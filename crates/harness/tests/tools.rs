mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use harness::driver::{Capabilities, Command, Driver, Launch, Link, OpenError};
use harness::event::Body;
use harness::session::{Harness, Open, Settings};
use harness::store::Store;
use harness::tools::{MAX_BODY, ToolSpec, ToolsEndpoint, post};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

/// What a start was given: its endpoint, its token and its result schema.
type Given = (ToolsEndpoint, String, Option<Value>);

/// A driver whose agent says it started and then waits to be stopped. It keeps what each start was given.
#[derive(Clone, Default)]
struct Recorder {
    launches: Arc<Mutex<Vec<Given>>>,
}

impl Driver for Recorder {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let provider_session = launch.resume.clone().unwrap_or_else(|| format!("rec-{}", harness::driver::random_hex(4)));
        self.launches.lock().unwrap().push((launch.tools.clone(), launch.tools_token.expose().to_owned(), launch.result_schema.clone()));
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        output.send(Body::Started { provider_session, resumed: launch.resume.is_some() }).unwrap();
        tokio::spawn(async move {
            while let Some(command) = commands_rx.recv().await {
                if matches!(command, Command::Stop | Command::Kill) {
                    break;
                }
            }
            drop(output);
        });
        Ok(Link { commands, output: receiver, process: None })
    }
}

impl Recorder {
    fn last(&self) -> Given {
        self.launches.lock().unwrap().last().cloned().expect("a start")
    }
}

/// Sessions run as Claude, so `Launch` carries Claude's allowed names, with a shell that is captured already.
fn recording(dir: &std::path::Path, settings: Settings) -> (Harness, Recorder) {
    let recorder = Recorder::default();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("claude".into(), Arc::new(recorder.clone()))];
    (Harness::with_setup(Store::open(dir).unwrap(), drivers, settings, Arc::new(shell(dir))), recorder)
}

fn shell(dir: &std::path::Path) -> harness::work::Setup {
    harness::work::Setup::new(None, dir.to_owned()).with_shell_env(harness::env::RunEnv::from_pairs([("PATH", "/usr/bin:/bin")]))
}

fn spec() -> Open {
    Open { provider: "claude".into(), cwd: "/nowhere".into(), tools: tools(), ..Open::default() }
}

/// The endpoint's port and path.
fn place(endpoint: &ToolsEndpoint) -> (u16, String) {
    let rest = endpoint.url.strip_prefix("http://127.0.0.1:").expect("on loopback");
    let (port, path) = rest.split_once('/').unwrap();
    (port.parse().unwrap(), format!("/{path}"))
}

fn rpc(method: &str, params: Value) -> Vec<u8> {
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string().into_bytes()
}

/// How long a test waits for an answer that must come: only a failure waits this long.
const ANSWER_WITHIN: Duration = Duration::from_secs(30);

async fn ping(port: u16, path: &str, token: &str) -> (u16, Vec<u8>) {
    let (bearer, body) = (format!("Bearer {token}"), rpc("ping", json!({})));
    tokio::time::timeout(ANSWER_WITHIN, post(port, path, &[("authorization", &bearer)], &body)).await.expect("an answer within the wait").unwrap()
}

async fn call(port: u16, path: &str, token: &str, name: &str, input: Value) -> (u16, Value) {
    let (bearer, body) = (format!("Bearer {token}"), rpc("tools/call", json!({ "name": name, "arguments": input })));
    let (status, body) = tokio::time::timeout(ANSWER_WITHIN, post(port, path, &[("authorization", &bearer)], &body)).await.expect("an answer within the wait").unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// Sends `request` as it is and reads the answer until the connection closes.
async fn raw(port: u16, request: &[u8]) -> String {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut answer = vec![];
    let _ = tokio::time::timeout(Duration::from_secs(30), stream.read_to_end(&mut answer)).await.expect("an answer and a close within 30 s");
    String::from_utf8_lossy(&answer).into_owned()
}

fn status_of(answer: &str) -> &str {
    answer.split(' ').nth(1).unwrap_or_default()
}

#[tokio::test]
async fn tools_endpoint_binds_loopback_only_and_each_session_has_its_own_path() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (_a, _ea) = harness.open(spec()).await.unwrap();
    let (a, _, _) = recorder.last();
    let (_b, _eb) = harness.open(spec()).await.unwrap();
    let (b, _, _) = recorder.last();
    assert!(a.url.starts_with("http://127.0.0.1:") && a.url.ends_with(&format!("/mcp/{}", a.name)));
    assert_eq!(place(&a).0, place(&b).0, "one listener");
    assert_ne!(a.name, b.name);
    // An address of this machine that is not loopback, if it has one, does not reach the listener.
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    if probe.connect("192.0.2.1:9").is_ok()
        && let Ok(local) = probe.local_addr()
        && !local.ip().is_loopback()
        && !local.ip().is_unspecified()
    {
        let refused = tokio::time::timeout(Duration::from_secs(5), tokio::net::TcpStream::connect((local.ip(), place(&a).0))).await;
        assert!(!matches!(refused, Ok(Ok(_))), "the endpoint answered on a non-loopback address");
    }
}

