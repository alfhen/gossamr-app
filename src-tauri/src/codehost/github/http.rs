//! GitHub's REST transport: conditional requests backed by the SQLite cache, pagination, and rate-limit handling.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::header::{HeaderMap, ACCEPT, IF_MODIFIED_SINCE, IF_NONE_MATCH};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;

use crate::db::{stamp, CachedHttp, Db};
use crate::error::{is_transport_failure, Error, Result};

const API_VERSION: &str = "2022-11-28";
const JSON: &str = "application/vnd.github+json";
/// Requests stop this far short of the limit, so a burst from somewhere else can't push the account over.
const CORE_RESERVE: u64 = 5;
const SEARCH_RESERVE: u64 = 1;
/// A limit with no retry hint is waited out this long at least.
const MIN_WAIT_SECS: u64 = 60;

/// Waits before the second and third attempts at a request that failed in transit.
#[cfg(not(test))]
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(300), Duration::from_secs(1)];
#[cfg(test)]
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(1), Duration::from_millis(1)];

#[derive(Clone, Copy, Debug)]
struct Limit {
    remaining: u64,
    reset: i64,
}

/// One answer, from the network or, after a 304, from the cache.
#[derive(Clone, Debug)]
pub struct Page {
    pub body: String,
    /// GitHub said nothing changed since the cached answer.
    pub unchanged: bool,
    pub next: Option<String>,
    pub last_modified: Option<String>,
    /// Seconds GitHub asks pollers to wait (`X-Poll-Interval`).
    pub poll_interval: Option<u64>,
    /// Scopes a classic token carries (`X-OAuth-Scopes`); absent for fine-grained tokens and apps.
    pub scopes: Option<Vec<String>>,
}

pub struct Api {
    http: reqwest::Client,
    base: String,
    token: String,
    connection_id: String,
    db: Arc<Mutex<Db>>,
    limits: Mutex<HashMap<String, Limit>>,
}

/// `base` spread by up to a quarter either way, so clients that failed together don't retry together.
fn jittered(base: Duration, random: u8) -> Duration {
    base.mul_f64(0.75 + f64::from(random) / 510.0)
}

fn retry_pause(base: Duration) -> Duration {
    let mut byte = [128u8];
    let _ = getrandom::fill(&mut byte);
    jittered(base, byte[0])
}

fn retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 502..=504)
}

fn header(h: &HeaderMap, name: &str) -> Option<String> {
    h.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
}

/// The URL of the `rel="next"` entry of a `Link` header.
fn next_link(h: &HeaderMap) -> Option<String> {
    header(h, "link")?.split(',').find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        (rel.trim() == "rel=\"next\"").then(|| url.trim().trim_start_matches('<').trim_end_matches('>').to_string())
    })
}

pub fn error_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str().map(String::from)))
        .unwrap_or_else(|| body.chars().take(200).collect())
}

fn clock(reset: i64) -> String {
    DateTime::from_timestamp(reset, 0).map(|t| t.format("%H:%M UTC").to_string()).unwrap_or_else(|| "soon".into())
}

/// The error a failed response becomes, worded for the person.
pub fn error_for(status: u16, h: &HeaderMap, body: &str, now: i64) -> Error {
    let message = error_message(body);
    let remaining = header(h, "x-ratelimit-remaining").and_then(|v| v.parse::<u64>().ok());
    let reset = header(h, "x-ratelimit-reset").and_then(|v| v.parse::<i64>().ok());
    if let Some(sso) = header(h, "x-github-sso") {
        let url = sso.split("url=").nth(1).map(|u| u.trim().to_string());
        let help = url.map(|u| format!(" Authorise it at {u}.")).unwrap_or_default();
        return Error::CodeHost {
            status,
            message: format!(
                "This token isn't authorised for an organisation that uses SAML single sign-on.{help} On GitHub, open the token in Settings > Developer settings and choose Configure SSO, then authorise the organisation."
            ),
        };
    }
    let limited = matches!(status, 403 | 429) && (remaining == Some(0) || header(h, "retry-after").is_some() || message.to_ascii_lowercase().contains("rate limit"));
    if limited {
        let secs = header(h, "retry-after")
            .and_then(|v| v.parse::<u64>().ok())
            .or_else(|| reset.map(|r| (r - now).max(0) as u64))
            .unwrap_or(MIN_WAIT_SECS)
            .max(1);
        let when = if reset.is_some() && remaining == Some(0) { format!("resets at {}", clock(reset.unwrap_or_default())) } else { format!("try again in {secs} seconds") };
        return Error::RateLimited { message: format!("GitHub is limiting requests; {when}."), retry_after_secs: secs };
    }
    match status {
        401 => Error::CodeHost { status, message: "GitHub didn't accept the token. It may have expired or been revoked; connect again.".into() },
        403 => Error::CodeHost { status, message: format!("GitHub refused this: {message}. The token may be missing a permission for it.") },
        404 => Error::CodeHost { status, message: "GitHub couldn't find that, or the token can't see it.".into() },
        _ => Error::CodeHost { status, message: format!("GitHub returned {status}: {message}") },
    }
}

