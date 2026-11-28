//! The Codex driver: the person's own `codex app-server` over JSON-RPC on stdio, one process per session, so a stop
//! can end the process tree: `turn/interrupt` leaves a running command alive (H0, row 3).
//!
//! Before it starts a session it checks the protocol's shape against the binary's own schema, with no version ceiling:
//! a version that passes but was not tested is a warning. It never sets `experimentalApi` and ignores notifications it
//! does not know. It passes no sandbox, sandbox mode, approval policy or trust: a sandbox on `thread/start` makes Codex
//! write project trust into the person's `config.toml` (H0, "A write into a login folder"). The tools endpoint goes in
//! the thread's `config.mcp_servers` under its per-session name, with its token in `http_headers` only, so it travels
//! on stdin and is in no argv, no environment and no file, and only that one server key is approved without asking.
//!
//! Each approval Codex asks for (a command, a file change, more permissions, another MCP server's tool) is a permission
//! request, answered in its own shape and never wider than once: no `acceptForSession`, no execpolicy amendment, no
//! `scope: session`. A `serverRequest/resolved` before the answer closes the request.

use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::binary::CliPlaces;
use crate::claude::driver::{LINE_MAX, Lines, write};
use crate::driver::{AgentEnd, Capabilities, Command, Driver, EndReport, Launch, Link, OpenError, guard};
use crate::env::RunEnv;
use crate::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use crate::process::{self, Process};
use crate::provider::Provider;

/// The versions the driver was tested on. Any other that passes the shape check runs, with a warning.
pub const TESTED: &[&str] = &["0.171.0"];

