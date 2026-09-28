use std::sync::Arc;

use chrono::{DateTime, Utc};
use reqwest::multipart::{Form, Part};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::adf;
use crate::auth::{json_or_error, Auth, Scope};
use crate::error::{Error, Result};
use crate::model::{Attachment, CachedTicket, Comment, History, HistoryItem, ParentRef, Person, Status, SubtaskRef, Transition, Uploaded};

const FIELDS: &[&str] = &[
    "summary", "status", "issuetype", "priority", "assignee", "reporter", "parent", "description", "comment",
    "subtasks", "duedate", "updated", "watches", "attachment",
];
const PAGE_SIZE: u32 = 50;
const CHANGELOG_PAGE: u64 = 100;
/// Bounds the changelog pages fetched per issue in one sync, so a ticket edited by automation can't stall it.
const MAX_CHANGELOG_PAGES: usize = 10;
/// Tickets the inbox tracks. Anything past this drops out of the inbox, so it is a sanity bound, not a page size.
pub const TRACKED_LIMIT: usize = 2000;
/// Tickets read for context, such as an epic's children, so a very broad JQL can't stall a sync.
pub const CONTEXT_LIMIT: usize = 300;
const MENTION_SUGGESTIONS: usize = 10;
/// Largest attachment shown in the app; bigger ones stay in Jira. Checked while reading, not after.
const PREVIEW_LIMIT: usize = 25 * 1024 * 1024;

pub struct Jira {
    http: reqwest::Client,
    /// Doesn't follow redirects, so a redirect's target can be read (see `media_id`).
    no_redirect: reqwest::Client,
    auth: Arc<Auth>,
}

impl Jira {
    pub fn new(http: reqwest::Client, auth: Arc<Auth>) -> Self {
        let no_redirect = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("static client config");
        Self { http, no_redirect, auth }
    }

