//! A minimal MCP server (streamable HTTP, JSON responses only) for Claude Code.
//!
//! Two audiences share it:
//! - Ask Claude runs (`/mcp/<request id>`) get read tools plus `propose_*` tools. Proposals are handed to the UI as
//!   cards and nothing on that path writes to Jira, so "Claude never changes Jira without your approval in the app"
//!   holds whatever the model decides.
//! - The user's other Claude Code sessions (`/mcp/external`) get the inbox, read tools and direct comment/transition
//!   tools. Those sessions ask the user before every MCP tool call under Claude Code's own permission rules.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{json, Value};

use crate::inbox::Core;
use crate::model::{CachedTicket, Transition};

const SEARCH_LIMIT: usize = 20;
const COMMENTS_SHOWN: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProposalBody {
    Comment { key: String, body: String },
    Transition { key: String, transition: Transition },
    Subtasks { key: String, summaries: Vec<String> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub request_id: String,
    pub id: String,
    #[serde(flatten)]
    pub body: ProposalBody,
}

pub type ProposalSink = Arc<dyn Fn(Proposal) + Send + Sync>;
/// Called after an external session changes Jira, so the window can refresh.
pub type ChangeHook = Arc<dyn Fn() + Send + Sync>;

/// Preferred port, so the URL registered with Claude Code stays valid across restarts.
pub const PREFERRED_PORT: u16 = 8724;
const EXTERNAL: &str = "external";

struct McpState {
    core: Arc<Core>,
    token: String,
    sink: ProposalSink,
    on_change: ChangeHook,
    seq: AtomicU64,
}

pub struct McpServer {
    pub port: u16,
    pub token: String,
}

impl McpServer {
    pub async fn start(core: Arc<Core>, token: String, sink: ProposalSink, on_change: ChangeHook) -> std::io::Result<Self> {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
            Ok(l) => l,
            Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        let state = Arc::new(McpState { core, token: token.clone(), sink, on_change, seq: AtomicU64::new(0) });
        let router = Router::new().route("/mcp/{request_id}", post(handle)).with_state(state);
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self { port, token })
    }

    pub fn external_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp/{EXTERNAL}", self.port)
    }

    pub fn config_json(&self, request_id: &str) -> String {
        json!({
            "mcpServers": {
                "jira-inbox": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{}/mcp/{request_id}", self.port),
                    "headers": { "Authorization": format!("Bearer {}", self.token) }
                }
            }
        })
        .to_string()
    }
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let given = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    // Constant-time so the token can't be guessed byte by byte by another local process.
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

async fn handle(
    State(st): State<Arc<McpState>>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
    Json(msg): Json<Value>,
) -> Response {
    if !authorized(&headers, &st.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Notifications carry no id and get no body.
    let Some(id) = msg.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => Ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "jira-inbox", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": if request_id == EXTERNAL { external_tool_list() } else { tool_list() } })),
        "tools/call" if request_id == EXTERNAL => Ok(call_external_tool(&st, &msg["params"]).await),
        "tools/call" => Ok(call_tool(&st, &request_id, &msg["params"]).await),
        _ => Err(json!({ "code": -32601, "message": "Method not found" })),
    };
    let reply = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    };
    Json(reply).into_response()
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

fn key_schema() -> Value {
    json!({ "type": "string", "description": "Issue key, e.g. CA-412" })
}

fn read_tools() -> Vec<Value> {
    let key = key_schema();
    vec![
        tool("get_ticket", "Read a Jira issue: fields, description, subtasks, recent comments and history.", json!({ "key": key }), &["key"]),
        tool(
            "search_tickets",
            "Search Jira with JQL. Returns up to 20 issues with key, status, assignee and summary.",
            json!({ "jql": { "type": "string" } }),
            &["jql"],
        ),
        tool("list_transitions", "List the workflow transitions available for an issue right now.", json!({ "key": key }), &["key"]),
    ]
}

