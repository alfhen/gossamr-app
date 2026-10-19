use chrono::Duration as Days;

use super::*;
use crate::domain::fixtures::run_spec;
use crate::domain::{CreatedBy, Doc, Intent, Origin};
use crate::proposals::Draft;
use crate::runs::rig::{ready, Rig};

const UNPUSHED: &str = "worktree has 1 unpushed commit; push it or pass --discard-unpushed";
const OVER: [RunState; 4] = [RunState::Done, RunState::Failed, RunState::Stopped, RunState::Unknown];

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("gossamr-archive-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(id: &str, state: RunState, ended_days_ago: i64) -> Run {
    let now = Utc::now();
    let mut r = Run::queued(id.into(), format!("p{id}"), "c".into(), None, run_spec(), "f".into(), now - Days::days(ended_days_ago + 1));
    r.state = state;
    r.ended_at = Some(now - Days::days(ended_days_ago));
    r
}

fn filter(days: Option<u32>, states: &[RunState]) -> ClearFilter {
    ClearFilter { older_than_days: days, states: states.to_vec(), keep: vec![] }
}

fn ids(runs: &[Run], f: &ClearFilter) -> Vec<String> {
    select_clearable(runs, &HashSet::new(), f, Utc::now()).ids
}

#[test]
fn a_run_is_selected_only_in_a_chosen_state_and_only_when_older_than_the_age() {
    let runs = [run("done-old", RunState::Done, 10), run("done-new", RunState::Done, 2), run("failed-old", RunState::Failed, 10), run("stopped-old", RunState::Stopped, 10)];
    assert_eq!(ids(&runs, &filter(Some(7), &[RunState::Done, RunState::Failed])), ["done-old", "failed-old"]);
    assert_eq!(ids(&runs, &filter(None, &[RunState::Done])), ["done-old", "done-new"]);
    assert!(ids(&runs, &filter(Some(1), &[])).is_empty());
}

#[test]
fn running_and_waiting_runs_are_never_selected_even_when_asked_for() {
    let live = [RunState::Queued, RunState::Launching, RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked];
    let runs: Vec<Run> = live.iter().map(|s| run(s.as_str(), *s, 90)).collect();
    let everything: Vec<RunState> = live.iter().chain(OVER.iter()).copied().collect();
    assert!(ids(&runs, &filter(None, &everything)).is_empty());
}

#[test]
fn a_run_with_a_pending_draft_is_kept_and_counted() {
    let runs = [run("plan", RunState::Done, 30), run("plain", RunState::Done, 30)];
    let preview = select_clearable(&runs, &["plan".to_string()].into(), &filter(Some(7), &OVER), Utc::now());
    assert_eq!(preview.ids, ["plain"]);
    assert_eq!((preview.kept.draft, preview.kept.needs_you), (1, 0));
}

#[test]
fn a_run_the_page_lists_in_needs_you_is_kept_and_counted() {
    let runs = [run("failed", RunState::Failed, 30), run("done", RunState::Done, 30)];
    let preview = select_clearable(&runs, &HashSet::new(), &ClearFilter { keep: vec!["failed".into()], ..filter(Some(7), &OVER) }, Utc::now());
    assert_eq!(preview.ids, ["done"]);
    assert_eq!(preview.by_state.get("done"), Some(&1));
    assert_eq!((preview.kept.draft, preview.kept.needs_you), (0, 1));
}

#[test]
fn an_archived_run_is_not_selected_again() {
    let mut archived = run("a", RunState::Done, 30);
    archived.archived_at = Some(Utc::now());
    assert!(ids(&[archived], &filter(None, &OVER)).is_empty());
}