impl Api {
    pub fn new(http: reqwest::Client, base: &str, token: &str, connection_id: &str, db: Arc<Mutex<Db>>) -> Self {
        Self { http, base: base.trim_end_matches('/').into(), token: token.into(), connection_id: connection_id.into(), db, limits: Mutex::new(HashMap::new()) }
    }

    /// Sends the request, trying again after a failure in transit or a 502, 503 or 504. Only reads are sent through
    /// here, so repeating one is safe. The body is read inside the loop because it can fail in transit too.
    async fn fetch(&self, request: impl Fn() -> reqwest::RequestBuilder) -> Result<(StatusCode, HeaderMap, String)> {
        let mut retries = RETRY_DELAYS.iter();
        loop {
            let attempt = async {
                let res = request().send().await?;
                let (status, headers) = (res.status(), res.headers().clone());
                Ok::<_, reqwest::Error>((status, headers, res.text().await?))
            }
            .await;
            let delay = match &attempt {
                Ok((status, ..)) if retryable_status(*status) => retries.next(),
                Err(e) if is_transport_failure(e) => retries.next(),
                _ => None,
            };
            let Some(delay) = delay else { return Ok(attempt?) };
            tokio::time::sleep(retry_pause(*delay)).await;
        }
    }

    fn url(&self, target: &str) -> String {
        if target.starts_with("http://") || target.starts_with("https://") {
            target.into()
        } else {
            format!("{}{target}", self.base)
        }
    }

    /// Refuses to send while the bucket this request draws on is nearly empty and hasn't reset yet.
    fn guard(&self, url: &str) -> Result<()> {
        let (resource, reserve) = if url.contains("/search/") { ("search", SEARCH_RESERVE) } else { ("core", CORE_RESERVE) };
        let Some(limit) = self.limits.lock().expect("limit lock poisoned").get(resource).copied() else { return Ok(()) };
        let now = Utc::now().timestamp();
        if limit.remaining <= reserve && limit.reset > now {
            return Err(Error::RateLimited {
                message: format!("GitHub's request limit is nearly used up; waiting until {}.", clock(limit.reset)),
                retry_after_secs: (limit.reset - now) as u64,
            });
        }
        Ok(())
    }

    fn note_limits(&self, h: &HeaderMap) {
        let number = |n: &str| header(h, n).and_then(|v| v.parse::<i64>().ok());
        if let (Some(remaining), Some(reset)) = (number("x-ratelimit-remaining"), number("x-ratelimit-reset")) {
            let resource = header(h, "x-ratelimit-resource").unwrap_or_else(|| "core".into());
            self.limits.lock().expect("limit lock poisoned").insert(resource, Limit { remaining: remaining.max(0) as u64, reset });
        }
    }

    fn cached(&self, url: &str) -> Option<CachedHttp> {
        self.db.lock().expect("db lock poisoned").http_cache_get(&self.connection_id, url).ok().flatten()
    }

    pub async fn get(&self, target: &str) -> Result<Page> {
        self.get_with(target, JSON).await
    }

