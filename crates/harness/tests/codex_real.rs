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
    let launch = Launch { cwd: work.clone(), locked: false, model: None, login: None, effort: None, resume: None, tools_token: Secret::random(), tools, result_schema: None, env };
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
