use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;

use super::*;
use crate::domain::fixtures::run_spec;
use crate::domain::RunFailure;
use crate::inbox::testing::{fixture_watching, Fixture};
use crate::runs::cli::{ClaudeCli, SystemCli};
use crate::runs::env::RunEnv;
use crate::runs::repo::testing::{clone_with_origin, install_fake_git};
use crate::runs::testing::{FakeCli, Outcome};
use crate::runs::toolchain::{FixedToolchain, ToolchainError};

const FAST: Timing = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(20), rm_wait: Duration::from_millis(5) };
const ORIGIN: &str = "https://github.com/acme/webshop.git";

struct Rig {
    fx: Fixture,
    svc: Arc<RunService>,
    cli: Arc<FakeCli>,
    clone: PathBuf,
    changes: Arc<Mutex<Vec<String>>>,
}

fn fake_env(dir: &Path) -> Arc<RunEnv> {
    let bin = install_fake_git(dir);
    Arc::new(RunEnv::from_pairs([("PATH", format!("{}:/usr/bin:/bin", bin.display()))]))
}

async fn build(tools: Option<ToolchainError>, tune: impl FnOnce(RunService) -> RunService) -> Rig {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let clone = fx.home.join("webshop");
    clone_with_origin(&clone, ORIGIN);
    let cli = Arc::new(FakeCli::new());
    cli.with(|s| s.config_dir = fx.dir.join("claude-config"));
    let tools = match tools {
        Some(e) => FixedToolchain(Err(e)),
        None => FixedToolchain(Ok(Toolchain { cli: cli.clone(), env: fake_env(&fx.dir) })),
    };
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    let svc = RunService::new(
        fx.core.clone(),
        Arc::new(tools),
        RunIndex::load(&fx.dir.join("index")),
        vec![fx.home.clone()],
        Arc::new(move |id| seen.lock().unwrap().push(id.to_string())),
    )
    .enabled(true)
    .with_timing(FAST);
    Rig { svc: Arc::new(tune(svc)), fx, cli, clone, changes }
}

async fn ready() -> Rig {
    build(None, |s| s).await
}

impl Rig {
    fn spec(&self, n: u32) -> RunSpec {
        RunSpec { clone_path: self.clone.clone(), name: format!("eng-1-fix-cart-{n:04x}"), ..run_spec() }
    }

    async fn queued(&self, n: u32) -> Run {
        let p = self.fx.core.draft_run(self.spec(n), Some(self.fx.item("CA-1"))).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        self.fx.core.runs_approve(&p.id, &digest).await.unwrap()
    }

    async fn get(&self, run: &Run) -> Run {
        self.fx.core.run(&run.id).await.unwrap().unwrap()
    }

    async fn set(&self, run: &Run, f: impl FnOnce(&mut Run)) -> Run {
        let mut run = self.get(run).await;
        f(&mut run);
        self.fx.core.save_run(&run).await.unwrap();
        run
    }

    fn live(&self) -> Vec<String> {
        self.svc.index.live().into_iter().map(|e| e.run_id).collect()
    }
}

