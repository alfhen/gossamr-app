//! Turns a harness session's events into its run's state and timeline. Nothing here reads a CLI's files or a listing:
//! the run is what its session says, in the order the harness numbered it.
//!
//! `fold` is pure. The link applies it inside the transaction that also stores the run, its timeline rows and how far
//! the session was followed (`Db::apply_session`), so an event is applied once, and one already applied is passed over.

use chrono::{DateTime, Utc};
use harness::event::{Body, ClosedBy, Decision, Event, FailKind, PermissionKind, QuestionEnd, TurnEnd, PRIVATE_FIELDS};
use serde_json::Value;

use super::redact::redact;
use super::tracker::cleaned_answer;
use crate::domain::{PermissionRequest, Run, RunEvent, RunFailure, RunState, SessionFollow};

const TEXT_KEPT: usize = 500;
const DETAIL_KEPT: usize = 2_048;
const NEEDS_KEPT: usize = super::tracker::NEEDS_KEPT;

pub const SLOT_WAIT: &str = "Waits for a free slot: the harness runs as many agents as it allows";
pub const HANDED_OVER: &str = "Handed over to Terminal";
pub const STOPPED_AFTER_DENY: &str = "Stopped after a deny";
pub const LOST: &str = "Part of this run's record was lost";
pub const ANSWER_WAITS: &str = "Your answer waits for the turn to end";
pub const ANSWER_WAITS_RESUME: &str = "Your answer waits for the session to resume";
pub const SIGNING_NEEDS_YOU: &str = "A commit needs your signing agent, which refused it: unlock it (for example 1Password), then message the agent to commit again.";
pub const NOT_DELIVERED: &str = "Your message didn't reach the agent: its session ended before it read it. Send it again; if the run takes no message, ask Pip to start it again.";
pub const SIGNING_NEEDS_YOU_CLOSED: &str = "A commit needs your signing agent, which refused it, and the run's session has since ended: unlock it (for example 1Password), then ask Pip to start it again.";
pub const AGENT_LOST: &str = "The harness lost this run's agent: it stopped without saying so. Message the agent to start it again.";
/// What a Stop that found the agent lost says: the run is over, so no message starts it again.
pub const LOST_AT_STOP: &str = "Stopped. The harness had already lost its agent.";
pub const CUT: &str = "The agent stopped in the middle of a turn";
pub const CUT_AGAIN: &str = "Its turn was cut short again after Gossamr carried on three times in a row. Message the agent to start it again.";
/// How many times in a row the app carries a cut run on, with no turn ending by itself between.
pub const CARRY_ONS: u32 = 3;
const NOT_KEPT: &str = "Asked a question; its text was not kept";

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
    // A take back or a resume that failed or closed again did not start: its run is no longer one starting up.
    if matches!(body, Body::Failed { .. } | Body::Closed { .. }) {
        (follow.taken_back, follow.resuming) = (false, false);
    }
    match body {
        Body::Started { resumed: true, provider_session } => {
            follow.provider_session = Some(provider_session);
            follow.closed = false;
            follow.stop_asked = false;
            follow.ended = false;
            (follow.taken_back, follow.resuming) = (false, false);
            run.handed_over = false;
            reopen(run);
            if follow.answered.is_some() {
                run.last_detail = Some(ANSWER_WAITS.into());
            }
            rows.add("follow_up", "Resumed", None);
        }
        Body::Started { provider_session, .. } => {
            follow.provider_session = Some(provider_session);
            rows.add("start", "Started", None);
        }
        Body::Prompted { text } => {
            follow.prompts += 1;
            // The first prompt is the brief the person approved; each later one is a message to the agent, but for
            // Gossamr's own carry on, whose row the carry on writes.
            if follow.prompts > 1 && text != super::on_harness::CARRY_ON {
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
        // A message taken while the session was ending never reached the agent: say so where it is read.
        Body::PromptsDropped => {
            run.last_detail = Some(NOT_DELIVERED.into());
            rows.add("error", NOT_DELIVERED, None);
        }
        Body::TurnStarted => {
            follow.in_turn = true;
            follow.cut = None;
            reopen(run);
            if run.last_detail.as_deref() == Some(SLOT_WAIT) {
                run.last_detail = None;
            }
        }
        Body::Text { text } => {
            run.last_detail = first_line(&text);
            rows.add("update", &text, None);
        }
        Body::ToolCall { id, name, input } => {
            if runs_git_commit(&input) {
                follow.commits.push(id);
            }
            let what = describe(&name, &input);
            run.last_detail = Some(redact(&what));
            rows.add(tool_kind(&name), &what, None);
        }
        Body::ClientToolCall { id, name, input } => {
            rows.add("read", &format!("Asked Gossamr: {name}"), None);
            follow.calls.push((id, name, input));
        }
        Body::ToolResult { id, error, output } => {
            follow.calls.retain(|(open, ..)| *open != id);
            let said = plain(&output);
            let commit = follow.commits.iter().position(|open| *open == id).map(|at| follow.commits.remove(at)).is_some();
            if commit && error && signing_refused(&said) {
                follow.signing_refused = true;
                rows.add("error", "A commit wasn't signed: your signing agent refused it", Some(&said));
            } else if commit && !error {
                // Committed after all, signed: the turn's work is safe.
                follow.signing_refused = false;
            } else if error {
                rows.add("error", "A tool call failed", Some(&said));
            }
        }
        Body::Permission { id, kind, tool, input } => {
            let harness_cut = event.cut.is_some();
            let asked = request(id.clone(), kind, tool.clone(), input, harness_cut);
            let what = summary(&tool, &asked.input, harness_cut);
            follow.permissions.push((id, asked.deny_only, cut(&redact(&format!("Wants to use {what}")), NEEDS_KEPT)));
            run.permissions.push(asked);
            rows.add("ask", &format!("Asks to use {what}"), None);
        }
        // An answer to it is refused from now on, so it waits on no one; settling shows what the run waits on instead.
        Body::PermissionClosed { id } => {
            follow.permissions.retain(|(open, ..)| *open != id);
            rows.add("update", "It withdrew the request before you answered", None);
        }
        Body::Answered { id, decision, .. } => {
            follow.permissions.retain(|(open, ..)| *open != id);
            rows.add("update", match decision {
                Decision::Allow => "You allowed it",
                Decision::Deny => "You denied it",
                Decision::Other => "It was answered",
            }, None);
        }
        Body::Question { id, text } => {
            // A withheld question keeps no text: keep what was read of it, or say so.
            let kept = follow.asked.clone().filter(|_| follow.question.as_deref() == Some(id.as_str()));
            let text = if text.trim().is_empty() { kept.unwrap_or_else(|| NOT_KEPT.into()) } else { text };
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
                drop_answer(run, follow);
            }
            match how {
                QuestionEnd::Answered => rows.add("update", "Its question was answered", None),
                QuestionEnd::Stopped => rows.add("stop", "Its question was closed: the run was stopped", None),
                QuestionEnd::HandedOver => rows.add("stop", "Its question was closed: the run was handed over", None),
                QuestionEnd::Denied => rows.add("stop", "Its question was closed: a deny ended its turn", None),
                QuestionEnd::CleanedUp => rows.add("stop", "Its question was closed: the run was cleaned up", None),
                QuestionEnd::NotResumable => rows.add("stop", "Its question was closed: no answer can reach the agent now", None),
                QuestionEnd::Other => rows.add("stop", "Its question was closed", None),
            }
            // Nothing resumes a session after these, so nothing more comes from it.
            if matches!(how, QuestionEnd::CleanedUp | QuestionEnd::NotResumable) {
                follow.ended = true;
                follow.closed = true;
            }
            if follow.closed && follow.question.is_none() && matches!(run.state, RunState::NeedsAnswer | RunState::NeedsPermission) {
                run.state = RunState::Stopped;
                run.ended_at.get_or_insert(now);
            }
        }
        // A withheld result kept nothing to show; the run keeps what it had.
        Body::Result { data: Value::Null } => rows.add("done", "Gave its result", None),
        Body::Result { data } => {
            run.result = cleaned_answer(&result_text(&data));
            run.result_complete = run.result.is_some();
            rows.add("done", "Gave its result", None);
        }
        Body::TurnEnded { how } => {
            follow.in_turn = false;
            follow.turns += 1;
            follow.permissions.clear();
            follow.calls.clear();
            follow.commits.clear();
            match how {
                TurnEnd::Done => {
                    follow.carry_ons = 0;
                    rows.add("done", "Finished its turn", None);
                }
                TurnEnd::Cancelled => rows.add("stop", "Its turn was cancelled", None),
                TurnEnd::Denied => rows.add("stop", STOPPED_AFTER_DENY, None),
                TurnEnd::Other => rows.add("stop", "Its turn ended", None),
            }
            if follow.question.is_none() {
                run.state = if how == TurnEnd::Done { RunState::Done } else { RunState::Stopped };
                run.last_detail = (how == TurnEnd::Denied).then(|| STOPPED_AFTER_DENY.into()).or(run.last_detail.take());
                run.ended_at = Some(now);
            }
            // The turn's work could not be committed, whatever the agent made of it: the person has to act. A turn that
            // ends on a question keeps the mark for the turn its answer starts.
            if follow.question.is_none() && std::mem::take(&mut follow.signing_refused) {
                run.state = RunState::Failed;
                run.error = Some(SIGNING_NEEDS_YOU.into());
                run.failure = Some(RunFailure::SigningNeedsYou);
            }
        }
        Body::Failed { kind: FailKind::AgentStopped, .. } if follow.stop_asked => {
            follow.in_turn = false;
            follow.permissions.clear();
            follow.calls.clear();
            run.state = RunState::Stopped;
            run.ended_at = Some(now);
        }
        // Nobody asked for it: a shutdown of the harness, or the agent's own end. Neither fails the run or wakes Pip;
        // an open question stays for after a resume.
        // A `failed` between turns of a run that is over ended nothing it was doing: a logout's signal or an out of memory
        // kill that reached an idle agent, a shutdown that could not finish, the idle session of a harness that went. Its
        // row says so and the run stays as it was, so nobody is woken. One before the first turn, a setup that failed,
        // still fails its run below.
        Body::Failed { reason, .. } if !follow.in_turn && matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped) => {
            follow.permissions.clear();
            follow.calls.clear();
            rows.add("update", &reason, None);
        }
        // An agent that stopped between turns cut nothing, whatever the run waits on, and nothing carries it on.
        Body::Failed { kind: FailKind::AgentStopped, .. } if !follow.in_turn => {
            follow.permissions.clear();
            follow.calls.clear();
        }
        Body::Failed { kind: FailKind::AgentStopped, reason } => {
            follow.in_turn = false;
            follow.cut = Some(reason.clone());
            follow.permissions.clear();
            follow.calls.clear();
            run.state = RunState::Stopped;
            run.last_detail = Some(CUT.into());
            run.ended_at = Some(now);
            rows.add("stop", CUT, Some(&reason));
        }
        Body::Failed { kind, reason } => {
            follow.in_turn = false;
            follow.permissions.clear();
            follow.calls.clear();
            drop_answer(run, follow);
            run.state = RunState::Failed;
            run.error = Some(cut(&redact(&reason), DETAIL_KEPT));
            run.failure = Some(if kind == FailKind::SignedOut { RunFailure::NotSignedIn } else { RunFailure::Other });
            run.ended_at = Some(now);
            rows.add("error", &reason, None);
        }
        Body::Notice { text } => rows.add("update", &text, None),
        // What a turn used is no row of the timeline.
        Body::Usage { .. } => {}
        Body::HandedOver => {
            run.handed_over = true;
            run.last_detail = Some(HANDED_OVER.into());
            rows.add("stop", HANDED_OVER, None);
        }
        // The session's task ended. Only after a stop the app asked for is that the end: a shutdown or a hand-over
        // can be resumed, and its question stays until a `question_closed`.
        Body::Closed { by } => {
            // A message can no longer reach it, so the way out its failure names is the one that still works.
            if run.failure == Some(RunFailure::SigningNeedsYou) {
                run.error = Some(SIGNING_NEEDS_YOU_CLOSED.into());
            }
            match (by, follow.cut.take()) {
                // A Stop or a hand-over from elsewhere is someone's choice, which "carry on" must not undo.
                (ClosedBy::Stop | ClosedBy::HandOver, _) | (_, None) => {}
                // The agent's own end (a crash, a kill from outside) or the harness giving up on it: a failure the
                // person hears of, named as its `failed` named it. One waiting on a question is resumed by the answer.
                (ClosedBy::Agent | ClosedBy::Harness, Some(reason)) => {
                    if follow.question.is_none() {
                        fail_cut(run, &mut rows, &reason);
                    }
                }
                (_, Some(reason)) => {
                    follow.cut = Some(reason);
                    cut_again(run, follow, &mut rows);
                }
            }
            follow.closed = true;
            follow.ended = follow.stop_asked;
            follow.in_turn = false;
            follow.permissions.clear();
            follow.calls.clear();
            if follow.ended {
                follow.question = None;
                follow.asked = None;
                drop_answer(run, follow);
            }
            if follow.question.is_none() {
                if !matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped) {
                    run.state = RunState::Stopped;
                    rows.add("stop", "Stopped", None);
                }
                run.ended_at.get_or_insert(now);
            }
        }
        Body::Withheld { .. } => {}
    }
    waits(run, follow);
    if run.state != before || !rows.rows.is_empty() {
        run.last_progress_at = now;
    }
    rows.rows
}