#[tokio::test]
async fn tools_endpoint_a_token_opens_only_its_own_session_and_dies_when_it_closes_or_is_resumed() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (a_id, mut a_events) = harness.open(spec()).await.unwrap();
    let (a, a_token) = { let (e, t, _) = recorder.last(); (e, t) };
    let (b_id, mut b_events) = harness.open(spec()).await.unwrap();
    let (b, b_token) = { let (e, t, _) = recorder.last(); (e, t) };
    let ((port, a_path), (_, b_path)) = (place(&a), place(&b));
    assert_eq!(ping(port, &a_path, &a_token).await.0, 200);
    assert_eq!(ping(port, &b_path, &b_token).await.0, 200);
    assert_eq!(ping(port, &b_path, &a_token).await.0, 404, "a token opens only its own session");
    assert_eq!(ping(port, &a_path, &b_token).await.0, 404);

    harness.close(&a_id).unwrap();
    until(&mut a_events, |body| matches!(*body, Body::Closed { .. })).await;
    assert_eq!(ping(port, &a_path, &a_token).await.0, 404, "closed with its session");
    assert_eq!(ping(port, &b_path, &b_token).await.0, 200, "another session is not touched");

    harness.close(&b_id).unwrap();
    until(&mut b_events, |body| matches!(*body, Body::Closed { .. })).await;
    let _resumed = harness.resume(&b_id).await.unwrap();
    let (again, new_token) = { let (e, t, _) = recorder.last(); (e, t) };
    assert_eq!(again.name, b.name, "a resume serves the same name");
    assert_ne!(new_token, b_token, "with a new token");
    assert_eq!(ping(port, &b_path, &b_token).await.0, 404, "the old token is refused after a resume");
    assert_eq!(ping(port, &b_path, &new_token).await.0, 200);
}

#[tokio::test]
async fn tools_endpoint_a_client_token_is_refused_and_looks_like_any_wrong_token() {
    let (_tmp, dir) = data_dir();
    let recorder = Recorder::default();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("claude".into(), Arc::new(recorder.clone()))];
    let client_token = harness::auth::Token::random();
    let first = client_token.clone();
    let server = harness::server::Server::bind_with(&dir, move || Some(first), drivers, Settings::default(), shell(&dir)).unwrap();
    let task = tokio::spawn(server.run());
    let mut client = harness::client::Client::connect(&dir, &client_token).await.unwrap();
    let open = harness::api::Op::Open {
        provider: "claude".into(),
        cwd: Some("/nowhere".into()),
        repo: None,
        base: None,
        branch: None,
        locked: false,
        model: None,
        login: None,
        effort: None,
        permissions: Default::default(),
        ends_with_client: false,
        tools: tools(),
        result_schema: None,
    };
    client.call(open).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    assert_eq!(ping(port, &path, &token).await.0, 200);
    let wrong = ping(port, &path, &harness::driver::random_hex(32)).await;
    assert_eq!(wrong.0, 404);
    assert_eq!(ping(port, &path, &client_token.hex()).await, wrong, "a client token is refused like any wrong one");
    task.abort();
}

#[tokio::test]
async fn tools_endpoint_a_request_from_a_web_page_or_for_another_host_is_refused_over_http() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (_id, _events) = harness.open(spec()).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    let body = rpc("ping", json!({}));
    let request = |host: Option<String>, origin: Option<&str>| {
        let mut head = format!("POST {path} HTTP/1.1\r\n");
        if let Some(host) = host {
            head.push_str(&format!("host: {host}\r\n"));
        }
        if let Some(origin) = origin {
            head.push_str(&format!("origin: {origin}\r\n"));
        }
        head.push_str(&format!("authorization: Bearer {token}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()));
        [head.into_bytes(), body.clone()].concat()
    };
    let here = format!("127.0.0.1:{port}");
    assert_eq!(status_of(&raw(port, &request(Some(here.clone()), None)).await), "200");
    assert_eq!(status_of(&raw(port, &request(Some(format!("localhost:{port}")), Some("http://localhost:5173"))).await), "200");
    for origin in ["https://evil.example", "http://evil.example", "null"] {
        let answer = raw(port, &request(Some(here.clone()), Some(origin))).await;
        assert_eq!(status_of(&answer), "403", "a web page at {origin}");
    }
    // DNS rebinding: a page's own name pointed at loopback reaches the port, under that name.
    for host in [format!("evil.example:{port}"), format!("127.0.0.1:{}", port.wrapping_add(1)), "127.0.0.1".to_owned()] {
        let answer = raw(port, &request(Some(host.clone()), None)).await;
        assert_eq!(status_of(&answer), "403", "Host {host}");
    }
    let no_host = raw(port, &request(None, None)).await;
    assert!(["400", "403"].contains(&status_of(&no_host)), "no Host: {}", status_of(&no_host));
    assert!(!raw(port, &request(Some("evil.example".into()), Some("https://evil.example"))).await.contains(&token), "a refusal never echoes the token");
}

#[tokio::test]
async fn tools_endpoint_an_unknown_name_a_closed_session_a_wrong_token_and_no_token_look_the_same() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (closed_id, mut closed_events) = harness.open(spec()).await.unwrap();
    let (closed, closed_token, _) = recorder.last();
    harness.close(&closed_id).unwrap();
    until(&mut closed_events, |body| matches!(*body, Body::Closed { .. })).await;
    let (_id, _events) = harness.open(spec()).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    let wrong = harness::driver::random_hex(32);
    let answers = [
        ("an unknown name", ping(port, "/mcp/nosuchname0000", &token).await),
        ("a closed session", ping(port, &place(&closed).1, &closed_token).await),
        ("a wrong token", ping(port, &path, &wrong).await),
        ("no token", post(port, &path, &[], &rpc("ping", json!({}))).await.unwrap()),
        ("another path", ping(port, "/elsewhere", &token).await),
    ];
    for (what, answer) in &answers {
        assert_eq!(*answer, (404, vec![]), "{what}");
    }
    let get = raw(port, format!("GET {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n").as_bytes()).await;
    let get_unknown = raw(port, format!("GET /mcp/nosuchname0000 HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n").as_bytes()).await;
    assert_eq!(status_of(&get), "405", "no event stream is offered");
    assert_eq!(status_of(&get_unknown), "405", "on any path, so a GET says nothing of a session");
}

