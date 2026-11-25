//! Turns a harness session's events into its run's state and timeline. Nothing here reads a CLI's files or a listing:
//! the run is what its session says, in the order the harness numbered it.
//!
//! `fold` is pure. The link applies it inside the transaction that also stores the run, its timeline rows and how far
//! the session was followed (`Db::apply_session`), so an event is applied once, and one already applied is passed over.

use chrono::{DateTime, Utc};
use harness::event::{Body, Decision, Event, FailKind, QuestionEnd, TurnEnd, PRIVATE_FIELDS};
use serde_json::Value;

use super::redact::redact;
use super::tracker::cleaned_answer;
use crate::domain::{Run, RunEvent, RunFailure, RunState, SessionFollow};

const TEXT_KEPT: usize = 500;
const DETAIL_KEPT: usize = 2_048;
const NEEDS_KEPT: usize = super::tracker::NEEDS_KEPT;

pub const SLOT_WAIT: &str = "Waits for a free slot: the harness runs as many agents as it allows";
pub const HANDED_OVER: &str = "Handed over to Terminal";
pub const STOPPED_AFTER_DENY: &str = "Stopped after a deny";
pub const LOST: &str = "Part of this run's record was lost";
pub const ANSWER_WAITS: &str = "Your answer waits for the turn to end";

