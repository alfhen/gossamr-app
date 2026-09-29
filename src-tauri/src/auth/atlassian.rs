//! Atlassian OAuth 2.0 (3LO): authorisation code with a client secret, the only grant the token endpoint accepts.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use url::Url;

use super::callback::Loopback;
use super::{
    json_or_error, unix_now, Account, AuthChallenge, AuthMethod, Authenticator, ClientSource, Credentials, Site, Tokens,
};
use crate::error::{Error, Result};
use crate::secrets;

/// Must match the callback URL registered on the Atlassian developer console exactly.
const CALLBACK_PORT: u16 = 8723;
pub const SCOPES: &str = "read:jira-work write:jira-work read:jira-user offline_access";
const APP_KEY: &str = "oauth-app";

const ENV_CLIENT_ID: &str = "GOSSAMR_ATLASSIAN_CLIENT_ID";
const ENV_CLIENT_SECRET: &str = "GOSSAMR_ATLASSIAN_CLIENT_SECRET";
const BUNDLED_CLIENT_ID: Option<&str> = option_env!("GOSSAMR_ATLASSIAN_CLIENT_ID");
const BUNDLED_CLIENT_SECRET: Option<&str> = option_env!("GOSSAMR_ATLASSIAN_CLIENT_SECRET");

pub fn redirect_uri() -> String {
    format!("http://localhost:{CALLBACK_PORT}/callback")
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
}

fn app_from(id: Option<&str>, secret: Option<&str>) -> Option<OAuthApp> {
    let (id, secret) = (id?.trim(), secret?.trim());
    (!id.is_empty() && !secret.is_empty()).then(|| OAuthApp { client_id: id.into(), client_secret: secret.into() })
}

/// The first source that has an app. What a person entered wins, so an existing sign-in keeps refreshing with the
/// app that issued its tokens.
fn pick(user: Option<OAuthApp>, managed: Option<OAuthApp>, bundled: Option<OAuthApp>) -> Option<(ClientSource, OAuthApp)> {
    user.map(|a| (ClientSource::UserSupplied, a))
        .or_else(|| managed.map(|a| (ClientSource::ManagedConfig, a)))
        .or_else(|| bundled.map(|a| (ClientSource::Bundled, a)))
}

/// Finds the OAuth app to sign in with: entered on the setup screen, from the environment, or compiled in with
/// `GOSSAMR_ATLASSIAN_CLIENT_ID` and `GOSSAMR_ATLASSIAN_CLIENT_SECRET` set at build time.
#[derive(Clone)]
pub struct ClientConfig;

impl ClientConfig {
    pub fn resolve(&self) -> Result<Option<(ClientSource, OAuthApp)>> {
        let managed = app_from(std::env::var(ENV_CLIENT_ID).ok().as_deref(), std::env::var(ENV_CLIENT_SECRET).ok().as_deref());
        let bundled = app_from(BUNDLED_CLIENT_ID, BUNDLED_CLIENT_SECRET);
        Ok(pick(secrets::load(APP_KEY)?, managed, bundled))
    }

    fn app(&self) -> Result<(ClientSource, OAuthApp)> {
        self.resolve()?.ok_or(Error::NotConfigured)
    }

    pub fn save(&self, app: OAuthApp) -> Result<()> {
        let app = app_from(Some(&app.client_id), Some(&app.client_secret))
            .ok_or_else(|| Error::Auth("client ID and secret are both required".into()))?;
        secrets::save(APP_KEY, &app)
    }
}

#[derive(Clone)]
struct Endpoints {
    /// Serves the consent page and the token endpoint.
    auth: String,
    api: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self { auth: "https://auth.atlassian.com".into(), api: "https://api.atlassian.com".into() }
    }
}

pub struct Atlassian {
    http: reqwest::Client,
    client: ClientConfig,
    endpoints: Endpoints,
}

impl Atlassian {
    pub fn new(http: reqwest::Client, client: ClientConfig) -> Self {
        Self { http, client, endpoints: Endpoints::default() }
    }

