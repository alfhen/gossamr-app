use super::*;
use crate::config::{AppConfig, TerminalChoice};
use crate::domain::RunState;
use crate::runs::rig::ready;

#[tokio::test]
async fn settings_are_clamped_saved_and_read_back_by_a_new_start() {
    let rig = ready().await;
    assert_eq!(rig.svc.settings(), AgentSettings::default());
    let saved = rig.svc.set_settings(AgentSettings { max_runs: 40, terminal: TerminalChoice::ITerm, draft_on_finish: false, ..AgentSettings::default() }).unwrap();
    assert_eq!(saved.max_runs, 6);
    assert_eq!(rig.svc.settings(), saved);
    assert_eq!(AppConfig::load(&rig.fx.core.data_dir()).agents, saved);
}

#[tokio::test]
async fn the_concurrency_limit_comes_from_the_settings() {
    let rig = ready().await;
    rig.svc.set_settings(AgentSettings { max_runs: 1, ..AgentSettings::default() }).unwrap();
    let first = rig.launched(1).await;
    assert_ne!(first.state, RunState::Failed);
    let queued = rig.fx.core.queue_test_run(rig.spec(2), Some(rig.fx.item("CA-1"))).await.unwrap();
    let waiting = rig.svc.start_now(&queued.id).await.unwrap();
    assert_eq!((waiting.state, waiting.slot_wait_since.is_some()), (RunState::Queued, true), "over the cap it waits for a slot");
    assert_eq!(rig.cli.launches(), 1);
}
