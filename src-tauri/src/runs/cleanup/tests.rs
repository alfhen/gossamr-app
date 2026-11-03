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

#[tokio::test]
async fn a_run_that_carried_on_in_another_session_has_both_sessions_stopped_and_removed() {
    let (rig, run) = stopped().await;
    let old = run.short_id.clone().unwrap();
    let new = crate::runs::cli::ShortId::parse("c0000009").unwrap();
    rig.cli.with(|s| s.sessions.push(crate::runs::testing::FakeCli::session("c0000009", &run.expected_worktree)));
    rig.set(&run, |r| {
        r.earlier_sessions = vec![crate::domain::EarlierSession { short_id: old.clone(), session_id: r.session_id.clone(), removed: false }];
        r.short_id = Some(new.clone());
        r.session_id = None;
    })
    .await;
    rig.cli.with(|s| s.sessions.push(crate::runs::testing::FakeCli::session("a0000001", &run.expected_worktree)));
    rig.set(&run, |r| r.earlier_sessions.push(crate::domain::EarlierSession { short_id: crate::runs::cli::ShortId::parse("a0000001").unwrap(), session_id: None, removed: false })).await;

    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let cli = rig.cli.0.lock().unwrap();
    assert!(cli.stops.contains(&"c0000009".to_owned()) && cli.stops.contains(&"a0000001".to_owned()), "a live session of either id is stopped first: {:?}", cli.stops);
    assert_eq!(cli.rms.first().map(String::as_str), Some("c0000009"), "the current session is removed first");
    assert!(cli.rms.contains(&old.to_string()) && cli.rms.contains(&"a0000001".to_owned()));
}

async fn with_earlier(ids: &[&str]) -> (Rig, Run) {
    let (rig, run) = stopped().await;
    rig.set(&run, |r| {
        r.earlier_sessions = ids.iter().map(|id| crate::domain::EarlierSession { short_id: crate::runs::cli::ShortId::parse(id).unwrap(), session_id: None, removed: false }).collect();
    })
    .await;
    (rig, run)
}

fn removed_flags(run: &Run) -> Vec<(String, bool)> {
    run.earlier_sessions.iter().map(|e| (e.short_id.to_string(), e.removed)).collect()
}

#[tokio::test]
async fn an_earlier_session_that_is_already_gone_counts_as_removed() {
    let (rig, run) = with_earlier(&["a0000001"]).await;
    rig.cli.with(|s| drop(s.rm_fails.insert("a0000001".into(), "No session a0000001".into())));
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let after = rig.get(&run).await;
    assert_eq!(removed_flags(&after), [("a0000001".to_owned(), true)]);
    assert_eq!(after.last_detail.as_deref(), Some("Worktree removed"));
    assert!(!cleanable(&after));
    assert!(rig.svc.cleanup(&run.id).await.is_err());
}

#[tokio::test]
async fn an_earlier_session_claude_keeps_is_remembered_and_retried_after_the_worktree_is_gone() {
    let (rig, run) = with_earlier(&["a0000001", "a0000002"]).await;
    rig.cli.with(|s| drop(s.rm_fails.insert("a0000002".into(), UNPUSHED.into())));
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed, "the worktree itself is removed");
    let kept = rig.get(&run).await;
    assert!(kept.worktree_removed_at.is_some());
    assert_eq!(removed_flags(&kept), [("a0000001".to_owned(), true), ("a0000002".to_owned(), false)]);
    assert!(kept.last_detail.as_deref().is_some_and(|d| d.contains("An earlier session was kept") && d.contains("unpushed")));
    assert!(cleanable(&kept), "something is still there to remove");
    let first_round = rig.cli.0.lock().unwrap().rms.clone();

    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Refused { message: UNPUSHED.into() }, "still refused: nothing new was removed");
    assert_eq!(rig.cli.0.lock().unwrap().rms[first_round.len()..], ["a0000002"], "only the one that was kept is tried again, not the current session");
    assert!(rig.get(&run).await.last_detail.as_deref().is_some_and(|d| d.contains("kept")));

    rig.cli.with(|s| s.rm_fails.clear());
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let done = rig.get(&run).await;
    assert_eq!(removed_flags(&done), [("a0000001".to_owned(), true), ("a0000002".to_owned(), true)]);
    assert_eq!(done.last_detail.as_deref(), Some("Worktree removed"));
    assert!(!cleanable(&done));
    assert!(rig.svc.cleanup(&run.id).await.is_err(), "nothing left, so it is refused as before");
}

