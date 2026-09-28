mod auth;
mod error;
mod secrets;

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use auth::{Auth, AuthStatus, OAuthApp};
use error::{Error, Result};

type AuthState = Arc<Auth>;

#[tauri::command]
async fn auth_status(auth: State<'_, AuthState>) -> Result<AuthStatus> {
    auth.status().await
}

#[tauri::command]
async fn save_oauth_app(auth: State<'_, AuthState>, client_id: String, client_secret: String) -> Result<AuthStatus> {
    auth.save_app(OAuthApp { client_id, client_secret })?;
    auth.status().await
}

#[tauri::command]
async fn sign_in(app: AppHandle, auth: State<'_, AuthState>) -> Result<AuthStatus> {
    auth.sign_in(|url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| Error::Auth(format!("couldn't open the browser: {e}")))
    })
    .await
}

#[tauri::command]
async fn sign_out(auth: State<'_, AuthState>) -> Result<()> {
    auth.sign_out().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let http = reqwest::Client::builder()
                .user_agent(concat!("jira-inbox/", env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage::<AuthState>(Arc::new(Auth::load(http)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![auth_status, save_oauth_app, sign_in, sign_out])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
