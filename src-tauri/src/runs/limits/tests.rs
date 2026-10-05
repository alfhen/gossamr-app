use chrono::{Duration, Utc};

use super::*;
use crate::config::{AppConfig, TerminalChoice};
use crate::domain::fixtures::run_spec;
use crate::runs::rig::ready;

fn run(state: RunState, minutes: i64, tokens: Option<u64>) -> Run {
    let now = Utc::now();
    let mut run = Run::queued("r".into(), "p".into(), "c".into(), None, run_spec(), "db".into(), now);
    run.state = state;
    run.launched_at = Some(now - Duration::minutes(minutes));
    run.tokens = tokens;
    run
}

#[test]
fn a_run_is_over_at_the_limit_and_not_just_under_it() {
    let settings = AgentSettings { wall_clock_minutes: 60, token_cap: 1000, ..AgentSettings::default() };
    let now = Utc::now();
    let at = |state, minutes, tokens| {
        let mut r = run(state, minutes, tokens);
        r.launched_at = Some(now - Duration::minutes(minutes));
        exceeded(&r, now, &settings)
    };
    assert_eq!(at(RunState::Working, 59, Some(999)), None);
    assert_eq!(at(RunState::Working, 60, Some(999)), Some(Overrun::Wall));
    assert_eq!(at(RunState::Working, 1, Some(1000)), Some(Overrun::Tokens));
    assert_eq!(at(RunState::NeedsAnswer, 61, None), Some(Overrun::Wall));
    assert_eq!(at(RunState::SystemBlocked, 61, None), Some(Overrun::Wall));
    assert_eq!(at(RunState::NeedsPermission, 1, Some(5000)), Some(Overrun::Tokens));
}

#[test]
fn queued_launching_and_finished_runs_are_exempt() {
    let settings = AgentSettings { wall_clock_minutes: 1, token_cap: 1, ..AgentSettings::default() };
    for state in [RunState::Queued, RunState::Launching, RunState::Done, RunState::Failed, RunState::Stopped, RunState::Unknown] {
        assert_eq!(exceeded(&run(state, 600, Some(9)), Utc::now(), &settings), None, "{state:?}");
    }
}

#[test]
fn a_run_the_person_carried_on_is_exempt() {
    let settings = AgentSettings { wall_clock_minutes: 1, token_cap: 1, ..AgentSettings::default() };
    let mut r = run(RunState::Working, 600, Some(9));
    assert!(exceeded(&r, Utc::now(), &settings).is_some());
    r.continued_at = Some(Utc::now());
    assert_eq!(exceeded(&r, Utc::now(), &settings), None);
}

#[test]
fn zero_turns_a_limit_off_and_a_run_that_never_launched_has_no_clock() {
    let off = AgentSettings { wall_clock_minutes: 0, token_cap: 0, ..AgentSettings::default() };
    assert_eq!(exceeded(&run(RunState::Working, 100_000, Some(u64::MAX)), Utc::now(), &off), None);
    let mut unlaunched = run(RunState::Working, 0, None);
    unlaunched.launched_at = None;
    assert_eq!(exceeded(&unlaunched, Utc::now(), &AgentSettings::default()), None);
}

#[test]
fn time_spent_waiting_on_the_person_is_not_work() {
    let now = Utc::now();
    let mut r = run(RunState::Working, 600, None);
    r.launched_at = Some(now - Duration::minutes(600));
    r.waited_secs = 3 * 3600;
    assert_eq!(worked(&r, now), Some(Duration::minutes(420)));
    r.waiting_since = Some(now - Duration::minutes(30));
    assert_eq!(worked(&r, now), Some(Duration::minutes(390)), "a wait still under way counts as waiting too");
    r.waited_secs = 100 * 3600;
    assert_eq!(worked(&r, now), Some(Duration::zero()), "never negative");
    r.launched_at = None;
    assert_eq!(worked(&r, now), None);
}