async fn finished_on_a_removed_instance() -> (Rig, Run) {
    let (rig, run) = stopped().await;
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    std::fs::write(rig.clone.join(".fake-branches"), format!("worktree-{}\n", run.spec.name)).unwrap();
    let run = rig
        .set(&run, |r| {
            r.runs_on = Some(crate::model_choice::ModelChoice { instance_id: "claude_2".into(), model: "default".into(), effort: None });
            r.branch = Some(format!("worktree-{}", r.spec.name));
        })
        .await;
    (rig, run)
}

fn git_calls(rig: &Rig) -> Vec<String> {
    let log = std::fs::read_to_string(rig.fx.dir.join("git.log")).unwrap_or_default();
    log.lines().filter(|l| l.contains("worktree remove") || l.contains("worktree prune") || l.contains(" branch ")).map(str::to_owned).collect()
}

#[tokio::test]
async fn a_finished_run_whose_instance_was_removed_is_cleaned_up_with_git_alone() {
    let (rig, run) = finished_on_a_removed_instance().await;
    let asked = |rig: &Rig| {
        let cli = rig.cli.0.lock().unwrap();
        (cli.rms.len(), cli.stops.len(), cli.listings)
    };
    let before = asked(&rig);
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    assert_eq!(asked(&rig), before, "claude is never asked");
    let after = rig.get(&run).await;
    assert!(after.worktree_removed_at.is_some() && after.sessions_left);
    assert_eq!(after.state, RunState::Stopped);
    assert!(!run.expected_worktree.exists());
    let calls = git_calls(&rig);
    assert!(calls.iter().any(|c| c.contains(&format!("worktree remove -- {}", run.expected_worktree.display()))), "{calls:?}");
    assert!(calls.iter().any(|c| c.ends_with(&format!("branch -d -- {}", run.branch.as_ref().unwrap()))), "{calls:?}");
    assert!(calls.iter().all(|c| !c.contains("--force") && !c.contains(" -D") && !c.contains(" -f")), "git is never forced: {calls:?}");
    assert!(!cleanable(&after));
}

#[tokio::test]
async fn a_run_cleaned_up_through_claude_does_not_say_its_session_was_left() {
    let (rig, run) = stopped().await;
    rig.svc.cleanup(&run.id).await.unwrap();
    assert!(!rig.get(&run).await.sessions_left);
}

#[tokio::test]
async fn git_keeps_a_worktree_with_uncommitted_work_and_says_so_without_forcing() {
    let (rig, run) = finished_on_a_removed_instance().await;
    std::fs::write(rig.clone.join(".fake-worktree-dirty"), "").unwrap();
    let Cleanup::Refused { message } = rig.svc.cleanup(&run.id).await.unwrap() else { panic!("expected a refusal") };
    assert!(message.contains("untracked files"), "{message}");
    assert!(run.expected_worktree.exists());
    assert_eq!(rig.get(&run).await.worktree_removed_at, None);
    assert!(git_calls(&rig).iter().all(|c| !c.contains(" branch -d")), "the branch is left while its worktree is");
}

