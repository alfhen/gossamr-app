use std::sync::Arc;

use super::*;
use crate::config::AppConfig;
use crate::domain::RunState;
use crate::inbox::testing::fixture_watching;
use crate::runs::index::RunIndex;
use crate::runs::rig::{ready, Rig};
use crate::runs::toolchain::{FixedToolchain, ToolchainError};

fn stored(rig: &Rig) -> bool {
    AppConfig::load(&rig.fx.core.data_dir()).agents_enabled
}

#[tokio::test]
async fn the_switch_is_saved_and_read_back() {
    let rig = ready().await;
    let off = rig.svc.set_enabled(false).await.unwrap();
    assert!(!off.enabled && !rig.svc.is_enabled() && !stored(&rig));
    let on = rig.svc.set_enabled(true).await.unwrap();
    assert!(on.enabled && rig.svc.is_enabled() && stored(&rig));
}

#[tokio::test]
async fn turning_on_keeps_what_else_is_in_the_config() {
    let rig = ready().await;
    rig.svc.set_enabled(false).await.unwrap();
    let dir = rig.fx.core.data_dir();
    AppConfig { agent_provider: "codex".into(), ..AppConfig::default() }.save(&dir).unwrap();
    rig.svc.set_enabled(true).await.unwrap();
    let config = AppConfig::load(&dir);
    assert!(config.agents_enabled);
    assert_eq!(config.agent_provider, "codex");
    assert!(!dir.join("config.json.tmp").exists());
}

#[tokio::test]
async fn a_failed_environment_capture_leaves_it_off_and_says_why() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let tools = FixedToolchain(Err(ToolchainError::NoEnvironment("the shell printed nothing".into())));
    let svc = RunService::new(fx.core.clone(), Arc::new(tools), RunIndex::load(&fx.dir.join("index")), vec![], Arc::new(|_| {}));
    let why = svc.set_enabled(true).await.unwrap_err().to_string();
    assert!(why.contains("the shell printed nothing"), "{why}");
    assert!(!svc.is_enabled());
    assert!(!AppConfig::load(&fx.core.data_dir()).agents_enabled);
    assert!(svc.ensure_enabled().is_err());
}

#[tokio::test]
async fn a_config_that_cannot_be_written_changes_nothing() {
    let rig = ready().await;
    rig.svc.set_enabled(false).await.unwrap();
    let dir = rig.fx.core.data_dir();
    std::fs::remove_file(dir.join("config.json")).unwrap();
    std::fs::create_dir(dir.join("config.json")).unwrap();
    assert!(rig.svc.set_enabled(true).await.is_err());
    assert!(!rig.svc.is_enabled());
    assert!(!dir.join("config.json.tmp").exists(), "the temporary file is not left behind");
}

#[tokio::test]
async fn commands_refuse_while_off_and_work_after_turning_on_without_a_restart() {
    let rig = ready().await;
    rig.svc.set_enabled(false).await.unwrap();
    let run = rig.queued(1).await;
    assert!(rig.svc.start_now(&run.id).await.is_err());
    assert!(rig.svc.preflight(None).await.is_err());
    assert!(rig.svc.clones("acme/webshop").await.is_err());
    assert_eq!(rig.cli.launches(), 0);

    rig.svc.set_enabled(true).await.unwrap();
    assert_eq!(rig.svc.start_now(&run.id).await.unwrap().state, RunState::Launching);
    assert_eq!(rig.cli.launches(), 1);
    assert!(rig.svc.clones("acme/webshop").await.is_ok());
}

#[tokio::test]
async fn turning_off_leaves_running_agents_alone_and_says_so() {
    let rig = ready().await;
    let run = rig.launched(1).await;
    let off = rig.svc.set_enabled(false).await.unwrap();
    assert_eq!(off.keep_running, 1);
    assert!(off.note.as_deref().is_some_and(|n| n.contains("1 agent is still running and was not stopped")), "{:?}", off.note);
    assert_eq!(rig.get(&run).await.state, RunState::Launching);
    assert_eq!(rig.svc.keep_running(), 1);
    assert!(rig.cli.0.lock().unwrap().stops.is_empty());
    assert!(rig.svc.set_enabled(true).await.unwrap().note.is_none());
}

#[tokio::test]
async fn nothing_to_say_when_nothing_is_running() {
    let rig = ready().await;
    assert_eq!(rig.svc.set_enabled(false).await.unwrap().note, None);
}

#[tokio::test]
async fn the_note_agrees_with_the_count() {
    let rig = ready().await;
    rig.launched(1).await;
    rig.launched(2).await;
    let note = rig.svc.set_enabled(false).await.unwrap().note.unwrap();
    assert!(note.starts_with("2 agents are still running and were not stopped"), "{note}");
    assert!(note.contains("follow them") && note.contains("they keep running"), "{note}");
}

#[tokio::test]
async fn a_start_that_waited_for_its_turn_does_not_launch_after_the_switch_went_off() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    let busy = rig.svc.launching.lock().await;
    let off = tokio::spawn({
        let svc = rig.svc.clone();
        async move { svc.set_enabled(false).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let start = tokio::spawn({
        let (svc, id) = (rig.svc.clone(), run.id.clone());
        async move { svc.start_now(&id).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    drop(busy);
    off.await.unwrap().unwrap();
    assert!(start.await.unwrap().is_err());
    assert_eq!(rig.cli.launches(), 0);
    assert_eq!(rig.get(&run).await.state, RunState::Queued);
}
