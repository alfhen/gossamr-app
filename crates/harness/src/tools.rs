//! The tools endpoint: one MCP server on loopback (streamable HTTP, JSON answers only), with an endpoint per session
//! at `/mcp/<name>`. The name is drawn at random for the session and kept with it; the token is new for every start of
//! it and kept only as its hash. A call of a tool the client declared becomes a `client_tool_call` event that the
//! client answers.
//!
//! What a caller learns: a request for another host or from a web page is refused (403) before anything else is
//! looked at, and an unknown name, a session that is not running, a wrong token and no token all get the same 404 with
//! no body, so nothing says which part was wrong. A body is read only once the token holds.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use http::{HeaderMap, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::{Semaphore, oneshot};

use crate::driver::Secret;
use crate::error::{Error, Result};
use crate::mcp::{Answer, ServerInfo, bearer, local_request, message, rpc};

/// The characters of an endpoint name: what every provider keeps as it is in a server key and a tool name.
const NAME_FIRST: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const NAME_REST: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
/// A letter, then 13 letters or digits: log2(26) + 13 log2(36), about 72 bits.
pub const NAME_LEN: usize = 14;

/// The most tools a client declares for a session, and the most bytes their definitions take as JSON.
pub const MAX_TOOLS: usize = 64;
pub const MAX_TOOLS_BYTES: usize = 256 << 10;
/// The most bytes a result schema takes as JSON.
pub const MAX_SCHEMA_BYTES: usize = 64 << 10;
/// Names the harness keeps for its own tools.
pub const RESERVED: &[&str] = &["result", "ask"];

/// The most bytes of a request body. A call's input over `event::EVENT_MAX` but under this reaches the client cut, and
/// fails with the reason; one over this is refused with 413.
pub const MAX_BODY: usize = 4 << 20;
/// Headers, all together. hyper takes no less than 8 KiB.
const MAX_HEADERS: usize = 16 << 10;
/// How long a connection has to send its headers, and then its body.
pub const HEADERS_WITHIN: Duration = Duration::from_secs(10);
pub const BODY_WITHIN: Duration = Duration::from_secs(30);
/// Connections open at once, held calls among them. One past it is closed at once.
pub const MAX_CONNECTIONS: usize = 64;
/// Calls of one session in flight at once.
pub const IN_FLIGHT: usize = 8;

const SERVER: ServerInfo<'static> = ServerInfo { name: "harness", version: crate::VERSION };

/// A tool the client offers a session. The harness knows nothing of what it does: each call is the client's to answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSpec {
    /// Letters, digits, `_` and `-`, at most 64.
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// A JSON Schema object for the input, as MCP's `inputSchema`. Left out, any object.
    #[serde(default = "any_object")]
    pub input_schema: Value,
}

fn any_object() -> Value {
    json!({ "type": "object" })
}

impl ToolSpec {
    fn listed(&self) -> Value {
        json!({ "name": self.name, "description": self.description, "inputSchema": self.input_schema })
    }
}

/// What `open` refuses of the tools a client declares and of a result schema, with the reason.
pub fn check_tools(tools: &[ToolSpec], result_schema: Option<&Value>) -> Result<()> {
    let refused = |why: String| Err(Error::Refused(why));
    if tools.len() > MAX_TOOLS {
        return refused(format!("a session takes at most {MAX_TOOLS} tools"));
    }
    let mut names = HashSet::new();
    for tool in tools {
        let name = &tool.name;
        if name.is_empty() || name.len() > 64 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return refused("a tool's name is 1 to 64 letters, digits, `_` and `-`".into());
        }
        if RESERVED.contains(&name.as_str()) {
            return refused(format!("`{name}` is the harness's own tool"));
        }
        if !names.insert(name) {
            return refused(format!("two tools are named `{name}`"));
        }
        if !tool.input_schema.is_object() {
            return refused(format!("the input schema of `{name}` is not a JSON object"));
        }
    }
    if serde_json::to_string(tools)?.len() > MAX_TOOLS_BYTES {
        return refused(format!("the tools take more than {MAX_TOOLS_BYTES} bytes"));
    }
    if let Some(schema) = result_schema {
        if !schema.is_object() {
            return refused("a result schema is a JSON object".into());
        }
        if serde_json::to_string(schema)?.len() > MAX_SCHEMA_BYTES {
            return refused(format!("a result schema takes at most {MAX_SCHEMA_BYTES} bytes"));
        }
    }
    Ok(())
}