    async fn exchange(&self, app: &OAuthApp, grant: &[(&str, &str)], previous_refresh: Option<&str>) -> Result<Tokens> {
        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
            refresh_token: Option<String>,
            expires_in: u64,
        }
        let mut body = serde_json::json!({
            "client_id": app.client_id,
            "client_secret": app.client_secret,
            "redirect_uri": redirect_uri(),
        });
        for (k, v) in grant {
            body[*k] = serde_json::Value::from(*v);
        }
        let res = self.http.post(format!("{}/oauth/token", self.endpoints.auth)).json(&body).send().await?;
        let t: TokenResponse = json_or_error(res).await?;
        let refresh_token = t
            .refresh_token
            .or_else(|| previous_refresh.map(String::from))
            .ok_or_else(|| Error::Auth("no refresh token returned; is offline_access enabled?".into()))?;
        Ok(Tokens { access_token: t.access_token, refresh_token, expires_at: unix_now() + t.expires_in })
    }

    async fn accessible_sites(&self, access_token: &str) -> Result<Vec<Site>> {
        #[derive(Deserialize)]
        struct Resource {
            id: String,
            name: String,
            url: String,
            #[serde(default)]
            scopes: Vec<String>,
        }
        let res = self
            .http
            .get(format!("{}/oauth/token/accessible-resources", self.endpoints.api))
            .bearer_auth(access_token)
            .send()
            .await?;
        let resources: Vec<Resource> = json_or_error(res).await?;
        Ok(resources
            .into_iter()
            .filter(|r| r.scopes.iter().any(|s| s.ends_with(":jira-work")))
            .map(|r| Site { cloud_id: r.id, name: r.name, url: r.url })
            .collect())
    }

    async fn myself(&self, access_token: &str, cloud_id: &str) -> Result<Account> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Myself {
            account_id: String,
            display_name: String,
            #[serde(default)]
            avatar_urls: std::collections::HashMap<String, String>,
        }
        let res = self
            .http
            .get(format!("{}/ex/jira/{cloud_id}/rest/api/3/myself", self.endpoints.api))
            .bearer_auth(access_token)
            .send()
            .await?;
        let me: Myself = json_or_error(res).await?;
        Ok(Account { account_id: me.account_id, name: me.display_name, avatar_url: me.avatar_urls.get("48x48").cloned() })
    }

    async fn identify(&self, tokens: Tokens) -> Result<Credentials> {
        let site = self
            .accessible_sites(&tokens.access_token)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| Error::Auth("this account has no Jira sites the app can access".into()))?;
        let me = self.myself(&tokens.access_token, &site.cloud_id).await?;
        Ok(Credentials { tokens, site, me })
    }
}

#[async_trait]
impl Authenticator for Atlassian {
    fn methods(&self) -> Vec<AuthMethod> {
        // The secret is required at the token endpoint, so PKCE can't stand in for it.
        let client = self.client.resolve().ok().flatten().map(|(source, _)| source).unwrap_or(ClientSource::UserSupplied);
        vec![AuthMethod::OAuthCode { client, pkce: false }]
    }

    async fn begin(&self, method: &AuthMethod) -> Result<AuthChallenge> {
        if !matches!(method, AuthMethod::OAuthCode { .. }) {
            return Err(Error::Auth("Atlassian doesn't offer that sign-in method".into()));
        }
        let (_, app) = self.client.app()?;
        let loopback = Loopback::bind(CALLBACK_PORT).await?;
        let url = authorize_url(&app, loopback.state(), &self.endpoints.auth).to_string();
        Ok(AuthChallenge::Browser { url, loopback })
    }

    async fn complete(&self, challenge: AuthChallenge) -> Result<Credentials> {
        let AuthChallenge::Browser { loopback, .. } = challenge;
        let code = loopback.code().await?;
        let (_, app) = self.client.app()?;
        let tokens = self.exchange(&app, &[("grant_type", "authorization_code"), ("code", &code)], None).await?;
        self.identify(tokens).await
    }

    async fn refresh(&self, current: &Credentials) -> Result<Credentials> {
        let (_, app) = self.client.app()?;
        let refresh = &current.tokens.refresh_token;
        let tokens = self
            .exchange(&app, &[("grant_type", "refresh_token"), ("refresh_token", refresh)], Some(refresh))
            .await?;
        Ok(Credentials { tokens, ..current.clone() })
    }
}

