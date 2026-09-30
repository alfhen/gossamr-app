use std::sync::Arc;

use chrono::{DateTime, Utc};
use reqwest::multipart::{Form, Part};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::adf;
use crate::auth::{json_or_error, Auth, Scope};
use crate::error::{Error, Result};
use crate::domain::StatusDef;
use crate::model::{Attachment, CachedTicket, Comment, History, HistoryItem, ParentRef, Person, Status, SubtaskRef, TicketLink, Uploaded};

const FIELDS: &[&str] = &[
    "summary", "status", "issuetype", "priority", "assignee", "reporter", "parent", "description", "comment",
    "subtasks", "duedate", "updated", "watches", "attachment", "resolutiondate", "created", "creator", "labels",
    "issuelinks",
];
const PAGE_SIZE: u32 = 50;
const CHANGELOG_PAGE: u64 = 100;
/// Bounds the changelog pages fetched per issue in one sync, so a ticket edited by automation can't stall it.
const MAX_CHANGELOG_PAGES: usize = 10;
const PROJECT_PAGE: usize = 50;
/// A keys-only page carries almost nothing, so it can be large.
const HIT_PAGE: u32 = 100;
const COMMENT_PAGE: u64 = 100;
const MENTION_SUGGESTIONS: usize = 10;
/// Largest attachment shown in the app; bigger ones stay in Jira. Checked while reading, not after.
const PREVIEW_LIMIT: usize = 25 * 1024 * 1024;
const API_BASE: &str = "https://api.atlassian.com";
/// Rate-limited requests are retried this many times before giving up.
const RATE_RETRIES: u32 = 3;
/// A `Retry-After` longer than this is reported instead of waited out, so a sync never hangs on it.
const MAX_INLINE_WAIT_SECS: u64 = 20;

/// A transition as Jira lists it: its own id, and the status it leads to.
pub(super) struct RawTransition {
    pub id: String,
    pub name: String,
    pub to: StatusDef,
    /// Fields the transition's screen insists on and has no default for. Only read with `transitions(.., true)`.
    pub required: Vec<RequiredField>,
}

pub(super) struct RequiredField {
    pub id: String,
    pub name: String,
    /// `(id, name)` of each value Jira accepts, when it lists them.
    pub allowed: Vec<(String, String)>,
}

/// One match of a keys-only search: where the issue lives and when it last changed.
pub(super) struct Hit {
    pub key: String,
    pub project_key: String,
    pub project_name: String,
    pub updated: Option<String>,
}

/// A project as the catalog lists it.
pub(super) struct ProjectInfo {
    pub key: String,
    pub name: String,
    pub kind: Option<String>,
    pub archived: bool,
    pub last_active: Option<String>,
    pub issue_count: Option<u32>,
}

pub(super) struct IssueType {
    pub id: String,
    pub name: String,
    pub subtask: bool,
}

pub(super) struct Jira {
    http: reqwest::Client,
    /// Doesn't follow redirects, so a redirect's target can be read (see `media_id`).
    no_redirect: reqwest::Client,
    auth: Arc<Auth>,
    base: String,
}

impl Jira {
    pub(super) fn new(http: reqwest::Client, auth: Arc<Auth>) -> Self {
        Self::at(API_BASE, http, auth)
    }

    pub(super) fn at(base: &str, http: reqwest::Client, auth: Arc<Auth>) -> Self {
        let no_redirect = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("static client config");
        Self { http, no_redirect, auth, base: base.trim_end_matches('/').into() }
    }

    /// Sends one request as `scope`. It is refused before sending if the signed-in site or account is no longer
    /// `scope`, so work started for one account can never read or write as another. `build` may run several times:
    /// a 401 is retried once with a refreshed token, and a 429 (or a 503 that says when to come back) is retried after
    /// the wait Jira asks for, up to a few times, then reported as `RateLimited`.
    async fn send(
        &self,
        client: &reqwest::Client,
        scope: &Scope,
        method: Method,
        path: &str,
        build: impl Fn(RequestBuilder) -> RequestBuilder,
    ) -> Result<reqwest::Response> {
        let mut force_refresh = false;
        let mut limited = 0;
        loop {
            let creds = self.auth.credentials(force_refresh).await?;
            if &creds.scope != scope {
                return Err(Error::SiteChanged);
            }
            let url = format!("{}/ex/jira/{}/rest/api/3/{path}", self.base, scope.cloud_id);
            let res = build(client.request(method.clone(), url).bearer_auth(&creds.access_token)).send().await?;
            // A token can be revoked or rotated elsewhere before it expires; refresh once and retry.
            if res.status() == StatusCode::UNAUTHORIZED && !force_refresh {
                force_refresh = true;
                continue;
            }
            if let Some(wait) = rate_limit_wait(&res, limited) {
                if limited >= RATE_RETRIES || wait > MAX_INLINE_WAIT_SECS {
                    return Err(Error::RateLimited { message: format!("Jira is limiting requests; try again in {wait} seconds."), retry_after_secs: wait });
                }
                limited += 1;
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                continue;
            }
            return Ok(res);
        }
    }

    async fn call<T: DeserializeOwned>(&self, scope: &Scope, method: Method, path: &str, body: Option<&Value>) -> Result<T> {
        let res = self
            .send(&self.http, scope, method, path, |req| match body {
                Some(b) => req.json(b),
                None => req,
            })
            .await?;
        if !res.status().is_success() {
            return json_or_error(res).await;
        }
        decode(&res.bytes().await?)
    }

