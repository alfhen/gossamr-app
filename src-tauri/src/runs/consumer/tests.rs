use chrono::Utc;
use harness::event::{Body, Decision, Event, FailKind, QuestionEnd, TurnEnd};
use serde_json::json;

use super::*;
use crate::domain::fixtures::run_spec;
use crate::domain::{Run, RunState, SessionFollow};

struct Played {
    run: Run,
    follow: SessionFollow,
    rows: Vec<RunEvent>,
    seq: u64,
}

impl Played {
    fn new() -> Played {
        let mut run = Run::queued("r1".into(), "p1".into(), "c1".into(), None, run_spec(), Utc::now());
        run.state = RunState::Launching;
        Played { run, follow: SessionFollow::default(), rows: Vec::new(), seq: 0 }
    }

    fn play(&mut self, bodies: impl IntoIterator<Item = Body>) -> &mut Played {
        for body in bodies {
            self.seq += 1;
            let event = Event { seq: self.seq, ms: 1_700_000_000_000 + self.seq as i64, body, cut: None };
            let rows = fold(&mut self.run, &mut self.follow, &event, Utc::now());
            self.rows.extend(rows);
        }
        self
    }

    fn kinds(&self) -> Vec<&str> {
        self.rows.iter().map(|row| row.kind.as_str()).collect()
    }
}

fn started() -> Vec<Body> {
    vec![Body::Prompted { text: "the brief".into() }, Body::TurnStarted, Body::Started { provider_session: "p".into(), resumed: false }]
}

#[test]
fn a_turn_that_streams_and_ends_reads_working_then_done_with_its_timeline() {
    let mut p = Played::new();
    p.play(started());
    assert_eq!(p.run.state, RunState::Working);
    p.play([
        Body::Text { text: "Looking at the code.".into() },
        Body::ToolCall { id: "t1".into(), name: "Bash".into(), input: json!({ "command": "cargo test\nmore" }) },
        Body::ToolResult { id: "t1".into(), output: json!("ok"), error: false },
    ]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Working, Some("Bash: cargo test")));
    p.play([Body::Result { data: json!({ "status": "done", "note": "All green." }) }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.state, RunState::Done);
    assert_eq!((p.run.result.as_deref(), p.run.result_complete), (Some("All green."), true));
    assert!(p.run.ended_at.is_some());
    assert_eq!(p.kinds(), ["start", "update", "run", "done", "done"], "the brief is no row, a result is");
    assert_eq!((p.follow.turns, p.follow.in_turn), (1, false));
}

#[test]
fn turns_are_counted_by_their_end_not_by_prompt() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::TurnEnded { how: TurnEnd::Done }, Body::TurnStarted, Body::Text { text: "a background task ended".into() }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!((p.follow.prompts, p.follow.turns), (1, 2), "one prompt, two turns");
}

#[test]
fn a_question_waits_on_the_person_through_the_end_of_its_turn_until_it_is_answered() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }]);
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.run.asking), (RunState::NeedsAnswer, Some("Which colour?"), true));
    p.play([Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.state, RunState::NeedsAnswer, "an open question outlasts its turn");
    assert!(p.run.ended_at.is_none());
    p.play([Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Answered }, Body::Prompted { text: "Blue".into() }, Body::TurnStarted]);
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.run.asking), (RunState::Working, None, false));
    assert!(p.kinds().contains(&"follow_up"), "the answer sent as a prompt is a message");
}

#[test]
fn a_permission_request_waits_then_its_answer_goes_back_to_work() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Permission { id: "p1".into(), kind: harness::event::PermissionKind::Command, tool: "Bash".into(), input: json!({ "command": "rm -rf build" }) }]);
    assert_eq!((p.run.state, p.run.needs.as_deref()), (RunState::NeedsPermission, Some("Wants to use Bash: rm -rf build")));
    assert_eq!(p.follow.permissions, vec![("p1".to_owned(), false, "Wants to use Bash: rm -rf build".to_owned())]);
    p.play([Body::Answered { id: "p1".into(), decision: Decision::Allow, message: None }]);
    assert_eq!((p.run.state, p.run.needs.as_deref()), (RunState::Working, None));
}

