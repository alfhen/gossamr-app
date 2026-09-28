use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use url::Url;

use crate::error::{Error, Result};
use crate::secrets;

/// Must match the callback URL registered on the Atlassian developer console exactly.
pub const CALLBACK_PORT: u16 = 8723;
pub const SCOPES: &str = "read:jira-work write:jira-work read:jira-user offline_access";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

const APP_KEY: &str = "oauth-app";
const SESSION_KEY: &str = "session";

pub fn redirect_uri() -> String {
    format!("http://localhost:{CALLBACK_PORT}/callback")
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
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

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    tokens: Tokens,
    site: Site,
    me: Account,
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

pub struct Auth {
    http: reqwest::Client,
    session: Mutex<Option<Session>>,
}

impl Auth {
    pub fn load(http: reqwest::Client) -> Result<Self> {
        Ok(Self {
            http,
            session: Mutex::new(secrets::load(SESSION_KEY)?),
        })
    }

    pub async fn status(&self) -> Result<AuthStatus> {
        let session = self.session.lock().await;
        Ok(AuthStatus {
            configured: secrets::load::<OAuthApp>(APP_KEY)?.is_some(),
            callback_url: redirect_uri(),
            scopes: SCOPES,
            site: session.as_ref().map(|s| s.site.clone()),
            me: session.as_ref().map(|s| s.me.clone()),
        })
    }

    pub fn save_app(&self, app: OAuthApp) -> Result<()> {
        if app.client_id.trim().is_empty() || app.client_secret.trim().is_empty() {
            return Err(Error::Auth("client ID and secret are both required".into()));
        }
        secrets::save(
            APP_KEY,
            &OAuthApp {
                client_id: app.client_id.trim().into(),
                client_secret: app.client_secret.trim().into(),
            },
        )
    }

    /// Runs the browser sign-in: listens for the redirect on localhost, opens the consent page, then exchanges the code.
    pub async fn sign_in(&self, open_browser: impl FnOnce(&str) -> Result<()>) -> Result<AuthStatus> {
        let app: OAuthApp = secrets::load(APP_KEY)?.ok_or(Error::NotConfigured)?;
        let state = random_state()?;
        let v4 = TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
            .await
            .map_err(|e| Error::Auth(format!("port {CALLBACK_PORT} is busy ({e})")))?;
        // Browsers may resolve localhost to ::1 first, so listen there too when available.
        let v6 = TcpListener::bind(("::1", CALLBACK_PORT)).await.ok();

        open_browser(authorize_url(&app, &state).as_str())?;
        let code = tokio::time::timeout(LOGIN_TIMEOUT, wait_for_code(&v4, v6.as_ref(), &state))
            .await
            .map_err(|_| Error::Auth("timed out waiting for the browser".into()))??;

        let tokens = self.exchange(&app, &[("grant_type", "authorization_code"), ("code", &code)], None).await?;
        let site = self
            .accessible_sites(&tokens.access_token)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| Error::Auth("this account has no Jira sites the app can access".into()))?;
        let me = self.myself(&tokens.access_token, &site.cloud_id).await?;

        let session = Session { tokens, site, me };
        secrets::save(SESSION_KEY, &session)?;
        *self.session.lock().await = Some(session);
        self.status().await
    }

    pub async fn sign_out(&self) -> Result<()> {
        secrets::delete(SESSION_KEY)?;
        *self.session.lock().await = None;
        Ok(())
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
        let res = self.http.post("https://auth.atlassian.com/oauth/token").json(&body).send().await?;
        let t: TokenResponse = json_or_error(res).await?;
        let refresh_token = t
            .refresh_token
            .or_else(|| previous_refresh.map(String::from))
            .ok_or_else(|| Error::Auth("no refresh token returned; is offline_access enabled?".into()))?;
        Ok(Tokens {
            access_token: t.access_token,
            refresh_token,
            expires_at: unix_now() + t.expires_in,
        })
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
            .get("https://api.atlassian.com/oauth/token/accessible-resources")
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
            .get(format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/myself"))
            .bearer_auth(access_token)
            .send()
            .await?;
        let me: Myself = json_or_error(res).await?;
        Ok(Account {
            account_id: me.account_id,
            name: me.display_name,
            avatar_url: me.avatar_urls.get("48x48").cloned(),
        })
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

fn authorize_url(app: &OAuthApp, state: &str) -> Url {
    let mut url = Url::parse("https://auth.atlassian.com/authorize").expect("static URL");
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

#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    Failed(String),
    Ignore,
}

/// Parses the request line of the redirect, e.g. `GET /callback?code=…&state=… HTTP/1.1`.
fn parse_callback(request_line: &str, expected_state: &str) -> Callback {
    let mut parts = request_line.split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Callback::Ignore;
    };
    let Ok(url) = Url::parse(&format!("http://localhost{target}")) else {
        return Callback::Ignore;
    };
    if url.path() != "/callback" {
        return Callback::Ignore;
    }
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if let Some(err) = param("error") {
        return Callback::Failed(param("error_description").unwrap_or(err));
    }
    // The state check is what stops another local page from completing the login with its own code.
    if param("state").as_deref() != Some(expected_state) {
        return Callback::Failed("the sign-in response did not match this request".into());
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Failed("no authorisation code in the response".into()),
    }
}

async fn wait_for_code(v4: &TcpListener, v6: Option<&TcpListener>, state: &str) -> Result<String> {
    loop {
        let mut stream = accept(v4, v6).await?;
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).await?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let line = request.lines().next().unwrap_or_default();
        match parse_callback(line, state) {
            Callback::Ignore => respond(&mut stream, "404 Not Found", "Not found").await,
            Callback::Code(code) => {
                respond(&mut stream, "200 OK", "Signed in to Jira Inbox. You can close this tab.").await;
                return Ok(code);
            }
            Callback::Failed(msg) => {
                respond(&mut stream, "400 Bad Request", &format!("Sign-in failed: {msg}")).await;
                return Err(Error::Auth(msg));
            }
        }
    }
}

async fn accept(v4: &TcpListener, v6: Option<&TcpListener>) -> std::io::Result<TcpStream> {
    match v6 {
        Some(v6) => tokio::select! {
            r = v4.accept() => r.map(|(s, _)| s),
            r = v6.accept() => r.map(|(s, _)| s),
        },
        None => v4.accept().await.map(|(s, _)| s),
    }
}

async fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Jira Inbox</title>\
         <body style=\"font:15px system-ui;display:grid;place-items:center;height:90vh\">{}</body>",
        html_escape(message)
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn random_state() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| Error::Auth(format!("no randomness available: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_carries_all_required_parameters() {
        let app = OAuthApp { client_id: "abc".into(), client_secret: "SECRET-VALUE".into() };
        let url = authorize_url(&app, "xyz");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["audience"], "api.atlassian.com");
        assert_eq!(q["client_id"], "abc");
        assert_eq!(q["state"], "xyz");
        assert_eq!(q["redirect_uri"], "http://localhost:8723/callback");
        assert_eq!(q["response_type"], "code");
        assert!(q["scope"].contains("offline_access"));
        assert!(!url.as_str().contains("SECRET-VALUE"), "the client secret must never be in the browser URL");
    }

    #[test]
    fn parses_a_valid_callback() {
        assert_eq!(
            parse_callback("GET /callback?code=c0de&state=st HTTP/1.1", "st"),
            Callback::Code("c0de".into())
        );
    }

    #[test]
    fn rejects_a_mismatched_state() {
        assert!(matches!(parse_callback("GET /callback?code=c&state=other HTTP/1.1", "st"), Callback::Failed(_)));
        assert!(matches!(parse_callback("GET /callback?code=c HTTP/1.1", "st"), Callback::Failed(_)));
    }

    #[test]
    fn reports_a_denied_consent() {
        assert_eq!(
            parse_callback("GET /callback?error=access_denied&error_description=User%20denied&state=st HTTP/1.1", "st"),
            Callback::Failed("User denied".into())
        );
    }

    #[test]
    fn ignores_other_requests() {
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1", "st"), Callback::Ignore);
        assert_eq!(parse_callback("POST /callback HTTP/1.1", "st"), Callback::Ignore);
        assert_eq!(parse_callback("", "st"), Callback::Ignore);
    }

    #[test]
    fn state_is_random_hex() {
        let (a, b) = (random_state().unwrap(), random_state().unwrap());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }
}
