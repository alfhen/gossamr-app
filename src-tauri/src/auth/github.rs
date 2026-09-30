//! Signing in to GitHub: a pasted token, the token the GitHub CLI holds, or the device flow. Tokens stay on the Rust
//! side, in the Keychain under the app's service, one entry per account.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::ACCEPT;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::{unix_now, AuthMethod, TokenField};
use crate::codehost::github::{error_message, API_BASE};
use crate::codehost::CodeAccount;
use crate::error::{Error, Result};
use crate::secrets;
use crate::tracker::Connection;

const INDEX_KEY: &str = "github-logins";
const WEB_BASE: &str = "https://github.com";
const ENV_CLIENT_ID: &str = "GOSSAMR_GITHUB_CLIENT_ID";
const BUNDLED_CLIENT_ID: Option<&str> = option_env!("GOSSAMR_GITHUB_CLIENT_ID");
const SCOPES: &str = "repo read:org notifications";
const REFRESH_MARGIN_SECS: u64 = 300;
/// A GUI app's PATH is minimal, so the usual places for `gh` are tried as well.
const GH_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionSource {
    Token,
    GhCli,
    DeviceFlow,
}

/// What a GitHub sign-in leaves in the Keychain.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSession {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub token: String,
    pub source: SessionSource,
    /// What a classic token may do; `None` when the token doesn't say.
    pub scopes: Option<Vec<String>>,
    /// Device-flow tokens from a GitHub App expire and carry a refresh token.
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>,
}

impl std::fmt::Debug for GithubSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubSession").field("login", &self.login).field("source", &self.source).finish_non_exhaustive()
    }
}

impl GithubSession {
    pub fn connection(&self) -> Connection {
        Connection::github(&self.login, &self.login)
    }

    fn needs_refresh(&self, now: u64) -> bool {
        self.refresh_token.is_some() && self.expires_at.is_some_and(|at| at <= now + REFRESH_MARGIN_SECS)
    }
}

/// Where sessions are kept. The Keychain has no way to list entries, so the store keeps an index of logins.
pub trait TokenStore: Send + Sync {
    fn logins(&self) -> Result<Vec<String>>;
    fn load(&self, login: &str) -> Result<Option<GithubSession>>;
    fn save(&self, session: &GithubSession) -> Result<()>;
    fn delete(&self, login: &str) -> Result<()>;
}

fn entry(login: &str) -> String {
    format!("github:{}", login.to_ascii_lowercase())
}

pub struct KeychainStore;

impl TokenStore for KeychainStore {
    fn logins(&self) -> Result<Vec<String>> {
        Ok(secrets::load(INDEX_KEY)?.unwrap_or_default())
    }

    fn load(&self, login: &str) -> Result<Option<GithubSession>> {
        secrets::load(&entry(login))
    }

    fn save(&self, session: &GithubSession) -> Result<()> {
        // Indexed first: a secret the index doesn't name could never be restored or forgotten.
        let mut logins = self.logins()?;
        if !logins.iter().any(|l| l.eq_ignore_ascii_case(&session.login)) {
            logins.push(session.login.clone());
            secrets::save(INDEX_KEY, &logins)?;
        }
        secrets::save(&entry(&session.login), session)?;
        Ok(())
    }

