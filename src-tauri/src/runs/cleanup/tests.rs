use super::*;
use crate::runs::rig::{ready, Rig};

const LOCKED: &str = "A Claude Code lock on the worktree names a process that is still running";
const UNPUSHED: &str = "worktree has 1 unpushed commit; push it or pass --discard-unpushed";

async fn stopped() -> (Rig, Run) {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    rig.svc.stop(&run.id).await.unwrap();
    let run = rig.get(&run).await;
    (rig, run)
}

#[tokio::test]
async fn a_finished_run_loses_its_worktree_and_keeps_its_row_and_state() {
    let (rig, run) = stopped().await;
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let after = rig.get(&run).await;
    assert_eq!(after.state, RunState::Stopped);
    assert!(after.worktree_removed_at.is_some());
    assert_eq!(after.last_detail.as_deref(), Some("Worktree removed"));
    assert_eq!(rig.cli.0.lock().unwrap().rms, [run.short_id.as_ref().unwrap().to_string()]);
    assert!(!rig.svc.index.contains(&run.id));
    assert!(!cleanable(&after));
    assert!(rig.svc.cleanup(&run.id).await.is_err(), "twice is refused without running rm again");
    assert_eq!(rig.cli.0.lock().unwrap().rms.len(), 1);
}

#[tokio::test]
async fn the_lock_refusal_after_a_stop_is_retried_until_it_clears() {
    let (rig, run) = stopped().await;
    rig.cli.with(|s| s.rm_refusals = vec![LOCKED.into(), LOCKED.into()]);
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    assert_eq!(rig.cli.0.lock().unwrap().rms.len(), 3);
}

#[tokio::test]
async fn a_lock_that_never_clears_is_given_up_on_with_claudes_words() {
    let (rig, run) = stopped().await;
    rig.cli.with(|s| s.rm_refusals = vec![LOCKED.into(); 20]);
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Refused { message: LOCKED.into() });
    assert_eq!(rig.cli.0.lock().unwrap().rms.len(), 7, "one try and six retries");
    assert_eq!(rig.get(&run).await.worktree_removed_at, None);
}

#[tokio::test]
async fn unpushed_work_is_refused_verbatim_and_not_retried() {
    let (rig, run) = stopped().await;
    rig.cli.with(|s| s.rm_refusals = vec![format!("{UNPUSHED}\n")]);
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Refused { message: UNPUSHED.into() });
    assert_eq!(rig.cli.0.lock().unwrap().rms.len(), 1);
    let after = rig.get(&run).await;
    assert_eq!((after.worktree_removed_at, after.last_detail), (None, run.last_detail));
    assert!(rig.svc.index.contains(&run.id));
}

#[tokio::test]
async fn a_second_request_for_a_run_being_cleaned_up_is_refused_and_rm_runs_once() {
    let (rig, run) = stopped().await;
    rig.cli.with(|s| s.rm_refusals = vec![LOCKED.into()]);
    let (first, second) = tokio::join!(rig.svc.cleanup(&run.id), rig.svc.cleanup(&run.id));
    assert_eq!(first.unwrap(), Cleanup::Removed);
    assert!(second.unwrap_err().to_string().contains("already being cleaned up"));
    assert_eq!(rig.cli.0.lock().unwrap().rms.len(), 2, "the refused try and the retry, both from the first request");
    assert!(rig.svc.cleaning.lock().unwrap().is_empty(), "the mark is gone after every way out");
    assert!(rig.svc.cleanup(&run.id).await.is_err());
    assert!(rig.svc.cleaning.lock().unwrap().is_empty());
}

#[tokio::test]
async fn only_finished_runs_with_a_session_can_be_cleaned_up() {
    let rig = ready().await;
    let working = rig.launched(1).await;
    assert!(rig.svc.cleanup(&working.id).await.unwrap_err().to_string().contains("Stop it first"));
    let queued = rig.queued(2).await;
    assert!(rig.svc.cleanup(&queued.id).await.is_err());
    let failed = rig.set(&queued, |r| r.state = RunState::Failed).await;
    assert!(rig.svc.cleanup(&failed.id).await.unwrap_err().to_string().contains("no session"));
    assert!(rig.cli.0.lock().unwrap().rms.is_empty());
}

#[tokio::test]
async fn nothing_is_removed_while_agents_are_off() {
    let (rig, run) = stopped().await;
    rig.svc.set_enabled(false).await.unwrap();
    assert!(rig.svc.cleanup(&run.id).await.is_err());
    assert!(rig.cli.0.lock().unwrap().rms.is_empty());
}

#[tokio::test]
async fn the_tracker_leaves_a_run_whose_worktree_is_gone_alone() {
    let (rig, run) = stopped().await;
    rig.svc.cleanup(&run.id).await.unwrap();
    let before = rig.cli.0.lock().unwrap().listings;
    rig.poll().await;
    assert_eq!(rig.cli.0.lock().unwrap().listings, before, "no unfinished run, so no listing");
}

#[tokio::test]
async fn a_finished_run_whose_session_is_still_open_is_stopped_before_its_worktree_is_removed() {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    rig.set(&run, |r| r.state = RunState::Done).await;
    let id = run.short_id.as_ref().unwrap().to_string();
    rig.cli.with(|s| s.rm_refusals = vec![LOCKED.into()]);

    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let cli = rig.cli.0.lock().unwrap();
    assert_eq!((cli.stops.clone(), cli.rms.len()), (vec![id], 2));
}

#[tokio::test]
async fn a_finished_run_with_no_process_is_removed_without_a_stop() {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = None;
        e.pid = None;
    });
    rig.set(&run, |r| r.state = RunState::Done).await;
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    assert!(rig.cli.0.lock().unwrap().stops.is_empty());
}

#[tokio::test]
async fn the_live_session_the_listing_names_is_the_one_stopped_and_removed_not_the_stored_id() {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    rig.session(&run, |e| {
        e.state = Some("stopped".into());
        e.pid = None;
    });
    let live = crate::runs::testing::FakeCli::session("d0d0d0d0", &run.expected_worktree);
    let foreign = crate::runs::testing::FakeCli::session("f1f1f1f1", &rig.clone);
    rig.cli.with(|s| s.sessions.extend([live, foreign]));
    rig.set(&run, |r| r.state = RunState::Done).await;

    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let cli = rig.cli.0.lock().unwrap();
    assert_eq!((cli.stops.clone(), cli.rms.clone()), (vec!["d0d0d0d0".to_owned()], vec!["d0d0d0d0".to_owned()]));
}
