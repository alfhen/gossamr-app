use chrono::Duration as Span;

use super::*;
use crate::domain::fixtures::run_spec;
use crate::runs::rig::{line, ready, Rig};
use crate::runs::service::belongs_to;
use crate::runs::testing::FakeCli;

fn stopped_run() -> Run {
    let mut run = Run::queued("r1".into(), "p1".into(), "c1".into(), None, run_spec(), "db".into(), Utc::now() - Span::hours(3));
    run.state = RunState::Stopped;
    run.short_id = ShortId::parse("2afa0a22");
    run.last_progress_at = Utc::now() - Span::hours(1);
    run
}

fn ms(span: Span) -> i64 {
    (Utc::now() + span).timestamp_millis()
}

fn listed(run: &Run, id: &str, cwd: &Path, started: i64) -> AgentEntry {
    AgentEntry { name: Some(title_of(run)), started_at: Some(started), ..FakeCli::session(id, cwd) }
}

fn none_taken() -> HashSet<ShortId> {
    HashSet::new()
}

fn ids(found: &[Candidate]) -> Vec<&str> {
    found.iter().map(|c| c.short_id.as_str()).collect()
}

#[test]
fn a_session_with_the_runs_title_in_its_worktree_started_after_its_last_progress_is_a_candidate() {
    let run = stopped_run();
    let entry = listed(&run, "bbb748a7", &run.expected_worktree, ms(Span::minutes(-5)));
    let found = candidates(&run, &[entry], &none_taken());
    assert_eq!(ids(&found), ["bbb748a7"]);
    assert!(found[0].in_worktree);
    assert!(matches!(link(found, false), Link::Adopt(c) if c.short_id.as_str() == "bbb748a7"));
}

#[test]
fn a_session_that_fails_any_one_check_is_not_a_candidate() {
    let run = stopped_run();
    let at = |entry: AgentEntry| candidates(&run, &[entry], &none_taken());
    let good = || listed(&run, "bbb748a7", &run.expected_worktree, ms(Span::minutes(-5)));
    assert_eq!(at(good()).len(), 1);
    assert!(at(AgentEntry { name: Some("Gossamr: CA-1 build".into()), ..good() }).is_empty(), "another title");
    assert!(at(AgentEntry { name: None, ..good() }).is_empty(), "no title, as a copy has");
    assert!(at(AgentEntry { kind: Some("interactive".into()), ..good() }).is_empty());
    assert!(at(AgentEntry { kind: None, ..good() }).is_empty());
    assert!(at(AgentEntry { started_at: Some(ms(Span::hours(-2))), ..good() }).is_empty(), "started before the run last made progress");
    assert!(at(AgentEntry { started_at: None, ..good() }).is_empty());
    assert!(at(AgentEntry { cwd: Some("/elsewhere/.claude/worktrees/other".into()), ..good() }).is_empty(), "another worktree");
    assert!(at(AgentEntry { cwd: None, ..good() }).is_empty());
    assert!(at(AgentEntry { id: Some("../../etc".into()), ..good() }).is_empty());
    let own = ShortId::parse("bbb748a7").unwrap();
    assert!(candidates(&run, &[good()], &HashSet::from([own])).is_empty(), "a session some run has or had");
}

#[test]
fn a_session_in_the_clone_only_is_offered_and_never_adopted() {
    let run = stopped_run();
    let found = candidates(&run, &[listed(&run, "bbb748a7", &run.spec.clone_path, ms(Span::minutes(-5)))], &none_taken());
    assert_eq!(ids(&found), ["bbb748a7"]);
    assert!(!found[0].in_worktree);
    assert!(matches!(link(found, false), Link::Offer(offer) if offer.len() == 1));
}

#[test]
fn more_than_one_candidate_is_never_adopted() {
    let run = stopped_run();
    let entries = [
        listed(&run, "bbb748a7", &run.expected_worktree, ms(Span::minutes(-5))),
        listed(&run, "ccc00001", &run.expected_worktree, ms(Span::minutes(-3))),
    ];
    let found = candidates(&run, &entries, &none_taken());
    assert_eq!(ids(&found), ["bbb748a7", "ccc00001"]);
    assert!(matches!(link(found, false), Link::Offer(offer) if offer.len() == 2));
}

#[test]
fn a_launch_that_is_not_settled_turns_an_adoption_into_an_offer() {
    let run = stopped_run();
    let found = candidates(&run, &[listed(&run, "bbb748a7", &run.expected_worktree, ms(Span::minutes(-5)))], &none_taken());
    assert!(matches!(link(found, true), Link::Offer(_)));
    assert_eq!(link(Vec::new(), true), Link::Nothing);
}