/// A new endpoint name from the operating system's secure source.
pub fn endpoint_name() -> String {
    name_from(|bytes| getrandom::fill(bytes).expect("the operating system has a secure random source"))
}

/// An endpoint name from the random bytes `fill` gives. Each character takes a byte below the largest multiple of its
/// alphabet's size, so every character is as likely as any other.
pub fn name_from(mut fill: impl FnMut(&mut [u8])) -> String {
    let mut name = String::with_capacity(NAME_LEN);
    let mut buf = [0u8; 32];
    let mut at = buf.len();
    while name.len() < NAME_LEN {
        if at == buf.len() {
            fill(&mut buf);
            at = 0;
        }
        let alphabet = if name.is_empty() { NAME_FIRST } else { NAME_REST };
        let byte = buf[at] as usize;
        at += 1;
        if byte < 256 - 256 % alphabet.len() {
            name.push(alphabet[byte % alphabet.len()] as char);
        }
    }
    name
}

/// A call of a client tool, on its way to the session.
pub(crate) struct ToolCall {
    pub name: String,
    pub input: Value,
    pub reply: oneshot::Sender<Reply>,
}

/// What a call gets back: the client's output, or the harness's reason it failed, with `error` set.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub output: Value,
    pub error: bool,
}

impl Reply {
    pub fn failed(reason: impl Into<String>) -> Reply {
        Reply { output: Value::String(reason.into()), error: true }
    }

    /// As MCP's `CallToolResult`: a string goes as it is, anything else as its JSON text.
    fn result(&self) -> Value {
        let text = match &self.output {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        json!({ "content": [{ "type": "text", "text": text }], "isError": self.error })
    }

    /// The reply a `CallToolResult` carries, as the agent reads it: text that is JSON is taken as JSON.
    fn read(result: &Value) -> Option<Reply> {
        let text = result["content"][0]["text"].as_str()?;
        let output = serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()));
        Some(Reply { output, error: result["isError"].as_bool().unwrap_or(false) })
    }
}

/// What a driver hands its agent: where the session's tools are, the name it serves them under, their names, and the
/// exact full names the harness allows by itself on this session's provider. The token is `Launch::tools_token`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolsEndpoint {
    pub url: String,
    /// The per-session name: the server's key in the agent's MCP configuration.
    pub name: String,
    /// The names of the tools it serves.
    pub tools: Vec<String>,
    /// For the session's provider, the exact names a driver lets through without asking the person: never a prefix.
    pub allowed: Vec<String>,
    port: u16,
}

impl ToolsEndpoint {
    /// An endpoint that belongs to no session: every call fails. For driving a driver on its own.
    pub fn unattached() -> ToolsEndpoint {
        ToolsEndpoint { url: "http://127.0.0.1:1/mcp/none".into(), name: "none".into(), tools: vec![], allowed: vec![], port: 1 }
    }

    /// Calls a tool over HTTP, as an agent does: one `tools/call` with `token`. An error says why no answer came; a
    /// reply the harness failed is an error reply, as the agent reads it.
    pub async fn call(&self, token: &str, name: &str, input: Value) -> std::result::Result<Reply, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": name, "arguments": input } }).to_string();
        let path = format!("/mcp/{}", self.name);
        let (status, answer) = post(self.port, &path, &[("authorization", &format!("Bearer {token}"))], body.as_bytes()).await.map_err(|e| e.to_string())?;
        let answer: Value = serde_json::from_slice(&answer).map_err(|_| format!("the endpoint answered {status} with no JSON-RPC reply"))?;
        if let Some(error) = answer.get("error") {
            return Err(error["message"].as_str().unwrap_or("the endpoint refused the call").to_owned());
        }
        Reply::read(&answer["result"]).ok_or_else(|| "the endpoint's reply has no text".to_owned())
    }
}

