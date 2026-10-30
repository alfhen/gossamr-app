//! What each kind of connection says about itself: a probe per instance returns a snapshot, and Settings draws the last one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::auth::find_gh_in;
use crate::error::Error;

/// A probe that takes longer is reported as a failure: `gh` can sit on a Keychain prompt.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// Variables that make `gh` use another token or host than the one stored for the account.
const GH_OVERRIDES: [&str; 3] = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Ready,
    NotSignedIn,
    /// The command line tool isn't installed.
    NotFound,
    /// The probe couldn't tell: no network, a server error, a timeout.
    Error,
    Off,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub installed: bool,
    pub version: Option<String>,
    pub state: State,
    pub account: Option<String>,
    pub message: String,
    /// The command that fixes it, when there is one.
    pub fix: Option<String>,
    pub checked_at: String,
}

impl Snapshot {
    fn new(state: State, message: impl Into<String>) -> Self {
        Self { installed: true, version: None, state, account: None, message: message.into(), fix: None, checked_at: crate::inbox::now_iso() }
    }

    fn fix(mut self, command: impl Into<String>) -> Self {
        self.fix = Some(command.into());
        self
    }

    pub fn off() -> Self {
        Self::new(State::Off, "Off. Gossamr doesn't sync it, Pip can't see it and drafts for it wait.")
    }

    /// Whether `other` says the same thing, whenever it was checked.
    pub fn same_as(&self, other: &Snapshot) -> bool {
        Snapshot { checked_at: String::new(), ..self.clone() } == Snapshot { checked_at: String::new(), ..other.clone() }
    }

    /// A probe that couldn't tell keeps the account the last one found: failing to look is not a different account.
    pub fn keeping_account_of(mut self, previous: Option<&Snapshot>) -> Self {
        if self.state == State::Error && self.account.is_none() {
            self.account = previous.and_then(|p| p.account.clone());
        }
        self
    }
}

pub fn jira(outcome: Option<crate::error::Result<crate::auth::Account>>) -> Snapshot {
    match outcome {
        None => Snapshot::new(State::Error, "Jira didn't answer in time."),
        Some(Ok(me)) => Snapshot { account: Some(me.name.clone()), ..Snapshot::new(State::Ready, format!("Signed in as {}", me.name)) },
        Some(Err(Error::NotSignedIn)) => Snapshot::new(State::NotSignedIn, "Not signed in to Jira."),
        Some(Err(e)) if e.needs_reauth() || matches!(e, Error::Api { status: 401, .. }) => Snapshot::new(State::NotSignedIn, "Atlassian ended the sign-in."),
        Some(Err(e)) => Snapshot::new(State::Error, e.to_string()),
    }
}

/// A GitHub account connected by token or browser sign-in, judged by whether GitHub accepts the stored token.
pub fn github_token(login: &str, outcome: Option<crate::error::Result<crate::codehost::CodeAccount>>) -> Snapshot {
    match outcome {
        None => Snapshot::new(State::Error, "GitHub didn't answer in time."),
        Some(Ok(me)) => Snapshot { account: Some(me.login.clone()), ..Snapshot::new(State::Ready, format!("Signed in as {}", me.login)) },
        Some(Err(e)) if e.is_unauthorized() => Snapshot::new(State::NotSignedIn, format!("GitHub no longer accepts the token for {login}.")),
        Some(Err(e)) => Snapshot::new(State::Error, e.to_string()),
    }
}

#[derive(Deserialize)]
struct Status {
    #[serde(default)]
    hosts: HashMap<String, Vec<Entry>>,
}

#[derive(Deserialize)]
struct Entry {
    state: String,
    login: String,
    /// What failed when `state` is `error`: `HTTP 401: Bad credentials` for a refused token, a connection error offline.
    error: Option<String>,
}

impl Entry {
    fn token_refused(&self) -> bool {
        self.error.as_deref().is_some_and(|e| e.starts_with("HTTP 401"))
    }
}

enum Ran {
    TimedOut,
    Failed,
    Output { ok: bool, stdout: String },
}

