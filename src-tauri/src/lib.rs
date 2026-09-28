mod adf;
mod auth;
mod db;
mod error;
mod events;
mod inbox;
mod jira;
mod model;
mod secrets;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use auth::{Auth, AuthStatus, OAuthApp};
use inbox::Core;
use error::{Error, Result};
use model::{Snapshot, Transition};

const POLL_INTERVAL: Duration = Duration::from_secs(60);

type CoreState = Arc<Core>;

/// Sends the latest snapshot to the window. Failures only mean there is nothing to show yet (e.g. signed out).
async fn publish(app: &AppHandle, core: &Core) {
    if let Ok(snap) = core.snapshot().await {
        let _ = app.emit("snapshot", snap);
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
async fn sign_out(core: State<'_, CoreState>) -> Result<()> {
    core.auth.sign_out().await?;
    core.close_db();
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
    core.transitions(&key).await
}

#[tauri::command]
async fn transition(app: AppHandle, core: State<'_, CoreState>, key: String, transition_id: String) -> Result<()> {
    core.transition(&key, &transition_id).await?;
    publish(&app, &core).await;
    Ok(())
}

#[tauri::command]
async fn comment(app: AppHandle, core: State<'_, CoreState>, key: String, body: String) -> Result<()> {
    core.comment(&key, &body).await?;
    publish(&app, &core).await;
    Ok(())
}

fn spawn_sync_loop(app: AppHandle, core: CoreState) {
    tauri::async_runtime::spawn(async move {
        loop {
            if core.auth.identity().await.is_some() {
                match core.sync().await {
                    Ok(_) => core.set_error(None),
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
        .setup(|app| {
            let http = reqwest::Client::builder()
                .user_agent(concat!("jira-inbox/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(30))
                .build()?;
            let auth = Arc::new(Auth::load(http.clone())?);
            let jira = jira::Jira::new(http, auth.clone());
            let core: CoreState = Arc::new(Core::new(auth, jira, app.path().app_data_dir()?));
            app.manage(core.clone());
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
            comment
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
