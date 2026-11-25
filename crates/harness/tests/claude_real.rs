//! The Claude driver on the real `claude`, on the person's own login. Ignored: `cargo test -p harness -- --ignored
//! claude_real`, from any terminal, a Claude Code session's included: the shell is captured from a cleared
//! environment, so none of the test process's own variables reach the agent. Each test runs in a scratch repo whose
//! remote is a local bare repo, records the login folders' config before and after, and fails if one changed or a
//! process of the session is left.

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

/// What a real session is opened with and told.
#[derive(Default)]
struct Real<'a> {
    locked: bool,
    result_schema: Option<serde_json::Value>,
    tools: Vec<harness::tools::ToolSpec>,
    prompt: &'a str,
    /// What the client answers a question with; a question with none fails the test.
    answer: Option<&'a str>,
}

/// What a real session left: its first turn's events, those after it, and its scratch repo, kept until this is dropped.
struct Ran {
    seen: Vec<Event>,
    rest: Vec<Event>,
    scratch: PathBuf,
    _tmp: tempfile::TempDir,
}

/// One real session opened in a scratch repo whose remote is a local bare repo, the prompt sent, its first turn run
/// with every permission allowed and a question answered, then the session closed. The login folders' config is
/// checked while it runs and after, and nothing of the session may be left.
async fn real_session(real: Real<'_>) -> Ran {
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
    let driver = ClaudeDriver::new(binary);
    let harness = Harness::with_setup(Store::open(&data).unwrap(), vec![("claude".into(), Arc::new(driver))], settings(4), Arc::new(setup));
    let spec = Open { provider: "claude".into(), cwd: scratch.clone(), locked: real.locked, model: Some("haiku".into()), result_schema: real.result_schema, tools: real.tools, ..Open::default() };
    let (id, mut events) = harness.open(spec).await.unwrap();
    harness.send(&id, real.prompt).unwrap();
    let mut seen = vec![];
    while !seen.last().is_some_and(|event: &Event| event.body.ends_turn()) {
        let event = tokio::time::timeout(Duration::from_secs(300), events.recv()).await.expect("the agent answers in time").unwrap();
        match &event.body {
            Body::Permission { id: asked, .. } => harness.answer(&id, asked, harness::event::Decision::Allow, None).unwrap(),
            Body::Question { id: asked, .. } => harness.answer_question(&id, asked, real.answer.expect("no question was expected").into()).await.unwrap(),
            _ => {}
        }
        seen.push(event);
    }
    assert!(!working_in(&scratch).is_empty(), "the agent runs in the scratch folder while the session is open");
    harness.close(&id).unwrap();
    let rest = until_within(&mut events, 60, |body| *body == Body::Closed).await;
    eprintln!("events: {:?} then {:?}", types(&seen), types(&rest));
    assert!(!seen.iter().chain(&rest).any(|event| matches!(event.body, Body::Failed { .. })), "nothing failed");
    assert!(!seen.iter().any(|event| matches!(event.body, Body::Notice { .. })), "Claude took the session's tools endpoint");
    assert!(working_in(&scratch).is_empty(), "no process of the session is left");

    watching.store(false, std::sync::atomic::Ordering::Relaxed);
    let unchanged_while_running = watcher.await.unwrap();
    let after = login_snapshot(&home);
    let changed: Vec<&String> = after.iter().filter(|line| !before.contains(line)).collect();
    assert!(unchanged_while_running && changed.is_empty(), "a login's config changed: {changed:?}");
    Ran { seen, rest, scratch, _tmp: tmp }
}

#[tokio::test]
#[ignore]
async fn claude_real_one_prompt_gives_text_and_a_result_and_leaves_nothing() {
    let seen = real_session(Real { prompt: "Reply with the single word ready, and use no tool.", ..Real::default() }).await.seen;
    let kinds = types(&seen);
    let started = seen.iter().find_map(|event| match &event.body { Body::Started { provider_session, resumed } => Some((provider_session.clone(), *resumed)), _ => None });
    let (session, resumed) = started.expect("init named the session");
    assert!(session.len() == 36 && session.matches('-').count() == 4 && !resumed, "a new session's id, from init");
    let text: String = seen.iter().filter_map(|event| match &event.body { Body::Text { text } => Some(text.as_str()), _ => None }).collect();
    assert!(text.to_lowercase().contains("ready"), "the agent's text arrived ({} characters)", text.len());
    assert_eq!(seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }), "the turn ends by its result");
    assert!(!kinds.iter().any(|kind| kind == "tool_call" || kind == "permission"), "no tool: {kinds:?}");
}

