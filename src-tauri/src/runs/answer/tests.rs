use super::*;
use crate::runs::rig::{ready, Rig};
use crate::runs::service::Timing;
use crate::runs::testing::{Resume, ResumeCall};
use std::time::Duration;

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(100), stop_settle: Duration::ZERO, rm_wait: Duration::from_millis(5) };

async fn asking() -> (Rig, Run) {
    let (rig, run, _) = asking_in(false).await;
    (rig, run)
}

/// A run asking a question; with `workstream`, one in a workstream opened on its ticket, whose id comes back too.
async fn asking_in(workstream: bool) -> (Rig, Run, Option<String>) {
    let mut rig = ready().await;
    rig.svc = std::sync::Arc::new(std::sync::Arc::into_inner(rig.svc).expect("sole owner").with_timing(FAST));
    let (run, ws) = if workstream {
        let (run, ws) = rig.launched_in_workstream(1).await;
        (run, Some(ws))
    } else {
        (rig.launched(1).await, None)
    };
    rig.job(run.short_id.as_ref().unwrap(), |j| j.suggested_reply = Some("Yes, go ahead".into()));
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.pid = None;
    });
    rig.poll().await;
    let run = rig.get(&run).await;
    assert_eq!(run.state, RunState::NeedsAnswer);
    (rig, run, ws)
}

#[tokio::test]
async fn an_answer_to_a_workstream_run_is_recorded_by_its_length_only_and_a_refused_one_is_not() {
    let (rig, run, ws) = asking_in(true).await;
    let ws = ws.unwrap();
    assert!(rig.svc.answer(&run.id, &"x".repeat(MAX_ANSWER_CHARS + 1)).await.is_err());
    assert!(rig.run_actions(&ws).await.is_empty());
    rig.svc.answer(&run.id, "Use the staging database.").await.unwrap();
    let actions = rig.run_actions(&ws).await;
    assert_eq!(actions, [("run_answered".to_string(), Some(run.id.clone()), Some("25".to_string()))]);
    let events = rig.fx.core.workstream_events(&rig.fx.scope, &ws).await.unwrap();
    assert!(events.iter().all(|e| !format!("{e:?}").contains("staging")), "the answer's text stays with the run");
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
    let copies: Vec<_> = after.earlier_sessions.iter().map(|e| e.short_id.as_str()).collect();
    assert!(matches!(copies.as_slice(), [copy] if copy.starts_with('c')), "the copy is remembered so it is never taken for another run's session: {copies:?}");
}

#[tokio::test]
async fn a_run_stopped_for_a_limit_is_resumed_with_the_persons_words_and_the_limit_no_longer_applies() {
    let (rig, run) = asking().await;
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    rig.svc.set_settings(crate::config::AgentSettings { wall_clock_minutes: 30, ..Default::default() }).unwrap();
    rig.svc.poll_at(chrono::Utc::now() + chrono::Duration::minutes(31)).await;
    rig.svc.poll_at(chrono::Utc::now() + chrono::Duration::minutes(90)).await;
    let id = run.short_id.clone().unwrap();
    assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer, "it was waiting on the person, which the clock doesn't count");

    rig.set(&run, |r| {
        r.state = RunState::Stopped;
        r.stopped_by_limit = true;
        r.error = Some("Stopped by Gossamr: it passed the 30 minute limit".into());
        r.ended_at = Some(chrono::Utc::now());
    })
    .await;
    rig.session(&run, |e| e.state = Some("stopped".into()));
    let resumed = rig.svc.answer(&run.id, "Go on with the plan").await.unwrap();
    assert_eq!((resumed.state, resumed.error, resumed.unsent_answer, resumed.ended_at), (RunState::Working, None, None, None));
    assert!(!resumed.stopped_by_limit && resumed.continued_at.is_some());
    {
        let cli = rig.cli.0.lock().unwrap();
        assert_eq!(cli.calls, [format!("resume:{id}")], "it was already stopped, so there is no second stop");
        assert_eq!(cli.resumes[0].message, format!("{REMINDER}\n\nGo on with the plan"));
    }
    rig.svc.poll_at(chrono::Utc::now() + chrono::Duration::hours(8)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
}

