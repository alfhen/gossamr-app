//! The whole chain on the real `claude`: the app's service, the sidecar manager, `harness serve` and the person's own
//! Claude login. Ignored, and run by hand after a debug build of the harness:
//! `cargo build -p harness && cargo test -p gossamr -- --ignored claude_on_harness_real --nocapture`.
//!
//! The login is used as it is and only read: its config is hashed before, while and after the run, and the test fails
//! if it changed. Everything else is in a temp folder: the app's data and its file vault, the harness's data folder,
//! and the work root, which the debug-only `HARNESS_WORK_HOME` moves there, so `~/Gossamr` is never touched. The
//! repository is a scratch one whose remote is a local bare repository: the clone's own config sends `github.com` there.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use harness::api::Op;
use harness::event::Decision;
use sha2::{Digest, Sha256};

use super::index::RunIndex;
use super::link::Link;
use super::on_harness::{OnHarness, ViaSidecar};
use super::service::RunService;
use super::toolchain::{FixedToolchain, Toolchain};
use crate::domain::RunState;
use crate::model_choice::ModelChoice;
use crate::secrets::{FileVault, Vault};
use crate::sidecar::{Action, Limits, Sidecar, State};

const NOTES: &str = "The cart button is red.\n";

/// The login's config files, hashed, and its credential file by size and time only: never what it holds. The home
/// folder is written `~`, so a failure names no path of the person's.
fn login_snapshot(home: &Path) -> Vec<String> {
    let shown = |path: &Path| format!("~/{}", path.strip_prefix(home).unwrap_or(path).display());
    let mut lines = vec![];
    for file in [".claude/settings.json", ".claude/settings.local.json"].map(|file| home.join(file)) {
        let state = std::fs::read(&file).map_or_else(|_| "absent".to_owned(), |bytes| format!("{:x}", Sha256::digest(&bytes)).chars().take(16).collect());
        lines.push(format!("{} {state}", shown(&file)));
    }
    let credentials = home.join(".claude/.credentials.json");
    let state = std::fs::metadata(&credentials).map_or_else(|_| "absent".to_owned(), |meta| format!("{} {:?}", meta.len(), meta.modified().ok()));
    lines.push(format!("{} {state}", shown(&credentials)));
    lines
}

/// Processes whose working folder is in `folder`.
fn working_in(folder: &Path) -> Vec<String> {
    let out = Command::new("lsof").args(["-a", "-d", "cwd", "-Fp", "+D"]).arg(folder).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| line.strip_prefix('p').map(str::to_owned)).collect()
}

/// Git with none of the person's settings, for the scratch repositories this test makes and reads.
fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// Stops the harness the test started, however the test ends: a failed assertion must not leave it, or its agent,
/// running on a temp folder that is removed with the test.
struct Stops(Arc<Option<Sidecar>>);

impl Drop for Stops {
    fn drop(&mut self) {
        if let Some(sidecar) = self.0.as_ref() {
            tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(sidecar.act(Action::Stop)));
        }
    }
}

