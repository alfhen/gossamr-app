#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use harness::driver::Driver;
use harness::event::{Body, Event};
use harness::mock::{Mock, Script};
use harness::session::{Harness, Open, Settings};
use harness::store::Store;
use tokio::sync::broadcast;

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
    harness.open(Open { provider: provider.into(), locked, cwd: "/nowhere".into(), ..Default::default() }).await.unwrap()
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