    fn delete(&self, login: &str) -> Result<()> {
        secrets::delete(&entry(login))?;
        let logins: Vec<String> = self.logins()?.into_iter().filter(|l| !l.eq_ignore_ascii_case(login)).collect();
        secrets::save(INDEX_KEY, &logins)
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore(pub std::sync::Mutex<Vec<GithubSession>>);

#[cfg(test)]
impl TokenStore for MemoryStore {
    fn logins(&self) -> Result<Vec<String>> {
        Ok(self.0.lock().unwrap().iter().map(|s| s.login.clone()).collect())
    }

    fn load(&self, login: &str) -> Result<Option<GithubSession>> {
        Ok(self.0.lock().unwrap().iter().find(|s| s.login.eq_ignore_ascii_case(login)).cloned())
    }

    fn save(&self, session: &GithubSession) -> Result<()> {
        let mut all = self.0.lock().unwrap();
        all.retain(|s| !s.login.eq_ignore_ascii_case(&session.login));
        all.push(session.clone());
        Ok(())
    }

    fn delete(&self, login: &str) -> Result<()> {
        self.0.lock().unwrap().retain(|s| !s.login.eq_ignore_ascii_case(login));
        Ok(())
    }
}

/// The ways to connect that work in this build and on this Mac.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInOptions {
    pub device_flow: bool,
    pub gh_cli: bool,
    pub token: bool,
}

/// What the page shows while the person authorises the app in a browser. The device code stays here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Clone, Debug)]
pub struct DeviceChallenge {
    device_code: String,
    pub start: DeviceStart,
}

#[derive(Clone)]
struct Endpoints {
    api: String,
    web: String,
}

pub struct GithubAuth {
    http: reqwest::Client,
    endpoints: Endpoints,
    store: Arc<dyn TokenStore>,
    client_id: Option<String>,
    gh_dirs: Vec<PathBuf>,
    /// How much longer to wait after GitHub answers `slow_down`.
    slow_down: Duration,
}

/// The device-flow client id: the running app's environment first, then the one compiled in. No secret is needed.
pub fn configured_client_id() -> Option<String> {
    let clean = |s: Option<&str>| s.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    clean(std::env::var(ENV_CLIENT_ID).ok().as_deref()).or_else(|| clean(BUNDLED_CLIENT_ID))
}

fn path_dirs() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).chain(GH_DIRS.iter().map(PathBuf::from)).collect()
}

impl GithubAuth {
    pub fn new(http: reqwest::Client, store: Arc<dyn TokenStore>) -> Self {
        Self {
            http,
            endpoints: Endpoints { api: API_BASE.into(), web: WEB_BASE.into() },
            store,
            client_id: configured_client_id(),
            gh_dirs: path_dirs(),
            slow_down: Duration::from_secs(5),
        }
    }

    #[cfg(test)]
    pub fn for_test(http: reqwest::Client, store: Arc<dyn TokenStore>, base: &str, client_id: Option<&str>, gh_dirs: Vec<PathBuf>) -> Self {
        Self {
            http,
            endpoints: Endpoints { api: base.into(), web: base.into() },
            store,
            client_id: client_id.map(String::from),
            gh_dirs,
            slow_down: Duration::from_millis(0),
        }
    }

    /// The ways to sign in, most preferred first. The device flow is offered only when a client id is configured.
    pub fn methods(&self) -> Vec<AuthMethod> {
        let mut methods = Vec::new();
        if let Some(client_id) = &self.client_id {
            methods.push(AuthMethod::DeviceFlow { client_id: client_id.clone() });
        }
        methods.push(AuthMethod::GhCli);
        methods.push(AuthMethod::ApiToken { fields: vec![TokenField { name: "token".into(), label: "Personal access token".into(), secret: true }] });
        methods
    }

    /// What the setup screen can offer. Whether `gh` is installed is found by looking, not by running it.
    pub fn options(&self) -> SignInOptions {
        SignInOptions {
            device_flow: self.methods().iter().any(|m| matches!(m, AuthMethod::DeviceFlow { .. })),
            gh_cli: self.find_gh().is_some(),
            token: true,
        }
    }

