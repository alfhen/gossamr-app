mod agent;
mod auth;
mod claude;
mod config;
mod db;
mod domain;
mod error;
mod events;
mod inbox;
mod legacy;
mod model;
mod notify;
mod proposals;
mod secrets;
mod sync;
mod tracker;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use auth::{Auth, AuthStatus, OAuthApp, Scope};
use agent::{AgentService, AskRequest};
use claude::ClaudeCodeProvider;
use tracker::Connection;
use inbox::{Core, Edit};
use error::{Error, Result};
use domain::{Container, ContainerRef, Event, Filter, Intent, ItemRef, Proposal, ProposalQuery, WorkItem, Workflow};
use model::{Snapshot, Transition};
use sync::Trigger;

/// How often the scheduler checks whether a sync is due. Waking from sleep is noticed within one tick.
const TICK: Duration = Duration::from_secs(15);
const EVENT_LIMIT: usize = 100;

type CoreState = Arc<Core>;
type AgentState = Arc<AgentService>;

/// Sends the latest snapshot to the window and updates the Dock badge. Failures only mean there is nothing to
/// show yet (e.g. signed out).
async fn publish(app: &AppHandle, core: &Core) {
    let Ok(snap) = core.snapshot().await else { return };
    if let Some(win) = app.get_webview_window("main") {
        let unread = snap.inbox_unread(&inbox::now_iso());
        let _ = win.set_badge_count((unread > 0).then_some(unread as i64));
    }
    let _ = app.emit("snapshot", snap);
}

/// Tells the page the cache changed, so views over it can re-read.
fn cache_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("cache-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page the stored drafts changed, so it can re-read them.
fn proposals_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("proposals-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Asks the page to narrow the view the person is looking at.
fn pip_view(app: &AppHandle, request_id: &str, filter: &domain::Filter, note: &str) {
    let _ = app.emit("pip-view", serde_json::json!({ "requestId": request_id, "filter": filter, "note": note }));
}

/// Shows native notifications for new events, unless the window is focused and the user can already see them.
fn announce(app: &AppHandle, events: &[events::NewEvent]) {
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if focused {
        return;
    }
    for n in notify::notices(events) {
        let _ = app.notification().builder().title(n.title).body(n.body).show();
    }
}

#[tauri::command]
async fn auth_status(core: State<'_, CoreState>) -> Result<AuthStatus> {
    core.auth.status().await
}

#[tauri::command]
async fn save_oauth_app(core: State<'_, CoreState>, client_id: String, client_secret: String) -> Result<AuthStatus> {
    core.auth.save_app(OAuthApp { client_id, client_secret })?;
    core.auth.status().await
}

#[tauri::command]
async fn sign_in(app: AppHandle, core: State<'_, CoreState>) -> Result<AuthStatus> {
    let status = core
        .sign_in(|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| Error::Auth(format!("couldn't open the browser: {e}")))
        })
        .await?;
    core.wake.notify_one();
    Ok(status)
}

#[tauri::command]
async fn sign_out(app: AppHandle, core: State<'_, CoreState>) -> Result<()> {
    core.sign_out().await?;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_badge_count(None);
    }
    Ok(())
}

#[tauri::command]
async fn snapshot(core: State<'_, CoreState>) -> Result<Snapshot> {
    core.snapshot().await
}

#[tauri::command]
async fn cache_search(core: State<'_, CoreState>, filter: Filter) -> Result<Vec<WorkItem>> {
    core.cache_search(&filter).await
}

#[tauri::command]
async fn cache_item(core: State<'_, CoreState>, item: ItemRef) -> Result<Option<WorkItem>> {
    core.cache_item(&item).await
}

#[tauri::command]
async fn cache_containers(core: State<'_, CoreState>) -> Result<Vec<Container>> {
    core.cache_containers().await
}

#[tauri::command]
async fn cache_workflow(core: State<'_, CoreState>, container: ContainerRef) -> Result<Option<Workflow>> {
    core.cache_workflow(&container).await
}