#[tokio::test]
async fn tools_endpoint_declared_tools_are_listed_and_each_call_is_an_event_the_client_answers() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (id, mut events) = harness.open(spec()).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    assert_eq!(endpoint.tools, ["choose", "read_ticket", "result", "ask"]);
    let exact = |tool: &str| format!("mcp__{}__{tool}", endpoint.name);
    assert_eq!(endpoint.allowed, [exact("choose"), exact("read_ticket"), exact("result"), exact("ask")], "exact names for Claude");
    let (port, path) = place(&endpoint);
    let (status, listed) = post(port, &path, &[("authorization", &format!("Bearer {token}"))], &rpc("tools/list", json!({}))).await.unwrap();
    let listed: Value = serde_json::from_slice(&listed).unwrap();
    assert_eq!(status, 200);
    let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["choose", "read_ticket", "result", "ask"]);
    assert_eq!(listed["result"]["tools"][1]["inputSchema"], json!({"type": "object"}));

    let calling = tokio::spawn(async move { call(port, &path, &token, "read_ticket", json!({"key": "T-1"})).await });
    let seen = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let Body::ClientToolCall { id: call_id, name, input } = &seen.last().unwrap().body else { unreachable!() };
    assert_eq!((name.as_str(), input), ("read_ticket", &json!({"key": "T-1"})));
    harness.tool_result(&id, call_id, json!({"title": "T"}), false).unwrap();
    let (status, answer) = calling.await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(answer["result"]["isError"], false);
    assert_eq!(serde_json::from_str::<Value>(answer["result"]["content"][0]["text"].as_str().unwrap()).unwrap(), json!({"title": "T"}));
    until(&mut events, |body| matches!(body, Body::ToolResult { .. })).await;

    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    let (_, unknown) = call(port, &path, &token, "delete_everything", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32602, "a tool the client did not declare is not called");
    quiet(&mut events, 100).await;
}

#[tokio::test]
async fn tools_endpoint_declared_a_call_with_no_client_listening_fails_at_once_and_is_recorded() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (id, events) = harness.open(spec()).await.unwrap();
    drop(events);
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    let (status, answer) = tokio::time::timeout(Duration::from_secs(10), call(port, &path, &token, "choose", json!({}))).await.expect("it fails at once, it does not wait for a client");
    assert_eq!(status, 200);
    assert_eq!(answer["result"]["isError"], true);
    assert_eq!(answer["result"]["content"][0]["text"], harness::session::CLIENT_AWAY);
    let stored = harness.events(&id, 0).unwrap();
    assert_eq!(types(&stored)[1..], ["client_tool_call", "tool_result"], "a later client sees the call and why it failed");
}

#[tokio::test]
async fn tools_endpoint_calls_past_the_cap_fail_with_the_reason_and_no_event() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings { tool_calls: 2, ..Settings::default() });
    let (id, events) = harness.open(spec()).await.unwrap();
    drop(events);
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    for _ in 0..2 {
        call(port, &path, &token, "choose", json!({})).await;
    }
    let before = harness.events(&id, 0).unwrap().len();
    let (_, answer) = call(port, &path, &token, "choose", json!({})).await;
    assert_eq!(answer["result"]["isError"], true);
    assert!(answer["result"]["content"][0]["text"].as_str().unwrap().contains("the 2 calls it may make"), "{answer}");
    assert_eq!(harness.events(&id, 0).unwrap().len(), before, "a refused call reaches no one");
}

