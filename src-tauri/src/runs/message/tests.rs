use std::time::Duration;

use super::*;
use crate::runs::answer::{MAX_ANSWER_CHARS, REMINDER};
use crate::runs::ask::Outcome;
use crate::runs::rig::{ready, Rig};
use crate::runs::service::Timing;
use crate::runs::testing::{Resume, ResumeCall};

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(100), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5) };

/// A run in a workstream, launched and seen working by the tracker.
async fn working() -> (Rig, Run, String) {
    let mut rig = ready().await;
    rig.svc = std::sync::Arc::new(std::sync::Arc::into_inner(rig.svc).expect("sole owner").with_timing(FAST));
    let (run, ws) = rig.launched_in_workstream(1).await;
    rig.poll().await;
    let run = rig.get(&run).await;
    assert_eq!(run.state, RunState::Working);
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    (rig, run, ws)
}

fn calls(rig: &Rig) -> Vec<String> {
    rig.cli.0.lock().unwrap().calls.clone()
}

fn resumes(rig: &Rig) -> Vec<ResumeCall> {
    rig.cli.0.lock().unwrap().resumes.clone()
}

/// What Pip did to the workstream's runs, as its audit has it: actor, action and detail.
async fn pip_lines(rig: &Rig, ws: &str) -> Vec<(String, Option<String>)> {
    let events = rig.fx.core.workstream_events(&rig.fx.scope, ws).await.unwrap();
    events.into_iter().filter(|e| e.actor == Actor::Pip && e.action != "agent_started").map(|e| (e.action, e.detail)).collect()
}

/// The session lists as finished, as it does once its turn is over.
fn ends_turn(rig: &Rig, run: &Run, state: &str) {
    rig.session(run, |e| {
        e.state = Some(state.into());
        e.status = None;
        e.pid = None;
    });
}

#[tokio::test]
async fn a_message_to_an_agent_waiting_in_ask_is_its_answer_with_no_stop_or_resume() {
    let (rig, run, ws) = working().await;
    let waiting = rig.fx.core.asks().open(&run.id, "Which database?").unwrap();
    let (after, how) = rig.svc.message_agent(&run.id, "  Use staging.\n", Actor::Pip).await.unwrap();
    assert_eq!((how, after.state, after.asking), (Delivery::Answered, RunState::Working, false));
    assert_eq!(waiting.until(Duration::from_secs(1)).await, Outcome::Answered("Use staging.".into()));
    assert!(calls(&rig).is_empty(), "the session was neither stopped nor resumed");
    assert_eq!(pip_lines(&rig, &ws).await, [("run_answered".to_string(), Some("12".to_string()))]);
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.last().map(|e| e.text.as_str()), Some("Pip answered"));
}

#[tokio::test]
async fn a_message_to_a_working_agent_is_queued_outside_the_run_and_a_newer_one_replaces_it() {
    let (rig, run, ws) = working().await;
    let (_, how) = rig.svc.message_agent(&run.id, "First thought.", Actor::Pip).await.unwrap();
    assert_eq!(how, Delivery::Queued);
    rig.svc.message_agent(&run.id, "Second thought.", Actor::Pip).await.unwrap();
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Second thought."));
    assert!(calls(&rig).is_empty());
    rig.poll().await;
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Second thought."), "a poll rewrites the run and leaves the message");
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    assert_eq!(pip_lines(&rig, &ws).await, [("agent_message_queued".to_string(), Some("14".to_string())), ("agent_message_queued".to_string(), Some("15".to_string()))]);
}

#[tokio::test]
async fn a_queued_message_is_the_answer_to_the_agents_next_ask_and_only_once() {
    let (rig, run, ws) = working().await;
    rig.svc.message_agent(&run.id, "Use staging.", Actor::Pip).await.unwrap();
    assert_eq!(take_for_ask(&rig.fx.core, &run, "Which database?").await.as_deref(), Some("Use staging."));
    assert_eq!(take_for_ask(&rig.fx.core, &run, "Again?").await, None);
    assert_eq!(pip_lines(&rig, &ws).await.last(), Some(&("run_answered".to_string(), Some("12".to_string()))));
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.last().map(|e| (e.text.as_str(), e.detail.as_deref())), Some(("Pip answered", Some("It asked: Which database?"))));
}