    /// Sends one request as `scope`. It is refused before sending if the signed-in site or account is no longer
    /// `scope`, so work started for one account can never read or write as another. `build` may run twice, since a
    /// 401 is retried once with a refreshed token.
    async fn send(
        &self,
        client: &reqwest::Client,
        scope: &Scope,
        method: Method,
        path: &str,
        build: impl Fn(RequestBuilder) -> RequestBuilder,
    ) -> Result<reqwest::Response> {
        let mut force_refresh = false;
        loop {
            let creds = self.auth.credentials(force_refresh).await?;
            if &creds.scope != scope {
                return Err(Error::SiteChanged);
            }
            let url = format!("https://api.atlassian.com/ex/jira/{}/rest/api/3/{path}", scope.cloud_id);
            let res = build(client.request(method.clone(), url).bearer_auth(&creds.access_token)).send().await?;
            // A token can be revoked or rotated elsewhere before it expires; refresh once and retry.
            if res.status() == StatusCode::UNAUTHORIZED && !force_refresh {
                force_refresh = true;
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
        if res.status() == StatusCode::NO_CONTENT {
            return Ok(serde_json::from_value(Value::Null)?);
        }
        json_or_error(res).await
    }

    /// Runs a JQL search and returns up to `limit` matching issues. With `history_since`, each issue carries its
    /// changelog back to at least that time (RFC 3339).
    pub async fn search(&self, scope: &Scope, jql: &str, history_since: Option<&str>, limit: usize) -> Result<Vec<CachedTicket>> {
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
                    out.push(match history_since {
                        Some(since) => self.with_history_since(scope, t, raw, since).await?,
                        None => t,
                    });
                }
            }
            match page.next_page_token {
                Some(t) if out.len() < limit => token = Some(t),
                _ => return Ok(out),
            }
        }
    }

    /// One issue, with its changelog back to at least `history_since` (RFC 3339).
    pub async fn issue(&self, scope: &Scope, key: &str, history_since: &str) -> Result<CachedTicket> {
        let raw: Value = self
            .call(scope, Method::GET, &format!("issue/{key}?fields={}&expand=changelog", FIELDS.join(",")), None)
            .await?;
        let t = parse_issue(&raw).ok_or_else(|| Error::Api { status: 200, message: format!("couldn't read {key}") })?;
        self.with_history_since(scope, t, &raw, history_since).await
    }

    /// An expanded changelog holds only its first page, which is the oldest history. When there is more, replace it
    /// with the newest pages, walking back until the history reaches `since`, since that's where new events come from.
    async fn with_history_since(&self, scope: &Scope, mut t: CachedTicket, raw: &Value, since: &str) -> Result<CachedTicket> {
        let Some(total) = incomplete_changelog_total(raw) else { return Ok(t) };
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

    pub async fn transitions(&self, scope: &Scope, key: &str) -> Result<Vec<Transition>> {
        let raw: Value = self.call(scope, Method::GET, &format!("issue/{key}/transitions"), None).await?;
        Ok(raw["transitions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| {
                Some(Transition { id: t["id"].as_str()?.into(), name: t["name"].as_str()?.into(), to: status(&t["to"])? })
            })
            .collect())
    }

    pub async fn transition(&self, scope: &Scope, key: &str, transition_id: &str) -> Result<()> {
        let body = json!({ "transition": { "id": transition_id } });
        self.call::<Value>(scope, Method::POST, &format!("issue/{key}/transitions"), Some(&body)).await?;
        Ok(())
    }

    /// Creates subtasks under `parent` using the project's first sub-task issue type, stopping at the first failure.
    /// Returns the keys created so far, in the order of `summaries`, with the error that stopped it.
    pub async fn create_subtasks(&self, scope: &Scope, parent: &str, summaries: &[String]) -> Result<(Vec<String>, Option<Error>)> {
        let project = parent.split('-').next().unwrap_or(parent);
        let types: Value = self.call(scope, Method::GET, &format!("issue/createmeta/{project}/issuetypes"), None).await?;
        let subtask_type = types["issueTypes"]
            .as_array()
            .or_else(|| types["values"].as_array())
            .into_iter()
            .flatten()
            .find(|t| t["subtask"] == true)
            .and_then(|t| t["id"].as_str())
            .ok_or_else(|| Error::Api { status: 400, message: format!("project {project} has no sub-task issue type") })?
            .to_string();
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
    pub async fn mentionable(&self, scope: &Scope, key: &str, query: &str) -> Result<Vec<Person>> {
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
    pub async fn attachment_limit(&self, scope: &Scope) -> Result<Option<u64>> {
        let meta: Value = self.call(scope, Method::GET, "attachment/meta", None).await?;
        Ok(if meta["enabled"] == false { None } else { meta["uploadLimit"].as_u64() })
    }

    /// Uploads a file to `key`, then looks up its media id so a comment can show it inline.
    pub async fn attach(&self, scope: &Scope, key: &str, filename: &str, mime_type: &str, bytes: Vec<u8>) -> Result<Uploaded> {
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
    pub async fn media_id(&self, scope: &Scope, attachment_id: &str) -> Result<Option<String>> {
        let res = self.send(&self.no_redirect, scope, Method::GET, &format!("attachment/content/{attachment_id}"), |r| r).await?;
        if !res.status().is_redirection() {
            return Ok(None);
        }
        Ok(res.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).and_then(media_id_from_location))
    }

    /// An attachment's content type and bytes. The download redirects to the media service with a signed URL;
    /// reqwest drops the bearer token when following it to another host.
    pub async fn download(&self, scope: &Scope, id: &str) -> Result<(String, Vec<u8>)> {
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

    pub async fn comment(&self, scope: &Scope, key: &str, text: &str, mentions: &[adf::MentionRef], files: &[Uploaded]) -> Result<()> {
        let body = json!({ "body": adf::with_files(adf::from_text(text, mentions), files) });
        self.call::<Value>(scope, Method::POST, &format!("issue/{key}/comment"), Some(&body)).await?;
        Ok(())
    }
}

/// Jira timestamps look like `2026-09-28T10:00:00.000+0200`; normalise to UTC RFC 3339 so they sort as strings.
pub fn normalise_time(s: &str) -> String {
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

fn status(v: &Value) -> Option<Status> {
    Some(Status {
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
        author: person(&h["author"])?,
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

pub fn parse_issue(raw: &Value) -> Option<CachedTicket> {
    let f = &raw["fields"];
    let key = raw["key"].as_str()?.to_string();
    let comments = f
        .pointer("/comment/comments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(Comment {
                id: c["id"].as_str()?.to_string(),
                author: person(&c["author"])?,
                created: normalise_time(c["created"].as_str()?),
                body: adf::to_text(&c["body"]),
                mentions: adf::mentions(&c["body"]),
                mentioned: adf::mentioned(&c["body"]),
                doc: doc(&c["body"]),
            })
        })
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
        watching: f.pointer("/watches/isWatching").and_then(Value::as_bool).unwrap_or(false),
        history,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn sample_issue() -> Value {
        json!({
            "key": "CA-1",
            "fields": {
                "summary": "Do the thing",
                "status": {"name": "In Review", "statusCategory": {"key": "indeterminate"}},
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
                "attachment": [{"id": "10001", "filename": "shot.png", "mimeType": "image/png", "size": 2048}]
            },
            "changelog": {"histories": [{
                "id": "500", "author": {"accountId": "sam", "displayName": "Sam"},
                "created": "2026-09-28T09:00:00.000+0200",
                "items": [{"field": "status", "fromString": "In Progress", "toString": "In Review", "to": "3"}]
            }]}
        })
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
    fn normalises_jira_timestamps_to_utc() {
        assert_eq!(normalise_time("2026-09-28T10:00:00.123+0200"), "2026-09-28T08:00:00Z");
        assert_eq!(normalise_time("2026-09-28T08:00:00Z"), "2026-09-28T08:00:00Z");
        assert_eq!(normalise_time("garbage"), "garbage");
    }
}