#[tokio::test]
#[ignore]
async fn claude_real_a_locked_session_runs_its_own_result_tool_unasked_and_is_offered_nothing_else() {
    // Pip's profile: `dontAsk`, no built-in tool, the endpoint by `mcp_set_servers`, its tools allowed by exact name.
    let schema = serde_json::json!({"type": "object", "properties": {"tools": {"type": "array", "items": {"type": "string"}}}, "required": ["tools"]});
    let prompt = "Call your result tool exactly once, with `tools` set to the name of every tool you are able to call, \
        each exactly as it is given to you. Call no other tool, then reply with the word done.";
    let note = harness::tools::ToolSpec { name: "note".into(), description: "Keeps a note. Do not call it.".into(), input_schema: serde_json::json!({"type": "object"}) };
    let seen = real_session(Real { locked: true, result_schema: Some(schema), tools: vec![note], prompt, ..Real::default() }).await.seen;
    assert!(!seen.iter().any(|event| matches!(event.body, Body::Permission { .. })), "nothing asked: {:?}", types(&seen));
    let call = seen.iter().find_map(|event| match &event.body { Body::ToolCall { id, name, .. } if name.ends_with("__result") => Some((id.clone(), name.clone())), _ => None });
    let (call, name) = call.expect("the result tool was called");
    let ran = seen.iter().any(|event| matches!(&event.body, Body::ToolResult { id, error: false, .. } if *id == call));
    assert!(ran, "and it ran, not denied: {:?}", types(&seen));
    let given = seen.iter().find_map(|event| match &event.body { Body::Result { data } => Some(data.clone()), _ => None }).expect("the result was taken");
    let server = name.trim_end_matches("__result");
    let mut tools: Vec<String> = given["tools"].as_array().unwrap().iter().filter_map(|tool| tool.as_str()).map(|tool| tool.trim_start_matches(&format!("{server}__")).to_owned()).collect();
    tools.sort();
    assert_eq!(tools, ["ask", "note", "result"], "it was offered the declared tools and the harness's own, and nothing else: {given}");
}

#[tokio::test]
#[ignore]
async fn claude_real_an_agent_edits_asks_is_answered_commits_and_ends_with_a_result_that_fits() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"file": {"type": "string"}, "commit": {"type": "string", "minLength": 40, "maxLength": 40}},
        "required": ["file", "commit"],
        "additionalProperties": false
    });
    let prompt = "In this repository, create a file named colour.txt. Before you write it, call your ask tool to ask which \
        colour to write, and wait for the answer. Write exactly that colour, in lower case, as the file's only line. Then \
        commit the file with git, with the message `Add colour`. Last, call your result tool with `file` set to the \
        file's name and `commit` set to the commit's full hash, then reply with the word done.";
    let ran = real_session(Real { result_schema: Some(schema), prompt, answer: Some("green"), ..Real::default() }).await;
    let kinds = types(&ran.seen);
    let asked = ran.seen.iter().any(|event| matches!(&event.body, Body::ToolCall { name, .. } if name.ends_with("__ask")));
    assert!(asked && kinds.iter().any(|kind| kind == "question"), "it asked through ask: {kinds:?}");
    assert_eq!(std::fs::read_to_string(ran.scratch.join("colour.txt")).unwrap().trim(), "green", "it wrote what it was told");
    let head = std::process::Command::new("git").args(["-C", ran.scratch.to_str().unwrap(), "log", "-1", "--format=%H %s"]).output().unwrap();
    let head = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    let given = ran.seen.iter().chain(&ran.rest).filter_map(|event| match &event.body { Body::Result { data } => Some(data.clone()), _ => None }).next_back().expect("a result was taken");
    assert_eq!(given["file"], "colour.txt");
    assert_eq!(head, format!("{} Add colour", given["commit"].as_str().unwrap()), "the result names the commit it made");
    assert_eq!(ran.seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }));
}