/// Notes that the harness took the person's answer to the open permission request `request`: it waits on no one now,
/// before its `answered` comes, so a second answer is refused and the run shows what it waits on next.
pub fn permission_answered(run: &mut Run, follow: &mut SessionFollow, request: &str) {
    follow.permissions.retain(|(open, ..)| open != request);
    waits(run, follow);
}

/// Rebuilds the open requests of a run saved before runs kept them, which only its follow has: from the harness's
/// `asked` events where it still has them, else deny-only with what the follow kept, since nothing the person did not
/// see whole may be allowed.
pub fn recover_permissions(run: &mut Run, follow: &SessionFollow, asked: &[Event]) {
    let mut kept = std::mem::take(&mut run.permissions);
    for (id, deny_only, need) in &follow.permissions {
        if let Some(at) = kept.iter().position(|open| open.id == *id) {
            run.permissions.push(kept.remove(at));
            continue;
        }
        let read = asked.iter().find_map(|event| match readable(&event.body) {
            Some(Body::Permission { id: got, kind, tool, input }) if got == *id => Some((kind, tool, input, event.cut.is_some())),
            _ => None,
        });
        run.permissions.push(match read {
            // The follow's flag is an older build's, which knew fewer reasons: either one denies.
            Some((kind, tool, input, cut)) => {
                let read = request(id.clone(), kind, tool, input, cut);
                PermissionRequest { deny_only: *deny_only || read.deny_only, ..read }
            }
            None => {
                let masked = need.contains(harness::redact::MASK) || need.contains(super::redact::MASK);
                PermissionRequest { id: id.clone(), kind: PermissionKind::Other, tool: String::new(), subject: need.clone(), input: Value::Null, masked, deny_only: true }
            }
        });
    }
}