#[test]
fn only_a_folder_strictly_inside_the_root_is_contained() {
    let dir = Scratch::new("contained");
    let root = dir.0.join("agents");
    let inside = root.join("acme/webshop");
    std::fs::create_dir_all(&inside).unwrap();
    let outside = dir.0.join("elsewhere");
    std::fs::create_dir_all(&outside).unwrap();
    let sibling = dir.0.join("agents-evil");
    std::fs::create_dir_all(&sibling).unwrap();

    assert_eq!(contained(&root, &inside), Some(inside.canonicalize().unwrap()));
    assert_eq!(contained(&root, &root), None, "the root itself is not removable");
    assert_eq!(contained(&root, &outside), None);
    assert_eq!(contained(&root, &root.join("acme/../../elsewhere")), None, "a .. that climbs out");
    assert_eq!(contained(&root, &root.join("missing")), None);
    assert_eq!(contained(&dir.0.join("no-root"), &inside), None);
    assert_eq!(contained(&root, &sibling), None, "a name that only starts the same");
}

#[cfg(unix)]
#[test]
fn a_symlink_inside_the_root_that_points_out_is_not_contained() {
    let dir = Scratch::new("symlink");
    let root = dir.0.join("agents");
    let outside = dir.0.join("precious");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    assert_eq!(contained(&root, &root.join("link")), None);
}

fn one(run: &Run) -> Vec<String> {
    vec![run.id.clone()]
}

async fn stopped(rig: &Rig, n: u32) -> Run {
    let run = rig.launched(n).await;
    rig.poll().await;
    rig.svc.stop(&run.id).await.unwrap();
    rig.get(&run).await
}

/// Moves a run's worktree to a real folder under `~/Gossamr/agents` and puts a file in it.
async fn in_gossamr_folder(rig: &Rig, run: &Run) -> PathBuf {
    let folder = rig.fx.home.canonicalize().unwrap().join("Gossamr/agents/acme/webshop/.claude/worktrees").join(&run.spec.name);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("file.txt"), vec![0u8; 1234]).unwrap();
    rig.set(run, |r| r.expected_worktree = folder.clone()).await;
    folder
}

#[tokio::test]
async fn archive_and_restore_round_trip_and_the_list_says_which_runs_are_archived() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    assert_eq!(rig.svc.archive(&one(&run)).await.unwrap(), one(&run));
    assert!(rig.get(&run).await.archived_at.is_some());
    assert!(rig.fx.core.runs_list(&Default::default()).await.unwrap().iter().any(|r| r.id == run.id && r.archived_at.is_some()));
    rig.svc.restore(&run.id).await.unwrap();
    assert!(rig.get(&run).await.archived_at.is_none());
    assert!(rig.svc.restore(&run.id).await.is_err(), "restoring a run that isn't archived is refused");
}

#[tokio::test]
async fn a_run_that_is_still_going_must_be_stopped_before_it_is_archived() {
    let rig = ready().await;
    let working = rig.launched(1).await;
    let err = rig.svc.archive(&one(&working)).await.unwrap_err().to_string();
    assert!(err.contains("Stop it first"), "{err}");
    assert!(rig.get(&working).await.archived_at.is_none());
}

#[tokio::test]
async fn archiving_tells_the_page_the_runs_changed() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    rig.changes.lock().unwrap().clear();
    rig.svc.archive(&one(&run)).await.unwrap();
    assert_eq!(*rig.changes.lock().unwrap(), vec![run.connection_id.clone()]);
}

#[tokio::test]
async fn a_run_that_is_not_archived_cannot_be_deleted() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    assert!(rig.svc.delete(&run.id, false).await.unwrap_err().to_string().contains("archived"));
    assert!(rig.fx.core.run(&run.id).await.unwrap().is_some());
}

#[tokio::test]
async fn deleting_removes_the_row_and_its_events_and_leaves_the_worktree_and_claudes_files_alone() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    let folder = in_gossamr_folder(&rig, &run).await;
    let claude_file = rig.fx.dir.join("claude-config/jobs/session.json");
    std::fs::create_dir_all(claude_file.parent().unwrap()).unwrap();
    std::fs::write(&claude_file, "{}").unwrap();
    let event = crate::domain::RunEvent { run_id: run.id.clone(), seq: 0, at: Utc::now(), kind: "k".into(), text: "t".into(), detail: None };
    rig.fx.core.append_run_events(&run.id, &[event]).await.unwrap();
    rig.svc.archive(&one(&run)).await.unwrap();

    assert_eq!(rig.svc.delete(&run.id, false).await.unwrap(), Deleted::Deleted);

    assert!(rig.fx.core.run(&run.id).await.unwrap().is_none());
    assert!(rig.fx.core.run_events(&run.id).await.unwrap().is_empty());
    assert!(folder.exists() && claude_file.exists());
    assert!(rig.cli.0.lock().unwrap().rms.is_empty(), "no claude rm without the person's say-so");
}

