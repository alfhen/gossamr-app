use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use super::*;
use crate::runs::index::Entry;
use crate::runs::rig::{ready, Rig};
use crate::runs::testing::FakeCli;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("gossamr-control-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

async fn working() -> (Rig, Run) {
    let rig = ready().await;
    let run = rig.launched(1).await;
    rig.poll().await;
    let run = rig.get(&run).await;
    assert_eq!(run.state, RunState::Working);
    (rig, run)
}

#[tokio::test]
async fn stop_is_refused_until_the_run_is_working() {
    let rig = ready().await;
    let queued = rig.queued(1).await;
    assert!(rig.svc.stop(&queued.id).await.unwrap_err().to_string().contains("once it is working"));
    let launching = rig.launched(2).await;
    assert_eq!(launching.state, RunState::Launching);
    assert!(rig.svc.stop(&launching.id).await.unwrap_err().to_string().contains("once it is working"));
    assert!(rig.cli.0.lock().unwrap().stops.is_empty());
}

#[tokio::test]
async fn stopping_a_working_run_stops_its_session_and_keeps_the_worktree() {
    let (rig, run) = working().await;
    let stopped = rig.svc.stop(&run.id).await.unwrap();
    assert_eq!((stopped.state, stopped.error), (RunState::Stopped, None));
    assert!(stopped.ended_at.is_some());
    assert_eq!(rig.cli.0.lock().unwrap().stops, [run.short_id.as_ref().unwrap().to_string()]);
    assert_eq!(rig.get(&run).await.state, RunState::Stopped);
    assert!(rig.svc.index.live().is_empty());
    assert!(rig.svc.stop(&run.id).await.unwrap_err().to_string().contains("nothing to stop"));
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Stopped, "the tracker agrees");
}

#[tokio::test]
async fn a_run_waiting_on_the_person_can_be_stopped() {
    let (rig, run) = working().await;
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.pid = None;
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);
    assert_eq!(rig.svc.stop(&run.id).await.unwrap().state, RunState::Stopped);
}

fn other_account(run_id: &str, id: &str) -> Entry {
    Entry { db_file: "inbox-other.sqlite".into(), run_id: run_id.into(), expected_worktree: format!("/elsewhere/{run_id}").into(), short_id: ShortId::parse(id), terminal: false }
}

#[tokio::test]
async fn stop_all_stops_only_runs_in_the_index_of_any_account_and_never_a_foreign_session() {
    let (rig, mine) = working().await;
    rig.cli.with(|s| {
        s.sessions.push(FakeCli::session("f0f0f0f0", Path::new("/tmp/foreign")));
        s.sessions.push(FakeCli::session("0ddba11e", Path::new("/elsewhere/other-1")));
    });
    rig.svc.index.record(other_account("other-1", "0ddba11e")).unwrap();

    let tally = rig.svc.stop_all().await.unwrap();
    assert_eq!(tally, StopAll { stopped: 2, failed: 0 });
    let stops = rig.cli.0.lock().unwrap().stops.clone();
    let mut expected = vec![mine.short_id.as_ref().unwrap().to_string(), "0ddba11e".to_string()];
    expected.sort();
    let mut stops_sorted = stops.clone();
    stops_sorted.sort();
    assert_eq!(stops_sorted, expected);
    assert!(!stops.contains(&"f0f0f0f0".to_string()));
    assert_eq!(rig.get(&mine).await.state, RunState::Stopped);
    assert!(rig.svc.index.live().is_empty());
    let sessions = rig.cli.0.lock().unwrap().sessions.clone();
    let foreign = sessions.iter().find(|e| e.id.as_deref() == Some("f0f0f0f0")).unwrap();
    assert_eq!(foreign.state.as_deref(), Some("working"));
}

#[tokio::test]
async fn stop_all_counts_what_it_could_not_stop_and_skips_finished_runs() {
    let rig = ready().await;
    let launching = rig.launched(1).await;
    let (working_run, done_run) = (rig.launched(2).await, rig.launched(3).await);
    rig.session(&working_run, |_| {});
    rig.set(&working_run, |r| r.state = RunState::Working).await;
    rig.set(&done_run, |r| r.state = RunState::Done).await;
    rig.svc.index.record(other_account("other-no-id", "00000000")).unwrap();
    rig.svc.index.record(Entry { short_id: None, ..other_account("other-unlaunched", "00000000") }).unwrap();

    let tally = rig.svc.stop_all().await.unwrap();
    assert_eq!(tally, StopAll { stopped: 2, failed: 2 }, "the launching run and the unlaunched one count as failed");
    assert_eq!(rig.get(&launching).await.state, RunState::Launching);
    assert_eq!(rig.get(&done_run).await.state, RunState::Done);
    assert!(!rig.svc.index.live().iter().any(|e| e.run_id == done_run.id));
}