    /// Runs a JQL search and returns up to `limit` matching issues. With `history_since`, each issue carries its
    /// changelog back to at least that time (RFC 3339).
    pub(super) async fn search(&self, scope: &Scope, jql: &str, history_since: Option<&str>, limit: usize) -> Result<Vec<CachedTicket>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            #[serde(default)]
            issues: Vec<Value>,
            next_page_token: Option<String>,
        }
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut body = json!({ "jql": jql, "fields": FIELDS, "maxResults": PAGE_SIZE });
            if history_since.is_some() {
                body["expand"] = json!("changelog");
            }
            if let Some(t) = &token {
                body["nextPageToken"] = json!(t);
            }
            let page: Page = self.call(scope, Method::POST, "search/jql", Some(&body)).await?;
            for raw in &page.issues {
                if let Some(t) = parse_issue(raw) {
                    let t = self.with_all_comments(scope, t, raw).await?;
                    out.push(match history_since {
                        Some(since) => self.with_history_since(scope, t, raw, since).await?,
                        None => t,
                    });
                }
            }
            match page.next_page_token {
                Some(t) if out.len() < limit && !page.issues.is_empty() => token = Some(t),
                _ => return Ok(out),
            }
        }
    }

    /// One issue, with its changelog back to at least `history_since` (RFC 3339).
    pub(super) async fn issue(&self, scope: &Scope, key: &str, history_since: &str) -> Result<CachedTicket> {
        let raw: Value = self
            .call(scope, Method::GET, &format!("issue/{key}?fields={}&expand=changelog", FIELDS.join(",")), None)
            .await
            .map_err(|e| match e {
                Error::Api { status: 404 | 410, .. } => Error::Api { status: 404, message: format!("{key} doesn't exist, or you can no longer see it") },
                other => other,
            })?;
        let t = parse_issue(&raw).ok_or_else(|| Error::Api { status: 200, message: format!("couldn't read {key}") })?;
        let t = self.with_all_comments(scope, t, &raw).await?;
        self.with_history_since(scope, t, &raw, history_since).await
    }

    /// An issue read carries a bounded number of comments. When Jira says there are more, read them all, since the
    /// newest are the ones that become events.
    async fn with_all_comments(&self, scope: &Scope, mut t: CachedTicket, raw: &Value) -> Result<CachedTicket> {
        let total = raw.pointer("/fields/comment/total").and_then(Value::as_u64).unwrap_or(0);
        if total > t.comments.len() as u64 {
            t.comments = self.comments(scope, &t.key).await?;
        }
        Ok(t)
    }

    /// The changelog's length when the expanded one may not hold all of it. Jira may leave out `total`; a page that
    /// came back full then counts as cut off, and the changelog endpoint says how long it is.
    async fn changelog_total(&self, scope: &Scope, key: &str, raw: &Value) -> Result<Option<u64>> {
        if let Some(total) = incomplete_changelog_total(raw) {
            return Ok(Some(total));
        }
        let have = raw.pointer("/changelog/histories").and_then(Value::as_array).map_or(0, Vec::len) as u64;
        if raw.pointer("/changelog/total").is_some() || have < CHANGELOG_PAGE {
            return Ok(None);
        }
        let page: Value = self.call(scope, Method::GET, &format!("issue/{key}/changelog?startAt=0&maxResults=1"), None).await?;
        Ok(page["total"].as_u64().filter(|total| *total > have))
    }

    /// An expanded changelog holds only its first page, which is the oldest history. When there is more, replace it
    /// with the newest pages, walking back until the history reaches `since`, since that's where new events come from.
    async fn with_history_since(&self, scope: &Scope, mut t: CachedTicket, raw: &Value, since: &str) -> Result<CachedTicket> {
        let Some(total) = self.changelog_total(scope, &t.key, raw).await? else { return Ok(t) };
        let mut history = Vec::new();
        let mut end = total;
        for _ in 0..MAX_CHANGELOG_PAGES {
            let Some((start, count)) = previous_page(end) else { break };
            let path = format!("issue/{}/changelog?startAt={start}&maxResults={count}", t.key);
            let page: Value = self.call(scope, Method::GET, &path, None).await?;
            let mut older: Vec<History> = page["values"].as_array().into_iter().flatten().filter_map(parse_history).collect();
            let reached = older.first().is_none_or(|h| h.at.as_str() <= since);
            older.append(&mut history);
            history = older;
            end = start;
            if reached {
                break;
            }
        }
        t.history = history;
        Ok(t)
    }

    /// Each transition open to `key` with the status it leads to.
    pub(super) async fn transitions(&self, scope: &Scope, key: &str, with_fields: bool) -> Result<Vec<RawTransition>> {
        let expand = if with_fields { "?expand=transitions.fields" } else { "" };
        let raw: Value = self.call(scope, Method::GET, &format!("issue/{key}/transitions{expand}"), None).await?;
        Ok(parse_transitions(&raw))
    }

    pub(super) async fn transition(&self, scope: &Scope, key: &str, body: &Value) -> Result<()> {
        self.call::<Value>(scope, Method::POST, &format!("issue/{key}/transitions"), Some(body)).await?;
        Ok(())
    }

    /// Creates subtasks under `parent` using the project's first sub-task issue type, stopping at the first failure.
    /// Returns the keys created so far, in the order of `summaries`, with the error that stopped it.
    pub(super) async fn create_subtasks(&self, scope: &Scope, parent: &str, summaries: &[String]) -> Result<(Vec<String>, Option<Error>)> {
        let project = parent.split('-').next().unwrap_or(parent);
        let subtask_type = self
            .issue_types(scope, project)
            .await?
            .into_iter()
            .find(|t| t.subtask)
            .map(|t| t.id)
            .ok_or_else(|| Error::Api { status: 400, message: format!("project {project} has no sub-task issue type") })?;
        let mut created = Vec::new();
        for summary in summaries {
            let body = json!({ "fields": {
                "project": { "key": project },
                "parent": { "key": parent },
                "issuetype": { "id": subtask_type },
                "summary": summary,
            }});
            match self.call::<Value>(scope, Method::POST, "issue", Some(&body)).await {
                Ok(res) => created.push(res["key"].as_str().unwrap_or_default().to_string()),
                Err(e) => return Ok((created, Some(e))),
            }
        }
        Ok((created, None))
    }

    /// People who can see `key` and match `query`, for @mention suggestions. Apps and deactivated users are left out.
    pub(super) async fn mentionable(&self, scope: &Scope, key: &str, query: &str) -> Result<Vec<Person>> {
        let encode = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        // Jira takes `maxResults` users first and filters that range by `query` afterwards, so a small page would
        // hide most of a site's people. 1,000 is the endpoint's ceiling.
        let path = format!("user/viewissue/search?issueKey={}&query={}&maxResults=1000", encode(key), encode(query));
        let raw: Value = self.call(scope, Method::GET, &path, None).await?;
        Ok(raw
            .as_array()
            .into_iter()
            .flatten()
            .filter(|u| u["active"] != false && u["accountType"].as_str().is_none_or(|t| t == "atlassian"))
            .filter_map(person)
            .take(MENTION_SUGGESTIONS)
            .collect())
    }

    /// Jira's per-file upload limit in bytes, or `None` when attachments are turned off on the site.
    pub(super) async fn attachment_limit(&self, scope: &Scope) -> Result<Option<u64>> {
        let meta: Value = self.call(scope, Method::GET, "attachment/meta", None).await?;
        Ok(if meta["enabled"] == false { None } else { meta["uploadLimit"].as_u64() })
    }

    /// Uploads a file to `key`, then looks up its media id so a comment can show it inline.
    pub(super) async fn attach(&self, scope: &Scope, key: &str, filename: &str, mime_type: &str, bytes: Vec<u8>) -> Result<Uploaded> {
        let mime_type = if Part::bytes(Vec::new()).mime_str(mime_type).is_ok() { mime_type } else { "application/octet-stream" };
        let res = self
            .send(&self.http, scope, Method::POST, &format!("issue/{key}/attachments"), |req| {
                let part = Part::bytes(bytes.clone()).file_name(filename.to_string()).mime_str(mime_type).expect("checked above");
                // Required by Jira for multipart uploads, as protection against cross-site requests.
                req.header("X-Atlassian-Token", "no-check").multipart(Form::new().part("file", part))
            })
            .await?;
        let created: Vec<Value> = json_or_error(res).await?;
        let a = created.first().ok_or_else(|| Error::Api { status: 200, message: "Jira didn't return the upload".into() })?;
        let id = a["id"].as_str().map(String::from).or_else(|| a["id"].as_u64().map(|n| n.to_string())).unwrap_or_default();
        let media_id = self.media_id(scope, &id).await.unwrap_or(None);
        Ok(Uploaded {
            filename: a["filename"].as_str().unwrap_or(filename).to_string(),
            mime_type: a["mimeType"].as_str().unwrap_or(mime_type).to_string(),
            id,
            media_id,
            width: None,
            height: None,
        })
    }

    /// The media-service id of an attachment. Jira's API only exposes it through the redirect its content download
    /// answers with (`…/file/{mediaId}/binary`), so this reads that redirect without following it.
    pub(super) async fn media_id(&self, scope: &Scope, attachment_id: &str) -> Result<Option<String>> {
        let res = self.send(&self.no_redirect, scope, Method::GET, &format!("attachment/content/{attachment_id}"), |r| r).await?;
        if !res.status().is_redirection() {
            return Ok(None);
        }
        Ok(res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).and_then(media_id_from_location))
    }

    /// An attachment's content type and bytes. The download redirects to the media service with a signed URL;
    /// reqwest drops the bearer token when following it to another host.
    pub(super) async fn download(&self, scope: &Scope, id: &str) -> Result<(String, Vec<u8>)> {
        let res = self.send(&self.http, scope, Method::GET, &format!("attachment/content/{id}"), |r| r).await?;
        if !res.status().is_success() {
            return Err(Error::Api { status: res.status().as_u16(), message: format!("couldn't download attachment {id}") });
        }
        let mime = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let too_big = || Error::Api { status: 413, message: format!("attachment {id} is too large to preview") };
        if res.content_length().is_some_and(|n| n > PREVIEW_LIMIT as u64) {
            return Err(too_big());
        }
        let mut res = res;
        let mut bytes = Vec::with_capacity(res.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = res.chunk().await? {
            if bytes.len() + chunk.len() > PREVIEW_LIMIT {
                return Err(too_big());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((mime, bytes))
    }

    pub(super) async fn comment(&self, scope: &Scope, key: &str, body: &Value) -> Result<()> {
        self.call::<Value>(scope, Method::POST, &format!("issue/{key}/comment"), Some(&json!({ "body": body }))).await?;
        Ok(())
    }

    pub(super) async fn comments(&self, scope: &Scope, key: &str) -> Result<Vec<Comment>> {
        let mut out = Vec::new();
        let mut start = 0u64;
        loop {
            let page: Value = self.call(scope, Method::GET, &format!("issue/{key}/comment?startAt={start}&maxResults={COMMENT_PAGE}"), None).await?;
            let raw = page["comments"].as_array().map(Vec::as_slice).unwrap_or_default();
            out.extend(raw.iter().filter_map(parse_comment));
            start += raw.len() as u64;
            if raw.is_empty() || start >= page["total"].as_u64().unwrap_or(0) {
                return Ok(out);
            }
        }
    }

    /// Projects the person can see, as `(key, name)`, up to `limit`.
    pub(super) async fn projects(&self, scope: &Scope, limit: usize) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        let mut start = 0;
        while out.len() < limit {
            let page: Value = self.call(scope, Method::GET, &format!("project/search?startAt={start}&maxResults={PROJECT_PAGE}"), None).await?;
            let read = page["values"].as_array().map_or(0, Vec::len);
            let empty = read == 0;
            start += read;
            out.extend(parse_projects(&page));
            if empty || page["isLast"] == true {
                break;
            }
        }
        out.truncate(limit);
        Ok(out)
    }

    /// Matches of a JQL search with only each issue's key, project and update time, up to `cap`.
    pub(super) async fn search_hits(&self, scope: &Scope, jql: &str, cap: usize) -> Result<Vec<Hit>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Page {
            #[serde(default)]
            issues: Vec<Value>,
            next_page_token: Option<String>,
        }
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut body = json!({ "jql": jql, "fields": ["project", "updated"], "maxResults": HIT_PAGE });
            if let Some(t) = &token {
                body["nextPageToken"] = json!(t);
            }
            let page: Page = self.call(scope, Method::POST, "search/jql", Some(&body)).await?;
            out.extend(page.issues.iter().filter_map(parse_hit));
            match page.next_page_token {
                Some(t) if out.len() < cap && !page.issues.is_empty() => token = Some(t),
                _ => {
                    out.truncate(cap);
                    return Ok(out);
                }
            }
        }
    }

    /// One page of projects matching `query`, from `start`, and whether it was the last.
    pub(super) async fn project_page(&self, scope: &Scope, query: &str, start: usize, limit: usize) -> Result<(Vec<ProjectInfo>, bool)> {
        let encode = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let path = format!("project/search?startAt={start}&maxResults={}&expand=insight&query={}", limit.min(PROJECT_PAGE), encode(query));
        let page: Value = self.call(scope, Method::GET, &path, None).await?;
        let empty = page["values"].as_array().is_none_or(|v| v.is_empty());
        Ok((parse_project_infos(&page), empty || page["isLast"] == true))
    }

    /// The projects among `keys` that exist and can be read, as `(key, name)`.
    pub(super) async fn projects_by_keys(&self, scope: &Scope, keys: &[&str]) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for chunk in keys.chunks(PROJECT_PAGE) {
            let keys: String = chunk.iter().map(|k| format!("&keys={}", url::form_urlencoded::byte_serialize(k.as_bytes()).collect::<String>())).collect();
            let page: Value = self.call(scope, Method::GET, &format!("project/search?maxResults={PROJECT_PAGE}{keys}"), None).await?;
            out.extend(parse_projects(&page));
        }
        Ok(out)
    }

    pub(super) async fn project_statuses(&self, scope: &Scope, project: &str) -> Result<Vec<StatusDef>> {
        let raw: Value = self.call(scope, Method::GET, &format!("project/{project}/statuses"), None).await?;
        Ok(parse_project_statuses(&raw))
    }

    pub(super) async fn issue_types(&self, scope: &Scope, project: &str) -> Result<Vec<IssueType>> {
        let raw: Value = self.call(scope, Method::GET, &format!("issue/createmeta/{project}/issuetypes"), None).await?;
        Ok(parse_issue_types(&raw))
    }

    /// Creates an issue from a `fields` object and returns its key.
    pub(super) async fn create_issue(&self, scope: &Scope, fields: Value) -> Result<String> {
        let res: Value = self.call(scope, Method::POST, "issue", Some(&json!({ "fields": fields }))).await?;
        res["key"].as_str().map(String::from).ok_or_else(|| Error::Api { status: 200, message: "Jira didn't return the new issue's key".into() })
    }

    pub(super) async fn update_issue(&self, scope: &Scope, key: &str, fields: Value) -> Result<()> {
        self.call::<Value>(scope, Method::PUT, &format!("issue/{key}"), Some(&json!({ "fields": fields }))).await?;
        Ok(())
    }

    pub(super) async fn link_issues(&self, scope: &Scope, body: &Value) -> Result<()> {
        self.call::<Value>(scope, Method::POST, "issueLink", Some(body)).await?;
        Ok(())
    }
}

