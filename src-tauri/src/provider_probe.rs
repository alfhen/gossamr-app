//! What a provider's CLI says about its login: `claude auth status --json`, `codex login status`.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command;

use crate::connections::Driver;
use crate::probe::{Snapshot, State};
use crate::runs::env::RunEnv;

pub const VERSION_TIMEOUT: Duration = Duration::from_secs(20);
pub const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone, Copy)]
pub struct Timeouts {
    pub version: Duration,
    pub account: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self { version: VERSION_TIMEOUT, account: ACCOUNT_TIMEOUT }
    }
}

/// An instance's folder: as typed, for the messages, and expanded, for the disk.
#[derive(Clone, Copy)]
pub struct Folder<'a> {
    pub typed: &'a str,
    pub path: &'a Path,
}

pub fn off() -> Snapshot {
    Snapshot::new(State::Off, "Off. Pip and agents don't use it.")
}

pub fn error(message: impl Into<String>) -> Snapshot {
    Snapshot::new(State::Error, message)
}

/// Asks the CLI of `driver` how its login stands. `env` is the instance's whole environment. Nothing the CLI prints
/// is kept except the few words below that name the login.
pub async fn probe(driver: Driver, binary: Option<&Path>, folder: Option<Folder<'_>>, env: &RunEnv, timeouts: Timeouts) -> Snapshot {
    if driver == Driver::Codex {
        if let Some(folder) = folder.filter(|f| !f.path.is_dir()) {
            return error(format!("The folder {} is gone.", folder.typed));
        }
    }
    let Some(binary) = binary else {
        return Snapshot { installed: false, ..Snapshot::new(State::NotFound, format!("`{}` isn't installed.", driver.binary())) };
    };
    let version = match run(binary, &["--version"], env, timeouts.version).await {
        Ran::Done { code: Some(0), stdout, .. } => version_of(&stdout),
        other => return failed(driver, &other),
    };
    let answer = match driver {
        Driver::Claude => claude_account(binary, folder, env, timeouts.account).await,
        Driver::Codex => codex_account(binary, folder, env, timeouts.account).await,
    };
    Snapshot { version, ..answer }
}

enum Ran {
    TimedOut,
    Failed,
    Done { code: Option<i32>, stdout: String, stderr: String },
}

/// The most of a CLI's stdout or stderr that is kept. The login lines are a few hundred bytes.
const KEPT_BYTES: u64 = 64 * 1024;

/// Keeps the first `KEPT_BYTES` of `pipe` and reads the rest away, so a chatty CLI neither fills memory nor blocks on a full pipe.
async fn capped(mut pipe: impl tokio::io::AsyncRead + Unpin, limit: u64) -> String {
    use tokio::io::AsyncReadExt;
    let mut kept = Vec::new();
    let _ = (&mut pipe).take(limit).read_to_end(&mut kept).await;
    let _ = tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await;
    String::from_utf8_lossy(&kept).into_owned()
}

/// Runs without a shell and without input, and stops the process after `timeout`.
async fn run(binary: &Path, args: &[&str], env: &RunEnv, timeout: Duration) -> Ran {
    let mut command = std::process::Command::new(binary);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    env.apply(&mut command);
    let mut command = Command::from(command);
    command.kill_on_drop(true);
    let Ok(mut child) = command.spawn() else { return Ran::Failed };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else { return Ran::Failed };
    match tokio::time::timeout(timeout, async { tokio::join!(capped(stdout, KEPT_BYTES), capped(stderr, KEPT_BYTES), child.wait()) }).await {
        Err(_) => Ran::TimedOut,
        Ok((_, _, Err(_))) => Ran::Failed,
        Ok((stdout, stderr, Ok(status))) => Ran::Done { code: status.code(), stdout, stderr },
    }
}

/// A run that gave no answer to read. A timeout and a failure to run are both "couldn't check", never "not signed in".
fn failed(driver: Driver, ran: &Ran) -> Snapshot {
    match ran {
        Ran::TimedOut => error(format!("{} didn't answer in time. Check again.", driver.label())),
        _ => couldnt_check(driver),
    }
}

fn couldnt_check(driver: Driver) -> Snapshot {
    error(format!("Couldn't check {}.", driver.label()))
}

/// The first word that starts with a digit: `2.1.316 (Claude Code)` and `codex-cli 0.46.0` both give their number.
fn version_of(output: &str) -> Option<String> {
    output.lines().next()?.split_whitespace().find(|w| w.starts_with(|c: char| c.is_ascii_digit())).map(String::from)
}

