#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness::driver::{Capabilities, Command, Driver, Launch, Link, OpenError};
use harness::event::{Body, Event};
use harness::mock::{Mock, Script};
use harness::session::{Harness, Open, Settings};
use harness::store::Store;
use harness::tools::ToolSpec;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};

/// A data folder under a temp folder that the harness makes itself.
pub fn data_dir() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("data");
    (tmp, dir)
}

pub fn mock(script: &str) -> Mock {
    Mock::new(Script::parse(script).unwrap())
}

pub fn harness(dir: &Path, mock: &Mock, limit: usize) -> Harness {
    harness_on(Store::open(dir).unwrap(), mock, limit)
}

pub fn harness_on(store: Store, mock: &Mock, limit: usize) -> Harness {
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    Harness::new(store, drivers, settings(limit))
}

pub fn settings(turn_limit: usize) -> Settings {
    Settings { turn_limit, ..Settings::default() }
}

pub async fn open(harness: &Harness, locked: bool) -> (String, broadcast::Receiver<Event>) {
    open_on(harness, "mock", locked).await
}

pub async fn open_on(harness: &Harness, provider: &str, locked: bool) -> (String, broadcast::Receiver<Event>) {
    harness.open(Open { provider: provider.into(), locked, cwd: "/nowhere".into(), tools: tools(), ..Default::default() }).await.unwrap()
}

/// The client tools the tests' sessions declare.
pub fn tools() -> Vec<ToolSpec> {
    ["choose", "read_ticket"].map(|name| ToolSpec { name: name.into(), description: format!("the test's {name}"), input_schema: serde_json::json!({"type": "object"}) }).to_vec()
}

pub async fn next(events: &mut broadcast::Receiver<Event>) -> Event {
    tokio::time::timeout(Duration::from_secs(10), events.recv()).await.expect("an event within 10 s").unwrap()
}

/// Events up to and including the first that `last` takes.
pub async fn until(events: &mut broadcast::Receiver<Event>, last: impl Fn(&Body) -> bool) -> Vec<Event> {
    let mut seen = vec![];
    loop {
        let event = next(events).await;
        let done = last(&event.body);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

pub fn types(events: &[Event]) -> Vec<String> {
    events.iter().map(|event| event.body.type_name()).collect()
}

/// Nothing more arrives within `ms`.
pub async fn quiet(events: &mut broadcast::Receiver<Event>, ms: u64) {
    if let Ok(event) = tokio::time::timeout(Duration::from_millis(ms), events.recv()).await {
        panic!("expected nothing, got {event:?}");
    }
}

/// Every byte of every file in `dir`, so a test can say a text is nowhere on disk.
pub fn bytes_on_disk(dir: &Path) -> Vec<u8> {
    let mut all = vec![];
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            all.extend(std::fs::read(path).unwrap());
        }
    }
    all
}

pub fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// Every value in every row of every table of the store, as text.
pub fn every_row(dir: &Path) -> String {
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut all = String::new();
    for table in tables {
        let mut stmt = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for column in 0..columns {
                let value: rusqlite::types::Value = row.get(column).unwrap();
                all.push_str(&format!("{value:?}\n"));
            }
        }
    }
    all
}

/// A store's lock outlives the last request by a moment while the session's task ends.
pub async fn reopen(dir: &Path) -> Store {
    for _ in 0..200 {
        match Store::open(dir) {
            Ok(store) => return store,
            Err(harness::error::Error::InUse(_)) => tokio::time::sleep(Duration::from_millis(10)).await,
            Err(e) => panic!("{e}"),
        }
    }
    panic!("the store stayed locked");
}

/// Binds a data folder that was served before, once its lock is free. The test has let go of the lock by then, but on
/// Linux a child that another test's thread was starting at that moment holds a copy of the lock's descriptor until it
/// execs, so the first try can still find the folder in use.
pub async fn bind_again(mut bind: impl FnMut() -> harness::error::Result<harness::server::Server>) -> harness::server::Server {
    let given = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match bind() {
            Err(harness::error::Error::InUse(_)) if std::time::Instant::now() < given => tokio::time::sleep(Duration::from_millis(10)).await,
            bound => return bound.unwrap(),
        }
    }
}

/// How a test agent goes after a stop.
#[derive(Clone)]
pub enum Going {
    /// 200 ms after the stop, saying a last word.
    Slowly,
    /// Only when killed.
    WhenKilled(Arc<Mutex<bool>>),
    /// Not even when killed, until the test lets it.
    WhenLet(Arc<tokio::sync::Notify>),
}

/// An agent that starts a turn on each prompt and goes after a stop as `going` says. Its driver gives 300 ms for a
/// stop.
pub struct Stopper {
    pub going: Going,
}

