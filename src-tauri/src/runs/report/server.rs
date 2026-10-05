//! The loopback server a run's session reaches the tool through, and the per-run config file that points it there.
//!
//! The listener holds one capability: `ReportSink::call`, which stores a validated report on one run. It reads no
//! tickets and runs no tracker or code client, and what it answers contains none of the arguments it was given.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::{definition, token_hash, well_formed, Reply};
use crate::domain::{REPORT_SERVER, REPORT_TOOL};

/// A report is a few thousand characters; a plan up to 24,000, which is under 100 KB as UTF-8.
const BODY_LIMIT: usize = 128 * 1024;
const IN_FLIGHT: usize = 4;
const PORT_FILE: &str = "port";

/// Stores a call's report, if the token is the one minted for that run and the run is still open to it.
#[async_trait]
pub trait ReportSink: Send + Sync {
    async fn call(&self, run_id: &str, token_hash: &str, args: &Value) -> Reply;
}

/// What a launch needs to offer the tool to a session: the config file that names the server and carries the token.
#[derive(Clone, PartialEq, Eq)]
pub struct ReportLaunch {
    pub config: PathBuf,
}

impl std::fmt::Debug for ReportLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ReportLaunch({})", self.config.display())
    }
}

/// Where the server listens and where per-run config files are kept.
#[derive(Debug)]
pub struct ReportChannel {
    port: u16,
    dir: PathBuf,
}

fn plain_id(run_id: &str) -> bool {
    (1..=64).contains(&run_id.len()) && run_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl ReportChannel {
    pub fn new(port: u16, dir: PathBuf) -> Self {
        Self { port, dir }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url_for(&self, run_id: &str) -> String {
        format!("http://127.0.0.1:{}/report/{run_id}", self.port)
    }

    fn config_path(&self, run_id: &str) -> Option<PathBuf> {
        plain_id(run_id).then(|| self.dir.join(format!("{run_id}.json")))
    }

    /// Writes the run's MCP config where only this user can read it. The token goes in the file and nowhere on a command
    /// line: argv is visible to every process of the user. A second call for the same run replaces the file, and every
    /// token minted for the run stays valid on the server.
    pub fn write_config(&self, run_id: &str, token: &str) -> std::io::Result<ReportLaunch> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let path = self.config_path(run_id).ok_or_else(|| std::io::Error::other("not a run id"))?;
        std::fs::create_dir_all(&self.dir)?;
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))?;
        let config = json!({ "mcpServers": { REPORT_SERVER: { "type": "http", "url": self.url_for(run_id), "headers": { "Authorization": format!("Bearer {token}") } } } });
        let temp = path.with_extension("json.tmp");
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
        file.write_all(config.to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp, &path).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })?;
        Ok(ReportLaunch { config: path })
    }

    pub fn remove_config(&self, run_id: &str) {
        if let Some(path) = self.config_path(run_id) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// The runs that have a config file.
    pub fn configured(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        entries.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".json").filter(|id| plain_id(id)).map(str::to_owned)).collect()
    }
}

pub struct ReportServer {
    pub channel: Arc<ReportChannel>,
}

struct Serving {
    sink: Arc<dyn ReportSink>,
    port: u16,
    slots: Semaphore,
}

impl ReportServer {
    /// Binds loopback, on the port used last time when it is free so a session that outlives a restart still finds the
    /// server. A bind error is the caller's to log: nothing else depends on this server.
    pub async fn start(sink: Arc<dyn ReportSink>, dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let remembered = std::fs::read_to_string(dir.join(PORT_FILE)).ok().and_then(|s| s.trim().parse::<u16>().ok()).filter(|p| *p != 0);
        let listener = match remembered {
            Some(port) => match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                Ok(l) => l,
                Err(_) => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
            },
            None => tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?,
        };
        let port = listener.local_addr()?.port();
        if remembered != Some(port) {
            let _ = std::fs::write(dir.join(PORT_FILE), port.to_string());
        }
        let state = Arc::new(Serving { sink, port, slots: Semaphore::new(IN_FLIGHT) });
        let router = Router::new().route("/report/{run_id}", post(handle)).layer(DefaultBodyLimit::max(BODY_LIMIT)).with_state(state);
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self { channel: Arc::new(ReportChannel::new(port, dir)) })
    }
}

fn is_loopback_host(host: &str, port: u16) -> bool {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")].iter().any(|h| h.eq_ignore_ascii_case(host))
}

fn is_loopback_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else { return false };
    let host = rest.split([':', '/']).next().unwrap_or_default();
    host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost")
}

/// A browser page can be made to post here; the Host check stops DNS rebinding and an Origin that isn't loopback stops
/// the page itself. The CLI sends neither a foreign Host nor a foreign Origin.
fn local_request(headers: &HeaderMap, port: u16) -> bool {
    let host_ok = headers.get("host").and_then(|h| h.to_str().ok()).is_some_and(|h| is_loopback_host(h, port));
    let origin_ok = headers.get("origin").is_none_or(|o| o.to_str().is_ok_and(is_loopback_origin));
    host_ok && origin_ok
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").filter(|t| well_formed(t))
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

async fn handle(State(st): State<Arc<Serving>>, UrlPath(run_id): UrlPath<String>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(_slot) = st.slots.try_acquire() else { return StatusCode::TOO_MANY_REQUESTS.into_response() };
    if !local_request(&headers, st.port) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Only a missing or malformed bearer is a 401; a client that sees one for a legitimate session may start OAuth.
    let Some(token) = bearer(&headers) else { return StatusCode::UNAUTHORIZED.into_response() };
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else { return StatusCode::BAD_REQUEST.into_response() };
    if !msg.is_object() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(id) = msg.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => Ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "gossamr-run-report", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": [definition()] })),
        "tools/call" => Ok(call(&st, &run_id, token, &msg["params"]).await),
        _ => Err(json!({ "code": -32601, "message": "Method not found" })),
    };
    let reply = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    };
    axum::Json(reply).into_response()
}

async fn call(st: &Serving, run_id: &str, token: &str, params: &Value) -> Value {
    if params["name"].as_str() != Some(REPORT_TOOL) {
        return tool_result("Unknown tool.", true);
    }
    let reply = if plain_id(run_id) { st.sink.call(run_id, &token_hash(token), &params["arguments"]).await } else { Reply::Unavailable };
    let (text, is_error) = reply.text();
    tool_result(&text, is_error)
}

/// The folder per-run config files live in, under the app's data folder.
pub fn config_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("report")
}
