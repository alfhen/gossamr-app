//! Reading the JSON lines `codex exec --json` prints: the thread, how the turn ended, tokens and what it is doing.

use std::path::Path;

use serde_json::Value;

use super::read_file;
use crate::runs::cli::TimelineLine;
use crate::runs::result::cut;

/// How much of the end of an events file is read, as for Claude's timeline.
const TAIL: u64 = 4 << 20;
const DETAIL_KEPT: usize = 200;

/// What Codex prints when a command fails because its sandbox keeps git out of the clone's `.git`.
const GIT_BLOCKED: [&str; 2] = ["index.lock': Operation not permitted", "unable to create temporary object directory"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed(String),
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Events {
    pub thread: Option<String>,
    /// How the turn ended, if it did.
    pub outcome: Option<Outcome>,
    pub tokens: u64,
    /// The newest item, in words.
    pub detail: Option<String>,
    pub timeline: Vec<TimelineLine>,
    pub last_message: Option<String>,
    /// A command failed because the sandbox kept git from writing.
    pub git_blocked: bool,
}

/// The events of one turn, from the end of its file.
pub fn read(path: &Path) -> Events {
    let Some(text) = read_file(path, TAIL, true) else { return Events::default() };
    let whole = std::fs::metadata(path).is_ok_and(|m| m.len() <= TAIL);
    // The first line of a cut tail is partial.
    let text = if whole { text.as_str() } else { text.split_once('\n').map_or("", |(_, rest)| rest) };
    parse(text)
}

pub fn parse(text: &str) -> Events {
    let mut out = Events::default();
    for line in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        match line["type"].as_str() {
            Some("thread.started") => {
                if out.thread.is_none() {
                    out.thread = line["thread_id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned);
                }
            }
            Some("turn.started") => out.outcome = None,
            Some("turn.completed") => {
                out.outcome = Some(Outcome::Completed);
                let usage = &line["usage"];
                out.tokens += usage["input_tokens"].as_u64().unwrap_or(0) + usage["output_tokens"].as_u64().unwrap_or(0);
            }
            Some("turn.failed") => out.outcome = Some(Outcome::Failed(message_of(&line["error"]))),
            Some("error") => out.outcome = Some(Outcome::Failed(message_of(&line))),
            Some(kind @ ("item.started" | "item.updated" | "item.completed")) => item(&mut out, &line["item"], kind == "item.completed"),
            _ => {}
        }
    }
    out
}

fn message_of(error: &Value) -> String {
    error["message"].as_str().or_else(|| error.as_str()).map(str::trim).filter(|m| !m.is_empty()).unwrap_or("Codex reported an error").to_owned()
}

fn item(out: &mut Events, item: &Value, completed: bool) {
    let text = |key: &str| item[key].as_str().map(str::trim).filter(|t| !t.is_empty());
    let described = match item["type"].as_str() {
        Some("command_execution") => text("command").map(str::to_owned),
        Some("mcp_tool_call") => text("tool").map(|tool| format!("Calling {tool}")),
        Some("agent_message") => text("text").map(|t| cut(t, DETAIL_KEPT)),
        _ => None,
    };
    if described.is_some() {
        out.detail = described.clone();
    }
    if !completed {
        return;
    }
    if item["type"] == "agent_message" {
        out.last_message = text("text").map(str::to_owned);
    }
    if item["type"] == "command_execution" {
        let failed = item["exit_code"].as_i64().is_some_and(|c| c != 0) || item["status"] == "failed";
        let output = item["aggregated_output"].as_str().unwrap_or("");
        if failed && GIT_BLOCKED.iter().any(|m| output.contains(m)) {
            out.git_blocked = true;
        }
    }
    if let Some(described) = described {
        out.timeline.push(TimelineLine { at: None, state: None, detail: None, text: Some(described) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_lines_and_unknown_types_are_skipped_and_tokens_are_summed() {
        let events = parse("{\"type\":\"thread.started\",\"thread_id\":\"t1\"}\nnot json\n{\"type\":\"mystery\",\"x\":1}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}\n");
        assert_eq!((events.thread.as_deref(), events.outcome, events.tokens), (Some("t1"), Some(Outcome::Completed), 7));
    }

    #[test]
    fn the_last_ending_in_a_file_wins() {
        let events = parse("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n{\"type\":\"turn.failed\",\"error\":{\"message\":\"boom\"}}\n");
        assert_eq!((events.tokens, events.outcome), (2, Some(Outcome::Failed("boom".into()))));
    }

    #[test]
    fn a_cut_tail_drops_its_partial_first_line() {
        let dir = std::env::temp_dir().join(format!("gossamr-events-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events-1.jsonl");
        let filler = "{\"type\":\"mystery\"}\n".repeat(((TAIL as usize) / 19) + 10);
        std::fs::write(&path, format!("{{\"type\":\"thread.started\",\"thread_id\":\"old\"}}\n{filler}{{\"type\":\"turn.completed\",\"usage\":{{\"input_tokens\":1,\"output_tokens\":1}}}}\n")).unwrap();
        let events = read(&path);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((events.thread, events.outcome), (None, Some(Outcome::Completed)));
    }

    #[test]
    fn a_symlinked_events_file_is_not_followed() {
        let dir = std::env::temp_dir().join(format!("gossamr-events-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real"), "{\"type\":\"turn.completed\"}\n").unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("events-1.jsonl")).unwrap();
        let events = read(&dir.join("events-1.jsonl"));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(events, Events::default());
    }
}