#[test]
fn a_cut_permission_request_is_kept_as_one_that_can_only_be_denied() {
    let mut p = Played::new();
    p.play(started());
    let body = Body::Permission { id: "p1".into(), kind: harness::event::PermissionKind::Command, tool: "Bash".into(), input: json!("cut") };
    let event = Event { seq: 9, ms: 0, body, cut: Some(40) };
    fold(&mut p.run, &mut p.follow, &event, Utc::now());
    assert_eq!(p.follow.permissions, vec![("p1".to_owned(), true, "Wants to use Bash".to_owned())]);
}

#[test]
fn an_event_applied_once_is_passed_over_and_one_never_stored_moves_nothing() {
    let mut p = Played::new();
    p.play(started());
    let again = Event { seq: 2, ms: 0, body: Body::Text { text: "again".into() }, cut: None };
    assert!(fold(&mut p.run, &mut p.follow, &again, Utc::now()).is_empty());
    let unstored = Event { seq: 0, ms: 0, body: Body::Failed { kind: FailKind::Harness, reason: "the store failed".into() }, cut: None };
    fold(&mut p.run, &mut p.follow, &unstored, Utc::now());
    assert_eq!((p.run.state, p.follow.seq), (RunState::Failed, 3));
}

#[test]
fn a_stop_reads_stopped_and_a_finished_run_stays_done_when_its_session_closes() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::TurnEnded { how: TurnEnd::Cancelled }, Body::Closed]);
    assert_eq!(p.run.state, RunState::Stopped);
    assert!(p.follow.closed);
    let mut done = Played::new();
    done.play(started());
    done.play([Body::TurnEnded { how: TurnEnd::Done }, Body::Closed]);
    assert_eq!(done.run.state, RunState::Done);
}

#[test]
fn a_deny_that_ends_the_turn_reads_stopped_after_a_deny() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::TurnEnded { how: TurnEnd::Denied }]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Stopped, Some(STOPPED_AFTER_DENY)));
}

#[test]
fn a_failure_keeps_its_reason_redacted_and_a_signed_out_login_says_so() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Failed { kind: FailKind::SignedOut, reason: "not signed in, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789".into() }]);
    assert_eq!((p.run.state, p.run.failure.clone()), (RunState::Failed, Some(RunFailure::NotSignedIn)));
    assert!(!p.run.error.as_deref().unwrap().contains("abcdefghijklmnop"), "the reason is redacted");
    assert!(p.rows.iter().all(|row| !row.text.contains("abcdefghijklmnop")), "and so is its row");
}

#[test]
fn waiting_for_a_slot_says_so_until_the_turn_starts() {
    let mut p = Played::new();
    p.play([Body::Prompted { text: "the brief".into() }, Body::Waiting]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Launching, Some(SLOT_WAIT)));
    p.play([Body::TurnStarted]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Working, None));
}

#[test]
fn a_withheld_event_still_moves_the_run_by_what_it_kept() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Text { text: "x".into() }.withheld(), Body::TurnEnded { how: TurnEnd::Done }.withheld()]);
    assert_eq!(p.run.state, RunState::Done, "how the turn ended is kept");
}

#[test]
fn a_hand_over_reads_handed_over() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::TurnEnded { how: TurnEnd::Cancelled }, Body::HandedOver, Body::Closed]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Stopped, Some(HANDED_OVER)));
}