#[test]
fn the_clock_opens_a_wait_when_the_run_asks_and_adds_it_when_the_run_is_back_at_work() {
    let t0 = Utc::now();
    let mut r = run(RunState::Working, 10, None);
    tick(&mut r, t0);
    assert_eq!((r.waited_secs, r.waiting_since), (0, None));
    for waiting in [RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked] {
        r.state = waiting;
        tick(&mut r, t0);
        assert_eq!(r.waiting_since, Some(t0), "{waiting:?}");
        tick(&mut r, t0 + Duration::minutes(5));
        assert_eq!(r.waiting_since, Some(t0), "a wait keeps the time it began");
        r.state = RunState::Working;
        tick(&mut r, t0 + Duration::seconds(90));
        assert_eq!(r.waiting_since, None);
        r.waited_secs = 0;
    }
    r.state = RunState::NeedsAnswer;
    tick(&mut r, t0);
    r.state = RunState::Stopped;
    tick(&mut r, t0 + Duration::hours(1));
    assert_eq!((r.waited_secs, r.waiting_since), (3600, None), "a run that ends while waiting closes its wait");
}

#[test]
fn only_working_time_counts_towards_the_wall_clock() {
    let settings = AgentSettings { wall_clock_minutes: 60, token_cap: 0, ..AgentSettings::default() };
    let now = Utc::now();
    let mut r = run(RunState::NeedsAnswer, 200, None);
    r.launched_at = Some(now - Duration::minutes(200));
    r.waiting_since = Some(now - Duration::minutes(190));
    assert_eq!(exceeded(&r, now, &settings), None, "10 minutes of work, 190 waiting");
    r.waiting_since = None;
    r.waited_secs = 190 * 60;
    r.state = RunState::Working;
    assert_eq!(exceeded(&r, now, &settings), None);
    r.waited_secs = 139 * 60;
    assert_eq!(exceeded(&r, now, &settings), Some(Overrun::Wall), "61 minutes of work");
}

#[test]
fn waiting_never_pauses_the_token_cap() {
    let settings = AgentSettings { wall_clock_minutes: 60, token_cap: 1000, ..AgentSettings::default() };
    let mut r = run(RunState::NeedsAnswer, 10, Some(1000));
    r.waiting_since = Some(Utc::now() - Duration::minutes(9));
    assert_eq!(exceeded(&r, Utc::now(), &settings), Some(Overrun::Tokens));
}

#[test]
fn the_reason_names_the_limit_in_plain_words() {
    let s = AgentSettings { wall_clock_minutes: 45, token_cap: 3_000_000, ..AgentSettings::default() };
    assert_eq!(Overrun::Wall.reason(&s), "Stopped by Gossamr: it passed the 45 minute limit");
    assert_eq!(Overrun::Tokens.reason(&s), "Stopped by Gossamr: it passed the 3,000,000 token limit");
    assert_eq!(grouped(999), "999");
    assert_eq!(grouped(1_000), "1,000");
    assert_eq!(grouped(12_345_678), "12,345,678");
}

#[tokio::test]
async fn settings_are_clamped_saved_and_read_back_by_a_new_start() {
    let rig = ready().await;
    assert_eq!(rig.svc.settings(), AgentSettings::default());
    let saved = rig.svc.set_settings(AgentSettings { max_runs: 40, wall_clock_minutes: 5, token_cap: 0, terminal: TerminalChoice::ITerm, draft_on_finish: false, report_result: false }).unwrap();
    assert_eq!((saved.max_runs, saved.wall_clock_minutes, saved.token_cap), (6, 5, 0));
    assert_eq!(rig.svc.settings(), saved);
    assert_eq!(AppConfig::load(&rig.fx.core.data_dir()).agents, saved);
    assert!(rig.svc.is_enabled(), "the switch is not touched");
}

#[tokio::test]
async fn the_concurrency_limit_comes_from_the_settings() {
    let rig = ready().await;
    rig.svc.set_settings(AgentSettings { max_runs: 1, ..AgentSettings::default() }).unwrap();
    let first = rig.launched(1).await;
    assert_ne!(first.state, RunState::Failed);
    let second = rig.fx.core.draft_run(rig.spec(2), Some(rig.fx.item("CA-1"))).await.unwrap();
    let digest = rig.fx.core.runs_review(&second.id).await.unwrap().digest;
    let queued = rig.fx.core.runs_approve(&second.id, &digest).await.unwrap();
    let refused = rig.svc.start_now(&queued.id).await.unwrap();
    assert_eq!(refused.state, RunState::Failed);
    assert!(refused.error.unwrap().contains("1 agents are already running"));
}