fn tool_list() -> Vec<Value> {
    let key = key_schema();
    let mut tools = read_tools();
    tools.extend([
        tool(
            "propose_comment",
            "Suggest a comment. The user sees it as a draft they can edit, post or skip. It is not posted by this call.",
            json!({ "key": key, "body": { "type": "string", "description": "Plain text. Blank lines separate paragraphs." } }),
            &["key", "body"],
        ),
        tool(
            "propose_transition",
            "Suggest moving an issue through its workflow. Get the id from list_transitions. The user approves or skips it.",
            json!({ "key": key, "transition_id": { "type": "string" } }),
            &["key", "transition_id"],
        ),
        tool(
            "propose_subtasks",
            "Suggest subtasks to create under an issue. The user picks which ones to create.",
            json!({ "key": key, "summaries": { "type": "array", "items": { "type": "string" }, "minItems": 1 } }),
            &["key", "summaries"],
        ),
    ]);
    tools
}

fn external_tool_list() -> Vec<Value> {
    let key = key_schema();
    let mut tools = vec![tool(
        "inbox",
        "The user's Jira Inbox: recent mentions, assignments, comments and status changes on tickets they follow, newest first.",
        json!({ "include_read": { "type": "boolean", "description": "Also list items already read (default false)" } }),
        &[],
    )];
    tools.extend(read_tools());
    tools.extend([
        tool(
            "comment_on_ticket",
            "Post a comment on a Jira issue as the user.",
            json!({ "key": key, "body": { "type": "string", "description": "Plain text. Blank lines separate paragraphs." } }),
            &["key", "body"],
        ),
        tool(
            "transition_ticket",
            "Move a Jira issue through its workflow. Get the id from list_transitions.",
            json!({ "key": key, "transition_id": { "type": "string" } }),
            &["key", "transition_id"],
        ),
    ]);
    tools
}

fn text(t: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": t.into() }], "isError": is_error })
}

const PROPOSED: &str = "Proposed. The user will approve, edit or skip it in Jira Inbox; don't say it has been done.";