#[test]
fn a_turn_cut_by_a_stop_the_app_asked_for_reads_stopped_and_one_it_did_not_reads_failed() {
    let cut = || Body::Failed { kind: FailKind::AgentStopped, reason: "the agent stopped in the middle of a turn".into() };
    let mut asked = Played::new();
    asked.play(started());
    asked.follow.stop_asked = true;
    asked.play([cut(), Body::Closed]);
    assert_eq!(asked.run.state, RunState::Stopped);
    let mut not = Played::new();
    not.play(started());
    not.play([cut(), Body::Closed]);
    assert_eq!(not.run.state, RunState::Failed);
}

#[test]
fn a_loss_names_the_events_it_skipped_and_reads_on_after_them() {
    let mut p = Played::new();
    p.play(started());
    let rows = lost(&mut p.run, &mut p.follow, "events were lost: swept", 9, Utc::now());
    assert_eq!((rows[0].text.as_str(), p.follow.seq, p.follow.lost), (format!("{LOST}: events 4 to 9 were skipped").as_str(), 9, 1));
    assert_eq!(rows[0].detail.as_deref(), Some("events were lost: swept"));
    let one = lost(&mut p.run, &mut p.follow, "again", 10, Utc::now());
    assert_eq!((one[0].text.as_str(), p.follow.lost), (format!("{LOST}: event 10 was skipped").as_str(), 2));
    let none = lost(&mut p.run, &mut p.follow, "behind", 3, Utc::now());
    assert_eq!((none[0].text.as_str(), p.follow.seq), (format!("{LOST}: no stored event was skipped").as_str(), 10), "never back");
}

#[test]
fn a_deny_that_closes_the_held_question_before_the_turn_ends_reads_stopped_after_a_deny() {
    let mut p = Played::new();
    p.play(started());
    p.play([
        Body::Question { id: "q1".into(), text: "Which colour?".into() },
        Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Denied },
        Body::TurnEnded { how: TurnEnd::Denied },
    ]);
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.follow.question.as_deref()), (RunState::Stopped, None, None));
    assert_eq!(p.run.last_detail.as_deref(), Some(STOPPED_AFTER_DENY));
}

#[test]
fn a_run_shows_what_it_still_waits_on_once_one_of_its_requests_is_answered() {
    let mut p = Played::new();
    p.play(started());
    let wants = |id: &str, command: &str| Body::Permission { id: id.into(), kind: harness::event::PermissionKind::Command, tool: "Bash".into(), input: json!({ "command": command }) };
    p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }, wants("p1", "rm a"), wants("p2", "rm b")]);
    assert_eq!((p.run.state, p.run.needs.as_deref()), (RunState::NeedsPermission, Some("Wants to use Bash: rm a")), "the oldest request first");
    p.play([Body::Answered { id: "p1".into(), decision: Decision::Allow, message: None }]);
    assert_eq!(p.run.needs.as_deref(), Some("Wants to use Bash: rm b"));
    p.play([Body::Answered { id: "p2".into(), decision: Decision::Deny, message: None }]);
    assert_eq!((p.run.state, p.run.needs.as_deref()), (RunState::NeedsAnswer, Some("Which colour?")), "then the question");
}

#[test]
fn an_answer_the_harness_took_reads_working_until_it_reaches_the_agent() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }, Body::TurnEnded { how: TurnEnd::Done }, Body::TurnStarted]);
    assert_eq!(p.run.state, RunState::NeedsAnswer, "a turn of its own started before the answer");
    answered(&mut p.run, &mut p.follow, "q1");
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.run.last_detail.as_deref()), (RunState::Working, None, Some(ANSWER_WAITS)));
    p.play([Body::Text { text: "still busy".into() }]);
    assert_eq!(p.run.state, RunState::Working, "the answered question waits on no one");
    p.play([Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.state, RunState::Working, "not done while the answer is on its way");
    p.play([Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Answered }, Body::Prompted { text: "Blue".into() }, Body::TurnStarted]);
    assert_eq!((p.follow.answered.as_deref(), p.follow.question.as_deref()), (None, None));
    answered(&mut p.run, &mut p.follow, "q1");
    assert!(p.follow.answered.is_none(), "an answer to a closed question changes nothing");
}