/// A success body as `T`. Several Jira writes answer 201 or 204 with nothing (`issueLink`, transitions, updates),
/// which reads as `null`.
fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::from_value(Value::Null)?);
    }
    Ok(serde_json::from_slice(bytes)?)
}

/// How long Jira wants us to wait, when the response is a rate limit: a 429, or a 503 that carries `Retry-After`.
/// Without the header the wait doubles per attempt, as Atlassian advises.
fn rate_limit_wait(res: &reqwest::Response, attempt: u32) -> Option<u64> {
    let asked = res.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| retry_after_secs(v, Utc::now()));
    match res.status() {
        StatusCode::TOO_MANY_REQUESTS => Some(asked.unwrap_or(2u64 << attempt.min(6))),
        StatusCode::SERVICE_UNAVAILABLE => asked,
        _ => None,
    }
}

/// A `Retry-After` value: a number of seconds, or an HTTP date (a past one meaning now).
fn retry_after_secs(value: &str, now: DateTime<Utc>) -> Option<u64> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(secs);
    }
    let at = DateTime::parse_from_rfc2822(value).ok()?;
    Some((at.with_timezone(&Utc) - now).num_seconds().max(0) as u64)
}

/// Jira timestamps look like `2026-09-28T10:00:00.000+0200`; normalise to UTC RFC 3339 so they sort as strings.
pub(super) fn normalise_time(s: &str) -> String {
    DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f%z")
        .or_else(|_| DateTime::parse_from_rfc3339(s))
        .map(|d| d.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|_| s.to_string())
}

