//! Run by hand against the real `claude`: `cargo test real_ -- --ignored --test-threads=1`.
//!
//! Each test uses a fresh `CLAUDE_CONFIG_DIR` in a scratch folder, so the person's own sessions, login and daemon are
//! never touched. That config is signed out, so nothing here does model work. The folder is trusted by writing the
//! scratch `.claude.json`. Everything a test starts is stopped and removed, and the scratch daemon is waited out.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::cli::{AgentEntry, AuthStatus, ClaudeCli, CliResult, JobInfo, LaunchRequest, Launched, ShortId, SystemCli};
use super::env::{capture, RunEnv};
use super::index::RunIndex;
use super::service::RunService;
use super::toolchain::{FixedToolchain, Toolchain};
use crate::domain::{RunSpec, RunState};

struct Scratch {
    root: PathBuf,
    config: PathBuf,
    repo: PathBuf,
    cli: SystemCli,
    env: Arc<RunEnv>,
    launched: Vec<ShortId>,
}

fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

impl Scratch {
    async fn new(tag: &str) -> Self {
        let base = std::env::var("GOSSAMR_SCRATCH").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
        let root = std::fs::canonicalize(&base).unwrap().join(format!("gossamr-real-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (config, repo) = (root.join("config"), root.join("repo"));
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "on main"]);
        git(&repo, &["checkout", "-q", "-b", "feature"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "on feature"]);
        let trust = serde_json::json!({ "projects": { repo.to_string_lossy(): { "hasTrustDialogAccepted": true } } });
        std::fs::write(config.join(".claude.json"), trust.to_string()).unwrap();

        let shell = std::env::var("SHELL").unwrap_or_default();
        let env = capture(&shell).await.expect("shell environment").with("CLAUDE_CONFIG_DIR", &config.to_string_lossy());
        let binary = super::binary::find_claude().expect("claude is installed");
        let env = Arc::new(env);
        Self { cli: SystemCli::new(binary, env.clone()), env, root, config, repo, launched: Vec::new() }
    }

    async fn launch(&mut self, name: &str) -> ShortId {
        let req = LaunchRequest {
            cwd: self.repo.clone(),
            name: format!("{name} investigate"),
            worktree: name.to_owned(),
            guard: "Do nothing.".into(),
            prompt: "Reply with OK and stop.".into(),
        };
        let launched = self.cli.launch(&req).await.expect("launch");
        self.launched.push(launched.short_id.clone());
        launched.short_id
    }

    fn worktree(&self, name: &str) -> PathBuf {
        self.repo.join(".claude/worktrees").join(name)
    }

