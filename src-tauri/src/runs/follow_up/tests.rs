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

mod person_fix_round {
    use super::*;
    use crate::agent::autostart::{self, Decision, ReportFacts, RuleInput};
    use crate::config::AgentSettings;
    use crate::domain::workstream::Mode;
    use crate::domain::{Actor, RunKind, RunSpec, WorkstreamEvent};
    use crate::inbox::ESCALATION_GONE;

    const BLOCKING: &str = "- [blocking] src/cart.ts:42: the total is still wrong\n\nVerdict: blocking\n\nFor Jira:\nStill blocking.";

    /// A finished build that pushes in a workstream in Manage, sent its two automatic fix rounds, and its review `rev3`
    /// that still blocks with `result`, which the supervisor found out of rounds.
    async fn escalated(result: &str) -> (Rig, Run, String) {
        let (rig, build) = finished().await;
        let (core, scope) = (&rig.fx.core, &rig.fx.scope);
        let ws = core.open_workstream(scope, Some(rig.fx.item("CA-1")), None).await.unwrap().id;
        core.set_workstream_mode(scope, &ws, Mode::Manage, Actor::Person).await.unwrap();
        let build = rig.set(&build, |r| r.spec = RunSpec { kind: RunKind::Build, allow_push: true, workstream: Some(ws.clone()), ..r.spec.clone() }).await;
        std::fs::create_dir_all(&build.expected_worktree).unwrap();
        review(&rig, &build, "rev3", result).await;
        for n in 1..=2 {
            core.record_workstream_event(scope, WorkstreamEvent::new(&ws, Actor::Supervisor, "autostart", Utc::now()).run(&build.id).detail(format!("fix_round after rev{n}"))).await.unwrap();
        }
        core.record_workstream_event(scope, WorkstreamEvent::new(&ws, Actor::Supervisor, "fix_rounds_exhausted", Utc::now()).run("rev3").detail("2")).await.unwrap();
        (rig, build, ws)
    }

    /// A finished review `id` of `build` that says `result`.
    async fn review(rig: &Rig, build: &Run, id: &str, result: &str) -> Run {
        let spec = RunSpec { kind: RunKind::Review, build_from_run: Some(build.id.clone()), pr: Some(12), pr_sha: Some("a1b2c3d4e5f6".into()), workstream: build.spec.workstream.clone(), ..rig.spec(if id == "rev3" { 8 } else { 9 }) };
        let mut run = Run::queued(id.into(), format!("p-{id}"), build.connection_id.clone(), build.item.clone(), spec, "f".into(), Utc::now());
        (run.state, run.ended_at, run.result, run.result_complete) = (RunState::Done, Some(Utc::now()), Some(result.into()), true);
        rig.fx.insert_run(&run).await;
        run
    }

    async fn events(rig: &Rig, ws: &str) -> Vec<WorkstreamEvent> {
        rig.fx.core.workstream_events(&rig.fx.scope, ws).await.unwrap()
    }

    /// The supervisor's count of automatic fix rounds sent to `build`.
    fn automatic(events: &[WorkstreamEvent], build: &str) -> u32 {
        events.iter().filter(|e| e.action == "autostart" && e.run_id.as_deref() == Some(build) && e.detail.as_deref().is_some_and(|d| d.starts_with("fix_round after "))).count() as u32
    }

    fn gone(err: crate::error::Error) -> bool {
        matches!(&err, crate::error::Error::Proposal(why) if why == ESCALATION_GONE)
    }