#[tokio::test]
async fn a_queued_run_launches_into_its_worktree_with_the_prompt_the_person_approved() {
    let rig = ready().await;
    let queued = rig.queued(1).await;
    rig.svc.launch(&queued.id).await.unwrap();

    let run = rig.get(&queued).await;
    assert_eq!(run.state, RunState::Launching);
    assert_eq!(run.short_id.as_ref().map(ShortId::as_str), Some("b0000001"));
    assert!(run.launched_at.is_some() && run.error.is_none());
    let (req, count) = {
        let s = rig.cli.0.lock().unwrap();
        (s.launches[0].clone(), s.launches.len())
    };
    assert_eq!(count, 1);
    assert_eq!(req.cwd, rig.clone);
    assert_eq!((req.name.as_str(), req.worktree.as_str()), ("CA-1 investigate", "eng-1-fix-cart-0001"));
    assert_eq!(req.guard, GUARD);
    assert_eq!(req.prompt, render_prompt(&run.spec));
    assert!(req.prompt.starts_with("Your worktree starts at the clone's current HEAD"));
    assert_eq!(run.expected_worktree, rig.clone.join(".claude/worktrees/eng-1-fix-cart-0001"));

    let [entry] = rig.svc.index.live().try_into().unwrap();
    assert_eq!((entry.run_id, entry.short_id, entry.expected_worktree), (run.id.clone(), run.short_id.clone(), run.expected_worktree));
    assert!(rig.changes.lock().unwrap().iter().all(|c| *c == run.connection_id) && !rig.changes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn launching_twice_starts_one_session() {
    let rig = ready().await;
    let queued = rig.queued(1).await;
    let (a, b) = tokio::join!(rig.svc.launch(&queued.id), rig.svc.launch(&queued.id));
    a.unwrap();
    b.unwrap();
    rig.svc.launch(&queued.id).await.unwrap();
    assert_eq!(rig.cli.launches(), 1);
    assert!(rig.svc.start_now(&queued.id).await.is_err(), "no longer queued");
}

#[tokio::test]
async fn launches_are_serialised_and_the_cap_is_held_under_the_lock() {
    let rig = build(None, |s| s.with_cap(1)).await;
    rig.cli.with(|s| s.delay = Duration::from_millis(60));
    let (a, b) = (rig.queued(1).await, rig.queued(2).await);
    let (ra, rb) = tokio::join!(rig.svc.launch(&a.id), rig.svc.launch(&b.id));
    ra.unwrap();
    rb.unwrap();
    let states: Vec<RunState> = vec![rig.get(&a).await.state, rig.get(&b).await.state];
    assert_eq!(states.iter().filter(|s| **s == RunState::Launching).count(), 1, "{states:?}");
    let failed = if states[0] == RunState::Failed { &a } else { &b };
    assert!(rig.get(failed).await.error.unwrap().contains("1 agents are already running"));
    assert_eq!(rig.cli.launches(), 1);
    assert_eq!(rig.live().len(), 1);
}

#[tokio::test]
async fn two_launches_never_overlap_in_the_cli() {
    let rig = ready().await;
    rig.cli.with(|s| s.delay = Duration::from_millis(40));
    let (a, b) = (rig.queued(1).await, rig.queued(2).await);
    let (ra, rb) = tokio::join!(rig.svc.launch(&a.id), rig.svc.launch(&b.id));
    ra.unwrap();
    rb.unwrap();
    assert_eq!(rig.cli.0.lock().unwrap().most_in_flight, 1);
    assert_eq!(rig.live().len(), 2);
}

#[tokio::test]
async fn the_cap_counts_runs_of_other_accounts_through_the_index() {
    let rig = build(None, |s| s.with_cap(2)).await;
    for n in 0..2 {
        let other = Entry { db_file: "inbox-other.sqlite".into(), run_id: format!("other-{n}"), expected_worktree: "/x".into(), short_id: None, terminal: false };
        rig.svc.index.record(other).unwrap();
    }
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    let capped = rig.get(&run).await;
    assert!(capped.error.unwrap().contains("2 agents are already running"));
    assert_eq!(capped.failure, Some(RunFailure::CapReached));
    rig.svc.index.mark_terminal("other-0").unwrap();
    assert_eq!(rig.svc.retry_launch(&run.id).await.unwrap().state, RunState::Launching);
}

async fn assert_fails_without_launching(rig: &Rig, run: &Run, text: &str, kind: RunFailure) -> Run {
    rig.svc.launch(&run.id).await.unwrap();
    let after = rig.get(run).await;
    assert_eq!(after.state, RunState::Failed);
    assert_eq!(after.failure, Some(kind), "{text}");
    assert!(after.error.as_deref().unwrap().contains(text), "{:?}", after.error);
    assert!(after.ended_at.is_some() && after.short_id.is_none());
    assert_eq!(rig.cli.launches(), 0);
    assert!(rig.live().is_empty());
    after
}

#[tokio::test]
async fn problems_found_before_launching_fail_the_run_with_the_reason_and_start_nothing() {
    let rig = ready().await;
    rig.cli.with(|s| s.logged_in = false);
    let run = rig.queued(1).await;
    assert_fails_without_launching(&rig, &run, "isn't signed in", RunFailure::NotSignedIn).await;

    let rig = rig_with(|c| c.with(|s| s.bg = false)).await;
    let run = rig.queued(1).await;
    assert_fails_without_launching(&rig, &run, "too old", RunFailure::Other).await;

    let rig = rig_with(|_| {}).await;
    let run = rig.queued(1).await;
    std::fs::write(rig.clone.join(".fake-origin"), "https://github.com/acme/other.git").unwrap();
    assert_fails_without_launching(&rig, &run, "isn't a clone of acme/webshop", RunFailure::NoClone).await;

    let rig = rig_with(|_| {}).await;
    let run = rig.queued(1).await;
    std::fs::remove_file(rig.clone.join(".fake-origin")).unwrap();
    assert_fails_without_launching(&rig, &run, "couldn't read the origin", RunFailure::NoClone).await;

    let rig = rig_with(|_| {}).await;
    let run = rig.queued(1).await;
    std::fs::remove_dir_all(&rig.clone).unwrap();
    assert_fails_without_launching(&rig, &run, "isn't a git clone any more", RunFailure::NoClone).await;

    let rig = rig_with(|_| {}).await;
    let run = rig.queued(1).await;
    let moved = rig.fx.home.join("moved");
    std::fs::rename(&rig.clone, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &rig.clone).unwrap();
    assert_fails_without_launching(&rig, &run, "isn't its real path", RunFailure::NoClone).await;

    let rig = rig_with(|_| {}).await;
    let run = rig.queued(1).await;
    rig.set(&run, |r| r.spec.base = "--upload-pack=evil".into()).await;
    assert_fails_without_launching(&rig, &run, "base branch name isn't valid", RunFailure::Other).await;
}

async fn rig_with(f: impl FnOnce(&FakeCli)) -> Rig {
    let rig = ready().await;
    f(&rig.cli);
    rig
}

#[tokio::test]
async fn no_claude_and_no_shell_environment_fail_the_run_and_nothing_starts() {
    let rig = build(Some(ToolchainError::ClaudeMissing), |s| s).await;
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.error.unwrap()), (RunState::Failed, Failure::ClaudeMissing.to_string()));
    assert_eq!(after.failure, Some(RunFailure::ClaudeMissing));

    let why = "Couldn't read your shell environment: your shell took too long to start.";
    let rig = build(Some(ToolchainError::NoEnvironment(why.into())), |s| s).await;
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    let after = rig.get(&run).await;
    assert_eq!((after.error.as_deref(), after.failure), (Some(why), Some(RunFailure::Other)));
}

