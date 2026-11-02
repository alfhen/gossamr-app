use super::*;
use crate::config::{AppConfig, TerminalChoice};
use crate::domain::RunState;
use crate::runs::rig::ready;

#[tokio::test]
async fn settings_are_clamped_saved_and_read_back_by_a_new_start() {
    let rig = ready().await;
    assert_eq!(rig.svc.settings(), AgentSettings::default());
    let saved = rig.svc.set_settings(AgentSettings { max_runs: 40, terminal: TerminalChoice::ITerm, ..AgentSettings::default() }).unwrap();
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

#[tokio::test]
async fn the_settings_view_gives_the_work_folders_commit_address_and_whether_git_chooses_by_folder() {
    let rig = ready().await;
    let work = crate::runs::fresh::agents_root(&rig.fx.home);
    let plain = rig.svc.settings_view(rig.svc.settings()).await;
    assert_eq!((plain.work_folder.commit_email, plain.work_folder.include_if), (None, false));

    std::fs::write(work.join(".fake-email"), "alf@acme.example\n").unwrap();
    std::fs::write(work.join(".fake-includeif"), "includeif.gitdir:~/Code/.path /Users/alf/.gitconfig-work\n").unwrap();
    let view = rig.svc.settings_view(rig.svc.settings()).await;
    assert_eq!((view.work_folder.commit_email.as_deref(), view.work_folder.include_if), (Some("alf@acme.example"), true));
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["workFolder"], serde_json::json!({ "commitEmail": "alf@acme.example", "includeIf": true }));
    assert_eq!(json["maxRuns"], 3, "the saved settings stay at the top level");
}

#[tokio::test]
async fn revealing_the_work_folder_makes_it_and_the_service_takes_no_path() {
    let rig = ready().await;
    let work = crate::runs::fresh::agents_root(&rig.fx.home);
    std::fs::remove_dir_all(&work).unwrap();
    let shown = rig.svc.work_folder_to_reveal().unwrap();
    assert!(work.is_dir());
    assert_eq!(shown, work.canonicalize().unwrap());
    assert_eq!(rig.svc.work_folder_to_reveal().unwrap(), shown, "again is the same folder");
}
