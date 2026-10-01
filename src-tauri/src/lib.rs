mod agent;
mod auth;
mod claude;
mod codehost;
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
mod runs;
mod secrets;
mod sync;
mod tracker;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use auth::{Auth, AuthStatus, DeviceStart, OAuthApp, Scope};
use agent::{AgentService, AskRequest};
use claude::ClaudeCodeProvider;
use tracker::{Connection, Move};
use inbox::{CatalogPage, CodeRef, ConnectionInfo, Core, Edit, WatchState};
use error::{Error, Result};
use domain::{
    CodeChange, CodeFile, CodeHit, CommitQuery, Comment, Container, ContainerRef, DevLink, Event, FeedPage, FeedQuery, Filter, Footprint, Identity, Intent, ItemRef, Proposal, ProposalQuery, PullRequestDetail, Stray,
    TreeEntry, WatchChange, WatchMode, WorkItem, Workflow,
};
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

/// Tells the page which work items' code links changed, so it can re-read them.
fn dev_links_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("dev-links-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page what is watched changed, so it can re-read the settings along with everything they scope.
fn watch_changed(app: &AppHandle, connection_id: &str) {
    let _ = app.emit("watch-changed", serde_json::json!({ "connectionId": connection_id }));
}

/// Tells the page about open items assigned to the person in containers they don't watch. It never watches them.
fn assigned_elsewhere(app: &AppHandle, connection_id: &str, strays: &[Stray]) {
    let _ = app.emit("watch-assigned-elsewhere", serde_json::json!({ "connectionId": connection_id, "strays": strays }));
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
async fn cache_search(core: State<'_, CoreState>, filter: Filter, include_unwatched: Option<bool>) -> Result<Vec<WorkItem>> {
    core.cache_search(&filter, include_unwatched.unwrap_or(false)).await
}

#[tauri::command]
async fn cache_item(core: State<'_, CoreState>, item: ItemRef) -> Result<Option<WorkItem>> {
    core.cache_item(&item).await
}

#[tauri::command]
async fn cache_containers(core: State<'_, CoreState>, include_unwatched: Option<bool>) -> Result<Vec<Container>> {
    core.cache_containers(include_unwatched.unwrap_or(false)).await
}

/// Reads an item live, without storing it, flagged `unwatched` when its container isn't watched.
#[tauri::command]
async fn peek_item(core: State<'_, CoreState>, item: ItemRef) -> Result<Option<WorkItem>> {
    core.peek_item(&item).await
}

#[tauri::command]
async fn watch_get(core: State<'_, CoreState>) -> Result<Vec<WatchState>> {
    core.watch_state().await
}

/// Everything the page shows and Pip sees depends on what is watched, so a change tells the page to re-read.
async fn watch_edited(app: &AppHandle, core: &Core, connection_id: &str) {
    watch_changed(app, connection_id);
    cache_changed(app, connection_id);
    publish(app, core).await;
}

#[tauri::command]
async fn watch_set_mode(app: AppHandle, core: State<'_, CoreState>, connection_id: String, mode: WatchMode) -> Result<()> {
    core.watch_set_mode(&connection_id, mode).await?;
    watch_edited(&app, &core, &connection_id).await;
    Ok(())
}

#[tauri::command]
async fn watch_set_containers(app: AppHandle, core: State<'_, CoreState>, connection_id: String, changes: Vec<WatchChange>) -> Result<()> {
    core.watch_set_containers(&connection_id, &changes).await?;
    watch_edited(&app, &core, &connection_id).await;
    Ok(())
}

#[tauri::command]
async fn watch_catalog(core: State<'_, CoreState>, connection_id: String, query: String, cursor: Option<String>) -> Result<CatalogPage> {
    core.watch_catalog(&connection_id, &query, cursor).await
}

#[tauri::command]
async fn watch_suggestions(core: State<'_, CoreState>, connection_id: String, refresh: Option<bool>) -> Result<Vec<Footprint>> {
    core.watch_suggestions(&connection_id, refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn watch_unwatched_assigned(core: State<'_, CoreState>, connection_id: String, refresh: Option<bool>) -> Result<Vec<Stray>> {
    core.watch_unwatched_assigned(&connection_id, refresh.unwrap_or(false)).await
}

#[tauri::command]
async fn watch_dismiss_assigned(core: State<'_, CoreState>, connection_id: String, container_id: String) -> Result<()> {
    core.watch_dismiss_assigned(&connection_id, &container_id).await
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
async fn cache_feed(core: State<'_, CoreState>, query: FeedQuery) -> Result<FeedPage> {
    core.cache_feed(&query).await
}

#[tauri::command]
async fn cache_feed_unread(core: State<'_, CoreState>) -> Result<usize> {
    core.cache_feed_unread().await
}

#[tauri::command]
async fn cache_me(core: State<'_, CoreState>) -> Result<Identity> {
    core.cache_me().await
}

#[tauri::command]
async fn cache_people(core: State<'_, CoreState>) -> Result<Vec<model::Person>> {
    core.cache_people().await
}

#[tauri::command]
async fn cache_comments(core: State<'_, CoreState>, item: ItemRef, refresh: bool) -> Result<Vec<Comment>> {
    core.cache_comments(&item, refresh).await
}

#[tauri::command]
async fn cache_transitions(core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<Move>> {
    core.cache_transitions(&item).await
}

#[tauri::command]
async fn connections_list(core: State<'_, CoreState>) -> Result<Vec<ConnectionInfo>> {
    core.connections().await
}

/// The account a pasted token belongs to is connected, and its repositories become watchable.
#[tauri::command]
async fn github_connect_token(app: AppHandle, core: State<'_, CoreState>, token: String) -> Result<ConnectionInfo> {
    let connected = core.github_connect_token(&token).await?;
    watch_changed(&app, &connected.id);
    Ok(connected)
}

/// Runs `gh auth token` now, because the person asked, and connects with what it prints.
#[tauri::command]
async fn github_import_gh_token(app: AppHandle, core: State<'_, CoreState>) -> Result<ConnectionInfo> {
    let connected = core.github_import_gh_token().await?;
    watch_changed(&app, &connected.id);
    Ok(connected)
}

/// Which ways of connecting GitHub work here: the device flow needs a client id, `gh` must be installed.
#[tauri::command]
fn github_sign_in_options(core: State<'_, CoreState>) -> auth::SignInOptions {
    core.code_sign_in_options()
}

/// Starts the device flow: show `userCode` and open `verificationUri`, then call `github_device_poll`.
#[tauri::command]
async fn github_device_start(core: State<'_, CoreState>) -> Result<DeviceStart> {
    core.github_device_start().await
}

/// Resolves when the code was authorised (or fails when it expired or was denied).
#[tauri::command]
async fn github_device_poll(app: AppHandle, core: State<'_, CoreState>) -> Result<ConnectionInfo> {
    let connected = core.github_device_poll().await?;
    watch_changed(&app, &connected.id);
    Ok(connected)
}

#[tauri::command]
async fn github_disconnect(app: AppHandle, core: State<'_, CoreState>, connection_id: String) -> Result<()> {
    core.github_disconnect(&connection_id).await?;
    watch_changed(&app, &connection_id);
    Ok(())
}

/// The pull requests, branches and commits that name a work item, from the cache. Instant; only watched repositories.
#[tauri::command]
fn dev_links(core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<DevLink>> {
    core.dev_links(&item)
}

/// Searches the watched repositories for the item's key, caches what it finds, and returns the links.
#[tauri::command]
async fn dev_links_live(app: AppHandle, core: State<'_, CoreState>, item: ItemRef) -> Result<Vec<DevLink>> {
    let (links, changed) = core.dev_links_live(&item).await?;
    changed.iter().for_each(|id| dev_links_changed(&app, id));
    Ok(links)
}

/// Pull request and notification events of the GitHub connections, newest first, for the Activity feed.
#[tauri::command]
fn code_events(core: State<'_, CoreState>, limit: Option<usize>) -> Result<Vec<Event>> {
    core.code_events(limit.unwrap_or(EVENT_LIMIT))
}

#[tauri::command]
async fn code_pull_request(core: State<'_, CoreState>, reference: CodeRef) -> Result<PullRequestDetail> {
    core.code_pull_request(&reference).await
}

#[tauri::command]
async fn code_search(core: State<'_, CoreState>, query: String) -> Result<Vec<CodeChange>> {
    core.code_search(&query).await
}

#[tauri::command]
async fn code_file(core: State<'_, CoreState>, connection_id: String, repo: String, path: String, reference: Option<String>) -> Result<CodeFile> {
    core.code_file(&connection_id, &repo, &path, reference.as_deref()).await
}

#[tauri::command]
async fn code_tree(core: State<'_, CoreState>, connection_id: String, repo: String, path: String, reference: Option<String>) -> Result<Vec<TreeEntry>> {
    core.code_tree(&connection_id, &repo, &path, reference.as_deref()).await
}

/// Commits of a branch or ref, newest first. `since` is RFC 3339; `query` filters by message text such as a ticket key.
#[tauri::command]
async fn code_commits(
    core: State<'_, CoreState>,
    connection_id: String,
    repo: String,
    reference: Option<String>,
    since: Option<String>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<CodeChange>> {
    let since = since
        .map(|s| chrono::DateTime::parse_from_rfc3339(&s).map(|d| d.with_timezone(&chrono::Utc)).map_err(|_| Error::Api { status: 400, message: format!("not a valid time: {s}") }))
        .transpose()?;
    core.code_commits(&connection_id, &CommitQuery { repo, reference, since, path: None, text: query, limit: limit.unwrap_or(0) }).await
}

/// GitHub code search, limited to watched repositories (all of them when `repos` is left out).
#[tauri::command]
async fn code_search_code(core: State<'_, CoreState>, connection_id: String, query: String, repos: Option<Vec<String>>) -> Result<Vec<CodeHit>> {
    core.code_search_code(&connection_id, &query, repos.as_deref()).await
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
    /// The session to continue for this ticket, when Pip can resume it.
    last: Option<String>,
}

#[tauri::command]
async fn claude_sessions(core: State<'_, CoreState>, key: String) -> Result<ClaudeSessions> {
    Ok(ClaudeSessions { last: core.claude_session_for(&key).await? })
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
                        if synced.watch_changed {
                            watch_changed(&app, &synced.connection_id);
                        }
                    }
                    Err(e) => core.set_error(Some(e.to_string())),
                }
                publish(&app, &core).await;
            }
            for (connection_id, result) in core.sync_code_if_due(trigger).await {
                // A failure shows on the connection's own row. It can follow repositories that were stored, so what
                // the page reads from the cache is refreshed either way.
                match result {
                    Ok(synced) => {
                        if synced.changed {
                            cache_changed(&app, &connection_id);
                        }
                        if synced.links_changed {
                            dev_links_changed(&app, &connection_id);
                        }
                    }
                    Err(_) => {
                        cache_changed(&app, &connection_id);
                        dev_links_changed(&app, &connection_id);
                    }
                }
                publish(&app, &core).await;
            }
            // A failed check is tried again at the next interval; nothing depends on it.
            if let Ok(Some((connection_id, strays))) = core.radar_if_due().await {
                assigned_elsewhere(&app, &connection_id, &strays);
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
            let registry = tracker::Registry::jira(http.clone(), auth.clone());
            let data_dir = app.path().app_data_dir()?;
            if let Err(e) = legacy::adopt_legacy_data(&data_dir) {
                eprintln!("couldn't move data from the previous app name, starting fresh: {e}");
            }
            let code = inbox::CodeService::new(http.clone(), inbox::CodeService::default_store());
            let core: CoreState = Arc::new(Core::new(auth, registry, data_dir).with_code(code));
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
            peek_item,
            watch_get,
            watch_set_mode,
            watch_set_containers,
            watch_catalog,
            watch_suggestions,
            watch_unwatched_assigned,
            watch_dismiss_assigned,
            cache_workflow,
            cache_events,
            cache_feed,
            cache_feed_unread,
            cache_me,
            cache_people,
            cache_comments,
            cache_transitions,
            connections_list,
            dev_links,
            dev_links_live,
            code_events,
            code_pull_request,
            code_search,
            code_file,
            code_tree,
            code_commits,
            code_search_code,
            github_connect_token,
            github_import_gh_token,
            github_sign_in_options,
            github_device_start,
            github_device_poll,
            github_disconnect,
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
