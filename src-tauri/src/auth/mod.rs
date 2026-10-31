//! Jira sign-in behind an `Authenticator`, and the signed-in session Core reads credentials from.

mod atlassian;
mod github;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use chrono::NaiveDate;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::secrets;
use crate::tracker::Connection;

pub use github::{find_gh_in, SessionSource, DeviceChallenge, DeviceStart, SignInOptions, GithubAuth, GithubSession, KeychainStore, TokenStore};
#[cfg(test)]
pub use github::{MemoryStore, SessionSource};
pub use atlassian::{Atlassian, SiteScope};

const TOKEN_KEY: &str = "jira-token";
/// What an earlier build kept for Atlassian sign-in. Nothing reads these now.
const RETIRED_KEYS: [&str; 2] = ["session", "oauth-app"];
/// Days before a token's expiry that Gossamr starts saying so.
pub const EXPIRY_WARNING_DAYS: i64 = 14;

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenField {
    pub name: String,
    pub label: String,
    pub secret: bool,
}

/// A way to sign in, in the terms the setup screen needs. GitHub offers all three until it signs in through `gh`.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    DeviceFlow { client_id: String },
    ApiToken { fields: Vec<TokenField> },
    /// Import the token the GitHub CLI holds, when the person asks.
    GhCli,
}

/// What the Connect Jira sheet sends.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSignIn {
    pub site: String,
    /// Only when the site wouldn't give it.
    pub cloud_id: Option<String>,
    pub email: String,
    pub token: String,
    /// `YYYY-MM-DD`. Atlassian doesn't report a token's expiry, so this is what the person says it is.
    pub expires_on: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub cloud_id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub account_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

/// What a sign-in leaves in the Keychain.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub email: String,
    pub token: String,
    pub expires_on: String,
    pub site: Site,
    pub me: Account,
}

impl Credentials {
    pub fn site_scope(&self) -> SiteScope {
        SiteScope { cloud_id: self.site.cloud_id.clone(), account_id: self.me.account_id.clone() }
    }

    pub fn scope(&self) -> Scope {
        self.site_scope().scope()
    }

    pub fn connection(&self) -> Connection {
        self.site_scope().connection(&self.site.name)
    }
}

#[async_trait]
pub trait Authenticator: Send + Sync {
    /// The cloud id `site` reports about itself, or `None` when it doesn't say.
    async fn find_cloud_id(&self, site: &str) -> Result<Option<String>>;

    /// Checks the token against Jira and returns what to keep.
    async fn connect(&self, input: &TokenSignIn) -> Result<Credentials>;

    /// Who `token` signs in as, which also proves it still works.
    async fn whoami(&self, token: &AccessToken) -> Result<Account>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub site: Option<Site>,
    pub me: Option<Account>,
    pub email: Option<String>,
    pub expires_on: Option<String>,
}

/// The signed-in connection and account a piece of work belongs to. Work started for one scope is refused once the
/// person has signed in as another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub connection_id: String,
    pub account_id: String,
}

/// What the Jira client needs for one request.
pub struct AccessToken {
    pub email: String,
    pub token: String,
    pub scope: SiteScope,
}

pub struct Auth {
    authenticator: Arc<dyn Authenticator>,
    session: Mutex<Option<Credentials>>,
    restore_failed: bool,
}

impl Auth {
    /// Restores the saved session. If the Keychain can't be read, the app starts signed out rather than failing.
    pub fn load(http: reqwest::Client) -> Self {
        let (session, restore_failed) = match secrets::load(TOKEN_KEY) {
            Ok(session) => (session, false),
            Err(e) => {
                eprintln!("couldn't restore the saved Jira token: {e}");
                (None, true)
            }
        };
        if session.is_none() && !restore_failed {
            for key in RETIRED_KEYS {
                if let Err(e) = secrets::delete(key) {
                    eprintln!("couldn't remove the old Atlassian sign-in ({key}): {e}");
                }
            }
        }
        Self { authenticator: Arc::new(Atlassian::new(http)), session: Mutex::new(session), restore_failed }
    }

    /// Whether the saved session was there but couldn't be read, so a signed-out `Auth` doesn't mean nobody was signed in.
    pub fn restore_failed(&self) -> bool {
        self.restore_failed
    }

    #[cfg(test)]
    pub fn signed_out(http: reqwest::Client) -> Self {
        Self { authenticator: Arc::new(Atlassian::new(http)), session: Mutex::new(None), restore_failed: false }
    }

    #[cfg(test)]
    pub fn with_authenticator(authenticator: Arc<dyn Authenticator>, credentials: Credentials) -> Self {
        Self { authenticator, session: Mutex::new(Some(credentials)), restore_failed: false }
    }

    #[cfg(test)]
    pub fn signed_in(http: reqwest::Client, credentials: Credentials) -> Self {
        Self::with_authenticator(Arc::new(Atlassian::new(http)), credentials)
    }