/// The v2 names the driver relies on, by the schema file that lists them. A missing one fails the check.
pub const NEEDED: [(&str, &[&str]); 2] = [
    ("ClientRequest.json", &["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt"]),
    ("ServerRequest.json", &["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]),
];

/// How long Codex lets a call to the session's tools run: `tool_timeout_sec` on the endpoint's server. Without it Codex
/// cuts a call at 300 s; with it a call held 540 s came back (H0, `5-hold-600`). `ask` returns before this.
pub const TOOL_TIMEOUT_SEC: u64 = 600;

/// How long a stopped agent has before its process group gets SIGTERM.
pub const TERM_AFTER: Duration = Duration::from_secs(3);

/// How long the session waits for a stopped agent before it says kill.
pub const STOP_TAKES_UP_TO: Duration = Duration::from_secs(10);

/// How long Codex has to answer `initialize` and the thread's start before the session fails.
pub const SETUP_WITHIN: Duration = Duration::from_secs(60);

/// How often the driver notes app-server's process tree while it runs, so a command it started in a group of its own
/// is known when app-server goes, however it goes.
const TREE_EVERY: Duration = Duration::from_secs(1);

/// How long the schema the shape check reads may take to write.
const SCHEMA_WITHIN: Duration = Duration::from_secs(20);

const STDERR_KEPT: usize = 500;

pub struct CodexDriver {
    binary: Binary,
    started_of: fn(u32) -> Option<u64>,
    term_after: Duration,
    stop_takes_up_to: Duration,
    setup_within: Duration,
    /// The binaries whose shape passed, each with its file's stamp, so an unchanged one is not checked again.
    checked: Mutex<HashMap<PathBuf, Stamp>>,
}

enum Binary {
    At(PathBuf),
    Found(CliPlaces),
}

impl CodexDriver {
    pub fn new(binary: PathBuf) -> CodexDriver {
        let (term_after, stop_takes_up_to, setup_within) = (TERM_AFTER, STOP_TAKES_UP_TO, SETUP_WITHIN);
        CodexDriver { binary: Binary::At(binary), started_of: process::started_of, term_after, stop_takes_up_to, setup_within, checked: Mutex::default() }
    }

    /// A driver that finds `codex` when a session opens, as `providers` looks for it.
    pub fn found(places: CliPlaces) -> CodexDriver {
        CodexDriver { binary: Binary::Found(places), ..CodexDriver::new(PathBuf::new()) }
    }

    /// Shorter waits before SIGTERM and before the session says kill, for tests.
    pub fn with_graces(self, term_after: Duration, stop_takes_up_to: Duration) -> CodexDriver {
        CodexDriver { term_after, stop_takes_up_to, ..self }
    }

    fn binary(&self, launch: &Launch) -> Result<PathBuf, OpenError> {
        match &self.binary {
            Binary::At(binary) => Ok(binary.clone()),
            Binary::Found(places) => places
                .find(Provider::Codex, &RunEnv::from_pairs(launch.env.iter().cloned()))
                .ok_or_else(|| OpenError { kind: FailKind::Provider, message: "codex was not found".into() }),
        }
    }

    /// The protocol's shape, from the binary's own schema: every name in `NEEDED`.
    fn check_shape(&self, binary: &Path, launch: &Launch) -> Result<(), OpenError> {
        let written = stamp(binary);
        let checked = self.checked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(binary).cloned();
        if written.is_some() && checked == written {
            return Ok(());
        }
        let missing = missing_names(binary, launch)?;
        if !missing.is_empty() {
            let message = format!("this Codex version is not supported: it has no {}", missing.join(", "));
            return Err(OpenError { kind: FailKind::VersionNotSupported, message });
        }
        if let Some(written) = written {
            self.checked.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(binary.to_owned(), written);
        }
        Ok(())
    }
}

/// What tells one installed file from another: the real file's device, inode, size and change time. npm unpacks every
/// file with one fixed modification time, so that alone would miss an upgrade; no unpacker can set the change time.
type Stamp = (PathBuf, u64, u64, u64, i64, i64);

fn stamp(binary: &Path) -> Option<Stamp> {
    use std::os::unix::fs::MetadataExt;
    let real = std::fs::canonicalize(binary).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    Some((real, meta.dev(), meta.ino(), meta.size(), meta.ctime(), meta.ctime_nsec()))
}

/// The names of `NEEDED` the binary's schema lacks, read from what `app-server generate-json-schema` writes into a
/// folder of its own, which goes afterwards.
fn missing_names(binary: &Path, launch: &Launch) -> Result<Vec<String>, OpenError> {
    let unreadable = |why: String| OpenError { kind: FailKind::VersionNotSupported, message: format!("this Codex version is not supported: its protocol could not be read ({why})") };
    let out = std::env::temp_dir().join(format!("gossamr-codex-schema-{}", crate::driver::random_hex(8)));
    std::fs::create_dir(&out).map_err(|e| unreadable(e.to_string()))?;
    let wrote = schema(binary, launch, &out);
    let lists: Result<Vec<HashSet<String>>, String> = NEEDED.iter().map(|(file, _)| methods(&out.join(file))).collect();
    let _ = std::fs::remove_dir_all(&out);
    let lists = wrote.and(lists).map_err(unreadable)?;
    Ok(NEEDED.iter().zip(&lists).flat_map(|((_, names), have)| names.iter().filter(|name| !have.contains(**name)).map(|name| (*name).to_owned())).collect())
}

fn schema(binary: &Path, launch: &Launch, out: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new(binary);
    command.args(["app-server", "generate-json-schema", "--out"]).arg(out).env_clear().envs(launch.env.iter().map(|(k, v)| (k, v)));
    let mut child = command.current_dir(&launch.cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let until = std::time::Instant::now() + SCHEMA_WITHIN;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => return Err(format!("it exited with {status}")),
            None if std::time::Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("it took over {} s", SCHEMA_WITHIN.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// The method names a schema file lists: each `oneOf` entry's `method` enum.
fn methods(file: &Path) -> Result<HashSet<String>, String> {
    let text = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.file_name().unwrap_or_default().to_string_lossy()))?;
    let schema: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let entries = schema["oneOf"].as_array().into_iter().flatten();
    Ok(entries.flat_map(|entry| entry["properties"]["method"]["enum"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned)).collect())
}

/// A model or an effort only when the person chose one other than the default (AGENTS.md rule 4).
fn chosen(value: &Option<String>) -> Option<String> {
    value.clone().filter(|value| value != crate::provider::DEFAULT_MODEL)
}

/// The thread's config: the session's endpoint under its per-session name, its token in `http_headers`, and nothing
/// else. Only this server's tools run without asking.
fn config(launch: &Launch) -> Value {
    let server = json!({
        "url": launch.tools.url,
        "http_headers": {"Authorization": format!("Bearer {}", launch.tools_token.expose())},
        "tool_timeout_sec": TOOL_TIMEOUT_SEC,
        "default_tools_approval_mode": "approve",
    });
    json!({"mcp_servers": {launch.tools.name.clone(): server}})
}

/// `thread/start`, or `thread/resume` of the session's thread: its folder, its config, the guard and a chosen model.
pub fn thread_request(launch: &Launch) -> (&'static str, Value) {
    let mut params = json!({"cwd": launch.cwd, "config": config(launch), "developerInstructions": guard(&launch.tools.tools)});
    if let Some(model) = chosen(&launch.model) {
        params["model"] = Value::from(model);
    }
    match &launch.resume {
        Some(thread) => {
            params["threadId"] = Value::from(thread.as_str());
            ("thread/resume", params)
        }
        None => ("thread/start", params),
    }
}

impl Driver for CodexDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            deny_ends_turn: false,
            tool_call_limit_ms: Some(TOOL_TIMEOUT_SEC * 1000),
            stop_kills_process_tree: true,
            runs_locked_profile: false,
            starts_turns_unprompted: false,
            stop_takes_up_to_ms: Some(self.stop_takes_up_to.as_millis() as u64),
        }
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        self.start(launch, None)
    }

    fn open_reporting(&self, launch: Launch, end: EndReport) -> Result<Link, OpenError> {
        self.start(launch, Some(end))
    }
}

