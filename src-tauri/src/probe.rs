//! What each kind of connection says about itself: a probe per instance returns a snapshot, and Settings draws the last one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use chrono::NaiveDate;

use crate::auth::{find_gh_in, EXPIRY_WARNING_DAYS};
use crate::error::Error;

/// A probe that takes longer is reported as a failure: `gh` can sit on a Keychain prompt.
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// What Terminal runs to add another account, and what a probe offers as the fix for a missing login.
pub const GH_LOGIN_COMMAND: &str = "gh auth login -h github.com";

/// Variables that make `gh` use another token or host than the one stored for the account.
pub(crate) const GH_OVERRIDES: [&str; 3] = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Ready,
    /// Works, but the API token is within `EXPIRY_WARNING_DAYS` of the expiry date the person gave.
    ExpiresSoon,
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

/// `expires_on` is the date the person gave when they pasted the token; Atlassian doesn't report it.
pub fn jira(outcome: Option<crate::error::Result<crate::auth::Account>>, expires_on: Option<NaiveDate>, today: NaiveDate) -> Snapshot {
    match outcome {
        None => Snapshot::new(State::Error, "Jira didn't answer in time."),
        Some(Ok(me)) => {
            let account = Some(me.name.clone());
            let days_left = expires_on.map(|on| (on - today).num_days()).filter(|days| *days <= EXPIRY_WARNING_DAYS);
            match (days_left, expires_on) {
                (Some(days), Some(on)) if days < 0 => Snapshot { account, ..Snapshot::new(State::ExpiresSoon, format!("Token was due to expire on {}. Make a new one and paste it here.", on.format("%-d %b"))) },
                (Some(days), _) => Snapshot { account, ..Snapshot::new(State::ExpiresSoon, format!("Token expires in {days} {}", if days == 1 { "day" } else { "days" })) },
                (None, _) => Snapshot { account, ..Snapshot::new(State::Ready, format!("Signed in as {}", me.name)) },
            }
        }
        Some(Err(Error::NotSignedIn)) => Snapshot::new(State::NotSignedIn, "Not signed in to Jira."),
        Some(Err(e)) if e.needs_reauth() || matches!(e, Error::Api { status: 401, .. }) => Snapshot::new(State::NotSignedIn, "Jira turned down your token. Make a new one and paste it here."),
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
    #[serde(default)]
    active: bool,
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

/// Runs `gh auth status` and `gh --version`. A failure is already the snapshot to show.
async fn ask_gh(gh_dirs: &[PathBuf], timeout: Duration) -> Result<(Option<String>, Status), Box<Snapshot>> {
    let Some(gh) = find_gh_in(gh_dirs) else {
        return Err(Box::new(Snapshot { installed: false, ..Snapshot::new(State::NotFound, "gh isn't installed.").fix("brew install gh") }));
    };
    let (version, status) = tokio::join!(run_gh(&gh, &["--version"], timeout), run_gh(&gh, &["auth", "status", "--json", "hosts"], timeout));
    let version = match version {
        Ran::Output { stdout, .. } => version_of(&stdout),
        _ => None,
    };
    let failed = |snapshot: Snapshot| Err(Box::new(Snapshot { version: version.clone(), ..snapshot }));
    match status {
        Ran::TimedOut => failed(Snapshot::new(State::Error, "gh didn't answer in time. If macOS is asking for Keychain access, allow it, then check again.").fix("gh auth status")),
        Ran::Failed => failed(Snapshot::new(State::Error, "Gossamr couldn't run gh.")),
        Ran::Output { ok: false, .. } => failed(Snapshot::new(State::Error, "This version of gh can't report its logins. Update it, then check again.").fix("brew upgrade gh")),
        Ran::Output { stdout, .. } => match serde_json::from_str::<Status>(&stdout) {
            Err(_) => failed(Snapshot::new(State::Error, "gh gave an answer Gossamr couldn't read.")),
            Ok(parsed) => Ok((version.clone(), parsed)),
        },
    }
}

/// Asks `gh` about `login` on `host`, never about the active account.
pub async fn github(gh_dirs: &[PathBuf], host: &str, login: &str, timeout: Duration) -> Snapshot {
    let (version, status) = match ask_gh(gh_dirs, timeout).await {
        Ok(asked) => asked,
        Err(snapshot) => return *snapshot,
    };
    let login_command = format!("gh auth login -h {host}");
    let entry = status.hosts.iter().filter(|(h, _)| h.eq_ignore_ascii_case(host)).flat_map(|(_, entries)| entries).find(|e| e.login.eq_ignore_ascii_case(login));
    let snapshot = match entry {
        None => Snapshot::new(State::NotSignedIn, format!("gh has no login for {login} on {host}.")).fix(login_command),
        Some(e) if e.state == "success" => Snapshot { account: Some(e.login.clone()), ..Snapshot::new(State::Ready, format!("gh is signed in as {} on {host}", e.login)) },
        Some(e) if e.state == "timeout" => Snapshot::new(State::Error, format!("gh couldn't reach {host}.")),
        Some(e) if e.token_refused() => Snapshot::new(State::NotSignedIn, format!("gh's token for {login} on {host} no longer works.")).fix(login_command),
        Some(_) => Snapshot::new(State::Error, format!("gh couldn't check its token for {login} on {host}.")),
    };
    Snapshot { version, ..snapshot }
}

/// Before any connection exists, no login is named, so this reports the account `gh` has active on `host`.
/// Only that account counts: `gh auth token` and gh's git credentials come from it, so a working inactive login must not hide a broken active one.
pub async fn github_first_run(gh_dirs: &[PathBuf], host: &str, timeout: Duration) -> Snapshot {
    let (version, status) = match ask_gh(gh_dirs, timeout).await {
        Ok(asked) => asked,
        Err(snapshot) => return *snapshot,
    };
    let entries: Vec<&Entry> = status.hosts.iter().filter(|(h, _)| h.eq_ignore_ascii_case(host)).flat_map(|(_, entries)| entries).collect();
    let login_command = format!("gh auth login -h {host}");
    let active = entries.iter().copied().find(|e| e.active).or(if let [only] = entries[..] { Some(only) } else { None });
    let snapshot = match active {
        None if entries.is_empty() => Snapshot::new(State::NotSignedIn, format!("gh has no login on {host}.")).fix(login_command),
        None => Snapshot::new(State::Error, format!("gh has no active login on {host}.")).fix(format!("gh auth switch -h {host}")),
        Some(e) if e.state == "success" => Snapshot { account: Some(e.login.clone()), ..Snapshot::new(State::Ready, format!("gh is signed in as {} on {host}", e.login)) },
        Some(e) if e.state == "timeout" => Snapshot::new(State::Error, format!("gh couldn't reach {host}.")),
        Some(e) if e.token_refused() => Snapshot::new(State::NotSignedIn, format!("gh's token for {} on {host} no longer works.", e.login)).fix(login_command),
        Some(_) => Snapshot::new(State::Error, format!("gh couldn't check its login on {host}.")),
    };
    Snapshot { version, ..snapshot }
}

/// A login `gh` holds on a host. `usable` is false only when GitHub refused its token; offline is not a sign-out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccount {
    pub login: String,
    pub active: bool,
    pub usable: bool,
}

/// The logins `gh` holds on a host. `message` and `fix` say what is missing when there are none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccounts {
    pub installed: bool,
    pub accounts: Vec<GhAccount>,
    pub message: Option<String>,
    pub fix: Option<String>,
}

