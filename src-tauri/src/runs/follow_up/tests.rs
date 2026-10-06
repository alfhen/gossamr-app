use super::*;
use crate::runs::answer::REMINDER;
use crate::domain::{Origin, Proposal};
use crate::proposals::Draft;
use crate::runs::rig::{ready, Rig};
use crate::runs::service::Timing;
use crate::runs::testing::{Resume, ResumeCall};
use std::time::Duration;

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(100), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5) };

async fn finished() -> (Rig, Run) {
    let mut rig = ready().await;
    rig.svc = std::sync::Arc::new(std::sync::Arc::into_inner(rig.svc).expect("sole owner").with_timing(FAST));
    let run = rig.launched(1).await;
    rig.poll().await;
    let run = rig.get(&run).await;
    let run = rig.set(&run, |r| {
        r.state = RunState::Done;
        r.ended_at = Some(Utc::now());
    })
    .await;
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.pid = None;
    });
    (rig, run)
}

async fn follow_up(rig: &Rig, run: &Run, by: CreatedBy, message: &str) -> Proposal {
    let intent = Intent::FollowUp { connection_id: run.connection_id.clone(), run_id: run.id.clone(), item: run.item.clone(), message: message.into(), reason: "two open questions".into() };
    let scope = rig.fx.scope.clone();
    rig.fx.core.propose(&scope, Draft { origin: Origin::Chat { request_id: "r".into() }, created_by: by, intent, label: None, basis: None }).await.unwrap()
}

fn calls(rig: &Rig) -> Vec<String> {
    rig.cli.0.lock().unwrap().calls.clone()
}

#[tokio::test]
async fn a_finished_run_is_resumed_with_the_reminder_and_the_message_and_nothing_else() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "Answer both open questions.").await;
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    let sent = rig.svc.send_follow_up(&p.id).await.unwrap();

    let id = run.short_id.clone().unwrap();
    assert_eq!((sent.state, sent.passes, sent.ended_at, sent.unsent_answer.clone()), (RunState::Working, 2, None, None));
    assert!(sent.continued_at.is_some());
    assert_eq!(calls(&rig), [format!("resume:{id}")], "a finished session needs no stop");
    assert_eq!(rig.cli.0.lock().unwrap().resumes, [ResumeCall { session_id: run.session_id.clone().unwrap(), message: format!("{REMINDER}\n\nAnswer both open questions."), cwd: Some(run.expected_worktree.clone()) }]);
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    let last = events.last().unwrap();
    assert_eq!((last.kind.as_str(), last.text.as_str(), last.detail.as_deref()), ("follow_up", "Pip asked for another pass: two open questions", Some("Pass 2. Approved by you.")));
    let stored = rig.fx.core.proposal(&p.id).await.unwrap().unwrap();
    assert_eq!((stored.state, stored.run), (crate::domain::ProposalState::Applied, Some(run.id.clone())));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
}

#[tokio::test]
async fn a_session_that_is_still_alive_is_stopped_first() {
    let (rig, run) = finished().await;
    rig.session(&run, |e| e.state = Some("idle".into()));
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    rig.svc.send_follow_up(&p.id).await.unwrap();
    let id = run.short_id.unwrap();
    assert_eq!(calls(&rig), [format!("stop:{id}"), format!("resume:{id}")]);
}

#[tokio::test]
async fn a_run_waiting_on_a_question_or_still_working_is_not_sent_back() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    for state in [RunState::NeedsAnswer, RunState::Working, RunState::Failed] {
        rig.set(&run, |r| r.state = state).await;
        let why = rig.svc.send_follow_up(&p.id).await.unwrap_err().to_string();
        assert!(why.contains("can't be sent back"), "{state:?}: {why}");
    }
    assert!(calls(&rig).is_empty());
    assert_eq!(rig.fx.core.proposal(&p.id).await.unwrap().unwrap().state, crate::domain::ProposalState::Pending);
}

#[tokio::test]
async fn a_failed_resume_keeps_the_draft_pending_with_the_reason_and_the_run_as_it_was() {
    let (rig, run) = finished().await;
    rig.cli.with(|s| s.resume = Resume::Exits);
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    assert!(rig.svc.send_follow_up(&p.id).await.is_err());
    let stored = rig.fx.core.proposal(&p.id).await.unwrap().unwrap();
    assert_eq!(stored.state, crate::domain::ProposalState::Pending);
    assert!(stored.error.is_some());
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.passes), (RunState::Done, 1));
}

#[tokio::test]
async fn a_copy_that_claude_starts_instead_is_reported_and_the_draft_stays_pending() {
    let (rig, run) = finished().await;
    rig.cli.with(|s| s.resume = Resume::Copies);
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    let why = rig.svc.send_follow_up(&p.id).await.unwrap_err().to_string();
    assert!(why.contains("started a copy"), "{why}");
    assert_eq!(rig.get(&run).await.passes, 1);
    assert_eq!(rig.fx.core.proposal(&p.id).await.unwrap().unwrap().state, crate::domain::ProposalState::Pending);
}

#[tokio::test]
async fn a_decided_follow_up_is_not_sent_twice_and_nothing_is_sent_with_agents_off() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    rig.svc.set_flag(false);
    assert!(rig.svc.send_follow_up(&p.id).await.is_err());
    rig.svc.set_flag(true);
    rig.svc.send_follow_up(&p.id).await.unwrap();
    assert!(rig.svc.send_follow_up(&p.id).await.unwrap_err().to_string().contains("already been decided"));
    assert_eq!(rig.cli.0.lock().unwrap().resumes.len(), 1);
}