#[tokio::test]
async fn deleting_with_the_worktree_removes_it_through_claude_inside_the_gossamr_folder() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    in_gossamr_folder(&rig, &run).await;
    rig.svc.archive(&one(&run)).await.unwrap();

    let info = rig.svc.worktree_info(&run.id).await.unwrap();
    assert_eq!((info.removable, info.bytes), (true, Some(1234)));

    assert_eq!(rig.svc.delete(&run.id, true).await.unwrap(), Deleted::Deleted);
    assert_eq!(rig.cli.0.lock().unwrap().rms, [run.short_id.as_ref().unwrap().to_string()]);
    assert!(rig.fx.core.run(&run.id).await.unwrap().is_none());
}

#[tokio::test]
async fn a_worktree_outside_the_gossamr_folder_is_never_offered_or_removed() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    let outside = rig.fx.dir.join("my-own-clone/.claude/worktrees/x");
    std::fs::create_dir_all(&outside).unwrap();
    rig.set(&run, |r| r.expected_worktree = outside.clone()).await;
    rig.svc.archive(&one(&run)).await.unwrap();

    let info = rig.svc.worktree_info(&run.id).await.unwrap();
    assert_eq!((info.removable, info.bytes), (false, None));
    assert!(info.reason.unwrap().contains("~/Gossamr/agents"));
    assert!(rig.svc.delete(&run.id, true).await.is_err());
    assert!(rig.cli.0.lock().unwrap().rms.is_empty());
    assert!(outside.exists());
    assert!(rig.fx.core.run(&run.id).await.unwrap().is_some(), "the row stays when the worktree can't be removed");
}

#[tokio::test]
async fn when_claude_refuses_to_remove_the_worktree_nothing_is_deleted() {
    let rig = ready().await;
    let run = stopped(&rig, 1).await;
    in_gossamr_folder(&rig, &run).await;
    rig.svc.archive(&one(&run)).await.unwrap();
    rig.cli.with(|s| s.rm_refusals = vec![UNPUSHED.into()]);

    assert_eq!(rig.svc.delete(&run.id, true).await.unwrap(), Deleted::Refused { message: UNPUSHED.into() });
    assert!(rig.get(&run).await.archived_at.is_some());
}

#[tokio::test]
async fn clearing_archives_what_the_preview_shows_and_keeps_a_run_with_a_pending_draft() {
    let rig = ready().await;
    let (old, kept) = (stopped(&rig, 1).await, stopped(&rig, 2).await);
    for r in [&old, &kept] {
        rig.set(r, |r| r.ended_at = Some(Utc::now() - Days::days(30))).await;
    }
    let intent = Intent::Comment { item: rig.fx.item("CA-1"), body: Doc::paragraph("hi") };
    let origin = Origin::Run { run_id: kept.id.clone(), short_id: None, workstream: None };
    rig.fx.core.propose(&rig.fx.scope, Draft { origin, created_by: CreatedBy::Agent, intent, label: None, basis: None }).await.unwrap();

    let f = filter(Some(7), &[RunState::Stopped]);
    let preview = rig.svc.clear_preview(&f).await.unwrap();
    assert_eq!((preview.ids.clone(), preview.kept.draft), (one(&old), 1));
    assert_eq!(rig.svc.clear(&f).await.unwrap(), one(&old));
    assert!(rig.get(&old).await.archived_at.is_some() && rig.get(&kept).await.archived_at.is_none());
}