impl Driver for Stopper {
    fn capabilities(&self) -> Capabilities {
        Capabilities { stop_takes_up_to_ms: Some(300), ..Capabilities::default() }
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        output.send(Body::Started { provider_session: "stopper".into(), resumed: false }).unwrap();
        let going = self.going.clone();
        tokio::spawn(async move {
            loop {
                match (commands_rx.recv().await, &going) {
                    (Some(Command::Prompt(_)), _) => {
                        let _ = output.send(Body::TurnStarted);
                    }
                    (Some(Command::Stop), Going::Slowly) => {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let _ = output.send(Body::Text { text: "stopped at last".into() });
                        return;
                    }
                    (Some(Command::Kill), Going::WhenKilled(killed)) => {
                        *killed.lock().unwrap() = true;
                        return;
                    }
                    (Some(Command::Kill), Going::WhenLet(let_go)) => return let_go.notified().await,
                    (None, _) => return,
                    _ => {}
                }
            }
        });
        Ok(Link { commands, output: receiver })
    }
}

/// What a driver was given at one start.
#[derive(Debug, Clone)]
pub struct Seen {
    pub cwd: PathBuf,
    pub login: Option<String>,
    pub effort: Option<String>,
    pub resume: Option<String>,
    pub env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
}

impl Seen {
    pub fn var(&self, name: &str) -> Option<String> {
        self.env.iter().find(|(key, _)| key == name).map(|(_, value)| value.to_string_lossy().into_owned())
    }
}

/// Records each start, says it started, and goes when it is stopped.
#[derive(Clone, Default)]
pub struct Seer(pub Arc<Mutex<Vec<Seen>>>);

impl Seer {
    pub fn starts(&self) -> Vec<Seen> {
        self.0.lock().unwrap().clone()
    }
}

impl Driver for Seer {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let seen = Seen { cwd: launch.cwd, login: launch.login, effort: launch.effort, resume: launch.resume.clone(), env: launch.env };
        self.0.lock().unwrap().push(seen);
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        output.send(Body::Started { provider_session: "seer-1".into(), resumed: launch.resume.is_some() }).unwrap();
        tokio::spawn(async move {
            while let Some(command) = commands_rx.recv().await {
                if matches!(command, Command::Stop | Command::Kill) {
                    break;
                }
            }
            drop(output);
        });
        Ok(Link { commands, output: receiver })
    }
}

/// A session's events as the golden files hold them: each event's type in order, with a permission's kind and tool, an
/// answer's decision, a tool's name, a call id by the order it first came in, a turn's end, a failure's kind and
/// reason, and a text's length, never the text. A tool call's and a permission's input and a tool result's output give
/// their shape (`shape`), never a value.
pub fn project(events: &[Event]) -> Vec<String> {
    let word = |value: &dyn erased::Word| value.word();
    let mut calls: Vec<String> = vec![];
    let mut call = |id: &str| match calls.iter().position(|seen| seen == id) {
        Some(at) => at,
        None => {
            calls.push(id.to_owned());
            calls.len() - 1
        }
    };
    events
        .iter()
        .map(|event| match &event.body {
            Body::Prompted { text } => format!("prompted {}", text.chars().count()),
            Body::Text { text } => format!("text {}", text.chars().count()),
            Body::ToolCall { id, name, input } => format!("tool_call {name} {} {}", call(id), shape(input)),
            Body::ToolResult { id, error, output } => format!("tool_result {} {} {}", call(id), if *error { "error" } else { "ok" }, shape(output)),
            Body::Permission { kind, tool, input, .. } => format!("permission {} {tool} {}", word(kind), shape(input)),
            Body::Answered { decision, .. } => format!("answered {}", word(decision)),
            Body::TurnEnded { how } => format!("turn_ended {}", word(how)),
            Body::Failed { kind, reason } => format!("failed {} {reason}", word(kind)),
            other => other.type_name(),
        })
        .collect()
}

/// A payload's shape with none of its values: an object's sorted top-level keys, and how many entries an object or
/// array has, or how many characters a string has.
fn shape(value: &Value) -> String {
    let (keys, len) = match value {
        Value::Object(fields) => {
            let mut keys: Vec<&str> = fields.keys().map(String::as_str).collect();
            keys.sort();
            (keys.join(","), fields.len())
        }
        Value::Array(items) => (String::new(), items.len()),
        Value::String(text) => (String::new(), text.chars().count()),
        _ => (String::new(), 0),
    };
    format!("{{{keys}}} {len}")
}

mod erased {
    /// An enum's own word on the wire, as `serde` writes it.
    pub trait Word {
        fn word(&self) -> String;
    }

    impl<T: serde::Serialize> Word for T {
        fn word(&self) -> String {
            serde_json::to_value(self).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
        }
    }
}