#[tokio::test]
async fn an_untrusted_folder_a_failed_command_and_garbled_output_each_fail_with_their_own_reason() {
    for (outcome, text) in [(Outcome::Untrusted, "doesn't trust"), (Outcome::Exits, "Claude couldn't start the agent: something broke"), (Outcome::Garbled, "wasn't recognised")] {
        let rig = ready().await;
        rig.cli.with(|s| s.outcome = outcome);
        let run = rig.queued(1).await;
        rig.svc.launch(&run.id).await.unwrap();
        let after = rig.get(&run).await;
        assert_eq!(after.state, RunState::Failed, "{outcome:?}");
        let error = after.error.unwrap();
        assert!(error.contains(text), "{error}");
        let kind = if outcome == Outcome::Untrusted { RunFailure::UntrustedFolder { path: rig.clone.clone() } } else { RunFailure::Other };
        assert_eq!(after.failure, Some(kind), "{outcome:?}");
        if outcome == Outcome::Untrusted {
            assert!(error.contains(&rig.clone.display().to_string()));
        }
        assert!(after.launched_at.is_some() && after.short_id.is_none());
        assert!(rig.live().is_empty(), "a failed run no longer counts toward the cap");
    }
}

#[tokio::test]
async fn nothing_launches_when_agents_are_off() {
    let rig = build(None, |s| s.enabled(false)).await;
    let run = rig.queued(1).await;
    assert!(rig.svc.launch(&run.id).await.is_err());
    assert!(rig.svc.start_now(&run.id).await.is_err());
    assert!(rig.svc.retry_launch(&run.id).await.is_err());
    assert!(rig.svc.preflight(None).await.is_err());
    assert!(rig.svc.clones("acme/webshop").await.is_err());
    assert!(rig.svc.repos().is_err());
    assert_eq!(rig.get(&run).await.state, RunState::Queued);
    assert_eq!(rig.cli.launches(), 0);
}

#[tokio::test]
async fn retry_after_a_failed_command_launches_again() {
    let rig = ready().await;
    rig.cli.with(|s| s.outcome = Outcome::Exits);
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    rig.cli.with(|s| s.outcome = Outcome::Starts);
    let again = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!((again.state, again.error.is_none()), (RunState::Launching, true));
    assert_eq!(rig.cli.launches(), 2);
    assert_eq!(rig.live(), vec![run.id.clone()]);
}

#[tokio::test]
async fn retry_after_the_folder_is_trusted_launches_a_run_that_never_had_a_session_and_clears_the_failure() {
    let rig = ready().await;
    rig.cli.with(|s| s.outcome = Outcome::Untrusted);
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    let failed = rig.get(&run).await;
    assert!(failed.short_id.is_none() && failed.failure.is_some() && failed.ended_at.is_some());
    let still = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!((still.state, still.failure), (RunState::Failed, Some(RunFailure::UntrustedFolder { path: rig.clone.clone() })), "not trusted yet: it fails the same way");

    rig.cli.with(|s| s.outcome = Outcome::Starts);
    let again = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!((again.state, again.error, again.failure, again.ended_at), (RunState::Launching, None, None, None));
    assert!(again.short_id.is_some());
    assert_eq!(rig.get(&run).await.failure, None);
    assert_eq!(rig.live(), vec![run.id.clone()]);
}

#[tokio::test]
async fn a_run_failed_before_failures_were_typed_gets_its_kind_from_its_message_when_read() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    let message = Failure::NeedsTrust { folder: rig.clone.clone() }.to_string();
    rig.set(&run, |r| {
        r.state = RunState::Failed;
        r.error = Some(message.clone());
    })
    .await;
    assert_eq!(rig.get(&run).await.failure, Some(RunFailure::UntrustedFolder { path: rig.clone.clone() }));
    let listed = rig.fx.core.runs_list(&RunQuery::default()).await.unwrap();
    assert_eq!(listed[0].failure, Some(RunFailure::UntrustedFolder { path: rig.clone.clone() }));
}