#[tokio::test]
async fn tools_endpoint_limits_a_body_too_large_an_input_too_large_and_too_many_in_flight() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (id, mut events) = harness.open(spec()).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    let bearer = format!("Bearer {token}");

    // Over the body limit: 413 with the reason, once the token holds; before that nothing is read.
    let huge = vec![b' '; MAX_BODY + 1];
    let (status, answer) = post(port, &path, &[("authorization", &bearer)], &huge).await.unwrap();
    assert_eq!(status, 413);
    assert!(String::from_utf8_lossy(&answer).contains("limit of a call"));
    assert_eq!(post(port, &path, &[], &huge).await.map(|(status, _)| status).unwrap_or(404), 404);

    // An input over the event cap reaches the client cut, and the call fails with the reason.
    let big = "x".repeat(harness::event::EVENT_MAX + 1000);
    let (_, answer) = call(port, &path, &token, "choose", json!({ "text": big })).await;
    assert_eq!(answer["result"]["isError"], true);
    assert!(answer["result"]["content"][0]["text"].as_str().unwrap().contains("limit of an event"), "{answer}");
    let seen = until(&mut events, |body| matches!(body, Body::ToolResult { .. })).await;
    let called = seen.iter().find(|event| event.body.type_name() == "client_tool_call").expect("the client is told of the call");
    assert!(called.cut.is_some() || matches!(called.body, Body::Withheld { .. }), "and that it was cut");

    // Calls in flight for one session: past the cap, 429 with the reason.
    let held: Vec<_> = (0..harness::tools::IN_FLIGHT)
        .map(|_| {
            let (path, token) = (path.clone(), token.clone());
            tokio::spawn(async move { call(port, &path, &token, "choose", json!({})).await })
        })
        .collect();
    for _ in 0..harness::tools::IN_FLIGHT {
        until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    }
    let (status, answer) = call(port, &path, &token, "choose", json!({})).await;
    assert_eq!(status, 429);
    assert!(answer["error"]["message"].as_str().unwrap().contains("calls in flight"), "{answer}");
    harness.close(&id).unwrap();
    for call in held {
        assert_eq!(call.await.unwrap().1["result"]["content"][0]["text"], "the session has ended");
    }
}

#[tokio::test]
async fn tools_endpoint_limits_past_the_connection_cap_a_connection_is_closed_at_once() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (_id, _events) = harness.open(spec()).await.unwrap();
    let (port, _) = place(&recorder.last().0);
    // These wait for their headers, each holding a slot; the listener takes connections in the order they came.
    let mut idle = vec![];
    for _ in 0..harness::tools::MAX_CONNECTIONS {
        idle.push(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap());
    }
    let mut over = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut read = [0u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(5), over.read(&mut read)).await.expect("closed at once, not after the header limit");
    assert!(matches!(closed, Ok(0) | Err(_)), "{closed:?}");
    // One under the cap still waits for its headers: it was not closed with the one past it.
    let mut first = idle.remove(0);
    first.write_all(format!("GET / HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nconnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut answered = String::new();
    first.read_to_string(&mut answered).await.unwrap();
    assert_eq!(status_of(&answered), "405");
}

#[tokio::test]
async fn tools_endpoint_limits_a_connection_that_sends_nothing_is_closed_after_the_header_limit() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (_id, _events) = harness.open(spec()).await.unwrap();
    let (port, _) = place(&recorder.last().0);
    let mut silent = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let started = Instant::now();
    let mut read = [0u8; 64];
    let limit = harness::tools::HEADERS_WITHIN + Duration::from_secs(20);
    let ended = tokio::time::timeout(limit, silent.read(&mut read)).await.expect("the harness closes a silent connection");
    assert!(matches!(ended, Ok(0) | Err(_)), "closed, not answered: {ended:?}");
    assert!(started.elapsed() >= harness::tools::HEADERS_WITHIN - Duration::from_millis(500), "not before the limit");
}

#[tokio::test]
async fn tools_endpoint_survive_a_restart_the_name_tools_and_result_schema_with_a_new_token() {
    let (_tmp, dir) = data_dir();
    let schema = json!({"type": "object", "required": ["verdict"]});
    let (id, endpoint, token) = {
        let (harness, recorder) = recording(&dir, Settings::default());
        let (id, mut events) = harness.open(Open { result_schema: Some(schema.clone()), ..spec() }).await.unwrap();
        let (endpoint, token, given) = recorder.last();
        assert_eq!(given, Some(schema.clone()), "the schema reaches the driver");
        harness.close(&id).unwrap();
        until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
        (id, endpoint, token)
    };
    let (harness, recorder) = recording(&dir, Settings::default());
    let _events = harness.resume(&id).await.unwrap();
    let (again, new_token, given) = recorder.last();
    assert_eq!((again.name.as_str(), &again.tools, &again.allowed), (endpoint.name.as_str(), &endpoint.tools, &endpoint.allowed));
    assert_eq!(given, Some(schema));
    assert_ne!(new_token, token);
    let (port, path) = place(&again);
    assert_eq!(ping(port, &path, &token).await.0, 404, "the token of the start before the restart is refused");
    assert_eq!(ping(port, &path, &new_token).await.0, 200);
}

