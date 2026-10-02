//! A minimal MCP server (streamable HTTP, JSON responses only) that an agent connects to during one of Pip's runs.
//!
//! The agent gets read tools plus proposal tools. A proposal is stored as a draft for the user to approve; nothing
//! here writes to a tracker. That keeps "Pip never changes anything without your approval" true regardless of what
//! the model decides.

use std::mem::discriminant;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::Scope;
use crate::error::{Error, Result};
use super::context::draft_line;
use super::{McpEndpoint, RunPlanner};
use crate::domain::{ContainerRef, Doc, Filter, Intent, ItemKind, ItemRef, NewItem, Proposal, ProposalQuery, StateKind, Transitions};
use crate::inbox::Core;
use crate::model::CachedTicket;
use crate::proposals::{self, Draft};
use crate::tracker::Connection;

const SEARCH_LIMIT: usize = 50;
const SEARCH_DEFAULT: usize = 20;
const PROPOSALS_SHOWN: usize = 30;
const COMMENTS_SHOWN: usize = 10;

/// Told the connection id whenever a draft was stored, so the page can re-read its drafts.
pub type ChangeSink = Arc<dyn Fn(&str) + Send + Sync>;

/// Told the request id, the filter and a one-line note when Pip wants the page to narrow its current view.
pub type ViewSink = Arc<dyn Fn(&str, &Filter, &str) + Send + Sync>;

/// One running request: the account it belongs to, and the tickets the user handed to Pip in it.
#[derive(Clone, Debug)]
pub struct PipRun {
    pub scope: Scope,
    /// Keys (upper case) of tickets the user opened or named in the request. Pip may read and draft on these even in a
    /// project that isn't watched, and on nothing else outside the watched projects.
    pub handed: std::collections::HashSet<String>,
}

impl PipRun {
    #[cfg(test)]
    pub fn new(scope: Scope) -> Self {
        Self { scope, handed: Default::default() }
    }
}

/// The runs in progress. Tools answer only for runs listed here, and only as that run's account, so switching accounts
/// mid-run can't hand the agent another account's tickets.
pub type PipRuns = Arc<std::sync::Mutex<std::collections::HashMap<String, PipRun>>>;

/// The bearer token of each run in progress, by run id. A token exists only between `endpoint` and `revoke`.
type Tokens = Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>;

pub(super) struct McpState {
    pub core: Arc<Core>,
    pub tokens: Tokens,
    pub sink: ChangeSink,
    pub view: ViewSink,
    pub runs: PipRuns,
    pub planner: Arc<dyn RunPlanner>,
}

pub struct McpServer {
    pub port: u16,
    pub runs: PipRuns,
    pub planner: Arc<dyn RunPlanner>,
    tokens: Tokens,
}

impl McpServer {
    pub async fn start(core: Arc<Core>, planner: Arc<dyn RunPlanner>, sink: ChangeSink, view: ViewSink) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let runs: PipRuns = Arc::default();
        let tokens = Tokens::default();
        let state = Arc::new(McpState { core, tokens: tokens.clone(), sink, view, runs: runs.clone(), planner: planner.clone() });
        let router = Router::new().route("/mcp/{request_id}", post(handle)).with_state(state);
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self { port, runs, planner, tokens })
    }

    /// Mints a fresh token for this run, valid until `revoke`. A second call for the same run replaces the first.
    pub fn endpoint(&self, request_id: &str) -> Result<McpEndpoint> {
        let token = random_token().map_err(|e| Error::Claude(format!("no randomness available: {e}")))?;
        self.tokens.lock().expect("lock poisoned").insert(request_id.to_string(), token.clone());
        Ok(McpEndpoint { url: format!("http://127.0.0.1:{}/mcp/{request_id}", self.port), token })
    }

    pub fn revoke(&self, request_id: &str) {
        self.tokens.lock().expect("lock poisoned").remove(request_id);
    }
}

fn random_token() -> std::result::Result<String, getrandom::Error> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A request is honoured only with the token issued for the run named in its path.
fn authorized(headers: &HeaderMap, tokens: &Tokens, request_id: &str) -> bool {
    let Some(token) = tokens.lock().expect("lock poisoned").get(request_id).cloned() else {
        return false;
    };
    let token = token.as_str();
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
    if !authorized(&headers, &st.tokens, &request_id) {
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

pub(super) fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required }
    })
}

const FILTER_HELP: &str = "A filter object, e.g. {\"type\":\"and\",\"filters\":[{\"type\":\"mine\"},{\"type\":\"status\",\"name\":\"In Review\"}]}. \
Types: needsMe, mine, unassigned, blocked, open, status{name}, category{category: todo|active|done}, stale{days}, label{label}, \
text{text}, container{container:{connectionId,externalId}}, parent{item}, assignee{person}, items{items}, and{filters}.";

fn tool_list() -> Vec<Value> {
    let key = json!({ "type": "string", "description": "Item key, e.g. CA-412" });
    let id = json!({ "type": "string", "description": "A draft id from list_proposals" });
    let summaries = json!({ "type": "array", "items": { "type": "string" }, "minItems": 1 });
    let text = |d: &str| json!({ "type": "string", "description": d });
    vec![
        tool(
            "search_items",
            "Find items in the watched projects. Give a filter, plain text, or both. Returns up to 50 with key, status, assignee and title.",
            json!({ "filter": { "type": "object", "description": FILTER_HELP }, "text": text("Plain-text search over titles, keys and descriptions"), "limit": { "type": "integer" } }),
            &[],
        ),
        tool("get_item", "Read an item: fields, description, subtasks, recent comments and history, and the open drafts on it.", json!({ "key": key }), &["key"]),
        tool("list_containers", "List the projects (containers) the user watches, with the id propose_create takes. Items in other projects are out of reach.", json!({}), &[]),
        tool(
            "find_containers",
            "Search every project the user can see, watched or not, by key or name. Use it to pick where propose_create should put a new item. It says nothing about the items in them.",
            json!({ "query": text("Part of a project key or name") }),
            &["query"],
        ),
        tool("get_workflow", "A container's statuses (with the ids propose_transition takes) and how they connect.", json!({ "container": text("Container id from list_containers") }), &["container"]),
        tool("list_next_statuses", "List the statuses an item can move to right now, with their ids.", json!({ "key": key }), &["key"]),
        tool(
            "list_proposals",
            "List drafts from Pip, the user and autopilot. Open ones by default. Check this before proposing so you don't repeat one.",
            json!({ "state": { "type": "string", "enum": ["open", "applied", "skipped", "retired", "all"] }, "key": key }),
            &[],
        ),
        tool(
            "set_view_filter",
            "Narrow the view the user is looking at to a filter, and tell them what you did in one short note. This changes only what is shown, never any item, and the user can undo it. Use it when they ask to see, show or filter items.",
            json!({ "filter": { "type": "object", "description": FILTER_HELP }, "note": text("What the view now shows, e.g. 'Stale tickets in DEVOPS'") }),
            &["filter", "note"],
        ),
        tool(
            "propose_comment",
            "Suggest a comment. The user sees it as a draft they can edit, post or skip. It is not posted by this call.",
            json!({ "key": key, "body": text("Plain text. Blank lines separate paragraphs.") }),
            &["key", "body"],
        ),
        tool(
            "propose_transition",
            "Suggest moving an item to a status. Get the status id from list_next_statuses. The user approves or skips it.",
            json!({ "key": key, "status_id": text("Target status id") }),
            &["key", "status_id"],
        ),
        tool(
            "propose_subtasks",
            "Suggest subtasks to create under an item. The user picks which ones to create.",
            json!({ "key": key, "summaries": summaries }),
            &["key", "summaries"],
        ),
        tool(
            "propose_create",
            "Suggest a new item. The user approves or skips it.",
            json!({
                "container": text("Container id from list_containers"),
                "title": { "type": "string" },
                "description": text("Plain text"),
                "kind": { "type": "string", "enum": ["task", "bug", "story", "epic"] },
                "parent": text("Key of the epic to put it under")
            }),
            &["container", "title"],
        ),
        tool(
            "revise_proposal",
            "Change one of YOUR OWN pending drafts, or the pending comment or new ticket an agent run drafted for the user from its result (its text, and for a ticket its type). Never anything else the user made. Pass the field that fits its kind: body for a comment, status_id for a transition, summaries for subtasks, title, description and/or kind (task, bug, story or epic) for a new item, focus and/or kind (investigate, triage or verify) for an agent run.",
            json!({ "id": id, "body": { "type": "string" }, "status_id": { "type": "string" }, "summaries": summaries, "title": { "type": "string" }, "description": { "type": "string" }, "focus": { "type": "string" }, "kind": { "type": "string" } }),
            &["id"],
        ),
        tool(
            "retire_proposal",
            "Withdraw one of YOUR OWN pending drafts that is no longer wanted (never anyone else's).",
            json!({ "id": id, "reason": { "type": "string" } }),
            &["id"],
        ),
    ]
    .into_iter()
    .chain(super::github::tools())
    .chain(super::runs::tools())
    .collect()
}