fn authorize_url(app: &OAuthApp, state: &str, auth_base: &str) -> Url {
    let mut url = Url::parse(&format!("{auth_base}/authorize")).expect("static URL");
    url.query_pairs_mut()
        .append_pair("audience", "api.atlassian.com")
        .append_pair("client_id", &app.client_id)
        .append_pair("scope", SCOPES)
        .append_pair("redirect_uri", &redirect_uri())
        .append_pair("state", state)
        .append_pair("response_type", "code")
        .append_pair("prompt", "consent");
    url
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn app(id: &str) -> OAuthApp {
        OAuthApp { client_id: id.into(), client_secret: format!("{id}-secret") }
    }

    /// Answers each request with the JSON registered for its path and records `path body` for every request.
    async fn serve(routes: Vec<(&'static str, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let body_start = loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                    if n == 0 {
                        break buf.len();
                    }
                };
                let head = String::from_utf8_lossy(&buf[..body_start]).to_string();
                let length = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                    .unwrap_or(0);
                while buf.len() < body_start + length {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {}", String::from_utf8_lossy(&buf[body_start..])));
                let (status, body) = routes
                    .iter()
                    .find(|(p, _)| *p == path)
                    .map(|(_, b)| ("200 OK", *b))
                    .unwrap_or(("404 Not Found", "{}"));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (base, seen)
    }

    async fn atlassian(routes: Vec<(&'static str, &'static str)>) -> (Atlassian, Arc<Mutex<Vec<String>>>) {
        let (base, seen) = serve(routes).await;
        let endpoints = Endpoints { auth: base.clone(), api: base };
        (Atlassian { http: reqwest::Client::new(), client: ClientConfig, endpoints }, seen)
    }

    fn stale() -> Credentials {
        Credentials {
            tokens: Tokens { access_token: "old-access".into(), refresh_token: "old-refresh".into(), expires_at: 1 },
            site: Site { cloud_id: "c1".into(), name: "Acme".into(), url: "https://acme.atlassian.net".into() },
            me: Account { account_id: "u1".into(), name: "Ann".into(), avatar_url: None },
        }
    }

    #[test]
    fn authorize_url_carries_all_required_parameters() {
        let app = OAuthApp { client_id: "abc".into(), client_secret: "SECRET-VALUE".into() };
        let url = authorize_url(&app, "xyz", "https://auth.atlassian.com");
        assert_eq!(url.host_str(), Some("auth.atlassian.com"));
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["audience"], "api.atlassian.com");
        assert_eq!(q["client_id"], "abc");
        assert_eq!(q["state"], "xyz");
        assert_eq!(q["redirect_uri"], "http://localhost:8723/callback");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "read:jira-work write:jira-work read:jira-user offline_access");
        assert!(!url.as_str().contains("SECRET-VALUE"), "the client secret must never be in the browser URL");
    }

    #[test]
    fn a_person_supplied_app_beats_the_environment_which_beats_the_bundled_one() {
        let (source, chosen) = pick(Some(app("user")), Some(app("env")), Some(app("built"))).unwrap();
        assert_eq!((source, chosen.client_id.as_str()), (ClientSource::UserSupplied, "user"));
        let (source, chosen) = pick(None, Some(app("env")), Some(app("built"))).unwrap();
        assert_eq!((source, chosen.client_id.as_str()), (ClientSource::ManagedConfig, "env"));
        let (source, chosen) = pick(None, None, Some(app("built"))).unwrap();
        assert_eq!((source, chosen.client_id.as_str()), (ClientSource::Bundled, "built"));
        assert!(pick(None, None, None).is_none());
    }

    #[test]
    fn an_app_needs_both_an_id_and_a_secret() {
        assert!(app_from(Some("id"), None).is_none());
        assert!(app_from(Some("id"), Some("  ")).is_none());
        let a = app_from(Some(" id "), Some("secret\n")).unwrap();
        assert_eq!((a.client_id.as_str(), a.client_secret.as_str()), ("id", "secret"));
    }

    #[tokio::test]
    async fn only_the_oauth_code_method_is_offered_and_begun() {
        let (a, _) = atlassian(vec![]).await;
        assert!(matches!(a.methods().as_slice(), [AuthMethod::OAuthCode { pkce: false, .. }]));
        let err = a.begin(&AuthMethod::ApiToken { fields: vec![] }).await.err().unwrap();
        assert!(matches!(err, Error::Auth(_)));
    }

    #[tokio::test]
    async fn a_rotated_refresh_token_replaces_the_old_one_and_the_identity_is_kept() {
        let (a, seen) = atlassian(vec![("/oauth/token", r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}"#)]).await;
        let client = OAuthApp { client_id: "id".into(), client_secret: "sec".into() };
        let before = stale();
        let tokens = a
            .exchange(&client, &[("grant_type", "refresh_token"), ("refresh_token", &before.tokens.refresh_token)], Some(&before.tokens.refresh_token))
            .await
            .unwrap();
        assert_eq!((tokens.access_token.as_str(), tokens.refresh_token.as_str()), ("new-access", "new-refresh"));
        assert!(tokens.expires_at > unix_now() + 3500 && !tokens.needs_refresh(unix_now()));
        let sent: serde_json::Value = serde_json::from_str(seen.lock().unwrap()[0].strip_prefix("/oauth/token ").unwrap()).unwrap();
        assert_eq!(sent["grant_type"], "refresh_token");
        assert_eq!(sent["refresh_token"], "old-refresh");
        assert_eq!(sent["client_secret"], "sec");
    }

    #[tokio::test]
    async fn the_old_refresh_token_is_kept_when_none_comes_back() {
        let (a, _) = atlassian(vec![("/oauth/token", r#"{"access_token":"new-access","expires_in":60}"#)]).await;
        let client = OAuthApp { client_id: "id".into(), client_secret: "sec".into() };
        let kept = a.exchange(&client, &[("grant_type", "refresh_token")], Some("old-refresh")).await.unwrap();
        assert_eq!(kept.refresh_token, "old-refresh");
        let err = a.exchange(&client, &[("grant_type", "authorization_code")], None).await.err().unwrap();
        assert!(matches!(err, Error::Auth(_)), "a first sign-in without offline_access has nothing to refresh with");
    }

    #[tokio::test]
    async fn a_rejected_refresh_surfaces_the_provider_error() {
        let (a, _) = atlassian(vec![]).await;
        let client = OAuthApp { client_id: "id".into(), client_secret: "sec".into() };
        let err = a.exchange(&client, &[("grant_type", "refresh_token")], Some("r")).await.err().unwrap();
        assert!(matches!(err, Error::Api { status: 404, .. }));
    }

    #[tokio::test]
    async fn signing_in_names_the_connection_after_the_site() {
        let (a, seen) = atlassian(vec![
            ("/oauth/token/accessible-resources", r#"[
                {"id":"conf","name":"Wiki","url":"https://w.atlassian.net","scopes":["read:confluence-content.all"]},
                {"id":"c1","name":"Acme","url":"https://acme.atlassian.net","scopes":["read:jira-work"]}]"#),
            ("/ex/jira/c1/rest/api/3/myself", r#"{"accountId":"u1","displayName":"Ann","avatarUrls":{"48x48":"https://a/48.png"}}"#),
        ])
        .await;
        let tokens = Tokens { access_token: "tok".into(), refresh_token: "r".into(), expires_at: unix_now() + 3600 };
        let credentials = a.identify(tokens).await.unwrap();
        let connection = credentials.connection();
        assert_eq!((connection.id.as_str(), connection.display_name.as_str()), ("jira:c1:u1", "Acme"));
        assert_eq!(credentials.me.avatar_url.as_deref(), Some("https://a/48.png"));
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_account_without_a_jira_site_cannot_sign_in() {
        let (a, _) = atlassian(vec![("/oauth/token/accessible-resources", "[]")]).await;
        let tokens = Tokens { access_token: "tok".into(), refresh_token: "r".into(), expires_at: 0 };
        assert!(matches!(a.identify(tokens).await.err().unwrap(), Error::Auth(_)));
    }
}