fn person(v: &Value) -> Option<Person> {
    Some(Person {
        account_id: v["accountId"].as_str()?.to_string(),
        name: v["displayName"].as_str().unwrap_or("Someone").to_string(),
        avatar_url: v.pointer("/avatarUrls/48x48").and_then(Value::as_str).map(String::from),
    })
}

/// Jira leaves the author off changes made by deleted accounts, imports and some automation. Their events still count.
fn person_or_unknown(v: &Value) -> Person {
    person(v).unwrap_or_else(|| Person { account_id: "unknown".into(), name: "Someone".into(), avatar_url: None })
}

fn status(v: &Value) -> Option<Status> {
    Some(Status {
        id: v["id"].as_str().unwrap_or_default().to_string(),
        name: v["name"].as_str()?.to_string(),
        category: v.pointer("/statusCategory/key").and_then(Value::as_str).unwrap_or("indeterminate").to_string(),
    })
}

fn doc(v: &Value) -> Option<Value> {
    v.is_object().then(|| v.clone())
}

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(String::from)
}

fn media_id_from_location(location: &str) -> Option<String> {
    let id = location.split("/file/").nth(1)?.split(['/', '?']).next()?;
    (id.len() >= 32 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then(|| id.to_string())
}

/// The changelog's total length, if the expanded changelog didn't include all of it.
fn incomplete_changelog_total(raw: &Value) -> Option<u64> {
    let total = raw.pointer("/changelog/total").and_then(Value::as_u64)?;
    let have = raw.pointer("/changelog/histories").and_then(Value::as_array).map_or(0, |h| h.len() as u64);
    (total > have).then_some(total)
}

/// The page just before `end` as `(startAt, maxResults)`, or `None` at the beginning. Pages never overlap.
fn previous_page(end: u64) -> Option<(u64, u64)> {
    (end > 0).then(|| {
        let start = end.saturating_sub(CHANGELOG_PAGE);
        (start, end - start)
    })
}

fn parse_history(h: &Value) -> Option<History> {
    Some(History {
        id: h["id"].as_str()?.to_string(),
        author: person_or_unknown(&h["author"]),
        at: normalise_time(h["created"].as_str()?),
        items: h["items"]
            .as_array()?
            .iter()
            .map(|i| HistoryItem {
                field: i["field"].as_str().unwrap_or_default().to_string(),
                from: str_of(&i["fromString"]),
                to: str_of(&i["toString"]),
                to_id: str_of(&i["to"]),
            })
            .collect(),
    })
}

fn parse_comment(c: &Value) -> Option<Comment> {
    Some(Comment {
        id: c["id"].as_str()?.to_string(),
        author: person_or_unknown(&c["author"]),
        created: normalise_time(c["created"].as_str()?),
        body: adf::to_text(&c["body"]),
        mentions: adf::mentions(&c["body"]),
        mentioned: adf::mentioned(&c["body"]),
        doc: doc(&c["body"]),
    })
}

fn parse_projects(page: &Value) -> Vec<(String, String)> {
    page["values"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p["key"].as_str()?.to_string(), p["name"].as_str()?.to_string())))
        .collect()
}

