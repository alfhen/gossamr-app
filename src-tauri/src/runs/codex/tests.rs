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
async fn a_process_start_time_does_not_change_while_it_runs() {
    let pid = std::process::id();
    let first = started_of(pid).unwrap();
    for _ in 0..5 {
        tokio::time::sleep(std::time::Duration::from_millis(450)).await;
        assert_eq!(started_of(pid), Some(first));
    }
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

mod watching {
    use super::*;
    use crate::domain::{Run, RunState};
    use crate::runs::backend::{Observation, Watched};
    use crate::runs::state::PROCESS_ENDED;
    use super::super::observe::{CARRIED_ON, GIT_SANDBOX};

    const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/test-fixtures/codex");

    fn run(state: RunState) -> Run {
        let mut run = Run::queued("run-1".into(), "p".into(), "c".into(), None, crate::domain::fixtures::run_spec(), chrono::Utc::now());
        run.state = state;
        run.short_id = Some(ShortId::parse("0a1b2c3d").unwrap());
        run.session_id = Some(THREAD.into());
        run.launched_at = Some(chrono::Utc::now());
        run
    }

    const TERMINAL_THREAD: &str = "019a0000-0000-7000-8000-0000000000ff";

    fn on_terminal_thread(state: RunState) -> Run {
        Run { session_id: Some(TERMINAL_THREAD.into()), ..run(state) }
    }

    fn this_process() -> RunProcess {
        let pid = std::process::id();
        RunProcess { pid, started: started_of(pid).unwrap() }
    }

    async fn look(backend: &CodexBackend, run: Run, ask: Option<&str>) -> Option<Observation> {
        let watched = Watched { run, misses: 0, idle: 0, ask: ask.map(str::to_owned) };
        let seen = backend.observe(std::slice::from_ref(&watched), &Folders::default(), chrono::Utc::now()).await.unwrap();
        seen.runs.into_iter().next()
    }

    fn with_events(rig: &Rig, fixture: &str) {
        std::fs::create_dir_all(rig.folder()).unwrap();
        std::fs::copy(format!("{FIXTURES}/{fixture}.jsonl"), rig.folder().join("events-1.jsonl")).unwrap();
    }

    fn another_backend(rig: &Rig) -> CodexBackend {
        let first = &rig.backend;
        CodexBackend::new(first.binary().unwrap(), first.login_env.clone(), first.git_env.clone(), first.runs_root.clone(), "Codex".into(), false)
    }

    async fn exited(rig: &Rig) {
        until("the fake to exit", || rig.folder().join("exit-1").exists()).await;
    }

    #[tokio::test]
    async fn fixture_streams_map_to_their_states_and_details() {
        let cases = [
            ("working", RunState::Working, true, RunState::Working, Some("pnpm test cart"), None),
            ("done", RunState::Working, false, RunState::Done, Some("Fixed the cart total."), Some("Fixed the cart total.")),
            ("ended-early", RunState::Working, false, RunState::Failed, Some("Starting."), None),
            ("sandbox-blocked", RunState::Working, false, RunState::Done, Some(GIT_SANDBOX), Some("I could not stage the change.")),
        ];
        for (fixture, before, running, expected, detail, answer) in cases {
            let rig = Rig::new(&format!("fx-{fixture}"), "");
            with_events(&rig, fixture);
            let mut watched = run(before);
            watched.process = running.then(this_process);
            let seen = look(&rig.backend, watched, None).await.unwrap_or_else(|| panic!("{fixture}"));
            assert_eq!(seen.seen.state, expected, "{fixture}");
            assert_eq!(seen.detail.as_deref(), detail, "{fixture}");
            assert_eq!(seen.answer.as_deref(), answer, "{fixture}");
            if expected == RunState::Failed {
                assert_eq!(seen.seen.error.as_deref(), Some(PROCESS_ENDED), "{fixture}");
            }
        }
    }

    #[tokio::test]
    async fn a_failed_turn_says_why_with_its_secrets_masked_and_a_done_one_counts_its_tokens() {
        let rig = Rig::new("fx-failed", "");
        with_events(&rig, "failed");
        let seen = look(&rig.backend, run(RunState::Working), None).await.unwrap();
        let why = seen.seen.error.unwrap();
        assert_eq!(seen.seen.state, RunState::Failed);
        assert!(why.contains("usage limit") && !why.contains("sk-abc123"), "{why}");

        with_events(&rig, "done");
        let seen = look(&rig.backend, run(RunState::Working), None).await.unwrap();
        assert_eq!(seen.tokens, Some(120));
        assert_eq!(seen.timeline.len(), 3);
    }

    #[tokio::test]
    async fn a_launching_run_with_no_thread_waits_and_then_fails() {
        let rig = Rig::new("fx-launching", "");
        std::fs::create_dir_all(rig.folder()).unwrap();
        std::fs::write(rig.folder().join("events-1.jsonl"), "").unwrap();
        let mut fresh = run(RunState::Launching);
        fresh.session_id = None;
        assert_eq!(look(&rig.backend, fresh.clone(), None).await.unwrap().seen.state, RunState::Launching);
        fresh.launched_at = Some(chrono::Utc::now() - chrono::Duration::minutes(5));
        assert_eq!(look(&rig.backend, fresh, None).await.unwrap().seen.state, RunState::Failed);
    }

    #[tokio::test]
    async fn recovery_adopts_a_launching_codex_run_whose_turn_finished_while_the_app_was_closed_and_keeps_its_answer() {
        let rig = Rig::new("recover", "answer=The cart is fixed.\n");
        let launched = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap();
        exited(&rig).await;
        let restarted = another_backend(&rig);

        let mut lost = run(RunState::Launching);
        lost.short_id = None;
        lost.session_id = None;
        let found = restarted.find(&lost, &Folders::default()).await.unwrap().expect("a finished turn is adopted");
        assert_eq!((found.short_id.as_str(), found.session_id.as_deref()), ("0a1b2c3d", Some(THREAD)));
        assert!(!alive(launched.process.as_ref().unwrap()));

        let mut adopted = run(RunState::Launching);
        adopted.process = found.process;
        let seen = look(&restarted, adopted, None).await.unwrap();
        assert_eq!((seen.seen.state, seen.answer.as_deref()), (RunState::Done, Some("The cart is fixed.")));
        assert!(rig.folder().join("final.txt").is_file());
    }

    #[tokio::test]
    async fn a_launch_that_left_no_live_process_and_no_finished_turn_is_not_adopted() {
        let rig = Rig::new("no-adopt", "exit_early=1\n");
        rig.backend.launch(&rig.request(None)).await.unwrap();
        exited(&rig).await;
        let mut lost = run(RunState::Launching);
        lost.short_id = None;
        assert_eq!(another_backend(&rig).find(&lost, &Folders::default()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_codex_run_waiting_in_ask_reads_as_needs_answer_and_asking() {
        let rig = Rig::new("ask", "hold=60\n");
        let session = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap();
        let mut waiting = run(RunState::Working);
        waiting.process = session.process.clone();

        let seen = look(&rig.backend, waiting.clone(), None).await.unwrap();
        assert_eq!(seen.seen.state, RunState::Working);
        let seen = look(&rig.backend, waiting, Some("Which table?")).await.unwrap();
        assert_eq!((seen.seen.state, seen.seen.text.as_deref()), (RunState::NeedsAnswer, Some("Which table?")));
        assert_eq!(std::fs::read_to_string(rig.folder().join("asked-1")).unwrap(), "Which table?");
        end(&rig.folder(), session.process.as_ref().unwrap()).await;
    }

    #[tokio::test]
    async fn a_codex_turn_that_ended_after_an_unanswered_ask_reads_as_needs_answer_not_done() {
        let rig = Rig::new("ask-ended", "hold=2\n");
        let session = rig.backend.launch(&rig.request(Some(offer()))).await.unwrap();
        let mut waiting = run(RunState::Working);
        waiting.process = session.process.clone();
        look(&rig.backend, waiting.clone(), Some("Which table?")).await.unwrap();
        exited(&rig).await;

        let seen = look(&rig.backend, waiting, None).await.unwrap();
        assert_eq!((seen.seen.state, seen.seen.text.as_deref()), (RunState::NeedsAnswer, Some("Which table?")));
    }

    #[tokio::test]
    async fn after_a_restart_a_codex_run_that_ended_waiting_for_an_answer_still_needs_one() {
        let rig = Rig::new("ask-restart", "");
        with_events(&rig, "done");
        std::fs::write(rig.folder().join("asked-1"), "Which table?").unwrap();

        let restarted = another_backend(&rig);
        let seen = look(&restarted, run(RunState::Working), None).await.unwrap();
        assert_eq!((seen.seen.state, seen.seen.text.as_deref()), (RunState::NeedsAnswer, Some("Which table?")));

        std::fs::remove_file(rig.folder().join("asked-1")).unwrap();
        let seen = look(&restarted, run(RunState::Working), None).await.unwrap();
        assert_eq!(seen.seen.state, RunState::Done);
    }

    #[tokio::test]
    async fn a_codex_run_whose_sandbox_stopped_git_says_so() {
        let rig = Rig::new("sandbox", "sandbox_git=1\n");
        let session = rig.backend.launch(&rig.request(None)).await.unwrap();
        exited(&rig).await;
        let mut stuck = run(RunState::Working);
        stuck.process = session.process;
        let seen = look(&rig.backend, stuck, None).await.unwrap();
        assert_eq!((seen.seen.state, seen.detail.as_deref()), (RunState::Done, Some(GIT_SANDBOX)));
    }

    #[tokio::test]
    async fn after_a_restart_a_live_codex_process_is_tracked_again_and_an_exited_one_is_read_from_its_events() {
        let rig = Rig::new("restart", "hold=60\n");
        let session = rig.backend.launch(&rig.request(None)).await.unwrap();
        let restarted = another_backend(&rig);
        let seen = look(&restarted, run(RunState::Launching), None).await.unwrap();
        assert_eq!(seen.seen.state, RunState::Working, "the recorded process is alive");
        assert_eq!(seen.session.unwrap().process, session.process);

        end(&rig.folder(), session.process.as_ref().unwrap()).await;
        let seen = look(&restarted, run(RunState::Working), None).await.unwrap();
        assert_eq!((seen.seen.state, seen.seen.error.as_deref()), (RunState::Failed, Some(PROCESS_ENDED)));

        let other = Rig::new("restart-done", "");
        with_events(&other, "done");
        assert_eq!(look(&another_backend(&other), run(RunState::Working), None).await.unwrap().seen.state, RunState::Done);
    }

    #[tokio::test]
    async fn a_finished_codex_run_takes_its_answer_from_the_o_file() {
        let rig = Rig::new("answer", "");
        with_events(&rig, "done");
        assert_eq!(rig.backend.final_answer(&run(RunState::Done), &Folders::default()).await.as_deref(), Some("Fixed the cart total."));

        std::fs::write(rig.folder().join("final.txt"), "From the file.\n").unwrap();
        assert_eq!(rig.backend.final_answer(&run(RunState::Done), &Folders::default()).await.as_deref(), Some("From the file."));
        let seen = look(&rig.backend, run(RunState::Working), None).await.unwrap();
        assert_eq!(seen.answer.as_deref(), Some("From the file."));

        std::fs::remove_file(rig.folder().join("final.txt")).unwrap();
        std::fs::write(rig.dir.join("elsewhere"), "Not mine.").unwrap();
        std::os::unix::fs::symlink(rig.dir.join("elsewhere"), rig.folder().join("final.txt")).unwrap();
        assert_eq!(rig.backend.final_answer(&run(RunState::Done), &Folders::default()).await.as_deref(), Some("Fixed the cart total."), "a symlink is not followed");
    }

    #[tokio::test]
    async fn asked_files_are_private_and_not_rewritten_for_the_same_question() {
        let rig = Rig::new("asked-private", "");
        with_events(&rig, "working");
        let mut live = run(RunState::Working);
        live.process = Some(this_process());
        look(&rig.backend, live.clone(), Some("Which table?")).await.unwrap();
        let file = rig.folder().join("asked-1");
        assert_eq!(mode(&file), 0o600);
        let inode = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&file).unwrap());
        look(&rig.backend, live.clone(), Some("Which table?")).await.unwrap();
        assert_eq!(std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&file).unwrap()), inode);

        std::fs::remove_file(&file).unwrap();
        std::fs::write(rig.dir.join("elsewhere"), "Planted").unwrap();
        std::os::unix::fs::symlink(rig.dir.join("elsewhere"), &file).unwrap();
        assert_eq!(super::super::observe::asked(&rig.folder(), 1), None, "a symlink is ignored");
        std::fs::remove_file(&file).unwrap();
        std::fs::write(&file, "x".repeat(70_000)).unwrap();
        assert_eq!(super::super::observe::asked(&rig.folder(), 1), None, "a file over 64 KB is ignored");
    }

    #[tokio::test]
    async fn a_second_question_in_one_turn_replaces_the_first_in_the_asked_file() {
        let rig = Rig::new("asked-twice", "");
        with_events(&rig, "working");
        let mut live = run(RunState::Working);
        live.process = Some(this_process());
        look(&rig.backend, live.clone(), Some("First?")).await.unwrap();
        look(&rig.backend, live, Some("Second?")).await.unwrap();
        assert_eq!(std::fs::read_to_string(rig.folder().join("asked-1")).unwrap(), "Second?");
        assert_eq!(mode(&rig.folder().join("asked-1")), 0o600);
    }

    #[tokio::test]
    async fn a_terminal_marker_reads_done_only_after_a_terminal_process_was_seen() {
        let rig = Rig::new("terminal", "terminal_hold=30\n");
        // A thread of its own, because other tests' Terminal stand-ins are listed by `ps` at the same time.
        std::fs::create_dir_all(rig.folder()).unwrap();
        let events = std::fs::read_to_string(format!("{FIXTURES}/ended-early.jsonl")).unwrap().replace(THREAD, TERMINAL_THREAD);
        std::fs::write(rig.folder().join("events-1.jsonl"), events).unwrap();
        std::fs::write(rig.folder().join("terminal"), "").unwrap();

        assert!(look(&rig.backend, on_terminal_thread(RunState::Stopped), None).await.is_none(), "a stopped run stays stopped until a Terminal process is seen");

        let mut terminal = Command::new(FAKE).args(["resume", TERMINAL_THREAD]).env("FAKE_CODEX_SCENARIO", &rig.scenario).spawn().unwrap();
        let seen = look(&rig.backend, on_terminal_thread(RunState::Stopped), None).await.unwrap();
        assert!(seen.revived && seen.seen.state == RunState::Working);
        assert!(rig.folder().join("terminal-seen").is_file());

        terminal.kill().unwrap();
        terminal.wait().unwrap();
        let seen = look(&rig.backend, on_terminal_thread(RunState::Working), None).await.unwrap();
        assert_eq!((seen.seen.state, seen.detail.as_deref()), (RunState::Done, Some(CARRIED_ON)));
    }

    #[tokio::test]
    async fn after_a_restart_find_adopts_the_live_process_a_dropped_backend_left_in_the_run_folder() {
        let rig = Rig::new("adopt", "hold=60\n");
        let session = rig.backend.launch(&rig.request(None)).await.unwrap();
        let process = session.process.clone().unwrap();

        let restarted = another_backend(&rig);
        let mut lost = run(RunState::Launching);
        lost.short_id = None;
        let found = restarted.find(&lost, &Folders::default()).await.unwrap().expect("the live process is adopted");
        assert_eq!(found.process, Some(process.clone()));

        let record = rig.folder().join("process-1.json");
        let original = std::fs::read_to_string(&record).unwrap();
        std::fs::write(&record, serde_json::json!({ "pid": process.pid, "started": process.started + 1 }).to_string()).unwrap();
        assert_eq!(restarted.find(&lost, &Folders::default()).await.unwrap(), None, "a reused pid is not adopted");
        std::fs::write(&record, original).unwrap();

        end(&rig.folder(), &process).await;
        assert_eq!(restarted.find(&lost, &Folders::default()).await.unwrap(), None, "an exited process with no finished turn is not adopted");
    }

    #[test]
    fn only_a_codex_process_that_names_the_thread_counts_as_the_terminal() {
        let listing = format!(
            "  101 /usr/local/bin/codex resume {THREAD}\n  102 node /opt/codex/bin/codex.js resume {THREAD}\n  103 vim {THREAD}\n  104 /usr/local/bin/codex resume other\n  105 /usr/local/bin/codex resume {THREAD}x\n"
        );
        assert_eq!(super::super::observe::processes_on(&listing, THREAD), vec![101, 102]);
    }
}
