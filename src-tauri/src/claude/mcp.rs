//! A minimal MCP server (streamable HTTP, JSON responses only) that Claude Code connects to during an Ask Claude run.
//!
//! Claude gets read tools plus `propose_*` tools. A proposal is stored as a draft for the user to approve; nothing
//! here writes to Jira. That keeps "Claude never changes Jira without your approval" true regardless of what the
//! model decides.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::Scope;
use crate::domain::{Doc, Intent, ItemRef};
use crate::inbox::{Core, CONTEXT_LIMIT};
use crate::model::CachedTicket;
use crate::proposals::Draft;
use crate::tracker::Connection;

const SEARCH_LIMIT: usize = 20;
const COMMENTS_SHOWN: usize = 10;

/// Told the connection id whenever a draft was stored, so the page can re-read its drafts.
pub type ChangeSink = Arc<dyn Fn(&str) + Send + Sync>;

/// The account each running Ask Claude request belongs to. Tools answer only for runs listed here, and only as that
/// account, so switching accounts mid-run can't hand Claude another account's tickets.
pub type Runs = Arc<std::sync::Mutex<std::collections::HashMap<String, Scope>>>;

struct McpState {
    core: Arc<Core>,
    token: String,
    sink: ChangeSink,
    runs: Runs,
}

pub struct McpServer {
    pub port: u16,
    pub token: String,
    pub runs: Runs,
}