/// One POST to the endpoint on `port` with `headers` besides Host and the body's, and the status and body of the
/// answer.
pub async fn post(port: u16, path: &str, headers: &[(&str, &str)], body: &[u8]) -> std::io::Result<(u16, Vec<u8>)> {
    let mut request = format!("POST {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\ncontent-type: application/json\r\naccept: application/json, text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n", body.len());
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(request.as_bytes()).await?;
    stream.write_all(body).await?;
    let mut answer = vec![];
    stream.take(MAX_BODY as u64 * 2).read_to_end(&mut answer).await?;
    let bad = || std::io::Error::new(std::io::ErrorKind::InvalidData, "not an HTTP answer");
    let split = answer.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(bad)?;
    let status = std::str::from_utf8(&answer[..split]).ok().and_then(|head| head.split(' ').nth(1)?.parse().ok()).ok_or_else(bad)?;
    Ok((status, answer[split + 4..].to_vec()))
}

/// The endpoint of one start of a session.
struct Entry {
    start: u64,
    hash: [u8; 32],
    calls: UnboundedSender<ToolCall>,
    tools: Arc<Vec<ToolSpec>>,
    in_flight: Arc<Semaphore>,
    made: Arc<AtomicU64>,
}

struct State {
    port: u16,
    /// By endpoint name.
    entries: Mutex<HashMap<String, Entry>>,
    /// Calls each session has made, over all its starts while this harness runs.
    made: Mutex<HashMap<String, Arc<AtomicU64>>>,
    call_cap: u32,
}

impl State {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The listener and the endpoints on it. Dropping it stops serving.
pub(crate) struct Endpoints {
    state: Arc<State>,
    serving: tokio::task::JoinHandle<()>,
}

impl Drop for Endpoints {
    fn drop(&mut self) {
        self.serving.abort();
    }
}

impl Endpoints {
    /// Listens on a free port of 127.0.0.1, and nowhere else. Needs a Tokio runtime.
    pub fn bind(call_cap: u32) -> Result<Endpoints> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(State { port, entries: Mutex::default(), made: Mutex::default(), call_cap });
        let serving = tokio::spawn(serve(listener, state.clone()));
        Ok(Endpoints { state, serving })
    }

    /// Serves `name` for this start of `session` with `token`, in place of any start before it, and gives what a driver
    /// hands the agent, with the names allowed on `provider`: none for one not in the table.
    pub fn register(&self, name: &str, (session, start): (&str, u64), token: &Secret, tools: Vec<ToolSpec>, calls: UnboundedSender<ToolCall>, provider: &str) -> ToolsEndpoint {
        let names: Vec<String> = tools.iter().map(|tool| tool.name.clone()).collect();
        let made = self.state.made.lock().unwrap_or_else(|p| p.into_inner()).entry(session.to_owned()).or_default().clone();
        let entry = Entry {
            start,
            hash: Sha256::digest(token.expose()).into(),
            calls,
            tools: Arc::new(tools),
            in_flight: Arc::new(Semaphore::new(IN_FLIGHT)),
            made,
        };
        self.state.entries().insert(name.to_owned(), entry);
        let allowed = crate::provider::Provider::named(provider).map(|p| p.own_tool_names(name, &names)).unwrap_or_default();
        ToolsEndpoint { url: format!("http://127.0.0.1:{}/mcp/{name}", self.state.port), name: name.to_owned(), tools: names, allowed, port: self.state.port }
    }

    /// Stops serving `name` if it is still this start's: its token is refused from now on.
    pub fn forget(&self, name: &str, start: u64) {
        let mut entries = self.state.entries();
        if entries.get(name).is_some_and(|entry| entry.start == start) {
            entries.remove(name);
        }
    }
}

async fn serve(listener: tokio::net::TcpListener, state: Arc<State>) {
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let Ok(slot) = connections.clone().try_acquire_owned() else { continue };
        let state = state.clone();
        tokio::spawn(async move {
            let _slot = slot;
            let service = hyper::service::service_fn(move |request| handle(state.clone(), request));
            let mut http = hyper::server::conn::http1::Builder::new();
            // One request per connection: a connection that waits for another holds no slot.
            http.timer(TokioTimer::new()).header_read_timeout(HEADERS_WITHIN).max_buf_size(MAX_HEADERS).keep_alive(false);
            let _ = http.serve_connection(TokioIo::new(stream), service).await;
        });
    }
}

type Answered = Response<Full<Bytes>>;

fn answer(status: StatusCode, body: Option<Value>) -> Answered {
    let json = body.is_some();
    let mut response = Response::new(Full::new(body.map(|body| Bytes::from(body.to_string())).unwrap_or_default()));
    *response.status_mut() = status;
    if json {
        response.headers_mut().insert("content-type", http::HeaderValue::from_static("application/json"));
    }
    response
}