#[tokio::test]
async fn retry_adopts_the_session_a_garbled_launch_left_instead_of_starting_another() {
    let rig = ready().await;
    rig.cli.with(|s| s.outcome = Outcome::Garbled);
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    assert_eq!(rig.get(&run).await.state, RunState::Failed);

    let adopted = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!(adopted.state, RunState::Launching);
    assert_eq!(adopted.short_id.as_ref().map(ShortId::as_str), Some("b0000001"));
    assert!(adopted.session_id.as_deref().unwrap().starts_with("b0000001"));
    assert!(adopted.error.is_none() && adopted.ended_at.is_none());
    assert_eq!(rig.cli.launches(), 1);
    assert_eq!(rig.live(), vec![run.id.clone()]);
}

#[tokio::test]
async fn retry_waits_for_a_session_still_listed_at_the_clone_root() {
    let rig = ready().await;
    rig.cli.with(|s| {
        s.outcome = Outcome::Garbled;
        s.lag = true;
    });
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    let (adopted, ()) = tokio::join!(rig.svc.retry_launch(&run.id), async {
        tokio::time::sleep(Duration::from_millis(80)).await;
        rig.cli.settle();
    });
    assert_eq!(adopted.unwrap().short_id.as_ref().map(ShortId::as_str), Some("b0000001"));
    assert_eq!(rig.cli.launches(), 1, "no second session");
    assert!(rig.cli.0.lock().unwrap().listings > 2);
}

#[tokio::test]
async fn retry_does_not_launch_when_the_sessions_cannot_be_listed() {
    let rig = ready().await;
    rig.cli.with(|s| s.outcome = Outcome::Exits);
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    rig.cli.with(|s| {
        s.outcome = Outcome::Starts;
        s.list_fails = true;
    });
    let after = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!(after.state, RunState::Failed);
    assert!(after.error.unwrap().contains("daemon unavailable"));
    assert_eq!(rig.cli.launches(), 1);
}

#[tokio::test]
async fn a_launch_that_never_started_can_be_retried_once_the_cause_is_fixed() {
    let rig = ready().await;
    rig.cli.with(|s| s.logged_in = false);
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    rig.cli.with(|s| s.logged_in = true);
    let started = std::time::Instant::now();
    assert_eq!(rig.svc.retry_launch(&run.id).await.unwrap().state, RunState::Launching);
    assert!(started.elapsed() < FAST.worktree_grace, "nothing was launched before, so there is no session to wait for");
}

#[tokio::test]
async fn only_a_failed_run_without_a_session_can_be_retried() {
    let rig = ready().await;
    let queued = rig.queued(1).await;
    assert!(rig.svc.retry_launch(&queued.id).await.is_err());
    rig.svc.launch(&queued.id).await.unwrap();
    assert!(rig.svc.retry_launch(&queued.id).await.is_err(), "launching");
    rig.set(&queued, |r| r.state = RunState::Failed).await;
    assert!(rig.svc.retry_launch(&queued.id).await.is_err(), "it has a session");
    assert!(rig.svc.retry_launch("nope").await.is_err());
    assert_eq!(rig.cli.launches(), 1);
}

#[tokio::test]
async fn start_now_starts_a_queued_run_and_refuses_the_others() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    assert_eq!(rig.svc.start_now(&run.id).await.unwrap().state, RunState::Launching);
    assert!(rig.svc.start_now(&run.id).await.is_err());
}

#[tokio::test]
async fn recovery_leaves_queued_runs_queued_and_adopts_a_launching_run_by_its_worktree() {
    let rig = ready().await;
    let waiting = rig.queued(1).await;
    let launching = rig.queued(2).await;
    let launching = rig.set(&launching, |r| {
        r.state = RunState::Launching;
        r.launched_at = Some(Utc::now());
    })
    .await;
    rig.cli.with(|s| {
        s.sessions.push(FakeCli::session("0c0ffee1", &launching.expected_worktree));
        s.sessions.push(FakeCli::session("0c0ffee2", &rig.clone));
    });
    rig.svc.recover().await;
    assert_eq!(rig.get(&waiting).await.state, RunState::Queued);
    let adopted = rig.get(&launching).await;
    assert_eq!((adopted.state, adopted.short_id.as_ref().map(ShortId::as_str)), (RunState::Launching, Some("0c0ffee1")));
    assert_eq!(rig.live(), vec![launching.id.clone()]);
    assert_eq!(rig.cli.launches(), 0, "recovery never starts anything");
}

#[tokio::test]
async fn recovery_waits_for_a_session_still_at_the_clone_root() {
    let rig = ready().await;
    rig.cli.with(|s| s.lag = true);
    let run = rig.queued(1).await;
    rig.svc.launch(&run.id).await.unwrap();
    rig.set(&run, |r| r.short_id = None).await;
    let ((), ()) = tokio::join!(rig.svc.recover(), async {
        tokio::time::sleep(Duration::from_millis(80)).await;
        rig.cli.settle();
    });
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.short_id.as_ref().map(ShortId::as_str)), (RunState::Launching, Some("b0000001")));
    assert_eq!(rig.cli.launches(), 1);
}