/// Runs `gh` without a shell, with the overrides cleared and no input, and stops it after `timeout`.
async fn run_gh(gh: &Path, args: &[&str], timeout: Duration) -> Ran {
    let mut command = Command::new(gh);
    command.args(args).stdin(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    for name in GH_OVERRIDES {
        command.env_remove(name);
    }
    match tokio::time::timeout(timeout, command.output()).await {
        Err(_) => Ran::TimedOut,
        Ok(Err(_)) => Ran::Failed,
        Ok(Ok(out)) => Ran::Output { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned() },
    }
}

fn version_of(output: &str) -> Option<String> {
    output.lines().next()?.strip_prefix("gh version ")?.split_whitespace().next().map(String::from)
}

/// Asks `gh` about `login` on `host`, never about the active account.
pub async fn github(gh_dirs: &[PathBuf], host: &str, login: &str, timeout: Duration) -> Snapshot {
    let Some(gh) = find_gh_in(gh_dirs) else {
        return Snapshot { installed: false, ..Snapshot::new(State::NotFound, "gh isn't installed.").fix("brew install gh") };
    };
    let (version, status) = tokio::join!(run_gh(&gh, &["--version"], timeout), run_gh(&gh, &["auth", "status", "--json", "hosts"], timeout));
    let version = match version {
        Ran::Output { stdout, .. } => version_of(&stdout),
        _ => None,
    };
    let login_command = format!("gh auth login -h {host}");
    let snapshot = match status {
        Ran::TimedOut => Snapshot::new(State::Error, "gh didn't answer in time. If macOS is asking for Keychain access, allow it, then check again.").fix("gh auth status"),
        Ran::Failed => Snapshot::new(State::Error, "Gossamr couldn't run gh."),
        Ran::Output { ok: false, .. } => Snapshot::new(State::Error, "This version of gh can't report its logins. Update it, then check again.").fix("brew upgrade gh"),
        Ran::Output { stdout, .. } => match serde_json::from_str::<Status>(&stdout) {
            Err(_) => Snapshot::new(State::Error, "gh gave an answer Gossamr couldn't read."),
            Ok(status) => {
                let entry = status.hosts.iter().filter(|(h, _)| h.eq_ignore_ascii_case(host)).flat_map(|(_, entries)| entries).find(|e| e.login.eq_ignore_ascii_case(login));
                match entry {
                    None => Snapshot::new(State::NotSignedIn, format!("gh has no login for {login} on {host}.")).fix(login_command),
                    Some(e) if e.state == "success" => Snapshot { account: Some(e.login.clone()), ..Snapshot::new(State::Ready, format!("Signed in as {} on {host}", e.login)) },
                    Some(e) if e.state == "timeout" => Snapshot::new(State::Error, format!("gh couldn't reach {host}.")),
                    Some(e) if e.token_refused() => Snapshot::new(State::NotSignedIn, format!("gh's token for {login} on {host} no longer works.")).fix(login_command),
                    Some(_) => Snapshot::new(State::Error, format!("gh couldn't check its token for {login} on {host}.")),
                }
            }
        },
    };
    Snapshot { version, ..snapshot }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Account;
    use std::os::unix::fs::PermissionsExt;

    const READY: &str = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"Alfhen","tokenSource":"keyring"},{"state":"error","active":false,"host":"github.com","login":"old","error":"HTTP 401: Bad credentials"}]}}"#;

    fn gh_dir(name: &str, script: &str) -> Vec<PathBuf> {
        let dir = std::env::temp_dir().join(format!("gossamr-probe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        vec![dir]
    }

    fn gh_saying(name: &str, status: &str) -> Vec<PathBuf> {
        gh_dir(name, &format!("[ \"$1\" = \"--version\" ] && {{ echo 'gh version 2.97.0 (2026-07-31)'; exit 0; }}\ncat <<'JSON'\n{status}\nJSON"))
    }

    async fn probe(dirs: &[PathBuf], login: &str) -> Snapshot {
        github(dirs, "github.com", login, Duration::from_secs(5)).await
    }

    #[tokio::test]
    async fn a_login_gh_knows_is_ready_whatever_its_case_and_reports_gh_s_version() {
        let seen = probe(&gh_saying("ready", READY), "alfhen").await;
        assert_eq!((seen.state, seen.account.as_deref(), seen.version.as_deref(), seen.installed), (State::Ready, Some("Alfhen"), Some("2.97.0"), true));
        assert_eq!(seen.fix, None);
    }

    #[tokio::test]
    async fn the_login_in_the_config_is_probed_not_the_active_account() {
        let seen = probe(&gh_saying("inactive", READY), "old").await;
        assert_eq!(seen.state, State::NotSignedIn);
        assert_eq!(seen.fix.as_deref(), Some("gh auth login -h github.com"));
    }

    #[tokio::test]
    async fn a_login_gh_does_not_have_is_not_signed_in_with_the_command_to_run() {
        let seen = probe(&gh_saying("missing", r#"{"hosts":{}}"#), "alfhen").await;
        assert_eq!((seen.state, seen.message.as_str()), (State::NotSignedIn, "gh has no login for alfhen on github.com."));
        assert_eq!(seen.fix.as_deref(), Some("gh auth login -h github.com"));
    }

    #[tokio::test]
    async fn gh_not_being_installed_is_not_found_with_how_to_install_it() {
        let seen = probe(&[std::env::temp_dir().join("gossamr-probe-nowhere")], "alfhen").await;
        assert_eq!((seen.state, seen.installed, seen.fix.as_deref()), (State::NotFound, false, Some("brew install gh")));
    }

    #[tokio::test]
    async fn gh_being_unable_to_reach_github_is_an_error_not_a_sign_out() {
        let status = r#"{"hosts":{"github.com":[{"state":"timeout","host":"github.com","login":"alfhen"}]}}"#;
        let seen = probe(&gh_saying("offline", status), "alfhen").await;
        assert_eq!(seen.state, State::Error);
        assert_eq!(seen.fix, None);
    }

    #[tokio::test]
    async fn a_token_github_refused_is_not_signed_in() {
        let status = r#"{"hosts":{"github.com":[{"state":"error","host":"github.com","login":"alfhen","error":"HTTP 401: Bad credentials (https://api.github.com/)"}]}}"#;
        assert_eq!(probe(&gh_saying("revoked", status), "alfhen").await.state, State::NotSignedIn);
    }

    #[tokio::test]
    async fn a_request_that_failed_for_another_reason_is_an_error_that_keeps_the_account() {
        for error in [r#""Get \"https://api.github.com/\": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused""#, r#""HTTP 503: Service Unavailable""#, "null"] {
            let status = format!(r#"{{"hosts":{{"github.com":[{{"state":"error","host":"github.com","login":"alfhen","error":{error}}}]}}}}"#);
            let seen = probe(&gh_saying("unreachable", &status), "alfhen").await;
            assert_eq!((seen.state, seen.fix.as_deref()), (State::Error, None));
            let before = Snapshot { account: Some("alfhen".into()), ..Snapshot::new(State::Ready, "") };
            assert_eq!(seen.keeping_account_of(Some(&before)).account.as_deref(), Some("alfhen"));
        }
    }

    #[tokio::test]
    async fn a_gh_that_waits_forever_is_stopped_at_the_timeout() {
        let dirs = gh_dir("hung", "sleep 30");
        let started = std::time::Instant::now();
        let seen = github(&dirs, "github.com", "alfhen", Duration::from_millis(200)).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(seen.state, State::Error);
        assert!(seen.message.contains("Keychain"));
    }

    #[tokio::test]
    async fn an_old_gh_without_json_output_asks_to_be_updated() {
        let dirs = gh_dir("old", "echo 'unknown flag: --json' >&2; exit 1");
        let seen = probe(&dirs, "alfhen").await;
        assert_eq!((seen.state, seen.fix.as_deref()), (State::Error, Some("brew upgrade gh")));
    }

    #[tokio::test]
    async fn gh_runs_without_the_variables_that_override_its_stored_token() {
        let dirs = gh_dir("env", &format!("[ -n \"$GH_TOKEN$GITHUB_TOKEN$GH_HOST\" ] && echo 'overridden' && exit 0\n[ \"$1\" = \"--version\" ] && exit 0\necho '{READY}'"));
        std::env::set_var("GH_TOKEN", "from-the-environment");
        let seen = probe(&dirs, "alfhen").await;
        std::env::remove_var("GH_TOKEN");
        assert_eq!(seen.state, State::Ready);
    }

    #[test]
    fn a_token_account_is_judged_by_github_not_by_gh() {
        let ok = crate::codehost::CodeAccount { login: "ann".into(), name: None, avatar_url: None, scopes: None };
        assert_eq!(github_token("ann", Some(Ok(ok))).account.as_deref(), Some("ann"));
        let refused = github_token("ann", Some(Err(Error::CodeHost { status: 401, message: "Bad credentials".into() })));
        assert_eq!((refused.state, refused.fix), (State::NotSignedIn, None));
        assert_eq!(github_token("ann", Some(Err(Error::Api { status: 503, message: "down".into() }))).state, State::Error);
        assert_eq!(github_token("ann", None).state, State::Error);
    }

    fn me() -> Account {
        Account { account_id: "u1".into(), name: "Ann".into(), avatar_url: None }
    }

    #[test]
    fn jira_answering_for_the_saved_session_is_ready_as_that_account() {
        let seen = jira(Some(Ok(me())));
        assert_eq!((seen.state, seen.account.as_deref()), (State::Ready, Some("Ann")));
    }

    #[test]
    fn jira_refusing_the_token_is_not_signed_in_and_a_server_error_is_only_an_error() {
        for refusal in [Error::ReauthRequired, Error::Api { status: 401, message: "no".into() }, Error::NotSignedIn] {
            assert_eq!(jira(Some(Err(refusal))).state, State::NotSignedIn);
        }
        assert_eq!(jira(Some(Err(Error::Api { status: 503, message: "down".into() }))).state, State::Error);
        assert_eq!(jira(None).state, State::Error);
    }

    #[test]
    fn a_probe_that_could_not_tell_keeps_the_account_found_before() {
        let before = jira(Some(Ok(me())));
        let failed = jira(None).keeping_account_of(Some(&before));
        assert_eq!((failed.state, failed.account.as_deref()), (State::Error, Some("Ann")));
        let refused = jira(Some(Err(Error::ReauthRequired))).keeping_account_of(Some(&before));
        assert_eq!(refused.account, None);
    }

    #[test]
    fn a_snapshot_checked_again_with_the_same_answer_is_the_same() {
        let a = jira(Some(Ok(me())));
        let mut b = a.clone();
        b.checked_at = "later".into();
        assert!(a.same_as(&b));
        assert!(!a.same_as(&jira(None)));
    }
}
