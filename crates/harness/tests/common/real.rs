//! A real session on the person's own login, for the ignored `claude_real` and `codex_real` tests: a scratch repo whose
//! remote is a local bare repo, the login folders' config recorded before, during and after, and no process of the
//! session left.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use harness::claude::driver::ClaudeDriver;
use harness::event::{Body, Event};
use harness::session::{Harness, Open};
use harness::store::Store;
use harness::work::Setup;
use sha2::{Digest, Sha256};

use super::{settings, types};

/// The login folders' config files, as `spikes/acp/scripts/env.sh` lists them: each is hashed.
pub fn config_files(home: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = [
        ".claude/settings.json",
        ".claude/settings.local.json",
        ".codex/config.toml",
        ".gemini/antigravity-cli/settings.json",
        ".gemini/config/mcp_config.json",
        ".gemini/config/hooks.json",
        ".gemini/config/config.json",
        ".gemini/settings.json",
        ".gemini/trustedFolders.json",
        ".gemini/projects.json",
        ".gemini/state.json",
    ]
    .iter()
    .map(|file| home.join(file))
    .collect();
    if let Some(folder) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        files.push(PathBuf::from(folder).join("settings.json"));
    }
    files
}

/// Credential files: only their size and modification time are read, never what they hold.
pub fn credential_files(home: &Path) -> Vec<PathBuf> {
    [".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".gemini/google_accounts.json"].iter().map(|file| home.join(file)).collect()
}

/// One line per file, with the home folder written `~`, so a failure names no path of the person's.
pub fn login_snapshot(home: &Path) -> Vec<String> {
    let shown = |path: &Path| format!("~/{}", path.strip_prefix(home).unwrap_or(path).display());
    let mut lines = vec![];
    for file in config_files(home) {
        let state = match std::fs::read(&file) {
            Ok(bytes) => format!("{:x}", Sha256::digest(&bytes)).chars().take(16).collect(),
            Err(_) => "absent".to_owned(),
        };
        lines.push(format!("{} {state}", shown(&file)));
    }
    for file in credential_files(home) {
        let state = match std::fs::metadata(&file) {
            Ok(meta) => format!("{} {:?}", meta.len(), meta.modified().ok()),
            Err(_) => "absent".to_owned(),
        };
        lines.push(format!("{} {state}", shown(&file)));
    }
    lines
}

/// Processes whose working folder is in `folder`: only the session's agent and what it started work there.
pub fn working_in(folder: &Path) -> Vec<String> {
    let out = std::process::Command::new("lsof").args(["-a", "-d", "cwd", "-Fp", "+D"]).arg(folder).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| line.strip_prefix('p').map(str::to_owned)).collect()
}

pub async fn until_within(events: &mut tokio::sync::broadcast::Receiver<Event>, secs: u64, last: impl Fn(&Body) -> bool) -> Vec<Event> {
    tokio::time::timeout(Duration::from_secs(secs), until_quiet_ok(events, last)).await.expect("the agent answers in time")
}