#[test]
fn taking_over_keeps_the_old_session_as_an_alias_and_hands_the_state_to_the_listing() {
    let mut run = stopped_run();
    run.session_id = Some("2afa0a22-11e6-47c8-924c-c779e6a25b5c".into());
    run.error = Some("Stopped by Gossamr: it passed the 60 minute limit".into());
    run.stopped_by_limit = true;
    run.ended_at = Some(Utc::now());
    run.possible_continuations = vec![Continuation { short_id: ShortId::parse("bbb748a7").unwrap(), session_id: None, started_at: None }];
    let to = Candidate { short_id: ShortId::parse("bbb748a7").unwrap(), session_id: Some("bbb748a7-dca2-4f33-9da1-caa7f80584b8".into()), started_at: None, in_worktree: true };
    let now = Utc::now();
    take_over(&mut run, &to, now);
    assert_eq!((run.short_id.as_ref().map(ShortId::as_str), run.session_id.as_deref()), (Some("bbb748a7"), Some("bbb748a7-dca2-4f33-9da1-caa7f80584b8")));
    assert_eq!(run.earlier_sessions, [EarlierSession { short_id: ShortId::parse("2afa0a22").unwrap(), session_id: Some("2afa0a22-11e6-47c8-924c-c779e6a25b5c".into()), removed: false }]);
    assert_eq!(run.session_ids().iter().map(ShortId::as_str).collect::<Vec<_>>(), ["bbb748a7", "2afa0a22"]);
    assert_eq!((run.state, run.error, run.ended_at, run.stopped_by_limit, run.continued_at), (RunState::Working, None, None, false, Some(now)));
    assert!(run.possible_continuations.is_empty());
}

/// Gossamr didn't launch the session it takes over, so a read-only run no longer claims the restriction it launched with.
#[test]
fn taking_over_drops_the_read_only_restriction_the_run_launched_with() {
    let mut run = stopped_run();
    run.read_only = run.spec.read_only();
    assert!(run.read_only.is_some());
    let to = Candidate { short_id: ShortId::parse("bbb748a7").unwrap(), session_id: None, started_at: None, in_worktree: true };
    take_over(&mut run, &to, Utc::now());
    assert_eq!(run.read_only, None);
}

#[test]
fn an_earlier_session_still_listed_is_no_longer_the_runs_own() {
    let mut run = stopped_run();
    let old = listed(&run, "2afa0a22", &run.expected_worktree, ms(Span::hours(-2)));
    assert!(belongs_to(&old, &run));
    run.earlier_sessions = vec![EarlierSession { short_id: ShortId::parse("2afa0a22").unwrap(), session_id: None, removed: false }];
    run.short_id = ShortId::parse("bbb748a7");
    assert!(!belongs_to(&old, &run), "not by id and not by the worktree it shares");
    assert!(belongs_to(&listed(&run, "bbb748a7", &run.expected_worktree, 0), &run));
}

async fn stopped() -> (Rig, Run) {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    rig.svc.stop(&run.id).await.unwrap();
    let run = rig.get(&run).await;
    (rig, run)
}

fn add(rig: &Rig, run: &Run, id: &str, cwd: &Path) {
    let entry = listed(run, id, cwd, ms(Span::minutes(1)));
    rig.cli.with(|s| s.sessions.push(entry));
}

fn later(minutes: i64) -> DateTime<Utc> {
    Utc::now() + Span::minutes(minutes)
}