#[tauri::command]
async fn cache_events(core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<Event>> {
    core.cache_events(&item, EVENT_LIMIT).await
}

#[tauri::command]
async fn proposals_list(core: State<'_, CoreState>, query: Option<ProposalQuery>) -> Result<Vec<Proposal>> {
    core.proposals(&query.unwrap_or_default()).await
}

#[tauri::command]
async fn proposals_get(core: State<'_, CoreState>, id: String) -> Result<Option<Proposal>> {
    core.proposal(&id).await
}

/// Drafts a write the person made by hand. It stays a draft until `proposals_approve`.
#[tauri::command]
async fn proposals_create(app: AppHandle, core: State<'_, CoreState>, intent: Intent, label: Option<String>) -> Result<Proposal> {
    let made = core.draft_as_user(intent, label).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(made)
}

#[tauri::command]
async fn proposals_edit(app: AppHandle, core: State<'_, CoreState>, id: String, edit: Edit) -> Result<Proposal> {
    let edited = core.edit_proposal(&id, &edit).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(edited)
}

#[tauri::command]
async fn proposals_skip(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let skipped = core.skip_proposal(&id).await?;
    proposals_changed(&app, &Connection::jira_id(&core.scope().await?));
    Ok(skipped)
}

/// Applies the draft. A failed attempt still returns it, back to pending with `error` set.
#[tauri::command]
async fn proposals_approve(app: AppHandle, core: State<'_, CoreState>, id: String) -> Result<Proposal> {
    let result = core.approve_proposal(&id).await;
    if let Ok(connection) = core.scope().await.map(|s| Connection::jira_id(&s)) {
        proposals_changed(&app, &connection);
        cache_changed(&app, &connection);
    }
    publish(&app, &core).await;
    result
}

#[tauri::command]
fn sync_now(core: State<'_, CoreState>) {
    core.wake.notify_one();
}

#[tauri::command]
async fn mark_seen(app: AppHandle, core: State<'_, CoreState>, key: String) -> Result<()> {
    core.mark_seen(&key).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn set_unread(app: AppHandle, core: State<'_, CoreState>, id: String, unread: bool) -> Result<()> {
    core.set_unread(&id, unread).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn set_done(app: AppHandle, core: State<'_, CoreState>, id: String, done: bool) -> Result<()> {
    core.set_done(&id, done).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn snooze(app: AppHandle, core: State<'_, CoreState>, id: String, until: Option<String>) -> Result<()> {
    core.snooze(&id, until.as_deref()).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn transitions(core: State<'_, CoreState>, key: String) -> Result<Vec<Transition>> {
    core.transitions(&core.scope().await?, &key).await
}

#[tauri::command]
async fn transition(app: AppHandle, core: State<'_, CoreState>, scope: Scope, key: String, transition_id: String) -> Result<()> {
    core.transition(&scope, &key, &transition_id).await?;
    cache_changed(&app, &Connection::jira_id(&scope));
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn comment(
    app: AppHandle,
    core: State<'_, CoreState>,
    scope: Scope,
    key: String,
    body: String,
    mentions: Option<Vec<model::MentionRef>>,
    files: Option<Vec<model::Uploaded>>,
) -> Result<()> {
    core.comment(&scope, &key, &body, &mentions.unwrap_or_default(), &files.unwrap_or_default()).await?;
    cache_changed(&app, &Connection::jira_id(&scope));
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn mentionable(core: State<'_, CoreState>, key: String, query: String) -> Result<Vec<model::Person>> {
    core.mentionable(&core.scope().await?, &key, &query).await
}

/// Uploads a file sent as the raw request body; its metadata comes URL-encoded in the `x-file` header, since header
/// values must be ASCII and file names often aren't.
#[tauri::command]
async fn attach(core: State<'_, CoreState>, request: tauri::ipc::Request<'_>) -> Result<model::Uploaded> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Api { status: 400, message: "expected the file as raw bytes".into() });
    };
    let meta: std::collections::HashMap<String, String> = request
        .headers()
        .get("x-file")
        .and_then(|v| v.to_str().ok())
        .map(|v| url::form_urlencoded::parse(v.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let field = |k: &str| meta.get(k).cloned().ok_or_else(|| Error::Api { status: 400, message: format!("missing {k}") });
    let scope = Scope { cloud_id: field("cloudId")?, account_id: field("accountId")? };
    core.attach(&scope, &field("key")?, &field("name")?, &field("type")?, bytes.clone()).await
}

#[tauri::command]
async fn ticket_media(core: State<'_, CoreState>, scope: Scope, key: String) -> Result<std::collections::HashMap<String, String>> {
    core.ticket_media(&scope, &key).await
}

#[tauri::command]
async fn attachment_limit(core: State<'_, CoreState>, scope: Scope) -> Result<Option<u64>> {
    core.attachment_limit(&scope).await
}

#[tauri::command]
async fn create_subtasks(
    app: AppHandle,
    core: State<'_, CoreState>,
    scope: Scope,
    key: String,
    summaries: Vec<String>,
) -> Result<model::CreatedSubtasks> {
    let created = core.create_subtasks(&scope, &key, &summaries).await?;
    cache_changed(&app, &Connection::jira_id(&scope));
    publish(&app, &core).await;
    Ok(created)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessions {
    /// The session last used for this ticket from the app, as `{id, cwd}`.
    last: Option<serde_json::Value>,
    recent: Vec<claude::sessions::SessionInfo>,
}

#[tauri::command]
async fn claude_sessions(core: State<'_, CoreState>, key: String) -> Result<ClaudeSessions> {
    let (last, own) = core.claude_sessions(&key).await?;
    let recent = tauri::async_runtime::spawn_blocking(move || {
        claude::sessions::projects_dir().map(|root| claude::sessions::recent(&root, &own, 15)).unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    Ok(ClaudeSessions { last, recent })
}

#[tauri::command]
async fn ask_claude(app: AppHandle, agent: State<'_, AgentState>, request: AskRequest) -> Result<()> {
    agent
        .ask(request, Arc::new(move |u| {
            let _ = app.emit("claude", u);
        }))
        .await
}

#[tauri::command]
fn cancel_claude(agent: State<'_, AgentState>, request_id: String) {
    agent.cancel(&request_id);
}

fn random_token() -> std::result::Result<String, getrandom::Error> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn spawn_sync_loop(app: AppHandle, core: CoreState) {
    tauri::async_runtime::spawn(async move {
        // Launch catches up straight away, from the cursor the last run left in the cache.
        let mut trigger = Trigger::Now;
        loop {
            if let Some(result) = core.sync_if_due(trigger).await {
                match result {
                    Ok(synced) => {
                        core.set_error(None);
                        announce(&app, &synced.new_events);
                        if synced.changed {
                            cache_changed(&app, &synced.connection_id);
                        }
                        if synced.proposals_changed {
                            proposals_changed(&app, &synced.connection_id);
                        }
                    }
                    Err(e) => core.set_error(Some(e.to_string())),
                }
                publish(&app, &core).await;
            }
            trigger = tokio::select! {
                _ = tokio::time::sleep(TICK) => Trigger::Timer,
                _ = core.wake.notified() => Trigger::Now,
                _ = core.focus.notified() => Trigger::Focus,
            };
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // `attachment://localhost/{id}` serves a Jira attachment to the page, so images load straight into <img>.
        .register_asynchronous_uri_scheme_protocol("attachment", |ctx, request, responder| {
            let core = ctx.app_handle().try_state::<CoreState>().map(|s| s.inner().clone());
            let id = request.uri().path().trim_start_matches('/').to_string();
            tauri::async_runtime::spawn(async move {
                let result = match core {
                    Some(core) => core.attachment(&id).await,
                    None => Err(Error::NotSignedIn),
                };
                let response = match result {
                    Ok((mime, bytes)) => tauri::http::Response::builder()
                        .header(tauri::http::header::CONTENT_TYPE, mime)
                        // Not cached: after a sign-out, another account must not be served this account's files.
                        .header(tauri::http::header::CACHE_CONTROL, "no-store")
                        .body(bytes),
                    Err(e) => tauri::http::Response::builder().status(502).body(e.to_string().into_bytes()),
                };
                responder.respond(response.expect("static response parts"));
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                if let Some(core) = window.app_handle().try_state::<CoreState>() {
                    core.focus.notify_one();
                }
            }
        })
        .setup(|app| {
            let http = reqwest::Client::builder()
                .user_agent(concat!("gossamr/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(30))
                .build()?;
            let auth = Arc::new(Auth::load(http.clone()));
            let registry = tracker::Registry::jira(http, auth.clone());
            let data_dir = app.path().app_data_dir()?;
            if let Err(e) = legacy::adopt_legacy_data(&data_dir) {
                eprintln!("couldn't move data from the previous app name, starting fresh: {e}");
            }
            let core: CoreState = Arc::new(Core::new(auth, registry, data_dir));
            tauri::async_runtime::block_on(core.restore());
            app.manage(core.clone());

            let handle = app.handle().clone();
            let view_handle = handle.clone();
            let token = random_token().map_err(|e| Error::Claude(format!("no randomness available: {e}")))?;
            let mcp = tauri::async_runtime::block_on(agent::mcp::McpServer::start(
                core.clone(),
                token,
                Arc::new(move |connection_id| proposals_changed(&handle, connection_id)),
                Arc::new(move |request_id, filter, note| pip_view(&view_handle, request_id, filter, note)),
            ))?;
            let config = config::AppConfig::load(&core.data_dir());
            app.manage::<AgentState>(Arc::new(AgentService::new(core.clone(), mcp, vec![Arc::new(ClaudeCodeProvider::new())], config)));

            spawn_sync_loop(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            save_oauth_app,
            sign_in,
            sign_out,
            snapshot,
            cache_search,
            cache_item,
            cache_containers,
            cache_workflow,
            cache_events,
            proposals_list,
            proposals_get,
            proposals_create,
            proposals_edit,
            proposals_skip,
            proposals_approve,
            sync_now,
            mark_seen,
            set_unread,
            set_done,
            snooze,
            transitions,
            transition,
            comment,
            attach,
            attachment_limit,
            ticket_media,
            mentionable,
            create_subtasks,
            claude_sessions,
            ask_claude,
            cancel_claude
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