#[tokio::test]
async fn a_queued_message_resumes_the_session_once_the_agents_turn_ends_done() {
    let (rig, run, ws) = working().await;
    rig.svc.message_agent(&run.id, "Also check the refund path.", Actor::Pip).await.unwrap();
    rig.poll().await;
    assert!(resumes(&rig).is_empty(), "it is still working, so the message waits");

    ends_turn(&rig, &run, "done");
    rig.poll().await;
    let id = run.short_id.clone().unwrap();
    assert_eq!(calls(&rig), [format!("resume:{id}")], "a finished session needs no stop");
    assert_eq!(resumes(&rig), [ResumeCall { session_id: run.session_id.clone().unwrap(), message: format!("{REMINDER}\n\nAlso check the refund path."), cwd: Some(run.expected_worktree.clone()) }]);
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.passes), (RunState::Working, 2));
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap(), None);
    assert!(pip_lines(&rig, &ws).await.iter().any(|(action, _)| action == "run_resumed"));
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert!(events.iter().any(|e| e.kind == "follow_up" && e.text == "Pip sent a message"));
}

#[tokio::test]
async fn a_queued_message_answers_the_question_an_agent_ends_its_turn_with() {
    let (rig, run, _) = working().await;
    rig.svc.message_agent(&run.id, "Use staging.", Actor::Pip).await.unwrap();
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.pid = None;
    });
    rig.poll().await;
    let id = run.short_id.clone().unwrap();
    assert_eq!(calls(&rig), [format!("stop:{id}"), format!("resume:{id}")], "an answer to a question that ended the turn stops, settles and resumes");
    assert_eq!(resumes(&rig)[0].message, format!("{REMINDER}\n\nUse staging."));
    assert_eq!((rig.get(&run).await.state, rig.fx.core.run_message(&run.id).await.unwrap()), (RunState::Working, None));
}

#[tokio::test]
async fn a_queued_message_waits_at_a_permission_prompt_and_is_dropped_when_nobody_can_take_it() {
    let (rig, run, ws) = working().await;
    rig.svc.message_agent(&run.id, "Carry on.", Actor::Pip).await.unwrap();
    rig.set(&run, |r| r.state = RunState::NeedsPermission).await;
    rig.svc.deliver_queued().await;
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Carry on."), "the person answers the prompt first");

    rig.set(&run, |r| r.state = RunState::Failed).await;
    rig.svc.deliver_queued().await;
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap(), None);
    assert!(calls(&rig).is_empty());
    let dropped: Vec<_> = pip_lines(&rig, &ws).await.into_iter().filter(|(action, _)| action == "agent_message_dropped").collect();
    assert_eq!(dropped, [("agent_message_dropped".to_string(), Some("the run is failed".to_string()))]);
}

#[tokio::test]
async fn an_agent_that_ended_its_turn_with_a_question_is_answered_by_stop_and_resume() {
    let (rig, run, _) = working().await;
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.pid = None;
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);
    let (after, how) = rig.svc.message_agent(&run.id, "Use staging.", Actor::Pip).await.unwrap();
    assert_eq!((how, after.state), (Delivery::Answered, RunState::Working));
    let id = run.short_id.clone().unwrap();
    assert_eq!(calls(&rig), [format!("stop:{id}"), format!("resume:{id}")]);
    assert_eq!(resumes(&rig)[0].message, format!("{REMINDER}\n\nUse staging."));
}

#[tokio::test]
async fn a_done_or_stopped_agent_with_a_session_is_resumed_with_the_reminder() {
    for (state, listed) in [(RunState::Done, "done"), (RunState::Stopped, "stopped")] {
        let (rig, run, _) = working().await;
        ends_turn(&rig, &run, listed);
        rig.set(&run, |r| (r.state, r.ended_at) = (state, Some(chrono::Utc::now()))).await;
        let (after, how) = rig.svc.message_agent(&run.id, "One more thing.", Actor::Pip).await.unwrap();
        let id = run.short_id.clone().unwrap();
        assert_eq!((how, after.state, after.passes), (Delivery::Resumed, RunState::Working, 2), "{state:?}");
        assert_eq!(calls(&rig), [format!("resume:{id}")], "{state:?}: nothing to stop");
        assert_eq!(resumes(&rig)[0].message, format!("{REMINDER}\n\nOne more thing."));
    }
}