pub async fn until_quiet_ok(events: &mut tokio::sync::broadcast::Receiver<Event>, last: impl Fn(&Body) -> bool) -> Vec<Event> {
    let mut seen = vec![];
    loop {
        let event = events.recv().await.unwrap();
        let done = last(&event.body);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

/// What a real session is opened with and told.
#[derive(Default)]
pub struct Real<'a> {
    /// Codex where set, else Claude.
    pub codex: bool,
    pub locked: bool,
    pub result_schema: Option<serde_json::Value>,
    pub tools: Vec<harness::tools::ToolSpec>,
    pub prompt: &'a str,
    /// What the client answers a question with; a question with none fails the test.
    pub answer: Option<&'a str>,
}

/// What a real session left: its first turn's events, those after it, and its scratch repo, kept until this is dropped.
pub struct Ran {
    pub seen: Vec<Event>,
    pub rest: Vec<Event>,
    pub scratch: PathBuf,
    _tmp: tempfile::TempDir,
}

/// One real session opened in a scratch repo whose remote is a local bare repo, the prompt sent, its first turn run
/// with every permission allowed and a question answered, then the session closed. The login folders' config is
/// checked while it runs and after, and nothing of the session may be left.
pub async fn real_session(real: Real<'_>) -> Ran {
    let home = dirs::home_dir().expect("a home folder");
    let before = login_snapshot(&home);
    let watching = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let watcher = {
        let (home, before, watching) = (home.clone(), before.clone(), watching.clone());
        // A write that is undone before the end is still seen.
        tokio::spawn(async move {
            while watching.load(std::sync::atomic::Ordering::Relaxed) {
                if login_snapshot(&home) != before {
                    return false;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            true
        })
    };
    let tmp = tempfile::tempdir().unwrap();
    let (scratch, remote, data) = (tmp.path().join("scratch"), tmp.path().join("remote.git"), tmp.path().join("data"));
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).output().unwrap().status.success(), "git {}", args[0]);
    git(&["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&["init", "-q", scratch.to_str().unwrap()]);
    git(&["-C", scratch.to_str().unwrap(), "remote", "add", "origin", remote.to_str().unwrap()]);
    // The scratch repo's own config, so a commit there needs no key and names no one.
    for (key, value) in [("user.name", "Harness Test"), ("user.email", "test@example.invalid"), ("commit.gpgsign", "false")] {
        git(&["-C", scratch.to_str().unwrap(), "config", key, value]);
    }
    let scratch = scratch.canonicalize().unwrap();
    let setup = Setup::of_this_machine(data.clone());
    setup.capture().await.expect("the shell's environment is read");
    // Run from inside a Claude Code session, the test process has that session's variables; none reaches the agent.
    let shell = setup.shell().expect("a capture");
    for marker in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"] {
        assert!(shell.get(marker).is_none(), "{marker} reached the agent's environment");
    }
    // Claude on its cheapest model; Codex on the person's own, at a low effort.
    let (provider, binary, model, effort) = match real.codex {
        true => ("codex", setup.places().find(harness::provider::Provider::Codex, &shell).expect("codex is installed"), None, Some("low".to_owned())),
        false => ("claude", harness::binary::find_claude().expect("claude is installed"), Some("haiku".to_owned()), None),
    };
    let version = std::process::Command::new(&binary).arg("--version").output().unwrap();
    eprintln!("{provider} --version: {}", String::from_utf8_lossy(&version.stdout).trim());
    let driver: Arc<dyn harness::driver::Driver> = match real.codex {
        true => Arc::new(harness::codex::driver::CodexDriver::new(binary)),
        false => Arc::new(ClaudeDriver::new(binary)),
    };
    let harness = Harness::with_setup(Store::open(&data).unwrap(), vec![(provider.into(), driver)], settings(4), Arc::new(setup));
    let spec = Open { provider: provider.into(), cwd: scratch.clone(), locked: real.locked, model, effort, result_schema: real.result_schema, tools: real.tools, ..Open::default() };
    let (id, mut events) = harness.open(spec).await.unwrap();
    harness.send(&id, real.prompt).unwrap();
    // One deadline for the whole turn, so an agent that keeps talking cannot hold the test open.
    let turn = async {
        let mut seen = vec![];
        while !seen.last().is_some_and(|event: &Event| event.body.ends_turn()) {
            let event = events.recv().await.unwrap();
            match &event.body {
                Body::Permission { id: asked, .. } => harness.answer(&id, asked, harness::event::Decision::Allow, None).unwrap(),
                Body::Question { id: asked, .. } => harness.answer_question(&id, asked, real.answer.expect("no question was expected").into()).await.unwrap(),
                _ => {}
            }
            seen.push(event);
        }
        seen
    };
    let seen = tokio::time::timeout(Duration::from_secs(300), turn).await.expect("the turn ends within 300 s");
    assert!(!working_in(&scratch).is_empty(), "the agent runs in the scratch folder while the session is open");
    harness.close(&id).unwrap();
    let rest = until_within(&mut events, 60, |body| matches!(*body, Body::Closed { .. })).await;
    eprintln!("events: {:?} then {:?}", types(&seen), types(&rest));
    assert!(!seen.iter().chain(&rest).any(|event| matches!(event.body, Body::Failed { .. })), "nothing failed");
    // Claude says nothing beside its turn when it took the endpoint; Codex's own warnings are notices too.
    assert!(real.codex || !seen.iter().any(|event| matches!(event.body, Body::Notice { .. })), "Claude took the session's tools endpoint");
    assert!(working_in(&scratch).is_empty(), "no process of the session is left");

    watching.store(false, std::sync::atomic::Ordering::Relaxed);
    let unchanged_while_running = watcher.await.unwrap();
    let after = login_snapshot(&home);
    let changed: Vec<&String> = after.iter().filter(|line| !before.contains(line)).collect();
    assert!(unchanged_while_running && changed.is_empty(), "a login's config changed: {changed:?}");
    Ran { seen, rest, scratch, _tmp: tmp }
}