impl CodexDriver {
    fn start(&self, launch: Launch, end: Option<EndReport>) -> Result<Link, OpenError> {
        if launch.locked {
            // Codex keeps its own tools whatever it is given (H0, row 11), so it cannot run Pip's lockdown.
            return Err(OpenError { kind: FailKind::Provider, message: "Codex cannot run a locked session: no setting removes its own tools".into() });
        }
        let binary = self.binary(&launch)?;
        self.check_shape(&binary, &launch)?;
        let mut command = tokio::process::Command::new(&binary);
        command.arg("app-server").env_clear().envs(launch.env.iter().map(|(k, v)| (k, v))).current_dir(&launch.cwd);
        command.process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        // On Linux, app-server takes in what its commands orphan, so a command that double-forks stays in its tree
        // while it runs. The setting outlives exec, and macOS has none like it.
        #[cfg(target_os = "linux")]
        // SAFETY: prctl is async-signal-safe and touches only the child's own setting.
        unsafe {
            command.pre_exec(|| match libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) {
                0 => Ok(()),
                _ => Err(std::io::Error::last_os_error()),
            });
        }
        let mut child = command.spawn().map_err(|e| OpenError { kind: FailKind::Provider, message: format!("codex could not be started: {e}") })?;
        let pid = child.id().expect("a child that was just spawned has a pid");
        let Some(started) = (self.started_of)(pid) else {
            let _ = child.start_kill();
            return Err(OpenError { kind: FailKind::Provider, message: "codex started, but its start time could not be read, so it could not be stopped safely".into() });
        };
        let process = Process { pid, started };
        let (stdin, stdout, stderr) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output, output_rx) = mpsc::unbounded_channel();
        let (lines, lines_rx) = mpsc::unbounded_channel();
        tokio::spawn(write(stdin, lines_rx));
        let last_said = Arc::new(Mutex::new(None::<String>));
        let keeping = last_said.clone();
        let secrets = [launch.tools_token.expose().to_owned()];
        let stderr = tokio::spawn(async move {
            let mut stderr = Lines::new(BufReader::new(stderr));
            while let Ok(Some((line, _))) = stderr.next(LINE_MAX).await {
                if !line.trim().is_empty() {
                    let masked = crate::redact::text(&line, &secrets).chars().take(STDERR_KEPT).collect();
                    *keeping.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(masked);
                }
            }
        });
        let rpc = Rpc::new(lines, output, &launch);
        let (noted, tree) = tokio::sync::watch::channel(vec![]);
        let agent = Agent { child: Some(child), process: process.clone(), rpc, term_after: self.term_after, kill_after: self.stop_takes_up_to, setup_within: self.setup_within, stderr: (stderr, last_said), end, sent: vec![], tree: vec![], noted };
        tokio::spawn(agent.run(BufReader::new(stdout), commands_rx));
        Ok(Link { commands, output: output_rx, process: Some(process), tree: Some(tree) })
    }
}

struct Agent {
    /// Taken by `run`, which waits on it beside the agent's output.
    child: Option<Child>,
    process: Process,
    rpc: Rpc,
    term_after: Duration,
    kill_after: Duration,
    setup_within: Duration,
    stderr: (tokio::task::JoinHandle<()>, Arc<Mutex<Option<String>>>),
    end: Option<EndReport>,
    sent: Vec<libc::c_int>,
    /// What app-server has started, noted while it runs: a command it leaves running is not in its group.
    tree: Vec<Process>,
    /// Where `tree` goes each time it changes, for the session to keep on record.
    noted: tokio::sync::watch::Sender<Vec<Process>>,
}