#[tokio::test]
async fn the_only_session_that_fits_is_taken_over_and_the_run_follows_it_to_its_answer() {
    let (rig, run) = stopped().await;
    let old = run.short_id.clone().unwrap();
    add(&rig, &run, "c0000009", &run.expected_worktree);
    let new = ShortId::parse("c0000009").unwrap();
    rig.job(&new, |j| {
        j.tokens = Some(7_006);
        j.timeline = vec![line("2099-01-01T00:00:00Z", "working", "Reading the gateway code")];
    });

    rig.svc.poll_at(later(2)).await;
    let adopted = rig.get(&run).await;
    assert_eq!(adopted.short_id.as_ref(), Some(&new));
    assert_eq!(adopted.session_id.as_deref(), Some("c0000009-0000-4000-8000-000000000000"));
    assert_eq!(adopted.earlier_sessions.iter().map(|e| e.short_id.as_str()).collect::<Vec<_>>(), [old.as_str()]);
    assert_eq!((adopted.state, adopted.tokens, adopted.ended_at), (RunState::Working, Some(7_006), None));
    assert!(adopted.continued_at.is_some() && adopted.possible_continuations.is_empty());
    assert!(rig.svc.index.live().iter().any(|e| e.run_id == run.id && e.short_id.as_ref() == Some(&new)), "the index follows the new id");
    let events = rig.fx.core.run_events(&run.id).await.unwrap();
    assert!(events.iter().any(|e| e.text.contains("Reading the gateway code")), "events come from the continuation");

    rig.cli.with(|s| {
        s.answers.insert("c0000009-0000-4000-8000-000000000000".into(), "The plan.\n\nFor Jira:\nPlanned.".into());
        s.sessions.iter_mut().find(|e| e.id.as_deref() == Some("c0000009")).unwrap().state = Some("done".into());
    });
    rig.job(&new, |j| j.result = Some("One line.".into()));
    rig.svc.poll_at(later(3)).await;
    let done = rig.get(&run).await;
    assert_eq!(done.state, RunState::Done);
    assert_eq!(done.result.as_deref(), Some("The plan.\n\nFor Jira:\nPlanned."));
    assert!(rig.cli.0.lock().unwrap().answer_reads.iter().all(|(session, _)| session.starts_with("c0000009")), "the transcript read is the continuation's");
    assert_eq!(rig.cli.0.lock().unwrap().stops.len(), 1, "only the person's own stop, nothing for the old id");
}

#[tokio::test]
async fn two_sessions_that_fit_are_offered_not_adopted_and_the_person_can_choose_one() {
    let (rig, run) = stopped().await;
    let old = run.short_id.clone().unwrap();
    add(&rig, &run, "c0000009", &run.expected_worktree);
    add(&rig, &run, "c000000a", &run.expected_worktree);

    rig.svc.poll_at(later(2)).await;
    let offered = rig.get(&run).await;
    assert_eq!(offered.short_id.as_ref(), Some(&old), "nothing is adopted when it is ambiguous");
    assert_eq!(offered.state, RunState::Stopped);
    assert_eq!(offered.possible_continuations.iter().map(|c| c.short_id.as_str()).collect::<Vec<_>>(), ["c0000009", "c000000a"]);

    assert!(rig.svc.adopt_session(&run.id, "c000000f").await.is_err(), "a session that isn't among the candidates");
    assert!(rig.svc.adopt_session(&run.id, "not-an-id").await.is_err());
    let chosen = rig.svc.adopt_session(&run.id, "c000000a").await.unwrap();
    assert_eq!(chosen.short_id.as_ref().map(ShortId::as_str), Some("c000000a"));
    assert_eq!(chosen.earlier_sessions[0].short_id, old);
    assert!(chosen.possible_continuations.is_empty() && chosen.continued_at.is_some());
    assert_eq!(rig.get(&run).await.short_id, chosen.short_id);
}

#[tokio::test]
async fn a_session_that_only_started_in_the_clone_is_offered_with_one_click_to_adopt_it() {
    let (rig, run) = stopped().await;
    add(&rig, &run, "c0000009", &run.spec.clone_path);
    rig.svc.poll_at(later(2)).await;
    let offered = rig.get(&run).await;
    assert_eq!(offered.short_id, run.short_id);
    assert_eq!(offered.possible_continuations.len(), 1);

    rig.cli.with(|s| s.sessions.retain(|e| e.id.as_deref() != Some("c0000009")));
    rig.svc.poll_at(later(3)).await;
    assert!(rig.get(&run).await.possible_continuations.is_empty(), "an offer that no longer fits is withdrawn");
    assert!(rig.svc.adopt_session(&run.id, "c0000009").await.is_err());
}

#[tokio::test]
async fn a_session_that_belongs_to_another_run_is_never_taken_even_in_this_runs_worktree() {
    let (rig, run) = stopped().await;
    let other = rig.launched(2).await;
    rig.poll().await;
    rig.session(&other, |e| {
        e.name = Some(title_of(&run));
        e.cwd = Some(run.expected_worktree.to_string_lossy().into_owned());
        e.started_at = Some(ms(Span::minutes(1)));
    });
    rig.svc.poll_at(later(2)).await;
    let after = rig.get(&run).await;
    assert_eq!((after.short_id, after.possible_continuations.len()), (run.short_id.clone(), 0));
    assert!(rig.svc.adopt_session(&run.id, other.short_id.as_ref().unwrap().as_str()).await.is_err());
}