impl McpServer {
    pub async fn start(core: Arc<Core>, token: String, sink: ChangeSink) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let runs: Runs = Arc::default();
        let state = Arc::new(McpState { core, token: token.clone(), sink, runs: runs.clone() });
        let router = Router::new().route("/mcp/{request_id}", post(handle)).with_state(state);
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self { port, token, runs })
    }

    pub fn config_json(&self, request_id: &str) -> String {
        json!({
            "mcpServers": {
                "gossamr": {
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
            "serverInfo": { "name": "gossamr", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
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

fn tool_list() -> Vec<Value> {
    let key = json!({ "type": "string", "description": "Issue key, e.g. CA-412" });
    vec![
        tool("get_ticket", "Read a Jira issue: fields, description, subtasks, recent comments and history.", json!({ "key": key }), &["key"]),
        tool(
            "search_tickets",
            "Search Jira with JQL. Returns up to 20 issues with key, status, assignee and summary.",
            json!({ "jql": { "type": "string" } }),
            &["jql"],
        ),
        tool("list_transitions", "List the workflow transitions available for an issue right now.", json!({ "key": key }), &["key"]),
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
    ]
}

fn text(t: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": t.into() }], "isError": is_error })
}

fn saved(key: &str, id: &str) -> String {
    format!(
        "Saved as a draft on {key} (proposal {id}). It shows in the Ask Claude panel on that ticket, where the user will approve, edit or skip it. It has not been applied; don't say it has."
    )
}

fn item_ref(scope: &Scope, key: &str) -> ItemRef {
    ItemRef { connection_id: Connection::jira_id(scope), external_id: key.into(), key: key.into() }
}

/// The intent for a `propose_comment` or `propose_subtasks` call, or what to tell the model is missing.
fn pip_intent(tool: &str, item: ItemRef, args: &Value) -> std::result::Result<Intent, &'static str> {
    let text = |k: &str| args[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    match tool {
        "propose_comment" => {
            let body = text("body").ok_or("body is required")?;
            Ok(Intent::Comment { item, body: Doc::from_text(body, &[]) })
        }
        "propose_subtasks" => {
            let summaries: Vec<String> = args["summaries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from))
                .collect();
            if summaries.is_empty() {
                return Err("summaries must list at least one subtask");
            }
            Ok(Intent::Subtasks { parent: item, summaries })
        }
        _ => Err("not a proposal tool"),
    }
}

async fn call_tool(st: &McpState, request_id: &str, params: &Value) -> Value {
    let Some(scope) = st.runs.lock().expect("runs lock poisoned").get(request_id).cloned() else {
        return text("This Ask Claude run has ended.", true);
    };
    let scope = &scope;
    let args = &params["arguments"];
    let arg = |k: &str| args[k].as_str().map(str::trim).filter(|s| !s.is_empty());
    let propose = |intent: Intent, label: Option<String>| async move {
        let key = intent.target().map(|t| t.key.clone()).unwrap_or_default();
        match st.core.propose(scope, Draft::from_pip(request_id, intent, label)).await {
            Ok(p) => {
                (st.sink)(&Connection::jira_id(scope));
                text(saved(&key, &p.id), false)
            }
            Err(e) => text(format!("Couldn't save the draft: {e}"), true),
        }
    };

    match (params["name"].as_str().unwrap_or_default(), arg("key")) {
        ("get_ticket", Some(key)) => match st.core.ticket(scope, key).await {
            Ok(t) => text(describe(&t), false),
            Err(e) => text(format!("Couldn't read {key}: {e}"), true),
        },
        ("list_transitions", Some(key)) => match st.core.transitions(scope, key).await {
            Ok(ts) => text(
                ts.iter().map(|t| format!("{}: {} → {}", t.id, t.name, t.to.name)).collect::<Vec<_>>().join("\n"),
                false,
            ),
            Err(e) => text(format!("Couldn't list transitions for {key}: {e}"), true),
        },
        ("search_tickets", _) => match arg("jql") {
            None => text("jql is required", true),
            Some(jql) => match st.core.search_native(scope, jql, CONTEXT_LIMIT).await {
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
        (tool @ ("propose_comment" | "propose_subtasks"), Some(key)) => match pip_intent(tool, item_ref(scope, key), args) {
            Ok(intent) => propose(intent, None).await,
            Err(message) => text(message, true),
        },
        ("propose_transition", Some(key)) => {
            let Some(id) = arg("transition_id") else { return text("transition_id is required", true) };
            match st.core.transitions(scope, key).await {
                Ok(ts) => match ts.into_iter().find(|t| t.id == id) {
                    Some(t) => propose(Intent::Transition { item: item_ref(scope, key), to: t.id }, Some(t.name)).await,
                    None => text(format!("{id} isn't an available transition for {key}; call list_transitions"), true),
                },
                Err(e) => text(format!("Couldn't check transitions for {key}: {e}"), true),
            }
        }
        (name, None) if name != "search_tickets" => text("key is required", true),
        (name, _) => text(format!("Unknown tool {name}"), true),
    }
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
    use crate::tracker::testing::sample_ticket;

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
    fn describes_a_ticket_for_the_model() {
        let d: Value = serde_json::from_str(&describe(&sample_ticket())).unwrap();
        assert_eq!(d["key"], "CA-1");
        assert_eq!(d["status"], "In Review");
        assert_eq!(d["recentComments"][0]["author"], "Sam");
        assert_eq!(d["recentHistory"][0]["to"], "In Review");
    }

    #[test]
    fn comment_and_subtask_calls_become_intents_and_bad_calls_say_what_is_missing() {
        let item = || ItemRef { connection_id: "c".into(), external_id: "1".into(), key: "CA-1".into() };
        let comment = pip_intent("propose_comment", item(), &json!({ "body": "  Looks good\n\nShip it " })).unwrap();
        assert_eq!(comment, Intent::Comment { item: item(), body: Doc::from_text("Looks good\n\nShip it", &[]) });
        assert_eq!(pip_intent("propose_comment", item(), &json!({ "body": " " })), Err("body is required"));

        let subtasks = pip_intent("propose_subtasks", item(), &json!({ "summaries": ["a", " ", "b"] })).unwrap();
        assert_eq!(subtasks, Intent::Subtasks { parent: item(), summaries: vec!["a".into(), "b".into()] });
        assert!(pip_intent("propose_subtasks", item(), &json!({ "summaries": [] })).is_err());
    }

    #[test]
    fn a_pip_draft_is_stored_pending_and_tied_to_the_run_that_made_it() {
        use crate::db::Db;
        use crate::domain::{CreatedBy, Origin, ProposalState};

        let db = Db::in_memory().unwrap();
        let item = ItemRef { connection_id: "c".into(), external_id: "1".into(), key: "CA-1".into() };
        let intent = pip_intent("propose_subtasks", item.clone(), &json!({ "summaries": ["a"] })).unwrap();
        let made = crate::proposals::create(&db, Draft::from_pip("run-7", intent, None), chrono::Utc::now()).unwrap();

        let stored = db.proposal(&made.id).unwrap().unwrap();
        assert_eq!(stored.state, ProposalState::Pending);
        assert_eq!(stored.created_by, CreatedBy::Pip);
        assert_eq!(stored.origin, Origin::Chat { request_id: "run-7".into() });
        assert!(saved("CA-1", &made.id).contains("has not been applied"));
    }
}
