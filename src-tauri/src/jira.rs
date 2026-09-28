use std::sync::Arc;

use chrono::{DateTime, Utc};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::adf;
use crate::auth::{json_or_error, Auth};
use crate::error::{Error, Result};
use crate::model::{CachedTicket, Comment, History, HistoryItem, ParentRef, Person, Status, SubtaskRef, Transition};

const FIELDS: &[&str] = &[
    "summary", "status", "issuetype", "priority", "assignee", "reporter", "parent", "description", "comment",
    "subtasks", "duedate", "updated", "watches",
];
const PAGE_SIZE: u32 = 50;
const CHANGELOG_PAGE: u64 = 100;
/// Upper bound per search so a very broad JQL can't stall a sync.
const MAX_ISSUES: usize = 300;

pub struct Jira {
    http: reqwest::Client,
    auth: Arc<Auth>,
}

impl Jira {
    pub fn new(http: reqwest::Client, auth: Arc<Auth>) -> Self {
        Self { http, auth }
    }

    async fn call<T: DeserializeOwned>(&self, method: Method, path: &str, body: Option<&Value>) -> Result<T> {
        let mut force_refresh = false;
        loop {
            let creds = self.auth.credentials(force_refresh).await?;
            let url = format!("https://api.atlassian.com/ex/jira/{}/rest/api/3/{path}", creds.cloud_id);
            let mut req = self.http.request(method.clone(), url).bearer_auth(&creds.access_token);
            if let Some(b) = body {
                req = req.json(b);
            }
            let res = req.send().await?;
            // A token can be revoked or rotated elsewhere before it expires; refresh once and retry.
            if res.status() == StatusCode::UNAUTHORIZED && !force_refresh {
                force_refresh = true;
                continue;
            }
            if res.status() == StatusCode::NO_CONTENT {
                return Ok(serde_json::from_value(Value::Null)?);
            }
            return json_or_error(res).await;
        }
    }

    /// Runs a JQL search and returns every matching issue (up to a cap) with its changelog.
    pub async fn search(&self, jql: &str, with_changelog: bool) -> Result<Vec<CachedTicket>> {
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
            if with_changelog {
                body["expand"] = json!("changelog");
            }
            if let Some(t) = &token {
                body["nextPageToken"] = json!(t);
            }
            let page: Page = self.call(Method::POST, "search/jql", Some(&body)).await?;
            for raw in &page.issues {
                if let Some(t) = parse_issue(raw) {
                    out.push(self.with_recent_history(t, raw).await?);
                }
            }
            match page.next_page_token {
                Some(t) if out.len() < MAX_ISSUES => token = Some(t),
                _ => return Ok(out),
            }
        }
    }

    pub async fn issue(&self, key: &str) -> Result<CachedTicket> {
        let raw: Value = self
            .call(Method::GET, &format!("issue/{key}?fields={}&expand=changelog", FIELDS.join(",")), None)
            .await?;
        let t = parse_issue(&raw).ok_or_else(|| Error::Api { status: 200, message: format!("couldn't read {key}") })?;
        self.with_recent_history(t, &raw).await
    }

    /// An expanded changelog holds only its first page, which is the oldest history. When there is more, replace it
    /// with the most recent page, since that's where new events come from.
    async fn with_recent_history(&self, mut t: CachedTicket, raw: &Value) -> Result<CachedTicket> {
        let Some(start) = recent_changelog_start(raw) else { return Ok(t) };
        let page: Value = self
            .call(Method::GET, &format!("issue/{}/changelog?startAt={start}&maxResults={CHANGELOG_PAGE}", t.key), None)
            .await?;
        t.history = page["values"].as_array().into_iter().flatten().filter_map(parse_history).collect();
        Ok(t)
    }

    pub async fn transitions(&self, key: &str) -> Result<Vec<Transition>> {
        let raw: Value = self.call(Method::GET, &format!("issue/{key}/transitions"), None).await?;
        Ok(raw["transitions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| {
                Some(Transition { id: t["id"].as_str()?.into(), name: t["name"].as_str()?.into(), to: status(&t["to"])? })
            })
            .collect())
    }

    pub async fn transition(&self, key: &str, transition_id: &str) -> Result<()> {
        let body = json!({ "transition": { "id": transition_id } });
        self.call::<Value>(Method::POST, &format!("issue/{key}/transitions"), Some(&body)).await?;
        Ok(())
    }

    pub async fn comment(&self, key: &str, text: &str) -> Result<()> {
        let body = json!({ "body": adf::from_text(text) });
        self.call::<Value>(Method::POST, &format!("issue/{key}/comment"), Some(&body)).await?;
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

fn str_of(v: &Value) -> Option<String> {
    v.as_str().map(String::from)
}

/// Where the most recent changelog page starts, if the expanded changelog is incomplete.
fn recent_changelog_start(raw: &Value) -> Option<u64> {
    let total = raw.pointer("/changelog/total").and_then(Value::as_u64)?;
    let have = raw.pointer("/changelog/histories").and_then(Value::as_array).map_or(0, |h| h.len() as u64);
    (total > have).then(|| total.saturating_sub(CHANGELOG_PAGE))
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
        comments,
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
                "watches": {"isWatching": true}
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
        assert_eq!(t.history[0].items[0].to.as_deref(), Some("In Review"));
    }

    #[test]
    fn asks_for_the_latest_changelog_page_only_when_incomplete() {
        let mut raw = sample_issue();
        assert_eq!(recent_changelog_start(&raw), None, "no total means nothing to page");
        raw["changelog"]["total"] = json!(1);
        assert_eq!(recent_changelog_start(&raw), None);
        raw["changelog"]["total"] = json!(250);
        assert_eq!(recent_changelog_start(&raw), Some(150));
        raw["changelog"]["total"] = json!(60);
        assert_eq!(recent_changelog_start(&raw), Some(0));
    }

    #[test]
    fn normalises_jira_timestamps_to_utc() {
        assert_eq!(normalise_time("2026-09-28T10:00:00.123+0200"), "2026-09-28T08:00:00Z");
        assert_eq!(normalise_time("2026-09-28T08:00:00Z"), "2026-09-28T08:00:00Z");
        assert_eq!(normalise_time("garbage"), "garbage");
    }
}