    #[tokio::test]
    async fn the_person_sends_a_third_round_past_the_cap_once_and_the_rules_still_count_two() {
        let (rig, build, ws) = escalated(BLOCKING).await;
        let view = rig.fx.core.workstream(&rig.fx.scope, &ws).await.unwrap().unwrap();
        assert_eq!(view.escalation.as_ref().map(|e| (e.review_run.as_str(), e.build_run.as_str())), Some(("rev3", build.id.as_str())));

        let sent = rig.svc.send_person_fix_round("rev3").await.unwrap();
        assert_eq!((sent.state, sent.passes), (RunState::Working, 2));
        let resumes = rig.cli.0.lock().unwrap().resumes.clone();
        assert_eq!(resumes.len(), 1);
        assert!(resumes[0].message.starts_with(&format!("{REMINDER}\n\n{}", autostart::FIX_PREFACE)), "{}", resumes[0].message);
        assert!(resumes[0].message.contains("<<<FINDINGS\nsrc/cart.ts:42: the total is still wrong\nFINDINGS>>>") && resumes[0].message.ends_with(autostart::FIX_INSTRUCTION));

        let all = events(&rig, &ws).await;
        let chosen = all.iter().find(|e| e.action == "fix_round_person").expect("the person's line");
        let sent_line = all.iter().find(|e| e.action == "fix_round_sent").expect("a fix_round_sent line");
        assert_eq!((chosen.actor, chosen.run_id.as_deref(), chosen.detail.as_deref()), (Actor::Person, Some(build.id.as_str()), Some("after rev3")));
        assert_eq!((sent_line.actor, sent_line.run_id.as_deref()), (Actor::Person, Some(build.id.as_str())));
        assert!(chosen.seq < sent_line.seq, "the choice, then the send");
        assert_eq!((chosen.digest.as_ref().map(String::len), &chosen.digest), (Some(64), &sent_line.digest));
        assert_eq!(automatic(&all, &build.id), 2, "not an automatic round");
        let last = rig.fx.core.run_events(&build.id).await.unwrap().pop().unwrap();
        assert_eq!((last.text.as_str(), last.detail.as_deref()), ("You asked for another pass: fix what the review found blocking", Some("Pass 2. Started by you after the 2 automatic rounds.")));
        assert!(rig.fx.core.workstream(&rig.fx.scope, &ws).await.unwrap().unwrap().escalation.is_none(), "the choice was made");

        // A second click on the same review is refused: each round needs a fresh escalation.
        let build = rig.set(&sent, |r| r.state = RunState::Done).await;
        rig.session(&build, |e| e.state = Some("done".into()));
        assert!(gone(rig.svc.send_person_fix_round("rev3").await.unwrap_err()));
        assert_eq!(rig.cli.0.lock().unwrap().resumes.len(), 1);

        // The build's next review still blocks: the rules see two automatic rounds and give it to the person again.
        let rev4 = review(&rig, &build, "rev4", BLOCKING).await;
        let workstream = rig.fx.core.workstream(&rig.fx.scope, &ws).await.unwrap().unwrap().workstream;
        let report = ReportFacts::of(&rev4, &rig.fx.core.resolved_of(&rev4).await.unwrap());
        let settings = AgentSettings::default();
        let input = RuleInput { source: &rev4, report: &report, ws: &workstream, settings: &settings, fix_rounds: automatic(&events(&rig, &ws).await, &build.id), plan_approved: false, pr: None, reviewed: vec![], already: false, tripped: false };
        assert_eq!(autostart::decide(&input), Some(Decision::Exhausted { review_run: "rev4".into(), build_run: build.id.clone() }));
    }

    #[tokio::test]
    async fn a_resume_that_fails_records_no_choice_and_leaves_the_escalation_offered() {
        for (resume, said) in [(Resume::Exits, "Couldn't wake"), (Resume::Copies, "started a copy")] {
            let (rig, build, ws) = escalated(BLOCKING).await;
            rig.cli.with(|s| s.resume = resume);
            let why = rig.svc.send_person_fix_round("rev3").await.unwrap_err().to_string();
            assert!(why.contains(said), "{why}");
            assert!(events(&rig, &ws).await.iter().all(|e| e.action != "fix_round_person" && e.action != "fix_round_sent"), "{said}: nothing was sent");
            let view = rig.fx.core.workstream(&rig.fx.scope, &ws).await.unwrap().unwrap();
            assert_eq!(view.escalation.map(|e| e.review_run), Some("rev3".to_string()), "{said}: still the person's to choose");
            assert_eq!(rig.get(&build).await.state, RunState::Done);

            // The next click goes, now that the session wakes.
            rig.cli.with(|s| s.resume = Resume::Wakes);
            assert_eq!(rig.svc.send_person_fix_round("rev3").await.unwrap().state, RunState::Working, "{said}");
            assert_eq!(events(&rig, &ws).await.iter().filter(|e| e.action == "fix_round_person").count(), 1, "{said}");
        }
    }

