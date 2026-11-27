//! The Codex driver on the real `codex app-server`, on the person's own login. Ignored: `cargo test -p harness --
//! --ignored codex_real`. Each test records the login folders' config before and after, `~/.codex/config.toml` among
//! them, and fails if one changed; the session's runs in a scratch repo whose remote is a local bare repo, and no
//! process of it may be left.

mod common;

use std::time::Duration;

use common::real::*;
use common::*;
use harness::driver::{Command, Driver, Launch, Secret};
use harness::event::{Body, TurnEnd};

#[tokio::test]
#[ignore]
async fn codex_real_a_session_asks_is_answered_and_ends_with_a_result_that_fits() {
    let schema = serde_json::json!({"type": "object", "properties": {"colour": {"type": "string"}}, "required": ["colour"], "additionalProperties": false});
    let prompt = "Call your ask tool to ask which colour to choose, and wait for its answer. Then call your result tool \
        with `colour` set to exactly that colour, in lower case. Use no other tool, then reply with the word done.";
    let ran = real_session(Real { codex: true, result_schema: Some(schema), prompt, answer: Some("green"), ..Real::default() }).await;
    let kinds = types(&ran.seen);
    let asked = ran.seen.iter().any(|event| matches!(&event.body, Body::ToolCall { name, .. } if name.ends_with("/ask")));
    assert!(asked && kinds.iter().any(|kind| kind == "question"), "it asked through ask: {kinds:?}");
    let given = ran.seen.iter().chain(&ran.rest).filter_map(|event| match &event.body { Body::Result { data } => Some(data.clone()), _ => None }).next_back();
    assert_eq!(given.expect("a result was taken")["colour"], "green", "the result holds the answer");
    assert_eq!(ran.seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }));
}

#[tokio::test]
#[ignore]
async fn codex_real_the_drivers_thread_start_in_an_empty_signed_out_codex_home_leaves_no_config_toml() {
    let home = dirs::home_dir().expect("a home folder");
    let tmp = tempfile::tempdir().unwrap();
    let (login, data, clone) = (tmp.path().join("codex-home"), tmp.path().join("data"), tmp.path().join("clone"));
    std::fs::create_dir_all(&login).unwrap();
    // A worktree of a clone, as a session works in: Codex keeps trust per repository root, so a plain folder would
    // show no write whatever the driver sent.
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).output().unwrap().status.success(), "git {}", args[0]);
    git(&["init", "-q", clone.to_str().unwrap()]);
    git(&["-C", clone.to_str().unwrap(), "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"]);
    let work = tmp.path().join("clone+worktrees").join("h7a");
    git(&["-C", clone.to_str().unwrap(), "worktree", "add", "-q", work.to_str().unwrap(), "-b", "h7a"]);
    let setup = harness::work::Setup::of_this_machine(data);
    setup.capture().await.expect("the shell's environment is read");
    let shell = setup.shell().expect("a capture");
    let before = login_snapshot(&home, &shell);
    let binary = setup.places().find(harness::provider::Provider::Codex, &shell).expect("codex is installed");
    // The usual agent environment with `CODEX_HOME` at the empty folder: a login folder the harness takes must be in the
    // home folder, where this test writes nothing.
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = setup.agent_env("codex", None).expect("the agent's environment").into_pairs().filter(|(name, _)| name != "CODEX_HOME").collect();
    env.push(("CODEX_HOME".into(), login.clone().into()));
    let mut tools = harness::tools::ToolsEndpoint::unattached();
    tools.allowed = vec![tools.name.clone()];
    let launch = Launch { cwd: work.clone(), locked: false, model: None, login: None, effort: None, permissions: Default::default(), resume: None, tools_token: Secret::random(), tools, result_schema: None, env };
    let mut link = harness::codex::driver::CodexDriver::new(binary).open(launch).unwrap();
    let started = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(body) = link.output.recv().await {
            if matches!(body, Body::Started { .. }) {
                return true;
            }
        }
        false
    });
    assert!(started.await.expect("the thread starts within 60 s"), "the thread started, signed out");
    link.commands.send(Command::Stop).unwrap();
    while tokio::time::timeout(Duration::from_secs(20), link.output.recv()).await.expect("app-server goes").is_some() {}
    assert!(!login.join("config.toml").exists(), "the driver's thread/start wrote no config.toml");
    assert_eq!(login_snapshot(&home, &shell), before, "and no login's config changed");
}

