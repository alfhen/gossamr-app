use super::*;
use crate::runs::rig::{ready, Rig};
use crate::runs::service::Timing;
use crate::runs::testing::{Resume, ResumeCall};
use std::time::Duration;

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(100), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5), answer_tries: 3, answer_wait: Duration::from_millis(5) };

async fn asking() -> (Rig, Run) {
    let mut rig = ready().await;
    rig.svc = std::sync::Arc::new(std::sync::Arc::into_inner(rig.svc).expect("sole owner").with_timing(FAST));
    let run = rig.launched(1).await;
    rig.job(run.short_id.as_ref().unwrap(), |j| j.suggested_reply = Some("Yes, go ahead".into()));
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.pid = None;
    });
    rig.poll().await;
    let run = rig.get(&run).await;
    assert_eq!(run.state, RunState::NeedsAnswer);
    (rig, run)
}

fn resumes(rig: &Rig) -> Vec<ResumeCall> {
    rig.cli.0.lock().unwrap().resumes.clone()
}

#[tokio::test]
async fn an_answer_stops_the_session_then_wakes_it_with_nothing_but_the_message() {
    let (rig, run) = asking().await;
    assert_eq!(run.suggested_reply.as_deref(), Some("Yes, go ahead"));
    let id = run.short_id.clone().unwrap();
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    let answered = rig.svc.answer(&run.id, "  Use the staging database.\n").await.unwrap();

    assert_eq!((answered.state, answered.short_id.as_ref(), answered.needs, answered.suggested_reply, answered.error, answered.ended_at), (RunState::Working, Some(&id), None, None, None, None));
    {
        let cli = rig.cli.0.lock().unwrap();
        assert_eq!(cli.calls, [format!("stop:{id}"), format!("resume:{id}")]);
        assert_eq!(cli.resumes, [ResumeCall { session_id: run.session_id.clone().unwrap(), message: format!("{REMINDER}\n\nUse the staging database."), cwd: Some(run.expected_worktree.clone()) }]);
        assert!(cli.launches.len() == 1, "no second launch");
    }
    assert!(rig.svc.index.live().iter().any(|e| e.run_id == run.id), "the run counts as running again");
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(events.last().map(|e| e.text.as_str()), Some("You answered"));
    assert!(events.iter().all(|e| !e.text.contains("staging") && e.detail.as_deref().is_none_or(|d| !d.contains("staging"))), "the answer itself isn't logged");
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working, "the tracker carries on with the same run");
}

#[tokio::test]
async fn without_a_worktree_on_disk_the_session_is_woken_from_the_clone() {
    let (rig, run) = asking().await;
    rig.svc.answer(&run.id, "Yes").await.unwrap();
    assert_eq!(resumes(&rig)[0].cwd.as_deref(), Some(run.spec.clone_path.as_path()));
}

#[tokio::test]
async fn the_agents_own_words_come_with_the_reminder_whatever_the_answer_says() {
    let (rig, run) = asking().await;
    rig.svc.answer(&run.id, "-n --flag").await.unwrap();
    let sent = &resumes(&rig)[0].message;
    assert!(sent.starts_with(REMINDER) && sent.ends_with("\n\n-n --flag"));
}

#[tokio::test]
async fn only_a_question_is_answered() {
    let (rig, run) = asking().await;
    for (state, said) in [(RunState::NeedsPermission, "permission prompt"), (RunState::SystemBlocked, "sign in"), (RunState::Working, "working"), (RunState::Done, "done"), (RunState::Stopped, "stopped"), (RunState::Unknown, "unknown")] {
        rig.set(&run, |r| r.state = state).await;
        let why = rig.svc.answer(&run.id, "Yes").await.unwrap_err().to_string();
        assert!(why.contains(said) || why.contains("isn't waiting"), "{state:?}: {why}");
    }
    assert!(resumes(&rig).is_empty() && rig.cli.0.lock().unwrap().stops.is_empty());
}

#[tokio::test]
async fn an_answer_is_one_to_four_thousand_characters_of_text() {
    let (rig, run) = asking().await;
    for bad in ["", "   \n", "nul\0byte", &"x".repeat(MAX_ANSWER_CHARS + 1)] {
        assert!(rig.svc.answer(&run.id, bad).await.is_err());
    }
    assert!(rig.cli.0.lock().unwrap().calls.is_empty() && rig.get(&run).await.state == RunState::NeedsAnswer);
    rig.svc.answer(&run.id, &"é".repeat(MAX_ANSWER_CHARS)).await.unwrap();
}