fn parse_hit(issue: &Value) -> Option<Hit> {
    let project = &issue["fields"]["project"];
    Some(Hit {
        key: issue["key"].as_str()?.to_string(),
        project_key: project["key"].as_str()?.to_string(),
        project_name: project["name"].as_str().unwrap_or_default().to_string(),
        updated: issue["fields"]["updated"].as_str().map(normalise_time),
    })
}

fn parse_project_infos(page: &Value) -> Vec<ProjectInfo> {
    page["values"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(ProjectInfo {
                key: p["key"].as_str()?.to_string(),
                name: p["name"].as_str()?.to_string(),
                kind: p["projectTypeKey"].as_str().map(String::from),
                archived: p["archived"] == true,
                last_active: p.pointer("/insight/lastIssueUpdateTime").and_then(Value::as_str).map(normalise_time),
                issue_count: p.pointer("/insight/totalIssueCount").and_then(Value::as_u64).map(|n| n as u32),
            })
        })
        .collect()
}

/// Jira has answered with `issueTypes` and with `values` for this endpoint; either is read.
fn parse_issue_types(raw: &Value) -> Vec<IssueType> {
    raw["issueTypes"]
        .as_array()
        .or_else(|| raw["values"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| Some(IssueType { id: t["id"].as_str()?.into(), name: t["name"].as_str()?.into(), subtask: t["subtask"] == true }))
        .collect()
}

pub(super) fn parse_transitions(raw: &Value) -> Vec<RawTransition> {
    raw["transitions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            Some(RawTransition { id: t["id"].as_str()?.into(), name: t["name"].as_str()?.into(), to: status_def(&t["to"])?, required: required_fields(&t["fields"]) })
        })
        .collect()
}

