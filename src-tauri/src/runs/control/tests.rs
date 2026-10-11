use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use super::*;
use crate::domain::RunFailure;
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
async fn stopping_a_workstream_run_is_recorded_in_its_audit_and_a_refused_stop_is_not() {
    let rig = ready().await;
    let (run, ws) = rig.launched_in_workstream(1).await;
    assert!(rig.svc.stop(&run.id).await.is_err(), "still launching");
    assert!(rig.run_actions(&ws).await.is_empty());
    rig.poll().await;
    rig.svc.stop(&run.id).await.unwrap();
    assert_eq!(rig.run_actions(&ws).await, [("run_stopped".to_string(), Some(run.id.clone()), None)]);
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
    assert_eq!(open_args(file, TerminalChoice::Terminal), [OsString::from("-a"), "Terminal".into(), file.as_os_str().to_owned()]);
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

fn home(tag: &str) -> PathBuf {
    let home = tmp(&format!("home-{tag}"));
    std::fs::create_dir_all(&home).unwrap();
    home.canonicalize().unwrap()
}

fn clone_in(home: &Path, name: &str) -> PathBuf {
    let clone = home.join(name);
    std::fs::create_dir_all(clone.join(".git")).unwrap();
    clone.canonicalize().unwrap()
}

#[test]
fn the_trust_and_sign_in_files_are_exactly_three_lines_named_by_a_digest_and_private() {
    let (dir, home) = (tmp("trust-file"), home("file"));
    let clone = clone_in(&home, "My Code");
    let claude = Path::new("/opt/fake/bin/claude");
    let script = format!("#!/bin/zsh\ncd '{}'\nexec '/opt/fake/bin/claude'\n", clone.display());
    for (purpose, prefix) in [(Purpose::Trust, "trust-"), (Purpose::SignIn, "signin-")] {
        let file = write_claude_file(&dir, purpose, claude, &clone, Some(&home)).unwrap();
        let name = file.file_name().unwrap().to_str().unwrap().to_owned();
        let digest = name.strip_prefix(prefix).and_then(|n| n.strip_suffix(".command")).unwrap();
        assert!(digest.len() == 16 && digest.bytes().all(|b| b.is_ascii_hexdigit()), "{name}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), script);
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(write_claude_file(&dir, purpose, claude, &clone, Some(&home)).unwrap(), file, "writing again replaces it");
    }
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn zsh_reads_a_hostile_but_quotable_folder_back_as_the_same_path_and_runs_nothing_in_it() {
    let (dir, home) = (tmp("trust-zsh"), home("zsh"));
    let clone = clone_in(&home, "with space/$(touch pwned)/`id`/${HOME}/a\"b/c\\d/*?[x]");
    let bin = home.join("fake-claude");
    std::fs::write(&bin, "#!/bin/zsh\nprint -rn -- \"$PWD|$#\" > \"$GOSSAMR_OUT\"\n").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    let file = write_claude_file(&dir, Purpose::Trust, &bin, &clone, Some(&home)).unwrap();

    let out = home.join("out.txt");
    let status = std::process::Command::new("/bin/zsh").arg(&file).env("GOSSAMR_OUT", &out).status().unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read_to_string(&out).unwrap(), format!("{}|0", clone.display()), "claude runs in the folder with no arguments");
    assert!(!clone.join("pwned").exists() && !Path::new("pwned").exists());
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn a_folder_that_is_not_a_plain_clone_inside_home_gets_no_file() {
    let (dir, home) = (tmp("trust-refuse"), home("refuse"));
    let outside = tmp("trust-outside");
    std::fs::create_dir_all(outside.join("repo/.git")).unwrap();
    let outside = outside.canonicalize().unwrap().join("repo");
    let real = clone_in(&home, "real");
    std::os::unix::fs::symlink(&real, home.join("link")).unwrap();
    std::fs::create_dir_all(home.join("plain")).unwrap();
    let quoted = clone_in(&home, "it's");
    let newline = clone_in(&home, "line\nbreak");
    let escape = clone_in(&home, "esc\u{1b}[31m");
    let claude = Path::new("/opt/fake/bin/claude");
    let cases: [(&Path, &str); 9] = [
        (&quoted, "a single quote"),
        (&newline, "a newline"),
        (&escape, "a control character"),
        (&outside, "outside home"),
        (&home, "home itself"),
        (&home.join("link"), "a symlink"),
        (&home.join("plain"), "not a clone"),
        (&home.join("missing"), "missing"),
        (Path::new("relative/path"), "relative"),
    ];
    for (folder, why) in cases {
        assert!(write_claude_file(&dir, Purpose::Trust, claude, folder, Some(&home)).is_err(), "{why}");
    }
    assert!(write_claude_file(&dir, Purpose::Trust, claude, &real, None).is_err(), "no home to compare with");
    assert!(write_claude_file(&dir, Purpose::Trust, Path::new("/opt/it's/claude"), &real, Some(&home)).is_err(), "a hostile claude path");
    assert!(!dir.exists() || std::fs::read_dir(&dir).unwrap().next().is_none(), "nothing was written");
    let _ = std::fs::remove_dir_all(outside.parent().unwrap());
    let _ = std::fs::remove_dir_all(home);
}

async fn untrusted() -> (Rig, Run) {
    let rig = ready().await;
    rig.cli.with(|s| s.outcome = crate::runs::testing::Outcome::Untrusted);
    let run = rig.queued(1).await;
    rig.svc.start_now(&run.id).await.unwrap();
    let run = rig.get(&run).await;
    assert_eq!((run.state, run.failure.clone()), (RunState::Failed, Some(RunFailure::UntrustedFolder { path: rig.clone.clone() })));
    (rig, run)
}

fn nothing_opened(rig: &Rig) {
    assert!(rig.opened.0.lock().unwrap().is_empty());
    assert!(!rig.fx.core.data_dir().join("attach").exists() || std::fs::read_dir(rig.fx.core.data_dir().join("attach")).unwrap().next().is_none());
}

#[tokio::test]
async fn trusting_a_folder_opens_terminal_in_the_clone_of_the_stored_run_with_plain_claude() {
    let (rig, run) = untrusted().await;
    rig.svc.open_claude(&run.id, Purpose::Trust).await.unwrap();
    let opened = rig.opened.0.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    assert!(opened[0].starts_with(rig.fx.core.data_dir().join("attach")));
    assert_eq!(std::fs::read_to_string(&opened[0]).unwrap(), format!("#!/bin/zsh\ncd '{}'\nexec '/opt/fake/bin/claude'\n", rig.clone.display()));
    assert_eq!(rig.get(&run).await, run, "opening Terminal changes nothing about the run");
    assert!(rig.svc.open_claude(&run.id, Purpose::SignIn).await.is_err(), "this run isn't about signing in");
}

#[tokio::test]
async fn trusting_is_refused_unless_the_run_failed_because_the_folder_is_untrusted() {
    let rig = ready().await;
    let untrusted = RunFailure::UntrustedFolder { path: rig.clone.clone() };
    let mut n = 0;
    let mut run_in = |state: RunState, failure: Option<RunFailure>| {
        n += 1;
        (rig.queued(n), state, failure)
    };
    let cases = [
        run_in(RunState::Queued, Some(untrusted.clone())),
        run_in(RunState::Launching, Some(untrusted.clone())),
        run_in(RunState::Working, Some(untrusted.clone())),
        run_in(RunState::Done, Some(untrusted.clone())),
        run_in(RunState::Stopped, Some(untrusted.clone())),
        run_in(RunState::Failed, None),
        run_in(RunState::Failed, Some(RunFailure::Other)),
        run_in(RunState::Failed, Some(RunFailure::NotSignedIn)),
        run_in(RunState::Failed, Some(RunFailure::ClaudeMissing)),
        run_in(RunState::Failed, Some(RunFailure::NoClone)),
        run_in(RunState::Failed, Some(RunFailure::CapReached)),
    ];
    for (run, state, failure) in cases {
        let run = rig.set(&run.await, |r| {
            r.state = state;
            r.failure = failure.clone();
        }).await;
        assert!(rig.svc.open_claude(&run.id, Purpose::Trust).await.is_err(), "{state:?} {failure:?}");
        let may_sign_in = state == RunState::Failed && failure == Some(RunFailure::NotSignedIn);
        assert_eq!(rig.svc.open_claude(&run.id, Purpose::SignIn).await.is_ok(), may_sign_in, "{state:?} {failure:?}");
    }
    assert!(rig.svc.open_claude("no-such-run", Purpose::Trust).await.is_err());
    assert_eq!(rig.opened.0.lock().unwrap().len(), 1, "only the one sign-in for a run that needs it");
}

#[tokio::test]
async fn the_folder_comes_from_the_stored_spec_and_a_hostile_one_is_refused() {
    let (rig, run) = untrusted().await;
    let home = rig.fx.home.canonicalize().unwrap();
    let outside = tmp("trust-svc-outside");
    std::fs::create_dir_all(outside.join(".git")).unwrap();
    let link = home.join("link");
    std::os::unix::fs::symlink(&rig.clone, &link).unwrap();
    std::fs::create_dir_all(home.join("not-a-clone")).unwrap();
    let quoted = clone_in(&home, "it's; rm -rf ~");
    for bad in [outside.canonicalize().unwrap(), link, home.join("not-a-clone"), quoted, home.join("gone"), PathBuf::from("relative")] {
        rig.set(&run, |r| r.spec.clone_path = bad.clone()).await;
        let refused = rig.svc.open_claude(&run.id, Purpose::Trust).await;
        assert!(refused.is_err(), "{}", bad.display());
    }
    nothing_opened(&rig);
    let _ = std::fs::remove_dir_all(outside);
}

#[tokio::test]
async fn a_folder_can_be_trusted_before_any_run_when_it_is_where_clones_live() {
    let rig = ready().await;
    rig.svc.trust_folder(&rig.clone).await.unwrap();
    let opened = rig.opened.0.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    assert_eq!(std::fs::read_to_string(&opened[0]).unwrap(), format!("#!/bin/zsh\ncd '{}'\nexec '/opt/fake/bin/claude'\n", rig.clone.display()));
    assert!(opened[0].file_name().unwrap().to_string_lossy().starts_with("trust-"));
}

#[tokio::test]
async fn trusting_a_folder_by_path_refuses_what_is_not_a_clone_in_a_known_place() {
    let rig = ready().await;
    let home = rig.fx.home.canonicalize().unwrap();
    let outside = tmp("trust-path-outside");
    std::fs::create_dir_all(outside.join(".git")).unwrap();
    std::fs::create_dir_all(home.join("not-a-clone")).unwrap();
    for folder in [outside.canonicalize().unwrap(), home.join("not-a-clone"), home.join("gone"), PathBuf::from("relative")] {
        assert!(rig.svc.trust_folder(&folder).await.is_err(), "{}", folder.display());
    }
    nothing_opened(&rig);
    let _ = std::fs::remove_dir_all(outside);
}

#[tokio::test]
async fn nothing_opens_when_agents_are_off() {
    let (rig, run) = untrusted().await;
    let off = RunService::new(rig.fx.core.clone(), Arc::new(crate::runs::toolchain::SystemToolchain::default()), crate::runs::index::RunIndex::load(&tmp("off-trust")), vec![], Arc::new(|_| {}));
    assert!(off.open_claude(&run.id, Purpose::Trust).await.is_err());
}

#[test]
fn iterm_is_opened_the_same_way_with_its_own_name() {
    let file = Path::new("/data/attach/1a2b3c4d.command");
    assert_eq!(open_args(file, TerminalChoice::ITerm), [OsString::from("-a"), "iTerm".into(), file.as_os_str().to_owned()]);
}

#[tokio::test]
async fn attach_opens_the_terminal_the_person_chose() {
    let (rig, run) = working().await;
    rig.svc.attach(&run.id).await.unwrap();
    rig.svc.set_settings(crate::config::AgentSettings { terminal: TerminalChoice::ITerm, ..Default::default() }).unwrap();
    rig.svc.attach(&run.id).await.unwrap();
    assert_eq!(*rig.opened.1.lock().unwrap(), [TerminalChoice::Terminal, TerminalChoice::ITerm]);
}