#[tokio::test]
async fn nothing_stops_when_agents_are_off() {
    let (rig, run) = working().await;
    let off = RunService::new(rig.fx.core.clone(), Arc::new(crate::runs::toolchain::SystemToolchain::default()), crate::runs::index::RunIndex::load(&tmp("off")), vec![], Arc::new(|_| {}));
    assert!(off.stop(&run.id).await.is_err() && off.stop_all().await.is_err() && off.attach(&run.id).await.is_err() && off.disk(&run.id).await.is_err());
}

fn ids() -> (ShortId, PathBuf) {
    (ShortId::parse("1a2b3c4d").unwrap(), PathBuf::from("/opt/fake/bin/claude"))
}

#[test]
fn the_attach_file_is_exactly_three_lines_and_private() {
    let dir = tmp("attach-file");
    let (id, claude) = ids();
    let worktree = Path::new("/Users/me/My Code/webshop/.claude/worktrees/ce-1-fix-cart-0a1b");
    let file = write_attach_file(&dir, &claude, worktree, &id).unwrap();
    assert_eq!(file, dir.join("1a2b3c4d.command"));
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "#!/bin/zsh\ncd '/Users/me/My Code/webshop/.claude/worktrees/ce-1-fix-cart-0a1b'\nexec '/opt/fake/bin/claude' attach 1a2b3c4d\n"
    );
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    write_attach_file(&dir, &claude, worktree, &id).unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_path_that_could_reach_the_shell_is_refused_and_nothing_is_written() {
    let dir = tmp("attach-hostile");
    let (id, claude) = ids();
    for bad in [
        "/work/it's",
        "/work/line\nbreak",
        "/work/carriage\rreturn",
        "/work/nul\0byte",
        "/work/tab\there",
        "relative/path",
        "",
        "/work/'; touch /tmp/pwned; echo '",
        "/work/esc\u{1b}[31m",
    ] {
        let refused = write_attach_file(&dir, &claude, Path::new(bad), &id);
        assert!(refused.is_err(), "{bad:?}");
        let refused = write_attach_file(&dir, Path::new(bad), Path::new("/work/ok"), &id);
        assert!(refused.is_err(), "{bad:?} as the claude path");
    }
    assert!(!dir.join("1a2b3c4d.command").exists());
}