fn required_fields(fields: &Value) -> Vec<RequiredField> {
    fields
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, f)| f["required"] == true && f["hasDefaultValue"] != true)
        .map(|(id, f)| RequiredField {
            id: f["fieldId"].as_str().unwrap_or(id).into(),
            name: f["name"].as_str().unwrap_or(id).into(),
            allowed: f["allowedValues"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    let id = v["id"].as_str().map(String::from).or_else(|| v["id"].as_u64().map(|n| n.to_string()))?;
                    Some((id, v["name"].as_str().or_else(|| v["value"].as_str())?.to_string()))
                })
                .collect(),
        })
        .collect()
}

/// A status from a project's statuses, once per id across issue types.
fn parse_project_statuses(raw: &Value) -> Vec<StatusDef> {
    let mut out: Vec<StatusDef> = Vec::new();
    for def in raw.as_array().into_iter().flatten().flat_map(|t| t["statuses"].as_array().into_iter().flatten()).filter_map(status_def) {
        if !out.iter().any(|s| s.id == def.id) {
            out.push(def);
        }
    }
    out
}

pub(super) fn status_def(v: &Value) -> Option<StatusDef> {
    use crate::domain::Category;
    let category = match v.pointer("/statusCategory/key").and_then(Value::as_str) {
        Some("new") => Category::Todo,
        Some("done") => Category::Done,
        _ => Category::Active,
    };
    Some(StatusDef { id: v["id"].as_str()?.into(), name: v["name"].as_str()?.into(), category })
}

fn parse_link(raw: &Value) -> Option<TicketLink> {
    let kind = raw.pointer("/type/name").and_then(Value::as_str)?.to_string();
    let (other, outward) = match (raw.pointer("/outwardIssue/key"), raw.pointer("/inwardIssue/key")) {
        (Some(k), _) => (k.as_str()?, true),
        (None, Some(k)) => (k.as_str()?, false),
        _ => return None,
    };
    Some(TicketLink { kind, other: other.to_string(), outward })
}

pub(in crate::tracker) fn parse_issue(raw: &Value) -> Option<CachedTicket> {
    let f = &raw["fields"];
    let key = raw["key"].as_str()?.to_string();
    let comments = f
        .pointer("/comment/comments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_comment)
        .collect();
    let history = raw
        .pointer("/changelog/histories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_history)
        .collect();
    let attachments = f["attachment"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            Some(Attachment {
                id: a["id"].as_str()?.to_string(),
                filename: a["filename"].as_str().unwrap_or_default().to_string(),
                mime_type: a["mimeType"].as_str().unwrap_or("application/octet-stream").to_string(),
                size: a["size"].as_u64().unwrap_or(0),
            })
        })
        .collect();
    let subtasks = f["subtasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(SubtaskRef {
                key: s["key"].as_str()?.to_string(),
                summary: s.pointer("/fields/summary").and_then(Value::as_str).unwrap_or_default().to_string(),
                done: s.pointer("/fields/status/statusCategory/key").and_then(Value::as_str) == Some("done"),
            })
        })
        .collect();

    Some(CachedTicket {
        key,
        summary: f["summary"].as_str().unwrap_or_default().to_string(),
        issue_type: f.pointer("/issuetype/name").and_then(Value::as_str).unwrap_or("Issue").to_string(),
        is_epic: f.pointer("/issuetype/hierarchyLevel").and_then(Value::as_i64) == Some(1),
        status: status(&f["status"])?,
        priority: f.pointer("/priority/name").and_then(Value::as_str).map(String::from),
        assignee: person(&f["assignee"]),
        reporter: person(&f["reporter"]),
        parent: f["parent"]["key"].as_str().map(|k| ParentRef {
            key: k.to_string(),
            summary: f.pointer("/parent/fields/summary").and_then(Value::as_str).unwrap_or_default().to_string(),
        }),
        description: adf::to_text(&f["description"]),
        description_doc: doc(&f["description"]),
        comments,
        attachments,
        subtasks,
        due_date: str_of(&f["duedate"]),
        updated: f["updated"].as_str().map(normalise_time).unwrap_or_default(),
        resolved: f["resolutiondate"].as_str().map(normalise_time),
        created: f["created"].as_str().map(normalise_time),
        creator: person(&f["creator"]),
        watching: f.pointer("/watches/isWatching").and_then(Value::as_bool).unwrap_or(false),
        history,
        labels: f["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(String::from)).collect(),
        links: f["issuelinks"].as_array().into_iter().flatten().filter_map(parse_link).collect(),
    })
}

#[cfg(test)]
pub(in crate::tracker) mod tests {
    use super::*;

