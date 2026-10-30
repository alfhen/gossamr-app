//! Jira by scoped API token: Basic auth with the person's email and token, through the `api.atlassian.com` gateway.

use async_trait::async_trait;
use chrono::NaiveDate;
use serde::Deserialize;

use super::{json_or_error, AccessToken, Account, Authenticator, Credentials, Scope, Site, TokenSignIn};
use crate::error::{Error, Result};
use crate::tracker::{Connection, ConnectionKind};

/// The Atlassian site and account behind a Jira connection. Only the Jira adapter and this sign-in read the parts; the
/// rest of Gossamr holds the `Scope` it makes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiteScope {
    pub cloud_id: String,
    pub account_id: String,
}

impl SiteScope {
    /// Stored in every row and database file name of a Jira account, so the format must not change.
    pub fn connection_id(&self) -> String {
        format!("jira:{}:{}", self.cloud_id, self.account_id)
    }

    pub fn scope(&self) -> Scope {
        Scope { connection_id: self.connection_id(), account_id: self.account_id.clone() }
    }

    pub fn connection(&self, display_name: &str) -> Connection {
        Connection {
            id: self.connection_id(),
            kind: ConnectionKind::Jira,
            workspace: self.cloud_id.clone(),
            account: self.account_id.clone(),
            display_name: display_name.into(),
        }
    }
}

/// `acme`, `acme.atlassian.net` and `https://acme.atlassian.net/browse/X-1` all mean the host `acme.atlassian.net`.
pub fn normalize_site(input: &str) -> Result<String> {
    let bad = || Error::Input("Enter your Jira site, like acme.atlassian.net.".into());
    let input = input.trim();
    let host = input.split_once("://").map_or(input, |(_, rest)| rest).split(['/', '?', '#']).next().unwrap_or_default().to_ascii_lowercase();
    let host = if host.contains('.') { host } else { format!("{host}.atlassian.net") };
    let labels_ok = host.split('.').all(|l| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    if host.starts_with('.') || !labels_ok {
        return Err(bad());
    }
    Ok(host)
}

pub fn parse_expiry(date: &str, today: NaiveDate) -> Result<NaiveDate> {
    let on = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").map_err(|_| Error::Input("Enter the date the token expires.".into()))?;
    if on < today {
        return Err(Error::Input("That expiry date has passed.".into()));
    }
    Ok(on)
}

fn valid_cloud_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Clone)]
struct Endpoints {
    /// Where `/_edge/tenant_info` is asked; the site itself unless a test points it elsewhere.
    tenant: Option<String>,
    api: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self { tenant: None, api: "https://api.atlassian.com".into() }
    }
}

pub struct Atlassian {
    http: reqwest::Client,
    endpoints: Endpoints,
}

impl Atlassian {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, endpoints: Endpoints::default() }
    }

    async fn myself(&self, email: &str, token: &str, cloud_id: &str) -> Result<Account> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Myself {
            account_id: String,
            display_name: String,
            #[serde(default)]
            avatar_urls: std::collections::HashMap<String, String>,
        }
        let res = self.http.get(format!("{}/ex/jira/{cloud_id}/rest/api/3/myself", self.endpoints.api)).basic_auth(email, Some(token)).send().await?;
        let me: Myself = json_or_error(res).await?;
        Ok(Account { account_id: me.account_id, name: me.display_name, avatar_url: me.avatar_urls.get("48x48").cloned() })
    }
}