/// The debug harness this workspace built, as `pnpm tauri dev` starts it.
fn debug_harness() -> PathBuf {
    let program = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/debug/harness");
    assert!(program.is_file(), "build it first: cargo build -p harness");
    program.canonicalize().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn claude_on_harness_real_a_run_reads_asks_edits_commits_pushes_and_ends_done_on_its_own_branch() {
    let home = dirs::home_dir().expect("a home folder");
    let before = login_snapshot(&home);
    let binary = super::binary::find_claude().expect("claude is installed");
    let version = Command::new(&binary).arg("--version").output().unwrap();
    eprintln!("claude --version: {}", String::from_utf8_lossy(&version.stdout).trim());
    let program = debug_harness();

    // The app's data, its vault and the work root, all in temp folders.
    let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
    let work_home = fx.home.canonicalize().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();

    // A bare remote with NOTES.md on main, and the clone the harness will fetch, where it would make one.
    let bare = root.join("remote/acme/webshop.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    git(&root, &["clone", "-q", bare.to_str().unwrap(), "seed"]);
    std::fs::write(root.join("seed/NOTES.md"), NOTES).unwrap();
    git(&root.join("seed"), &["add", "NOTES.md"]);
    git(&root.join("seed"), &["commit", "-q", "-m", "first"]);
    git(&root.join("seed"), &["push", "-q", "origin", "main"]);
    let clone = work_home.join("Gossamr/agents/acme/webshop");
    std::fs::create_dir_all(clone.parent().unwrap()).unwrap();
    let _ = std::fs::remove_dir_all(&clone);
    git(clone.parent().unwrap(), &["clone", "-q", bare.to_str().unwrap(), "webshop"]);
    // As the harness checks it: origin on GitHub. The clone's own config sends that URL to the bare remote, and keeps
    // the agent's commits unsigned and named for a test, whatever the person's own git settings say.
    git(&clone, &["remote", "set-url", "origin", "https://github.com/acme/webshop.git"]);
    git(&clone, &["config", &format!("url.file://{}.insteadOf", bare.display()), "https://github.com/acme/webshop.git"]);
    for (key, value) in [("commit.gpgsign", "false"), ("tag.gpgsign", "false"), ("user.name", "Test"), ("user.email", "test@example.invalid")] {
        git(&clone, &["config", key, value]);
    }
    git(&clone, &["fetch", "-q", "origin"]);

    // The sidecar manager starts the debug harness, as the app does, with its work root in the temp home.
    // SAFETY: set before any harness starts, in a test run on its own.
    std::env::set_var("HARNESS_WORK_HOME", &work_home);
    let vault = Vault::new(Box::new(FileVault::new(root.join("vault.json"))));
    let sidecar = Arc::new(Some(Sidecar::new(root.join("harness"), program, Box::new(vault), Limits::default())));
    let stops = Stops(sidecar.clone());
    let status = sidecar.as_ref().as_ref().unwrap().ensure().await;
    assert_eq!(status.state, State::Running, "the harness started: {:?}", status.message);

    // The app's service, with the person's real `claude` for its sign-in check, opening runs on the harness's driver.
    let shell = std::env::var("SHELL").unwrap_or_default();
    let env = Arc::new(super::env::capture(&shell).await.expect("the shell's environment"));
    let cli = Arc::new(super::cli::SystemCli::new(binary, env.clone()));
    let tools = FixedToolchain(Ok(Toolchain::new(cli, env)));
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(fx.core.clone()));
    let link = Arc::new(Link::start(fx.core.clone(), Arc::new(ViaSidecar(sidecar.clone())), reads, Arc::new(super::rig::Notices::default()), changed.clone()));
    let svc = RunService::new(fx.core.clone(), Arc::new(tools), RunIndex::load(&fx.dir.join("index")), changed)
        .with_home(work_home.clone())
        .with_harness(OnHarness { link: link.clone(), provider: "claude".into() });

    let spec = crate::domain::RunSpec {
        clone_path: clone.clone(),
        name: "h10e-colour".into(),
        brief: "NOTES.md says which colour the cart button is. Before you change anything, ask me which colour to use, with Gossamr's ask tool. \
            Then read NOTES.md, change the colour in it to the one I give you, commit that with the message \"Set the cart button colour\", \
            and push your branch to origin. Finish with your result."
            .into(),
        report: true,
        ..crate::domain::fixtures::run_spec()
    };
    let queued = fx.core.queue_test_run(spec, Some(fx.item("CA-1"))).await.unwrap();
    let mut chosen = queued.clone();
    chosen.runs_on = Some(ModelChoice { instance_id: crate::connections::DEFAULT_CLAUDE.into(), model: "haiku".into(), effort: None });
    fx.core.save_run(&chosen).await.unwrap();
    let started = Instant::now();
    let run = svc.start_now(&queued.id).await.unwrap();
    let session = run.harness_session.clone().unwrap_or_else(|| panic!("opened on the harness: {:?}", run.error));
    eprintln!("opened {} on the harness in {:?}", run.id, started.elapsed());

    // Answered as the run sheet would: the question by `answer`, each permission request allowed through the run's
    // own link (the app has no button for it yet: H11a).
    let (mut asked, mut allowed): (usize, Vec<String>) = (0, Vec::new());
    let done = loop {
        assert!(started.elapsed() < Duration::from_secs(600), "the run did not end in 10 minutes");
        let now = fx.core.run(&run.id).await.unwrap().expect("the run is kept");
        match now.state {
            RunState::Done => break now,
            RunState::Failed | RunState::Stopped => {
                let rows: Vec<String> = fx.core.run_events(&run.id).await.unwrap().into_iter().map(|e| format!("{}: {}", e.kind, e.text)).collect();
                panic!("the run ended {:?}: {:?}\n{rows:#?}", now.state, now.error);
            }
            RunState::NeedsAnswer if asked == 0 => {
                eprintln!("asked: {:?}", now.needs);
                asked += 1;
                svc.answer(&run.id, "Blue").await.unwrap();
            }
            RunState::NeedsPermission => {
                let (_, follow) = fx.core.session_run(&session).await.unwrap().unwrap();
                for (request, _, need) in follow.permissions {
                    eprintln!("allowed: {need}");
                    allowed.push(need);
                    link.call(Op::Answer { session: session.clone(), request, decision: Decision::Allow, message: None }).await.unwrap();
                }
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    eprintln!("done in {:?}: {asked} question, {} permission requests", started.elapsed(), allowed.len());
    let rows: Vec<String> = fx.core.run_events(&run.id).await.unwrap().into_iter().map(|e| format!("{}: {}", e.kind, e.text)).collect();
    eprintln!("timeline:\n{}", rows.join("\n"));

    // The run, as the app keeps it: its report, and the branch and worktree the harness made.
    assert_eq!(asked, 1, "it asked through `ask`");
    assert!(done.result.as_deref().is_some_and(|result| !result.trim().is_empty()), "it gave its result: {:?}", done.result);
    assert!(!rows.iter().any(|row| row.contains("__report")), "it looked for no `report` tool: the brief names `result`");
    assert_eq!(done.branch.as_deref(), Some("h10e-colour"));
    let worktree = work_home.join("Gossamr/agents/acme/webshop+worktrees/h10e-colour");
    assert_eq!(done.expected_worktree, worktree);
    assert!(std::fs::read_to_string(worktree.join("NOTES.md")).unwrap().to_lowercase().contains("blue"), "it edited the file");
    // The commit is on the branch the run records, and on the remote after the push.
    assert_eq!(git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]), "h10e-colour", "it stayed on the harness's branch");
    let head = git(&worktree, &["rev-parse", "HEAD"]);
    assert_ne!(head, git(&clone, &["rev-parse", "origin/main"]), "it committed");
    assert_eq!(git(&bare, &["rev-parse", "refs/heads/h10e-colour"]), head, "its push reached the remote");

    // The check the harness's clean-up makes after its fetch: every commit of the branch is on the remote. The
    // harness itself refuses to fetch this clone, whose own config sends github.com to the bare remote, since a fetch
    // honours a clone's config; so its clean-up refuses here, and says why.
    let shell_git = super::toolchain::git(Arc::new(super::env::RunEnv::from_pairs([("PATH", "/usr/bin:/bin"), ("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_CONFIG_GLOBAL", "/dev/null")])));
    let kept = shell_git.check_branch_deletable(&clone, "h10e-colour", "main").await;
    assert!(kept.is_ok(), "the branch's commits are on the remote: {kept:?}");
    link.stop(&session).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !fx.core.session_run(&session).await.unwrap().unwrap().1.closed {
        assert!(Instant::now() < deadline, "the session did not close");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let refused = link.call(Op::CleanUp { session: session.clone() }).await.unwrap_err();
    assert!(refused.contains("settings Gossamr didn't make"), "{refused}");
    assert!(worktree.join("NOTES.md").is_file(), "and removes nothing");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !working_in(&work_home).is_empty() {
        assert!(Instant::now() < deadline, "a process of the session is left: {:?}", working_in(&work_home));
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let listed = link.call(Op::Sessions).await.unwrap();
    assert!(listed.as_array().unwrap().iter().all(|row| row["running"] != true), "no session runs: {listed}");
    let stopped = sidecar.as_ref().as_ref().unwrap().act(Action::Stop).await;
    assert_eq!(stopped.state, State::Stopped, "the harness stopped: {:?}", stopped.message);
    drop(stops);
    std::env::remove_var("HARNESS_WORK_HOME");

    let after = login_snapshot(&home);
    let changed: Vec<&String> = after.iter().filter(|line| !before.contains(line)).collect();
    assert!(changed.is_empty(), "the login's config changed: {changed:?}");
}