    async fn wait_for<T>(&self, what: &str, mut probe: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(v) = probe() {
                return v;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let claude = |args: &[&str]| {
            Command::new(self.cli.binary())
                .args(args)
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", std::env::var_os("HOME").unwrap_or_default())
                .env("CLAUDE_CONFIG_DIR", &self.config)
                .current_dir(&self.repo)
                .stdin(std::process::Stdio::null())
                .output()
                .is_ok_and(|o| o.status.success())
        };
        for id in &self.launched {
            claude(&["stop", id.as_str()]);
            for _ in 0..15 {
                if claude(&["rm", id.as_str()]) {
                    break;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(45);
        while !scratch_daemons(&self.config).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(1));
        }
        let left = scratch_daemons(&self.config);
        let _ = std::fs::remove_dir_all(&self.root);
        assert!(left.is_empty(), "a scratch daemon outlived its sessions: {left:?}");
    }
}

fn ps(args: &[&str]) -> String {
    String::from_utf8_lossy(&Command::new("ps").args(args).output().unwrap().stdout).into_owned()
}

/// Daemons whose environment names this scratch config, so the person's own daemon is never matched.
fn scratch_daemons(config: &Path) -> Vec<u32> {
    let needle = format!("CLAUDE_CONFIG_DIR={}", config.display());
    ps(&["-axo", "pid=,command="])
        .lines()
        .filter(|l| l.contains("claude daemon run"))
        .filter_map(|l| l.split_whitespace().next()?.parse::<u32>().ok())
        .filter(|pid| ps(&["eww", "-p", &pid.to_string(), "-o", "command="]).contains(&needle))
        .collect()
}

/// `ps eww` prints the environment space-separated, and values can hold spaces, so a value runs to the next ` NAME=`.
fn env_value(ps_line: &str, key: &str) -> Option<String> {
    let start = ps_line.find(&format!(" {key}="))? + key.len() + 2;
    let rest = &ps_line[start..];
    let mut end = rest.len();
    for (i, _) in rest.match_indices(' ') {
        let after = &rest[i + 1..];
        let name: String = after.chars().take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_').collect();
        if !name.is_empty() && after[name.len()..].starts_with('=') {
            end = i;
            break;
        }
    }
    Some(rest[..end].to_owned())
}

#[tokio::test]
#[ignore = "runs the real claude in a scratch config"]
async fn real_launch_is_listed_by_worktree_then_stops_and_removes() {
    let mut s = Scratch::new("lifecycle").await;
    let auth = s.cli.auth_status().await.unwrap();
    assert!(!auth.logged_in, "the scratch config must be signed out");
    assert_eq!(auth.config_directory.as_deref(), Some(s.config.as_path()));

    let id = s.launch("ce-1-spike-a1b2").await;
    let expected = s.worktree("ce-1-spike-a1b2");
    // The session is listed at the clone's root first; its cwd moves to the worktree once that exists (about 6 s).
    let started = Instant::now();
    let mut first_cwd: Option<Option<String>> = None;
    let entry = loop {
        let listed = s.cli.agents(false).await.unwrap();
        if let Some(e) = listed.into_iter().find(|e| e.id.as_deref() == Some(id.as_str())) {
            first_cwd.get_or_insert_with(|| e.cwd.clone());
            if e.cwd.as_deref().map(Path::new) == Some(expected.as_path()) {
                break e;
            }
        }
        assert!(started.elapsed() < Duration::from_secs(30), "cwd never became the worktree: {first_cwd:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    eprintln!("first listed cwd: {first_cwd:?}; worktree cwd after {:?}", started.elapsed());
    assert_eq!(entry.kind.as_deref(), Some("background"));
    assert_eq!(&entry.session_id.as_deref().unwrap()[..8], id.as_str());

    s.cli.stop(&id).await.unwrap();
    let all = s.cli.agents(true).await.unwrap();
    assert_eq!(all.iter().find(|e| e.id.as_deref() == Some(id.as_str())).unwrap().state.as_deref(), Some("stopped"));
    assert!(!s.cli.agents(false).await.unwrap().iter().any(|e| e.id.as_deref() == Some(id.as_str())));

    // rm right after stop can be refused while the stopped process still holds the worktree lock.
    let removed = Instant::now();
    while let Err(e) = s.cli.rm(&id).await {
        eprintln!("rm refused after {:?}: {e}", removed.elapsed());
        assert!(removed.elapsed() < Duration::from_secs(30), "rm never succeeded");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(!s.cli.agents(true).await.unwrap().iter().any(|e| e.id.as_deref() == Some(id.as_str())));
    assert!(git(&s.repo, &["branch", "--list", "worktree-*"]).is_empty());
}

#[tokio::test]
#[ignore = "runs the real claude in a scratch config"]
async fn real_worktree_starts_at_the_clones_current_head_not_main() {
    let mut s = Scratch::new("head").await;
    s.launch("ce-2-spike-c3d4").await;
    let worktree = s.worktree("ce-2-spike-c3d4");
    s.wait_for("the worktree to appear", || worktree.join(".git").exists().then_some(())).await;
    let head = git(&s.repo, &["rev-parse", "feature"]);
    assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), head);
    assert_ne!(head, git(&s.repo, &["rev-parse", "main"]));
}

/// Start the test binary as `env -i HOME=$HOME PATH=/usr/bin:/bin` to make the difference from a login shell visible.
#[tokio::test]
#[ignore = "runs the real claude in a scratch config; start the test process under `env -i`"]
async fn real_daemon_gets_the_captured_environment_and_nothing_added_after_the_capture() {
    let mut s = Scratch::new("env").await;
    let captured_path = s.env.get("PATH").map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let own_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("GOSSAMR_LATE_VARIABLE", "set after the capture");
    s.launch("ce-3-spike-e5f6").await;
    let pid = s.wait_for("the scratch daemon", || scratch_daemons(&s.config).first().copied()).await;
    let line = ps(&["eww", "-p", &pid.to_string(), "-o", "command="]);
    let daemon_path = env_value(&line, "PATH").expect("daemon has a PATH");
    eprintln!("test process PATH: {own_path}\ncaptured PATH:     {captured_path}\ndaemon PATH:       {daemon_path}");
    assert_eq!(daemon_path, captured_path);
    assert!(env_value(&line, "GOSSAMR_LATE_VARIABLE").is_none(), "a variable set after the capture reached the daemon");
}

/// The scratch config is signed out, which the service refuses before launching. This reports it as signed in so the
/// launch plumbing (worktree path, short id, adoption) runs against the real CLI; the session itself does no model work.
struct SignedIn(SystemCli);

#[async_trait]
impl ClaudeCli for SignedIn {
    async fn version(&self) -> CliResult<String> {
        self.0.version().await
    }

    async fn auth_status(&self) -> CliResult<AuthStatus> {
        Ok(AuthStatus { logged_in: true, ..self.0.auth_status().await? })
    }

    async fn supports_bg(&self) -> CliResult<bool> {
        self.0.supports_bg().await
    }

    async fn launch(&self, req: &LaunchRequest) -> CliResult<Launched> {
        self.0.launch(req).await
    }

    async fn agents(&self, all: bool) -> CliResult<Vec<AgentEntry>> {
        self.0.agents(all).await
    }

    async fn resume(&self, session_id: &str, message: &str, cwd: Option<&Path>) -> CliResult<Launched> {
        self.0.resume(session_id, message, cwd).await
    }

    async fn stop(&self, id: &ShortId) -> CliResult<()> {
        self.0.stop(id).await
    }

    async fn rm(&self, id: &ShortId) -> CliResult<()> {
        self.0.rm(id).await
    }

    async fn job(&self, config_dir: &Path, id: &ShortId) -> CliResult<Option<JobInfo>> {
        self.0.job(config_dir, id).await
    }

    fn binary(&self) -> Option<PathBuf> {
        Some(self.0.binary().to_path_buf())
    }
}

#[tokio::test]
#[ignore = "runs the real claude in a scratch config"]
async fn real_approved_run_launches_into_its_worktree_is_adopted_by_retry_then_stops_and_removes() {
    let mut s = Scratch::new("service").await;
    let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
    let clone = fx.home.join("webshop");
    git(&fx.home, &["clone", "-q", "--local", &s.repo.to_string_lossy(), "webshop"]);
    git(&clone, &["remote", "set-url", "origin", "https://github.com/acme/webshop.git"]);
    let trust = serde_json::json!({ "projects": { s.repo.to_string_lossy(): { "hasTrustDialogAccepted": true }, clone.to_string_lossy(): { "hasTrustDialogAccepted": true } } });
    std::fs::write(s.config.join(".claude.json"), trust.to_string()).unwrap();

    let cli = Arc::new(SignedIn(SystemCli::new(s.cli.binary().to_path_buf(), s.env.clone())));
    let tools = FixedToolchain(Ok(Toolchain { cli: cli.clone(), env: s.env.clone() }));
    let svc = RunService::new(fx.core.clone(), Arc::new(tools), RunIndex::load(&fx.dir.join("index")), vec![], Arc::new(|_| {})).enabled(true);

    let spec = RunSpec { clone_path: clone.canonicalize().unwrap(), name: "ce-4-spike-0a1b".into(), base: "feature".into(), ..crate::domain::fixtures::run_spec() };
    let draft = fx.core.draft_run(spec, Some(fx.item("CA-1"))).await.unwrap();
    let digest = fx.core.runs_review(&draft.id).await.unwrap().digest;
    let run = fx.core.runs_approve(&draft.id, &digest).await.unwrap();
    svc.start_now(&run.id).await.unwrap();

    let mut run = fx.core.run(&run.id).await.unwrap().unwrap();
    assert_eq!(run.state, RunState::Launching, "{:?}", run.error);
    let id = run.short_id.clone().expect("a short id from launch");
    s.launched.push(id.clone());

    let listed_at_worktree = started_listing(&cli, &id, &run.expected_worktree).await;
    assert!(listed_at_worktree, "the session never moved to its worktree");

    run.state = RunState::Failed;
    run.short_id = None;
    run.error = Some("answer lost".into());
    fx.core.save_run(&run).await.unwrap();
    let adopted = svc.retry_launch(&run.id).await.unwrap();
    assert_eq!((adopted.state, adopted.short_id.clone()), (RunState::Launching, Some(id.clone())));
    let sessions = cli.agents(true).await.unwrap();
    assert_eq!(sessions.iter().filter(|e| e.cwd.as_deref().map(Path::new) == Some(run.expected_worktree.as_path())).count(), 1, "retry started no second session");

    cli.stop(&id).await.unwrap();
    let removed = Instant::now();
    while let Err(e) = cli.rm(&id).await {
        eprintln!("rm refused after {:?}: {e}", removed.elapsed());
        assert!(removed.elapsed() < Duration::from_secs(30), "rm never succeeded");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(!cli.agents(true).await.unwrap().iter().any(|e| e.id.as_deref() == Some(id.as_str())));
}

#[tokio::test]
#[ignore = "runs the real claude in a scratch config"]
async fn real_signed_out_session_is_tracked_as_a_system_block_then_stops_and_a_foreign_session_is_left_alone() {
    let mut s = Scratch::new("tracker").await;
    let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
    let clone = fx.home.join("webshop");
    git(&fx.home, &["clone", "-q", "--local", &s.repo.to_string_lossy(), "webshop"]);
    git(&clone, &["remote", "set-url", "origin", "https://github.com/acme/webshop.git"]);
    let trust = serde_json::json!({ "projects": { s.repo.to_string_lossy(): { "hasTrustDialogAccepted": true }, clone.to_string_lossy(): { "hasTrustDialogAccepted": true } } });
    std::fs::write(s.config.join(".claude.json"), trust.to_string()).unwrap();

    let cli = Arc::new(SignedIn(SystemCli::new(s.cli.binary().to_path_buf(), s.env.clone())));
    let tools = FixedToolchain(Ok(Toolchain { cli: cli.clone(), env: s.env.clone() }));
    let opened = Arc::new(super::rig::Opened::default());
    let notices = Arc::new(super::rig::Notices::default());
    let svc = RunService::new(fx.core.clone(), Arc::new(tools), RunIndex::load(&fx.dir.join("index")), vec![], Arc::new(|_| {}))
        .enabled(true)
        .with_terminal(opened.clone())
        .with_notifier(notices.clone());

    let foreign = s.launch("foreign-0a1b").await;
    let spec = RunSpec { clone_path: clone.canonicalize().unwrap(), name: "ce-5-track-0a1b".into(), base: "feature".into(), ..crate::domain::fixtures::run_spec() };
    let draft = fx.core.draft_run(spec, Some(fx.item("CA-1"))).await.unwrap();
    let digest = fx.core.runs_review(&draft.id).await.unwrap().digest;
    let run = fx.core.runs_approve(&draft.id, &digest).await.unwrap();
    svc.start_now(&run.id).await.unwrap();
    let id = fx.core.run(&run.id).await.unwrap().unwrap().short_id.expect("a short id");
    s.launched.push(id.clone());

    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(45);
    let tracked = loop {
        svc.poll().await;
        let now = fx.core.run(&run.id).await.unwrap().unwrap();
        if seen.last() != Some(&now.state) {
            seen.push(now.state);
        }
        if now.state == RunState::SystemBlocked {
            break now;
        }
        assert!(Instant::now() < deadline, "never reached SystemBlocked: {seen:?} {:?}", now.error);
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    eprintln!("states seen: {seen:?}; needs: {:?}; detail: {:?}", tracked.needs, tracked.last_detail);
    assert!(tracked.needs.as_deref().is_some_and(|n| n.contains("login required")), "{:?}", tracked.needs);
    assert_eq!(tracked.session_id.as_deref().map(|s| &s[..8]), Some(id.as_str()));
    assert!(notices.0.lock().unwrap().iter().any(|(_, _, state)| *state == RunState::SystemBlocked));
    eprintln!("events: {:?}", fx.core.run_events(&run.id).await.unwrap().iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
    eprintln!("disk bytes: {:?}", svc.disk(&run.id).await);

    svc.attach(&run.id).await.unwrap();
    let file = opened.0.lock().unwrap()[0].clone();
    let script = std::fs::read_to_string(&file).unwrap();
    assert!(script.ends_with(&format!("attach {id}\n")) && script.contains(&tracked.expected_worktree.to_string_lossy().into_owned()), "{script}");

    let stopped = svc.stop(&run.id).await.unwrap();
    assert_eq!(stopped.state, RunState::Stopped);
    let listing = cli.agents(true).await.unwrap();
    let state_of = |id: &ShortId| listing.iter().find(|e| e.id.as_deref() == Some(id.as_str())).and_then(|e| e.state.clone());
    assert_eq!(state_of(&id).as_deref(), Some("stopped"));
    assert_ne!(state_of(&foreign).as_deref(), Some("stopped"), "a session Gossamr didn't start was left alone");
    svc.poll().await;
    assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap().state, RunState::Stopped);
    let _ = std::fs::remove_file(file);
}

async fn started_listing(cli: &SignedIn, id: &ShortId, worktree: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let listed = cli.agents(false).await.unwrap();
        if listed.iter().any(|e| e.id.as_deref() == Some(id.as_str()) && e.cwd.as_deref().map(Path::new) == Some(worktree)) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

fn claude_in(env: &RunEnv, binary: &Path, cwd: &Path, args: &[&str]) -> (bool, String) {
    let mut cmd = Command::new(binary);
    cmd.args(args).current_dir(cwd).stdin(std::process::Stdio::null());
    env.apply(&mut cmd);
    let out = cmd.output().expect("claude runs");
    (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}
struct Cleanup {
    binary: PathBuf,
    env: RunEnv,
    cwd: PathBuf,
    name: String,
}

impl Cleanup {
    fn listed(&self) -> Vec<String> {
        let (_, json) = claude_in(&self.env, &self.binary, &self.cwd, &["agents", "--json", "--all"]);
        super::cli::parse_agents(&json).unwrap_or_default().into_iter().filter(|e| e.name.as_deref() == Some(self.name.as_str())).filter_map(|e| e.id).collect()
    }
}

/// Stops and removes every session the test named, including a copy a faulty resume would have started.
impl Drop for Cleanup {
    fn drop(&mut self) {
        for id in self.listed() {
            claude_in(&self.env, &self.binary, &self.cwd, &["stop", &id]);
            for _ in 0..15 {
                if claude_in(&self.env, &self.binary, &self.cwd, &["rm", &id]).0 {
                    break;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        let left = self.listed();
        assert!(left.is_empty(), "the test's sessions were not removed: {left:?}");
    }
}

/// Uses the person's real, signed-in config and a trusted folder (`~/Code`), so it does model work with one short
/// prompt that uses no tools. Everything it starts is stopped and removed.
#[tokio::test]
#[ignore = "runs the real claude with the real config and does model work"]
async fn real_stop_then_resume_continues_same_session() {
    let home = dirs::home_dir().expect("home");
    let cwd = home.join("Code");
    let shell = std::env::var("SHELL").unwrap_or_default();
    let env = capture(&shell).await.expect("shell environment");
    let binary = super::binary::find_claude().expect("claude is installed");
    let cli = SystemCli::new(binary.clone(), Arc::new(env.clone()));
    let config = cli.auth_status().await.unwrap().config_directory.expect("config directory");
    let name = format!("gossamr-spike-{}", std::process::id());
    let _cleanup = Cleanup { binary: binary.clone(), env: env.clone(), cwd: cwd.clone(), name: name.clone() };
    let prompt = "Do not use any tools. Reply with exactly one yes/no question: Shall I continue? Then wait for my answer.";
    let (ok, out) = claude_in(&env, &binary, &cwd, &["--bg", "--name", &name, "--", prompt]);
    assert!(ok, "launch: {out}");
    let id = super::cli::parse_launch_stdout(&out).unwrap_or_else(|| panic!("no session id in: {out}"));

    let wait = |what: &'static str, want: &'static str| {
        let (cli, id) = (&cli, &id);
        async move {
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                let rows = cli.agents(true).await.unwrap();
                if let Some(e) = rows.into_iter().find(|e| e.id.as_deref() == Some(id.as_str()) && e.state.as_deref() == Some(want)) {
                    return e;
                }
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };
    let asked = wait("the question", "blocked").await;
    let session = asked.session_id.clone().expect("session id");
    cli.stop(&id).await.unwrap();
    assert_eq!(wait("stopped", "stopped").await.pid, None);
    tokio::time::sleep(super::service::Timing::default().stop_settle).await;

    let said = cli.resume(&session, "Yes. Reply with the single word OK and nothing else.", Some(&cwd)).await.expect("resume");
    assert_eq!(said.short_id, id, "resume answered with another session: a copy was started");
    let rows = cli.agents(true).await.unwrap();
    let ours: Vec<_> = rows.iter().filter(|e| e.name.as_deref() == Some(name.as_str())).collect();
    assert_eq!(ours.len(), 1, "a copy was started: {ours:?}");
    assert_eq!((ours[0].id.as_deref(), ours[0].session_id.as_deref()), (Some(id.as_str()), Some(session.as_str())));
    wait("done", "done").await;
    let timeline = std::fs::read_to_string(config.join("jobs").join(id.as_str()).join("timeline.jsonl")).unwrap();
    assert!(timeline.contains("Reply with the single word OK"), "the answer is in the timeline:\n{timeline}");
    let job = cli.job(&config, &id).await.unwrap().expect("job");
    assert!(job.result.as_deref().is_some_and(|r| r.contains("OK")), "result: {:?}", job.result);
}