#[async_trait]
impl Authenticator for Atlassian {
    async fn find_cloud_id(&self, site: &str) -> Result<Option<String>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Tenant {
            cloud_id: String,
        }
        let host = normalize_site(site)?;
        let base = self.endpoints.tenant.clone().unwrap_or_else(|| format!("https://{host}"));
        let res = self.http.get(format!("{base}/_edge/tenant_info")).send().await.map_err(|_| Error::Input(format!("Gossamr couldn't reach {host}. Check the site.")))?;
        Ok(json_or_error::<Tenant>(res).await.ok().map(|t| t.cloud_id).filter(|id| valid_cloud_id(id)))
    }

    async fn connect(&self, input: &TokenSignIn) -> Result<Credentials> {
        let host = normalize_site(&input.site)?;
        let expires_on = parse_expiry(&input.expires_on, chrono::Local::now().date_naive())?;
        let (email, token) = (input.email.trim(), input.token.trim());
        if email.is_empty() || token.is_empty() {
            return Err(Error::Input("Enter your email and the token.".into()));
        }
        let given = input.cloud_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
        let reported = match self.find_cloud_id(&host).await {
            Ok(found) => found,
            Err(e) if given.is_none() => return Err(e),
            Err(_) => None,
        };
        let cloud_id = match (given, reported) {
            (Some(given), Some(reported)) if !given.eq_ignore_ascii_case(&reported) => {
                return Err(Error::Input(format!("That cloud id isn't the one {host} reports. Check the site.")));
            }
            (_, Some(reported)) => reported,
            (Some(given), None) => given.to_string(),
            (None, None) => return Err(Error::Input(format!("Gossamr couldn't find the cloud id of {host}. Enter it yourself."))),
        };
        if !valid_cloud_id(&cloud_id) {
            return Err(Error::Input("That cloud id doesn't look right.".into()));
        }
        let me = self.myself(email, token, &cloud_id).await.map_err(|e| match e {
            Error::Api { status: 401 | 403, .. } => Error::Input("Jira didn't accept that email and token. Check both, and that the token has the three scopes.".into()),
            other => other,
        })?;
        Ok(Credentials {
            email: email.into(),
            token: token.into(),
            expires_on: expires_on.to_string(),
            site: Site { cloud_id, name: host.clone(), url: format!("https://{host}") },
            me,
        })
    }

    async fn whoami(&self, token: &AccessToken) -> Result<Account> {
        self.myself(&token.email, &token.token, &token.scope.cloud_id).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    /// Answers each request with the JSON registered for its path (404 otherwise) and records the request head.
    async fn serve(routes: Vec<(&'static str, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(head);
                let (status, body) = routes.iter().find(|(p, _)| *p == path).map(|(_, b)| match b.strip_prefix("401:") {
                    Some(rest) => ("401 Unauthorized", rest),
                    None => ("200 OK", *b),
                }).unwrap_or(("404 Not Found", "{}"));
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (base, seen)
    }

    async fn atlassian(routes: Vec<(&'static str, &'static str)>) -> (Atlassian, Arc<Mutex<Vec<String>>>) {
        let (base, seen) = serve(routes).await;
        (Atlassian { http: reqwest::Client::new(), endpoints: Endpoints { tenant: Some(base.clone()), api: base } }, seen)
    }

    fn sign_in(cloud_id: Option<&str>) -> TokenSignIn {
        TokenSignIn {
            site: "https://Acme.atlassian.net/jira".into(),
            cloud_id: cloud_id.map(String::from),
            email: " ann@acme.com ".into(),
            token: " secret-token\n".into(),
            expires_on: (chrono::Local::now().date_naive() + chrono::Days::new(365)).to_string(),
        }
    }

    const ME: &str = r#"{"accountId":"u1","displayName":"Ann","avatarUrls":{"48x48":"https://a/48.png"}}"#;
    const TENANT: &str = r#"{"cloudId":"c1-uuid"}"#;

    #[test]
    fn a_site_is_whatever_form_the_person_pastes_it_in() {
        for typed in ["acme", "Acme.atlassian.net", " https://acme.atlassian.net/ ", "https://acme.atlassian.net/jira/software/projects/X?x=1"] {
            assert_eq!(normalize_site(typed).unwrap(), "acme.atlassian.net", "{typed}");
        }
        assert_eq!(normalize_site("jira.acme.com").unwrap(), "jira.acme.com");
    }

    #[test]
    fn a_site_that_is_not_a_host_is_refused() {
        for typed in ["", "  ", "a b.atlassian.net", "acme.atlassian.net:99@evil.example", "-x.atlassian.net", ".net", "a..b"] {
            assert!(normalize_site(typed).is_err(), "{typed:?}");
        }
    }

    #[test]
    fn an_expiry_must_be_a_date_that_has_not_passed() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        assert_eq!(parse_expiry("2026-10-30", today).unwrap(), today);
        assert!(parse_expiry("2026-10-29", today).is_err());
        assert!(parse_expiry("30 Oct", today).is_err());
    }

    #[tokio::test]
    async fn the_cloud_id_comes_from_the_site_without_signing_in() {
        let (a, seen) = atlassian(vec![("/_edge/tenant_info", TENANT)]).await;
        assert_eq!(a.find_cloud_id("acme").await.unwrap().as_deref(), Some("c1-uuid"));
        assert!(!seen.lock().unwrap()[0].to_ascii_lowercase().contains("authorization"));
    }

    #[tokio::test]
    async fn a_site_that_does_not_give_its_cloud_id_is_none_and_not_an_error() {
        let (a, _) = atlassian(vec![]).await;
        assert_eq!(a.find_cloud_id("acme").await.unwrap(), None);
        let (a, _) = atlassian(vec![("/_edge/tenant_info", r#"{"cloudId":"../../x"}"#)]).await;
        assert_eq!(a.find_cloud_id("acme").await.unwrap(), None);
    }

    #[tokio::test]
    async fn connecting_asks_myself_through_the_gateway_with_the_email_and_token_and_names_the_connection_after_the_site() {
        let (a, seen) = atlassian(vec![("/_edge/tenant_info", TENANT), ("/ex/jira/c1-uuid/rest/api/3/myself", ME)]).await;
        let c = a.connect(&sign_in(None)).await.unwrap();
        assert_eq!((c.email.as_str(), c.token.as_str(), c.site.name.as_str(), c.site.url.as_str()), ("ann@acme.com", "secret-token", "acme.atlassian.net", "https://acme.atlassian.net"));
        assert_eq!(c.connection().id, "jira:c1-uuid:u1");
        assert_eq!(c.expires_on, sign_in(None).expires_on);
        assert_eq!(c.me.avatar_url.as_deref(), Some("https://a/48.png"));
        let myself = seen.lock().unwrap().iter().find(|h| h.contains("/myself")).cloned().unwrap();
        let basic = myself.lines().find_map(|l| l.strip_prefix("authorization: Basic ")).expect("Basic auth");
        assert_eq!(basic, "YW5uQGFjbWUuY29tOnNlY3JldC10b2tlbg==");
    }

    #[tokio::test]
    async fn a_cloud_id_the_person_gives_is_used_when_the_site_does_not_say_otherwise() {
        let (a, _) = atlassian(vec![("/ex/jira/given-1/rest/api/3/myself", ME)]).await;
        assert_eq!(a.connect(&sign_in(Some("given-1"))).await.unwrap().site.cloud_id, "given-1");
        let (a, _) = atlassian(vec![("/_edge/tenant_info", TENANT), ("/ex/jira/c1-uuid/rest/api/3/myself", ME)]).await;
        assert_eq!(a.connect(&sign_in(Some("C1-UUID"))).await.unwrap().site.cloud_id, "c1-uuid");
    }

    #[tokio::test]
    async fn a_cloud_id_that_is_not_the_one_the_site_reports_is_refused_before_any_token_is_sent() {
        let (a, seen) = atlassian(vec![("/_edge/tenant_info", TENANT), ("/ex/jira/other/rest/api/3/myself", ME)]).await;
        let message = a.connect(&sign_in(Some("other"))).await.err().unwrap().to_string();
        assert!(message.contains("acme.atlassian.net") && message.contains("cloud id"), "{message}");
        assert!(seen.lock().unwrap().iter().all(|h| !h.contains("/myself")));
    }

    #[tokio::test]
    async fn a_site_that_cannot_be_reached_says_so_and_does_not_ask_for_a_cloud_id() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let closed = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let a = Atlassian { http: reqwest::Client::new(), endpoints: Endpoints { tenant: Some(closed), api: "http://unused.invalid".into() } };
        let message = a.find_cloud_id("acme").await.err().unwrap().to_string();
        assert!(message.contains("couldn't reach acme.atlassian.net"), "{message}");
        assert!(a.connect(&sign_in(None)).await.err().unwrap().to_string().contains("couldn't reach"));
        assert!(a.find_cloud_id("not a site").await.is_err());
    }

    #[tokio::test]
    async fn a_site_with_no_findable_cloud_id_asks_for_it() {
        let (a, _) = atlassian(vec![]).await;
        let message = a.connect(&sign_in(None)).await.err().unwrap().to_string();
        assert!(message.contains("cloud id"), "{message}");
    }

    #[tokio::test]
    async fn a_token_jira_refuses_says_what_to_check_and_other_failures_keep_jira_s_own_error() {
        let (a, _) = atlassian(vec![("/ex/jira/c1-uuid/rest/api/3/myself", "401:{}")]).await;
        let message = a.connect(&sign_in(Some("c1-uuid"))).await.err().unwrap().to_string();
        assert!(message.contains("email and token"), "{message}");
        let (a, _) = atlassian(vec![]).await;
        assert!(matches!(a.connect(&sign_in(Some("c1-uuid"))).await.err().unwrap(), Error::Api { status: 404, .. }));
    }

    #[tokio::test]
    async fn asking_who_a_token_belongs_to_calls_myself_on_its_site_with_that_token() {
        let (a, seen) = atlassian(vec![("/ex/jira/c1/rest/api/3/myself", r#"{"accountId":"u1","displayName":"Ann"}"#)]).await;
        let token = AccessToken { email: "ann@acme.com".into(), token: "tok".into(), scope: SiteScope { cloud_id: "c1".into(), account_id: "u1".into() } };
        assert_eq!(a.whoami(&token).await.unwrap().name, "Ann");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
