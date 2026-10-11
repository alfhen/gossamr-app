use super::*;
use crate::runs::answer::REMINDER;
use crate::domain::{Origin, Proposal};
use crate::proposals::{self, Draft};
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
    let intent = Intent::FollowUp { connection_id: run.connection_id.clone(), run_id: run.id.clone(), short_id: None, item: run.item.clone(), message: message.into(), reason: "two open questions".into() };
    let scope = rig.fx.scope.clone();
    rig.fx.core.propose(&scope, Draft { origin: Origin::chat("r"), created_by: by, intent, label: None, basis: None }).await.unwrap()
}

fn calls(rig: &Rig) -> Vec<String> {
    rig.cli.0.lock().unwrap().calls.clone()
}

#[tokio::test]
async fn a_finished_run_is_resumed_with_the_reminder_and_the_message_and_nothing_else() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "Answer both open questions.").await;
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    let sent = rig.svc.send_follow_up(&p.id, "Answer both open questions.").await.unwrap();

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
    rig.svc.send_follow_up(&p.id, "More please.").await.unwrap();
    let id = run.short_id.unwrap();
    assert_eq!(calls(&rig), [format!("stop:{id}"), format!("resume:{id}")]);
}

#[tokio::test]
async fn a_run_waiting_on_a_question_or_still_working_is_not_sent_back() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    for state in [RunState::NeedsAnswer, RunState::Working, RunState::Failed] {
        rig.set(&run, |r| r.state = state).await;
        let why = rig.svc.send_follow_up(&p.id, "More please.").await.unwrap_err().to_string();
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
    assert!(rig.svc.send_follow_up(&p.id, "More please.").await.is_err());
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
    let why = rig.svc.send_follow_up(&p.id, "More please.").await.unwrap_err().to_string();
    assert!(why.contains("started a copy"), "{why}");
    assert_eq!(rig.get(&run).await.passes, 1);
    assert_eq!(rig.fx.core.proposal(&p.id).await.unwrap().unwrap().state, crate::domain::ProposalState::Pending);
}

#[tokio::test]
async fn a_decided_follow_up_is_not_sent_twice_and_nothing_is_sent_with_agents_off() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    rig.svc.set_flag(false);
    assert!(rig.svc.send_follow_up(&p.id, "More please.").await.is_err());
    rig.svc.set_flag(true);
    rig.svc.send_follow_up(&p.id, "More please.").await.unwrap();
    assert!(rig.svc.send_follow_up(&p.id, "More please.").await.unwrap_err().to_string().contains("already been decided"));
    assert_eq!(rig.cli.0.lock().unwrap().resumes.len(), 1);
}

#[tokio::test]
async fn a_message_that_changed_after_the_person_read_it_is_not_sent() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "Pip revised this after you read it.").await;
    let why = rig.svc.send_follow_up(&p.id, "The text you read.").await.unwrap_err().to_string();
    assert!(why.contains("changed after you read it"), "{why}");
    assert!(calls(&rig).is_empty());
    assert_eq!(rig.get(&run).await.passes, 1);
    rig.svc.send_follow_up(&p.id, "  Pip revised this after you read it.\n").await.unwrap();
}

#[tokio::test]
async fn an_edited_message_is_sent_on_the_retry_of_a_send_that_failed_after_the_session_was_stopped() {
    let (rig, run) = finished().await;
    rig.session(&run, |e| e.state = Some("idle".into()));
    rig.cli.with(|s| s.resume = Resume::Exits);
    let p = follow_up(&rig, &run, CreatedBy::Pip, "First words.").await;
    assert!(rig.svc.send_follow_up(&p.id, "First words.").await.is_err());
    let stopped = rig.get(&run).await;
    assert_eq!((stopped.state, stopped.unsent_answer.as_deref()), (RunState::Stopped, Some("First words.")));

    let edited = rig.fx.core.edit_proposal(&p.id, &crate::inbox::Edit::FollowUp { message: "Better words.".into() }).await.unwrap();
    assert!(edited.revisions.iter().any(|r| r.note == proposals::SEND_FAILED_NOTE));
    rig.cli.with(|s| s.resume = Resume::Wakes);
    rig.session(&run, |e| e.state = Some("stopped".into()));
    let sent = rig.svc.send_follow_up(&p.id, "Better words.").await.unwrap();
    assert_eq!((sent.state, sent.passes, sent.unsent_answer), (RunState::Working, 2, None));
    assert_eq!(rig.cli.0.lock().unwrap().resumes.last().unwrap().message, format!("{REMINDER}\n\nBetter words."));
}

