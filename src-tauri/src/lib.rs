mod adf;
mod auth;
mod claude;
mod db;
mod error;
mod events;
mod inbox;
mod jira;
mod legacy;
mod model;
mod notify;
mod secrets;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use auth::{Auth, AuthStatus, OAuthApp, Scope};
use claude::{AskRequest, Claude};
use inbox::Core;
use error::{Error, Result};
use model::{Snapshot, Transition};

const POLL_INTERVAL: Duration = Duration::from_secs(60);

type CoreState = Arc<Core>;
type ClaudeState = Arc<Claude>;

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
        .auth
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
    core.auth.sign_out().await?;
    core.close_db();
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
    mentions: Option<Vec<adf::MentionRef>>,
    files: Option<Vec<model::Uploaded>>,
) -> Result<()> {
    core.comment(&scope, &key, &body, &mentions.unwrap_or_default(), &files.unwrap_or_default()).await?;
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
async fn ask_claude(app: AppHandle, claude: State<'_, ClaudeState>, request: AskRequest) -> Result<()> {
    claude
        .ask(request, Arc::new(move |u| {
            let _ = app.emit("claude", u);
        }))
        .await
}

#[tauri::command]
fn cancel_claude(claude: State<'_, ClaudeState>, request_id: String) {
    claude.cancel(&request_id);
}

fn random_token() -> std::result::Result<String, getrandom::Error> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn spawn_sync_loop(app: AppHandle, core: CoreState) {
    tauri::async_runtime::spawn(async move {
        loop {
            if core.auth.identity().await.is_some() {
                match core.sync().await {
                    Ok(new) => {
                        core.set_error(None);
                        announce(&app, &new);
                    }
                    Err(e) => core.set_error(Some(e.to_string())),
                }
                publish(&app, &core).await;
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = core.wake.notified() => {}
            }
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
        .setup(|app| {
            let http = reqwest::Client::builder()
                .user_agent(concat!("gossamr/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(30))
                .build()?;
            let auth = Arc::new(Auth::load(http.clone()));
            let jira = jira::Jira::new(http, auth.clone());
            let data_dir = app.path().app_data_dir()?;
            if let Err(e) = legacy::adopt_legacy_data(&data_dir) {
                eprintln!("couldn't move data from the previous app name, starting fresh: {e}");
            }
            let core: CoreState = Arc::new(Core::new(auth, jira, data_dir));
            app.manage(core.clone());

            let handle = app.handle().clone();
            let token = random_token().map_err(|e| Error::Claude(format!("no randomness available: {e}")))?;
            let mcp = tauri::async_runtime::block_on(claude::mcp::McpServer::start(
                core.clone(),
                token,
                Arc::new(move |p| {
                    let _ = handle.emit("claude-proposal", p);
                }),
            ))?;
            app.manage::<ClaudeState>(Arc::new(Claude::new(core.clone(), mcp)));

            spawn_sync_loop(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            auth_status,
            save_oauth_app,
            sign_in,
            sign_out,
            snapshot,
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