#[tokio::test]
async fn a_launch_still_unsettled_makes_the_adoption_an_offer() {
    let (rig, run) = stopped().await;
    rig.queued(2).await;
    add(&rig, &run, "c0000009", &run.expected_worktree);
    rig.svc.poll_at(later(2)).await;
    let after = rig.get(&run).await;
    assert_eq!((after.short_id, after.possible_continuations.len()), (run.short_id.clone(), 1));
}

#[tokio::test]
async fn a_run_that_is_still_going_has_no_other_session_to_adopt() {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    add(&rig, &run, "c0000009", &run.expected_worktree);
    assert!(rig.svc.adopt_session(&run.id, "c0000009").await.unwrap_err().to_string().contains("working"));
}

#[tokio::test]
async fn a_run_whose_own_session_is_live_again_is_not_moved_to_another() {
    let (rig, run) = stopped().await;
    rig.session(&run, |e| {
        e.state = Some("working".into());
        e.status = Some("busy".into());
        e.pid = Some(4242);
    });
    add(&rig, &run, "c0000009", &run.expected_worktree);
    rig.svc.poll_at(later(2)).await;
    let after = rig.get(&run).await;
    assert_eq!((after.short_id, after.state), (run.short_id, RunState::Working));
}

#[tokio::test]
async fn a_session_is_not_adopted_while_the_runs_own_has_come_back_to_life() {
    let (rig, run) = stopped().await;
    add(&rig, &run, "c0000009", &run.expected_worktree);
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.status = Some("idle".into());
        e.pid = Some(777);
    });
    rig.set(&run, |r| r.ended_at = Some(Utc::now() - Span::minutes(5))).await;
    let why = rig.svc.adopt_session(&run.id, "c0000009").await.unwrap_err().to_string();
    assert!(why.contains("own session is working again"), "{why}");
    let after = rig.get(&run).await;
    assert_eq!((after.short_id, after.earlier_sessions.len()), (run.short_id.clone(), 0));

    rig.session(&run, |e| {
        e.state = Some("stopped".into());
        e.pid = None;
    });
    let chosen = rig.svc.adopt_session(&run.id, "c0000009").await.unwrap();
    assert_eq!(chosen.short_id.as_ref().map(ShortId::as_str), Some("c0000009"), "the normal case still adopts");
}

#[test]
fn a_stopped_run_with_an_answer_waiting_is_not_at_rest_and_a_finished_one_is() {
    let mut run = stopped_run();
    assert!(at_rest(&run));
    run.unsent_answer = Some("Use staging.".into());
    assert!(!at_rest(&run));
    run.state = RunState::Done;
    assert!(at_rest(&run), "a finished run keeps no answer to send");
    run.state = RunState::Working;
    run.unsent_answer = None;
    assert!(!at_rest(&run));
}

#[tokio::test]
async fn a_run_holding_an_unsent_answer_keeps_it_and_is_neither_adopted_nor_offered_a_session() {
    let (rig, run) = stopped().await;
    add(&rig, &run, "c0000009", &run.expected_worktree);
    rig.set(&run, |r| r.unsent_answer = Some("Use staging.".into())).await;

    rig.svc.poll_at(later(2)).await;
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.short_id.clone(), after.unsent_answer.as_deref()), (RunState::Stopped, run.short_id.clone(), Some("Use staging.")));
    assert!(after.possible_continuations.is_empty() && after.earlier_sessions.is_empty());

    let why = rig.svc.adopt_session(&run.id, "c0000009").await.unwrap_err().to_string();
    assert!(why.contains("answer waiting to be sent"), "{why}");
    assert_eq!(rig.get(&run).await.unsent_answer.as_deref(), Some("Use staging."));

    rig.set(&run, |r| r.unsent_answer = None).await;
    rig.svc.poll_at(later(3)).await;
    assert_eq!(rig.get(&run).await.short_id.as_ref().map(ShortId::as_str), Some("c0000009"), "without a pending answer the same session is adopted");
}

#[tokio::test]
async fn a_pending_answer_can_still_be_sent_again_once_the_poller_has_left_the_run_alone() {
    let (rig, run) = stopped().await;
    add(&rig, &run, "c0000009", &run.expected_worktree);
    rig.set(&run, |r| r.unsent_answer = Some("Use staging.".into())).await;
    rig.svc.poll_at(later(2)).await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped);
    let sent = rig.svc.answer(&run.id, "Use staging.").await.unwrap();
    assert_eq!((sent.state, sent.unsent_answer), (RunState::Working, None), "the saved answer is still offered and goes to the run's own session");
}