impl Agent {
    async fn run(mut self, stdout: BufReader<tokio::process::ChildStdout>, mut commands: UnboundedReceiver<Command>) {
        let at = |after: Duration| Some(tokio::time::Instant::now() + after);
        let mut stdout = Lines::new(stdout);
        let mut child = self.child.take().expect("run once");
        let (mut term_at, mut kill_at, mut setup_until) = (None, None, at(self.setup_within));
        let (mut going, mut listening) = (false, true);
        // A command app-server started can hold its stdout open after it exits, so its exit ends the session too.
        let mut exited = None;
        let mut tree_every = tokio::time::interval(TREE_EVERY);
        let until = |when: Option<tokio::time::Instant>| async move {
            match when {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        loop {
            if self.rpc.thread.is_some() {
                setup_until = None;
            }
            tokio::select! {
                biased;
                line = stdout.next(LINE_MAX) => match line {
                    Ok(Some((_, true))) => self.rpc.emit(Body::Notice { text: format!("Codex wrote a line over {} MiB, which was skipped.", LINE_MAX >> 20) }),
                    Ok(Some((line, false))) => {
                        self.rpc.read(&line);
                        // A command starts with its item: noted now, while app-server surely leads it.
                        if std::mem::take(&mut self.rpc.item_started) {
                            self.note_tree();
                        }
                        if self.rpc.broken && !going {
                            going = true;
                            self.kill();
                        }
                    }
                    Ok(None) | Err(_) => break,
                },
                status = child.wait() => {
                    exited = status.ok();
                    break;
                }
                command = commands.recv(), if listening => match command {
                    Some(Command::Prompt(text)) => self.rpc.prompt(text),
                    // Codex's answers hold no reason, so a deny's message stays with the session.
                    Some(Command::Answer { id, decision, .. }) => self.rpc.answer(&id, decision),
                    Some(Command::Cancel) => self.rpc.cancel(),
                    // Codex's own sandbox setting decides what it may do; Gossamr's choice is Claude's alone.
                    Some(Command::SetPermissions(_)) => {}
                    Some(Command::Stop) => {
                        going = true;
                        self.go();
                        term_at = term_at.or(at(self.term_after));
                    }
                    None => {
                        (going, listening) = (true, false);
                        self.go();
                        term_at = term_at.or(at(self.term_after));
                        kill_at = at(self.kill_after);
                    }
                    Some(Command::Kill) => {
                        going = true;
                        self.kill();
                    }
                },
                () = until(term_at) => {
                    term_at = None;
                    self.sent.push(libc::SIGTERM);
                    let _ = process::signal_group(&self.process, libc::SIGTERM);
                }
                () = until(kill_at) => {
                    kill_at = None;
                    self.kill();
                }
                _ = tree_every.tick() => self.note_tree(),
                () = until(setup_until) => {
                    setup_until = None;
                    going = true;
                    self.rpc.fail(FailKind::Provider, format!("Codex did not start its thread within {} s", self.setup_within.as_secs_f32()));
                    self.kill();
                }
            }
        }
        // Whatever of the group is left, and what app-server had started outside it, goes too. Its output can end
        // while it runs, and then this kill is the driver's own.
        self.note_tree();
        if process::alive(&self.process) {
            self.sent.push(libc::SIGKILL);
        }
        let _ = process::kill_group(&self.process);
        self.kill_tree();
        let status = match exited {
            Some(status) => Some(status),
            None => child.wait().await.ok(),
        };
        let ended = status.and_then(|status| match (status.code(), status.signal()) {
            (Some(code), _) => Some(AgentEnd::Exited(code)),
            (None, Some(signal)) => Some(AgentEnd::Signalled { signal, sent: self.sent.contains(&signal) }),
            (None, None) => None,
        });
        if !going {
            let _ = tokio::time::timeout(Duration::from_secs(1), &mut self.stderr.0).await;
            let said = self.stderr.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
            let mut how = if self.rpc.turn.is_some() { "codex exited in the middle of a turn" } else { "codex exited" }.to_owned();
            if let Some(AgentEnd::Signalled { signal, sent: false }) = ended {
                how.push_str(&format!(", ended by signal {signal}"));
            }
            let cut = self.rpc.turn.is_some() && matches!(ended, Some(AgentEnd::Signalled { signal: libc::SIGTERM | libc::SIGHUP | libc::SIGINT, sent: false }));
            let reason = match said {
                Some(said) => format!("{how}: {said}"),
                None => how,
            };
            self.rpc.fail(if cut { FailKind::AgentStopped } else { FailKind::Provider }, reason);
        }
        if let (Some(end), Some(ended)) = (self.end.take(), ended) {
            end.send(ended);
        }
    }

    /// Notes the process tree while app-server is still its root, then closes stdin, which is how it is told to go.
    fn go(&mut self) {
        self.note_tree();
        self.rpc.lines = None;
    }

    fn note_tree(&mut self) {
        // Kept until nothing is left of it, neither it nor its group, or its pid is another process's: an exited
        // command's group can still hold what it started.
        self.tree.retain(|left| !process::nothing_has(left.pid) && process::started_of(left.pid).is_none_or(|started| started == left.started));
        for found in process::descendants(&self.process) {
            if !self.tree.contains(&found) {
                self.tree.push(found);
            }
        }
        self.noted.send_if_modified(|noted| {
            let changed = *noted != self.tree;
            noted.clone_from(&self.tree);
            changed
        });
    }

    fn kill(&mut self) {
        self.note_tree();
        self.sent.push(libc::SIGKILL);
        let _ = process::kill_group(&self.process);
        self.kill_tree();
    }

    /// Each process of the noted tree, and the group each led: a command in a group of its own leaves what it started
    /// there when it exits.
    fn kill_tree(&self) {
        for left in &self.tree {
            let _ = process::signal(left, libc::SIGKILL);
            process::kill_led_group(left);
        }
    }
}

/// The running turn: its id once `turn/start` is answered, and whether it was interrupted.
struct Turn {
    /// The id of its `turn/start`, whose answer alone names it.
    request: u64,
    id: Option<String>,
    cancelled: bool,
    /// The thread's token total when the turn began, so its usage is what it added.
    from: Option<Value>,
}

/// What a request of the driver's was, by its id, for its answer.
#[derive(Clone, Copy, PartialEq)]
enum Asked {
    Initialize,
    Thread,
    Turn,
    Interrupt,
}

/// A request of app-server's that waits for the person: its id as Codex sent it, and how it is answered.
struct Pending {
    id: Value,
    shape: Shape,
}

enum Shape {
    /// A command or a file change: `decision`, `accept` or `decline`.
    Decision,
    /// More permissions: the profile asked for, granted for this turn alone, or none.
    Grant(Value),
    /// Another MCP server's tool, by elicitation: `action`.
    Action,
}

/// The JSON-RPC conversation with app-server, apart from the process.
struct Rpc {
    /// None once stdin is closed.
    lines: Option<UnboundedSender<String>>,
    output: UnboundedSender<Body>,
    next: u64,
    asked: HashMap<u64, Asked>,
    /// The thread request, sent once `initialize` is answered.
    thread_request: Option<(&'static str, Value)>,
    /// The thread's id, once it started or resumed.
    thread: Option<String>,
    resumed: bool,
    turn: Option<Turn>,
    /// Prompts that wait for the thread, or for the running turn to end.
    held: VecDeque<String>,
    effort: Option<String>,
    /// The thread's latest token total.
    total: Option<Value>,
    /// A setup answer was an error, so the agent must go.
    broken: bool,
    /// An item started since the agent last looked, so its process tree may have grown.
    item_started: bool,
    /// Requests that wait for the person, by the driver's id of each: the JSON text of Codex's id.
    pending: HashMap<String, Pending>,
}

impl Rpc {
    fn new(lines: UnboundedSender<String>, output: UnboundedSender<Body>, launch: &Launch) -> Rpc {
        if let Some(thread) = &launch.resume {
            let _ = output.send(Body::Started { provider_session: thread.clone(), resumed: true });
        }
        let mut rpc = Rpc {
            lines: Some(lines),
            output,
            next: 0,
            asked: HashMap::new(),
            thread_request: Some(thread_request(launch)),
            thread: None,
            resumed: launch.resume.is_some(),
            turn: None,
            held: VecDeque::new(),
            effort: chosen(&launch.effort),
            total: None,
            broken: false,
            item_started: false,
            pending: HashMap::new(),
        };
        // No `capabilities`, so `experimentalApi` is never set.
        let client = json!({"name": "gossamr", "title": "Gossamr", "version": env!("CARGO_PKG_VERSION")});
        rpc.request(Asked::Initialize, "initialize", json!({"clientInfo": client}));
        rpc
    }

    fn send(&mut self, line: Value) {
        if let Some(lines) = &self.lines {
            let _ = lines.send(line.to_string());
        }
    }

    fn request(&mut self, asked: Asked, method: &str, params: Value) {
        self.next += 1;
        self.asked.insert(self.next, asked);
        self.send(json!({"id": self.next, "method": method, "params": params}));
    }

    fn emit(&self, body: Body) {
        let _ = self.output.send(body);
    }

    fn fail(&mut self, kind: FailKind, reason: String) {
        self.turn = None;
        self.held.clear();
        self.pending.clear();
        self.emit(Body::Failed { kind, reason });
    }

    fn prompt(&mut self, text: String) {
        let Some(thread) = self.thread.clone().filter(|_| self.turn.is_none()) else {
            self.held.push_back(text);
            return;
        };
        let mut params = json!({"threadId": thread, "input": [{"type": "text", "text": text}]});
        if let Some(effort) = &self.effort {
            params["effort"] = Value::from(effort.as_str());
        }
        self.emit(Body::TurnStarted);
        self.request(Asked::Turn, "turn/start", params);
        self.turn = Some(Turn { request: self.next, id: None, cancelled: false, from: self.total.clone() });
    }

    fn cancel(&mut self) {
        if self.turn.is_none() && self.held.pop_front().is_some() {
            // A prompt that waits for the thread never reaches Codex: its turn ends cancelled, as a sent one's would.
            self.emit(Body::TurnStarted);
            self.emit(Body::TurnEnded { how: TurnEnd::Cancelled });
            return;
        }
        let Some(turn) = self.turn.as_mut().filter(|turn| !turn.cancelled) else { return };
        turn.cancelled = true;
        if turn.id.is_some() {
            self.interrupt();
        }
    }

    fn interrupt(&mut self) {
        if let (Some(thread), Some(turn)) = (self.thread.clone(), self.turn.as_ref().and_then(|turn| turn.id.clone())) {
            self.request(Asked::Interrupt, "turn/interrupt", json!({"threadId": thread, "turnId": turn}));
        }
    }

    fn read(&mut self, line: &str) {
        let Ok(line) = serde_json::from_str::<Value>(line) else { return };
        match (line["method"].as_str(), line.get("id")) {
            (Some(method), Some(id)) => self.asks(method, id.clone(), &line["params"]),
            (Some(method), None) => self.notified(method, &line["params"]),
            (None, Some(id)) => {
                let (id, asked) = (id.as_u64(), id.as_u64().and_then(|id| self.asked.remove(&id)));
                self.answered(id, asked, &line);
            }
            (None, None) => {}
        }
    }

    /// A request of app-server's: an approval becomes a permission request, with all Codex gave but its ids, so a
    /// command comes whole. Anything else is refused at once, so no turn waits on it.
    fn asks(&mut self, method: &str, id: Value, params: &Value) {
        let (kind, tool, shape) = match method {
            "item/commandExecution/requestApproval" => (PermissionKind::Command, "command".to_owned(), Shape::Decision),
            "item/fileChange/requestApproval" => (PermissionKind::FileChange, "file_change".to_owned(), Shape::Decision),
            "item/permissions/requestApproval" => (PermissionKind::Permissions, "permissions".to_owned(), Shape::Grant(params["permissions"].clone())),
            "mcpServer/elicitation/request" if asks_only_yes_or_no(params) => (PermissionKind::Tool, params["serverName"].as_str().unwrap_or_default().to_owned(), Shape::Action),
            "mcpServer/elicitation/request" => {
                // A form with fields or a page to open: an Allow could not fill it in.
                self.send(json!({"id": id, "result": {"action": "decline", "content": null}}));
                let server = params["serverName"].as_str().unwrap_or("an MCP server");
                return self.emit(Body::Notice { text: format!("{server} asked for input Gossamr can't give, so it was declined.") });
            }
            _ => return self.send(json!({"id": id, "error": {"code": -32601, "message": "not supported by this client"}})),
        };
        let mut input = params.clone();
        if let Some(fields) = input.as_object_mut() {
            for gone in ["threadId", "turnId", "itemId", "startedAtMs", "environmentId"] {
                fields.remove(gone);
            }
        }
        let request = id.to_string();
        self.pending.insert(request.clone(), Pending { id, shape });
        self.emit(Body::Permission { id: request, kind, tool, input });
    }

    /// The person's answer, in the request's own shape and for it alone. A request Codex has resolved is not answered.
    fn answer(&mut self, request: &str, decision: Decision) {
        let Some(Pending { id, shape }) = self.pending.remove(request) else { return };
        let allow = decision == Decision::Allow;
        let result = match (shape, allow) {
            (Shape::Decision, true) => json!({"decision": "accept"}),
            (Shape::Decision, false) => json!({"decision": "decline"}),
            (Shape::Grant(asked), true) => json!({"permissions": asked, "scope": "turn"}),
            (Shape::Grant(_), false) => json!({"permissions": {}, "scope": "turn"}),
            (Shape::Action, true) => json!({"action": "accept", "content": {}}),
            (Shape::Action, false) => json!({"action": "decline", "content": null}),
        };
        self.send(json!({"id": id, "result": result}));
    }

    /// Codex no longer waits on a request it asked, answered or not: one still open is closed.
    fn resolved(&mut self, params: &Value) {
        let request = params["requestId"].to_string();
        if self.pending.remove(&request).is_some() {
            self.emit(Body::PermissionClosed { id: request });
        }
    }

    fn answered(&mut self, request: Option<u64>, asked: Option<Asked>, line: &Value) {
        let error = line["error"]["message"].as_str().map(str::to_owned).or_else(|| line.get("error").map(|_| "Codex refused the request".to_owned()));
        match (asked, error) {
            (Some(Asked::Initialize), None) => self.initialized(&line["result"]),
            (Some(Asked::Thread), None) => {
                let Some(thread) = line["result"]["thread"]["id"].as_str() else { return self.setup_failed("Codex started a thread with no id".into()) };
                if !self.resumed {
                    self.emit(Body::Started { provider_session: thread.to_owned(), resumed: false });
                }
                self.thread = Some(thread.to_owned());
                if let Some(text) = self.held.pop_front() {
                    self.prompt(text);
                }
            }
            (Some(Asked::Turn), None) => {
                let id = line["result"]["turn"]["id"].as_str().map(str::to_owned);
                // Only the running turn's own: a turn that completed before its answer came must not name the next.
                if let Some(turn) = self.turn.as_mut().filter(|turn| Some(turn.request) == request && turn.id.is_none()) {
                    turn.id = id;
                    if turn.cancelled {
                        self.interrupt();
                    }
                }
            }
            (Some(Asked::Initialize | Asked::Thread), Some(error)) => self.setup_failed(error),
            (Some(Asked::Turn), Some(error)) if self.turn.as_ref().is_some_and(|turn| Some(turn.request) == request) => {
                self.turn = None;
                self.emit(Body::Failed { kind: FailKind::Provider, reason: error });
                self.next_prompt();
            }
            (Some(Asked::Interrupt | Asked::Turn) | None, _) => {}
        }
    }

    fn setup_failed(&mut self, reason: String) {
        self.fail(FailKind::Provider, reason);
        self.broken = true;
    }

    /// The `initialize` answer's shape and version, then the thread.
    fn initialized(&mut self, result: &Value) {
        let Some(version) = result["userAgent"].as_str().and_then(version_of) else {
            self.fail(FailKind::VersionNotSupported, "this Codex version is not supported: its initialize answer names no version".into());
            self.broken = true;
            return;
        };
        if !TESTED.contains(&version.as_str()) {
            self.emit(Body::Notice { text: format!("Codex {version} has not been tested with Gossamr. It passed the protocol check, so it runs.") });
        }
        self.send(json!({"method": "initialized", "params": {}}));
        if let Some((method, params)) = self.thread_request.take() {
            self.request(Asked::Thread, method, params);
        }
    }

    fn notified(&mut self, method: &str, params: &Value) {
        let item = &params["item"];
        match method {
            "item/started" => {
                self.item_started = true;
                let (name, input) = match item["type"].as_str() {
                    Some("commandExecution") => ("command".to_owned(), json!({"command": item["command"]})),
                    Some("fileChange") => ("file_change".to_owned(), json!({"changes": item["changes"]})),
                    Some("mcpToolCall") => (format!("{}/{}", item["server"].as_str().unwrap_or_default(), item["tool"].as_str().unwrap_or_default()), item["arguments"].clone()),
                    _ => return,
                };
                self.emit(Body::ToolCall { id: item["id"].as_str().unwrap_or_default().to_owned(), name, input });
            }
            "item/completed" => match item["type"].as_str() {
                Some("agentMessage") => self.emit(Body::Text { text: item["text"].as_str().unwrap_or_default().to_owned() }),
                Some("commandExecution" | "fileChange" | "mcpToolCall") => {
                    let output = [&item["aggregatedOutput"], &item["result"], &item["error"]].into_iter().find(|output| !output.is_null()).cloned().unwrap_or_else(|| item["status"].clone());
                    self.emit(Body::ToolResult { id: item["id"].as_str().unwrap_or_default().to_owned(), output, error: item["status"] != "completed" });
                }
                _ => {}
            },
            "thread/tokenUsage/updated" => self.total = Some(params["tokenUsage"]["total"].clone()),
            "serverRequest/resolved" => self.resolved(params),
            "turn/completed" => self.completed(&params["turn"]),
            "configWarning" | "deprecationNotice" => {
                let summary = params["summary"].as_str().unwrap_or("Codex warned about its setup");
                let text = match params["details"].as_str() {
                    Some(details) => format!("Codex: {summary} {details}"),
                    None => format!("Codex: {summary}"),
                };
                self.emit(Body::Notice { text });
            }
            _ => {}
        }
    }

    fn completed(&mut self, turn: &Value) {
        let Some(running) = self.turn.take() else { return };
        // Codex resolves what it asked before its turn ends; one it did not is closed here, so the run says it ended
        // blocked on it.
        let mut left: Vec<String> = self.pending.drain().map(|(request, _)| request).collect();
        left.sort();
        for request in left {
            self.emit(Body::Notice { text: "Codex's turn ended while it waited for your answer to a request.".into() });
            self.emit(Body::PermissionClosed { id: request });
        }
        if let Some(used) = usage(running.from.as_ref(), self.total.as_ref()) {
            self.emit(used);
        }
        let body = match turn["status"].as_str() {
            Some("completed") => Body::TurnEnded { how: TurnEnd::Done },
            Some("interrupted") => Body::TurnEnded { how: TurnEnd::Cancelled },
            status => Body::Failed { kind: FailKind::Provider, reason: turn["error"]["message"].as_str().or(status).unwrap_or("the turn failed").to_owned() },
        };
        self.emit(body);
        self.next_prompt();
    }

    fn next_prompt(&mut self) {
        if let Some(text) = self.held.pop_front() {
            self.prompt(text);
        }
    }
}

/// An elicitation an Allow or a Deny answers: a form that asks for no field, as Codex's approval of another server's
/// tool is (H0, R1). A page to open, or a field to fill, is not one.
fn asks_only_yes_or_no(params: &Value) -> bool {
    let fields = &params["requestedSchema"]["properties"];
    params["mode"] != "url" && params.get("url").is_none() && (fields.is_null() || fields.as_object().is_some_and(serde_json::Map::is_empty))
}

/// The version in an `initialize` answer's `userAgent`: `<client>/<version> (<platform>) ...`.
fn version_of(agent: &str) -> Option<String> {
    let version = agent.split_once('/')?.1.split_whitespace().next()?;
    (!version.is_empty() && version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))).then(|| version.to_owned())
}

/// What a turn used: the thread's token total at its end less the total when it began. Codex counts cached input among
/// input; the event counts it apart, as cache reads.
fn usage(from: Option<&Value>, to: Option<&Value>) -> Option<Body> {
    let to = to?;
    let count = |total: Option<&Value>, field: &str| total.and_then(|total| total[field].as_u64()).unwrap_or(0);
    let added = |field: &str| count(Some(to), field).saturating_sub(count(from, field));
    if from == Some(to) {
        return None;
    }
    let cached = added("cachedInputTokens");
    Some(Body::Usage {
        input_tokens: added("inputTokens").saturating_sub(cached),
        output_tokens: added("outputTokens"),
        cache_read_tokens: cached,
        cache_creation_tokens: added("cacheWriteInputTokens"),
        cost_usd: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An `Rpc` whose thread `thr` has started, with what it writes and says.
    fn rpc() -> (Rpc, mpsc::UnboundedReceiver<String>, mpsc::UnboundedReceiver<Body>) {
        let (lines, written) = mpsc::unbounded_channel();
        let (output, said) = mpsc::unbounded_channel();
        let launch = Launch {
            cwd: "/nowhere".into(),
            locked: false,
            model: None,
            login: None,
            effort: None,
            permissions: Default::default(),
            resume: None,
            tools_token: crate::driver::Secret::random(),
            tools: crate::tools::ToolsEndpoint::unattached(),
            result_schema: None,
            env: vec![],
        };
        (Rpc::new(lines, output, &launch), written, said)
    }

    fn drained<T>(from: &mut mpsc::UnboundedReceiver<T>) -> Vec<T> {
        std::iter::from_fn(|| from.try_recv().ok()).collect()
    }

    #[test]
    fn a_cancel_of_a_prompt_that_waits_for_the_thread_ends_its_turn_and_never_sends_it() {
        let (mut rpc, mut written, mut said) = rpc();
        rpc.prompt("go".into());
        rpc.cancel();
        assert_eq!(drained(&mut said), [Body::TurnStarted, Body::TurnEnded { how: TurnEnd::Cancelled }]);
        rpc.answered(Some(2), Some(Asked::Thread), &json!({"result": {"thread": {"id": "thr"}}}));
        let sent = drained(&mut written);
        assert!(!sent.iter().any(|line| line.contains("turn/start")), "the cancelled prompt never went: {sent:?}");
    }

    #[test]
    fn a_turn_start_answer_names_only_its_own_turn() {
        let (mut rpc, mut written, _said) = rpc();
        rpc.thread = Some("thr".into());
        rpc.prompt("first".into());
        let first = rpc.next;
        // The first turn completes before its `turn/start` is answered; the next starts at once.
        rpc.notified("turn/completed", &json!({"turn": {"id": "turn-1", "status": "completed"}}));
        rpc.prompt("second".into());
        let second = rpc.next;
        rpc.answered(Some(first), Some(Asked::Turn), &json!({"result": {"turn": {"id": "turn-1"}}}));
        rpc.answered(Some(second), Some(Asked::Turn), &json!({"result": {"turn": {"id": "turn-2"}}}));
        drained(&mut written);
        rpc.cancel();
        let interrupt: Value = serde_json::from_str(&drained(&mut written).pop().expect("an interrupt")).unwrap();
        assert_eq!((&interrupt["method"], &interrupt["params"]["turnId"]), (&json!("turn/interrupt"), &json!("turn-2")), "the running turn is the one interrupted");
    }

    #[test]
    fn a_version_is_read_from_the_user_agent_and_nothing_else() {
        assert_eq!(version_of("gossamr/0.171.0 (Mac OS 26.7.3; arm64) unknown (gossamr; 0.1.0)").as_deref(), Some("0.171.0"));
        assert_eq!(version_of("no version here"), None);
        assert_eq!(version_of("x/0.1.0;rm (y)"), None, "only a version's characters");
    }

    #[test]
    fn a_turns_usage_is_what_it_added_to_the_threads_total_with_cache_reads_apart() {
        let total = |input: u64, cached: u64, output: u64| json!({"inputTokens": input, "cachedInputTokens": cached, "outputTokens": output, "cacheWriteInputTokens": 0});
        let used = usage(Some(&total(100, 40, 10)), Some(&total(250, 90, 30)));
        assert_eq!(used, Some(Body::Usage { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_creation_tokens: 0, cost_usd: None }));
        assert_eq!(usage(Some(&total(1, 0, 1)), Some(&total(1, 0, 1))), None, "a turn that used nothing says nothing");
        assert_eq!(usage(None, None), None);
    }
}