#[tokio::test]
async fn a_launching_run_with_no_session_after_the_window_fails_as_interrupted() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    rig.set(&run, |r| {
        r.state = RunState::Launching;
        r.launched_at = Some(Utc::now());
    })
    .await;
    rig.svc.index.record(entry_of(&rig.get(&run).await)).unwrap();
    let started = std::time::Instant::now();
    rig.svc.recover().await;
    assert!(started.elapsed() >= FAST.recover_window);
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.error.as_deref()), (RunState::Failed, Some("Launch was interrupted")));
    assert!(rig.live().is_empty());
    assert_eq!(rig.cli.launches(), 0);
    let retried = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!(retried.state, RunState::Launching, "the person can retry, which looks first");
}

#[tokio::test]
async fn overlapping_recovery_passes_act_on_a_run_once() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    rig.set(&run, |r| {
        r.state = RunState::Launching;
        r.launched_at = Some(Utc::now());
    })
    .await;
    let started = std::time::Instant::now();
    tokio::join!(rig.svc.recover(), rig.svc.recover(), rig.svc.recover());
    assert!(started.elapsed() < FAST.recover_window * 2, "the later passes find nothing left to do");
    assert_eq!(rig.get(&run).await.error.as_deref(), Some("Launch was interrupted"));
    assert_eq!(rig.changes.lock().unwrap().len(), 1, "the run was written once");
    assert_eq!(rig.cli.launches(), 0);
}

#[tokio::test]
async fn recovery_puts_live_runs_back_into_a_lost_index() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    rig.cli.with(|s| s.sessions.push(FakeCli::session("0c0ffee1", &run.expected_worktree)));
    rig.set(&run, |r| {
        r.state = RunState::Working;
        r.short_id = ShortId::parse("0c0ffee1");
    })
    .await;
    assert!(rig.live().is_empty());
    rig.svc.recover().await;
    assert_eq!(rig.live(), vec![run.id.clone()]);
}

#[tokio::test]
async fn recovery_does_not_touch_a_run_that_is_being_launched() {
    let rig = ready().await;
    rig.cli.with(|s| s.delay = Duration::from_millis(150));
    let run = rig.queued(1).await;
    let svc = rig.svc.clone();
    let id = run.id.clone();
    let launch = tokio::spawn(async move { svc.launch(&id).await });
    tokio::time::sleep(Duration::from_millis(40)).await;
    rig.svc.recover().await;
    launch.await.unwrap().unwrap();
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.short_id.is_some()), (RunState::Launching, true));
    assert_eq!(rig.cli.launches(), 1);
}

#[test]
fn a_session_belongs_to_a_run_by_worktree_path_or_short_id_and_never_by_name_or_an_interactive_session() {
    let base = std::env::temp_dir().join(format!("gossamr-belongs-{}", std::process::id()));
    let real_dir = base.join("real/clone/.claude/worktrees/w");
    std::fs::create_dir_all(&real_dir).unwrap();
    let link = base.join("link");
    std::os::unix::fs::symlink(base.join("real"), &link).unwrap();

    let mut run = Run::queued("r".into(), "p".into(), "c".into(), None, RunSpec { clone_path: link.join("clone"), name: "w".into(), ..run_spec() }, "f".into(), Utc::now());
    let listed = |id: &str, cwd: &Path| FakeCli::session(id, cwd);
    assert!(belongs_to(&listed("0a0a0a0a", &real_dir), &run), "the listed path is the real one, the expected one goes through a link");
    assert!(belongs_to(&listed("0a0a0a0a", &link.join("clone/.claude/worktrees/w")), &run));
    assert!(!belongs_to(&listed("0a0a0a0a", &base.join("real/clone")), &run), "the clone root is not the worktree");
    assert!(!belongs_to(&listed("0a0a0a0a", &base.join("real/clone/.claude/worktrees/other")), &run));
    let mut named = listed("0a0a0a0a", &base);
    named.name = Some("anything".into());
    assert!(!belongs_to(&named, &run));
    let interactive = AgentEntry { kind: Some("interactive".into()), ..listed("0a0a0a0a", &real_dir) };
    assert!(!belongs_to(&interactive, &run));
    assert!(!belongs_to(&AgentEntry { id: None, ..listed("0a0a0a0a", &real_dir) }, &run));
    assert!(!belongs_to(&AgentEntry { id: Some("../../x".into()), ..listed("0a0a0a0a", &real_dir) }, &run));

    run.short_id = ShortId::parse("0b0b0b0b");
    assert!(belongs_to(&listed("0b0b0b0b", &base), &run));
    let _ = std::fs::remove_dir_all(base);
}

fn second_clone(rig: &Rig) -> PathBuf {
    let other = rig.fx.home.join("webshop-copy");
    clone_with_origin(&other, "git@github.com:acme/webshop.git");
    other
}

