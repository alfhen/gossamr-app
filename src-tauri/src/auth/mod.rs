//! Sign-in behind an `Authenticator`, and the signed-in session Core reads credentials from.

mod atlassian;
mod callback;
mod github;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{Error, Result};
use crate::secrets;
use crate::tracker::Connection;

pub use github::{DeviceChallenge, DeviceStart, SignInOptions, GithubAuth, GithubSession, KeychainStore, TokenStore};
#[cfg(test)]
pub use github::MemoryStore;
pub use atlassian::{redirect_uri, Atlassian, ClientConfig, OAuthApp, SCOPES};

const SESSION_KEY: &str = "session";
const REFRESH_MARGIN_SECS: u64 = 60;

/// Where an OAuth app's client id and secret come from.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientSource {
    /// Compiled into the build.
    Bundled,
    /// Supplied to the running app from its environment.
    ManagedConfig,
    /// Entered by the person on the setup screen and kept in the Keychain.
    UserSupplied,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenField {
    pub name: String,
    pub label: String,
    pub secret: bool,
}

/// A way to sign in, in the terms the setup screen needs. Only `OAuthCode` can be driven today.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthMethod {
    OAuthCode { client: ClientSource, pkce: bool },
    DeviceFlow { client_id: String },
    ApiToken { fields: Vec<TokenField> },
    /// Import the token the GitHub CLI holds, when the person asks.
    GhCli,
    Broker { base_url: String },
}

impl AuthMethod {
    fn is_supported(&self) -> bool {
        matches!(self, AuthMethod::OAuthCode { .. })
    }
}

/// The first offered method that can be driven. Connectors list their methods in order of preference.
fn choose(methods: &[AuthMethod]) -> Result<&AuthMethod> {
    methods.iter().find(|m| m.is_supported()).ok_or_else(|| Error::Auth("no sign-in method is available".into()))
}

/// A sign-in that has started and is waiting for the person.
pub enum AuthChallenge {
    /// Open `url` in a browser; the provider redirects back to the local listener.
    Browser { url: String, loopback: callback::Loopback },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
}

impl Tokens {
    pub fn needs_refresh(&self, now: u64) -> bool {
        self.expires_at <= now + REFRESH_MARGIN_SECS
    }
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

/// What a sign-in leaves in the Keychain. The field names are the stored format, so existing sign-ins carry over.
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub tokens: Tokens,
    pub site: Site,
    pub me: Account,
}

impl Credentials {
    pub fn scope(&self) -> Scope {
        Scope::of(&self.site, &self.me)
    }

    pub fn connection(&self) -> Connection {
        Connection::jira(&self.scope(), &self.site.name)
    }
}

#[async_trait]
pub trait Authenticator: Send + Sync {
    /// The methods on offer, most preferred first.
    fn methods(&self) -> Vec<AuthMethod>;

    async fn begin(&self, method: &AuthMethod) -> Result<AuthChallenge>;

    async fn complete(&self, challenge: AuthChallenge) -> Result<Credentials>;

    /// Fresh credentials for the same site and account. Refresh tokens rotate, so the caller must keep the result.
    async fn refresh(&self, current: &Credentials) -> Result<Credentials>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub configured: bool,
    pub callback_url: String,
    pub scopes: &'static str,
    pub site: Option<Site>,
    pub me: Option<Account>,
}

/// The Jira site and account a piece of work belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub cloud_id: String,
    pub account_id: String,
}

impl Scope {
    pub fn of(site: &Site, me: &Account) -> Self {
        Self { cloud_id: site.cloud_id.clone(), account_id: me.account_id.clone() }
    }
}

/// What the Jira client needs for one request.
pub struct AccessToken {
    pub access_token: String,
    pub scope: Scope,
}

pub struct Auth {
    authenticator: Arc<dyn Authenticator>,
    client: ClientConfig,
    session: Mutex<Option<Credentials>>,
}

impl Auth {
    /// Restores the saved session. If the Keychain can't be read, the app starts signed out rather than failing.
    pub fn load(http: reqwest::Client) -> Self {
        let session = secrets::load(SESSION_KEY).unwrap_or_else(|e| {
            eprintln!("couldn't restore the saved Jira session: {e}");
            None
        });
        let client = ClientConfig;
        Self { authenticator: Arc::new(Atlassian::new(http, client.clone())), client, session: Mutex::new(session) }
    }

    #[cfg(test)]
    pub fn signed_out(http: reqwest::Client) -> Self {
        let client = ClientConfig;
        Self { authenticator: Arc::new(Atlassian::new(http, client.clone())), client, session: Mutex::new(None) }
    }

