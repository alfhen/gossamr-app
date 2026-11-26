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
    assert!(p.follow.ended && p.follow.question.is_none(), "nothing more is followed or answered");
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