#[tokio::test]
async fn tools_endpoint_what_open_refuses_of_the_tools_and_the_schema() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let tool = |name: &str| ToolSpec { name: name.into(), description: String::new(), input_schema: json!({"type": "object"}) };
    let refused = [
        vec![tool("result")],
        vec![tool("ask")],
        vec![tool("a b")],
        vec![tool("")],
        vec![tool(&"x".repeat(harness::tools::TOOL_NAME_MAX + 1))],
        vec![tool("twice"), tool("twice")],
        vec![ToolSpec { input_schema: json!("string"), ..tool("odd") }],
        (0..=harness::tools::MAX_TOOLS).map(|n| tool(&format!("t{n}"))).collect(),
    ];
    for tools in refused {
        let open = harness.open(Open { tools: tools.clone(), ..spec() }).await;
        assert!(matches!(open, Err(harness::error::Error::Refused(_))), "{:?}", tools.iter().map(|t| &t.name).collect::<Vec<_>>());
    }
    let token = (harness::redact::SHAPES.iter().find(|shape| shape.name == "GitHub token").expect("a shape of that name").example)();
    let holding = ToolSpec { description: format!("call it with {token}"), ..tool("leaky") };
    let open = harness.open(Open { tools: vec![holding], ..spec() }).await;
    assert!(matches!(open, Err(harness::error::Error::Refused(why)) if why.contains("looks like a secret")), "a declaration that holds a secret is not kept");
    let open = harness.open(Open { result_schema: Some(json!({"type": "object", "default": {"key": token}})), ..spec() }).await;
    assert!(matches!(open, Err(harness::error::Error::Refused(_))), "nor a schema that does");
    let open = harness.open(Open { result_schema: Some(json!([1])), ..spec() }).await;
    assert!(matches!(open, Err(harness::error::Error::Refused(_))), "a schema is an object");
    assert!(recorder.launches.lock().unwrap().is_empty(), "no refused open started an agent");
    assert!(harness.sessions().unwrap().is_empty(), "or made a row");
    let longest = tool(&"y".repeat(harness::tools::TOOL_NAME_MAX));
    harness.open(Open { tools: vec![longest], ..spec() }).await.expect("the longest name opens");
    let (endpoint, _, _) = recorder.last();
    assert!(endpoint.allowed.iter().all(|full| full.len() <= 64), "every full name fits a provider's 64: {:?}", endpoint.allowed);
    for provider in harness::provider::Provider::ALL {
        let full = provider.own_tool_names(&endpoint.name, &endpoint.tools);
        assert!(full.iter().all(|name| name.len() <= 64), "{provider:?}: {full:?}");
    }
}

#[tokio::test]
async fn tools_endpoint_the_token_is_in_no_event_store_or_output() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/scripts/client-tool.jsonl")).unwrap());
    let harness = harness(&dir, &mock, 4);
    let (id, events) = harness.open(Open { provider: "mock".into(), cwd: "/nowhere".into(), tools: tools(), ..Open::default() }).await.unwrap();
    let client = mock.client();
    let mut printed = vec![];
    let followed = harness::run::drive(&harness, &id, events, client, vec![], Some("read T-1".into()), |event| printed.push(serde_json::to_string(event).unwrap())).await;
    assert!(followed);
    let started = harness.events(&id, 0).unwrap();
    let Body::Started { provider_session, .. } = &started[0].body else { panic!() };
    let token = mock.tokens(provider_session).pop().unwrap();
    assert!(printed.iter().any(|line| line.contains("client_tool_call")), "the call went through");
    assert!(!printed.iter().any(|line| line.contains(&token)), "no event holds the token");
    let on_disk = bytes_on_disk(&dir);
    assert!(!on_disk.windows(token.len()).any(|window| window == token.as_bytes()), "no file of the store holds it");
}