    pub(in crate::tracker) fn sample_issue() -> Value {
        json!({
            "key": "CA-1",
            "fields": {
                "summary": "Do the thing",
                "status": {"id": "3", "name": "In Review", "statusCategory": {"key": "indeterminate"}},
                "issuetype": {"name": "Story", "hierarchyLevel": 0},
                "priority": {"name": "High"},
                "assignee": {"accountId": "me", "displayName": "Me Myself"},
                "reporter": null,
                "parent": {"key": "CA-0", "fields": {"summary": "Epic"}},
                "description": {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hi"}]}]},
                "comment": {"comments": [{
                    "id": "10", "author": {"accountId": "sam", "displayName": "Sam"},
                    "created": "2026-09-28T10:00:00.000+0200",
                    "body": {"type":"doc","content":[{"type":"paragraph","content":[{"type":"mention","attrs":{"id":"me","text":"@Me"}}]}]}
                }]},
                "subtasks": [{"key": "CA-2", "fields": {"summary": "Sub", "status": {"statusCategory": {"key": "done"}}}}],
                "duedate": "2026-10-17",
                "updated": "2026-09-28T10:05:00.000+0200",
                "watches": {"isWatching": true},
                "attachment": [{"id": "10001", "filename": "shot.png", "mimeType": "image/png", "size": 2048}],
                "resolutiondate": null,
                "created": "2026-09-20T09:00:00.000+0200",
                "creator": {"accountId": "me", "displayName": "Me Myself"},
                "labels": ["backend", "urgent"],
                "issuelinks": [
                    {"type": {"name": "Blocks"}, "outwardIssue": {"key": "CA-7"}},
                    {"type": {"name": "Blocks"}, "inwardIssue": {"key": "CA-8"}},
                    {"type": {"name": "Relates"}}
                ]
            },
            "changelog": {"histories": [{
                "id": "500", "author": {"accountId": "sam", "displayName": "Sam"},
                "created": "2026-09-28T09:00:00.000+0200",
                "items": [{"field": "status", "fromString": "In Progress", "toString": "In Review", "to": "3"}]
            }]}
        })
    }

    #[test]
    fn an_empty_success_body_reads_as_null() {
        assert_eq!(decode::<Value>(b"").unwrap(), Value::Null);
        assert_eq!(decode::<Value>(b"\n").unwrap(), Value::Null);
        assert_eq!(decode::<Value>(br#"{"key":"CA-2"}"#).unwrap()["key"], "CA-2");
        assert!(decode::<Value>(b"<html>").is_err());
    }

    #[test]
    fn parses_an_issue_with_comments_history_and_subtasks() {
        let t = parse_issue(&sample_issue()).unwrap();
        assert_eq!(t.key, "CA-1");
        assert_eq!(t.status.name, "In Review");
        assert_eq!(t.assignee.unwrap().account_id, "me");
        assert!(t.reporter.is_none());
        assert_eq!(t.parent.unwrap().key, "CA-0");
        assert_eq!(t.description, "Hi");
        assert_eq!(t.comments[0].mentions, vec!["me"]);
        assert_eq!(t.comments[0].created, "2026-09-28T08:00:00Z");
        assert!(t.subtasks[0].done);
        assert!(t.watching);
        assert_eq!((t.attachments[0].id.as_str(), t.attachments[0].mime_type.as_str()), ("10001", "image/png"));
        assert_eq!(t.history[0].items[0].to.as_deref(), Some("In Review"));
        assert_eq!((t.resolved, t.created.as_deref()), (None, Some("2026-09-20T07:00:00Z")));
        assert_eq!(t.creator.unwrap().account_id, "me");
        assert_eq!(t.labels, ["backend", "urgent"]);
        assert_eq!(
            t.links,
            vec![
                TicketLink { kind: "Blocks".into(), other: "CA-7".into(), outward: true },
                TicketLink { kind: "Blocks".into(), other: "CA-8".into(), outward: false },
            ]
        );
    }

    #[test]
    fn pages_the_changelog_only_when_the_expanded_one_is_incomplete() {
        let mut raw = sample_issue();
        assert_eq!(incomplete_changelog_total(&raw), None, "no total means nothing to page");
        raw["changelog"]["total"] = json!(1);
        assert_eq!(incomplete_changelog_total(&raw), None);
        raw["changelog"]["total"] = json!(250);
        assert_eq!(incomplete_changelog_total(&raw), Some(250));
    }

    #[test]
    fn walks_back_through_changelog_pages_without_overlap() {
        let mut pages = Vec::new();
        let mut end = 250;
        while let Some((start, count)) = previous_page(end) {
            pages.push((start, count));
            end = start;
        }
        assert_eq!(pages, vec![(150, 100), (50, 100), (0, 50)]);
        assert_eq!(previous_page(0), None);
    }

    #[test]
    fn reads_the_media_id_from_a_content_redirect() {
        let id = "3f5b1c2a-9d4e-4b7a-8c1f-2e6d9a0b7c34";
        let loc = format!("https://api.media.atlassian.com/file/{id}/binary?token=abc&client=xyz&collection=&dl=true");
        assert_eq!(media_id_from_location(&loc).as_deref(), Some(id));
        assert_eq!(media_id_from_location("https://example.com/secure/attachment/10001/a.png"), None);
        assert_eq!(media_id_from_location("https://api.media.atlassian.com/file/not-an-id/binary"), None);
    }

    #[test]
    fn retry_after_is_seconds_or_an_http_date() {
        let now = DateTime::parse_from_rfc3339("2026-09-30T12:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(retry_after_secs("30", now), Some(30));
        assert_eq!(retry_after_secs(" 0 ", now), Some(0));
        assert_eq!(retry_after_secs("Wed, 30 Sep 2026 12:01:30 GMT", now), Some(90));
        assert_eq!(retry_after_secs("Wed, 30 Sep 2026 11:00:00 GMT", now), Some(0), "a date in the past means now");
        assert_eq!(retry_after_secs("soon", now), None);
    }

    #[test]
    fn normalises_jira_timestamps_to_utc() {
        assert_eq!(normalise_time("2026-09-28T10:00:00.123+0200"), "2026-09-28T08:00:00Z");
        assert_eq!(normalise_time("2026-09-28T08:00:00Z"), "2026-09-28T08:00:00Z");
        assert_eq!(normalise_time("garbage"), "garbage");
    }

    #[test]
    fn reads_transitions_with_the_status_each_leads_to() {
        let raw = json!({"transitions": [
            {"id": "11", "name": "Start", "to": {"id": "3", "name": "In Progress", "statusCategory": {"key": "indeterminate"}}},
            {"id": "31", "name": "Finish", "to": {"id": "5", "name": "Done", "statusCategory": {"key": "done"}}},
            {"id": "99", "name": "Broken", "to": {"name": "no id"}}
        ]});
        let ts = parse_transitions(&raw);
        assert_eq!(ts.len(), 2);
        assert_eq!((ts[0].id.as_str(), ts[0].to.id.as_str()), ("11", "3"));
        assert_eq!(ts[1].to.category, crate::domain::Category::Done);
    }

    #[test]
    fn reads_documented_project_and_issue_type_pages() {
        let projects = json!({ "self": "x", "maxResults": 50, "startAt": 0, "total": 2, "isLast": true, "values": [
            { "expand": "description", "id": "10000", "key": "EX", "name": "Example", "projectTypeKey": "software" },
            { "id": "10001", "key": "ABC", "name": "Alphabetical" }
        ]});
        assert_eq!(parse_projects(&projects), [("EX".to_string(), "Example".to_string()), ("ABC".to_string(), "Alphabetical".to_string())]);
        let types = json!({ "issueTypes": [
            { "id": "10000", "name": "Task", "subtask": false, "hierarchyLevel": 0 },
            { "id": "10002", "name": "Sub-task", "subtask": true, "hierarchyLevel": -1 }
        ], "maxResults": 50, "startAt": 0, "total": 2 });
        let parsed = parse_issue_types(&types);
        assert_eq!(parsed.iter().map(|t| (t.id.as_str(), t.subtask)).collect::<Vec<_>>(), [("10000", false), ("10002", true)]);
        assert_eq!(parse_issue_types(&json!({ "values": [{ "id": "1", "name": "Bug" }] })).len(), 1);
    }

    #[test]
    fn reads_keys_only_hits_and_catalog_entries_with_their_insight() {
        let hit = parse_hit(&json!({ "key": "WHS-4", "fields": { "project": { "key": "WHS", "name": "Warehouse" }, "updated": "2026-09-28T10:00:00.000+0200" } })).unwrap();
        assert_eq!((hit.key.as_str(), hit.project_key.as_str(), hit.project_name.as_str()), ("WHS-4", "WHS", "Warehouse"));
        assert_eq!(hit.updated.as_deref(), Some("2026-09-28T08:00:00Z"));
        assert!(parse_hit(&json!({ "key": "X-1", "fields": {} })).is_none());
        let page = json!({ "values": [
            { "key": "A", "name": "Alpha", "projectTypeKey": "service_desk", "archived": true, "insight": { "lastIssueUpdateTime": "2026-09-01T00:00:00.000+0000", "totalIssueCount": 12 } },
            { "key": "B", "name": "Beta" }
        ]});
        let infos = parse_project_infos(&page);
        assert_eq!((infos[0].kind.as_deref(), infos[0].archived, infos[0].issue_count), (Some("service_desk"), true, Some(12)));
        assert_eq!(infos[0].last_active.as_deref(), Some("2026-09-01T00:00:00Z"));
        assert_eq!((infos[1].archived, infos[1].issue_count), (false, None));
    }

    #[test]
    fn reads_a_documented_comment_page() {
        let page = json!({ "startAt": 0, "maxResults": 100, "total": 1, "comments": [{
            "id": "10000", "self": "x",
            "author": { "accountId": "5b10a2844c20165700ede21g", "displayName": "Mia Krystof", "active": true, "avatarUrls": { "48x48": "https://a/48" } },
            "body": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Lorem ipsum" }] }] },
            "created": "2021-01-17T12:34:00.000+0000", "updated": "2021-01-18T23:45:00.000+0000"
        }]});
        let comments: Vec<Comment> = page["comments"].as_array().unwrap().iter().filter_map(parse_comment).collect();
        assert_eq!((comments[0].body.as_str(), comments[0].created.as_str()), ("Lorem ipsum", "2021-01-17T12:34:00Z"));
        assert_eq!(comments[0].author.avatar_url.as_deref(), Some("https://a/48"));
    }

    #[test]
    fn a_projects_statuses_are_listed_once_across_issue_types() {
        let raw = json!([
            {"name": "Task", "statuses": [
                {"id": "1", "name": "To Do", "statusCategory": {"key": "new"}},
                {"id": "3", "name": "In Progress", "statusCategory": {"key": "indeterminate"}}
            ]},
            {"name": "Bug", "statuses": [
                {"id": "1", "name": "To Do", "statusCategory": {"key": "new"}},
                {"id": "5", "name": "Done", "statusCategory": {"key": "done"}}
            ]}
        ]);
        let names: Vec<String> = parse_project_statuses(&raw).into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["To Do", "In Progress", "Done"]);
    }
}