/// What the open requests leave the run waiting on, and what it shows for it.
fn waits(run: &mut Run, follow: &SessionFollow) {
    run.permissions.retain(|asked| follow.permissions.iter().any(|(open, ..)| *open == asked.id));
    settle(run, follow);
    run.answer_waits = follow.answered.is_some();
    run.asking = run.state == RunState::NeedsAnswer;
    // What it waits on now: the oldest permission request, else the question, whichever event closed the other.
    run.needs = match run.state {
        RunState::NeedsPermission => follow.permissions.first().map(|(.., need)| need.clone()),
        RunState::NeedsAnswer => follow.asked.clone(),
        _ => None,
    };
}

/// Ends a turn the harness can no longer say the end of: its agent went with a harness that stopped with no shutdown.
/// It reads as a cut, which no one is woken for and "carry on" may take up; an open question stays.
pub fn agent_lost(run: &mut Run, follow: &mut SessionFollow, now: DateTime<Utc>) -> Vec<RunEvent> {
    follow.in_turn = false;
    follow.closed = true;
    follow.cut = Some(AGENT_LOST.into());
    follow.permissions.clear();
    run.permissions.clear();
    follow.calls.clear();
    run.state = RunState::Stopped;
    let said = if follow.stop_asked { LOST_AT_STOP } else { AGENT_LOST };
    run.last_detail = Some(said.into());
    run.ended_at = Some(now);
    let mut rows = Rows { run_id: run.id.clone(), at: now, rows: Vec::new() };
    rows.add("stop", said, None);
    // A Stop that found the agent lost is the person's end of the run: nothing is left to answer or carry on.
    if follow.stop_asked {
        follow.ended = true;
        follow.cut = None;
        follow.question = None;
        follow.asked = None;
        drop_answer(run, follow);
    } else {
        cut_again(run, follow, &mut rows);
    }
    settle(run, follow);
    run.asking = run.state == RunState::NeedsAnswer;
    run.needs = (run.state == RunState::NeedsAnswer).then(|| follow.asked.clone()).flatten();
    run.last_progress_at = now;
    rows.rows
}

