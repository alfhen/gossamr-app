//! The Claude driver on the real `claude`, on the person's own login. Ignored: `cargo test -p harness -- --ignored
//! claude_real`, from any terminal, a Claude Code session's included: the shell is captured from a cleared
//! environment, so none of the test process's own variables reach the agent. Each test runs in a scratch folder,
//! records the login folders' config before and after, and fails if one changed or a process of the session is left.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use harness::claude::driver::ClaudeDriver;
use harness::event::{Body, Event, TurnEnd};
use harness::session::{Harness, Open};
use harness::store::Store;
use harness::work::Setup;
use sha2::{Digest, Sha256};

/// The login folders' config files, as `spikes/acp/scripts/env.sh` lists them: each is hashed.
fn config_files(home: &Path) -> Vec<PathBuf> {
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
fn credential_files(home: &Path) -> Vec<PathBuf> {
    [".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".gemini/google_accounts.json"].iter().map(|file| home.join(file)).collect()
}

/// One line per file, with the home folder written `~`, so a failure names no path of the person's.
fn login_snapshot(home: &Path) -> Vec<String> {
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
fn working_in(folder: &Path) -> Vec<String> {
    let out = std::process::Command::new("lsof").args(["-a", "-d", "cwd", "-Fp", "+D"]).arg(folder).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| line.strip_prefix('p').map(str::to_owned)).collect()
}

async fn until_within(events: &mut tokio::sync::broadcast::Receiver<Event>, secs: u64, last: impl Fn(&Body) -> bool) -> Vec<Event> {
    tokio::time::timeout(Duration::from_secs(secs), until_quiet_ok(events, last)).await.expect("the agent answers in time")
}

async fn until_quiet_ok(events: &mut tokio::sync::broadcast::Receiver<Event>, last: impl Fn(&Body) -> bool) -> Vec<Event> {
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

#[tokio::test]
#[ignore]
async fn claude_real_one_prompt_gives_text_and_a_result_and_leaves_nothing() {
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
    let binary = harness::binary::find_claude().expect("claude is installed");
    let version = std::process::Command::new(&binary).arg("--version").output().unwrap();
    eprintln!("claude --version: {}", String::from_utf8_lossy(&version.stdout).trim());

    let tmp = tempfile::tempdir().unwrap();
    let (scratch, data) = (tmp.path().join("scratch"), tmp.path().join("data"));
    std::fs::create_dir_all(&scratch).unwrap();
    let scratch = scratch.canonicalize().unwrap();
    let setup = Setup::of_this_machine(data.clone());
    setup.capture().await.expect("the shell's environment is read");
    // Run from inside a Claude Code session, the test process has that session's variables; none reaches the agent.
    let shell = setup.shell().expect("a capture");
    for marker in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"] {
        assert!(shell.get(marker).is_none(), "{marker} reached the agent's environment");
    }
    let driver = ClaudeDriver::new(binary);
    let harness = Harness::with_setup(Store::open(&data).unwrap(), vec![("claude".into(), Arc::new(driver))], settings(4), Arc::new(setup));
    let spec = Open { provider: "claude".into(), cwd: scratch.clone(), model: Some("haiku".into()), ..Open::default() };
    let (id, mut events) = harness.open(spec).await.unwrap();
    harness.send(&id, "Reply with the single word ready, and use no tool.").unwrap();
    let seen = until_within(&mut events, 180, |body| body.ends_turn()).await;
    assert!(!working_in(&scratch).is_empty(), "the agent runs in the scratch folder while the session is open");
    harness.close(&id).unwrap();
    let rest = until_within(&mut events, 60, |body| *body == Body::Closed).await;

    let kinds = types(&seen);
    eprintln!("events: {kinds:?} then {:?}", types(&rest));
    let started = seen.iter().find_map(|event| match &event.body { Body::Started { provider_session, resumed } => Some((provider_session.clone(), *resumed)), _ => None });
    let (session, resumed) = started.expect("init named the session");
    assert!(session.len() == 36 && session.matches('-').count() == 4 && !resumed, "a new session's id, from init");
    let text: String = seen.iter().filter_map(|event| match &event.body { Body::Text { text } => Some(text.as_str()), _ => None }).collect();
    assert!(text.to_lowercase().contains("ready"), "the agent's text arrived ({} characters)", text.len());
    assert_eq!(seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }), "the turn ends by its result");
    assert!(!kinds.iter().any(|kind| kind == "tool_call" || kind == "permission"), "no tool: {kinds:?}");
    assert!(!rest.iter().any(|event| matches!(event.body, Body::Failed { .. })), "the stop fails nothing: {:?}", types(&rest));
    assert!(working_in(&scratch).is_empty(), "no process of the session is left");

    watching.store(false, std::sync::atomic::Ordering::Relaxed);
    let unchanged_while_running = watcher.await.unwrap();
    let after = login_snapshot(&home);
    let changed: Vec<&String> = after.iter().filter(|line| !before.contains(line)).collect();
    assert!(unchanged_while_running && changed.is_empty(), "a login's config changed: {changed:?}");
}
