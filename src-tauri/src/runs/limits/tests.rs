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
fn zero_turns_a_limit_off_and_a_run_that_never_launched_has_no_clock() {
    let off = AgentSettings { wall_clock_minutes: 0, token_cap: 0, ..AgentSettings::default() };
    assert_eq!(exceeded(&run(RunState::Working, 100_000, Some(u64::MAX)), Utc::now(), &off), None);
    let mut unlaunched = run(RunState::Working, 0, None);
    unlaunched.launched_at = None;
    assert_eq!(exceeded(&unlaunched, Utc::now(), &AgentSettings::default()), None);
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
    let saved = rig.svc.set_settings(AgentSettings { max_runs: 40, wall_clock_minutes: 5, token_cap: 0, terminal: TerminalChoice::ITerm, draft_on_finish: false }).unwrap();
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