#[tokio::test]
async fn clones_of_a_watched_repository_are_found_and_the_chosen_one_comes_first() {
    let rig = ready().await;
    let [only] = rig.svc.clones("acme/webshop").await.unwrap().clones.try_into().unwrap();
    assert_eq!(only.path, rig.clone);
    let other = second_clone(&rig);
    rig.svc.clones.clear();
    let before = rig.svc.clones("Acme/WebShop").await.unwrap();
    assert_eq!((before.clones.len(), before.picked), (2, None));

    rig.svc.pick_clone("acme/webshop", &other).await.unwrap();
    let after = rig.svc.clones("acme/webshop").await.unwrap();
    assert_eq!(after.picked.as_ref(), Some(&other));
    assert_eq!(after.clones[0].path, other);
    let config = AppConfig::load(&rig.fx.core.data_dir());
    assert_eq!(config.picked_clones.get("acme/webshop"), Some(&other));
    assert_eq!(config.agent_provider, AppConfig::default().agent_provider);

    std::fs::remove_dir_all(&other).unwrap();
    rig.svc.clones.clear();
    assert_eq!(rig.svc.clones("acme/webshop").await.unwrap().picked, None, "a choice that is no longer a clone is ignored");
}

#[tokio::test]
async fn the_repositories_to_run_in_are_the_watched_ones() {
    let rig = ready().await;
    assert_eq!(rig.svc.repos().unwrap(), ["acme/webshop"]);
}

#[tokio::test]
async fn only_a_clone_that_was_found_can_be_picked_and_only_for_a_watched_repository() {
    let rig = ready().await;
    let stranger = rig.fx.home.join("not-a-clone");
    std::fs::create_dir_all(&stranger).unwrap();
    assert!(rig.svc.pick_clone("acme/webshop", &stranger).await.is_err());
    assert!(rig.svc.pick_clone("acme/webshop", &rig.fx.home.join("missing")).await.is_err());
    let elsewhere = rig.fx.dir.join("outside");
    clone_with_origin(&elsewhere, ORIGIN);
    assert!(rig.svc.pick_clone("acme/webshop", &elsewhere).await.is_err(), "outside the scanned folders");
    assert!(rig.svc.clones("acme/unwatched").await.is_err());
    assert!(AppConfig::load(&rig.fx.core.data_dir()).picked_clones.is_empty());
}

#[tokio::test]
async fn a_suggested_name_avoids_worktrees_and_leftover_branches() {
    let rig = ready().await;
    std::fs::write(rig.clone.join(".fake-branches"), "worktree-eng-1-fix-cart-0001\n").unwrap();
    let name = rig.svc.suggest_name(&rig.clone, "ENG-1", "Fix cart", ).await.unwrap();
    assert!(name.starts_with("eng-1-fix-cart-") && name != "eng-1-fix-cart-0001", "{name}");
    assert!(rig.svc.suggest_name(Path::new("relative"), "K", "t").await.is_err());
    assert!(rig.svc.suggest_name(&rig.fx.home.join("missing"), "K", "t").await.is_err());
}

#[tokio::test]
async fn the_draft_must_be_in_a_watched_repository() {
    let rig = ready().await;
    let spec = RunSpec { repo: "acme/unwatched".into(), ..rig.spec(1) };
    let err = rig.fx.core.draft_run(spec, None).await.unwrap_err();
    assert!(err.to_string().contains("isn't a repository you watch"), "{err}");
    let spec = RunSpec { repo: "ACME/WebShop".into(), ..rig.spec(2) };
    assert!(rig.fx.core.draft_run(spec, None).await.is_ok(), "GitHub names ignore case");
}

#[tokio::test]
async fn approval_refuses_a_repository_that_is_no_longer_watched() {
    let rig = ready().await;
    let draft = rig.fx.core.draft_run(rig.spec(1), None).await.unwrap();
    let digest = rig.fx.core.runs_review(&draft.id).await.unwrap().digest;
    let connection = rig.fx.core.watched_code_repos().unwrap()[0].0.clone();
    let off = crate::domain::WatchMode::Selected;
    rig.fx.core.watch_set_mode(&connection, off).await.unwrap();
    let err = rig.fx.core.runs_approve(&draft.id, &digest).await.unwrap_err();
    assert!(err.to_string().contains("isn't a repository you watch"), "{err}");
    assert!(rig.fx.core.runs_list(&Default::default()).await.unwrap().is_empty());
}

mod preflight_rows {
    use super::*;
    use crate::runs::preflight::Level;

    async fn rows(rig: &Rig, spec: Option<RunSpec>) -> Preflight {
        rig.svc.preflight(spec).await.unwrap()
    }

    fn has(p: &Preflight, level: Level, text: &str) -> bool {
        p.rows.iter().any(|r| r.level == level && r.text.contains(text))
    }