/// Applies `event` to `run` and `follow`, and returns the timeline rows it adds. An event the app already applied
/// (numbered at or below `follow.seq`) changes nothing; one numbered 0 was never stored, so it is applied and moves
/// nothing.
pub fn fold(run: &mut Run, follow: &mut SessionFollow, event: &Event, now: DateTime<Utc>) -> Vec<RunEvent> {
    if event.seq != 0 && event.seq <= follow.seq {
        return Vec::new();
    }
    follow.seq = follow.seq.max(event.seq);
    let Some(body) = readable(&event.body) else { return Vec::new() };
    let at = DateTime::from_timestamp_millis(event.ms).unwrap_or(now);
    let mut rows = Rows { run_id: run.id.clone(), at, rows: Vec::new() };
    let before = run.state;
    match body {
        Body::Started { resumed, .. } => rows.add(if resumed { "follow_up" } else { "start" }, if resumed { "Resumed" } else { "Started" }, None),
        Body::Prompted { text } => {
            follow.prompts += 1;
            // The first prompt is the brief the person approved; each later one is a message to the agent.
            if follow.prompts > 1 {
                rows.add("follow_up", "Message sent", Some(&text));
            }
        }
        Body::Waiting => {
            if matches!(run.state, RunState::Queued | RunState::Launching) {
                run.state = RunState::Launching;
            }
            run.last_detail = Some(SLOT_WAIT.into());
            rows.add("update", SLOT_WAIT, None);
        }
        Body::PromptsDropped => rows.add("update", "Messages it had not read yet were dropped", None),
        Body::TurnStarted => {
            follow.in_turn = true;
            run.ended_at = None;
            if run.last_detail.as_deref() == Some(SLOT_WAIT) {
                run.last_detail = None;
            }
        }
        Body::Text { text } => {
            run.last_detail = first_line(&text);
            rows.add("update", &text, None);
        }
        Body::ToolCall { name, input, .. } => {
            let what = describe(&name, &input);
            run.last_detail = Some(what.clone());
            rows.add(tool_kind(&name), &what, None);
        }
        Body::ClientToolCall { name, .. } => rows.add("read", &format!("Asked Gossamr: {name}"), None),
        Body::ToolResult { error: true, output, .. } => rows.add("error", "A tool call failed", Some(&plain(&output))),
        Body::ToolResult { .. } => {}
        Body::Permission { id, tool, input, .. } => {
            let what = describe(&tool, &input);
            follow.permissions.push((id, event.cut.is_some(), cut(&redact(&format!("Wants to use {what}")), NEEDS_KEPT)));
            rows.add("ask", &format!("Asks to use {what}"), None);
        }
        Body::Answered { id, decision, .. } => {
            follow.permissions.retain(|(open, ..)| *open != id);
            rows.add("update", if decision == Decision::Allow { "You allowed it" } else { "You denied it" }, None);
        }
        Body::Question { id, text } => {
            follow.question = Some(id);
            follow.asked = Some(cut(&redact(&text), NEEDS_KEPT));
            rows.add("ask", &text, None);
        }
        Body::QuestionClosed { id, how } => {
            if follow.question.as_deref() == Some(id.as_str()) {
                follow.question = None;
                follow.asked = None;
            }
            if follow.answered.as_deref() == Some(id.as_str()) {
                follow.answered = None;
                if run.last_detail.as_deref() == Some(ANSWER_WAITS) {
                    run.last_detail = None;
                }
            }
            match how {
                QuestionEnd::Answered => rows.add("update", "Its question was answered", None),
                QuestionEnd::Stopped => rows.add("stop", "Its question was closed: the run was stopped", None),
                QuestionEnd::HandedOver => rows.add("stop", "Its question was closed: the run was handed over", None),
                QuestionEnd::Denied => rows.add("stop", "Its question was closed: a deny ended its turn", None),
            }
        }
        Body::Result { data } => {
            run.result = cleaned_answer(&result_text(&data));
            run.result_complete = run.result.is_some();
            rows.add("done", "Gave its result", None);
        }
        Body::TurnEnded { how } => {
            follow.in_turn = false;
            follow.turns += 1;
            follow.permissions.clear();
            match how {
                TurnEnd::Done => {
                    follow.carry_ons = 0;
                    rows.add("done", "Finished its turn", None);
                }
                TurnEnd::Cancelled => rows.add("stop", "Its turn was cancelled", None),
                TurnEnd::Denied => rows.add("stop", STOPPED_AFTER_DENY, None),
            }
            if follow.question.is_none() {
                run.state = if how == TurnEnd::Done { RunState::Done } else { RunState::Stopped };
                run.last_detail = (how == TurnEnd::Denied).then(|| STOPPED_AFTER_DENY.into()).or(run.last_detail.take());
                run.ended_at = Some(now);
            }
        }
        Body::Failed { kind: FailKind::AgentStopped, .. } if follow.stop_asked => {
            follow.in_turn = false;
            follow.permissions.clear();
            run.state = RunState::Stopped;
            run.ended_at = Some(now);
        }
        Body::Failed { kind, reason } => {
            follow.in_turn = false;
            follow.permissions.clear();
            run.state = RunState::Failed;
            run.error = Some(cut(&redact(&reason), DETAIL_KEPT));
            run.failure = Some(if kind == FailKind::SignedOut { RunFailure::NotSignedIn } else { RunFailure::Other });
            run.ended_at = Some(now);
            rows.add("error", &reason, None);
        }
        Body::Notice { text } => rows.add("update", &text, None),
        Body::HandedOver => {
            run.last_detail = Some(HANDED_OVER.into());
            rows.add("stop", HANDED_OVER, None);
        }
        Body::Closed => {
            follow.closed = true;
            follow.in_turn = false;
            follow.question = None;
            follow.asked = None;
            follow.answered = None;
            follow.permissions.clear();
            if !matches!(run.state, RunState::Done | RunState::Failed) {
                run.state = RunState::Stopped;
                rows.add("stop", "Stopped", None);
            }
            run.ended_at.get_or_insert(now);
        }
        Body::Withheld { .. } => {}
    }
    settle(run, follow);
    run.asking = run.state == RunState::NeedsAnswer;
    // What it waits on now: the oldest permission request, else the question, whichever event closed the other.
    run.needs = match run.state {
        RunState::NeedsPermission => follow.permissions.first().map(|(.., need)| need.clone()),
        RunState::NeedsAnswer => follow.asked.clone(),
        _ => None,
    };
    if run.state != before || !rows.rows.is_empty() {
        run.last_progress_at = now;
    }
    rows.rows
}

/// Notes, once, that the session's events after what the app applied and up to `last` were lost, and reads on after
/// `last`. The row names the events skipped, so the person sees a hole in the record and not a silent jump.
pub fn lost(run: &mut Run, follow: &mut SessionFollow, reason: &str, last: u64, now: DateTime<Utc>) -> Vec<RunEvent> {
    let (from, to) = (follow.seq + 1, last.max(follow.seq));
    follow.seq = to;
    follow.lost += 1;
    run.last_progress_at = now;
    let skipped = match to.cmp(&from) {
        std::cmp::Ordering::Less => "no stored event was skipped".to_owned(),
        std::cmp::Ordering::Equal => format!("event {from} was skipped"),
        std::cmp::Ordering::Greater => format!("events {from} to {to} were skipped"),
    };
    let mut rows = Rows { run_id: run.id.clone(), at: now, rows: Vec::new() };
    rows.add("error", &format!("{LOST}: {skipped}"), Some(reason));
    rows.rows
}