#[tokio::test]
async fn the_retry_follows_the_message_that_failed_even_when_the_draft_was_edited_during_the_send() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "Original words.").await;
    rig.fx.core.edit_proposal(&p.id, &crate::inbox::Edit::FollowUp { message: "Edited meanwhile.".into() }).await.unwrap();
    rig.set(&run, |r| {
        r.state = RunState::Stopped;
        r.unsent_answer = Some("Original words.".into());
    })
    .await;
    rig.fx.core.follow_up_failed(&p.id, "boom", Some("Original words.")).await.unwrap();
    let stored = rig.fx.core.proposal(&p.id).await.unwrap().unwrap();
    let kept: Vec<_> = stored.revisions.iter().filter(|r| r.note == proposals::SEND_FAILED_NOTE).collect();
    assert!(matches!(&kept[..], [r] if matches!(&r.intent, Intent::FollowUp { message, .. } if message == "Original words.")));
    rig.session(&run, |e| e.state = Some("stopped".into()));
    let sent = rig.svc.send_follow_up(&p.id, "Edited meanwhile.").await.unwrap();
    assert_eq!(sent.state, RunState::Working);
}

#[tokio::test]
async fn another_stopped_run_with_an_unsent_answer_is_not_taken_for_a_retry() {
    let (rig, run) = finished().await;
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    rig.set(&run, |r| {
        r.state = RunState::Stopped;
        r.unsent_answer = Some("More please.".into());
    })
    .await;
    let why = rig.svc.send_follow_up(&p.id, "More please.").await.unwrap_err().to_string();
    assert!(why.contains("can't be sent back"), "{why}");
}

#[tokio::test]
async fn a_copy_started_instead_is_remembered_on_a_finished_run() {
    let (rig, run) = finished().await;
    rig.cli.with(|s| s.resume = Resume::Copies);
    let p = follow_up(&rig, &run, CreatedBy::Pip, "More please.").await;
    assert!(rig.svc.send_follow_up(&p.id, "More please.").await.is_err());
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.earlier_sessions.len()), (RunState::Done, 1));
}

mod fix_round {
    use super::*;
    use crate::domain::{RunKind, RunSpec};

    /// A finished run of `kind`, in a workstream when `in_ws`, that may push when `push`.
    async fn finished_as(kind: RunKind, in_ws: bool, push: bool) -> (Rig, Run) {
        let (rig, run) = finished().await;
        let ws = if in_ws { Some(rig.fx.core.open_workstream(&rig.fx.scope, Some(rig.fx.item("CA-1")), None).await.unwrap().id) } else { None };
        if let Some(ws) = &ws {
            rig.fx.core.set_workstream_mode(&rig.fx.scope, ws, crate::domain::workstream::Mode::Manage, crate::domain::Actor::Person).await.unwrap();
        }
        let run = rig.set(&run, |r| r.spec = RunSpec { kind, allow_push: push, workstream: ws, ..r.spec.clone() }).await;
        (rig, run)
    }

    #[tokio::test]
    async fn a_fix_round_goes_only_to_a_finished_workstream_build_that_pushes() {
        for (kind, in_ws, push) in [(RunKind::Review, true, false), (RunKind::Build, true, false), (RunKind::Build, false, true), (RunKind::Investigate, true, true)] {
            let (rig, run) = finished_as(kind, in_ws, push).await;
            let err = rig.svc.send_fix_round(&run.id, "rev1", "Fix it.").await.unwrap_err().to_string();
            assert!(err.contains("fix round goes only"), "{kind:?} {in_ws} {push}: {err}");
            assert!(calls(&rig).is_empty(), "nothing was resumed");
        }
        let (rig, run) = finished_as(RunKind::Build, true, true).await;
        let working = rig.set(&run, |r| r.state = RunState::Working).await;
        assert!(rig.svc.send_fix_round(&working.id, "rev1", "Fix it.").await.is_err());
        assert!(calls(&rig).is_empty());
    }