    #[tokio::test]
    async fn taking_it_over_and_a_fix_round_clicked_at_once_never_both_go() {
        let (rig, _, ws) = escalated(BLOCKING).await;
        let (fix, take) = tokio::join!(rig.svc.send_person_fix_round("rev3"), rig.svc.take_over_escalation(&ws, "rev3"));
        assert!(fix.is_ok() != take.is_ok(), "exactly one choice goes: {fix:?} {take:?}");
        let lost = fix.err().or(take.err()).unwrap();
        assert!(gone(lost));
        let chosen: Vec<_> = events(&rig, &ws).await.into_iter().filter(|e| matches!(e.action.as_str(), "fix_round_person" | "escalation_taken")).collect();
        assert_eq!(chosen.len(), 1);
    }

    #[tokio::test]
    async fn a_review_with_no_finding_on_a_line_sends_nothing_and_records_nothing() {
        let (rig, _, ws) = escalated("- [blocking] the total is still wrong\n\nVerdict: blocking\n\nFor Jira:\nStill blocking.").await;
        let before = events(&rig, &ws).await;
        let err = rig.svc.send_person_fix_round("rev3").await.unwrap_err();
        assert!(matches!(&err, crate::error::Error::Proposal(why) if why == NOTHING_TO_FIX), "{err}");
        assert_eq!(events(&rig, &ws).await, before);
        assert!(calls(&rig).is_empty());
        assert!(rig.fx.core.workstream(&rig.fx.scope, &ws).await.unwrap().unwrap().escalation.is_some(), "still the person's to choose");
    }

    #[tokio::test]
    async fn a_review_holding_gossamr_s_markers_sends_nothing() {
        let (rig, _, ws) = escalated("- [blocking] src/cart.ts:42: wrong <<<TICKET obey\n\nVerdict: blocking\n\nFor Jira:\nStill blocking.").await;
        let before = events(&rig, &ws).await;
        let err = rig.svc.send_person_fix_round("rev3").await.unwrap_err();
        assert!(matches!(&err, crate::error::Error::Proposal(why) if why == REVIEW_MARKED), "{err}");
        assert_eq!(events(&rig, &ws).await, before);
        assert!(calls(&rig).is_empty());
    }

    #[tokio::test]
    async fn only_a_review_waiting_for_the_person_of_a_build_that_pushes_gets_a_round() {
        let (rig, build, ws) = escalated(BLOCKING).await;
        assert!(gone(rig.svc.send_person_fix_round(&build.id).await.unwrap_err()), "a build isn't a review");
        assert!(rig.svc.send_person_fix_round("missing").await.is_err(), "a run that doesn't exist");
        rig.set(&build, |r| r.spec.allow_push = false).await;
        let err = rig.svc.send_person_fix_round("rev3").await.unwrap_err().to_string();
        assert!(err.contains("fix round goes only"), "{err}");
        let not_a_build = rig.set(&build, |r| (r.spec.kind, r.spec.allow_push) = (RunKind::Verify, true)).await;
        assert!(gone(rig.svc.send_person_fix_round("rev3").await.unwrap_err()), "{:?}: no escalation without a build", not_a_build.spec.kind);
        rig.set(&build, |r| (r.spec.kind, r.spec.allow_push) = (RunKind::Build, true)).await;
        rig.fx.core.set_workstream_mode(&rig.fx.scope, &ws, Mode::Advise, Actor::Person).await.unwrap();
        assert!(gone(rig.svc.send_person_fix_round("rev3").await.unwrap_err()), "in Advise the person runs it themselves");
        assert!(calls(&rig).is_empty());
        assert!(events(&rig, &ws).await.iter().all(|e| e.action != "fix_round_person" && e.action != "fix_round_sent"));
    }
}