    /// Like `get`, for a different media type (text matches in code search).
    pub async fn get_with(&self, target: &str, accept: &str) -> Result<Page> {
        let url = self.url(target);
        self.guard(&url)?;
        // The same URL answers differently per media type, so each is cached apart.
        let key = if accept == JSON { url.clone() } else { format!("{url}#{accept}") };
        let cached = self.cached(&key);
        let (status, h, body) = self
            .fetch(|| {
                let mut req = self.http.get(&url).bearer_auth(&self.token).header(ACCEPT, accept).header("X-GitHub-Api-Version", API_VERSION);
                if let Some(c) = &cached {
                    if let Some(etag) = &c.etag {
                        req = req.header(IF_NONE_MATCH, etag);
                    } else if let Some(since) = &c.last_modified {
                        req = req.header(IF_MODIFIED_SINCE, since);
                    }
                }
                req
            })
            .await?;
        self.note_limits(&h);
        let poll_interval = header(&h, "x-poll-interval").and_then(|v| v.parse().ok());
        let scopes = header(&h, "x-oauth-scopes").map(|s| s.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect());
        if status == StatusCode::NOT_MODIFIED {
            let c = cached.ok_or_else(|| Error::CodeHost { status: 304, message: "GitHub answered 'not modified' to a request that wasn't conditional.".into() })?;
            // A repository that never changes is polled forever, so the answer must not age out of the cache.
            let _ = self.db.lock().expect("db lock poisoned").http_cache_touch(&self.connection_id, &key, &stamp(Utc::now()));
            return Ok(Page { body: c.body, unchanged: true, next: c.next, last_modified: c.last_modified, poll_interval, scopes });
        }
        if !status.is_success() {
            return Err(error_for(status.as_u16(), &h, &body, Utc::now().timestamp()));
        }
        let page = Page { body, unchanged: false, next: next_link(&h), last_modified: header(&h, "last-modified"), poll_interval, scopes };
        let etag = header(&h, "etag");
        if etag.is_some() || page.last_modified.is_some() {
            let entry = CachedHttp { etag, last_modified: page.last_modified.clone(), next: page.next.clone(), body: page.body.clone() };
            // A full disk must not turn a good answer into an error.
            let _ = self.db.lock().expect("db lock poisoned").http_cache_put(&self.connection_id, &key, &entry, &stamp(Utc::now()));
        }
        Ok(page)
    }

    pub async fn json<T: DeserializeOwned>(&self, target: &str) -> Result<(T, Page)> {
        let page = self.get(target).await?;
        Ok((serde_json::from_str(&page.body)?, page))
    }

    /// Follows `next` links for at most `max_pages` pages. `unchanged` is whether the first page was.
    pub async fn paged<T: DeserializeOwned>(&self, target: &str, max_pages: usize) -> Result<(Vec<T>, bool)> {
        let mut out = Vec::new();
        let mut next = Some(target.to_string());
        let mut unchanged = false;
        for n in 0..max_pages {
            let Some(url) = next.take() else { break };
            let (items, page): (Vec<T>, Page) = self.json(&url).await?;
            if n == 0 {
                unchanged = page.unchanged;
            }
            out.extend(items);
            next = page.next;
        }
        Ok((out, unchanged))
    }
}

#[cfg(test)]
mod tests {
    use reqwest::header::HeaderValue;

    use super::super::testserver::{serve, Reply};
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn api(base: &str) -> Api {
        Api::new(reqwest::Client::new(), base, "tok", "github:ann", Arc::new(Mutex::new(Db::in_memory().unwrap())))
    }