fn text(t: impl Into<String>, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": t.into() }], "isError": is_error })
}

pub(super) type Reply = std::result::Result<String, String>;

pub(super) fn opt<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args[k].as_str().map(str::trim).filter(|s| !s.is_empty())
}

pub(super) fn required<'a>(args: &'a Value, k: &str) -> std::result::Result<&'a str, String> {
    opt(args, k).ok_or_else(|| format!("{k} is required"))
}

/// `args[k]`, with a JSON-encoded string decoded into the value it holds; some clients send arrays and objects that way.
fn structured(args: &Value, k: &str) -> Value {
    match &args[k] {
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
        v => v.clone(),
    }
}

fn summaries_of(args: &Value) -> std::result::Result<Vec<String>, String> {
    let all: Vec<String> = structured(args, "summaries")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from))
        .collect();
    if all.is_empty() {
        return Err("summaries must list at least one subtask".into());
    }
    Ok(all)
}

pub(super) fn item_ref(scope: &Scope, key: &str) -> ItemRef {
    ItemRef { connection_id: Connection::jira_id(scope), external_id: key.into(), key: key.into() }
}

fn open_states() -> Vec<StateKind> {
    vec![StateKind::Pending, StateKind::Applying]
}

fn saved(target: &str, place: &str, id: &str) -> String {
    format!(
        "Saved as a draft {target} (proposal {id}). It shows {place}, where the user will approve, edit or skip it. It has not been applied; don't say it has."
    )
}

fn described(kind: ItemKind) -> String {
    format!("to create a new {kind:?}").to_lowercase()
}

pub(super) async fn call_tool(st: &McpState, request_id: &str, params: &Value) -> Value {
    let Some(run) = st.runs.lock().expect("runs lock poisoned").get(request_id).cloned() else {
        return text("This run has ended.", true);
    };
    let name = params["name"].as_str().unwrap_or_default();
    match run_tool(st, &run, request_id, name, &params["arguments"]).await {
        Ok(t) => text(t, false),
        Err(e) => text(e, true),
    }
}

/// Pip reads and drafts on items in watched projects, and on an unwatched one only when the user handed it over in this
/// run. Creating a new item in any project is a different tool and isn't held to this.
pub(super) async fn reachable(st: &McpState, run: &PipRun, key: &str) -> std::result::Result<(), String> {
    if run.handed.contains(&key.to_uppercase()) || st.core.is_item_watched(&run.scope, key).await.map_err(|e| e.to_string())? {
        return Ok(());
    }
    Err(format!(
        "{key} isn't in a project the user watches, so it is out of reach. Only the user can hand it to you, by opening it or naming it in their request."
    ))
}

