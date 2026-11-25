//! `harness providers` against fake `claude`, `codex` and `agy`: in-process, and through the server's `providers` op
//! from the command line.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use common::*;
use harness::auth::Token;
use harness::driver::Driver;
use harness::env::RunEnv;
use harness::providers::{Asked, Standing, check, with_usual};
use harness::server::Server;
use harness::testing::fake_cli;
use harness::work::Setup;

const HARNESS: &str = env!("CARGO_BIN_EXE_harness");

const CATALOG: &str = r#"{"models":[{"slug":"gpt-7","display_name":"GPT-7","visibility":"list","priority":1}]}"#;

/// A home folder whose shell has the fakes on its PATH and a Codex login, `~/.codex-usual`, that is signed in, and an
/// empty login folder, `~/.codex-scratch`.
struct Rig {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    bin: PathBuf,
}

impl Rig {
    fn new() -> Rig {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (home, bin) = (root.join("home"), root.join("bin"));
        std::fs::create_dir_all(home.join(".codex-scratch")).unwrap();
        std::fs::create_dir_all(home.join(".codex-usual")).unwrap();
        std::fs::write(home.join(".codex-usual/signed-in"), "").unwrap();
        fake_cli(&bin.join("claude"), "[ \"$1\" = --version ] && { echo '2.1.316 (Claude Code)'; exit 0; }\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"someone@example.invalid\"}'");
        fake_cli(
            &bin.join("codex"),
            &format!("case \"$1 $2\" in\n--version*) echo 'codex-cli 0.165.0';;\n'login status') if [ -e \"$CODEX_HOME/signed-in\" ]; then echo 'Logged in using ChatGPT' >&2; else echo 'Not logged in' >&2; exit 1; fi;;\n'debug models') echo '{CATALOG}';;\nesac"),
        );
        fake_cli(&bin.join("agy"), "[ \"$1\" = --version ] && echo '1.5.14'");
        Rig { _tmp: tmp, home, data: root.join("data"), bin }
    }

    fn setup(&self) -> Setup {
        let shell = RunEnv::from_pairs([
            ("PATH", format!("{}:/usr/bin:/bin", self.bin.display())),
            ("CODEX_HOME", self.home.join(".codex-usual").display().to_string()),
        ]);
        Setup::new(Some(self.home.clone()), self.data.clone()).with_shell_env(shell)
    }
}

fn scratch() -> Asked {
    Asked { provider: "codex".into(), folder: Some("~/.codex-scratch".into()) }
}

fn states(seen: &[Standing]) -> Vec<(String, Option<String>, String)> {
    seen.iter().map(|s| (s.provider.clone(), s.folder.clone(), s.state.clone())).collect()
}

fn expected() -> Vec<(String, Option<String>, String)> {
    vec![
        ("claude".into(), None, "ready".into()),
        ("codex".into(), None, "ready".into()),
        ("gemini".into(), None, "error".into()),
        ("codex".into(), Some("~/.codex-scratch".into()), "not_signed_in".into()),
    ]
}

#[tokio::test]
async fn providers_reports_each_usual_login_and_each_folder_asked_for_in_one_call() {
    let rig = Rig::new();
    let setup = rig.setup();
    let seen = check(&setup, setup.places(), &with_usual(vec![scratch()])).await;
    assert_eq!(states(&seen), expected());
    let [claude, codex, gemini, empty] = <[Standing; 4]>::try_from(seen).unwrap();
    assert_eq!((claude.version.as_deref(), claude.models.len()), (Some("2.1.316"), 5));
    assert_eq!(codex.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "gpt-7"], "a signed-in Codex lists its own");
    assert_eq!((gemini.version.as_deref(), gemini.installed), (Some("1.5.14"), true));
    assert_eq!(empty.fix.as_deref(), Some("CODEX_HOME=~/.codex-scratch codex login"));
    assert_eq!(empty.models.len(), 5, "a signed-out Codex offers the built-in list");
}

#[tokio::test]
async fn providers_a_folder_the_harness_cannot_use_is_an_error_and_runs_nothing() {
    let rig = Rig::new();
    let setup = rig.setup();
    let asked = [Asked { provider: "codex".into(), folder: Some("~/.codex-missing".into()) }, Asked { provider: "gemini".into(), folder: Some("~/.codex-scratch".into()) }, Asked { provider: "nobody".into(), folder: None }];
    let seen = check(&setup, setup.places(), &asked).await;
    assert!(seen.iter().all(|s| s.state == "error" && s.version.is_none()), "{:?}", states(&seen));
}

#[tokio::test]
async fn providers_from_the_command_line_go_through_the_servers_op() {
    let rig = Rig::new();
    let token = Token::random();
    let first = token.clone();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(Seer::default()))];
    let server = Server::bind_with(&rig.data, move || Some(first), drivers, settings(4), rig.setup()).unwrap();
    let task = tokio::spawn(server.run());
    let (data, hex) = (rig.data.clone(), token.hex());
    let out = tokio::task::spawn_blocking(move || command_line(&data, &hex)).await.unwrap();
    task.abort();
    assert!(out.status.success(), "exit {}", out.status);
    let lines: Vec<String> = String::from_utf8(out.stdout).unwrap().lines().map(str::to_owned).collect();
    let printed: Vec<(String, Option<String>, String)> = lines
        .iter()
        .map(|line| {
            let mut words = line.split(' ');
            let (provider, folder, _version, state) = (words.next().unwrap(), words.next().unwrap(), words.next().unwrap(), words.next().unwrap());
            let folder = (!folder.starts_with('(')).then(|| folder.to_owned());
            (provider.to_owned(), folder, state.trim_end_matches(':').to_owned())
        })
        .collect();
    assert_eq!(printed, expected());
}

fn command_line(data: &Path, token: &str) -> std::process::Output {
    let mut child = std::process::Command::new(HARNESS)
        .args(["providers", "--token-stdin", "--login", "codex=~/.codex-scratch", "--data"])
        .arg(data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{token}").unwrap();
    child.wait_with_output().unwrap()
}

#[tokio::test]
async fn providers_one_call_names_at_most_sixteen_logins() {
    let rig = Rig::new();
    let token = Token::random();
    let first = token.clone();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(Seer::default()))];
    let server = Server::bind_with(&rig.data, move || Some(first), drivers, settings(4), rig.setup()).unwrap();
    let task = tokio::spawn(server.run());
    let mut client = harness::client::Client::connect(&rig.data, &token).await.unwrap();
    let asked = |n: usize| harness::api::Op::Providers { logins: vec![scratch(); n] };
    assert!(client.call(asked(harness::server::MAX_LOGINS_ASKED + 1)).await.is_err(), "one more is refused before any CLI runs");
    let answer = client.call(asked(harness::server::MAX_LOGINS_ASKED)).await.unwrap();
    assert_eq!(answer["logins"].as_array().unwrap().len(), 3 + harness::server::MAX_LOGINS_ASKED);
    task.abort();
}