/// What a person types to sign in, for the detail pane to show. Terminal never runs this text.
fn sign_in_command(driver: Driver, folder: Option<Folder<'_>>) -> String {
    let login = match driver {
        Driver::Claude => "claude auth login",
        Driver::Codex => "codex login",
    };
    match folder {
        None => login.to_string(),
        Some(f) if f.typed.chars().all(|c| c.is_ascii_alphanumeric() || "._~/-".contains(c)) => format!("{}={} {login}", driver.folder_variable(), f.typed),
        Some(f) => match f.typed.strip_prefix("~/") {
            Some(rest) => format!("{}=~/'{rest}' {login}", driver.folder_variable()),
            None => format!("{}='{}' {login}", driver.folder_variable(), f.typed),
        },
    }
}

fn not_signed_in(driver: Driver, folder: Option<Folder<'_>>) -> Snapshot {
    Snapshot::new(State::NotSignedIn, format!("Not signed in to {}.", driver.label())).fix(sign_in_command(driver, folder))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeStatus {
    logged_in: bool,
    auth_method: Option<String>,
    api_provider: Option<String>,
    email: Option<String>,
}

impl ClaudeStatus {
    /// Who the login is, for the line after "Authenticated". An API key or a third-party provider is named as that,
    /// and with no folder it is the shell's, because a folder drops every login variable the shell has.
    fn login(&self, from_shell: bool) -> String {
        let source = if from_shell { " from your shell" } else { "" };
        let provider = match self.api_provider.as_deref() {
            Some("bedrock") => Some("Amazon Bedrock"),
            Some("vertex") => Some("Google Vertex AI"),
            Some("foundry") => Some("Microsoft Foundry"),
            Some("firstParty") | None => None,
            Some(_) => Some("another provider"),
        };
        if let Some(provider) = provider {
            return format!("{provider}{source}");
        }
        if self.auth_method.as_deref().is_some_and(|m| m.to_ascii_lowercase().replace('_', "").contains("apikey")) {
            return format!("API key{source}");
        }
        self.email.clone().unwrap_or_else(|| "Claude".into())
    }
}

async fn claude_account(binary: &Path, folder: Option<Folder<'_>>, env: &RunEnv, timeout: Duration) -> Snapshot {
    let ran = run(binary, &["auth", "status", "--json"], env, timeout).await;
    let Ran::Done { stdout, .. } = &ran else { return failed(Driver::Claude, &ran) };
    // Signed out, the CLI still prints the JSON but exits 1, so the exit code says nothing here.
    let Ok(status) = serde_json::from_str::<ClaudeStatus>(stdout) else { return couldnt_check(Driver::Claude) };
    if !status.logged_in {
        return not_signed_in(Driver::Claude, folder);
    }
    let login = status.login(folder.is_none());
    Snapshot { account: status.email.filter(|e| !e.is_empty()), ..Snapshot::new(State::Ready, format!("Authenticated · {login}")) }
}

async fn codex_account(binary: &Path, folder: Option<Folder<'_>>, env: &RunEnv, timeout: Duration) -> Snapshot {
    let ran = run(binary, &["login", "status"], env, timeout).await;
    let Ran::Done { code, stderr, .. } = &ran else { return failed(Driver::Codex, &ran) };
    // `login status` prints on stderr, and that can hold part of an API key, so only the matched prefix is looked at.
    let said = stderr.trim_start();
    match code {
        Some(0) if said.starts_with("Logged in using ChatGPT") => Snapshot::new(State::Ready, "Authenticated · ChatGPT"),
        Some(0) if said.starts_with("API key configured") => Snapshot::new(State::Ready, "Authenticated · API key"),
        Some(1) if said.starts_with("Not logged in") => not_signed_in(Driver::Codex, folder),
        _ => couldnt_check(Driver::Codex),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-provider-probe-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cli(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn only_the_start_of_a_chatty_cli_is_kept_and_the_rest_is_read_away() {
        let big = vec![b'x'; 300_000];
        assert_eq!(capped(&big[..], 100).await.len(), 100);
        assert_eq!(capped(&b"short"[..], 100).await, "short");
        let dir = scratch("chatty");
        let noisy = cli(&dir, "claude", "[ \"$1\" = \"--version\" ] && { echo '2.1.316 (Claude Code)'; exit 0; }\necho '{\"loggedIn\":true,\"email\":\"a@b.c\"}'\nhead -c 3000000 /dev/zero | tr '\\0' x >&2");
        let seen = probe(Driver::Claude, Some(&noisy), None, &env(), Timeouts::default()).await;
        assert_eq!(seen.state, State::Ready);
    }

    fn env() -> RunEnv {
        RunEnv::from_pairs([("PATH", "/usr/bin:/bin")])
    }

    /// A `claude` that answers `--version` and prints `status` then exits with `code` for `auth status --json`.
    fn claude_saying(dir: &Path, status: &str, code: i32) -> PathBuf {
        cli(dir, "claude", &format!("[ \"$1\" = \"--version\" ] && {{ echo '2.1.316 (Claude Code)'; exit 0; }}\ncat <<'JSON'\n{status}\nJSON\nexit {code}"))
    }

    /// A `codex` that answers `--version` and prints `said` on stderr then exits with `code` for `login status`.
    fn codex_saying(dir: &Path, said: &str, code: i32) -> PathBuf {
        cli(dir, "codex", &format!("[ \"$1\" = \"--version\" ] && {{ echo 'codex-cli 0.46.0'; exit 0; }}\necho '{said}' >&2\nexit {code}"))
    }

    async fn claude(binary: &Path, folder: Option<&str>) -> Snapshot {
        let path = folder.map(PathBuf::from);
        let folder = folder.zip(path.as_deref()).map(|(typed, path)| Folder { typed, path });
        probe(Driver::Claude, Some(binary), folder, &env(), Timeouts::default()).await
    }

    async fn codex(binary: &Path) -> Snapshot {
        probe(Driver::Codex, Some(binary), None, &env(), Timeouts::default()).await
    }

    const SIGNED_IN: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"alf@acme.com","orgName":"Acme","subscriptionType":"team","configDirectory":"/Users/x/.claude"}"#;

    #[tokio::test]
    async fn a_signed_in_claude_is_ready_as_its_email_with_its_version() {
        let dir = scratch("claude-ready");
        let seen = claude(&claude_saying(&dir, SIGNED_IN, 0), None).await;
        assert_eq!((seen.state, seen.message.as_str(), seen.account.as_deref(), seen.version.as_deref(), seen.installed), (State::Ready, "Authenticated · alf@acme.com", Some("alf@acme.com"), Some("2.1.316"), true));
        assert_eq!(seen.fix, None);
    }

    #[tokio::test]
    async fn a_signed_out_claude_that_still_prints_json_and_exits_1_is_not_signed_in_with_the_command_to_run() {
        let dir = scratch("claude-out");
        let seen = claude(&claude_saying(&dir, r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#, 1), None).await;
        assert_eq!((seen.state, seen.message.as_str(), seen.fix.as_deref()), (State::NotSignedIn, "Not signed in to Claude.", Some("claude auth login")));
        assert_eq!(seen.account, None);
    }

    #[tokio::test]
    async fn the_sign_in_command_of_an_instance_with_a_folder_names_the_folder_and_quotes_what_needs_it() {
        let dir = scratch("claude-folder");
        let out = r#"{"loggedIn":false}"#;
        let binary = claude_saying(&dir, out, 1);
        assert_eq!(claude(&binary, Some("~/.claude-work")).await.fix.as_deref(), Some("CLAUDE_CONFIG_DIR=~/.claude-work claude auth login"));
        assert_eq!(claude(&binary, Some("/Users/x/My Claude")).await.fix.as_deref(), Some("CLAUDE_CONFIG_DIR='/Users/x/My Claude' claude auth login"));
        assert_eq!(claude(&binary, Some("~/My Claude")).await.fix.as_deref(), Some("CLAUDE_CONFIG_DIR=~/'My Claude' claude auth login"));
    }

    #[tokio::test]
    async fn a_login_from_an_api_key_or_a_cloud_provider_says_so_and_names_the_shell_only_without_a_folder() {
        let dir = scratch("claude-source");
        let key = claude_saying(&dir, r#"{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}"#, 0);
        let seen = claude(&key, None).await;
        assert_eq!((seen.state, seen.message.as_str(), seen.account), (State::Ready, "Authenticated · API key from your shell", None));
        assert_eq!(claude(&key, Some("/Users/x/.claude-work")).await.message, "Authenticated · API key");

        let bedrock = claude_saying(&dir, r#"{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}"#, 0);
        assert_eq!(claude(&bedrock, None).await.message, "Authenticated · Amazon Bedrock from your shell");
        let other = claude_saying(&dir, r#"{"loggedIn":true,"apiProvider":"somethingNew","email":"a@b.c"}"#, 0);
        assert_eq!(claude(&other, None).await.message, "Authenticated · another provider from your shell");
    }

    #[tokio::test]
    async fn claude_answering_with_something_that_is_not_the_status_json_is_an_error_not_a_sign_out() {
        let dir = scratch("claude-garbage");
        for (text, code) in [("not json", 0), ("", 1), (r#"{"unrelated":true}"#, 0), ("Error: boom", 1)] {
            let seen = claude(&claude_saying(&dir, text, code), None).await;
            assert_eq!((seen.state, seen.message.as_str(), seen.fix), (State::Error, "Couldn't check Claude.", None), "{text}");
        }
    }

    #[tokio::test]
    async fn a_claude_whose_version_check_fails_is_an_error_without_asking_who_is_signed_in() {
        let dir = scratch("claude-no-version");
        let asked = dir.join("asked");
        let binary = cli(&dir, "claude", &format!("[ \"$1\" = \"--version\" ] && exit 3\ntouch '{}'\necho '{SIGNED_IN}'", asked.display()));
        let seen = claude(&binary, None).await;
        assert_eq!((seen.state, seen.installed), (State::Error, true));
        assert!(!asked.exists());
    }

    #[tokio::test]
    async fn a_missing_cli_is_not_found_for_either_driver() {
        for driver in [Driver::Claude, Driver::Codex] {
            let seen = probe(driver, None, None, &env(), Timeouts::default()).await;
            assert_eq!((seen.state, seen.installed, seen.message), (State::NotFound, false, format!("`{}` isn't installed.", driver.binary())));
        }
    }

    #[tokio::test]
    async fn a_claude_that_hangs_is_stopped_at_the_timeout_and_is_an_error_whichever_step_hangs() {
        let dir = scratch("claude-hung");
        let hangs_on_version = cli(&dir, "claude", "exec sleep 30");
        let hangs_on_status = cli(&dir, "claude2", "[ \"$1\" = \"--version\" ] && exit 0\nexec sleep 30");
        let quick = Timeouts { version: Duration::from_millis(200), account: Duration::from_millis(200) };
        for binary in [&hangs_on_version, &hangs_on_status] {
            let started = std::time::Instant::now();
            let seen = probe(Driver::Claude, Some(binary), None, &env(), quick).await;
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_eq!((seen.state, seen.message.as_str(), seen.fix), (State::Error, "Claude didn't answer in time. Check again.", None));
        }
    }

    #[tokio::test]
    async fn a_binary_that_cannot_start_is_an_error() {
        let dir = scratch("claude-unrunnable");
        let binary = dir.join("claude");
        std::fs::write(&binary, "#!/nonexistent/interpreter\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(claude(&binary, None).await.state, State::Error);
    }

    #[tokio::test]
    async fn the_cli_runs_with_the_environment_it_is_given_and_nothing_else() {
        let dir = scratch("claude-env");
        let binary = cli(&dir, "claude", &format!("[ \"$1\" = \"--version\" ] && exit 0\nenv > '{}'\necho '{SIGNED_IN}'", dir.join("seen").display()));
        std::env::set_var("GOSSAMR_PROBE_LEAK", "leak");
        let base = RunEnv::from_pairs([("PATH", "/usr/bin:/bin"), ("CLAUDE_CONFIG_DIR", "/Users/x/.claude-work")]);
        probe(Driver::Claude, Some(&binary), None, &base, Timeouts::default()).await;
        std::env::remove_var("GOSSAMR_PROBE_LEAK");
        let seen = std::fs::read_to_string(dir.join("seen")).unwrap();
        assert!(seen.contains("CLAUDE_CONFIG_DIR=/Users/x/.claude-work"), "{seen}");
        assert!(!seen.contains("GOSSAMR_PROBE_LEAK"), "{seen}");
    }

    #[tokio::test]
    async fn codex_logged_in_with_chatgpt_or_a_key_is_ready_and_says_which() {
        let dir = scratch("codex-ready");
        let chatgpt = codex(&codex_saying(&dir, "Logged in using ChatGPT", 0)).await;
        assert_eq!((chatgpt.state, chatgpt.message.as_str(), chatgpt.version.as_deref(), chatgpt.account), (State::Ready, "Authenticated · ChatGPT", Some("0.46.0"), None));
        let key = codex(&codex_saying(&dir, "API key configured", 0)).await;
        assert_eq!((key.state, key.message.as_str()), (State::Ready, "Authenticated · API key"));
    }

    #[tokio::test]
    async fn codex_that_is_not_logged_in_is_not_signed_in_only_for_the_exact_prefix_and_exit() {
        let dir = scratch("codex-out");
        let seen = codex(&codex_saying(&dir, "Not logged in", 1)).await;
        assert_eq!((seen.state, seen.message.as_str(), seen.fix.as_deref()), (State::NotSignedIn, "Not signed in to Codex.", Some("codex login")));
        for (said, code) in [("Not logged in", 0), ("Not logged in", 2), ("not logged in", 1), ("Error: could not read auth.json", 1)] {
            let seen = codex(&codex_saying(&dir, said, code)).await;
            assert_eq!((seen.state, seen.fix), (State::Error, None), "{said} {code}");
        }
    }

    #[tokio::test]
    async fn an_unknown_codex_output_is_an_error_and_the_text_is_kept_nowhere() {
        let dir = scratch("codex-unknown");
        for (said, code) in [("Logged in using sk-proj-SECRET123", 0), ("Logged in using ChatGPT", 1), ("", 0), ("API key configured", 7)] {
            let seen = codex(&codex_saying(&dir, said, code)).await;
            assert_eq!((seen.state, seen.message.as_str()), (State::Error, "Couldn't check Codex."), "{said} {code}");
            assert!(!format!("{seen:?}").contains("SECRET123"));
        }
    }

    #[tokio::test]
    async fn a_ready_codex_snapshot_holds_only_the_matched_prefix() {
        let dir = scratch("codex-prefix");
        let seen = codex(&codex_saying(&dir, "API key configured sk-proj-SECRET123", 0)).await;
        assert_eq!(seen.state, State::Ready);
        assert!(!format!("{seen:?}").contains("SECRET123"));
    }

    #[tokio::test]
    async fn a_codex_folder_that_is_gone_is_an_error_before_anything_runs() {
        let dir = scratch("codex-gone");
        let ran = dir.join("ran");
        let binary = cli(&dir, "codex", &format!("touch '{}'", ran.display()));
        let gone = dir.join("no-such-folder");
        let folder = Folder { typed: "~/.codex-work", path: &gone };
        let seen = probe(Driver::Codex, Some(&binary), Some(folder), &env(), Timeouts::default()).await;
        assert_eq!((seen.state, seen.message.as_str()), (State::Error, "The folder ~/.codex-work is gone."));
        assert!(!ran.exists());

        std::fs::create_dir_all(&gone).unwrap();
        let there = codex_saying(&dir, "Logged in using ChatGPT", 0);
        let seen = probe(Driver::Codex, Some(&there), Some(Folder { typed: "~/.codex-work", path: &gone }), &env(), Timeouts::default()).await;
        assert_eq!(seen.state, State::Ready);
    }

    #[tokio::test]
    async fn a_codex_that_is_a_node_launcher_runs_with_the_node_on_the_environments_path() {
        let dir = scratch("codex-node");
        let node = dir.join("node/bin");
        let nvm = dir.join("nvm/bin");
        std::fs::create_dir_all(&node).unwrap();
        std::fs::create_dir_all(&nvm).unwrap();
        cli(&node, "node", "case \"$3\" in status) echo 'Logged in using ChatGPT' >&2; exit 0;; esac\necho 'codex-cli 9.9.9'");
        let launcher = nvm.join("codex");
        std::fs::write(&launcher, "#!/usr/bin/env node\nlogin\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:/usr/bin:/bin", node.display());
        let seen = probe(Driver::Codex, Some(&launcher), None, &RunEnv::from_pairs([("PATH", path.as_str())]), Timeouts::default()).await;
        assert_eq!((seen.state, seen.version.as_deref()), (State::Ready, Some("9.9.9")));
        let without = probe(Driver::Codex, Some(&launcher), None, &env(), Timeouts::default()).await;
        assert_eq!(without.state, State::Error, "the launcher needs the shell's PATH");
    }

    #[test]
    fn a_version_is_the_first_word_that_starts_with_a_digit() {
        assert_eq!(version_of("2.1.316 (Claude Code)\n").as_deref(), Some("2.1.316"));
        assert_eq!(version_of("codex-cli 0.46.0").as_deref(), Some("0.46.0"));
        assert_eq!(version_of("no number here"), None);
        assert_eq!(version_of(""), None);
    }
}
