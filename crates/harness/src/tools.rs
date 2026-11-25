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

/// The longest name a declared tool may have. A provider takes a tool name of at most 64 characters (Anthropic's
/// API), and the longest full name is `mcp__<name>__<tool>`: 21 characters around it.
pub const TOOL_NAME_MAX: usize = 64 - NAME_LEN - 7;

/// The most tools a client declares for a session, and the most bytes their definitions take as JSON.
pub const MAX_TOOLS: usize = 64;
pub const MAX_TOOLS_BYTES: usize = 256 << 10;
/// The most bytes a result schema takes as JSON.
pub const MAX_SCHEMA_BYTES: usize = 64 << 10;
/// The harness's own tool the agent ends its work with.
pub const RESULT: &str = "result";
/// Names the harness keeps for its own tools.
pub const RESERVED: &[&str] = &[RESULT, "ask"];

/// The most bytes of a request body. A call's input over `event::EVENT_MAX` but under this reaches the client cut, and
/// fails with the reason; one over this is refused with 413.
pub const MAX_BODY: usize = 4 << 20;
/// How much of a body the harness reads, and throws away, before it refuses a caller that has not proven its token.
/// Closing a socket with data unread resets it, and the caller would not see the answer.
pub const REFUSED_BODY: usize = 64 << 10;
/// How long it reads a body it throws away.
const DISCARD_WITHIN: Duration = Duration::from_secs(1);
/// Headers, all together. hyper takes no less than 8 KiB.
const MAX_HEADERS: usize = 16 << 10;
/// How long a connection has to send its headers, and then its body.
pub const HEADERS_WITHIN: Duration = Duration::from_secs(10);
pub const BODY_WITHIN: Duration = Duration::from_secs(30);
/// Connections whose token has not held yet. One past it is closed at once. A connection leaves this count once its
/// token holds, so calls waiting on a client never take the slots other sessions' agents connect through; those are
/// held to `IN_FLIGHT` per session instead.
pub const MAX_CONNECTIONS: usize = 64;
/// How long the listener waits after an accept fails, as when the process is out of file descriptors.
const ACCEPT_AGAIN_AFTER: Duration = Duration::from_millis(50);
/// Calls of one session in flight at once.
pub const IN_FLIGHT: usize = 8;

const SERVER: ServerInfo<'static> = ServerInfo { name: "harness", version: crate::VERSION };

/// A tool the client offers a session. The harness knows nothing of what it does: each call is the client's to answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolSpec {
    /// Letters, digits, `_` and `-`, at most `TOOL_NAME_MAX`.
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
        if name.is_empty() || name.len() > TOOL_NAME_MAX || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return refused(format!("a tool's name is 1 to {TOOL_NAME_MAX} letters, digits, `_` and `-`"));
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
        if serde_json::to_string(schema)?.len() > MAX_SCHEMA_BYTES {
            return refused(format!("a result schema takes at most {MAX_SCHEMA_BYTES} bytes"));
        }
        crate::schema::check(schema).map_err(|why| Error::Refused(format!("the result schema: {why}")))?;
    }
    Ok(())
}