/// Notes that the person answered the open `question`: the run goes back to work while the answer waits to reach the
/// agent, and an answer to a question that has closed since changes nothing.
pub fn answered(run: &mut Run, follow: &mut SessionFollow, question: &str) {
    if follow.question.as_deref() != Some(question) {
        return;
    }
    follow.answered = Some(question.to_owned());
    settle(run, follow);
    if run.state == RunState::Working && follow.permissions.is_empty() {
        run.asking = false;
        run.needs = None;
        run.last_detail = Some(ANSWER_WAITS.into());
    }
}

/// What the open requests leave the run waiting on, while it is not over.
fn settle(run: &mut Run, follow: &SessionFollow) {
    if follow.closed || run.state == RunState::Failed {
        return;
    }
    if !follow.permissions.is_empty() {
        run.state = RunState::NeedsPermission;
    } else if follow.question.is_some() && follow.answered != follow.question {
        run.state = RunState::NeedsAnswer;
    } else if follow.in_turn || matches!(run.state, RunState::NeedsAnswer | RunState::NeedsPermission) {
        run.state = RunState::Working;
    }
}

/// The event as its type, with what a withheld one did not keep left empty. Its kept fields still say how a turn ended,
/// what was asked for and what was answered.
fn readable(body: &Body) -> Option<Body> {
    let Body::Withheld { of, kept } = body else { return Some(body.clone()) };
    let mut fields = kept.clone();
    fields.insert("type".into(), Value::String(of.clone()));
    for field in PRIVATE_FIELDS {
        let empty = match *field {
            "text" | "reason" => Value::String(String::new()),
            _ => Value::Null,
        };
        fields.entry(field.to_string()).or_insert(empty);
    }
    serde_json::from_value(Value::Object(fields)).ok()
}

struct Rows {
    run_id: String,
    at: DateTime<Utc>,
    rows: Vec<RunEvent>,
}

impl Rows {
    /// A row, redacted and cut. Text with nothing left after that adds none.
    fn add(&mut self, kind: &str, text: &str, detail: Option<&str>) {
        let text = redact(text.trim());
        if text.is_empty() {
            return;
        }
        let (text, rest) = split_at_chars(&text, TEXT_KEPT);
        let detail = match (rest, detail.map(|d| redact(d.trim())).filter(|d| !d.is_empty())) {
            (Some(rest), _) => Some(cut(&rest, DETAIL_KEPT)),
            (None, detail) => detail.map(|d| cut(&d, DETAIL_KEPT)),
        };
        self.rows.push(RunEvent { run_id: self.run_id.clone(), seq: 0, at: self.at, kind: kind.into(), text, detail });
    }
}

fn split_at_chars(text: &str, max: usize) -> (String, Option<String>) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (text[..at].to_owned(), Some(text[at..].to_owned())),
        None => (text.to_owned(), None),
    }
}

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|line| !line.is_empty()).map(|line| cut(&redact(line), 200))
}

fn tool_kind(name: &str) -> &'static str {
    match name {
        "Read" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edit",
        "Grep" | "Glob" | "WebSearch" | "WebFetch" => "search",
        "Bash" => "run",
        _ => "update",
    }
}

/// A tool and the one field of its input that says what it does: the command, the file, the pattern or the address.
fn describe(name: &str, input: &Value) -> String {
    let field = ["command", "file_path", "path", "pattern", "url", "query"].iter().find_map(|key| input.get(*key).and_then(Value::as_str));
    match field.and_then(|f| f.lines().next()).map(|f| cut(f.trim(), 200)) {
        Some(what) if !what.is_empty() => format!("{name}: {what}"),
        _ => name.to_owned(),
    }
}

fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A result as the run shows it: its `note` when it has one, else the whole of it.
fn result_text(data: &Value) -> String {
    match data.get("note").and_then(Value::as_str) {
        Some(note) => note.to_owned(),
        None => serde_json::to_string_pretty(data).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests;