/// A cut after `CARRY_ONS` carry-ons in a row is not carried on again: it fails, so the person hears of it.
fn cut_again(run: &mut Run, follow: &mut SessionFollow, rows: &mut Rows) {
    // It stays cut, so a message from the person can still resume it.
    if follow.carry_ons >= CARRY_ONS && follow.question.is_none() {
        fail_cut(run, rows, CUT_AGAIN);
    }
}

fn fail_cut(run: &mut Run, rows: &mut Rows, reason: &str) {
    run.state = RunState::Failed;
    run.error = Some(cut(&redact(reason), DETAIL_KEPT));
    run.failure = Some(RunFailure::Other);
    rows.add("error", reason, None);
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
    // On the run too, so the person sees it when its timeline is full and keeps no new row.
    run.last_detail = Some(format!("{LOST}: {skipped}"));
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
    run.answer_waits = true;
    settle(run, follow);
    if run.state == RunState::Working && follow.permissions.is_empty() {
        run.asking = false;
        run.needs = None;
        run.last_detail = Some(ANSWER_WAITS.into());
    }
}

/// An answer the run waited on that no longer goes anywhere, and the words that said so.
fn drop_answer(run: &mut Run, follow: &mut SessionFollow) {
    follow.answered = None;
    if matches!(run.last_detail.as_deref(), Some(ANSWER_WAITS | ANSWER_WAITS_RESUME)) {
        run.last_detail = None;
    }
}