#[tokio::test]
async fn tools_endpoint_harness_run_prints_the_call_the_clients_answer_and_what_the_mock_received() {
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_harness"))
        .args(["run", "--provider", "mock", "--script", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/scripts/client-tool.jsonl"), "read T-1"])
        .env_remove("HARNESS_DATA")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()).await.expect("`harness run` ended within 60 s").unwrap();
    assert!(out.status.success(), "exit {:?}", out.status.code());
    let lines: Vec<Value> = String::from_utf8(out.stdout.clone()).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let at = |kind: &str, id_prefix: &str| lines.iter().position(|line| line["type"] == kind && line["id"].as_str().is_some_and(|id| id.starts_with(id_prefix)));
    let (called, answered, received) = (at("client_tool_call", "c").unwrap(), at("tool_result", "c").unwrap(), at("tool_result", "t").unwrap());
    assert!(called < answered && answered < received, "the call, the client's answer, then what the mock received");
    let title = json!({"key": "T-1", "title": "Fix the login page"});
    assert_eq!((&lines[answered]["output"], &lines[received]["output"]), (&title, &title));
    // A tools token is 64 hex digits; nothing printed has one.
    let text = [out.stdout, out.stderr].concat();
    let hex_run = text.split(|b| !b.is_ascii_hexdigit()).map(<[u8]>::len).max().unwrap_or(0);
    assert!(hex_run < 64, "no token in the output");
}

/// A session with `schema` and the place and token of its endpoint, with its events.
async fn with_schema(dir: &std::path::Path, schema: Option<Value>) -> (Harness, String, tokio::sync::broadcast::Receiver<harness::event::Event>, u16, String, String) {
    let (harness, recorder) = recording(dir, Settings::default());
    let (id, events) = harness.open(Open { result_schema: schema, ..spec() }).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    (harness, id, events, port, path, token)
}

fn verdict() -> Value {
    json!({"type": "object", "properties": {"verdict": {"type": "string", "enum": ["pass", "fail"]}}, "required": ["verdict"], "additionalProperties": false})
}

#[tokio::test]
async fn tools_endpoint_result_is_listed_with_the_sessions_schema_as_its_input() {
    let (_tmp, dir) = data_dir();
    for schema in [Some(verdict()), None] {
        let (_harness, _id, _events, port, path, token) = with_schema(&dir.join(schema.is_some().to_string()), schema.clone()).await;
        let (_, listed) = post(port, &path, &[("authorization", &format!("Bearer {token}"))], &rpc("tools/list", json!({}))).await.unwrap();
        let listed: Value = serde_json::from_slice(&listed).unwrap();
        let result = listed["result"]["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == "result").cloned().expect("result is listed");
        assert_eq!(result["inputSchema"], schema.unwrap_or_else(|| json!({"type": "object"})));
    }
}

#[tokio::test]
async fn tools_endpoint_result_that_fits_is_a_result_event_and_the_agent_is_told() {
    let (_tmp, dir) = data_dir();
    let (harness, id, mut events, port, path, token) = with_schema(&dir, Some(verdict())).await;
    let (_, answer) = call(port, &path, &token, "result", json!({"verdict": "pass"})).await;
    assert_eq!(answer["result"]["isError"], false, "{answer}");
    assert_eq!(answer["result"]["content"][0]["text"], "the result was recorded");
    let seen = until(&mut events, |body| matches!(body, Body::Result { .. })).await;
    assert_eq!(seen.last().unwrap().body, Body::Result { data: json!({"verdict": "pass"}) });
    assert_eq!(harness.events(&id, 0).unwrap().last().unwrap().body, Body::Result { data: json!({"verdict": "pass"}) }, "it is stored");
}

#[tokio::test]
async fn tools_endpoint_result_that_does_not_fit_goes_back_to_the_agent_with_the_reason_and_no_event() {
    let (_tmp, dir) = data_dir();
    let (harness, id, mut events, port, path, token) = with_schema(&dir, Some(verdict())).await;
    let (_, answer) = call(port, &path, &token, "result", json!({"verdict": "maybe", "extra": 1})).await;
    assert_eq!(answer["result"]["isError"], true);
    let reason = answer["result"]["content"][0]["text"].as_str().unwrap();
    assert!(reason.starts_with("the result does not fit its schema, so it was not taken"), "{reason}");
    assert!(reason.contains("at /verdict: is not one of the values the schema lists") && reason.contains("at /extra: is not a property the schema allows"), "{reason}");
    let (_, fits) = call(port, &path, &token, "result", json!({"verdict": "fail"})).await;
    assert_eq!(fits["result"]["isError"], false, "the agent can call it again");
    until(&mut events, |body| matches!(body, Body::Result { .. })).await;
    let results = harness.events(&id, 0).unwrap().into_iter().filter(|event| event.body.type_name() == "result").count();
    assert_eq!(results, 1, "the misfit made no event");
}

#[tokio::test]
async fn tools_endpoint_result_schema_refused_at_open_with_the_keyword_and_nothing_starts() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    for (schema, said) in [(json!({"type": "object", "properties": {"a": {"pattern": "x"}}}), "/properties/a: `pattern`"), (json!({"type": "string"}), "top level")] {
        match harness.open(Open { result_schema: Some(schema), ..spec() }).await {
            Err(harness::error::Error::Refused(why)) => assert!(why.contains(said), "{why}"),
            other => panic!("not refused: {:?}", other.map(|(id, _)| id)),
        }
    }
    assert!(recorder.launches.lock().unwrap().is_empty() && harness.sessions().unwrap().is_empty(), "no agent and no row");
}

/// A driver that asks a question as soon as it starts, and keeps it open.
#[derive(Clone, Default)]
struct Asker(Recorder);

impl Driver for Asker {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let Link { commands, output, .. } = self.0.open(launch)?;
        let (relay, receiver) = mpsc::unbounded_channel();
        let mut output = output;
        tokio::spawn(async move {
            if let Some(started) = output.recv().await {
                let _ = relay.send(started);
                let _ = relay.send(Body::Question { id: "q1".into(), text: "which colour?".into() });
            }
            while let Some(body) = output.recv().await {
                let _ = relay.send(body);
            }
        });
        Ok(Link { commands, output: receiver, process: None })
    }
}

