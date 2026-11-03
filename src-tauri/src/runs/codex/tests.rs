use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::launch::toml_string;
use super::process::{alive, signal, signal_group, started_of};
use super::*;
use crate::connections::Driver;
use crate::domain::{RunProcess, AGENT_GUARD};
use crate::runs::backend::ToolsOffer;
use crate::runs::cli::ShortId;
use crate::runs::report::{new_token, well_formed};

const FAKE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-support/fake-codex.sh");
const THREAD: &str = "019a0000-0000-7000-8000-000000000001";
const WORKTREE_NAME: &str = "eng-1-fix-cart-0001";

struct Rig {
    dir: PathBuf,
    clone: PathBuf,
    scenario: PathBuf,
    backend: CodexBackend,
}

impl Rig {
    fn new(tag: &str, scenario: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("gossamr-codex-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        git(&dir, &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        git(&dir, &["clone", "-q", "origin.git", "clone"]);
        let clone = dir.join("clone");
        std::fs::write(clone.join("README"), "hello").unwrap();
        git(&clone, &["add", "README"]);
        git(&clone, &["commit", "-q", "-m", "first"]);
        git(&clone, &["push", "-q", "origin", "HEAD:main"]);
        git(&clone, &["fetch", "-q", "origin"]);

        let scenario_file = dir.join("scenario");
        std::fs::write(&scenario_file, scenario).unwrap();
        let login = RunEnv::from_pairs([("PATH", "/usr/bin:/bin".to_owned()), ("FAKE_CODEX_SCENARIO", scenario_file.display().to_string())]);
        let shell = RunEnv::from_pairs([("PATH", "/usr/bin:/bin"), ("GIT_CONFIG_GLOBAL", "/dev/null"), ("GIT_CONFIG_SYSTEM", "/dev/null")]);
        let backend = CodexBackend::new(PathBuf::from(FAKE), Arc::new(login), Arc::new(shell), dir.join("agents").join("runs"), "Codex".into(), false).with_launch_wait(Duration::from_secs(20));
        Self { dir, clone, scenario: scenario_file, backend }
    }

    fn request(&self, tools: Option<ToolsOffer>) -> LaunchRequest {
        LaunchRequest {
            cwd: self.clone.clone(),
            name: "Fix the cart".into(),
            worktree: WORKTREE_NAME.into(),
            guard: "Guard.".into(),
            prompt: "Do it.".into(),
            tools,
            model: None,
            fresh_id: ShortId::parse("0a1b2c3d").unwrap(),
            run_id: "run-1".into(),
            base: "main".into(),
        }
    }

    fn folder(&self) -> PathBuf {
        self.dir.join("agents").join("runs").join("run-1")
    }

    fn worktree(&self) -> PathBuf {
        self.clone.join(".claude").join("worktrees").join(WORKTREE_NAME)
    }

    fn calls(&self) -> String {
        std::fs::read_to_string(self.dir.join("calls.log")).unwrap_or_default()
    }

    fn branches(&self) -> String {
        git(&self.clone, &["branch", "--list", "worktree-*"])
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn offer() -> ToolsOffer {
    ToolsOffer { run_id: "run-1".into(), url: "http://127.0.0.1:4321/agent/run-1".into(), token: new_token().unwrap() }
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

async fn until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Ends the fake and waits for its reaper to record the exit, so no test leaves a process behind.
async fn end(folder: &Path, process: &RunProcess) {
    let _ = signal_group(process, libc::SIGKILL);
    until("the process to exit", || folder.join("exit-1").exists()).await;
}

fn args_of(calls: &str) -> Vec<&str> {
    calls.lines().collect()
}

#[tokio::test]
async fn a_codex_launch_makes_the_worktree_and_run_folder_and_records_the_thread_and_a_live_process() {
    let rig = Rig::new("launch", "hold=60\n");
    let session = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap();

    assert_eq!(session.short_id.as_str(), "0a1b2c3d");
    assert_eq!(session.session_id.as_deref(), Some(THREAD));
    let process = session.process.clone().expect("a process");
    assert!(alive(&process));
    assert!(rig.worktree().join("README").is_file(), "the worktree has the base's files");
    assert!(rig.branches().contains("worktree-eng-1-fix-cart-0001"));
    assert!(rig.calls().contains(&format!("cwd={}", rig.worktree().display())), "run in the worktree");

    let folder = rig.folder();
    assert_eq!(mode(&folder), 0o700);
    for file in ["events-1.jsonl", "stderr-1.log", "process-1.json"] {
        assert_eq!(mode(&folder.join(file)), 0o600, "{file}");
    }
    let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(folder.join("process-1.json")).unwrap()).unwrap();
    assert_eq!((recorded["pid"].as_u64(), recorded["started"].as_u64()), (Some(process.pid as u64), Some(process.started)));
    end(&folder, &process).await;
    assert!(!alive(&process));
}

#[tokio::test]
async fn a_codex_launch_passes_the_server_the_approval_the_tool_timeout_and_the_guard_and_no_sandbox() {
    let rig = Rig::new("argv", "");
    let tools = offer();
    let session = rig.backend.launch(&rig.request(Some(tools.clone()))).await.unwrap();
    end(&rig.folder(), session.process.as_ref().unwrap()).await;

    let calls = rig.calls();
    let args = args_of(&calls);
    for expected in [
        "exec".to_owned(),
        "--json".into(),
        format!("mcp_servers.gossamr.url={}", toml_string(&tools.url)),
        "mcp_servers.gossamr.bearer_token_env_var=\"GOSSAMR_MCP_TOKEN\"".into(),
        "mcp_servers.gossamr.default_tools_approval_mode=\"approve\"".into(),
        "mcp_servers.gossamr.tool_timeout_sec=600".into(),
        format!("developer_instructions={}", toml_string(&format!("Guard. {AGENT_GUARD} {CODEX_GUARD}"))),
        "Do it.".into(),
    ] {
        assert!(args.contains(&expected.as_str()), "{expected}\n{calls}");
    }
    let at = |flag: &str| args.iter().position(|a| *a == flag).unwrap_or_else(|| panic!("{flag}\n{calls}"));
    assert_eq!(args[at("-C") + 1], rig.worktree().display().to_string());
    assert_eq!(args[at("-o") + 1], rig.folder().join("final.txt").display().to_string());
    assert!(at("--") < args.iter().position(|a| *a == "Do it.").unwrap(), "the prompt follows --");
    for forbidden in ["--sandbox", "-s", "--ignore-user-config", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-a", "--ask-for-approval"] {
        assert!(!args.contains(&forbidden), "{forbidden}");
    }
    assert!(!calls.contains("approval_policy") && !calls.contains("sandbox_mode"), "{calls}");
}

#[tokio::test]
async fn a_codex_launch_with_no_offer_leaves_out_the_server_and_the_token() {
    let rig = Rig::new("nooffer", "");
    let session = rig.backend.launch(&rig.request(None)).await.unwrap();
    end(&rig.folder(), session.process.as_ref().unwrap()).await;

    let calls = rig.calls();
    assert!(!calls.contains("mcp_servers"), "{calls}");
    assert!(calls.contains(&format!("developer_instructions={}", toml_string(&format!("Guard. {CODEX_GUARD}")))), "{calls}");
    assert!(!rig.dir.join("token.seen").exists());
}

#[tokio::test]
async fn the_chosen_model_is_passed_with_m() {
    let rig = Rig::new("model", "");
    let request = LaunchRequest { model: Some("gpt-5.1-codex".into()), ..rig.request(None) };
    let session = rig.backend.launch(&request).await.unwrap();
    end(&rig.folder(), session.process.as_ref().unwrap()).await;
    let calls = rig.calls();
    let args = args_of(&calls);
    let at = args.iter().position(|a| *a == "-m").expect("-m");
    assert_eq!(args[at + 1], "gpt-5.1-codex");
}

#[tokio::test]
async fn the_mcp_token_is_in_the_codex_environment_and_in_no_argument() {
    let rig = Rig::new("token", "");
    let tools = offer();
    assert!(well_formed(&tools.token));
    let session = rig.backend.launch(&rig.request(Some(tools.clone()))).await.unwrap();
    end(&rig.folder(), session.process.as_ref().unwrap()).await;

    assert_eq!(std::fs::read_to_string(rig.dir.join("token.seen")).unwrap().trim(), "ok", "the child had the token");
    assert!(std::fs::read_to_string(rig.dir.join("env.last")).unwrap().lines().any(|n| n == "GOSSAMR_MCP_TOKEN"));
    let secret = &tools.token[4..];
    assert!(!rig.calls().contains(secret), "the token is in argv");
    for file in std::fs::read_dir(rig.folder()).unwrap() {
        let text = std::fs::read_to_string(file.unwrap().path()).unwrap_or_default();
        assert!(!text.contains(secret), "the token is in the run folder");
    }
    assert!(!format!("{session:?}").contains(secret) && !format!("{:?}", rig.request(Some(tools.clone()))).contains(secret));
}

#[tokio::test]
async fn a_codex_launch_writes_process_1_json_before_thread_started() {
    let rig = Arc::new(Rig::new("early", "start_delay=2\nhold=30\n"));
    let launching = {
        let rig = rig.clone();
        tokio::spawn(async move { rig.backend.launch(&rig.request(None)).await })
    };
    let file = rig.folder().join("process-1.json");
    until("process-1.json", || file.exists()).await;
    assert!(!launching.is_finished(), "launch is still waiting for thread.started");
    assert_eq!(mode(&file), 0o600);
    let recorded: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    until("the fake to log its pid", || rig.calls().contains("pid=")).await;
    let pid = rig.calls().lines().find_map(|l| l.strip_prefix("pid=").map(str::to_owned)).unwrap();
    assert_eq!(recorded["pid"].to_string(), pid);

    let session = launching.await.unwrap().unwrap();
    end(&rig.folder(), session.process.as_ref().unwrap()).await;
}

#[test]
fn a_reused_pid_is_not_the_run_s_process() {
    let pid = std::process::id();
    let started = started_of(pid).expect("this process has a start time");
    assert!(alive(&RunProcess { pid, started }));
    let reused = RunProcess { pid, started: started + 1 };
    assert!(!alive(&reused));
    assert!(!signal(&reused, 0).unwrap(), "nothing is sent to a process that is not the run's");
    assert!(!signal_group(&reused, 0).unwrap());
}

#[tokio::test]
async fn a_failed_codex_launch_can_be_retried() {
    let rig = Rig::new("retry", "fail=Something broke\n");
    let failed = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap_err();
    assert!(failed.to_string().contains("Something broke"), "{failed}");
    assert!(!rig.folder().exists(), "the run folder is gone");
    assert!(!rig.worktree().exists(), "the worktree is gone");
    assert_eq!(rig.branches().trim(), "", "the branch is gone");

    std::fs::write(&rig.scenario, "hold=30\n").unwrap();
    let session = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap();
    assert_eq!(session.session_id.as_deref(), Some(THREAD));
    end(&rig.folder(), session.process.as_ref().unwrap()).await;
}

#[tokio::test]
async fn an_interrupted_launch_that_left_its_worktree_untouched_is_taken_up_again() {
    let rig = Rig::new("again", "hold=30\n");
    git(&rig.clone, &["worktree", "add", "--no-track", "-b", "worktree-eng-1-fix-cart-0001", "--", &rig.worktree().display().to_string(), "origin/main"]);
    let session = rig.backend.launch(&rig.request(None)).await.unwrap();
    assert!(session.process.is_some());
    end(&rig.folder(), session.process.as_ref().unwrap()).await;
}

#[tokio::test]
async fn a_launch_over_a_worktree_with_commits_is_refused_and_leaves_it_alone() {
    let rig = Rig::new("commits", "");
    git(&rig.clone, &["worktree", "add", "--no-track", "-b", "worktree-eng-1-fix-cart-0001", "--", &rig.worktree().display().to_string(), "origin/main"]);
    git(&rig.worktree(), &["commit", "-q", "--allow-empty", "-m", "work"]);
    let failed = rig.backend.launch(&rig.request(None)).await.unwrap_err();
    assert!(failed.to_string().contains("already there"), "{failed}");
    assert!(rig.worktree().exists() && rig.branches().contains("worktree-"), "the work stays");
    assert!(!rig.folder().exists());
}

#[tokio::test]
async fn a_failed_codex_launch_never_reads_as_needing_trust_and_never_says_claude() {
    let rig = Rig::new("trust", "fail=Workspace not trusted\n");
    let failed = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap_err();
    assert!(!matches!(failed, Failure::NeedsTrust { .. }));
    let words = failed.to_string();
    assert!(words.contains("Workspace not trusted") && words.starts_with("Codex"), "{words}");
    assert!(!words.to_lowercase().contains("claude"), "{words}");
}

#[tokio::test]
async fn a_codex_launch_that_never_names_a_thread_fails_and_stops_the_process() {
    let rig = Rig::new("slow", "start_delay=30\n");
    let backend = CodexBackend::new(rig.backend.binary().unwrap(), rig.backend.login_env.clone(), rig.backend.git_env.clone(), rig.backend.runs_root.clone(), "Codex".into(), false).with_launch_wait(Duration::from_millis(400));
    let failed = backend.launch(&rig.request(None)).await.unwrap_err();
    assert!(failed.to_string().contains("didn't start a session"), "{failed}");
    assert!(!rig.folder().exists() && !rig.worktree().exists());
    let pid: u32 = rig.calls().lines().find_map(|l| l.strip_prefix("pid=")).unwrap().parse().unwrap();
    until("the fake to be gone", || started_of(pid).is_none() || unsafe { libc::kill(pid as i32, 0) } != 0).await;
}

#[tokio::test]
async fn stderr_in_a_failed_launch_has_its_secrets_masked() {
    let rig = Rig::new("redact", "fail=request failed: Authorization: Bearer sk-abc123\n");
    let failed = rig.backend.launch(&rig.request(None)).await.unwrap_err();
    assert!(!failed.to_string().contains("sk-abc123"), "{failed}");
}

#[tokio::test]
async fn a_run_id_that_is_not_plain_gets_no_folder() {
    let rig = Rig::new("badid", "");
    let failed = rig.backend.launch(&LaunchRequest { run_id: "../x".into(), ..rig.request(None) }).await.unwrap_err();
    assert!(matches!(failed, Failure::Invalid(_)));
    assert!(!rig.worktree().exists(), "nothing was made");
}

#[tokio::test]
async fn preflight_follows_codex_login_status() {
    let rig = Rig::new("login", "");
    assert_eq!(rig.backend.preflight(&rig.clone).await, Ok(()));
    assert!(rig.backend.signed_in().await.unwrap());

    std::fs::write(&rig.scenario, "login=Not logged in\nlogin_code=1\n").unwrap();
    assert_eq!(rig.backend.preflight(&rig.clone).await.err(), Some(Failure::NotSignedIn { instance: "Codex".into(), own_folder: false }));
    assert!(!rig.backend.signed_in().await.unwrap());

    std::fs::write(&rig.scenario, "login=garbled\nlogin_code=3\n").unwrap();
    assert!(rig.backend.signed_in().await.is_err());

    let missing = CodexBackend::new(rig.dir.join("nope"), rig.backend.login_env.clone(), rig.backend.git_env.clone(), rig.backend.runs_root.clone(), "Codex".into(), false);
    assert_eq!(missing.preflight(&rig.clone).await.err(), Some(Failure::ClaudeMissing { instance: "Codex".into(), driver: Driver::Codex }));
    assert!(matches!(missing.signed_in().await, Err(BackendError::Spawn { program: "codex", .. })));
    assert!(rig.backend.trust_file().await.unwrap().is_none());
}

#[test]
fn a_toml_string_escapes_what_would_end_or_break_it() {
    assert_eq!(toml_string("plain"), "\"plain\"");
    assert_eq!(toml_string("a \"q\" and a \\ and\nnew\tline\r"), "\"a \\\"q\\\" and a \\\\ and\\nnew\\tline\\r\"");
    assert_eq!(toml_string("bell\u{7}"), "\"bell\\u0007\"");
    assert_eq!(toml_string("é ✓"), "\"é ✓\"");
}

#[test]
fn only_a_plain_run_id_names_a_run_folder() {
    let root = Path::new("/data/agents/runs");
    assert_eq!(run_folder(root, "run-1"), Some(root.join("run-1")));
    for bad in ["", "..", "../x", "a/b", "a b"] {
        assert_eq!(run_folder(root, bad), None, "{bad:?}");
    }
}
