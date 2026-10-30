//! What Rust tells the page: four events, and nothing reaches the page any other way. `src/backend/events.ts` names the same four.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::domain::Stray;

/// Every event the page can hear.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// Something the page reads changed; the payload says what (`Topic`) and for which connection.
    Changed,
    /// One event of Pip's streamed turn, or its request to narrow the view.
    Pip,
    /// The inbox snapshot, sent whenever it changes.
    Snapshot,
    /// A notification was clicked: focus the run it was about.
    OpenRun,
}

impl Event {
    #[cfg(test)]
    pub const ALL: [Event; 4] = [Event::Changed, Event::Pip, Event::Snapshot, Event::OpenRun];

    pub const fn name(self) -> &'static str {
        match self {
            Event::Changed => "changed",
            Event::Pip => "pip",
            Event::Snapshot => "snapshot",
            Event::OpenRun => "open-run",
        }
    }
}

/// What a `changed` event says changed, so a screen re-reads only what it shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    /// The cache of tickets, code and what is derived from them.
    Cache,
    Proposals,
    Runs,
    Workstreams,
    /// What is watched.
    Watch,
    /// Which work items are linked to code.
    DevLinks,
    /// Open items assigned to the person in containers they don't watch; the payload carries them as `strays`.
    AssignedElsewhere,
    /// A macOS display option the page follows, such as Reduce transparency.
    Display,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed<'a> {
    topic: Topic,
    connection_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    strays: Option<&'a [Stray]>,
}

fn send<S: Serialize + Clone>(app: &AppHandle, event: Event, payload: S) {
    let _ = app.emit(event.name(), payload);
}

pub fn changed(app: &AppHandle, topic: Topic, connection_id: &str) {
    send(app, Event::Changed, Changed { topic, connection_id, strays: None });
}

pub fn assigned_elsewhere(app: &AppHandle, connection_id: &str, strays: &[Stray]) {
    send(app, Event::Changed, Changed { topic: Topic::AssignedElsewhere, connection_id, strays: Some(strays) });
}

pub fn pip<S: Serialize + Clone>(app: &AppHandle, payload: S) {
    send(app, Event::Pip, payload);
}

pub fn snapshot(app: &AppHandle, snapshot: crate::model::Snapshot) {
    send(app, Event::Snapshot, snapshot);
}

pub fn open_run(app: &AppHandle, run_id: &str) {
    send(app, Event::OpenRun, serde_json::json!({ "runId": run_id }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_page_can_hear_exactly_four_events() {
        let names: Vec<_> = Event::ALL.iter().map(|e| e.name()).collect();
        assert_eq!(names, ["changed", "pip", "snapshot", "open-run"]);
    }

    fn sources(dir: &Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push((path.display().to_string(), std::fs::read_to_string(&path).unwrap()));
            }
        }
    }

    #[test]
    fn nothing_but_this_module_emits_to_the_page() {
        let mut files = Vec::new();
        sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        let own = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("wire.rs").display().to_string();
        let calls = [".emit(", ".emit::<", ".emit_to(", ".emit_to::<", ".emit_str(", ".emit_filter(", ".emit_filter::<", "Emitter::emit"];
        let emitting: Vec<_> = files.iter().filter(|(path, text)| *path != own && calls.iter().any(|c| text.contains(c))).map(|(p, _)| p.as_str()).collect();
        assert!(emitting.is_empty(), "these emit events of their own: {emitting:?}");
    }

    #[test]
    fn a_changed_event_names_its_topic_and_connection() {
        let json = serde_json::to_value(Changed { topic: Topic::DevLinks, connection_id: "jira:1", strays: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "topic": "devLinks", "connectionId": "jira:1" }));
    }
}