    #[tokio::test]
    async fn a_ready_machine_is_all_green_and_reads_the_permission_mode_without_writing() {
        let rig = ready().await;
        let config = rig.fx.dir.join("claude-config");
        std::fs::create_dir_all(&config).unwrap();
        let settings = config.join("settings.json");
        std::fs::write(&settings, r#"{"permissions":{"defaultMode":"auto"},"env":{"TOKEN":"never shown"}}"#).unwrap();
        let before = std::fs::read(&settings).unwrap();
        let spec = rig.spec(1);
        let p = rows(&rig, Some(spec.clone())).await;
        assert!(!p.blocking && p.rows.iter().all(|r| r.level == Level::Green), "{p:?}");
        assert!(has(&p, Level::Green, "Claude Code 2.1.286"));
        assert!(has(&p, Level::Green, "Signed in"));
        assert!(has(&p, Level::Green, "Background agents are supported"));
        assert!(has(&p, Level::Green, "Agents get this PATH: "));
        assert!(has(&p, Level::Green, &format!("Clone: {} on main", rig.clone.display())));
        assert!(has(&p, Level::Green, "0 of 3 agents running"));
        assert!(has(&p, Level::Green, "your permission mode: auto"));
        assert!(has(&p, Level::Green, &format!("What runs: {}", &spec.digest()[..12])));
        assert!(!format!("{p:?}").contains("never shown"));
        assert_eq!(std::fs::read(&settings).unwrap(), before);

        std::fs::write(&settings, r#"{"defaultMode":"bypassPermissions"}"#).unwrap();
        assert!(has(&rows(&rig, None).await, Level::Amber, "bypassPermissions"));
        std::fs::remove_file(&settings).unwrap();
        assert!(has(&rows(&rig, None).await, Level::Green, "no default permission mode is set"));
    }

    #[tokio::test]
    async fn each_failure_is_a_red_row_that_blocks() {
        let rig = ready().await;
        rig.cli.with(|s| s.logged_in = false);
        let p = rows(&rig, Some(rig.spec(1))).await;
        assert!(p.blocking && has(&p, Level::Red, "isn't signed in"));

        let rig = rig_with(|c| c.with(|s| s.bg = false)).await;
        assert!(has(&rows(&rig, None).await, Level::Red, "too old"));

        let rig = ready().await;
        std::fs::remove_dir_all(&rig.clone).unwrap();
        let p = rows(&rig, Some(rig.spec(1))).await;
        assert!(p.blocking && has(&p, Level::Red, "isn't a git clone"));

        let rig = build(Some(ToolchainError::ClaudeMissing), |s| s).await;
        let p = rows(&rig, None).await;
        assert!(p.blocking && has(&p, Level::Red, "isn't installed"));
        let rig = build(Some(ToolchainError::NoEnvironment("Couldn't read your shell environment: it printed no variables.".into())), |s| s).await;
        assert!(has(&rows(&rig, None).await, Level::Red, "Couldn't read your shell environment"));

        let rig = build(None, |s| s.with_cap(1)).await;
        let run = rig.queued(1).await;
        rig.svc.launch(&run.id).await.unwrap();
        let p = rows(&rig, None).await;
        assert!(p.blocking && has(&p, Level::Red, "1 agents are already running"));
    }

    #[tokio::test]
    async fn a_dirty_clone_or_another_branch_is_amber_and_does_not_block() {
        let rig = ready().await;
        std::fs::write(rig.clone.join(".fake-dirty"), " M cart.js\n").unwrap();
        let p = rows(&rig, Some(rig.spec(1))).await;
        assert!(!p.blocking && has(&p, Level::Amber, "uncommitted changes"));
        std::fs::remove_file(rig.clone.join(".fake-dirty")).unwrap();
        std::fs::write(rig.clone.join(".fake-branch"), "feature/x\n").unwrap();
        let p = rows(&rig, Some(rig.spec(1))).await;
        assert!(!p.blocking && has(&p, Level::Amber, "It is on feature/x, not main"));
    }

    #[tokio::test]
    async fn without_a_spec_only_the_environment_and_capacity_are_checked() {
        let rig = ready().await;
        let p = rows(&rig, None).await;
        assert!(!p.rows.iter().any(|r| r.text.contains("Clone:") || r.text.contains("What runs")));
        assert!(has(&p, Level::Green, "agents running"));
    }
}

mod through_the_real_spawner {
    use super::*;
    use std::collections::BTreeSet;

    const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-support/fake-claude.sh");
    const FORBIDDEN: [&str; 9] = [
        "--permission-mode",
        "--dangerously-skip-permissions",
        "--allowedTools",
        "--disallowedTools",
        "--settings",
        "--setting-sources",
        "--strict-mcp-config",
        "--model",
        "--session-id",
    ];

    struct Real {
        rig: Rig,
        cli: Arc<SystemCli>,
        scenario_dir: PathBuf,
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    async fn real() -> Real {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let clone = fx.home.join("webshop");
        std::fs::create_dir_all(&clone).unwrap();
        git(&clone, &["init", "-q"]);
        git(&clone, &["remote", "add", "origin", ORIGIN]);

        let scenario_dir = fx.dir.join("claude");
        std::fs::create_dir_all(&scenario_dir).unwrap();
        std::fs::write(scenario_dir.join("scenario"), "service_line=1\n").unwrap();
        let env = Arc::new(RunEnv::from_pairs([
            ("PATH", "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin".to_string()),
            ("HOME", fx.dir.to_string_lossy().into_owned()),
            ("FAKE_CLAUDE_SCENARIO", scenario_dir.join("scenario").to_string_lossy().into_owned()),
        ]));
        let cli = Arc::new(SystemCli::new(PathBuf::from(FAKE), env.clone()));
        let tools = FixedToolchain(Ok(Toolchain { cli: cli.clone(), env }));
        let svc = RunService::new(fx.core.clone(), Arc::new(tools), RunIndex::load(&fx.dir.join("index")), vec![], Arc::new(|_| {})).enabled(true).with_timing(FAST);
        let rig = Rig { svc: Arc::new(svc), cli: Arc::new(FakeCli::new()), clone: clone.canonicalize().unwrap(), changes: Arc::default(), fx };
        Real { rig, cli, scenario_dir }
    }

    fn calls(real: &Real) -> String {
        std::fs::read_to_string(real.scenario_dir.join("calls.log")).unwrap()
    }

    #[tokio::test]
    async fn approve_and_launch_writes_the_job_files_and_the_run_matches_its_entry_by_path() {
        let real = real().await;
        let run = real.rig.queued(1).await;
        real.rig.svc.launch(&run.id).await.unwrap();

        let run = real.rig.get(&run).await;
        assert_eq!(run.state, RunState::Launching, "{:?}", run.error);
        let short = run.short_id.clone().unwrap();
        assert!(real.scenario_dir.join("config/jobs").join(short.as_str()).join("state.json").is_file());
        let listed = real.cli.agents(true).await.unwrap();
        let mine = listed.iter().find(|e| belongs_to(e, &run)).expect("matched by worktree path");
        assert_eq!(mine.id.as_deref(), Some(short.as_str()));
        assert_eq!(real.rig.svc.index.live().len(), 1);

        let log = calls(&real);
        assert!(!FORBIDDEN.iter().any(|flag| log.lines().any(|l| l == *flag)), "{log}");
        let launch = log.split("---\n").find(|call| call.contains("\n--bg\n")).unwrap();
        assert!(launch.starts_with(&format!("cwd={}\n--bg\n--name\nCA-1 investigate\n--worktree\neng-1-fix-cart-0001\n--append-system-prompt\n{GUARD}\n--\n", real.rig.clone.display())), "{launch}");

        let seen: BTreeSet<String> = std::fs::read_to_string(real.scenario_dir.join("env.last")).unwrap().lines().map(String::from).collect();
        let captured: BTreeSet<String> = ["PATH", "HOME", "FAKE_CLAUDE_SCENARIO"].map(String::from).into();
        let shell_added: BTreeSet<String> = ["PWD", "SHLVL", "_", "OLDPWD"].map(String::from).into();
        assert!(seen.difference(&captured).all(|k| shell_added.contains(k)), "nothing is added per launch: {seen:?}");

        real.rig.svc.recover().await;
        assert_eq!(real.rig.get(&run).await.short_id, Some(short));
        assert_eq!(log.lines().filter(|l| *l == "--bg").count(), 1);
    }

    #[tokio::test]
    async fn retry_adopts_a_session_the_real_cli_listed_under_the_worktree_path() {
        let real = real().await;
        let run = real.rig.queued(1).await;
        let spec = &run.spec;
        let request = LaunchRequest { cwd: spec.clone_path.clone(), name: "x".into(), worktree: spec.name.clone(), guard: GUARD.into(), prompt: "p".into() };
        let started = real.cli.launch(&request).await.unwrap();
        real.rig.set(&run, |r| {
            r.state = RunState::Failed;
            r.error = Some("lost".into());
        })
        .await;

        let adopted = real.rig.svc.retry_launch(&run.id).await.unwrap();
        assert_eq!((adopted.state, adopted.short_id), (RunState::Launching, Some(started.short_id)));
        assert_eq!(calls(&real).lines().filter(|l| *l == "--bg").count(), 1, "nothing was launched twice");
    }

    #[tokio::test]
    async fn the_scripts_launch_modes_map_to_their_failures() {
        for (mode, text) in [("untrusted", "doesn't trust"), ("exit", "something broke"), ("garbage", "wasn't recognised")] {
            let real = real().await;
            std::fs::write(real.scenario_dir.join("scenario"), format!("launch_fail={mode}\n")).unwrap();
            let run = real.rig.queued(1).await;
            real.rig.svc.launch(&run.id).await.unwrap();
            let after = real.rig.get(&run).await;
            assert_eq!(after.state, RunState::Failed, "{mode}");
            assert!(after.error.unwrap().contains(text), "{mode}");
        }
    }

    #[test]
    fn the_fake_script_is_executable() {
        assert!(std::fs::metadata(FAKE).unwrap().permissions().mode() & 0o111 != 0);
    }
}