    #[tokio::test]
    async fn a_fix_round_resumes_the_build_and_records_only_the_message_s_digest_and_length() {
        let (rig, run) = finished_as(RunKind::Build, true, true).await;
        std::fs::create_dir_all(&run.expected_worktree).unwrap();
        let sent = rig.svc.send_fix_round(&run.id, "rev1", "Fix these findings.").await.unwrap();
        assert_eq!((sent.state, sent.passes), (RunState::Working, 2));
        let resumes = rig.cli.0.lock().unwrap().resumes.clone();
        assert_eq!(resumes.len(), 1);
        assert_eq!(resumes[0].message, format!("{REMINDER}\n\nFix these findings."));
        let ws = run.spec.workstream.clone().unwrap();
        let events = rig.fx.core.workstream_events(&rig.fx.scope, &ws).await.unwrap();
        let line = events.iter().find(|e| e.action == "fix_round_sent").expect("a fix_round_sent line");
        assert_eq!((line.actor, line.run_id.as_deref(), line.detail.as_deref()), (crate::domain::Actor::Supervisor, Some(run.id.as_str()), Some("19")));
        assert_eq!(line.digest.as_ref().map(String::len), Some(64));
        assert!(!format!("{events:?}").contains("Fix these findings"));
        let last = rig.fx.core.run_events(&run.id).await.unwrap().pop().unwrap();
        assert_eq!(last.detail.as_deref(), Some("Pass 2. Started automatically."));
        // Counted before the resume, under the same lock, by the line the rules count.
        let counted: Vec<_> = events.iter().filter(|e| e.action == "autostart").collect();
        assert_eq!(counted.len(), 1);
        assert_eq!((counted[0].run_id.as_deref(), counted[0].detail.as_deref()), (Some(run.id.as_str()), Some("fix_round after rev1")));
        assert!(counted[0].seq < line.seq);
    }

    #[tokio::test]
    async fn a_fix_round_is_refused_once_the_person_held_advised_or_switched_it_off_and_nothing_is_counted() {
        use crate::domain::workstream::{Mode, Rule, HELD_ALL, HELD_PERSON};
        use crate::domain::Actor;
        for what in ["hold", "hold all", "advise", "rule off"] {
            let (rig, run) = finished_as(RunKind::Build, true, true).await;
            let ws = run.spec.workstream.clone().unwrap();
            let (core, scope) = (&rig.fx.core, &rig.fx.scope);
            match what {
                "hold" => drop(core.hold_workstream(scope, &ws, HELD_PERSON, Actor::Person).await.unwrap()),
                "hold all" => drop(core.hold_workstream(scope, &ws, HELD_ALL, Actor::Person).await.unwrap()),
                "advise" => drop(core.set_workstream_mode(scope, &ws, Mode::Advise, Actor::Person).await.unwrap()),
                _ => drop(core.set_workstream_rule(scope, &ws, Rule::FixRound, Some(false)).await.unwrap()),
            }
            let err = rig.svc.send_fix_round(&run.id, "rev1", "Fix it.").await.unwrap_err();
            assert!(matches!(&err, crate::error::Error::Proposal(why) if why == crate::inbox::NOT_ON_ITS_OWN), "{what}: {err}");
            assert!(calls(&rig).is_empty(), "{what}: nothing was resumed");
            let events = rig.fx.core.workstream_events(&rig.fx.scope, &ws).await.unwrap();
            assert!(events.iter().all(|e| e.action != "autostart" && e.action != "fix_round_sent"), "{what}: nothing counted");
        }
    }
}