#[tokio::test]
async fn an_agent_nobody_can_message_is_refused_in_one_sentence_and_nothing_is_touched() {
    let (rig, run, _) = working().await;
    let refuses = |why: &str, got: Error| assert!(got.to_string().contains(why), "{why}: {got}");
    let say = |text: &'static str| {
        let (svc, id) = (rig.svc.clone(), run.id.clone());
        async move { svc.message_agent(&id, text, Actor::Pip).await.unwrap_err() }
    };
    for (state, why) in [
        (RunState::Queued, "hasn't started working yet"),
        (RunState::Launching, "hasn't started working yet"),
        (RunState::Failed, "It failed"),
        (RunState::Unknown, "can't find its session"),
        (RunState::NeedsPermission, "permission prompt; the person answers it in Terminal"),
        (RunState::SystemBlocked, "sign in, in Terminal"),
    ] {
        rig.set(&run, |r| r.state = state).await;
        refuses(why, say("Hello.").await);
    }
    rig.set(&run, |r| (r.state, r.stopped_by_limit) = (RunState::Stopped, true)).await;
    refuses("only the person resumes it", say("Hello.").await);
    rig.set(&run, |r| (r.state, r.stopped_by_limit, r.unsent_answer) = (RunState::Stopped, false, Some("An earlier answer".into()))).await;
    refuses("still waiting to be sent", say("Hello.").await);
    assert!(calls(&rig).is_empty());
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap(), None, "nothing was queued either");
    assert!(rig.svc.message_agent(&run.id, "  ", Actor::Pip).await.is_err());
    assert!(rig.svc.message_agent(&run.id, &"x".repeat(MAX_ANSWER_CHARS + 1), Actor::Pip).await.is_err());
}

#[tokio::test]
async fn a_session_open_in_terminal_is_never_stopped_for_a_message() {
    let (rig, run, _) = working().await;
    rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
    let why = rig.svc.message_agent(&run.id, "Hello.", Actor::Pip).await.unwrap_err().to_string();
    assert!(why.contains("open on it in Terminal"), "{why}");
    assert!(calls(&rig).is_empty());
    assert_eq!(rig.get(&run).await.state, RunState::Done);
}

#[tokio::test]
async fn a_resume_that_fails_leaves_the_agent_as_it_was_and_tells_pip_why() {
    let (rig, run, _) = working().await;
    ends_turn(&rig, &run, "done");
    rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
    rig.cli.with(|s| s.resume = Resume::Exits);
    assert!(rig.svc.message_agent(&run.id, "More please.", Actor::Pip).await.is_err());
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.passes, after.unsent_answer), (RunState::Done, 1, None));
}

fn with_cap(rig: &Rig, cap: usize) {
    let settings = rig.svc.settings();
    rig.svc.set_settings(crate::config::AgentSettings { max_runs: cap, ..settings }).unwrap();
}

#[tokio::test]
async fn pip_cannot_wake_an_agent_in_a_paused_or_closed_workstream_and_a_queued_message_waits() {
    use crate::domain::workstream::PauseReason;
    let (rig, run, ws) = working().await;
    rig.svc.message_agent(&run.id, "Carry on.", Actor::Pip).await.unwrap();
    ends_turn(&rig, &run, "done");
    rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;

    rig.fx.core.pause_workstream(&rig.fx.scope, &ws, PauseReason::Person, Actor::Person).await.unwrap();
    let why = rig.svc.message_agent(&run.id, "Hello.", Actor::Pip).await.unwrap_err().to_string();
    assert!(why.contains("is paused; only the person resumes it"), "{why}");
    rig.svc.deliver_queued().await;
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Carry on."), "kept for when the person resumes");
    assert!(resumes(&rig).is_empty());

    rig.fx.core.resume_workstream(&rig.fx.scope, &ws).await.unwrap();
    rig.fx.core.close_workstream(&rig.fx.scope, &ws).await.unwrap();
    let why = rig.svc.message_agent(&run.id, "Hello.", Actor::Pip).await.unwrap_err().to_string();
    assert!(why.contains("is closed"), "{why}");
    rig.svc.deliver_queued().await;
    assert!(resumes(&rig).is_empty() && rig.fx.core.run_message(&run.id).await.unwrap().is_some());

    let (_, how) = rig.svc.message_agent(&run.id, "From the person.", Actor::Person).await.unwrap();
    assert_eq!(how, Delivery::Resumed, "the pause holds Pip's work, not the person's");
}