    pub async fn status(&self) -> Result<AuthStatus> {
        let session = self.session.lock().await;
        Ok(AuthStatus {
            site: session.as_ref().map(|s| s.site.clone()),
            me: session.as_ref().map(|s| s.me.clone()),
            email: session.as_ref().map(|s| s.email.clone()),
            expires_on: session.as_ref().map(|s| s.expires_on.clone()),
        })
    }

    pub async fn find_cloud_id(&self, site: &str) -> Result<Option<String>> {
        self.authenticator.find_cloud_id(site).await
    }

    /// Checks `input` against Jira and, only if it works, keeps it in place of any earlier sign-in.
    pub async fn connect(&self, input: &TokenSignIn) -> Result<Connection> {
        let credentials = self.authenticator.connect(input).await?;
        secrets::save(TOKEN_KEY, &credentials)?;
        let connection = credentials.connection();
        *self.session.lock().await = Some(credentials);
        Ok(connection)
    }

    pub async fn sign_out(&self) -> Result<()> {
        secrets::delete(TOKEN_KEY)?;
        *self.session.lock().await = None;
        Ok(())
    }

    /// The signed-in site and account, if any.
    pub async fn identity(&self) -> Option<(Scope, Site, Account)> {
        self.session.lock().await.as_ref().map(|s| (s.scope(), s.site.clone(), s.me.clone()))
    }

    /// The signed-in connection, if any.
    pub async fn connection(&self) -> Option<Connection> {
        self.session.lock().await.as_ref().map(Credentials::connection)
    }

    /// The day the saved token expires, as the person said.
    pub async fn expires_on(&self) -> Option<NaiveDate> {
        let session = self.session.lock().await;
        NaiveDate::parse_from_str(&session.as_ref()?.expires_on, "%Y-%m-%d").ok()
    }

    /// Asks Jira who the saved token signs in as, and gives up on Jira's answer after `within` (`None`).
    pub async fn whoami(&self, within: Duration) -> Option<Result<Account>> {
        let token = match self.credentials().await {
            Ok(token) => token,
            Err(e) => return Some(Err(e)),
        };
        tokio::time::timeout(within, self.authenticator.whoami(&token)).await.ok()
    }

    pub async fn credentials(&self) -> Result<AccessToken> {
        let session = self.session.lock().await;
        let session = session.as_ref().ok_or(Error::NotSignedIn)?;
        Ok(AccessToken { email: session.email.clone(), token: session.token.clone(), scope: session.site_scope() })
    }
}