/// The `result` tool as `tools/list` shows it: its input is the result, so its schema is the result schema.
fn result_tool(schema: Option<&Value>) -> Value {
    json!({
        "name": RESULT,
        "description": "Give the result of your work when you are done. With a schema, the result must fit it; a result that does not fit comes back with the reasons, and you can call this again.",
        "inputSchema": schema.cloned().unwrap_or_else(any_object),
    })
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
    result_schema: Option<Arc<Value>>,
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
    /// hands the agent, with the names allowed on `provider`: none for one not in the table. It serves the client's
    /// `tools` and `result`, with `result_schema`.
    pub fn register(
        &self,
        name: &str,
        (session, start): (&str, u64),
        token: &Secret,
        (tools, result_schema): (Vec<ToolSpec>, Option<Value>),
        calls: UnboundedSender<ToolCall>,
        provider: &str,
    ) -> ToolsEndpoint {
        let names: Vec<String> = tools.iter().map(|tool| tool.name.clone()).chain([RESULT.to_owned()]).collect();
        let made = self.state.made.lock().unwrap_or_else(|p| p.into_inner()).entry(session.to_owned()).or_default().clone();
        let entry = Entry {
            start,
            hash: Sha256::digest(token.expose()).into(),
            calls,
            tools: Arc::new(tools),
            result_schema: result_schema.map(Arc::new),
            in_flight: Arc::new(Semaphore::new(IN_FLIGHT)),
            made,
        };
        self.state.entries().insert(name.to_owned(), entry);
        let allowed = crate::provider::Provider::named(provider).map(|p| p.own_tool_names(name, &names)).unwrap_or_default();
        ToolsEndpoint { url: format!("http://127.0.0.1:{}/mcp/{name}", self.state.port), name: name.to_owned(), tools: names, allowed, port: self.state.port }
    }

    #[cfg(test)]
    pub(crate) fn serves(&self, name: &str) -> bool {
        self.state.entries().contains_key(name)
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
        let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(ACCEPT_AGAIN_AFTER).await;
            continue;
        };
        let Ok(slot) = connections.clone().try_acquire_owned() else { continue };
        let state = state.clone();
        tokio::spawn(async move {
            let slot = Arc::new(Mutex::new(Some(slot)));
            let service = hyper::service::service_fn(move |request| handle(state.clone(), slot.clone(), request));
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

/// A connection's place among those whose token has not held yet.
type Unproven = Arc<Mutex<Option<tokio::sync::OwnedSemaphorePermit>>>;

async fn handle(state: Arc<State>, unproven: Unproven, request: Request<Incoming>) -> std::result::Result<Answered, Infallible> {
    let (head, body) = request.into_parts();
    let answered = answer_to(&state, &unproven, &head, body).await;
    Ok(answered)
}

async fn answer_to(state: &Arc<State>, unproven: &Unproven, head: &http::request::Parts, body: Incoming) -> Answered {
    if head.method != Method::POST {
        // No event stream is offered, on any path, so this says nothing of a session.
        let mut refused = answer(StatusCode::METHOD_NOT_ALLOWED, None);
        refused.headers_mut().insert("allow", http::HeaderValue::from_static("POST"));
        discard(body, REFUSED_BODY).await;
        return refused;
    }
    if !local_request(&head.headers, state.port) {
        discard(body, REFUSED_BODY).await;
        return answer(StatusCode::FORBIDDEN, None);
    }
    let Some(entry) = head.uri.path().strip_prefix("/mcp/").and_then(|name| opened(state, name, &head.headers)) else {
        discard(body, REFUSED_BODY).await;
        return answer(StatusCode::NOT_FOUND, None);
    };
    unproven.lock().unwrap_or_else(|p| p.into_inner()).take();
    let Ok(_held) = entry.in_flight.clone().try_acquire_owned() else {
        discard(body, REFUSED_BODY).await;
        return cut(StatusCode::TOO_MANY_REQUESTS, format!("this session has {IN_FLIGHT} calls in flight already: wait for one"));
    };
    let body = match tokio::time::timeout(BODY_WITHIN, read(body)).await {
        Ok(Some(body)) => body,
        Ok(None) => return cut(StatusCode::PAYLOAD_TOO_LARGE, format!("the request is over the {MAX_BODY}-byte limit of a call")),
        Err(_) => return cut(StatusCode::REQUEST_TIMEOUT, format!("the request's body did not come within {} s", BODY_WITHIN.as_secs())),
    };
    let msg = match message(&body) {
        Ok(msg) => msg,
        Err(status) => return answer(status, None),
    };
    let params = msg["params"].clone();
    let (tools, schema) = (entry.tools.clone(), entry.result_schema.clone());
    let listed = move || tools.iter().map(ToolSpec::listed).chain([result_tool(schema.as_deref())]).collect();
    match rpc(msg, SERVER, listed, call(state, &entry, &params)).await {
        Answer::Accepted => answer(StatusCode::ACCEPTED, None),
        Answer::Reply(reply) => answer(StatusCode::OK, Some(reply)),
    }
}

/// The body, or None when it is over `MAX_BODY`; then up to `MAX_BODY` more is read and thrown away, so the caller
/// gets the answer.
async fn read(mut body: Incoming) -> Option<Bytes> {
    let mut read = bytes::BytesMut::new();
    while let Some(frame) = body.frame().await {
        let Ok(data) = frame.map(|frame| frame.into_data().unwrap_or_default()) else { return Some(Bytes::new()) };
        if read.len() + data.len() > MAX_BODY {
            discard(body, MAX_BODY).await;
            return None;
        }
        read.extend_from_slice(&data);
    }
    Some(read.freeze())
}

/// Reads and drops up to `most` bytes of a body, for a second at most.
async fn discard(body: Incoming, most: usize) {
    let _ = tokio::time::timeout(DISCARD_WITHIN, Limited::new(body, most).collect()).await;
}

/// What a running session's endpoint needs for a request, if `name` is one and the request's token is its start's.
struct Opened {
    calls: UnboundedSender<ToolCall>,
    tools: Arc<Vec<ToolSpec>>,
    result_schema: Option<Arc<Value>>,
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
    Some(Opened { calls: entry.calls.clone(), tools: entry.tools.clone(), result_schema: entry.result_schema.clone(), in_flight: entry.in_flight.clone(), made: entry.made.clone() })
}

async fn call(state: &State, entry: &Opened, params: &Value) -> std::result::Result<Value, Value> {
    let name = params["name"].as_str().unwrap_or_default();
    if name != RESULT && !entry.tools.iter().any(|tool| tool.name == name) {
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
    let input = match name {
        // Off the async task: a large result against a large schema takes a while, and `serve` runs on one thread.
        RESULT => {
            let schema = entry.result_schema.clone().unwrap_or_else(|| Arc::new(any_object()));
            let checked = tokio::task::spawn_blocking(move || {
                let misfits = crate::schema::misfits(&schema, &input);
                (input, misfits)
            });
            let Ok((input, misfits)) = checked.await else { return Ok(Reply::failed("the harness could not check the result").result()) };
            if !misfits.is_empty() {
                return Ok(Reply::failed(format!("the result does not fit its schema, so it was not taken: {}", misfits.join("; "))).result());
            }
            input
        }
        _ => input,
    };
    let (reply, answer) = oneshot::channel();
    let ended = || Reply::failed("the session has ended");
    let reply = match entry.calls.send(ToolCall { name: name.to_owned(), input, reply }) {
        Ok(()) => answer.await.unwrap_or_else(|_| ended()),
        Err(_) => ended(),
    };
    Ok(reply.result())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bits a name of `NAME_LEN` characters carries when each is drawn evenly.
    fn bits() -> f64 {
        (NAME_FIRST.len() as f64).log2() + (NAME_LEN - 1) as f64 * (NAME_REST.len() as f64).log2()
    }

    #[test]
    fn tools_endpoint_a_name_is_letters_and_digits_with_at_least_64_bits() {
        assert!(bits() >= 64.0, "{} bits", bits());
        for _ in 0..200 {
            let name = endpoint_name();
            assert_eq!(name.len(), NAME_LEN);
            assert!(name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()), "letters and digits only, no `_` or `-`");
            assert!(name.as_bytes()[0].is_ascii_lowercase(), "it starts with a letter");
        }
    }

    #[test]
    fn tools_endpoint_a_name_is_drawn_at_random_so_no_counter_or_fixed_prefix_passes() {
        let names: Vec<String> = (0..2000).map(|_| endpoint_name()).collect();
        assert_eq!(names.iter().collect::<HashSet<_>>().len(), names.len(), "every name is new");
        // A counter or a fixed prefix keeps its first characters; drawn names spread every position over its alphabet.
        for at in 0..NAME_LEN {
            let seen: HashSet<u8> = names.iter().map(|name| name.as_bytes()[at]).collect();
            let alphabet = if at == 0 { NAME_FIRST.len() } else { NAME_REST.len() };
            assert!(seen.len() >= alphabet * 3 / 4, "position {at} took only {} of {alphabet} characters", seen.len());
        }
    }

    #[test]
    fn tools_endpoint_a_name_comes_from_its_random_source_evenly() {
        let zeros = name_from(|bytes| bytes.fill(0));
        assert_eq!(zeros, "a".to_owned() + &"a".repeat(NAME_LEN - 1));
        let mut n = 0u8;
        let counting = name_from(|bytes| bytes.iter_mut().for_each(|b| (*b, n) = (n, n.wrapping_add(1))));
        assert_eq!(&counting[..3], "abc", "each character is the source's byte, taken modulo its alphabet");
        // A byte at or past the largest multiple of the alphabet's size is passed over, so no character is likelier.
        let mut first = true;
        let skipped = name_from(|bytes| {
            bytes.fill(if first { 255 } else { 1 });
            first = false;
        });
        assert_eq!(skipped, "b".repeat(NAME_LEN));
    }

    #[test]
    fn tools_endpoint_a_reply_reads_back_as_the_agent_sees_it() {
        for reply in [Reply { output: json!({"title": "T"}), error: false }, Reply::failed("timed out after 200 ms"), Reply { output: json!("blue"), error: false }] {
            assert_eq!(Reply::read(&reply.result()), Some(reply));
        }
    }
}