/// A JSON-RPC error with no id, for a request the harness cut before it could read one.
fn cut(status: StatusCode, reason: String) -> Answered {
    answer(status, Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": reason } })))
}

async fn handle(state: Arc<State>, request: Request<Incoming>) -> std::result::Result<Answered, Infallible> {
    if request.method() != Method::POST {
        // No event stream is offered, on any path, so this says nothing of a session.
        let mut refused = answer(StatusCode::METHOD_NOT_ALLOWED, None);
        refused.headers_mut().insert("allow", http::HeaderValue::from_static("POST"));
        return Ok(refused);
    }
    if !local_request(request.headers(), state.port) {
        return Ok(answer(StatusCode::FORBIDDEN, None));
    }
    let Some(entry) = request.uri().path().strip_prefix("/mcp/").and_then(|name| opened(&state, name, request.headers())) else {
        return Ok(answer(StatusCode::NOT_FOUND, None));
    };
    let Ok(_held) = entry.in_flight.clone().try_acquire_owned() else {
        return Ok(cut(StatusCode::TOO_MANY_REQUESTS, format!("this session has {IN_FLIGHT} calls in flight already: wait for one")));
    };
    let body = match tokio::time::timeout(BODY_WITHIN, Limited::new(request.into_body(), MAX_BODY).collect()).await {
        Ok(Ok(body)) => body.to_bytes(),
        Ok(Err(e)) if e.is::<http_body_util::LengthLimitError>() => {
            return Ok(cut(StatusCode::PAYLOAD_TOO_LARGE, format!("the request is over the {MAX_BODY}-byte limit of a call")));
        }
        Ok(Err(_)) => return Ok(answer(StatusCode::BAD_REQUEST, None)),
        Err(_) => return Ok(cut(StatusCode::REQUEST_TIMEOUT, format!("the request's body did not come within {} s", BODY_WITHIN.as_secs()))),
    };
    let msg = match message(&body) {
        Ok(msg) => msg,
        Err(status) => return Ok(answer(status, None)),
    };
    let params = msg["params"].clone();
    let tools = entry.tools.clone();
    let listed = move || tools.iter().map(ToolSpec::listed).collect();
    let answered = rpc(msg, SERVER, listed, call(&state, &entry, &params)).await;
    Ok(match answered {
        Answer::Accepted => answer(StatusCode::ACCEPTED, None),
        Answer::Reply(reply) => answer(StatusCode::OK, Some(reply)),
    })
}

/// What a running session's endpoint needs for a request, if `name` is one and the request's token is its start's.
struct Opened {
    calls: UnboundedSender<ToolCall>,
    tools: Arc<Vec<ToolSpec>>,
    in_flight: Arc<Semaphore>,
    made: Arc<AtomicU64>,
}

fn opened(state: &State, name: &str, headers: &HeaderMap) -> Option<Opened> {
    let given: [u8; 32] = Sha256::digest(bearer(headers)?).into();
    let entries = state.entries();
    let entry = entries.get(name)?;
    if !bool::from(entry.hash.ct_eq(&given)) {
        return None;
    }
    Some(Opened { calls: entry.calls.clone(), tools: entry.tools.clone(), in_flight: entry.in_flight.clone(), made: entry.made.clone() })
}

async fn call(state: &State, entry: &Opened, params: &Value) -> std::result::Result<Value, Value> {
    let name = params["name"].as_str().unwrap_or_default();
    if !entry.tools.iter().any(|tool| tool.name == name) {
        return Err(json!({ "code": -32602, "message": "Unknown tool" }));
    }
    let input = match &params["arguments"] {
        Value::Null => json!({}),
        input => input.clone(),
    };
    // 64 bits never wrap, so a refused call can count too.
    if entry.made.fetch_add(1, Ordering::Relaxed) >= u64::from(state.call_cap) {
        return Ok(Reply::failed(format!("this session has made the {} calls it may make to these tools", state.call_cap)).result());
    }
    let (reply, answer) = oneshot::channel();
    let ended = || Reply::failed("the session has ended");
    let reply = match entry.calls.send(ToolCall { name: name.to_owned(), input, reply }) {
        Ok(()) => answer.await.unwrap_or_else(|_| ended()),
        Err(_) => ended(),
    };
    Ok(reply.result())
}