/// Lists every login `gh` holds on `host`, the active one first.
pub async fn github_accounts(gh_dirs: &[PathBuf], host: &str, timeout: Duration) -> GhAccounts {
    let status = match ask_gh(gh_dirs, timeout).await {
        Ok((_, status)) => status,
        Err(snapshot) => return GhAccounts { installed: snapshot.installed, accounts: Vec::new(), message: Some(snapshot.message), fix: snapshot.fix },
    };
    let mut accounts: Vec<GhAccount> = status
        .hosts
        .iter()
        .filter(|(h, _)| h.eq_ignore_ascii_case(host))
        .flat_map(|(_, entries)| entries)
        .map(|e| GhAccount { login: e.login.clone(), active: e.active, usable: !e.token_refused() })
        .collect();
    accounts.sort_by_key(|a| !a.active);
    let empty = accounts.is_empty();
    GhAccounts { installed: true, accounts, message: empty.then(|| format!("gh has no login on {host}.")), fix: empty.then(|| GH_LOGIN_COMMAND.to_string()) }
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
    async fn before_any_login_is_named_the_account_gh_has_active_is_the_one_reported() {
        let both = r#"{"hosts":{"github.com":[{"state":"success","active":false,"host":"github.com","login":"other"},{"state":"success","active":true,"host":"github.com","login":"Alfhen"}]}}"#;
        let seen = github_first_run(&gh_saying("first-run", both), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.account.as_deref(), seen.version.as_deref(), seen.fix), (State::Ready, Some("Alfhen"), Some("2.97.0"), None));
    }

    #[tokio::test]
    async fn before_any_login_is_named_a_gh_with_no_login_is_not_signed_in_with_the_command_to_run() {
        let seen = github_first_run(&gh_saying("first-run-none", r#"{"hosts":{}}"#), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.fix.as_deref()), (State::NotSignedIn, Some("gh auth login -h github.com")));
    }

    #[tokio::test]
    async fn before_any_login_is_named_a_missing_gh_is_not_found_and_a_refused_token_is_not_signed_in() {
        let gone = github_first_run(&[std::env::temp_dir().join("gossamr-probe-nowhere")], "github.com", Duration::from_secs(5)).await;
        assert_eq!((gone.state, gone.fix.as_deref()), (State::NotFound, Some("brew install gh")));
        let refused = r#"{"hosts":{"github.com":[{"state":"error","active":true,"host":"github.com","login":"alfhen","error":"HTTP 401: Bad credentials"}]}}"#;
        let seen = github_first_run(&gh_saying("first-run-refused", refused), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.account), (State::NotSignedIn, None));
    }

    #[tokio::test]
    async fn before_any_login_is_named_a_refused_active_account_is_not_hidden_by_a_working_inactive_one() {
        let status = r#"{"hosts":{"github.com":[{"state":"error","active":true,"host":"github.com","login":"work","error":"HTTP 401: Bad credentials"},{"state":"success","active":false,"host":"github.com","login":"personal"}]}}"#;
        let seen = github_first_run(&gh_saying("first-run-inactive-works", status), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.account, seen.fix.as_deref()), (State::NotSignedIn, None, Some("gh auth login -h github.com")));
        assert!(seen.message.contains("work"));
    }

    #[tokio::test]
    async fn before_any_login_is_named_logins_with_none_active_are_not_guessed_between() {
        let status = r#"{"hosts":{"github.com":[{"state":"success","host":"github.com","login":"a"},{"state":"success","host":"github.com","login":"b"}]}}"#;
        let seen = github_first_run(&gh_saying("first-run-none-active", status), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.account, seen.fix.as_deref()), (State::Error, None, Some("gh auth switch -h github.com")));
    }

    #[tokio::test]
    async fn before_any_login_is_named_the_only_login_is_the_one_reported_even_when_gh_does_not_say_it_is_active() {
        let status = r#"{"hosts":{"github.com":[{"state":"success","host":"github.com","login":"solo"}]}}"#;
        let seen = github_first_run(&gh_saying("first-run-solo", status), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.account.as_deref()), (State::Ready, Some("solo")));
    }

    #[tokio::test]
    async fn before_any_login_is_named_a_gh_that_cannot_reach_github_is_an_error_not_a_sign_out() {
        let offline = r#"{"hosts":{"github.com":[{"state":"timeout","active":true,"host":"github.com","login":"alfhen"}]}}"#;
        let seen = github_first_run(&gh_saying("first-run-offline", offline), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.state, seen.fix), (State::Error, None));
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

    #[test]
    fn a_gh_file_that_cannot_run_does_not_hide_one_that_can() {
        let blocked = gh_dir("blocked", "exit 1");
        std::fs::set_permissions(blocked[0].join("gh"), std::fs::Permissions::from_mode(0o644)).unwrap();
        let working = gh_dir("working", "exit 0");
        let dirs = [blocked[0].clone(), working[0].clone()];
        assert_eq!(find_gh_in(&dirs), Some(working[0].join("gh")));
    }

    fn me() -> Account {
        Account { account_id: "u1".into(), name: "Ann".into(), avatar_url: None }
    }

    const TODAY: NaiveDate = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();

    fn jira_until(outcome: Option<crate::error::Result<Account>>, expires_on: Option<&str>) -> Snapshot {
        super::jira(outcome, expires_on.map(|d| d.parse().unwrap()), TODAY)
    }

    fn jira(outcome: Option<crate::error::Result<Account>>) -> Snapshot {
        jira_until(outcome, Some("2027-10-30"))
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
    fn a_token_within_two_weeks_of_its_expiry_says_how_many_days_are_left_and_still_works() {
        let seen = jira_until(Some(Ok(me())), Some("2026-11-13"));
        assert_eq!((seen.state, seen.message.as_str(), seen.account.as_deref()), (State::ExpiresSoon, "Token expires in 14 days", Some("Ann")));
        assert_eq!(jira_until(Some(Ok(me())), Some("2026-10-31")).message, "Token expires in 1 day");
        assert_eq!(jira_until(Some(Ok(me())), Some("2026-11-14")).state, State::Ready);
        assert_eq!(jira_until(Some(Ok(me())), None).state, State::Ready);
    }

    #[test]
    fn a_token_past_the_date_the_person_gave_but_still_accepted_asks_for_a_new_one() {
        let seen = jira_until(Some(Ok(me())), Some("2026-10-02"));
        assert_eq!((seen.state, seen.message.as_str()), (State::ExpiresSoon, "Token was due to expire on 2 Oct. Make a new one and paste it here."));
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

    #[tokio::test]
    async fn the_accounts_gh_holds_are_listed_with_the_active_one_first_and_the_unusable_marked() {
        let status = r#"{"hosts":{"github.com":[{"state":"success","active":false,"host":"github.com","login":"work"},{"state":"success","active":true,"host":"github.com","login":"Alfhen"},{"state":"error","active":false,"host":"github.com","login":"old","error":"HTTP 401: Bad credentials"}],"ghe.example.com":[{"state":"success","active":true,"host":"ghe.example.com","login":"elsewhere"}]}}"#;
        let seen = github_accounts(&gh_saying("accounts", status), "github.com", Duration::from_secs(5)).await;
        let listed: Vec<_> = seen.accounts.iter().map(|a| (a.login.as_str(), a.active, a.usable)).collect();
        assert_eq!(listed, [("Alfhen", true, true), ("work", false, true), ("old", false, false)]);
        assert_eq!((seen.installed, seen.message, seen.fix), (true, None, None));
    }

    #[tokio::test]
    async fn a_login_gh_could_not_check_because_it_was_offline_is_still_usable() {
        let status = r#"{"hosts":{"github.com":[{"state":"timeout","active":true,"host":"github.com","login":"alfhen"},{"state":"error","active":false,"host":"github.com","login":"work","error":"HTTP 503: Service Unavailable"}]}}"#;
        let seen = github_accounts(&gh_saying("accounts-offline", status), "github.com", Duration::from_secs(5)).await;
        assert!(seen.accounts.iter().all(|a| a.usable), "{:?}", seen.accounts);
    }

    #[tokio::test]
    async fn no_login_on_the_host_lists_nothing_and_offers_the_login_command() {
        let seen = github_accounts(&gh_saying("accounts-none", r#"{"hosts":{}}"#), "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.accounts.len(), seen.installed, seen.message.as_deref(), seen.fix.as_deref()), (0, true, Some("gh has no login on github.com."), Some("gh auth login -h github.com")));
    }

    #[tokio::test]
    async fn a_missing_gh_lists_nothing_and_offers_how_to_install_it() {
        let seen = github_accounts(&[std::env::temp_dir().join("gossamr-probe-nowhere")], "github.com", Duration::from_secs(5)).await;
        assert_eq!((seen.accounts.len(), seen.installed, seen.fix.as_deref()), (0, false, Some("brew install gh")));
    }
}