async fn call_tool(st: &McpState, request_id: &str, params: &Value) -> Value {
    let args = &params["arguments"];
    let arg = |k: &str| args[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    let propose = |body: ProposalBody| {
        let id = st.seq.fetch_add(1, Ordering::Relaxed).to_string();
        (st.sink)(Proposal { request_id: request_id.to_string(), id, body });
        text(PROPOSED, false)
    };

    if let Some(result) = call_read_tool(st, params).await {
        return result;
    }
    match (params["name"].as_str().unwrap_or_default(), arg("key")) {
        ("propose_comment", Some(key)) => match arg("body") {
            Some(body) => propose(ProposalBody::Comment { key: key.into(), body: body.into() }),
            None => text("body is required", true),
        },
        ("propose_transition", Some(key)) => {
            let Some(id) = arg("transition_id") else { return text("transition_id is required", true) };
            match st.core.transitions(key).await {
                Ok(ts) => match ts.into_iter().find(|t| t.id == id) {
                    Some(transition) => propose(ProposalBody::Transition { key: key.into(), transition }),
                    None => text(format!("{id} isn't an available transition for {key}; call list_transitions"), true),
                },
                Err(e) => text(format!("Couldn't check transitions for {key}: {e}"), true),
            }
        }
        ("propose_subtasks", Some(key)) => {
            let summaries: Vec<String> = args["summaries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from))
                .collect();
            if summaries.is_empty() {
                return text("summaries must list at least one subtask", true);
            }
            propose(ProposalBody::Subtasks { key: key.into(), summaries })
        }
        (_, None) => text("key is required", true),
        (name, _) => text(format!("Unknown tool {name}"), true),
    }
}

/// Tools both audiences share. Returns `None` for any other tool name.
async fn call_read_tool(st: &McpState, params: &Value) -> Option<Value> {
    let args = &params["arguments"];
    let arg = |k: &str| args[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    let name = params["name"].as_str().unwrap_or_default();
    if !["get_ticket", "list_transitions", "search_tickets"].contains(&name) {
        return None;
    }
    Some(match (name, arg("key")) {
        ("get_ticket", Some(key)) => match st.core.ticket(key).await {
            Ok(t) => text(describe(&t), false),
            Err(e) => text(format!("Couldn't read {key}: {e}"), true),
        },
        ("list_transitions", Some(key)) => match st.core.transitions(key).await {
            Ok(ts) => text(
                ts.iter().map(|t| format!("{}: {} → {}", t.id, t.name, t.to.name)).collect::<Vec<_>>().join("\n"),
                false,
            ),
            Err(e) => text(format!("Couldn't list transitions for {key}: {e}"), true),
        },
        ("search_tickets", _) => match arg("jql") {
            None => text("jql is required", true),
            Some(jql) => match st.core.jira.search(jql, false).await {
                Ok(found) => text(
                    found
                        .iter()
                        .take(SEARCH_LIMIT)
                        .map(|t| {
                            let who = t.assignee.as_ref().map(|p| p.name.as_str()).unwrap_or("unassigned");
                            format!("{} [{}] {} ({who})", t.key, t.status.name, t.summary)
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                    false,
                ),
                Err(e) => text(format!("Search failed: {e}"), true),
            },
        },
        _ => text("key is required", true),
    })
}

async fn call_external_tool(st: &McpState, params: &Value) -> Value {
    if let Some(result) = call_read_tool(st, params).await {
        return result;
    }
    let args = &params["arguments"];
    let arg = |k: &str| args[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    let changed = |r: crate::error::Result<()>, done: String| match r {
        Ok(()) => {
            (st.on_change)();
            text(done, false)
        }
        Err(e) => text(e.to_string(), true),
    };
    match (params["name"].as_str().unwrap_or_default(), arg("key")) {
        ("inbox", _) => match st.core.snapshot().await {
            Ok(snap) => text(inbox_text(&snap, args["include_read"] == true, &crate::inbox::now_iso()), false),
            Err(e) => text(e.to_string(), true),
        },
        ("comment_on_ticket", Some(key)) => match arg("body") {
            Some(body) => changed(st.core.comment(key, body).await, format!("Commented on {key}.")),
            None => text("body is required", true),
        },
        ("transition_ticket", Some(key)) => match arg("transition_id") {
            Some(id) => changed(st.core.transition(key, id).await, format!("Moved {key}.")),
            None => text("transition_id is required", true),
        },
        (_, None) => text("key is required", true),
        (name, _) => text(format!("Unknown tool {name}"), true),
    }
}

/// Active inbox items (not done, not snoozed) as one line each.
fn inbox_text(snap: &crate::model::Snapshot, include_read: bool, now: &str) -> String {
    let lines: Vec<String> = snap
        .events
        .iter()
        .filter(|e| e.done_at.is_none() && e.snoozed_until.as_deref().is_none_or(|u| u <= now))
        .filter(|e| include_read || e.unread)
        .take(50)
        .map(|e| {
            let summary = snap.tickets.get(&e.ticket_key).map(|t| t.summary.as_str()).unwrap_or_default();
            format!(
                "{}{} {} “{summary}”: {} {} — {}",
                if e.unread { "[unread] " } else { "" },
                e.at,
                e.ticket_key,
                e.actor.name,
                e.kind.as_str(),
                e.text
            )
        })
        .collect();
    if lines.is_empty() {
        return "Nothing new in the inbox.".into();
    }
    lines.join("\n")
}

/// The ticket as compact JSON for the model.
pub fn describe(t: &CachedTicket) -> String {
    let comments: Vec<Value> = t
        .comments
        .iter()
        .rev()
        .take(COMMENTS_SHOWN)
        .rev()
        .map(|c| json!({ "author": c.author.name, "at": c.created, "body": c.body }))
        .collect();
    let history: Vec<Value> = t
        .history
        .iter()
        .rev()
        .take(15)
        .flat_map(|h| h.items.iter().map(move |i| json!({ "at": h.at, "by": h.author.name, "field": i.field, "from": i.from, "to": i.to })))
        .collect();
    serde_json::to_string_pretty(&json!({
        "key": t.key,
        "summary": t.summary,
        "type": t.issue_type,
        "status": t.status.name,
        "priority": t.priority,
        "assignee": t.assignee.as_ref().map(|p| &p.name),
        "reporter": t.reporter.as_ref().map(|p| &p.name),
        "parent": t.parent.as_ref().map(|p| format!("{} {}", p.key, p.summary)),
        "dueDate": t.due_date,
        "description": t.description,
        "subtasks": t.subtasks.iter().map(|s| json!({ "key": s.key, "summary": s.summary, "done": s.done })).collect::<Vec<_>>(),
        "recentComments": comments,
        "recentHistory": history,
    }))
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jira::{parse_issue, tests::sample_issue};

    #[test]
    fn checks_the_bearer_token() {
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, "abc"));
        h.insert("authorization", "Bearer abd".parse().unwrap());
        assert!(!authorized(&h, "abc"));
        h.insert("authorization", "Bearer abc".parse().unwrap());
        assert!(authorized(&h, "abc"));
    }

    #[test]
    fn only_read_and_propose_tools_are_offered() {
        let names: Vec<String> = tool_list().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert!(names.iter().all(|n| n.starts_with("get_") || n.starts_with("search_") || n.starts_with("list_") || n.starts_with("propose_")));
    }

    #[test]
    fn external_sessions_get_the_inbox_and_direct_writes_but_no_proposals() {
        let names: Vec<String> = external_tool_list().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"inbox".to_string()));
        assert!(names.contains(&"comment_on_ticket".to_string()));
        assert!(!names.iter().any(|n| n.starts_with("propose_")));
    }

    #[test]
    fn inbox_text_lists_active_unread_items() {
        use crate::model::{EventKind, InboxEvent, Person, Snapshot};
        let person = Person { account_id: "s".into(), name: "Sam".into(), avatar_url: None };
        let ev = |id: &str, unread: bool, done: Option<&str>| InboxEvent {
            id: id.into(),
            kind: EventKind::Mention,
            ticket_key: "CA-1".into(),
            actor: person.clone(),
            at: "2026-09-28T10:00:00Z".into(),
            text: format!("text {id}"),
            unread,
            done_at: done.map(String::from),
            snoozed_until: None,
        };
        let snap = Snapshot {
            me: person.clone(),
            site: String::new(),
            tickets: Default::default(),
            events: vec![ev("a", true, None), ev("b", false, None), ev("c", true, Some("2026-09-28T11:00:00Z"))],
            watching: vec![],
            last_sync_at: None,
            sync_error: None,
        };
        let out = inbox_text(&snap, false, "2026-09-28T12:00:00Z");
        assert!(out.contains("[unread]") && out.contains("text a"));
        assert!(!out.contains("text b") && !out.contains("text c"));
        assert!(inbox_text(&snap, true, "2026-09-28T12:00:00Z").contains("text b"));
    }

    #[test]
    fn describes_a_ticket_for_the_model() {
        let d: Value = serde_json::from_str(&describe(&parse_issue(&sample_issue()).unwrap())).unwrap();
        assert_eq!(d["key"], "CA-1");
        assert_eq!(d["status"], "In Review");
        assert_eq!(d["recentComments"][0]["author"], "Sam");
        assert_eq!(d["recentHistory"][0]["to"], "In Review");
    }

    #[test]
    fn proposals_serialise_flat_for_the_ui() {
        let p = Proposal {
            request_id: "r".into(),
            id: "0".into(),
            body: ProposalBody::Subtasks { key: "CA-1".into(), summaries: vec!["a".into()] },
        };
        let v = serde_json::to_value(p).unwrap();
        assert_eq!(v["kind"], "subtasks");
        assert_eq!(v["requestId"], "r");
        assert_eq!(v["summaries"][0], "a");
    }
}