    /// Asks GitHub who `token` belongs to, which also proves it works.
    pub async fn validate(&self, token: &str) -> Result<CodeAccount> {
        let token = token.trim();
        if token.is_empty() {
            return Err(Error::Auth("paste a GitHub token first".into()));
        }
        let res = self
            .http
            .get(format!("{}/user", self.endpoints.api))
            .bearer_auth(token)
            .header(ACCEPT, "application/vnd.github+json")
            .send()
            .await?;
        let status = res.status();
        let h = res.headers().clone();
        let scopes = h
            .get("x-oauth-scopes")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect());
        let body = res.text().await?;
        if !status.is_success() {
            return Err(crate::codehost::github::http::error_for(status.as_u16(), &h, &body, unix_now() as i64));
        }
        #[derive(Deserialize)]
        struct User {
            login: String,
            name: Option<String>,
            avatar_url: Option<String>,
        }
        let user: User = serde_json::from_str(&body).map_err(|_| Error::Auth(error_message(&body)))?;
        Ok(CodeAccount { login: user.login, name: user.name, avatar_url: user.avatar_url, scopes })
    }

    async fn keep(&self, token: &str, source: SessionSource, refresh: Option<(String, u64)>) -> Result<GithubSession> {
        let account = self.validate(token).await?;
        let session = GithubSession {
            login: account.login,
            name: account.name,
            avatar_url: account.avatar_url,
            token: token.trim().into(),
            source,
            scopes: account.scopes,
            refresh_token: refresh.as_ref().map(|r| r.0.clone()),
            expires_at: refresh.map(|r| r.1),
        };
        self.store.save(&session)?;
        Ok(session)
    }

    /// Validates a pasted personal access token, classic or fine-grained, and stores it.
    pub async fn connect_token(&self, token: &str) -> Result<GithubSession> {
        self.keep(token, SessionSource::Token, None).await
    }

    fn find_gh(&self) -> Option<PathBuf> {
        self.gh_dirs.iter().map(|d| d.join("gh")).find(|p| p.is_file())
    }

    /// Runs `gh auth token` and keeps what it prints like a pasted token. The CLI's own files are never read.
    pub async fn import_gh_token(&self) -> Result<GithubSession> {
        let gh = self.find_gh().ok_or_else(|| Error::Auth("the GitHub CLI (gh) isn't installed here".into()))?;
        let out = Command::new(gh)
            .args(["auth", "token"])
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .map_err(|e| Error::Auth(format!("couldn't run gh: {e}")))?;
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || token.is_empty() {
            return Err(Error::Auth("gh has no token to give. Run `gh auth login` in a terminal, then try again".into()));
        }
        self.keep(&token, SessionSource::GhCli, None).await
    }

    fn client_id(&self) -> Result<&str> {
        self.client_id.as_deref().ok_or_else(|| Error::Auth("signing in with a browser isn't set up in this build; use a token or the GitHub CLI".into()))
    }

    async fn post_form(&self, path: &str, form: &[(&str, &str)]) -> Result<serde_json::Value> {
        let encoded = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
        let res = self
            .http
            .post(format!("{}{path}", self.endpoints.web))
            .header(ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(encoded)
            .send()
            .await?;
        let status = res.status();
        let body: serde_json::Value = res.json().await.map_err(|_| Error::Auth(format!("GitHub answered {status} with something unexpected")))?;
        if let Some(e) = body["error"].as_str().filter(|_| !status.is_success() || body["access_token"].is_null()) {
            // `authorization_pending` and `slow_down` are answers, not failures; the caller reads them.
            if !matches!(e, "authorization_pending" | "slow_down") {
                let detail = body["error_description"].as_str().unwrap_or(e);
                return Err(Error::Auth(detail.to_string()));
            }
        }
        Ok(body)
    }

    /// Starts the device flow: the person enters `user_code` at `verification_uri`.
    pub async fn device_start(&self) -> Result<DeviceChallenge> {
        let client_id = self.client_id()?.to_string();
        let body = self.post_form("/login/device/code", &[("client_id", &client_id), ("scope", SCOPES)]).await?;
        let text = |k: &str| body[k].as_str().map(String::from).ok_or_else(|| Error::Auth("GitHub didn't return a device code".into()));
        Ok(DeviceChallenge {
            device_code: text("device_code")?,
            start: DeviceStart {
                user_code: text("user_code")?,
                verification_uri: text("verification_uri")?,
                expires_in: body["expires_in"].as_u64().unwrap_or(900),
                interval: body["interval"].as_u64().unwrap_or(5),
            },
        })
    }

    /// Waits for the person to authorise, asking at the interval GitHub set and slowing down when told to.
    pub async fn device_wait(&self, challenge: &DeviceChallenge) -> Result<GithubSession> {
        let client_id = self.client_id()?.to_string();
        let mut interval = Duration::from_secs(challenge.start.interval);
        let deadline = unix_now() + challenge.start.expires_in;
        loop {
            tokio::time::sleep(interval).await;
            if unix_now() > deadline {
                return Err(Error::Auth("the code expired before it was entered; start again".into()));
            }
            let body = self
                .post_form("/login/oauth/access_token", &[("client_id", &client_id), ("device_code", &challenge.device_code), ("grant_type", DEVICE_GRANT)])
                .await?;
            match body["error"].as_str() {
                Some("authorization_pending") => {}
                Some("slow_down") => interval += self.slow_down,
                Some(other) => return Err(Error::Auth(other.to_string())),
                None => {
                    let token = body["access_token"].as_str().ok_or_else(|| Error::Auth("GitHub didn't return a token".into()))?;
                    let refresh = body["refresh_token"].as_str().map(|r| (r.to_string(), unix_now() + body["expires_in"].as_u64().unwrap_or(0)));
                    return self.keep(token, SessionSource::DeviceFlow, refresh).await;
                }
            }
        }
    }

    /// The session with a current token: refreshed when it is about to expire. A token without an expiry is returned as is.
    pub async fn fresh(&self, session: GithubSession) -> Result<GithubSession> {
        if !session.needs_refresh(unix_now()) {
            return Ok(session);
        }
        let client_id = self.client_id()?.to_string();
        let refresh = session.refresh_token.clone().unwrap_or_default();
        let body = self.post_form("/login/oauth/access_token", &[("client_id", &client_id), ("grant_type", "refresh_token"), ("refresh_token", &refresh)]).await?;
        let token = body["access_token"].as_str().ok_or_else(|| Error::Auth("GitHub didn't return a token; connect again".into()))?;
        let renewed = GithubSession {
            token: token.into(),
            refresh_token: body["refresh_token"].as_str().map(String::from).or(Some(refresh)),
            expires_at: body["expires_in"].as_u64().map(|s| unix_now() + s),
            ..session
        };
        self.store.save(&renewed)?;
        Ok(renewed)
    }

    pub fn disconnect(&self, login: &str) -> Result<()> {
        self.store.delete(login)
    }

    /// Sessions restored from the Keychain. One that can't be read is skipped, so the rest still work.
    pub fn restore(&self) -> Vec<GithubSession> {
        let logins = self.store.logins().unwrap_or_else(|e| {
            eprintln!("couldn't read the saved GitHub sign-ins: {e}");
            Vec::new()
        });
        logins.iter().filter_map(|l| self.store.load(l).ok().flatten()).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::codehost::github::testserver::{serve, Reply, Server};

    const USER: &str = include_str!("../codehost/github/fixtures/user.json");

    fn auth(server: &Server, client_id: Option<&str>, gh_dirs: Vec<PathBuf>) -> (GithubAuth, Arc<MemoryStore>) {
        let store = Arc::new(MemoryStore::default());
        (GithubAuth::for_test(reqwest::Client::new(), store.clone(), &server.base, client_id, gh_dirs), store)
    }

    fn fake_gh(dir: &std::path::Path, script: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-gh-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[tokio::test]
    async fn a_pasted_token_is_validated_and_kept_under_the_account() {
        let server = serve(vec![("/user", vec![Reply::ok(USER).header("x-oauth-scopes", "repo, notifications")])]).await;
        let (auth, store) = auth(&server, None, vec![]);
        let session = auth.connect_token("  ghp_secret \n").await.unwrap();
        assert_eq!((session.login.as_str(), session.source), ("ann", SessionSource::Token));
        assert_eq!(session.connection().id, "github:ann");
        assert_eq!(session.scopes, Some(vec!["repo".to_string(), "notifications".into()]));
        assert_eq!(store.load("ANN").unwrap().unwrap().token, "ghp_secret");
        assert_eq!(server.header_of(0, "authorization").as_deref(), Some("Bearer ghp_secret"));
    }

    #[tokio::test]
    async fn a_fine_grained_token_is_accepted_without_notification_access() {
        let server = serve(vec![("/user", vec![Reply::ok(USER)])]).await;
        let (auth, _) = auth(&server, None, vec![]);
        assert_eq!(auth.connect_token("github_pat_x").await.unwrap().scopes, None);
    }

    #[tokio::test]
    async fn a_bad_token_is_refused_and_nothing_is_stored() {
        let server = serve(vec![("/user", vec![Reply::status(401, "{\"message\":\"Bad credentials\"}")])]).await;
        let (auth, store) = auth(&server, None, vec![]);
        let err = auth.connect_token("nope").await.unwrap_err().to_string();
        assert!(err.contains("didn't accept the token"), "{err}");
        assert!(store.logins().unwrap().is_empty());
        assert!(auth.connect_token("  ").await.is_err());
    }

    #[tokio::test]
    async fn an_sso_enforced_token_is_told_to_authorise_the_organisation() {
        let reply = Reply::status(403, "{\"message\":\"Resource protected by organization SAML enforcement.\"}").header("x-github-sso", "required; url=https://github.com/orgs/acme/sso?authorization_request=x");
        let server = serve(vec![("/user", vec![reply])]).await;
        let (auth, _) = auth(&server, None, vec![]);
        let err = auth.connect_token("ghp_x").await.unwrap_err().to_string();
        assert!(err.contains("https://github.com/orgs/acme/sso") && err.contains("authorise"), "{err}");
    }

    #[tokio::test]
    async fn gh_is_asked_for_its_token_only_when_imported_and_the_token_is_stored_like_a_pasted_one() {
        let server = serve(vec![("/user", vec![Reply::ok(USER)])]).await;
        let dir = temp("ok");
        fake_gh(&dir, "[ \"$1 $2\" = \"auth token\" ] && echo gho_fromgh");
        let (auth, store) = auth(&server, None, vec![PathBuf::from("/nonexistent"), dir.clone()]);
        assert!(store.logins().unwrap().is_empty(), "nothing happens before the import");
        let session = auth.import_gh_token().await.unwrap();
        assert_eq!((session.token.as_str(), session.source), ("gho_fromgh", SessionSource::GhCli));
        assert_eq!(server.header_of(0, "authorization").as_deref(), Some("Bearer gho_fromgh"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn gh_missing_or_signed_out_gives_a_plain_message() {
        let server = serve(vec![]).await;
        let (missing, _) = auth(&server, None, vec![PathBuf::from("/nonexistent")]);
        assert!(missing.import_gh_token().await.unwrap_err().to_string().contains("isn't installed"));
        let dir = temp("out");
        fake_gh(&dir, "echo 'not logged in' >&2; exit 1");
        let (out, _) = auth(&server, None, vec![dir.clone()]);
        assert!(out.import_gh_token().await.unwrap_err().to_string().contains("gh auth login"));
        assert!(server.targets().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_device_flow_is_offered_only_with_a_client_id() {
        let http = reqwest::Client::new();
        let store: Arc<dyn TokenStore> = Arc::new(MemoryStore::default());
        let without = GithubAuth::for_test(http.clone(), store.clone(), "http://x", None, vec![]);
        assert!(!without.methods().iter().any(|m| matches!(m, AuthMethod::DeviceFlow { .. })));
        assert!(without.methods().contains(&AuthMethod::GhCli));
        assert_eq!(without.options(), SignInOptions { device_flow: false, gh_cli: false, token: true });
        let with = GithubAuth::for_test(http, store, "http://x", Some("Iv1.abc"), vec![]);
        assert_eq!(with.methods()[0], AuthMethod::DeviceFlow { client_id: "Iv1.abc".into() });
        assert!(with.options().device_flow);
    }

    #[tokio::test]
    async fn without_a_client_id_the_device_flow_says_so() {
        let server = serve(vec![]).await;
        let (auth, _) = auth(&server, None, vec![]);
        assert!(auth.device_start().await.unwrap_err().to_string().contains("isn't set up"));
    }

    #[tokio::test]
    async fn the_device_flow_waits_through_pending_and_slow_down_then_stores_the_token() {
        let start = "{\"device_code\":\"dc\",\"user_code\":\"WDJB-MJHT\",\"verification_uri\":\"https://github.com/login/device\",\"expires_in\":900,\"interval\":0}";
        let server = serve(vec![
            ("/login/device/code", vec![Reply::ok(start)]),
            (
                "/login/oauth/access_token",
                vec![
                    Reply::ok("{\"error\":\"authorization_pending\"}"),
                    Reply::ok("{\"error\":\"slow_down\",\"interval\":10}"),
                    Reply::ok("{\"access_token\":\"gho_dev\",\"token_type\":\"bearer\",\"scope\":\"repo\"}"),
                ],
            ),
            ("/user", vec![Reply::ok(USER)]),
        ])
        .await;
        let (mut auth, store) = auth(&server, Some("Iv1.abc"), vec![]);
        auth.slow_down = Duration::from_millis(0);
        let challenge = auth.device_start().await.unwrap();
        assert_eq!((challenge.start.user_code.as_str(), challenge.start.verification_uri.as_str()), ("WDJB-MJHT", "https://github.com/login/device"));
        let session = tokio::time::timeout(Duration::from_secs(20), auth.device_wait(&challenge)).await.expect("finishes").unwrap();
        assert_eq!((session.token.as_str(), session.source, session.login.as_str()), ("gho_dev", SessionSource::DeviceFlow, "ann"));
        assert!(store.load("ann").unwrap().is_some());
        let seen = server.seen.lock().unwrap();
        assert!(seen[0].body.contains("client_id=Iv1.abc") && seen[0].body.contains("scope="), "{}", seen[0].body);
        assert!(seen[1].body.contains("device_code=dc") && seen[1].body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"), "{}", seen[1].body);
        assert_eq!(seen[1].headers.get("accept").map(String::as_str), Some("application/json"));
    }

    #[tokio::test]
    async fn a_denied_or_expired_device_code_ends_the_wait_with_a_reason() {
        let start = "{\"device_code\":\"dc\",\"user_code\":\"AAAA-BBBB\",\"verification_uri\":\"https://github.com/login/device\",\"expires_in\":900,\"interval\":0}";
        for (error, expected) in [("access_denied", "access_denied"), ("expired_token", "The device code has expired")] {
            let denied = format!("{{\"error\":\"{error}\",\"error_description\":\"The device code has expired\"}}");
            let server = serve(vec![("/login/device/code", vec![Reply::ok(start)]), ("/login/oauth/access_token", vec![Reply::ok(&denied)])]).await;
            let (auth, store) = auth(&server, Some("Iv1.abc"), vec![]);
            let challenge = auth.device_start().await.unwrap();
            let err = auth.device_wait(&challenge).await.unwrap_err().to_string();
            assert!(err.contains(expected) || err.contains("expired"), "{err}");
            assert!(store.logins().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn an_expiring_token_is_refreshed_with_the_client_id_alone_and_a_fresh_one_is_left_alone() {
        let server = serve(vec![("/login/oauth/access_token", vec![Reply::ok("{\"access_token\":\"new\",\"refresh_token\":\"r2\",\"expires_in\":28800}")])]).await;
        let (auth, store) = auth(&server, Some("Iv1.abc"), vec![]);
        let old = GithubSession {
            login: "ann".into(),
            name: None,
            avatar_url: None,
            token: "old".into(),
            source: SessionSource::DeviceFlow,
            scopes: None,
            refresh_token: Some("r1".into()),
            expires_at: Some(unix_now() + 10),
        };
        let fresh = auth.fresh(old.clone()).await.unwrap();
        assert_eq!((fresh.token.as_str(), fresh.refresh_token.as_deref()), ("new", Some("r2")));
        assert!(fresh.expires_at.unwrap() > unix_now() + 28000);
        assert_eq!(store.load("ann").unwrap().unwrap().token, "new");
        let body = server.seen.lock().unwrap()[0].body.clone();
        assert!(body.contains("grant_type=refresh_token") && body.contains("refresh_token=r1") && !body.contains("client_secret"), "{body}");
        let never = GithubSession { expires_at: None, refresh_token: None, ..old };
        assert_eq!(auth.fresh(never).await.unwrap().token, "old");
        assert_eq!(server.targets().len(), 1);
    }

    #[test]
    fn disconnecting_forgets_one_account_and_restore_returns_the_rest() {
        let store = Arc::new(MemoryStore::default());
        let auth = GithubAuth::for_test(reqwest::Client::new(), store.clone(), "http://x", None, vec![]);
        for login in ["ann", "acme-bot"] {
            store
                .save(&GithubSession { login: login.into(), name: None, avatar_url: None, token: "t".into(), source: SessionSource::Token, scopes: None, refresh_token: None, expires_at: None })
                .unwrap();
        }
        assert_eq!(auth.restore().len(), 2);
        auth.disconnect("Ann").unwrap();
        assert_eq!(auth.restore().iter().map(|s| s.login.as_str()).collect::<Vec<_>>(), ["acme-bot"]);
    }
}