/// What git says when the signing program refused a commit: it wrote no commit object, and the signer said why.
fn signing_refused(said: &str) -> bool {
    let said = said.to_lowercase();
    // Whole words, so "design" or "assign" is no signer.
    let mut words = said.split(|c: char| !(c.is_alphanumeric() || c == '-'));
    said.contains("failed to write commit object") && words.any(|word| ["sign", "signing", "1password", "gpg", "ssh-keygen", "ssh", "key", "agent"].contains(&word))
}

/// Whether a shell call's command runs `git commit`, past git's own options (`git -C dir -c key=value commit`).
fn runs_git_commit(input: &Value) -> bool {
    let Some(command) = input.get("command").and_then(Value::as_str) else { return false };
    // Split as the shell splits it, so a quoted `-C` folder is one word, and `bash -c "git commit …"` is seen too.
    super::shell::commands(command).iter().any(|words| {
        let mut words = words.iter().map(String::as_str).skip_while(|word| *word != "git" && !word.ends_with("/git")).skip(1);
        while let Some(word) = words.next() {
            match word {
                "-c" | "-C" => {
                    words.next();
                }
                option if option.starts_with('-') => {}
                sub => return sub == "commit",
            }
        }
        false
    })
}

/// A run its session takes up again, after a failed turn, a stop or a close: no longer over.
fn reopen(run: &mut Run) {
    run.ended_at = None;
    if matches!(run.state, RunState::Failed | RunState::Stopped | RunState::Done) {
        run.state = RunState::Working;
        run.error = None;
        run.failure = None;
    }
}