#[test]
fn spaces_dollars_and_backticks_stay_inert_inside_single_quotes() {
    let dir = tmp("attach-inert");
    let (id, claude) = ids();
    let worktree = "/work/with space/$(touch /tmp/pwned)/`id`/${HOME}/a\"b/c\\d";
    let file = write_attach_file(&dir, &claude, Path::new(worktree), &id).unwrap();
    let script = std::fs::read_to_string(&file).unwrap();
    assert_eq!(script.lines().nth(1).unwrap(), format!("cd '{worktree}'"));

    // The shell reads the quoted text back as the same path and runs nothing in it.
    let echoed = std::process::Command::new("/bin/zsh").arg("-c").arg(format!("printf %s '{worktree}'")).output().unwrap();
    assert_eq!(String::from_utf8(echoed.stdout).unwrap(), worktree);
    assert!(!Path::new("/tmp/pwned").exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_session_id_that_is_not_eight_hex_never_gets_a_file() {
    // The type refuses it first; the writer checks again, so a loosened type couldn't let one through.
    for bad in ["../../x", "1A2B3C4D", "1a2b3c4", "1a2b3c4d; ls"] {
        assert!(ShortId::parse(bad).is_none(), "{bad}");
    }
}

#[test]
fn terminal_is_opened_with_the_file_as_its_own_argument() {
    let file = Path::new("/data/attach/1a2b3c4d.command");
    assert_eq!(open_args(file), [OsString::from("-a"), "Terminal".into(), file.as_os_str().to_owned()]);
}

#[tokio::test]
async fn attach_writes_the_file_for_the_stored_run_and_opens_it() {
    let (rig, run) = working().await;
    rig.svc.attach(&run.id).await.unwrap();
    let opened = rig.opened.0.lock().unwrap().clone();
    let expected = rig.fx.core.data_dir().join("attach").join(format!("{}.command", run.short_id.as_ref().unwrap()));
    assert_eq!(opened, std::slice::from_ref(&expected));
    let script = std::fs::read_to_string(&expected).unwrap();
    assert_eq!(script, format!("#!/bin/zsh\ncd '{}'\nexec '/opt/fake/bin/claude' attach {}\n", run.expected_worktree.display(), run.short_id.as_ref().unwrap()));
}

#[tokio::test]
async fn attach_refuses_a_run_without_a_session_or_with_a_hostile_stored_path() {
    let rig = ready().await;
    let queued = rig.queued(1).await;
    assert!(rig.svc.attach(&queued.id).await.unwrap_err().to_string().contains("no session"));
    let run = rig.launched(2).await;
    rig.set(&run, |r| r.expected_worktree = PathBuf::from("/work/it's; rm -rf ~")).await;
    assert!(rig.svc.attach(&run.id).await.is_err());
    assert!(rig.opened.0.lock().unwrap().is_empty());
    assert!(rig.svc.attach("no-such-run").await.is_err());
}

#[test]
fn old_attach_files_are_removed_and_recent_ones_and_other_files_stay() {
    let dir = tmp("attach-clean");
    std::fs::create_dir_all(&dir).unwrap();
    for name in ["old.command", "new.command", "notes.txt"] {
        std::fs::write(dir.join(name), "x").unwrap();
    }
    let long_ago = std::time::SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
    for name in ["old.command", "notes.txt"] {
        std::fs::File::options().write(true).open(dir.join(name)).unwrap().set_modified(long_ago).unwrap();
    }
    clean_attach_dir(&dir, Duration::from_secs(24 * 60 * 60));
    assert!(!dir.join("old.command").exists());
    assert!(dir.join("new.command").exists() && dir.join("notes.txt").exists());
    clean_attach_dir(&dir.join("missing"), Duration::ZERO);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn disk_counts_the_runs_own_job_folder_only() {
    let (rig, run) = working().await;
    let jobs = rig.fx.dir.join("claude-config/jobs");
    let mine = jobs.join(run.short_id.as_ref().unwrap().as_str());
    std::fs::create_dir_all(mine.join("tmp/deep")).unwrap();
    std::fs::write(mine.join("state.json"), vec![0u8; 1_000]).unwrap();
    std::fs::write(mine.join("tmp/deep/big"), vec![0u8; 24_000]).unwrap();
    std::fs::create_dir_all(jobs.join("someone-else")).unwrap();
    std::fs::write(jobs.join("someone-else/huge"), vec![0u8; 500_000]).unwrap();
    std::os::unix::fs::symlink(jobs.join("someone-else"), mine.join("link")).unwrap();
    assert_eq!(rig.svc.disk(&run.id).await.unwrap(), 25_000);
}

#[test]
fn the_disk_count_stops_at_its_time_limit_on_a_large_tree() {
    let dir = tmp("disk-big");
    for d in 0..40 {
        let sub = dir.join(format!("d{d}"));
        std::fs::create_dir_all(&sub).unwrap();
        for f in 0..50 {
            std::fs::write(sub.join(format!("f{f}")), [0u8; 10]).unwrap();
        }
    }
    assert_eq!(size_within(&dir, Duration::from_secs(10)), 20_000);
    let started = std::time::Instant::now();
    let partial = size_within(&dir, Duration::ZERO);
    assert!(partial < 20_000 && started.elapsed() < Duration::from_secs(1));
    assert_eq!(size_within(&dir.join("missing"), Duration::from_secs(1)), 0);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn keep_running_counts_live_runs_of_every_account() {
    let (rig, _run) = working().await;
    rig.svc.index.record(other_account("other-1", "0ddba11e")).unwrap();
    assert_eq!(rig.svc.keep_running(), 2);
    rig.svc.stop_all().await.unwrap();
    assert_eq!(rig.svc.keep_running(), 0);
}