async fn run_tool(st: &McpState, run: &PipRun, run_id: &str, name: &str, args: &Value) -> Reply {
    let core = &st.core;
    let scope = &run.scope;
    match name {
        "search_items" => {
            let raw = structured(args, "filter");
            let filter = match (Some(&raw).filter(|f| !f.is_null()), opt(args, "text")) {
                (None, None) => Filter::Open,
                (f, t) => {
                    let mut all: Vec<Filter> = Vec::new();
                    if let Some(f) = f {
                        all.push(serde_json::from_value(f.clone()).map_err(|e| format!("filter isn't valid: {e}. {FILTER_HELP}"))?);
                    }
                    all.extend(t.map(|text| Filter::Text { text: text.into() }));
                    if all.len() == 1 { all.remove(0) } else { Filter::And { filters: all } }
                }
            };
            let limit = args["limit"].as_u64().map_or(SEARCH_DEFAULT, |n| (n as usize).clamp(1, SEARCH_LIMIT));
            let found = core.search_cached(scope, &filter).await.map_err(|e| format!("Search failed: {e}"))?;
            let mut out = format!("{} items match", found.len());
            if found.len() > limit {
                out.push_str(&format!(", showing {limit}"));
            }
            for i in found.iter().take(limit) {
                let who = serde_json::from_value::<CachedTicket>(i.extra.clone()).ok().and_then(|t| t.assignee.map(|p| p.name));
                out.push_str(&format!("\n{} [{}] {} ({})", i.item.key, i.status.name, i.title, who.as_deref().unwrap_or("unassigned")));
            }
            Ok(out)
        }
        "get_item" => {
            let key = required(args, "key")?;
            reachable(st, run, key).await?;
            let ticket = core.ticket(scope, key).await.map_err(|e| format!("Couldn't read {key}: {e}"))?;
            let query = ProposalQuery { states: Some(open_states()), item: Some(item_ref(scope, key)), ..Default::default() };
            let drafts = core.proposals_in(scope, &query).await.unwrap_or_default();
            let mut out = describe(&ticket);
            if !drafts.is_empty() {
                out.push_str("\n\nOpen drafts on this item:\n");
                out.push_str(&drafts.iter().map(draft_line).collect::<Vec<_>>().join("\n"));
            }
            Ok(out)
        }
        "find_containers" => {
            let found = core.find_containers(scope, required(args, "query")?, SEARCH_DEFAULT).await.map_err(|e| format!("Couldn't search the projects: {e}"))?;
            if found.is_empty() {
                return Ok("No project matches.".into());
            }
            Ok(found
                .iter()
                .map(|(c, watched)| format!("{} · {} · {}{}", c.container_ref.external_id, c.key, c.name, if *watched { "" } else { " · not watched" }))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "list_containers" => {
            let all = core.containers_in(scope).await.map_err(|e| format!("Couldn't list containers: {e}"))?;
            Ok(all.iter().map(|c| format!("{} · {} · {}", c.container_ref.external_id, c.key, c.name)).collect::<Vec<_>>().join("\n"))
        }
        "get_workflow" => {
            let container = ContainerRef { connection_id: Connection::jira_id(scope), external_id: required(args, "container")?.into() };
            let watched = core.containers_in(scope).await.map_err(|e| e.to_string())?;
            if !watched.iter().any(|c| c.container_ref == container) {
                return Err("no such container among the watched ones; call list_containers".into());
            }
            let w = core.workflow_in(scope, &container).await.map_err(|e| e.to_string())?.ok_or("no such container; call list_containers")?;
            let mut out = w.statuses.iter().map(|s| format!("{} · {} · {:?}", s.id, s.name, s.category)).collect::<Vec<_>>().join("\n");
            match &w.transitions {
                Transitions::Any => out.push_str("\nAny status can follow any other."),
                Transitions::Graph(moves) => {
                    out.push_str("\nMoves:");
                    moves.iter().for_each(|m| out.push_str(&format!("\n{} → {}", m.from, m.to)));
                }
            }
            Ok(out)
        }
        "list_next_statuses" => {
            let key = required(args, "key")?;
            reachable(st, run, key).await?;
            let ts = core.transitions(scope, key).await.map_err(|e| format!("Couldn't list statuses for {key}: {e}"))?;
            Ok(ts.iter().map(|t| format!("{}: {} → {}", t.id, t.name, t.to.name)).collect::<Vec<_>>().join("\n"))
        }
        "list_proposals" => {
            let states = match opt(args, "state").unwrap_or("open") {
                "open" => Some(open_states()),
                "applied" => Some(vec![StateKind::Applied]),
                "skipped" => Some(vec![StateKind::Skipped]),
                "retired" => Some(vec![StateKind::Retired]),
                "all" => None,
                other => return Err(format!("state must be open, applied, skipped, retired or all, not {other}")),
            };
            let item = opt(args, "key").map(|k| item_ref(scope, k));
            let found = core.proposals_in(scope, &ProposalQuery { states, item, ..Default::default() }).await.map_err(|e| e.to_string())?;
            if found.is_empty() {
                return Ok("No drafts.".into());
            }
            Ok(found.iter().take(PROPOSALS_SHOWN).map(draft_line).collect::<Vec<_>>().join("\n"))
        }
        "set_view_filter" => {
            let filter: Filter = serde_json::from_value(structured(args, "filter")).map_err(|e| format!("filter isn't valid: {e}. {FILTER_HELP}"))?;
            (st.view)(run_id, &filter, required(args, "note")?);
            Ok("The user's view now shows that filter, and they can undo it.".into())
        }
        "propose_comment" => {
            let key = required(args, "key")?;
            reachable(st, run, key).await?;
            let intent = Intent::Comment { item: item_ref(scope, key), body: Doc::from_text(required(args, "body")?, &[]) };
            propose(st, scope, run_id, intent, None).await
        }
        "propose_subtasks" => {
            let key = required(args, "key")?;
            reachable(st, run, key).await?;
            let intent = Intent::Subtasks { parent: item_ref(scope, key), summaries: summaries_of(args)? };
            propose(st, scope, run_id, intent, None).await
        }
        "propose_transition" => {
            let key = required(args, "key")?;
            reachable(st, run, key).await?;
            let (intent, label) = transition(st, scope, key, required(args, "status_id")?).await?;
            propose(st, scope, run_id, intent, Some(label)).await
        }
        "propose_create" => {
            let container = required(args, "container")?;
            // Any project will do, watched or not: a new item reads nothing of what is already there.
            let found = core.container_named(scope, container).await.map_err(|e| e.to_string())?.ok_or("no such container; call list_containers or find_containers")?;
            if let Some(parent) = opt(args, "parent") {
                reachable(st, run, parent).await?;
            }
            let kind = item_kind(opt(args, "kind").unwrap_or("task"))?;
            let fields = NewItem {
                title: required(args, "title")?.into(),
                body: opt(args, "description").map(|d| Doc::from_text(d, &[])).unwrap_or_default(),
                kind,
                assignee: None,
                parent: opt(args, "parent").map(|k| item_ref(scope, k)),
                priority: None,
                labels: vec![],
            };
            propose(st, scope, run_id, Intent::Create { container: found, fields, link: None }, None).await
        }
        "revise_proposal" => {
            let id = required(args, "id")?;
            let p = core.proposal_in(scope, id).await.map_err(|e| e.to_string())?.ok_or("no draft with that id; call list_proposals")?;
            proposals::require_pip_may_revise(&p).map_err(|e| e.to_string())?;
            let intent = match &p.intent {
                Intent::Comment { item, .. } => Intent::Comment { item: item.clone(), body: Doc::from_text(required(args, "body")?, &[]) },
                Intent::Transition { item, .. } => transition(st, scope, &item.key, required(args, "status_id")?).await?.0,
                Intent::Subtasks { parent, .. } => Intent::Subtasks { parent: parent.clone(), summaries: summaries_of(args)? },
                Intent::Create { container, fields, link } => {
                    let title = opt(args, "title").map_or(fields.title.clone(), String::from);
                    let body = opt(args, "description").map_or(fields.body.clone(), |d| Doc::from_text(d, &[]));
                    let kind = opt(args, "kind").map(item_kind).transpose()?.unwrap_or(fields.kind);
                    Intent::Create { container: container.clone(), fields: NewItem { title, body, kind, ..fields.clone() }, link: link.clone() }
                }
                Intent::StartRun { connection_id, item, spec } => super::runs::revised(connection_id, item, spec, args)?,
                _ => return Err("this kind of draft can't be revised".into()),
            };
            let revised = core.revise_as_pip(scope, id, intent).await.map_err(|e| e.to_string())?;
            (st.sink)(&Connection::jira_id(scope));
            Ok(format!("Draft {} updated. It has not been applied; the user still has to approve it.", revised.id))
        }
        "retire_proposal" => {
            let id = required(args, "id")?;
            let reason = format!("withdrawn by Pip: {}", opt(args, "reason").unwrap_or("no longer needed"));
            let retired = core.retire_as_pip(scope, id, &reason).await.map_err(|e| e.to_string())?;
            (st.sink)(&Connection::jira_id(scope));
            Ok(format!("Draft {} withdrawn.", retired.id))
        }
        other => match super::github::run(st, run, other, args).await {
            Some(reply) => reply,
            None => match super::runs::run(st, run, run_id, other, args).await {
                Some(reply) => reply,
                None => Err(format!("Unknown tool {other}")),
            },
        },
    }
}

fn item_kind(name: &str) -> std::result::Result<ItemKind, String> {
    match name {
        "task" => Ok(ItemKind::Task),
        "bug" => Ok(ItemKind::Bug),
        "story" => Ok(ItemKind::Story),
        "epic" => Ok(ItemKind::Epic),
        other => Err(format!("kind must be task, bug, story or epic, not {other}")),
    }
}

/// The transition to `status_id` and its name, if the item can move there now.
async fn transition(st: &McpState, scope: &Scope, key: &str, status_id: &str) -> std::result::Result<(Intent, String), String> {
    let moves = st.core.transitions(scope, key).await.map_err(|e| format!("Couldn't check statuses for {key}: {e}"))?;
    let found = moves
        .into_iter()
        .find(|t| t.id == status_id)
        .ok_or_else(|| format!("{status_id} isn't a status {key} can move to; call list_next_statuses"))?;
    Ok((Intent::Transition { item: item_ref(scope, key), to: found.id }, found.name))
}

/// Stores the draft, unless the same one is already open. Other open drafts of the same kind on the item are named in
/// the reply so the model can revise one instead of piling up.
async fn propose(st: &McpState, scope: &Scope, run_id: &str, intent: Intent, label: Option<String>) -> Reply {
    let query = ProposalQuery { states: Some(open_states()), item: intent.target().cloned(), ..Default::default() };
    let open: Vec<Proposal> = st.core.proposals_in(scope, &query).await.map_err(|e| e.to_string())?;
    if let Some(same) = open.iter().find(|p| p.intent == intent) {
        return Err(format!("An identical draft is already open (proposal {}). Don't propose it again; see list_proposals.", same.id));
    }
    let similar: Vec<&str> = open
        .iter()
        .filter(|p| discriminant(&p.intent) == discriminant(&intent) && intent.target().is_some())
        .map(|p| p.id.as_str())
        .collect();
    let (target, place) = match intent.target() {
        Some(t) => (format!("on {}", t.key), "in the Pip panel on that item".to_string()),
        None => match &intent {
            Intent::Create { fields, .. } => (described(fields.kind), "in the user's list of open drafts".into()),
            _ => (String::new(), String::new()),
        },
    };
    let made = st.core.propose(scope, Draft::from_pip(run_id, intent, label)).await.map_err(|e| format!("Couldn't save the draft: {e}"))?;
    (st.sink)(&Connection::jira_id(scope));
    let mut reply = saved(&target, &place, &made.id);
    if !similar.is_empty() {
        reply.push_str(&format!(" Note: other open drafts of this kind exist on the item ({}); revise or retire yours if this replaces one.", similar.join(", ")));
    }
    Ok(reply)
}

/// A short, human description of one of our tools' calls, e.g. `Looked up CA-412`.
pub fn tool_label(name: &str, input: &Value) -> Option<String> {
    let s = |k: &str| input[k].as_str().unwrap_or_default();
    Some(match name {
        "get_item" => format!("Looked up {}", s("key")),
        "search_items" => "Searched the items".into(),
        "list_containers" => "Listed the projects".into(),
        "find_containers" => format!("Looked for projects matching {}", s("query")),
        "get_workflow" => "Checked a workflow".into(),
        "list_next_statuses" => format!("Checked the statuses for {}", s("key")),
        "list_proposals" => "Checked the open drafts".into(),
        "set_view_filter" => "Filtered the view".into(),
        "propose_comment" => format!("Drafted a comment on {}", s("key")),
        "propose_transition" => format!("Suggested a transition for {}", s("key")),
        "propose_subtasks" => format!("Suggested subtasks for {}", s("key")),
        "propose_create" => format!("Suggested a new item: {}", s("title")),
        "revise_proposal" => "Updated a draft".into(),
        "retire_proposal" => "Withdrew a draft".into(),
        _ => return super::runs::label(name).or_else(|| super::github::label(name, input)),
    })
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::domain::{Category, CreatedBy, Origin, ProposalState, StatusDef};
    use crate::inbox::testing::{fixture, Fixture};
    use crate::tracker::testing::sample_ticket;
    use crate::tracker::Move;

    struct Rig {
        fx: Fixture,
        st: McpState,
        changes: Arc<AtomicUsize>,
        views: Views,
    }

    type Views = Arc<std::sync::Mutex<Vec<(String, Filter, String)>>>;

    async fn rig() -> Rig {
        let fx = fixture().await;
        fx.add_item(2).await;
        fx.tracker.moves.lock().unwrap().push(Move { name: "Finish".into(), to: StatusDef { id: "10001".into(), name: "Done".into(), category: Category::Done } });
        let changes = Arc::new(AtomicUsize::new(0));
        let counter = changes.clone();
        let views: Views = Arc::default();
        let seen = views.clone();
        let runs: PipRuns = Arc::default();
        runs.lock().unwrap().insert("run-1".into(), PipRun::new(fx.scope.clone()));
        let st = McpState { core: fx.core.clone(), tokens: Tokens::default(), sink: Arc::new(move |_| { counter.fetch_add(1, Ordering::SeqCst); }), view: Arc::new(move |run, f, note| seen.lock().unwrap().push((run.into(), f.clone(), note.into()))), runs, planner: crate::agent::runs::testing::FakePlanner::unused() };
        Rig { fx, st, changes, views }
    }

    impl Rig {
        /// The user hands Pip these tickets in this run.
        fn hand(&self, keys: &[&str]) {
            self.st.runs.lock().unwrap().get_mut("run-1").unwrap().handed = keys.iter().map(|k| k.to_uppercase()).collect();
        }

        /// Watches only `CA`, with another project's ticket `OTH-1` in the cache and both projects known.
        async fn only_ca_watched(&self) {
            self.fx.add_in("OTH-1", "OTH").await;
            let ca = self.fx.core.containers_in(&self.fx.scope).await.unwrap().remove(0);
            let oth = crate::domain::Container {
                container_ref: ContainerRef { connection_id: ca.container_ref.connection_id.clone(), external_id: "OTH".into() },
                key: "OTH".into(),
                name: "Other".into(),
                workflow: ca.workflow.clone(),
            };
            let id = ca.container_ref.connection_id.clone();
            self.fx.set_containers(&[ca, oth]).await;
            self.fx.core.watch_set_mode(&id, crate::domain::WatchMode::Selected).await.unwrap();
            let change = crate::domain::WatchChange { container_id: "CA".into(), watched: Some(true), ..Default::default() };
            self.fx.core.watch_set_containers(&id, &[change]).await.unwrap();
        }

        async fn call(&self, name: &str, args: Value) -> (String, bool) {
            let r = call_tool(&self.st, "run-1", &json!({ "name": name, "arguments": args })).await;
            (r["content"][0]["text"].as_str().unwrap().to_string(), r["isError"].as_bool().unwrap())
        }

        async fn ok(&self, name: &str, args: Value) -> String {
            let (text, is_error) = self.call(name, args).await;
            assert!(!is_error, "{name}: {text}");
            text
        }

        async fn err(&self, name: &str, args: Value) -> String {
            let (text, is_error) = self.call(name, args).await;
            assert!(is_error, "{name} should have failed: {text}");
            text
        }

        async fn drafts(&self) -> Vec<Proposal> {
            self.fx.core.proposals_in(&self.fx.scope, &ProposalQuery::default()).await.unwrap()
        }

        async fn draft_by(&self, by: CreatedBy, body: &str) -> Proposal {
            self.draft_from(Origin::Board, by, body).await
        }

        async fn draft_from(&self, origin: Origin, by: CreatedBy, body: &str) -> Proposal {
            let draft = Draft {
                origin,
                created_by: by,
                intent: Intent::Comment { item: self.fx.item("CA-1"), body: Doc::from_text(body, &[]) },
                label: None,
                basis: None,
            };
            self.fx.core.propose(&self.fx.scope, draft).await.unwrap()
        }

        async fn stored(&self, id: &str) -> Proposal {
            self.fx.core.proposal_in(&self.fx.scope, id).await.unwrap().unwrap()
        }
    }

    fn id_in(reply: &str) -> String {
        reply.split("proposal ").nth(1).unwrap().split(')').next().unwrap().to_string()
    }

    #[test]
    fn checks_the_bearer_token_against_the_one_issued_for_that_run() {
        let tokens = Tokens::default();
        tokens.lock().unwrap().insert("r1".into(), "abc".into());
        let mut h = HeaderMap::new();
        assert!(!authorized(&h, &tokens, "r1"));
        h.insert("authorization", "Bearer abd".parse().unwrap());
        assert!(!authorized(&h, &tokens, "r1"));
        h.insert("authorization", "Bearer abc".parse().unwrap());
        assert!(authorized(&h, &tokens, "r1"));
        assert!(!authorized(&h, &tokens, "r2"));
    }

    #[test]
    fn the_tools_are_the_neutral_set_and_none_of_them_writes() {
        let mut names: Vec<String> = tool_list().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
        names.sort();
        let mut want = [
            "search_items", "get_item", "list_containers", "find_containers", "get_workflow", "list_next_statuses", "list_proposals",
            "propose_comment", "propose_transition", "propose_subtasks", "propose_create", "revise_proposal", "retire_proposal",
            "set_view_filter",
        ]
        .map(String::from)
        .into_iter()
        .chain(crate::agent::github::NAMES.map(String::from))
        .chain(crate::agent::runs::NAMES.map(String::from))
        .collect::<Vec<_>>();
        want.sort();
        assert_eq!(names, want);
        for forbidden in ["start_run", "stop_run", "answer_run", "attach_run", "rm_run", "approve_run", "launch_run"] {
            assert!(!names.iter().any(|n| n == forbidden), "{forbidden}");
        }
        let described: Vec<Value> = tool_list().into_iter().filter(|t| t["name"] != "search_items").collect();
        assert!(described.iter().all(|t| t["inputSchema"]["required"].is_array()));
    }

    #[tokio::test]
    async fn without_a_github_account_the_code_tools_say_nothing_is_watched() {
        let r = rig().await;
        assert!(r
            .ok("list_watched_repos", json!({}))
            .await
            .contains("No repositories are watched"));
        assert!(r
            .err(
                "read_repo_file",
                json!({ "repo": "acme/webshop", "path": "a" })
            )
            .await
            .contains("Ask the person to watch it"));
        assert!(r
            .ok("ticket_changes", json!({ "key": "CA-1" }))
            .await
            .contains("No pull request, branch or commit"));
        assert!(r
            .ok("search_code", json!({ "query": "x" }))
            .await
            .contains("No matches"));
    }

    #[tokio::test]
    async fn set_view_filter_hands_the_filter_to_the_page_and_writes_nothing() {
        let r = rig().await;
        r.ok("set_view_filter", json!({ "filter": { "type": "and", "filters": [{ "type": "stale", "days": 5 }, { "type": "blocked" }] }, "note": "Stale and blocked" })).await;
        let seen = r.views.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "run-1");
        assert_eq!(seen[0].1, Filter::And { filters: vec![Filter::Stale { days: 5 }, Filter::Blocked] });
        assert_eq!(seen[0].2, "Stale and blocked");
        assert!(r.drafts().await.is_empty());
        assert!(r.err("set_view_filter", json!({ "filter": { "type": "nope" }, "note": "x" })).await.contains("isn't valid"));
        assert!(r.err("set_view_filter", json!({ "filter": { "type": "blocked" } })).await.contains("note is required"));
        assert_eq!(r.views.lock().unwrap().len(), 1);
    }

    #[test]
    fn describes_a_ticket_for_the_model() {
        let d: Value = serde_json::from_str(&describe(&sample_ticket())).unwrap();
        assert_eq!(d["key"], "CA-1");
        assert_eq!(d["status"], "In Review");
        assert_eq!(d["recentComments"][0]["author"], "Sam");
        assert_eq!(d["recentHistory"][0]["to"], "In Review");
    }

    #[tokio::test]
    async fn a_run_that_has_ended_gets_nothing() {
        let r = rig().await;
        let reply = call_tool(&r.st, "gone", &json!({ "name": "get_item", "arguments": { "key": "CA-1" } })).await;
        assert_eq!(reply["isError"], true);
        assert!(reply["content"][0]["text"].as_str().unwrap().contains("ended"));
        assert!(r.err("nonsense", json!({})).await.contains("Unknown tool"));
    }

    #[tokio::test]
    async fn search_items_takes_a_filter_plain_text_or_both() {
        let r = rig().await;
        let all = r.ok("search_items", json!({})).await;
        assert!(all.starts_with("2 items match") && all.contains("CA-1 [In Review] Ticket 1") && all.contains("CA-2"), "{all}");

        let by_text = r.ok("search_items", json!({ "text": "ticket 2" })).await;
        assert!(by_text.starts_with("1 items match") && by_text.contains("CA-2"), "{by_text}");

        let by_filter = r.ok("search_items", json!({ "filter": { "type": "status", "name": "in review" } })).await;
        assert!(by_filter.starts_with("2 items match"), "{by_filter}");

        let both = r.ok("search_items", json!({ "filter": { "type": "status", "name": "In Review" }, "text": "Ticket 2", "limit": 1 })).await;
        assert!(both.starts_with("1 items match") && both.contains("CA-2") && !both.contains("CA-1"), "{both}");

        let capped = r.ok("search_items", json!({ "limit": 1 })).await;
        assert!(capped.contains("showing 1") && capped.lines().count() == 2, "{capped}");

        let encoded = r.ok("search_items", json!({ "filter": "{\"type\":\"status\",\"name\":\"In Review\"}", "text": "Ticket 2" })).await;
        assert!(encoded.starts_with("1 items match"), "{encoded}");

        let bad = r.err("search_items", json!({ "filter": { "type": "nope" } })).await;
        assert!(bad.contains("filter isn't valid") && bad.contains("needsMe"), "{bad}");
    }

    #[tokio::test]
    async fn get_item_and_the_workflow_tools_read_the_cache() {
        let r = rig().await;
        let item = r.ok("get_item", json!({ "key": "CA-1" })).await;
        assert!(item.contains("\"summary\"") && !item.contains("Open drafts"));
        r.draft_by(CreatedBy::User, "already here").await;
        assert!(r.ok("get_item", json!({ "key": "CA-1" })).await.contains("Open drafts on this item:\n"));
        assert!(r.err("get_item", json!({})).await.contains("key is required"));

        let containers = r.ok("list_containers", json!({})).await;
        assert!(containers.contains("· CA · Cats"), "{containers}");
        let id = containers.split(" · ").next().unwrap();
        let workflow = r.ok("get_workflow", json!({ "container": id })).await;
        assert!(workflow.contains("10001 · Done · Done") && workflow.contains("Any status can follow any other"), "{workflow}");
        assert!(r.err("get_workflow", json!({ "container": "nope" })).await.contains("list_containers"));
        assert_eq!(r.ok("list_next_statuses", json!({ "key": "CA-1" })).await, "10001: Finish → Done");
    }

    #[tokio::test]
    async fn every_propose_tool_stores_a_pending_pip_draft_and_none_touches_the_tracker() {
        let r = rig().await;
        let comment = r.ok("propose_comment", json!({ "key": "CA-1", "body": " Looks good " })).await;
        assert!(comment.contains("on CA-1") && comment.contains("has not been applied"), "{comment}");
        r.ok("propose_transition", json!({ "key": "CA-1", "status_id": "10001" })).await;
        r.ok("propose_subtasks", json!({ "key": "CA-1", "summaries": "[\"a\", \" \", \"b\"]" })).await;
        let container = r.ok("list_containers", json!({})).await.split(" · ").next().unwrap().to_string();
        let created = r.ok("propose_create", json!({ "container": container, "title": "New thing", "description": "Why", "kind": "bug", "parent": "CA-2" })).await;
        assert!(created.contains("to create a new bug"), "{created}");

        let drafts = r.drafts().await;
        assert_eq!(drafts.len(), 4);
        assert!(drafts.iter().all(|p| p.created_by == CreatedBy::Pip && p.state == ProposalState::Pending && p.origin == Origin::Chat { request_id: "run-1".into() }));
        let has = |f: &dyn Fn(&Intent) -> bool| drafts.iter().any(|p| f(&p.intent));
        assert!(has(&|i| matches!(i, Intent::Comment { body, .. } if body.plain_text() == "Looks good")));
        assert!(has(&|i| matches!(i, Intent::Transition { to, .. } if to == "10001")));
        assert!(has(&|i| matches!(i, Intent::Subtasks { summaries, .. } if summaries == &["a", "b"])));
        assert!(has(&|i| matches!(i, Intent::Create { fields, .. } if fields.title == "New thing" && fields.parent.as_ref().is_some_and(|p| p.key == "CA-2"))));
        assert_eq!(drafts.iter().find(|p| matches!(p.intent, Intent::Transition { .. })).unwrap().label.as_deref(), Some("Finish"));
        assert_eq!(r.changes.load(Ordering::SeqCst), 4);
        assert!(r.fx.tracker.intents().is_empty(), "proposing must never write");

        assert!(r.err("propose_transition", json!({ "key": "CA-1", "status_id": "99" })).await.contains("list_next_statuses"));
        assert!(r.err("propose_comment", json!({ "key": "CA-1", "body": " " })).await.contains("body is required"));
        assert!(r.err("propose_subtasks", json!({ "key": "CA-1", "summaries": [] })).await.contains("at least one"));
        assert!(r.err("propose_create", json!({ "container": "nope", "title": "x" })).await.contains("list_containers"));
        assert!(r.err("propose_create", json!({ "container": container, "title": "x", "kind": "saga" })).await.contains("kind must be"));
        assert_eq!(r.drafts().await.len(), 4);
    }

    #[tokio::test]
    async fn an_identical_open_draft_is_refused_and_a_similar_one_is_flagged() {
        let r = rig().await;
        let first = id_in(&r.ok("propose_comment", json!({ "key": "CA-1", "body": "Ship it" })).await);

        let again = r.err("propose_comment", json!({ "key": "CA-1", "body": "Ship it" })).await;
        assert!(again.contains(&first) && again.contains("identical"), "{again}");

        let other_item = r.ok("propose_comment", json!({ "key": "CA-2", "body": "Ship it" })).await;
        assert!(!other_item.contains("Note:"));
        let similar = r.ok("propose_comment", json!({ "key": "CA-1", "body": "Ship it soon" })).await;
        assert!(similar.contains("Note:") && similar.contains(&first), "{similar}");

        r.fx.core.skip_proposal(&first).await.unwrap();
        r.ok("propose_comment", json!({ "key": "CA-1", "body": "Ship it" })).await;
    }

    #[tokio::test]
    async fn list_proposals_shows_everyone_s_drafts_and_marks_the_ones_pip_may_change() {
        let r = rig().await;
        let mine = id_in(&r.ok("propose_comment", json!({ "key": "CA-1", "body": "mine" })).await);
        let users = r.draft_by(CreatedBy::User, "the user's").await;
        let auto = r.draft_by(CreatedBy::Autopilot, "autopilot's").await;
        let skipped = r.draft_by(CreatedBy::User, "skipped one").await;
        r.fx.core.skip_proposal(&skipped.id).await.unwrap();
        r.ok("propose_subtasks", json!({ "key": "CA-2", "summaries": ["x"] })).await;

        let open = r.ok("list_proposals", json!({})).await;
        assert_eq!(open.lines().count(), 4, "{open}");
        let line = |id: &str| open.lines().find(|l| l.starts_with(id)).unwrap().to_string();
        assert!(line(&mine).contains("by Pip · yours to revise or retire"));
        assert!(line(&users.id).contains("by the user") && !line(&users.id).contains("yours"));
        assert!(line(&auto.id).contains("by autopilot") && !line(&auto.id).contains("yours"));
        assert!(!open.contains(&skipped.id));

        assert!(r.ok("list_proposals", json!({ "state": "skipped" })).await.contains(&skipped.id));
        assert_eq!(r.ok("list_proposals", json!({ "state": "all" })).await.lines().count(), 5);
        let on_two = r.ok("list_proposals", json!({ "key": "CA-2" })).await;
        assert!(on_two.lines().count() == 1 && on_two.contains("subtasks under CA-2"), "{on_two}");
        assert_eq!(r.ok("list_proposals", json!({ "state": "applied" })).await, "No drafts.");
        assert!(r.err("list_proposals", json!({ "state": "weird" })).await.contains("state must be"));
    }

    #[tokio::test]
    async fn pip_may_revise_and_retire_only_its_own_pending_drafts() {
        let r = rig().await;
        let mine = id_in(&r.ok("propose_comment", json!({ "key": "CA-1", "body": "first try" })).await);
        let users = r.draft_by(CreatedBy::User, "the user's words").await;
        let auto = r.draft_by(CreatedBy::Autopilot, "autopilot's words").await;
        let before = r.drafts().await;

        for foreign in [&users.id, &auto.id] {
            let revise = r.err("revise_proposal", json!({ "id": foreign, "body": "hijacked" })).await;
            assert!(revise.contains("wasn't made by Pip"), "{revise}");
            assert!(r.err("retire_proposal", json!({ "id": foreign })).await.contains("wasn't made by Pip"));
        }
        assert!(r.err("revise_proposal", json!({ "id": "missing", "body": "x" })).await.contains("list_proposals"));
        assert_eq!(r.drafts().await, before, "refused calls change nothing");

        assert!(r.ok("revise_proposal", json!({ "id": mine, "body": "second try" })).await.contains("not been applied"));
        let revised = r.stored(&mine).await;
        assert!(matches!(&revised.intent, Intent::Comment { body, .. } if body.plain_text() == "second try"));
        assert_eq!(revised.revisions.last().unwrap().note, "Revised by Pip");
        assert!(r.err("revise_proposal", json!({ "id": mine })).await.contains("body is required"));

        r.ok("retire_proposal", json!({ "id": mine, "reason": "the user said no" })).await;
        assert_eq!(r.stored(&mine).await.state, ProposalState::Retired("withdrawn by Pip: the user said no".into()));
        assert!(r.err("revise_proposal", json!({ "id": mine, "body": "again" })).await.contains("retired"));
        assert!(r.err("retire_proposal", json!({ "id": mine })).await.contains("retired"));

        let decided = id_in(&r.ok("propose_comment", json!({ "key": "CA-2", "body": "decided" })).await);
        r.fx.core.skip_proposal(&decided).await.unwrap();
        assert!(r.err("revise_proposal", json!({ "id": decided, "body": "late" })).await.contains("skipped"));
        assert_eq!(r.stored(&users.id).await, users);
        assert!(r.fx.tracker.intents().is_empty());
    }

    #[tokio::test]
    async fn the_own_drafts_rule_lives_in_core_not_only_in_the_tools() {
        let r = rig().await;
        let users = r.draft_by(CreatedBy::User, "theirs").await;
        let intent = Intent::Comment { item: r.fx.item("CA-1"), body: Doc::paragraph("mine now") };
        assert!(r.fx.core.revise_as_pip(&r.fx.scope, &users.id, intent).await.is_err());
        assert!(r.fx.core.retire_as_pip(&r.fx.scope, &users.id, "x").await.is_err());
        assert_eq!(r.stored(&users.id).await, users);
    }

    fn from_run() -> Origin {
        Origin::Run { run_id: "r1".into(), short_id: Some("ab12cd34".into()) }
    }

    #[tokio::test]
    async fn pip_may_revise_the_pending_comment_a_run_left_but_nothing_else_the_person_made() {
        let r = rig().await;
        let left = r.draft_from(from_run(), CreatedBy::User, "From the run").await;
        let by_hand = r.draft_by(CreatedBy::User, "typed by the person").await;
        let by_autopilot = r.draft_from(from_run(), CreatedBy::Autopilot, "autopilot's").await;
        let before = (r.stored(&by_hand.id).await, r.stored(&by_autopilot.id).await);

        let reply = r.ok("revise_proposal", json!({ "id": left.id, "body": "Reworked with the full result" })).await;
        assert!(reply.contains("not been applied") && reply.contains("approve"), "{reply}");
        let revised = r.stored(&left.id).await;
        assert!(matches!(&revised.intent, Intent::Comment { body, item } if body.plain_text() == "Reworked with the full result" && item.key == "CA-1"));
        assert_eq!((revised.created_by, revised.origin.clone(), revised.state.clone()), (CreatedBy::User, from_run(), ProposalState::Pending));
        assert_eq!(revised.revisions.last().unwrap().note, "Revised by Pip");
        assert!(r.fx.tracker.intents().is_empty(), "nothing is posted");

        for other in [&by_hand.id, &by_autopilot.id] {
            assert!(r.err("revise_proposal", json!({ "id": other, "body": "hijacked" })).await.contains("wasn't made by Pip"));
        }
        assert_eq!((r.stored(&by_hand.id).await, r.stored(&by_autopilot.id).await), before);
        assert!(r.err("retire_proposal", json!({ "id": left.id })).await.contains("wasn't made by Pip"), "it may be revised, not withdrawn");

        r.fx.core.skip_proposal(&left.id).await.unwrap();
        assert!(r.err("revise_proposal", json!({ "id": left.id, "body": "late" })).await.contains("skipped"));
    }

    async fn new_ticket_from(r: &Rig, origin: Origin, by: CreatedBy) -> Proposal {
        let container = r.fx.core.containers_in(&r.fx.scope).await.unwrap()[0].container_ref.clone();
        let fields = NewItem { title: "Backoff".into(), body: Doc::from_text("It loops.", &[]), kind: ItemKind::Task, assignee: None, parent: None, priority: None, labels: vec![] };
        let draft = Draft { origin, created_by: by, intent: Intent::Create { container, fields, link: None }, label: None, basis: None };
        r.fx.core.propose(&r.fx.scope, draft).await.unwrap()
    }

    #[tokio::test]
    async fn pip_may_revise_the_title_text_and_type_of_the_pending_ticket_a_run_left_and_nothing_else_of_it() {
        let r = rig().await;
        let left = new_ticket_from(&r, from_run(), CreatedBy::User).await;
        let reply = r.ok("revise_proposal", json!({ "id": left.id, "title": "Add a backoff to the consumer", "description": "It retries in a tight loop.\n\nEvidence: consumer.rs.", "kind": "bug" })).await;
        assert!(reply.contains("not been applied"), "{reply}");
        let revised = r.stored(&left.id).await;
        let (Intent::Create { container, fields, link }, Intent::Create { container: was, .. }) = (&revised.intent, &left.intent) else { panic!() };
        assert_eq!((fields.title.as_str(), fields.kind, container, link), ("Add a backoff to the consumer", ItemKind::Bug, was, &None));
        assert_eq!(fields.body.plain_text(), "It retries in a tight loop.\nEvidence: consumer.rs.");
        assert_eq!((fields.assignee.as_ref(), fields.parent.as_ref(), fields.priority, fields.labels.len()), (None, None, None, 0));
        assert_eq!((revised.created_by, revised.origin.clone(), revised.state.clone()), (CreatedBy::User, from_run(), ProposalState::Pending));
        assert_eq!(revised.revisions.last().unwrap().note, "Revised by Pip");
        assert!(r.err("revise_proposal", json!({ "id": left.id, "kind": "nonsense" })).await.contains("kind must be"));
        assert!(r.err("retire_proposal", json!({ "id": left.id })).await.contains("wasn't made by Pip"), "it may be revised, not withdrawn");
        assert!(r.fx.tracker.intents().is_empty(), "nothing is created");

        r.ok("revise_proposal", json!({ "id": left.id, "title": "Only the title" })).await;
        let Intent::Create { fields, .. } = r.stored(&left.id).await.intent else { panic!() };
        assert_eq!((fields.title.as_str(), fields.kind), ("Only the title", ItemKind::Bug), "what isn't named stays");

        r.fx.core.skip_proposal(&left.id).await.unwrap();
        assert!(r.err("revise_proposal", json!({ "id": left.id, "title": "late" })).await.contains("skipped"));
    }

    #[tokio::test]
    async fn a_new_ticket_the_person_made_or_autopilot_made_stays_off_limits_even_with_a_run_origin_next_door() {
        let r = rig().await;
        let by_hand = new_ticket_from(&r, Origin::Board, CreatedBy::User).await;
        let by_autopilot = new_ticket_from(&r, from_run(), CreatedBy::Autopilot).await;
        let before = (r.stored(&by_hand.id).await, r.stored(&by_autopilot.id).await);
        for other in [&by_hand.id, &by_autopilot.id] {
            assert!(r.err("revise_proposal", json!({ "id": other, "title": "hijacked" })).await.contains("wasn't made by Pip"));
        }
        let intent = Intent::Create { container: ContainerRef { connection_id: "c".into(), external_id: "x".into() }, fields: NewItem { title: "x".into(), body: Doc::default(), kind: ItemKind::Task, assignee: None, parent: None, priority: None, labels: vec![] }, link: None };
        assert!(r.fx.core.revise_as_pip(&r.fx.scope, &by_hand.id, intent).await.is_err(), "the rule lives in Core too");
        assert_eq!((r.stored(&by_hand.id).await, r.stored(&by_autopilot.id).await), before);
    }

    #[tokio::test]
    async fn the_list_names_the_run_a_ticket_draft_came_from_and_that_pip_may_revise_it() {
        let r = rig().await;
        let left = new_ticket_from(&r, from_run(), CreatedBy::User).await;
        let list = r.ok("list_proposals", json!({})).await;
        assert!(list.lines().any(|l| l.starts_with(&left.id) && l.contains("drafted from run r1; you may revise its text but not retire it")), "{list}");
    }

    #[tokio::test]
    async fn only_a_comment_from_a_run_is_open_to_pip_not_the_other_drafts_a_run_leaves() {
        let r = rig().await;
        r.fx.add_item(2).await;
        let link = r
            .fx
            .core
            .propose(
                &r.fx.scope,
                Draft { origin: from_run(), created_by: CreatedBy::User, intent: Intent::Link { from: r.fx.item("CA-2"), to: r.fx.item("CA-1"), kind: crate::domain::LinkKind::Blocks }, label: None, basis: None },
            )
            .await
            .unwrap();
        assert!(r.err("revise_proposal", json!({ "id": link.id, "body": "x" })).await.contains("wasn't made by Pip"));
        let intent = Intent::Comment { item: r.fx.item("CA-1"), body: Doc::paragraph("x") };
        assert!(r.fx.core.revise_as_pip(&r.fx.scope, &link.id, intent).await.is_err());
        assert_eq!(r.stored(&link.id).await, link);
    }

    #[tokio::test]
    async fn revising_a_transition_or_a_new_item_keeps_what_it_is_about() {
        let r = rig().await;
        let t = id_in(&r.ok("propose_transition", json!({ "key": "CA-1", "status_id": "10001" })).await);
        assert_eq!(r.stored(&t).await.label.as_deref(), Some("Finish"));
        r.fx.tracker.moves.lock().unwrap().push(Move { name: "Reopen".into(), to: StatusDef { id: "1".into(), name: "Open".into(), category: Category::Todo } });
        r.ok("revise_proposal", json!({ "id": t, "status_id": "1" })).await;
        let moved = r.stored(&t).await;
        assert!(matches!(&moved.intent, Intent::Transition { item, to } if item.key == "CA-1" && to == "1"));
        assert_eq!(moved.label, None, "the old target's name no longer applies");
        assert!(r.err("revise_proposal", json!({ "id": t, "status_id": "nope" })).await.contains("list_next_statuses"));

        let container = r.ok("list_containers", json!({})).await.split(" · ").next().unwrap().to_string();
        let c = id_in(&r.ok("propose_create", json!({ "container": container, "title": "Old", "description": "Keep me" })).await);
        r.ok("revise_proposal", json!({ "id": c, "title": "New" })).await;
        let Intent::Create { fields, .. } = r.stored(&c).await.intent else { panic!() };
        assert_eq!((fields.title.as_str(), fields.body.plain_text().as_str()), ("New", "Keep me"));
    }

    #[tokio::test]
    async fn search_and_the_container_tools_stop_at_the_watched_projects() {
        let r = rig().await;
        r.only_ca_watched().await;
        let found = r.ok("search_items", json!({})).await;
        assert!(found.contains("CA-1") && !found.contains("OTH-1"), "{found}");
        assert!(r.ok("search_items", json!({ "text": "OTH-1" })).await.starts_with("0 items match"));
        let containers = r.ok("list_containers", json!({})).await;
        assert!(containers.contains("· CA ·") && !containers.contains("OTH"), "{containers}");
        assert!(r.err("get_workflow", json!({ "container": "OTH" })).await.contains("watched"));
        assert!(r.ok("get_workflow", json!({ "container": "CA" })).await.contains("Done"));
    }

    #[tokio::test]
    async fn an_unwatched_ticket_is_out_of_reach_until_the_user_hands_it_over() {
        let r = rig().await;
        r.only_ca_watched().await;
        for (tool, args) in [
            ("get_item", json!({ "key": "OTH-1" })),
            ("list_next_statuses", json!({ "key": "OTH-1" })),
            ("propose_comment", json!({ "key": "OTH-1", "body": "hi" })),
            ("propose_transition", json!({ "key": "OTH-1", "status_id": "10001" })),
            ("propose_subtasks", json!({ "key": "OTH-1", "summaries": ["a"] })),
        ] {
            let e = r.err(tool, args).await;
            assert!(e.contains("OTH-1 isn't in a project the user watches"), "{tool}: {e}");
        }
        assert!(r.drafts().await.is_empty());
        assert_eq!(r.changes.load(Ordering::SeqCst), 0);

        r.hand(&["oth-1"]);
        assert!(r.ok("get_item", json!({ "key": "OTH-1" })).await.contains("\"summary\""));
        assert_eq!(r.ok("list_next_statuses", json!({ "key": "OTH-1" })).await, "10001: Finish → Done");
        r.ok("propose_comment", json!({ "key": "OTH-1", "body": "hi" })).await;
        r.ok("propose_transition", json!({ "key": "OTH-1", "status_id": "10001" })).await;
        r.ok("propose_subtasks", json!({ "key": "OTH-1", "summaries": ["a"] })).await;
        assert_eq!(r.drafts().await.len(), 3);
        assert!(r.err("propose_comment", json!({ "key": "OTH-2", "body": "hi" })).await.contains("OTH-2 isn't in a project"), "handing over one ticket hands over only that one");
        assert!(r.fx.tracker.intents().is_empty());
    }

    #[tokio::test]
    async fn a_watched_ticket_needs_no_handoff_and_an_uncached_one_is_out_of_reach() {
        let r = rig().await;
        r.only_ca_watched().await;
        r.ok("propose_comment", json!({ "key": "CA-1", "body": "fine" })).await;
        assert!(r.err("get_item", json!({ "key": "CA-404" })).await.contains("out of reach"));
    }

    #[tokio::test]
    async fn pip_may_create_in_any_project_and_can_look_projects_up() {
        let r = rig().await;
        r.only_ca_watched().await;
        let summary = |key: &str| crate::domain::ContainerSummary {
            container_ref: ContainerRef { connection_id: "jira:site:me".into(), external_id: key.into() },
            key: key.into(),
            name: format!("Project {key}"),
            kind: None,
            archived: false,
            last_active: None,
            item_hint: None,
        };
        *r.fx.tracker.catalog.lock().unwrap() = vec![summary("CA"), summary("WHS")];

        let found = r.ok("find_containers", json!({ "query": "whs" })).await;
        assert_eq!(found, "WHS · WHS · Project WHS · not watched");
        assert!(r.ok("find_containers", json!({ "query": "ca" })).await.lines().all(|l| !l.contains("not watched")));
        assert_eq!(r.ok("find_containers", json!({ "query": "zzz" })).await, "No project matches.");

        let created = r.ok("propose_create", json!({ "container": "whs", "title": "Pallet count off" })).await;
        assert!(created.contains("to create a new task"), "{created}");
        let drafts = r.drafts().await;
        assert!(matches!(&drafts[0].intent, Intent::Create { container, .. } if container.external_id == "WHS"));
        assert!(r.err("propose_create", json!({ "container": "NOPE", "title": "x" })).await.contains("find_containers"));
    }

    #[tokio::test]
    async fn a_new_item_cannot_hang_off_a_parent_pip_was_not_handed() {
        let r = rig().await;
        r.only_ca_watched().await;
        r.fx.tracker.catalog.lock().unwrap().push(crate::domain::ContainerSummary {
            container_ref: ContainerRef { connection_id: "jira:site:me".into(), external_id: "OTH".into() },
            key: "OTH".into(),
            name: "Other".into(),
            kind: None,
            archived: false,
            last_active: None,
            item_hint: None,
        });
        let args = json!({ "container": "OTH", "title": "Child", "parent": "OTH-1" });
        assert!(r.err("propose_create", args.clone()).await.contains("OTH-1 isn't in a project"));
        r.hand(&["OTH-1"]);
        r.ok("propose_create", args).await;
    }
}