#[tokio::test]
async fn git_keeps_a_branch_with_unpushed_commits_and_the_run_can_be_cleaned_up_again() {
    let (rig, run) = finished_on_a_removed_instance().await;
    std::fs::write(rig.clone.join(".fake-branch-unmerged"), "").unwrap();
    let Cleanup::Refused { message } = rig.svc.cleanup(&run.id).await.unwrap() else { panic!("expected a refusal") };
    assert!(message.contains("not fully merged"), "{message}");
    assert!(run.expected_worktree.exists(), "the worktree stays when its branch is refused");
    assert_eq!(rig.get(&run).await.worktree_removed_at, None);
    std::fs::remove_file(rig.clone.join(".fake-branch-unmerged")).unwrap();
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    assert!(!run.expected_worktree.exists());
}

#[tokio::test]
async fn git_does_not_touch_a_worktree_outside_the_work_folder() {
    let (rig, run) = finished_on_a_removed_instance().await;
    let elsewhere = rig.fx.home.join("Code/webshop/.claude/worktrees/x");
    std::fs::create_dir_all(&elsewhere).unwrap();
    rig.set(&run, |r| r.expected_worktree = elsewhere.clone()).await;
    assert!(rig.svc.cleanup(&run.id).await.unwrap_err().to_string().contains("isn't in ~/Gossamr/agents"));
    assert!(elsewhere.exists() && git_calls(&rig).is_empty());
}

#[tokio::test]
async fn git_does_not_touch_a_clone_outside_the_work_folder_when_the_worktree_is_gone() {
    let (rig, run) = finished_on_a_removed_instance().await;
    let legacy = rig.fx.home.join("Code/webshop");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::remove_dir_all(&run.expected_worktree).unwrap();
    rig.set(&run, |r| r.spec.clone_path = legacy.clone()).await;
    assert!(rig.svc.cleanup(&run.id).await.unwrap_err().to_string().contains("clone isn't in ~/Gossamr/agents"));
    assert!(git_calls(&rig).is_empty());
}

#[tokio::test]
async fn earlier_sessions_of_a_run_on_a_removed_instance_are_left_in_its_folder_and_not_offered_again() {
    let (rig, run) = finished_on_a_removed_instance().await;
    let run = rig
        .set(&run, |r| r.earlier_sessions.push(crate::domain::EarlierSession { short_id: ShortId::parse("e1e1e1e1").unwrap(), session_id: None, removed: false }))
        .await;
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let after = rig.get(&run).await;
    assert!(after.leftover_sessions().is_empty() && !cleanable(&after));
    assert_eq!(rig.cli.0.lock().unwrap().rms.len(), 0);
}

#[tokio::test]
async fn a_finished_run_on_an_instance_that_is_off_is_still_cleaned_up_through_claude() {
    let (rig, run) = stopped().await;
    rig.set(&run, |r| r.runs_on = Some(crate::model_choice::ModelChoice { instance_id: "claude".into(), model: "default".into(), effort: None })).await;
    rig.fx.core.set_instance_enabled("claude", false).await.unwrap();
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    let after = rig.get(&run).await;
    assert!(after.worktree_removed_at.is_some() && !after.sessions_left);
    assert!(!rig.cli.0.lock().unwrap().rms.is_empty(), "claude removed it");
    assert!(git_calls(&rig).is_empty());
}

#[tokio::test]
async fn a_finished_run_on_the_second_login_is_cleaned_up_through_that_logins_claude_only_even_while_it_is_off() {
    let rig = ready().await;
    crate::config::AppConfig::update(&rig.fx.core.data_dir(), |config| {
        config.providers.push(crate::connections::ProviderInstance { id: "claude_2".into(), display_name: "Claude personal".into(), ..crate::connections::default_claude() })
    })
    .unwrap();
    let (svc, second, run) = crate::runs::rig::working_on_second_login(&rig, true).await;
    let run = rig.set(&run, |r| r.state = RunState::Stopped).await;
    second.with(|s| {
        s.sessions[0].state = Some("stopped".into());
        s.sessions[0].pid = None;
    });

    assert_eq!(svc.cleanup(&run.id).await.unwrap(), Cleanup::Removed);
    assert_eq!(second.0.lock().unwrap().rms, ["abc12345"]);
    assert!(rig.cli.0.lock().unwrap().rms.is_empty());
}