#[tokio::test]
async fn tools_endpoint_result_is_refused_while_a_question_is_open() {
    let (_tmp, dir) = data_dir();
    let asker = Asker::default();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("claude".into(), Arc::new(asker.clone()))];
    let harness = Harness::with_setup(Store::open(&dir).unwrap(), drivers, Settings::default(), Arc::new(shell(&dir)));
    let (id, mut events) = harness.open(spec()).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Question { .. })).await;
    let (endpoint, token, _) = asker.0.last();
    let (port, path) = place(&endpoint);
    let (_, answer) = call(port, &path, &token, "result", json!({"done": true})).await;
    assert_eq!(answer["result"]["isError"], true);
    assert_eq!(answer["result"]["content"][0]["text"], "a question is open (q1): wait for its answer, then give your result");
    assert!(!harness.events(&id, 0).unwrap().iter().any(|event| event.body.type_name() == "result"), "no result event");
    harness.answer_question(&id, "q1", "blue".into()).await.unwrap();
    let (_, answer) = call(port, &path, &token, "result", json!({"done": true})).await;
    assert_eq!(answer["result"]["isError"], false, "taken once the question is answered: {answer}");
}

#[tokio::test]
async fn tools_endpoint_result_over_the_event_cap_is_refused_with_the_reason_and_no_event() {
    let (_tmp, dir) = data_dir();
    let (harness, id, _events, port, path, token) = with_schema(&dir, None).await;
    let big = "x".repeat(harness::event::EVENT_MAX + 1000);
    let (_, answer) = call(port, &path, &token, "result", json!({ "text": big })).await;
    assert_eq!(answer["result"]["isError"], true);
    assert!(answer["result"]["content"][0]["text"].as_str().unwrap().contains("limit of an event, so it was not taken"), "{answer}");
    assert!(!harness.events(&id, 0).unwrap().iter().any(|event| ["result", "withheld"].contains(&event.body.type_name().as_str())), "no cut result is stored");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tools_endpoint_limits_calls_waiting_on_their_clients_never_shut_another_session_out() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    // More sessions, each with all its calls waiting, than there are slots for connections still proving a token.
    let busy = harness::tools::MAX_CONNECTIONS / harness::tools::IN_FLIGHT + 1;
    let (mut held, mut kept) = (vec![], vec![]);
    for _ in 0..busy {
        let (id, mut events) = harness.open(spec()).await.unwrap();
        let (endpoint, token, _) = recorder.last();
        let (port, path) = place(&endpoint);
        for _ in 0..harness::tools::IN_FLIGHT {
            let (path, token) = (path.clone(), token.clone());
            held.push(tokio::spawn(async move { call(port, &path, &token, "choose", json!({})).await }));
        }
        for _ in 0..harness::tools::IN_FLIGHT {
            until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
        }
        kept.push((id, events));
    }
    let (_free, _events) = harness.open(spec()).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    assert_eq!(ping(port, &path, &token).await.0, 200, "{} calls wait, and another session's agent still gets in", busy * harness::tools::IN_FLIGHT);
    for (id, _) in &kept {
        harness.close(id).unwrap();
    }
    for call in held {
        assert_eq!(call.await.unwrap().1["result"]["content"][0]["text"], "the session has ended");
    }
}

#[tokio::test]
async fn tools_endpoint_result_with_no_schema_takes_any_object_and_nothing_else() {
    let (_tmp, dir) = data_dir();
    let (harness, id, _events, port, path, token) = with_schema(&dir, None).await;
    for not_an_object in [json!("done"), json!([1]), json!(3)] {
        let (_, answer) = call(port, &path, &token, "result", not_an_object.clone()).await;
        assert_eq!(answer["result"]["isError"], true, "{not_an_object}");
        assert!(answer["result"]["content"][0]["text"].as_str().unwrap().contains("at /: expected object"), "{answer}");
    }
    let (_, answer) = call(port, &path, &token, "result", json!({"anything": [1, {}]})).await;
    assert_eq!(answer["result"]["isError"], false);
    assert_eq!(harness.events(&id, 0).unwrap().iter().filter(|event| event.body.type_name() == "result").count(), 1);
}

#[tokio::test]
async fn tools_endpoint_result_each_one_taken_is_an_event_in_order() {
    let (_tmp, dir) = data_dir();
    let (harness, id, mut events, port, path, token) = with_schema(&dir, Some(verdict())).await;
    for verdict in ["fail", "pass"] {
        call(port, &path, &token, "result", json!({ "verdict": verdict })).await;
        until(&mut events, |body| matches!(body, Body::Result { .. })).await;
    }
    let results: Vec<Body> = harness.events(&id, 0).unwrap().into_iter().map(|event| event.body).filter(|body| matches!(body, Body::Result { .. })).collect();
    assert_eq!(results, [Body::Result { data: json!({"verdict": "fail"}) }, Body::Result { data: json!({"verdict": "pass"}) }], "the last one counts");
}