    #[test]
    fn the_next_link_is_found_among_others() {
        let h = headers(&[("link", "<https://api.github.com/x?page=1>; rel=\"prev\", <https://api.github.com/x?page=3>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"")]);
        assert_eq!(next_link(&h).as_deref(), Some("https://api.github.com/x?page=3"));
        assert_eq!(next_link(&headers(&[("link", "<u>; rel=\"prev\"")])), None);
        assert_eq!(next_link(&HeaderMap::new()), None);
    }

    #[test]
    fn a_rejected_token_and_a_missing_repository_read_plainly() {
        let e = error_for(401, &HeaderMap::new(), "{\"message\":\"Bad credentials\"}", 0).to_string();
        assert!(e.contains("didn't accept the token"), "{e}");
        let e = error_for(404, &HeaderMap::new(), "{}", 0).to_string();
        assert!(e.contains("can't see it"), "{e}");
        let e = error_for(500, &HeaderMap::new(), "{\"message\":\"boom\"}", 0).to_string();
        assert!(e.contains("500") && e.contains("boom"), "{e}");
    }

    #[test]
    fn a_403_with_the_sso_header_tells_the_person_to_authorise_the_token() {
        let h = headers(&[("x-github-sso", "required; url=https://github.com/orgs/acme/sso?authorization_request=abc")]);
        let e = error_for(403, &h, "{\"message\":\"Resource protected by organization SAML enforcement.\"}", 0).to_string();
        assert!(e.contains("https://github.com/orgs/acme/sso?authorization_request=abc") && e.contains("authorise"), "{e}");
    }

    #[test]
    fn rate_limits_are_told_apart_from_other_403s() {
        let primary = headers(&[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1100")]);
        let Error::RateLimited { retry_after_secs, message } = error_for(403, &primary, "{\"message\":\"API rate limit exceeded\"}", 1000) else { panic!("not limited") };
        assert_eq!(retry_after_secs, 100);
        assert!(message.contains("resets at"), "{message}");
        let secondary = headers(&[("retry-after", "30")]);
        assert!(matches!(error_for(429, &secondary, "{}", 0), Error::RateLimited { retry_after_secs: 30, .. }));
        let by_message = error_for(403, &HeaderMap::new(), "{\"message\":\"You have exceeded a secondary rate limit\"}", 0);
        assert!(matches!(by_message, Error::RateLimited { retry_after_secs: 60, .. }));
        assert!(matches!(error_for(403, &HeaderMap::new(), "{\"message\":\"Resource not accessible\"}", 0), Error::CodeHost { status: 403, .. }));
    }

    #[tokio::test]
    async fn a_second_request_is_conditional_and_a_304_is_answered_from_the_cache() {
        let server = serve(vec![(
            "/repos/acme/webshop/pulls",
            vec![
                Reply::ok("[1,2]").header("etag", "\"v1\"").header("link", "<http://x/next>; rel=\"next\""),
                Reply::status(304, ""),
            ],
        )])
        .await;
        let api = api(&server.base);
        let (first, page): (Vec<u32>, Page) = api.json("/repos/acme/webshop/pulls").await.unwrap();
        assert_eq!((first, page.unchanged), (vec![1, 2], false));
        let (again, page): (Vec<u32>, Page) = api.json("/repos/acme/webshop/pulls").await.unwrap();
        assert_eq!((again, page.unchanged, page.next.as_deref()), (vec![1, 2], true, Some("http://x/next")));
        assert_eq!(server.header_of(0, "if-none-match"), None);
        assert_eq!(server.header_of(1, "if-none-match").as_deref(), Some("\"v1\""));
        assert_eq!(server.header_of(1, "authorization").as_deref(), Some("Bearer tok"));
        let cutoff = stamp(Utc::now() - chrono::Duration::minutes(1));
        assert_eq!(api.db.lock().unwrap().http_cache_prune("github:ann", &cutoff).unwrap(), 0, "the 304 refreshed the entry");
        assert_eq!(server.header_of(1, "x-github-api-version").as_deref(), Some(API_VERSION));
    }

    #[tokio::test]
    async fn last_modified_is_used_when_there_is_no_etag() {
        let server = serve(vec![("/notifications", vec![Reply::ok("[]").header("last-modified", "Wed, 30 Sep 2026 10:00:00 GMT").header("x-poll-interval", "60"), Reply::status(304, "")])]).await;
        let api = api(&server.base);
        let page = api.get("/notifications").await.unwrap();
        assert_eq!(page.poll_interval, Some(60));
        let page = api.get("/notifications").await.unwrap();
        assert!(page.unchanged);
        assert_eq!(server.header_of(1, "if-modified-since").as_deref(), Some("Wed, 30 Sep 2026 10:00:00 GMT"));
    }

    #[tokio::test]
    async fn pages_are_followed_and_the_first_page_decides_whether_anything_changed() {
        let server2 = serve(vec![
            ("/list", vec![Reply::ok("[1]").header("link", "</list2>; rel=\"next\"")]),
            ("/list2", vec![Reply::ok("[2]")]),
        ])
        .await;
        let (all, unchanged): (Vec<u32>, bool) = api(&server2.base).paged("/list", 5).await.unwrap();
        assert_eq!((all, unchanged), (vec![1, 2], false));
        let (capped, _): (Vec<u32>, bool) = api(&server2.base).paged("/list", 1).await.unwrap();
        assert_eq!(capped, vec![1]);
    }

    #[tokio::test]
    async fn a_nearly_empty_bucket_stops_requests_before_they_are_sent() {
        let reset = (Utc::now().timestamp() + 600).to_string();
        let server = serve(vec![("/a", vec![Reply::ok("{}").header("x-ratelimit-remaining", "3").header("x-ratelimit-reset", &reset).header("x-ratelimit-resource", "core")])]).await;
        let api = api(&server.base);
        api.get("/a").await.unwrap();
        let err = api.get("/a").await.unwrap_err();
        assert!(matches!(err, Error::RateLimited { retry_after_secs, .. } if retry_after_secs > 500), "{err}");
        assert_eq!(server.targets().len(), 1, "the second request never left");
        let search = api.get("/search/repositories?q=x").await;
        assert!(!matches!(search, Err(Error::RateLimited { .. })), "the search bucket is separate");
    }

    #[tokio::test]
    async fn an_exhausted_bucket_that_has_reset_is_used_again() {
        let past = (Utc::now().timestamp() - 5).to_string();
        let server = serve(vec![("/a", vec![Reply::ok("{}").header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", &past)])]).await;
        let api = api(&server.base);
        api.get("/a").await.unwrap();
        api.get("/a").await.unwrap();
        assert_eq!(server.targets().len(), 2);
    }

    #[tokio::test]
    async fn failures_become_friendly_errors() {
        let server = serve(vec![("/bad", vec![Reply::status(401, "{\"message\":\"Bad credentials\"}")])]).await;
        let err = api(&server.base).get("/bad").await.unwrap_err();
        assert!(err.to_string().contains("didn't accept the token"), "{err}");
    }

    #[tokio::test]
    async fn a_request_that_fails_in_transit_once_is_tried_again() {
        let server = serve(vec![("/a", vec![Reply::hang_up(), Reply::ok("[7]")])]).await;
        let (got, _): (Vec<u32>, Page) = api(&server.base).json("/a").await.unwrap();
        assert_eq!(got, vec![7]);
        assert_eq!(server.targets().len(), 2);
    }

    #[tokio::test]
    async fn three_failures_in_transit_give_up_and_name_the_cause() {
        let server = serve(vec![("/a?per_page=100", vec![Reply::hang_up()])]).await;
        let err = api(&server.base).get("/a?per_page=100").await.unwrap_err();
        assert_eq!(server.targets().len(), 3);
        assert!(err.is_transient());
        let text = err.to_string();
        assert!(text.starts_with("Network error: error sending request for url ("), "{text}");
        assert!(text.contains("/a)") && !text.contains("per_page"), "the query is dropped: {text}");
        assert!(text.matches(": ").count() >= 2, "the causes follow: {text}");
        assert!(!text.to_ascii_lowercase().contains("tok"), "{text}");
    }

    #[tokio::test]
    async fn a_gateway_error_is_tried_again_and_other_failures_are_not() {
        let server = serve(vec![
            ("/flaky", vec![Reply::status(503, "{\"message\":\"busy\"}"), Reply::status(502, ""), Reply::ok("1")]),
            ("/down", vec![Reply::status(504, "{\"message\":\"gone\"}")]),
            ("/missing", vec![Reply::status(404, "{}")]),
            ("/mine", vec![Reply::status(500, "{}")]),
        ])
        .await;
        let api = api(&server.base);
        assert_eq!(api.get("/flaky").await.unwrap().body, "1");
        let err = api.get("/down").await.unwrap_err();
        assert!(matches!(err, Error::CodeHost { status: 504, .. }) && err.is_transient(), "{err}");
        assert_eq!(server.targets().iter().filter(|t| *t == "/down").count(), 3);
        assert!(matches!(api.get("/missing").await, Err(Error::CodeHost { status: 404, .. })));
        assert!(matches!(api.get("/mine").await, Err(Error::CodeHost { status: 500, .. })));
        assert_eq!(server.targets().iter().filter(|t| *t == "/missing" || *t == "/mine").count(), 2, "neither was repeated");
    }

    #[tokio::test]
    async fn a_rate_limit_is_reported_at_once() {
        let server = serve(vec![("/a", vec![Reply::status(429, "{}").header("retry-after", "30"), Reply::ok("{}")])]).await;
        let err = api(&server.base).get("/a").await.unwrap_err();
        assert!(matches!(err, Error::RateLimited { retry_after_secs: 30, .. }), "{err}");
        assert!(!err.is_transient());
        assert_eq!(server.targets().len(), 1);
    }

    #[tokio::test]
    async fn a_retry_stays_conditional() {
        let server = serve(vec![("/a", vec![Reply::ok("[1]").header("etag", "\"v1\""), Reply::hang_up(), Reply::status(304, "")])]).await;
        let api = api(&server.base);
        api.get("/a").await.unwrap();
        let page = api.get("/a").await.unwrap();
        assert!(page.unchanged);
        assert_eq!(server.targets().len(), 3);
        assert_eq!(server.header_of(1, "if-none-match").as_deref(), Some("\"v1\""));
        assert_eq!(server.header_of(2, "if-none-match").as_deref(), Some("\"v1\""));
    }

    #[test]
    fn the_wait_before_a_retry_varies_by_a_quarter_either_way() {
        let base = Duration::from_millis(1000);
        assert_eq!(jittered(base, 0), Duration::from_millis(750));
        assert_eq!(jittered(base, 255), Duration::from_millis(1250));
        assert!(jittered(base, 128) > jittered(base, 127));
    }
}