/// The `sleep 300` processes working in `folder`, by pid.
fn sleeps_in(folder: &std::path::Path) -> Vec<u32> {
    working_in(folder)
        .into_iter()
        .filter_map(|pid| pid.parse::<u32>().ok())
        .filter(|pid| {
            let out = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim() == "sleep 300"
        })
        .collect()
}

/// A worktree of a scratch clone, as a session works in.
fn scratch_worktree(tmp: &std::path::Path) -> std::path::PathBuf {
    let clone = tmp.join("clone");
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).output().unwrap().status.success(), "git {}", args[0]);
    git(&["init", "-q", clone.to_str().unwrap()]);
    git(&["-C", clone.to_str().unwrap(), "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "start"]);
    let work = tmp.join("clone+worktrees").join("h7a-2");
    git(&["-C", clone.to_str().unwrap(), "worktree", "add", "-q", work.to_str().unwrap(), "-b", "h7a-2"]);
    work.canonicalize().unwrap()
}

const BACKGROUND: &str = "Run exactly this one shell command, with no other command: `sleep 300 > /dev/null 2>&1 & echo $!`. Then reply with the word done.";

/// A job a command sends to the background in its own group is gone by the turn's end: Codex ends the command's group
/// when the command returns (0.171.0, in its default sandbox). Any `sleep` left is killed by its pid.
#[tokio::test]
#[ignore]
async fn codex_real_a_job_a_command_sends_to_the_background_is_gone_by_the_turns_end() {
    let home = dirs::home_dir().expect("a home folder");
    let tmp = tempfile::tempdir().unwrap();
    let work = scratch_worktree(tmp.path());
    let setup = harness::work::Setup::of_this_machine(tmp.path().join("data"));
    setup.capture().await.expect("the shell's environment is read");
    let shell = setup.shell().expect("a capture");
    let before = login_snapshot(&home, &shell);
    let binary = setup.places().find(harness::provider::Provider::Codex, &shell).expect("codex is installed");
    let env: Vec<(std::ffi::OsString, std::ffi::OsString)> = setup.agent_env("codex", None).expect("the agent's environment").into_pairs().collect();
    let mut tools = harness::tools::ToolsEndpoint::unattached();
    tools.allowed = vec![tools.name.clone()];
    let launch = Launch { cwd: work.clone(), locked: false, model: None, login: None, effort: Some("low".into()), permissions: Default::default(), resume: None, tools_token: Secret::random(), tools, result_schema: None, env };
    let mut link = harness::codex::driver::CodexDriver::new(binary).open(launch).unwrap();
    link.commands.send(Command::Prompt(BACKGROUND.into())).unwrap();
    let mut said = vec![];
    let ended = tokio::time::timeout(Duration::from_secs(180), async {
        while let Some(body) = link.output.recv().await {
            let done = matches!(body, Body::TurnEnded { .. } | Body::Failed { .. });
            said.push(body);
            if done {
                return;
            }
        }
    });
    ended.await.expect("the turn ends within 180 s");
    let during = sleeps_in(&work);
    link.commands.send(Command::Stop).unwrap();
    while tokio::time::timeout(Duration::from_secs(20), link.output.recv()).await.expect("app-server goes").is_some() {}
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = sleeps_in(&work);
    let calls: Vec<&Body> = said.iter().filter(|body| matches!(body, Body::ToolCall { .. } | Body::ToolResult { .. } | Body::Notice { .. })).collect();
    eprintln!("calls: {calls:?}");
    eprintln!("sleep 300 in the worktree: {} at the turn's end, {} after Stop", during.len(), after.len());
    for pid in &after {
        // SAFETY: a `sleep 300` this test's own agent started, working in this test's own scratch worktree.
        unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
    }
    assert_eq!(login_snapshot(&home, &shell), before, "no login's config changed");
    let started = said.iter().any(|body| matches!(body, Body::ToolResult { output, .. } if output.as_str().is_some_and(|out| out.lines().any(|line| line.trim().parse::<u32>().is_ok()))));
    assert!(started, "the command started its job and said its pid");
    assert_eq!((during, after), (vec![], vec![]), "the job was gone by the turn's end");
}