    #[cfg(test)]
    pub fn signed_in(http: reqwest::Client, credentials: Credentials) -> Self {
        let client = ClientConfig;
        Self { authenticator: Arc::new(Atlassian::new(http, client.clone())), client, session: Mutex::new(Some(credentials)) }
    }

    pub async fn status(&self) -> Result<AuthStatus> {
        let session = self.session.lock().await;
        Ok(AuthStatus {
            configured: self.client.resolve()?.is_some(),
            callback_url: redirect_uri(),
            scopes: SCOPES,
            site: session.as_ref().map(|s| s.site.clone()),
            me: session.as_ref().map(|s| s.me.clone()),
        })
    }

    pub fn save_app(&self, app: OAuthApp) -> Result<()> {
        self.client.save(app)
    }

    /// Runs the sign-in the connector prefers: `open_browser` is given the page the person must visit.
    pub async fn sign_in(&self, open_browser: impl FnOnce(&str) -> Result<()>) -> Result<Connection> {
        let methods = self.authenticator.methods();
        let challenge = self.authenticator.begin(choose(&methods)?).await?;
        let AuthChallenge::Browser { url, .. } = &challenge;
        open_browser(url)?;
        let credentials = self.authenticator.complete(challenge).await?;
        secrets::save(SESSION_KEY, &credentials)?;
        let connection = credentials.connection();
        *self.session.lock().await = Some(credentials);
        Ok(connection)
    }

    pub async fn sign_out(&self) -> Result<()> {
        secrets::delete(SESSION_KEY)?;
        *self.session.lock().await = None;
        Ok(())
    }

    /// The signed-in site and account, if any.
    pub async fn identity(&self) -> Option<(Site, Account)> {
        self.session.lock().await.as_ref().map(|s| (s.site.clone(), s.me.clone()))
    }

    /// The signed-in connection, if any.
    pub async fn connection(&self) -> Option<Connection> {
        self.session.lock().await.as_ref().map(Credentials::connection)
    }

    /// Returns a valid access token, refreshing it when it is about to expire or when `force` is set (after a 401).
    pub async fn credentials(&self, force: bool) -> Result<AccessToken> {
        // Holding the lock across the refresh stops concurrent requests from spending the same rotating refresh token twice.
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().ok_or(Error::NotSignedIn)?;
        if force || session.tokens.needs_refresh(unix_now()) {
            let fresh = self.authenticator.refresh(session).await?;
            secrets::save(SESSION_KEY, &fresh)?;
            *session = fresh;
        }
        Ok(AccessToken { access_token: session.tokens.access_token.clone(), scope: session.scope() })
    }
}

pub async fn json_or_error<T: DeserializeOwned>(res: reqwest::Response) -> Result<T> {
    let status = res.status();
    if status.is_success() {
        return Ok(res.json().await?);
    }
    let mut message = res.text().await.unwrap_or_default();
    message.truncate(300);
    Err(Error::Api { status: status.as_u16(), message })
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth() -> AuthMethod {
        AuthMethod::OAuthCode { client: ClientSource::Bundled, pkce: false }
    }

    #[test]
    fn refreshes_a_minute_before_expiry() {
        let t = Tokens { access_token: "a".into(), refresh_token: "r".into(), expires_at: 1_000 };
        assert!(!t.needs_refresh(900));
        assert!(t.needs_refresh(941));
    }

    #[test]
    fn the_first_method_that_can_be_driven_is_chosen() {
        let token = AuthMethod::ApiToken { fields: vec![] };
        assert_eq!(choose(&[token.clone(), oauth()]).unwrap(), &oauth());
        assert_eq!(choose(&[oauth(), token]).unwrap(), &oauth());
    }

    #[test]
    fn no_drivable_method_is_an_error() {
        let methods = [AuthMethod::Broker { base_url: "https://broker.invalid".into() }, AuthMethod::DeviceFlow { client_id: "x".into() }];
        assert!(matches!(choose(&methods), Err(Error::Auth(_))));
        assert!(choose(&[]).is_err());
    }

    #[test]
    fn a_stored_session_from_before_this_layout_still_parses() {
        let stored = r#"{"tokens":{"access_token":"a","refresh_token":"r","expires_at":5},
            "site":{"cloudId":"c1","name":"Acme","url":"https://acme.atlassian.net"},
            "me":{"accountId":"u1","name":"Ann","avatarUrl":null}}"#;
        let c: Credentials = serde_json::from_str(stored).unwrap();
        let connection = c.connection();
        assert_eq!(connection.id, "jira:c1:u1");
        assert_eq!(connection.display_name, "Acme");
        assert_eq!(c.scope(), Scope { cloud_id: "c1".into(), account_id: "u1".into() });
    }
}