#[tokio::test]
async fn a_resume_with_no_free_slot_is_refused_and_a_queued_message_waits_for_one() {
    let (rig, run, _) = working().await;
    rig.svc.message_agent(&run.id, "Carry on.", Actor::Pip).await.unwrap();
    ends_turn(&rig, &run, "done");
    rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
    rig.launched_in_workstream(2).await;
    with_cap(&rig, 1);

    let why = rig.svc.message_agent(&run.id, "Hello.", Actor::Pip).await.unwrap_err().to_string();
    assert!(why.contains("Every agent slot is taken"), "{why}");
    rig.svc.deliver_queued().await;
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Carry on."));
    assert!(resumes(&rig).is_empty());

    with_cap(&rig, 2);
    rig.svc.deliver_queued().await;
    assert_eq!((rig.get(&run).await.state, rig.fx.core.run_message(&run.id).await.unwrap()), (RunState::Working, None));
}

#[tokio::test]
async fn a_finished_session_the_person_attached_to_is_not_resumed() {
    let (rig, run, _) = working().await;
    ends_turn(&rig, &run, "done");
    rig.session(&run, |e| {
        e.status = Some("idle".into());
        e.pid = Some(4242);
    });
    rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
    let why = rig.svc.message_agent(&run.id, "Hello.", Actor::Pip).await.unwrap_err().to_string();
    assert!(why.contains("open on it in Terminal"), "{why}");
    assert!(calls(&rig).is_empty());
}

#[tokio::test]
async fn a_queued_message_whose_wake_fails_is_kept_for_a_few_tries_then_dropped_and_a_newer_one_is_not_overwritten() {
    let (rig, run, ws) = working().await;
    rig.svc.message_agent(&run.id, "Carry on.", Actor::Pip).await.unwrap();
    ends_turn(&rig, &run, "done");
    rig.set(&run, |r| (r.state, r.ended_at) = (RunState::Done, Some(chrono::Utc::now()))).await;
    rig.cli.with(|s| s.resume = Resume::Exits);
    rig.svc.deliver_queued().await;
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Carry on."), "a wake that failed is tried again");
    rig.svc.deliver_queued().await;
    assert!(rig.fx.core.run_message(&run.id).await.unwrap().is_some());
    rig.svc.deliver_queued().await;
    assert!(rig.fx.core.run_message(&run.id).await.unwrap().is_none(), "a wake that keeps failing is dropped");
    assert_eq!(rig.get(&run).await.state, RunState::Done);
    assert!(pip_lines(&rig, &ws).await.iter().any(|(action, _)| action == "agent_message_dropped"));

    rig.fx.core.queue_run_message(&run.id, "Newer.").await.unwrap();
    rig.fx.core.restore_run_message(&run.id, "Older.").await.unwrap();
    assert_eq!(rig.fx.core.run_message(&run.id).await.unwrap().as_deref(), Some("Newer."));
}

#[tokio::test]
async fn pips_answer_never_resumes_an_agent_gossamr_stopped_at_its_limit() {
    let (rig, run, _) = working().await;
    rig.set(&run, |r| (r.state, r.stopped_by_limit, r.ended_at) = (RunState::Stopped, true, Some(chrono::Utc::now()))).await;
    let why = rig.svc.answer_as(&run.id, "Go on.", Actor::Pip).await.unwrap_err().to_string();
    assert!(why.contains("only the person resumes it"), "{why}");
    assert!(rig.get(&run).await.stopped_by_limit);
}