#[tokio::test]
async fn tools_endpoint_result_a_stored_schema_the_harness_cannot_check_is_not_resumed() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (id, mut events) = harness.open(Open { result_schema: Some(verdict()), ..spec() }).await.unwrap();
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
    // As a row from before the check could hold it.
    let old = json!({"type": "object", "properties": {"verdict": {"pattern": "^p"}}}).to_string();
    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute("UPDATE sessions SET result_schema = ?1", [old]).unwrap();
    let starts = recorder.launches.lock().unwrap().len();
    match harness.resume(&id).await {
        Err(harness::error::Error::Refused(why)) => assert!(why.contains("`pattern`") && why.contains("not resumed"), "{why}"),
        other => panic!("resumed: {:?}", other.is_ok()),
    }
    assert_eq!(recorder.launches.lock().unwrap().len(), starts, "no agent started");
}

/// A token shape the harness masks, from its own list.
fn secret() -> String {
    (harness::redact::SHAPES.iter().find(|shape| shape.name == "GitHub token").expect("a shape of that name").example)()
}

#[tokio::test]
async fn tools_endpoint_result_is_masked_before_it_is_kept_and_refused_when_masked_it_no_longer_fits() {
    let (_tmp, dir) = data_dir();
    let long = json!({"type": "object", "properties": {"key": {"type": "string", "minLength": 30}}});
    let (harness, id, mut events, port, path, token) = with_schema(&dir, Some(long)).await;
    let (_, answer) = call(port, &path, &token, "result", json!({ "key": secret() })).await;
    assert_eq!(answer["result"]["isError"], true, "masked, it is too short for its schema");
    assert!(answer["result"]["content"][0]["text"].as_str().unwrap().contains("masked it does not fit its schema"), "{answer}");
    let (_, answer) = call(port, &path, &token, "result", json!({ "key": "a key long enough to fit its schema", "note": secret() })).await;
    assert_eq!(answer["result"]["isError"], false, "{answer}");
    let seen = until(&mut events, |body| matches!(body, Body::Result { .. })).await;
    let Body::Result { data } = &seen.last().unwrap().body else { unreachable!() };
    assert!(!data.to_string().contains(&secret()), "the kept result holds no secret: {data}");
    assert_eq!(harness.events(&id, 0).unwrap().iter().filter(|event| event.body.type_name() == "result").count(), 1);
}

#[tokio::test]
async fn tools_endpoint_result_of_a_locked_session_reaches_its_client_whole_and_is_withheld_in_the_store() {
    let (_tmp, dir) = data_dir();
    let (harness, recorder) = recording(&dir, Settings::default());
    let (id, mut events) = harness.open(Open { locked: true, ..spec() }).await.unwrap();
    let (endpoint, token, _) = recorder.last();
    let (port, path) = place(&endpoint);
    call(port, &path, &token, "result", json!({"verdict": "private text"})).await;
    let seen = until(&mut events, |body| matches!(body, Body::Result { .. })).await;
    assert_eq!(seen.last().unwrap().body, Body::Result { data: json!({"verdict": "private text"}) }, "the client gets it whole");
    let stored = harness.events(&id, 0).unwrap().pop().unwrap();
    assert!(matches!(&stored.body, Body::Withheld { of, kept } if of == "result" && kept.is_empty()), "{:?}", stored.body);
}

#[tokio::test]
async fn tools_endpoint_declared_a_locked_sessions_client_that_fell_behind_is_away_and_the_call_fails_at_once() {
    let (_tmp, dir) = data_dir();
    // The four events before the call fill the client's backlog, so sending the call drops the client.
    let script = "{\"prompt\": null}\n{\"call\": {\"name\": \"choose\", \"input\": {}}}\n{\"end\": \"done\"}\n{\"prompt\": null}";
    let mock = mock(script);
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, Settings { locked_backlog: 4, ..Settings::default() });
    let (id, events, _feed) = harness.open_watched(Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), tools: tools(), ..Open::default() }).unwrap();
    drop(events);
    harness.send(&id, "go").unwrap();
    let given = Instant::now() + ANSWER_WITHIN;
    let ps = loop {
        if let Some(Body::Withheld { kept, .. }) = harness.events(&id, 0).unwrap().first().map(|event| event.body.clone()) {
            break kept["provider_session"].as_str().unwrap().to_owned();
        }
        assert!(Instant::now() < given, "the session started within the wait");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    while mock.replies(&ps).is_empty() {
        assert!(Instant::now() < given, "the call failed within the wait, not held for a client that is gone");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(mock.replies(&ps), [Ok(harness::tools::Reply::failed(harness::session::CLIENT_AWAY))]);
}