#[tokio::test]
async fn a_session_that_has_moved_on_is_left_running() {
    let (rig, run) = asking().await;
    rig.session(&run, |e| {
        e.state = Some("working".into());
        e.pid = Some(4242);
    });
    assert!(rig.svc.answer(&run.id, "Yes").await.unwrap_err().to_string().contains("any more"));
    assert!(rig.cli.0.lock().unwrap().calls.is_empty());
}

#[tokio::test]
async fn a_failed_stop_changes_nothing() {
    let (rig, run) = asking().await;
    rig.cli.with(|s| s.stop_fails = true);
    assert!(rig.svc.answer(&run.id, "Yes").await.is_err());
    assert!(resumes(&rig).is_empty());
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.unsent_answer), (RunState::NeedsAnswer, None));
    assert!(rig.svc.index.live().iter().any(|e| e.run_id == run.id));
}

#[tokio::test]
async fn a_failed_resume_leaves_the_run_stopped_with_the_answer_kept() {
    let (rig, run) = asking().await;
    rig.cli.with(|s| s.resume = Resume::Exits);
    let why = rig.svc.answer(&run.id, "Use staging").await.unwrap_err().to_string();
    assert!(why.contains("kept"), "{why}");
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.unsent_answer.as_deref()), (RunState::Stopped, Some("Use staging")));
    assert!(after.error.as_deref().is_some_and(|e| e.contains("Couldn't wake")));
    assert!(rig.svc.index.live().is_empty());
}

#[tokio::test]
async fn an_app_that_quits_between_the_stop_and_the_wake_keeps_the_answer() {
    let (rig, run) = asking().await;
    rig.cli.with(|s| s.resume = Resume::Hangs);
    let quit = tokio::time::timeout(Duration::from_millis(300), rig.svc.answer(&run.id, "Use staging")).await;
    assert!(quit.is_err(), "the wake was still waiting");
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.unsent_answer.as_deref()), (RunState::Stopped, Some("Use staging")));
    rig.cli.with(|s| s.resume = Resume::Wakes);
    assert_eq!(rig.svc.answer(&run.id, "Use staging").await.unwrap().state, RunState::Working);
}

#[tokio::test]
async fn an_answer_that_was_stopped_on_its_way_can_be_sent_again() {
    let (rig, run) = asking().await;
    rig.cli.with(|s| s.resume = Resume::Exits);
    rig.svc.answer(&run.id, "Use staging").await.unwrap_err();
    rig.cli.with(|s| s.resume = Resume::Wakes);
    let again = rig.svc.answer(&run.id, "Use staging, please").await.unwrap();
    assert_eq!((again.state, again.unsent_answer, again.error), (RunState::Working, None, None));
    let cli = rig.cli.0.lock().unwrap();
    assert_eq!(cli.stops.len(), 1, "the session is not stopped a second time");
    assert!(cli.resumes[1].message.ends_with("Use staging, please"));
}

#[tokio::test]
async fn a_resume_that_starts_a_copy_stops_the_copy_and_keeps_the_run_stopped() {
    let (rig, run) = asking().await;
    rig.cli.with(|s| s.resume = Resume::Copies);
    let why = rig.svc.answer(&run.id, "Yes").await.unwrap_err().to_string();
    assert!(why.contains("started a copy") && why.contains("was stopped"), "{why}");
    let copy_state = {
        let cli = rig.cli.0.lock().unwrap();
        cli.sessions.iter().find(|e| e.id.as_deref().is_some_and(|i| i.starts_with('c'))).and_then(|e| e.state.clone())
    };
    assert_eq!(copy_state.as_deref(), Some("stopped"));
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.unsent_answer.as_deref()), (RunState::Stopped, Some("Yes")));
}

#[tokio::test]
async fn a_session_that_never_shows_as_stopped_is_not_woken() {
    let (rig, run) = asking().await;
    rig.cli.with(|s| s.stop_lingers = true);
    let why = rig.svc.answer(&run.id, "Yes").await.unwrap_err().to_string();
    assert!(why.contains("didn't show as stopped"), "{why}");
    assert!(resumes(&rig).is_empty());
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.unsent_answer.as_deref()), (RunState::Stopped, Some("Yes")));
}

#[tokio::test]
async fn nothing_is_answered_when_agents_are_off() {
    let (rig, run) = asking().await;
    rig.svc.set_flag(false);
    assert!(rig.svc.answer(&run.id, "Yes").await.is_err());
    assert!(rig.cli.0.lock().unwrap().calls.is_empty());
}