/// What the open requests leave the run waiting on, while it is not over. A question outlasts a close it was not
/// closed by.
fn settle(run: &mut Run, follow: &SessionFollow) {
    if follow.ended || run.state == RunState::Failed {
        return;
    }
    if follow.closed {
        if follow.question.is_some() && follow.answered != follow.question {
            run.state = RunState::NeedsAnswer;
        } else if follow.answered.is_some() {
            // The answer is the harness's, and reaches the agent once the session is resumed.
            run.state = RunState::Stopped;
            run.last_detail = Some(ANSWER_WAITS_RESUME.into());
        } else if matches!(run.state, RunState::NeedsAnswer | RunState::NeedsPermission) {
            run.state = RunState::Stopped;
        }
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

/// The type of an event this build cannot read, which moves its number and nothing else.
pub fn unreadable(body: &Body) -> Option<&str> {
    match body {
        Body::Withheld { of, .. } if readable(body).is_none() => Some(of),
        _ => None,
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

/// The fields of a tool's input that say what it does: the command, the file, the pattern or the address.
const SAYS_WHAT: [&str; 6] = ["command", "file_path", "path", "pattern", "url", "query"];

/// A tool and the one field of its input that says what it does, cut to a line.
fn describe(name: &str, input: &Value) -> String {
    let field = SAYS_WHAT.iter().find_map(|key| input.get(*key).and_then(Value::as_str));
    match field.and_then(|f| f.lines().next()).map(|f| cut(f.trim(), 200)) {
        Some(what) if !what.is_empty() => format!("{name}: {what}"),
        _ => name.to_owned(),
    }
}

/// A permission request as `app.sqlite` keeps it: with the app's own redactor run over it, so a secret the harness let
/// through is never stored. It is masked, so deny-only, wherever that masked anything; the page shows and judges an allow
/// on the harness's own copy (`harness_copy`) instead, held in memory, and falls back to this one only without it.
fn request(id: String, kind: PermissionKind, tool: String, input: Value, cut: bool) -> PermissionRequest {
    build(id, kind, tool, input, cut, true)
}

/// The harness's own copy of the permission request an event asks, masked only by the harness: what the page shows, and
/// what an allow sends, since an allow sends the driver's own copy. A withheld one has no input to show.
pub fn harness_copy(event: &Event) -> Option<PermissionRequest> {
    match readable(&event.body)? {
        Body::Permission { id, kind, tool, input } => Some(build(id, kind, tool, input, event.cut.is_some(), false)),
        _ => None,
    }
}

/// A permission request. A kind this build does not know is still a request, one the person can only deny, as is one
/// cut or masked, and one whose input is not an object: cut to text, or a payload no longer kept. `ours`: run the app's
/// redactor over it too.
fn build(id: String, kind: PermissionKind, tool: String, input: Value, cut: bool, ours: bool) -> PermissionRequest {
    let (input, ours) = if ours { masked_copy(&input) } else { (input, false) };
    let masked = ours || holds_mask(&input);
    let deny_only = cut || masked || kind == PermissionKind::Other || !input.is_object() || !shows_exactly(&input) || stacks_marks(&input);
    PermissionRequest { id, kind, tool, subject: subject(&input), input, masked, deny_only }
}

/// Whether the input holds a field beside the one `subject` shows.
fn holds_more(input: &Value) -> bool {
    let shown = SAYS_WHAT.iter().find(|key| input.get(**key).and_then(Value::as_str).is_some());
    match (input.as_object(), shown) {
        (Some(fields), Some(shown)) => fields.keys().any(|key| key != shown),
        _ => false,
    }
}

/// Whether the page reads every number of it as the value an allow sends: JavaScript holds an integer exactly only
/// within ±(2^53 − 1). A float here is already an `f64`, which goes to the page and back to the agent as the same one.
pub(super) fn shows_exactly(value: &Value) -> bool {
    const SAFE: u64 = (1 << 53) - 1;
    match value {
        // An integer past the `u64` or `i64` range, or written as a float, arrives as an `f64` the harness already rounded.
        Value::Number(n) if n.is_f64() => n.as_f64().is_none_or(|f| f.fract() != 0.0 || f.abs() <= SAFE as f64),
        Value::Number(n) => n.as_u64().is_none_or(|n| n <= SAFE) && n.as_i64().is_none_or(|n| n.unsigned_abs() <= SAFE),
        Value::Array(items) => items.iter().all(shows_exactly),
        Value::Object(fields) => fields.values().all(shows_exactly),
        _ => true,
    }
}

/// `value` with the app's redactor run over every text in it, keys and values, and whether that masked anything.
fn masked_copy(value: &Value) -> (Value, bool) {
    masked_under(value, false)
}

/// `masked_copy`, where `secret` says the value sits under a key that names a secret (`GITHUB_TOKEN`, `password`): then
/// every text in it is masked whole, since `redact` sees the text alone. A number or a flag there is kept, so
/// `"private": true` stays readable.
fn masked_under(value: &Value, secret: bool) -> (Value, bool) {
    match value {
        Value::String(text) if secret && !text.is_empty() => (Value::String(super::redact::MASK.to_owned()), true),
        Value::String(text) => {
            let out = redact(text);
            let masked = out != *text;
            (Value::String(out), masked)
        }
        Value::Array(items) => {
            let (items, masked): (Vec<_>, Vec<_>) = items.iter().map(|item| masked_under(item, secret)).unzip();
            (Value::Array(items), masked.into_iter().any(|m| m))
        }
        Value::Object(fields) => {
            let mut masked = false;
            let mut out = serde_json::Map::new();
            for (key, value) in fields {
                let mut name = redact(key);
                masked |= name != *key;
                // Two keys that mask to one name stay two fields, numbered as the harness numbers them.
                let base = name.clone();
                let mut n = 2;
                while out.contains_key(&name) {
                    name = format!("{base} {n}");
                    n += 1;
                }
                let (value, inner) = masked_under(value, secret || super::redact::is_secret_name(key));
                masked |= inner;
                out.insert(name, value);
            }
            (Value::Object(out), masked)
        }
        other => (other.clone(), false),
    }
}

/// Whether a key or a text in it stacks more than two combining marks on one character, which the page shows only as a
/// count, not as which marks they are. Marks Unicode draws as nothing are shown one by one there, so they don't count.
pub(super) fn stacks_marks(value: &Value) -> bool {
    static STACK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{Mn}\p{Me}--\p{Default_Ignorable_Code_Point}]{3,}").expect("a valid pattern"));
    match value {
        Value::String(text) => STACK.is_match(text),
        Value::Array(items) => items.iter().any(stacks_marks),
        Value::Object(fields) => fields.iter().any(|(key, value)| STACK.is_match(key) || stacks_marks(value)),
        _ => false,
    }
}

/// Whether the harness masked any part of it, in a value or a key.
fn holds_mask(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains(harness::redact::MASK),
        Value::Array(items) => items.iter().any(holds_mask),
        Value::Object(fields) => fields.iter().any(|(key, value)| key.contains(harness::redact::MASK) || holds_mask(value)),
        _ => false,
    }
}

/// A request in a line for the run, the timeline, Needs you and Pip, saying when it holds less than the request: more
/// lines, a line cut, the harness's cut, or more in it than that one field.
fn summary(name: &str, input: &Value, cut_by_harness: bool) -> String {
    let field = SAYS_WHAT.iter().find_map(|key| input.get(*key).and_then(Value::as_str)).map(str::trim).filter(|f| !f.is_empty());
    let less = |line: String, lines: usize, cut_line: bool| {
        if lines > 1 {
            format!("{line} … ({lines} lines)")
        } else if cut_line || cut_by_harness {
            format!("{line} … (cut)")
        } else if holds_more(input) {
            format!("{line} … (and more)")
        } else {
            line
        }
    };
    match field {
        Some(field) => {
            let first = field.lines().next().unwrap_or_default().trim();
            let shown = cut(first, 200);
            less(format!("{name}: {shown}"), field.lines().count(), shown.len() < first.len())
        }
        None if cut_by_harness || input.is_null() || input.as_object().is_some_and(|fields| fields.is_empty()) => less(name.to_owned(), 1, false),
        None => format!("{name} … (and more)"),
    }
}

/// The whole of what a permission request asks for: the field that says it, else its whole input. The input of one the
/// harness cut is text.
fn subject(input: &Value) -> String {
    match SAYS_WHAT.iter().find_map(|key| input.get(*key).and_then(Value::as_str)) {
        Some(field) => field.to_owned(),
        None if input.is_null() => String::new(),
        None => plain(input),
    }
}

fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A `result` as the run's report, for Pip to read as it read `report`: one the harness checked against
/// `report::result_schema`, so one that does not fit it is none.
pub fn report_of(body: &Body) -> Option<crate::runs::report::Report> {
    let Body::Result { data } = body else { return None };
    crate::runs::report::check(data).ok().map(|checked| checked.report)
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