#[tokio::test]
async fn a_failed_resume_of_a_run_stopped_for_a_limit_keeps_the_words_and_the_limit_mark() {
    let (rig, run) = asking().await;
    rig.set(&run, |r| {
        r.state = RunState::Stopped;
        r.stopped_by_limit = true;
    })
    .await;
    rig.session(&run, |e| e.state = Some("stopped".into()));
    rig.cli.with(|s| s.resume = Resume::Exits);
    assert!(rig.svc.answer(&run.id, "Carry on").await.is_err());
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.unsent_answer.as_deref(), after.stopped_by_limit), (RunState::Stopped, Some("Carry on"), true));
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

mod drafts {
    use super::*;
    use crate::domain::{Actor, CreatedBy, Origin, Proposal, ProposalState};
    use crate::proposals::Draft;

    /// An answer Pip suggests for `run`, as its tool saves one.
    async fn suggested(rig: &Rig, run: &Run, message: &str) -> Proposal {
        rig.fx.core.propose_answer_as_pip(&rig.fx.scope, "r", &run.id, message).await.unwrap()
    }

    async fn stored(rig: &Rig, id: &str) -> Proposal {
        rig.fx.core.proposal(id).await.unwrap().unwrap()
    }

    fn calls(rig: &Rig) -> Vec<String> {
        rig.cli.0.lock().unwrap().calls.clone()
    }

    #[tokio::test]
    async fn an_approved_suggestion_is_sent_exactly_as_the_persons_own_answer_and_the_draft_is_applied_and_audited() {
        let (rig, run, ws) = asking_in(true).await;
        let ws = ws.unwrap();
        std::fs::create_dir_all(&run.expected_worktree).unwrap();
        let p = suggested(&rig, &run, "Use the staging database.").await;
        assert_eq!((p.created_by, p.workstream()), (CreatedBy::Pip, Some(ws.as_str())));
        let answered = rig.svc.answer_draft(&p.id, "  Use the staging database.\n").await.unwrap();

        let id = run.short_id.clone().unwrap();
        assert_eq!((answered.state, answered.needs, answered.unsent_answer), (RunState::Working, None, None));
        {
            let cli = rig.cli.0.lock().unwrap();
            assert_eq!(cli.calls, [format!("stop:{id}"), format!("resume:{id}")], "the same stop and resume as the person's own answer");
            assert_eq!(cli.resumes, [ResumeCall { session_id: run.session_id.clone().unwrap(), message: format!("{REMINDER}\n\nUse the staging database."), cwd: Some(run.expected_worktree.clone()) }]);
        }
        let back = stored(&rig, &p.id).await;
        assert_eq!((back.state, back.run.as_deref(), back.error), (ProposalState::Applied, Some(run.id.as_str()), None));
        assert!(back.revisions.is_empty(), "what was sent is what Pip wrote");
        let events = rig.fx.core.workstream_events(&rig.fx.scope, &ws).await.unwrap();
        assert!(events.iter().any(|e| e.action == "draft_approved" && e.actor == Actor::Person && e.proposal_id.as_deref() == Some(p.id.as_str())), "{events:?}");
        assert_eq!(rig.run_actions(&ws).await, [("run_answered".to_string(), Some(run.id.clone()), Some("25".to_string()))]);
        assert!(rig.fx.tracker.intents().is_empty(), "nothing went to Jira");
        assert_eq!(rig.fx.core.run_events(&run.id).await.unwrap().last().map(|e| e.text.as_str()), Some("You answered"));
    }

    #[tokio::test]
    async fn an_answer_that_changed_after_the_person_read_it_is_not_sent() {
        let (rig, run) = asking().await;
        let p = suggested(&rig, &run, "Pip revised this after you read it.").await;
        let why = rig.svc.answer_draft(&p.id, "The text you read.").await.unwrap_err().to_string();
        assert!(why.contains("The answer changed after you read it"), "{why}");
        assert!(calls(&rig).is_empty());
        assert_eq!((stored(&rig, &p.id).await.state, rig.get(&run).await.state), (ProposalState::Pending, RunState::NeedsAnswer));
    }