pub async fn json_or_error<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    let status = res.status();
    if status.is_success() {
        return Ok(res.json().await?);
    }
    // Not `String::truncate`, which panics when byte 300 falls inside a character.
    let message: String = res.text().await.unwrap_or_default().chars().take(300).collect();
    Err(Error::Api { status: status.as_u16(), message })
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn credentials() -> Credentials {
        Credentials {
            email: "ann@acme.com".into(),
            token: "secret-token".into(),
            expires_on: "2027-10-30".into(),
            site: Site { cloud_id: "c1".into(), name: "acme.atlassian.net".into(), url: "https://acme.atlassian.net".into() },
            me: Account { account_id: "u1".into(), name: "Ann".into(), avatar_url: None },
        }
    }

    fn github(login: &str) -> GithubSession {
        GithubSession {
            login: login.into(),
            name: None,
            avatar_url: None,
            token: "t".into(),
            source: github::SessionSource::Token,
            scopes: None,
            refresh_token: None,
            expires_at: None,
        }
    }

    #[test]
    fn a_saved_token_names_its_connection_after_the_site_and_the_account() {
        let c = credentials();
        assert_eq!(c.connection().id, "jira:c1:u1");
        assert_eq!(c.connection().display_name, "acme.atlassian.net");
        assert_eq!(c.scope(), Scope { connection_id: "jira:c1:u1".into(), account_id: "u1".into() });
        assert_eq!(c.site_scope(), SiteScope { cloud_id: "c1".into(), account_id: "u1".into() });
    }

    fn restore_everything() -> (bool, usize) {
        let http = reqwest::Client::new();
        let auth = Auth::load(http.clone());
        let signed_in = auth.session.try_lock().unwrap().is_some();
        let restored = GithubAuth::new(http, Arc::new(KeychainStore)).restore();
        (signed_in, restored.len())
    }

    #[test]
    fn a_normal_launch_reads_the_keychain_once_and_writes_nothing() {
        let fake = secrets::fake::Fake::default();
        let _installed = secrets::fake::install(&fake);
        secrets::save(TOKEN_KEY, &credentials()).unwrap();
        let store = KeychainStore;
        store.save(&github("ann")).unwrap();
        store.save(&github("bob")).unwrap();

        let _relaunched = secrets::fake::install(&fake);
        fake.reset_counts();
        assert_eq!(restore_everything(), (true, 2));
        assert_eq!((fake.reads(), fake.writes(), fake.removes()), (1, 0, 0));
    }

    #[test]
    fn launching_with_only_the_old_atlassian_sign_in_starts_signed_out_and_forgets_it() {
        let fake = secrets::fake::Fake::default();
        let _installed = secrets::fake::install(&fake);
        let old = r#"{"tokens":{"access_token":"a","refresh_token":"r","expires_at":5},"site":{"cloudId":"c1","name":"Acme","url":"https://acme.atlassian.net"},"me":{"accountId":"u1","name":"Ann","avatarUrl":null}}"#;
        fake.put("session", old);
        fake.put("oauth-app", r#"{"client_id":"id","client_secret":"secret"}"#);
        fake.put("github-logins", r#"["ann"]"#);
        fake.put("github:ann", &serde_json::to_string(&github("ann")).unwrap());
        assert_eq!(restore_everything(), (false, 1));
        for retired in ["session", "oauth-app"] {
            assert_eq!(fake.get(retired), None);
            assert!(secrets::load::<Value>(retired).unwrap().is_none());
        }

        let _relaunched = secrets::fake::install(&fake);
        fake.reset_counts();
        assert_eq!(restore_everything(), (false, 1));
        assert_eq!((fake.reads(), fake.writes()), (1, 0));
    }

    #[test]
    fn a_denied_keychain_starts_signed_out_and_is_asked_once() {
        let fake = secrets::fake::Fake::default();
        fake.deny_reads_of("vault");
        let _installed = secrets::fake::install(&fake);
        assert_eq!(restore_everything(), (false, 0));
        assert_eq!(fake.reads(), 1);
    }

    /// Knows only `ann@acme.com`, answers after `answer_after`, and keeps no state.
    struct Slow {
        answer_after: Duration,
    }

    #[async_trait]
    impl Authenticator for Slow {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, _: &TokenSignIn) -> Result<Credentials> {
            Ok(credentials())
        }
        async fn whoami(&self, token: &AccessToken) -> Result<Account> {
            tokio::time::sleep(self.answer_after).await;
            if token.token == "secret-token" {
                Ok(credentials().me)
            } else {
                Err(Error::Api { status: 401, message: "revoked".into() })
            }
        }
    }

    #[tokio::test]
    async fn jira_not_answering_in_time_is_none_and_leaves_the_session_as_it_was() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let auth = Auth::with_authenticator(Arc::new(Slow { answer_after: Duration::from_secs(30) }), credentials());
        assert!(auth.whoami(Duration::from_millis(30)).await.is_none());
        assert!(auth.identity().await.is_some());
        assert_eq!(fake.writes(), 0);
    }

    #[tokio::test]
    async fn connecting_keeps_the_token_in_the_keychain_and_replaces_the_earlier_session() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        let auth = Auth::with_authenticator(Arc::new(Slow { answer_after: Duration::ZERO }), Credentials { token: "old".into(), ..credentials() });
        let input = TokenSignIn { site: "acme".into(), cloud_id: None, email: "ann@acme.com".into(), token: "secret-token".into(), expires_on: "2027-10-30".into() };
        assert_eq!(auth.connect(&input).await.unwrap().id, "jira:c1:u1");
        assert_eq!(secrets::load::<Credentials>(TOKEN_KEY).unwrap().unwrap().token, "secret-token");
        assert_eq!(auth.credentials().await.unwrap().token, "secret-token");
    }

    struct Refusing;

    #[async_trait]
    impl Authenticator for Refusing {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, _: &TokenSignIn) -> Result<Credentials> {
            Err(Error::Auth("Jira didn't accept that email and token.".into()))
        }
        async fn whoami(&self, _: &AccessToken) -> Result<Account> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn a_token_that_does_not_work_leaves_the_earlier_session_and_the_keychain_alone() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        secrets::save(TOKEN_KEY, &credentials()).unwrap();
        let auth = Auth::with_authenticator(Arc::new(Refusing), credentials());
        let input = TokenSignIn { site: "acme".into(), cloud_id: None, email: "x".into(), token: "bad".into(), expires_on: "2027-10-30".into() };
        assert!(auth.connect(&input).await.is_err());
        assert_eq!(auth.credentials().await.unwrap().token, "secret-token");
        assert_eq!(secrets::load::<Credentials>(TOKEN_KEY).unwrap().unwrap().token, "secret-token");
    }

    #[tokio::test]
    async fn signing_out_forgets_the_token() {
        let fake = secrets::fake::Fake::default();
        let _vault = secrets::fake::install(&fake);
        secrets::save(TOKEN_KEY, &credentials()).unwrap();
        let auth = Auth::with_authenticator(Arc::new(Refusing), credentials());
        auth.sign_out().await.unwrap();
        assert!(matches!(auth.credentials().await, Err(Error::NotSignedIn)));
        assert!(secrets::load::<Credentials>(TOKEN_KEY).unwrap().is_none());
    }

    #[tokio::test]
    async fn the_expiry_day_is_what_the_person_said() {
        let auth = Auth::with_authenticator(Arc::new(Refusing), credentials());
        assert_eq!(auth.expires_on().await, NaiveDate::from_ymd_opt(2027, 10, 30));
    }
}