    #[tokio::test]
    async fn an_answer_to_a_run_that_stopped_asking_stays_pending_with_the_reason() {
        let (rig, run) = asking().await;
        let p = suggested(&rig, &run, "Yes").await;
        rig.session(&run, |e| {
            e.state = Some("working".into());
            e.pid = Some(4242);
        });
        let why = rig.svc.answer_draft(&p.id, "Yes").await.unwrap_err().to_string();
        assert!(why.contains("any more"), "{why}");
        let back = stored(&rig, &p.id).await;
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.as_deref().is_some_and(|e| e.contains("any more")), "{back:?}");
        assert!(calls(&rig).is_empty());
    }

    #[tokio::test]
    async fn only_a_pending_answer_draft_of_this_connection_is_sent_and_nothing_with_agents_off() {
        let (rig, run) = asking().await;
        let p = suggested(&rig, &run, "Yes").await;
        rig.svc.set_flag(false);
        assert!(rig.svc.answer_draft(&p.id, "Yes").await.is_err());
        rig.svc.set_flag(true);
        rig.set(&run, |r| r.connection_id = "jira:other:somebody".into()).await;
        assert!(rig.svc.answer_draft(&p.id, "Yes").await.unwrap_err().to_string().contains("another connection"));
        rig.set(&run, |r| r.connection_id = run.connection_id.clone()).await;
        assert!(rig.svc.answer_draft("no-such-draft", "Yes").await.is_err());
        rig.fx.core.skip_proposal(&p.id).await.unwrap();
        assert!(rig.svc.answer_draft(&p.id, "Yes").await.unwrap_err().to_string().contains("already been decided"));
        assert!(calls(&rig).is_empty());
    }

    #[tokio::test]
    async fn two_sends_of_the_same_answer_at_once_answer_once_and_neither_waits_forever() {
        let (rig, run) = asking().await;
        let p = suggested(&rig, &run, "Use staging").await;
        let both = tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(rig.svc.answer_draft(&p.id, "Use staging"), rig.svc.answer_draft(&p.id, "Use staging")) }).await;
        let (a, b) = both.expect("no deadlock");
        assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(), 1, "{a:?} / {b:?}");
        {
            let cli = rig.cli.0.lock().unwrap();
            assert_eq!((cli.stops.len(), cli.resumes.len()), (1, 1), "sent once");
        }
        let back = stored(&rig, &p.id).await;
        assert_eq!((back.state, back.error), (ProposalState::Applied, None));
        assert_eq!(rig.get(&run).await.state, RunState::Working);
    }

    #[tokio::test]
    async fn the_persons_own_answer_retires_what_pip_suggested_and_a_sent_suggestion_retires_the_others() {
        let (rig, run) = asking().await;
        let p = suggested(&rig, &run, "Yes").await;
        rig.svc.answer(&run.id, "No, keep the old rounding.").await.unwrap();
        assert_eq!(stored(&rig, &p.id).await.state, ProposalState::Retired(crate::runs::answer::ANSWERED.into()));

        let (rig, run) = asking().await;
        let sent = suggested(&rig, &run, "Yes").await;
        let intent = Intent::RunAnswer { connection_id: run.connection_id.clone(), run_id: run.id.clone(), short_id: None, item: run.item.clone(), message: "Another".into(), question: None };
        let other = rig.fx.core.propose(&rig.fx.scope, Draft { origin: Origin::chat("r2"), created_by: CreatedBy::Pip, intent, label: None, basis: None }).await.unwrap();
        rig.svc.answer_draft(&sent.id, "Yes").await.unwrap();
        assert_eq!(stored(&rig, &sent.id).await.state, ProposalState::Applied);
        assert_eq!(stored(&rig, &other.id).await.state, ProposalState::Retired(crate::runs::answer::ANSWERED.into()));
    }

    #[tokio::test]
    async fn a_suggestion_is_retired_when_the_run_finishes_without_one() {
        let (rig, run) = asking().await;
        let p = suggested(&rig, &run, "Yes").await;
        rig.session(&run, |e| {
            e.state = Some("done".into());
            e.status = Some("idle".into());
        });
        rig.poll().await;
        assert_eq!(rig.get(&run).await.state, RunState::Done);
        assert_eq!(stored(&rig, &p.id).await.state, ProposalState::Retired(crate::runs::answer::NOT_ASKING.into()));
        assert!(rig.svc.answer_draft(&p.id, "Yes").await.is_err());
        assert!(rig.cli.0.lock().unwrap().resumes.is_empty());
    }

    #[tokio::test]
    async fn a_suggestion_is_retired_once_the_run_is_answered_in_terminal_so_pip_can_suggest_for_its_next_question() {
        let (rig, run) = asking().await;
        let id = run.short_id.clone().unwrap();
        rig.job(&id, |j| j.needs = Some("Which database?".into()));
        rig.poll().await;
        let p = suggested(&rig, &run, "Use staging.").await;
        // Answered in Terminal: the session works again.
        rig.session(&run, |e| {
            e.state = Some("working".into());
            e.pid = Some(4242);
        });
        rig.poll().await;
        assert_eq!(rig.get(&run).await.state, RunState::Working);
        assert_eq!(stored(&rig, &p.id).await.state, ProposalState::Retired(crate::runs::answer::MOVED_ON.into()));

        // It asks again: Pip may suggest for the new question, and the old answer can't be sent to it.
        rig.job(&id, |j| j.needs = Some("Which branch?".into()));
        rig.session(&run, |e| {
            e.state = Some("blocked".into());
            e.pid = None;
        });
        rig.poll().await;
        assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);
        let next = suggested(&rig, &run, "Use main.").await;
        assert!(matches!(&next.intent, Intent::RunAnswer { question, .. } if question.as_deref() == Some("Which branch?")), "{:?}", next.intent);
        assert!(rig.svc.answer_draft(&p.id, "Use staging.").await.is_err());
        assert!(calls(&rig).iter().all(|c| !c.starts_with("resume")));
    }

    #[tokio::test]
    async fn a_suggestion_for_an_earlier_question_is_retired_and_never_sent_to_the_new_one() {
        let (rig, run) = asking().await;
        let id = run.short_id.clone().unwrap();
        rig.job(&id, |j| j.needs = Some("Which database?".into()));
        rig.poll().await;
        let p = suggested(&rig, &run, "Use staging.").await;

        // The question changes before any poll has seen it: the send is refused.
        rig.set(&run, |r| r.needs = Some("Which branch?".into())).await;
        let why = rig.svc.answer_draft(&p.id, "Use staging.").await.unwrap_err().to_string();
        assert!(why.contains("asking something else"), "{why}");
        assert!(calls(&rig).is_empty(), "nothing was stopped or sent");

        // Once a poll sees the run ask another question, the old suggestion is retired.
        rig.set(&run, |r| r.needs = Some("Which database?".into())).await;
        rig.job(&id, |j| j.needs = Some("Which branch?".into()));
        rig.poll().await;
        assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);
        assert_eq!(stored(&rig, &p.id).await.state, ProposalState::Retired(crate::runs::answer::MOVED_ON.into()));
    }

    #[tokio::test]
    async fn an_edited_suggestion_is_sent_with_the_persons_words() {
        let (rig, run) = asking().await;
        std::fs::create_dir_all(&run.expected_worktree).unwrap();
        let p = suggested(&rig, &run, "Use staging.").await;
        rig.fx.core.edit_proposal(&p.id, &crate::inbox::Edit::RunAnswer { message: "Use production, carefully.".into() }).await.unwrap();
        assert!(rig.svc.answer_draft(&p.id, "Use staging.").await.is_err(), "Pip's words are no longer the draft");
        rig.svc.answer_draft(&p.id, "Use production, carefully.").await.unwrap();
        assert_eq!(resumes(&rig).iter().map(|r| r.message.clone()).collect::<Vec<_>>(), [format!("{REMINDER}\n\nUse production, carefully.")]);
        assert_eq!(stored(&rig, &p.id).await.state, ProposalState::Applied);
    }

    #[tokio::test]
    async fn pip_suggests_only_for_a_run_that_is_asking_and_one_at_a_time_outside_a_workstream() {
        let (rig, run) = asking().await;
        let first = suggested(&rig, &run, "Yes").await;
        let Intent::RunAnswer { short_id, item, .. } = &first.intent else { panic!("{:?}", first.intent) };
        assert_eq!((short_id.as_deref(), item.as_ref()), (run.short_id.as_ref().map(|s| s.as_str()), run.item.as_ref()));
        let again = rig.fx.core.propose_answer_as_pip(&rig.fx.scope, "r", &run.id, "No").await.unwrap_err().to_string();
        assert!(again.contains("already waiting") && again.contains(&first.id), "{again}");
        rig.set(&run, |r| r.state = RunState::Working).await;
        rig.fx.core.skip_proposal(&first.id).await.unwrap();
        let working = rig.fx.core.propose_answer_as_pip(&rig.fx.scope, "r", &run.id, "No").await.unwrap_err().to_string();
        assert!(working.contains("isn't waiting for an answer"), "{working}");
        assert!(rig.fx.core.propose_answer_as_pip(&rig.fx.scope, "r", "no-such-run", "No").await.is_err());
    }
}
