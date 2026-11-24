mod common;

use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use futures_util::{SinkExt, StreamExt};
use harness::api::{DESCRIPTOR, Descriptor, Hello, Op, PROTOCOL, Proof, SOCKET};
use harness::auth::{Token, decode, encode};
use harness::client::{Client, Push};
use harness::driver::Driver;
use harness::error::Error;
use harness::event::{Body, Decision, Event};
use harness::mock::Mock;
use harness::server::{Limits, Server};
use harness::session::Harness;
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio_tungstenite::tungstenite::Message;

/// How long a test waits for what must come. Only a failure waits this long; a big event's redaction under load can
/// take seconds.
const WAIT: Duration = Duration::from_secs(60);

/// Waits at a permission request, then plays a client tool call, a cancel and a second turn.
const SCRIPT: &str = r#"{"prompt": null}
{"say": "one"}
{"say": "two"}
{"permission": {"kind": "command", "tool": "Bash", "input": {"command": "ls"}}}
{"call": {"name": "read_ticket", "input": {"key": "T-1"}}}
{"end": "done"}
{"prompt": null}
"cancel"
{"end": "cancelled"}
{"prompt": null}"#;

struct Served {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    token: Token,
    mock: Mock,
    harness: Harness,
    task: tokio::task::JoinHandle<harness::error::Result<()>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn serve(script: &str) -> Served {
    serve_with(script, Limits::default())
}

fn serve_with(script: &str, limits: Limits) -> Served {
    serve_set(script, limits, settings(4))
}

fn serve_set(script: &str, limits: Limits, settings: harness::session::Settings) -> Served {
    let (tmp, dir) = data_dir();
    let (token, mock) = (Token::random(), common::mock(script));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    let first = token.clone();
    let server = Server::bind(&dir, move || Some(first), drivers, settings).unwrap().limits(limits);
    let harness = server.harness().clone();
    let task = tokio::spawn(server.run());
    Served { _tmp: tmp, dir, token, mock, harness, task }
}

async fn connect(served: &Served) -> Client {
    Client::connect(&served.dir, &served.token).await.unwrap()
}

async fn open(client: &mut Client) -> String {
    open_as(client, false, false).await
}

async fn open_as(client: &mut Client, locked: bool, ends_with_client: bool) -> String {
    let opened = client.call(Op::Open { provider: "mock".into(), cwd: "/nowhere".into(), locked, model: None, ends_with_client }).await.unwrap();
    opened["session"].as_str().unwrap().to_owned()
}

async fn next_event(client: &mut Client) -> Event {
    match tokio::time::timeout(WAIT, client.push()).await.expect("a push within the wait").unwrap() {
        Some(Push::Event { event, .. }) => event,
        other => panic!("expected an event, got {other:?}"),
    }
}

/// Events up to and including the first that `last` takes.
async fn events_until(client: &mut Client, last: impl Fn(&Body) -> bool) -> Vec<Event> {
    let mut seen = vec![];
    loop {
        let event = next_event(client).await;
        let done = last(&event.body);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

/// A raw WebSocket on the harness's socket, before any proof, and the hello it was given.
async fn raw(served: &Served) -> (tokio_tungstenite::WebSocketStream<UnixStream>, String) {
    let stream = UnixStream::connect(served.dir.join(SOCKET)).await.unwrap();
    let (mut ws, _) = tokio_tungstenite::client_async("ws://harness/", stream).await.unwrap();
    let Some(Ok(Message::Text(hello_text))) = ws.next().await else { panic!("no hello") };
    let hello: Hello = serde_json::from_str(hello_text.as_str()).unwrap();
    assert!(decode(&hello.challenge).is_some(), "a challenge is 32 bytes in hex");
    (ws, hello_text.as_str().to_owned())
}

/// What the harness says after a first message, until it closes the connection.
async fn after_first(mut ws: tokio_tungstenite::WebSocketStream<UnixStream>, first: Value) -> Vec<Value> {
    // The harness may close the connection before a large message is all sent.
    let _ = ws.send(Message::text(first.to_string())).await;
    // A call sent after a refused proof must not be served either.
    let _ = ws.send(Message::text(json!({ "id": 2, "op": "sessions" }).to_string())).await;
    let mut said = vec![];
    while let Ok(Some(Ok(message))) = tokio::time::timeout(WAIT, ws.next()).await {
        match message {
            Message::Text(text) => said.push(serde_json::from_str(text.as_str()).unwrap()),
            Message::Close(_) => break,
            _ => {}
        }
    }
    said
}

fn refused(said: &[Value]) -> bool {
    said.len() == 1 && said[0]["error"].as_str().is_some_and(|error| error.contains("did not prove a token")) && said[0].get("id").is_none()
}

#[tokio::test]
async fn auth_no_token_a_wrong_token_and_a_sessions_tools_token_are_refused() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    let Body::Started { provider_session, .. } = next_event(&mut client).await.body else { panic!("expected started") };
    let tools = Token::parse(&served.mock.tokens(&provider_session)[0]).expect("a tools token is 32 bytes in hex");

    let (ws, _) = raw(&served).await;
    let open_call = json!({ "id": 1, "op": "open", "provider": "mock", "cwd": "/nowhere" });
    assert!(refused(&after_first(ws, open_call).await), "a call with no proof");
    let (ws, _) = raw(&served).await;
    assert!(refused(&after_first(ws, json!({ "proof": "" })).await), "an empty proof");
    let (ws, hello) = raw(&served).await;
    let wrong = json!(Proof { proof: encode(&Token::random().answer(hello.as_bytes())) });
    assert!(refused(&after_first(ws, wrong).await), "a wrong token");
    let (ws, hello) = raw(&served).await;
    let of_tools = json!(Proof { proof: encode(&tools.answer(hello.as_bytes())) });
    assert!(refused(&after_first(ws, of_tools).await), "the session's tools token");
    let (ws, _) = raw(&served).await;
    let replayed = json!(Proof { proof: encode(&served.token.answer(hello.as_bytes())) });
    assert!(refused(&after_first(ws, replayed).await), "a right answer to another connection's hello");

    match Client::connect(&served.dir, &tools).await {
        Err(Error::Said(_)) => {}
        other => assert!(other.is_err(), "the client module is refused with the tools token too"),
    }
    let sessions = client.call(Op::Sessions).await.unwrap();
    assert_eq!(sessions.as_array().unwrap().len(), 1, "no refused client made a session");
    assert_eq!(sessions[0]["id"], id.as_str());
}

#[tokio::test]
async fn auth_token_new_without_a_valid_token_is_refused_and_adds_none() {
    let served = serve(SCRIPT);
    let (ws, _) = raw(&served).await;
    let new = Token::random();
    let call = json!({ "id": 1, "op": "token_new", "stored_key": encode(&new.stored_key()) });
    assert!(refused(&after_first(ws, call).await), "`token new` as the first message");
    let (ws, hello) = raw(&served).await;
    let wrong = json!(Proof { proof: encode(&Token::random().answer(hello.as_bytes())) });
    assert!(refused(&after_first(ws, wrong).await), "`token new` after a wrong proof");
    let keys: Vec<[u8; 32]> = served.harness.client_tokens().unwrap().into_iter().map(|token| token.stored_key).collect();
    assert_eq!(keys, [served.token.stored_key()], "only the first token");
    assert!(Client::connect(&served.dir, &new).await.is_err(), "the new token opens nothing");

    let mut client = connect(&served).await;
    client.call(Op::TokenNew { stored_key: encode(&new.stored_key()) }).await.unwrap();
    Client::connect(&served.dir, &new).await.expect("added with a valid token, the new one works");
}

#[tokio::test]
async fn auth_the_token_never_crosses_the_socket_a_fake_server_sees_only_the_answer() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = UnixListener::bind(tmp.path().join(SOCKET)).unwrap();
    let hello = serde_json::to_string(&Hello { protocol: PROTOCOL, build: "fake".into(), challenge: encode(&Token::random().stored_key()) }).unwrap();
    let sent = hello.clone();
    let fake = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        ws.send(Message::text(sent)).await.unwrap();
        let mut seen = vec![];
        if let Some(Ok(Message::Text(text))) = ws.next().await {
            seen.push(text.as_str().to_owned());
        }
        ws.send(Message::text(json!({ "error": "refused" }).to_string())).await.unwrap();
        while let Some(Ok(message)) = ws.next().await {
            if let Message::Text(text) = message {
                seen.push(text.as_str().to_owned());
            }
        }
        seen
    });
    let token = Token::random();
    assert!(Client::connect(tmp.path(), &token).await.is_err(), "a server that refuses is refused");
    let seen = fake.await.unwrap();
    let answer = json!(Proof { proof: encode(&token.answer(hello.as_bytes())) }).to_string();
    assert!(seen == [answer], "the fake server got the challenge answer and nothing else");
    assert!(!seen.iter().any(|text| text.contains(&token.hex()) || text.contains(&encode(&token.stored_key()))), "no token or stored key");
}

#[tokio::test]
async fn events_a_client_that_reconnects_after_n_gets_exactly_what_it_missed() {
    let served = serve(SCRIPT);
    let mut first = connect(&served).await;
    let id = open(&mut first).await;
    first.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    let seen = events_until(&mut first, |body| matches!(body, Body::Text { .. })).await;
    let after = seen.last().unwrap().seq;
    drop(first);

    let mut second = connect(&served).await;
    second.call(Op::Watch { session: id.clone(), after }).await.unwrap();
    let request = events_until(&mut second, |body| matches!(body, Body::Permission { .. })).await;
    let Body::Permission { id: request_id, .. } = &request.last().unwrap().body else { unreachable!() };
    second.call(Op::Answer { session: id.clone(), request: request_id.clone(), decision: Decision::Allow, message: None }).await.unwrap();
    let call = events_until(&mut second, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let Body::ClientToolCall { id: call_id, .. } = &call.last().unwrap().body else { unreachable!() };
    second.call(Op::ToolResult { session: id.clone(), call: call_id.clone(), output: json!("ticket"), error: false }).await.unwrap();
    let ended = events_until(&mut second, |body| matches!(body, Body::TurnEnded { .. })).await;
    second.call(Op::Close { session: id.clone() }).await.unwrap();
    let rest = events_until(&mut second, |body| *body == Body::Closed).await;
    assert_eq!(tokio::time::timeout(WAIT, second.push()).await.unwrap().unwrap(), Some(Push::End { session: id.clone() }));

    let got: Vec<Event> = [request, call, ended, rest].concat();
    let missed = served.harness.events(&id, after).unwrap();
    assert!(got == missed, "exactly the stored events after {after}, once each, in order");
    let seqs: Vec<u64> = got.iter().map(|event| event.seq).collect();
    assert_eq!(seqs, (after + 1..=after + got.len() as u64).collect::<Vec<_>>());
}

#[tokio::test]
async fn requests_each_request_of_the_api_works_against_the_mock() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let providers = client.call(Op::Providers).await.unwrap();
    assert_eq!(providers[0]["name"], "mock");
    assert_eq!(providers.as_array().unwrap().len(), 1);
    let id = open(&mut client).await;
    let s = || id.clone();
    client.call(Op::Send { session: s(), text: "go".into() }).await.unwrap();
    let asked = events_until(&mut client, |body| matches!(body, Body::Permission { .. })).await;
    let Body::Permission { id: request, .. } = &asked.last().unwrap().body else { unreachable!() };
    let wrong = client.call(Op::Answer { session: s(), request: "p-never".into(), decision: Decision::Allow, message: None }).await;
    assert!(matches!(wrong, Err(Error::Said(_))), "an answer to no request is refused: {wrong:?}");
    client.call(Op::Answer { session: s(), request: request.clone(), decision: Decision::Allow, message: None }).await.unwrap();
    let called = events_until(&mut client, |body| matches!(body, Body::ClientToolCall { .. })).await;
    assert!(matches!(&called[0].body, Body::Answered { decision: Decision::Allow, .. }));
    let Body::ClientToolCall { id: call, .. } = &called.last().unwrap().body else { unreachable!() };
    client.call(Op::ToolResult { session: s(), call: call.clone(), output: json!({ "title": "T" }), error: false }).await.unwrap();
    let ended = events_until(&mut client, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert!(matches!(&ended[0].body, Body::ToolResult { output, error: false, .. } if output["title"] == "T"));
    assert_eq!(served.mock.replies(&provider_session(&served, &id))[0].as_ref().unwrap().output["title"], "T", "the agent got the result");

    client.call(Op::Send { session: s(), text: "again".into() }).await.unwrap();
    events_until(&mut client, |body| *body == Body::TurnStarted).await;
    client.call(Op::Cancel { session: s() }).await.unwrap();
    events_until(&mut client, |body| matches!(body, Body::TurnEnded { .. })).await;
    client.call(Op::Close { session: s() }).await.unwrap();
    events_until(&mut client, |body| *body == Body::Closed).await;
    client.call(Op::CleanUp { session: s() }).await.unwrap();

    let page = client.call(Op::Events { session: s(), after: 0 }).await.unwrap();
    assert_eq!(page["more"], json!(false));
    let stored: Vec<Event> = serde_json::from_value(page["events"].clone()).unwrap();
    assert!(stored.iter().all(|event| matches!(event.body, Body::Withheld { .. })), "cleaned up, the payload is gone");
    let sessions = client.call(Op::Sessions).await.unwrap();
    assert_eq!((sessions[0]["id"].as_str(), &sessions[0]["cleaned"], &sessions[0]["running"]), (Some(id.as_str()), &json!(true), &json!(false)));
    assert!(matches!(client.call(Op::Watch { session: "nope".into(), after: 0 }).await, Err(Error::Said(_))), "no such session");
}

fn provider_session(served: &Served, id: &str) -> String {
    match &served.harness.events(id, 0).unwrap()[0].body {
        Body::Started { provider_session, .. } => provider_session.clone(),
        other => panic!("expected started, got {other:?}"),
    }
}

#[tokio::test]
async fn serve_the_socket_is_private_and_the_hello_and_descriptor_name_protocol_and_build() {
    let served = serve(SCRIPT);
    let mode = |path: PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(served.dir.clone()), 0o700, "the data folder is the user's alone");
    assert!(std::fs::metadata(served.dir.join(SOCKET)).unwrap().file_type().is_socket());
    assert_eq!(mode(served.dir.join(SOCKET)), 0o600);
    assert_eq!(mode(served.dir.join(DESCRIPTOR)), 0o600);
    let descriptor: Descriptor = serde_json::from_slice(&std::fs::read(served.dir.join(DESCRIPTOR)).unwrap()).unwrap();
    assert_eq!(descriptor, Descriptor { protocol: PROTOCOL, build: harness::BUILD_ID.into(), pid: std::process::id() });
    let client = connect(&served).await;
    assert_eq!((client.hello.protocol, client.hello.build.as_str()), (PROTOCOL, harness::BUILD_ID));
    let (_, first) = raw(&served).await;
    let (_, second) = raw(&served).await;
    assert!(first != second, "each connection gets its own challenge");
}

#[tokio::test]
async fn serve_a_harness_with_no_token_and_none_handed_over_does_not_start() {
    let (_tmp, dir) = data_dir();
    let refused = Server::bind(&dir, || None, vec![], settings(4));
    assert!(matches!(refused, Err(Error::Refused(_))), "no first token");
    assert!(!dir.join(SOCKET).exists());
}

/// True when the harness closes `stream` within 5 s without saying anything.
async fn closed_by_the_harness(mut stream: UnixStream) -> bool {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 64];
    matches!(tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await, Ok(Ok(0) | Err(_)))
}

#[tokio::test]
async fn serve_a_connection_that_never_does_the_handshake_is_closed_at_the_proof_limit() {
    let served = serve_with(SCRIPT, Limits { proof_within: Duration::from_millis(200), ..Limits::default() });
    let idle = UnixStream::connect(served.dir.join(SOCKET)).await.unwrap();
    assert!(closed_by_the_harness(idle).await, "the time limit covers the handshake too");
}

#[tokio::test]
async fn serve_a_connection_past_the_cap_of_those_proving_is_closed_at_once_and_proven_ones_go_on() {
    let served = serve_with(SCRIPT, Limits { proving: 2, ..Limits::default() });
    let mut client = connect(&served).await;
    let _kept = [UnixStream::connect(served.dir.join(SOCKET)).await.unwrap(), UnixStream::connect(served.dir.join(SOCKET)).await.unwrap()];
    let third = UnixStream::connect(served.dir.join(SOCKET)).await.unwrap();
    assert!(closed_by_the_harness(third).await, "a third connection still proving is one past the cap");
    client.call(Op::Sessions).await.expect("a proven client is not counted among those proving");
}

#[tokio::test]
async fn serve_a_client_past_the_cap_of_proven_ones_is_told_so() {
    let served = serve_with(SCRIPT, Limits { proven: 1, ..Limits::default() });
    let _first = connect(&served).await;
    match Client::connect(&served.dir, &served.token).await {
        Err(Error::Said(why)) => assert!(why.contains("1 clients already"), "{why}"),
        other => panic!("expected the cap, got {:?}", other.err()),
    }
}

#[tokio::test]
async fn serve_a_first_message_past_a_few_kb_is_refused_before_it_is_read() {
    let served = serve(SCRIPT);
    let (ws, hello) = raw(&served).await;
    let padded = json!({ "proof": encode(&served.token.answer(hello.as_bytes())), "padding": "x".repeat(8 * 1024) });
    let said = after_first(ws, padded).await;
    assert!(said.iter().all(|reply| reply.get("ok").is_none()), "not taken as a proof, though it holds the right answer: {said:?}");
}

#[tokio::test]
async fn locked_a_client_that_stops_reading_misses_no_event_and_gets_each_whole() {
    // Many long lines of a locked session: far more than the socket, the pushes queue and a 1024-event channel hold.
    let says = 3_000;
    let script: String = std::iter::once("{\"prompt\": null}".to_owned())
        .chain((0..says).map(|n| format!("{{\"say\": \"{n} {}\"}}", "x".repeat(400))))
        .chain(std::iter::once("{\"end\": \"done\"}".to_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let served = serve(&script);
    let mut slow = connect(&served).await;
    let id = open_as(&mut slow, true, false).await;
    let mut done = served.harness.subscribe(&id).unwrap();
    slow.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    // The client reads nothing until the session has closed.
    loop {
        match done.recv().await {
            Ok(event) if event.body == Body::Closed => break,
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(e) => panic!("{e}"),
        }
    }
    let mut got = vec![];
    while let Some(Push::Event { event, .. }) = tokio::time::timeout(WAIT, slow.push()).await.unwrap().unwrap() {
        got.push(event);
    }
    let seqs: Vec<u64> = got.iter().map(|event| event.seq).collect();
    assert_eq!(seqs, (1..=got.len() as u64).collect::<Vec<_>>(), "every event once, in order");
    assert!(got.last().unwrap().body.withheld() == Body::Closed.withheld(), "the last is `closed`");
    // A locked session's text is not in the store, so a client that fell behind gets it only if nothing was dropped.
    assert!(got.iter().all(|event| !matches!(event.body, Body::Withheld { .. })), "every event whole");
    assert_eq!(got.iter().filter(|event| matches!(event.body, Body::Text { .. })).count(), says);
}

#[tokio::test]
async fn events_a_watch_from_past_the_end_pushes_nothing_at_or_below_its_number() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    client.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    events_until(&mut client, |body| matches!(body, Body::Permission { .. })).await;
    let mut watcher = connect(&served).await;
    watcher.call(Op::Watch { session: id.clone(), after: 1_000 }).await.unwrap();
    client.call(Op::Close { session: id.clone() }).await.unwrap();
    let pushed = tokio::time::timeout(WAIT, watcher.push()).await.unwrap().unwrap();
    assert_eq!(pushed, Some(Push::End { session: id }), "no event numbered 1000 or less, then the end");
}

#[tokio::test]
async fn events_one_connection_watches_a_session_once_at_a_time() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    let again = client.call(Op::Watch { session: id.clone(), after: 0 }).await;
    assert!(matches!(again, Err(Error::Said(ref why)) if why.contains("already watches")), "{again:?}");
    client.call(Op::Close { session: id.clone() }).await.unwrap();
    while let Some(push) = tokio::time::timeout(WAIT, client.push()).await.unwrap().unwrap() {
        if push == (Push::End { session: id.clone() }) {
            break;
        }
    }
    let mut ended = false;
    for _ in 0..100 {
        // The ended watch's task finishes just after it pushes its end.
        match client.call(Op::Watch { session: id.clone(), after: 0 }).await {
            Ok(_) => {
                ended = true;
                break;
            }
            Err(_) => tokio::task::yield_now().await,
        }
    }
    assert!(ended, "once a watch has ended the session can be watched again");
}

#[tokio::test]
async fn events_for_an_unknown_session_is_an_error() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    assert!(matches!(client.call(Op::Events { session: "nope".into(), after: 0 }).await, Err(Error::Said(_))));
}

#[tokio::test]
async fn locked_a_reconnecting_client_gets_kept_fields_and_not_the_text() {
    let served = serve(SCRIPT);
    let mut first = connect(&served).await;
    let id = open_as(&mut first, true, false).await;
    first.call(Op::Send { session: id.clone(), text: "a private prompt".into() }).await.unwrap();
    let live = events_until(&mut first, |body| matches!(body, Body::Permission { .. })).await;
    assert!(live.iter().any(|event| event.body == Body::Text { text: "two".into() }), "the connected client gets the text");
    drop(first);

    let mut second = connect(&served).await;
    second.call(Op::Watch { session: id.clone(), after: 0 }).await.unwrap();
    let mut read = vec![];
    for _ in 0..live.len() {
        read.push(next_event(&mut second).await);
    }
    assert_eq!(read.iter().map(|event| event.seq).collect::<Vec<_>>(), live.iter().map(|event| event.seq).collect::<Vec<_>>());
    for (stored, seen) in read.iter().zip(&live) {
        assert!(stored.body == seen.body.withheld(), "seq {}: only the kept fields come back", stored.seq);
    }
    let printed = serde_json::to_string(&read).unwrap();
    assert!(!printed.contains("a private prompt") && !printed.contains("\"two\""), "no text after a reconnect");
}

#[tokio::test]
async fn leave_a_session_that_ends_with_its_client_closes_when_it_leaves_and_is_not_resumed() {
    let served = serve(SCRIPT);
    let mut first = connect(&served).await;
    let ends = open_as(&mut first, false, true).await;
    let stays = open_as(&mut first, false, false).await;
    let mut watcher = connect(&served).await;
    watcher.call(Op::Watch { session: ends.clone(), after: 0 }).await.unwrap();
    next_event(&mut watcher).await;
    drop(first);
    events_until(&mut watcher, |body| *body == Body::Closed).await;
    assert!(matches!(served.harness.resume(&ends).await, Err(Error::EndedWithClient(_))), "never resumed");
    let sessions = watcher.call(Op::Sessions).await.unwrap();
    let row = |id: &str| sessions.as_array().unwrap().iter().find(|row| row["id"] == id).unwrap().clone();
    assert_eq!((&row(&ends)["ends_with_client"], &row(&ends)["running"]), (&json!(true), &json!(false)));
    assert_eq!(row(&stays)["running"], json!(true), "a session opened without the option goes on");
}

#[tokio::test]
async fn shutdown_stops_every_session_and_frees_the_data_folder() {
    let mut served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let (idle, asking) = (open(&mut client).await, open(&mut client).await);
    client.call(Op::Send { session: asking.clone(), text: "go".into() }).await.unwrap();
    loop {
        match next_event(&mut client).await.body {
            Body::Permission { .. } => break,
            _ => continue,
        }
    }
    let shut = tokio::time::timeout(Duration::from_secs(10), client.call(Op::Shutdown)).await;
    shut.expect("shutdown answers once every session has stopped").unwrap();
    let store = harness::store::Store::open(&served.dir).expect("the data folder is free once shutdown answers");
    for id in [&idle, &asking] {
        let last = store.events(id, 0).unwrap().pop().unwrap();
        assert_eq!(last.body, Body::Closed, "{id} recorded its close");
    }
    drop(store);
    assert!(matches!(served.harness.open(harness::session::Open { provider: "mock".into(), ..Default::default() }).await, Err(Error::ShutDown)));
    tokio::time::timeout(Duration::from_secs(10), &mut served.task).await.expect("serve ends").unwrap().unwrap();
    assert!(!served.dir.join(SOCKET).exists() && !served.dir.join(DESCRIPTOR).exists());
}

/// Asks a question, then thanks for the answer in the next turn.
const QUESTION: &str = r#"{"prompt": null}
{"question": "which one?"}
{"end": "done"}
{"prompt": null}
{"say": "thanks"}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn requests_a_question_is_answered_as_the_next_prompt_and_hand_over_keeps_the_provider_id() {
    let served = serve(QUESTION);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    client.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    let asked = events_until(&mut client, |body| matches!(body, Body::Question { .. })).await;
    let Body::Question { id: question, .. } = &asked.last().unwrap().body else { unreachable!() };
    client.call(Op::AnswerQuestion { session: id.clone(), question: question.clone(), text: "this one".into() }).await.unwrap();
    let again = client.call(Op::AnswerQuestion { session: id.clone(), question: question.clone(), text: "twice".into() }).await;
    assert!(matches!(again, Err(Error::Said(_))), "a question is answered once: {again:?}");
    let answered = events_until(&mut client, |body| *body == Body::Text { text: "thanks".into() }).await;
    assert!(answered.iter().any(|event| event.body == Body::Prompted { text: "this one".into() }), "the answer went as the next prompt");
    events_until(&mut client, |body| matches!(body, Body::TurnEnded { .. })).await;

    client.call(Op::HandOver { session: id.clone() }).await.unwrap();
    let rest = events_until(&mut client, |body| *body == Body::Closed).await;
    assert_eq!(rest.iter().map(|event| event.body.type_name()).collect::<Vec<_>>(), ["handed_over", "closed"]);
    let provider = provider_session(&served, &id);
    assert!(matches!(served.harness.resume(&id).await, Err(Error::HandedOver(_))), "not resumed while Terminal may hold it");
    let mut resumed = served.harness.take_back(&id).await.expect("taken back, it resumes from the kept id");
    assert_eq!(resumed.recv().await.unwrap().body, Body::Started { provider_session: provider, resumed: true });
}

#[tokio::test]
async fn serve_the_descriptor_follows_no_link_and_is_made_private() {
    let (_tmp, dir) = data_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let elsewhere = dir.parent().unwrap().join("elsewhere");
    std::fs::write(&elsewhere, "untouched").unwrap();
    std::os::unix::fs::symlink(&elsewhere, dir.join(DESCRIPTOR)).unwrap();
    let first = Token::random();
    let server = Server::bind(&dir, move || Some(first), vec![], settings(4)).unwrap();
    assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "untouched", "the link was not followed");
    let meta = std::fs::symlink_metadata(dir.join(DESCRIPTOR)).unwrap();
    assert!(meta.is_file() && meta.permissions().mode() & 0o777 == 0o600, "a private file in its place");
    drop(server);

    std::fs::set_permissions(dir.join(DESCRIPTOR), std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::remove_file(dir.join(SOCKET)).unwrap();
    let _server = Server::bind(&dir, || None, vec![], settings(4)).unwrap();
    assert_eq!(std::fs::metadata(dir.join(DESCRIPTOR)).unwrap().permissions().mode() & 0o777, 0o600, "an old file is replaced");
}

#[tokio::test]
async fn serve_a_socket_path_the_platform_cannot_take_says_its_length_and_the_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("d".repeat(120));
    let Err(e) = Server::bind(&dir, || Some(Token::random()), vec![], settings(4)) else { panic!("a path that long was taken") };
    let said = e.to_string();
    let len = dir.join(SOCKET).as_os_str().len();
    assert!(said.contains(&len.to_string()) && said.contains(&(harness::api::SOCKET_PATH_MAX - 1).to_string()), "{said}");
    assert!(!dir.exists(), "nothing was made");
    assert!(matches!(Client::connect(&dir, &Token::random()).await, Err(Error::SocketPathTooLong { .. })), "the client says so too");
}

#[tokio::test]
async fn tokens_a_list_shows_ids_and_times_marks_yours_and_holds_no_key() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let other = Token::random();
    client.call(Op::TokenNew { stored_key: encode(&other.stored_key()) }).await.unwrap();
    let listed = client.call(Op::TokenList).await.unwrap();
    let rows = listed.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().map(|row| row["yours"].clone()).collect::<Vec<_>>(), [json!(true), json!(false)]);
    for row in rows {
        let mut fields: Vec<&String> = row.as_object().unwrap().keys().collect();
        fields.sort();
        assert_eq!(fields, ["created_ms", "id", "yours"], "only these, never a key");
    }
    let printed = listed.to_string();
    for key in [served.token.stored_key(), other.stored_key()] {
        assert!(!printed.contains(&encode(&key)), "no stored key in the list");
    }
}

#[tokio::test]
async fn tokens_a_revoked_token_is_refused_and_its_open_connection_ends_at_its_next_call() {
    let served = serve(SCRIPT);
    let mut first = connect(&served).await;
    let other = Token::random();
    first.call(Op::TokenNew { stored_key: encode(&other.stored_key()) }).await.unwrap();
    let mut second = Client::connect(&served.dir, &other).await.unwrap();
    let listed = first.call(Op::TokenList).await.unwrap();
    let id = listed.as_array().unwrap().iter().find(|row| row["yours"] == json!(false)).unwrap()["id"].as_i64().unwrap();
    first.call(Op::TokenRevoke { token: id }).await.unwrap();
    assert!(second.call(Op::Sessions).await.is_err(), "the open connection of a revoked token ends");
    assert!(Client::connect(&served.dir, &other).await.is_err(), "and the token opens nothing again");
    let own = listed.as_array().unwrap().iter().find(|row| row["yours"] == json!(true)).unwrap()["id"].as_i64().unwrap();
    assert!(matches!(first.call(Op::TokenRevoke { token: own }).await, Err(Error::Said(_))), "the last token stays");
    first.call(Op::Sessions).await.expect("the first token still works");
}

/// A session that says a text of `len` bytes, then "after".
fn big_say(len: usize) -> String {
    format!("{{\"prompt\": null}}\n{{\"say\": \"{}\"}}\n{{\"say\": \"after\"}}\n{{\"end\": \"done\"}}", "y".repeat(len))
}

#[tokio::test]
async fn limits_an_event_over_the_cap_is_cut_stored_and_sent_cut_and_readers_go_on_past_it() {
    for locked in [false, true] {
        let served = serve(&big_say(20 << 20));
        let mut client = connect(&served).await;
        let id = open_as(&mut client, locked, false).await;
        client.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
        let seen = events_until(&mut client, |body| *body == Body::Text { text: "after".into() }).await;
        let big = seen.iter().find(|event| matches!(&event.body, Body::Text { text } if text.starts_with('y'))).expect("the big text came, cut");
        let Body::Text { text } = &big.body else { unreachable!() };
        assert!(text.len() <= harness::event::EVENT_MAX, "locked {locked}: cut to the cap");
        assert_eq!(big.cut, Some(((20 << 20) - text.len()) as u64), "locked {locked}: it says how much was cut");
        let stored = served.harness.events(&id, big.seq - 1).unwrap();
        assert_eq!(stored[0].cut, big.cut, "locked {locked}: the cut is kept in the store");
        assert_eq!(matches!(stored[0].body, Body::Withheld { .. }), locked, "a locked session's text is still withheld");
        let mut read = vec![];
        client.events(&id, 0, |event| read.push(event)).await.unwrap();
        assert!(read.iter().any(|event| event.seq > big.seq), "locked {locked}: a reader goes on past it");
    }
}

#[tokio::test]
async fn limits_events_come_in_pages_and_the_client_reads_them_all() {
    // About 12 MiB stored: more than a page and more than a message.
    let says = 40;
    let script: String = std::iter::once("{\"prompt\": null}".to_owned())
        .chain((0..says).map(|n| format!("{{\"say\": \"{n} {}\"}}", "z".repeat(300_000))))
        .chain(std::iter::once("{\"end\": \"done\"}".to_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let served = serve(&script);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    client.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    events_until(&mut client, |body| matches!(body, Body::TurnEnded { .. })).await;
    let first = client.call(Op::Events { session: id.clone(), after: 0 }).await.unwrap();
    assert_eq!(first["more"], json!(true), "the first page is not all");
    assert!(first.to_string().len() <= harness::api::PAGE_BYTES + harness::event::EVENT_MAX, "a page holds about a page");
    let mut read = vec![];
    client.events(&id, 0, |event| read.push(event)).await.unwrap();
    assert!(read == served.harness.events(&id, 0).unwrap(), "every page, each event once, in order");
    assert_eq!(read.iter().filter(|event| matches!(event.body, Body::Text { .. })).count(), says);

    // A watch from the start reads the same backlog page by page, then ends at `closed`. The script has ended.
    events_until(&mut client, |body| *body == Body::Closed).await;
    let mut watcher = connect(&served).await;
    watcher.call(Op::Watch { session: id.clone(), after: 0 }).await.unwrap();
    let mut watched = vec![];
    while let Some(Push::Event { event, .. }) = tokio::time::timeout(WAIT, watcher.push()).await.unwrap().unwrap() {
        watched.push(event);
    }
    assert!(watched == served.harness.events(&id, 0).unwrap(), "a watch pages through the store too");
}

#[tokio::test]
async fn limits_a_page_of_many_small_events_fits_in_a_message() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    client.call(Op::Close { session: id.clone() }).await.unwrap();
    events_until(&mut client, |body| *body == Body::Closed).await;
    // Small events whose payload fits a page several times over as stored, but not once as sent.
    let small = 240_000;
    let raw = rusqlite::Connection::open(served.dir.join("harness.sqlite")).unwrap();
    raw.execute(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO events (session, seq, ms, type, payload, withheld) SELECT ?1, 1000 + i, 0, 'waiting', '{\"type\":\"waiting\"}', 0 FROM n",
        rusqlite::params![id, small],
    )
    .unwrap();
    let mut read = 0;
    client.events(&id, 999, |_| read += 1).await.expect("every page fits in a message");
    assert_eq!(read, small);
}

#[tokio::test]
async fn limits_a_call_over_the_limit_is_refused_and_the_connection_goes_on() {
    let served = serve(SCRIPT);
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    let big = json!("w".repeat(harness::api::MAX_MESSAGE));
    match client.call(Op::ToolResult { session: id.clone(), call: "c1".into(), output: big, error: false }).await {
        Err(e @ Error::TooLarge { .. }) => assert!(e.to_string().contains(&harness::api::MAX_MESSAGE.to_string()), "it names the limit: {e}"),
        other => panic!("expected the limit, got {other:?}"),
    }
    client.call(Op::Sessions).await.expect("the connection goes on");
}

#[tokio::test]
async fn serve_a_call_sent_with_the_proof_is_answered() {
    let served = serve(SCRIPT);
    let (mut ws, hello) = raw(&served).await;
    let proof = json!(Proof { proof: encode(&served.token.answer(hello.as_bytes())) });
    // Both in one flush, before the answer to the proof.
    ws.feed(Message::text(proof.to_string())).await.unwrap();
    ws.feed(Message::text(json!({ "id": 1, "op": "sessions" }).to_string())).await.unwrap();
    ws.flush().await.unwrap();
    let mut said = vec![];
    while said.len() < 2 {
        let Some(Ok(Message::Text(text))) = tokio::time::timeout(WAIT, ws.next()).await.unwrap() else { panic!("closed") };
        said.push(serde_json::from_str::<Value>(text.as_str()).unwrap());
    }
    assert_eq!((&said[0]["ok"], &said[1]["id"], &said[1]["ok"]), (&json!(true), &json!(1), &json!([])));
}

#[tokio::test]
async fn serve_a_binary_frame_after_the_proof_gets_an_error() {
    let served = serve(SCRIPT);
    let (mut ws, hello) = raw(&served).await;
    ws.send(Message::text(json!(Proof { proof: encode(&served.token.answer(hello.as_bytes())) }).to_string())).await.unwrap();
    ws.next().await;
    ws.send(Message::binary(b"{\"id\":1,\"op\":\"sessions\"}".to_vec())).await.unwrap();
    let Some(Ok(Message::Text(text))) = tokio::time::timeout(WAIT, ws.next()).await.unwrap() else { panic!("no answer") };
    let said: Value = serde_json::from_str(text.as_str()).unwrap();
    assert!(said["error"].as_str().is_some_and(|error| error.contains("text")), "{said}");
}

#[tokio::test]
async fn auth_a_client_gives_up_on_a_harness_that_never_says_hello() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = UnixListener::bind(tmp.path().join(SOCKET)).unwrap();
    let _silent = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        std::future::pending::<()>().await;
    });
    let gave_up = tokio::time::timeout(WAIT, Client::connect_within(tmp.path(), &Token::random(), Duration::from_millis(200))).await;
    assert!(matches!(gave_up, Ok(Err(Error::Protocol(ref why))) if why.contains("did not answer")), "{:?}", gave_up.map(|r| r.err()));
}

/// A permission request whose input is over the event cap, then one whose tool name is.
fn big_permissions() -> String {
    let big = "q".repeat(2 << 20);
    format!(
        "{{\"prompt\": null}}\n{{\"permission\": {{\"kind\": \"command\", \"tool\": \"Bash\", \"input\": {{\"command\": \"{big}\"}}}}}}\n{{\"permission\": {{\"kind\": \"tool\", \"tool\": \"{big}\"}}}}\n{{\"end\": \"done\"}}\n{{\"prompt\": null}}"
    )
}

#[tokio::test]
async fn limits_a_cut_permission_request_can_only_be_denied_and_one_too_large_to_show_is_denied_at_once() {
    let served = serve(&big_permissions());
    let mut client = connect(&served).await;
    let id = open(&mut client).await;
    client.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    let asked = events_until(&mut client, |body| matches!(body, Body::Permission { .. })).await;
    let event = asked.last().unwrap();
    assert!(event.cut.is_some(), "its input was cut");
    let Body::Permission { id: request, .. } = &event.body else { unreachable!() };
    let allow = client.call(Op::Answer { session: id.clone(), request: request.clone(), decision: Decision::Allow, message: None }).await;
    assert!(matches!(allow, Err(Error::Said(ref why)) if why.contains("only be denied")), "{allow:?}");
    client.call(Op::Answer { session: id.clone(), request: request.clone(), decision: Decision::Deny, message: None }).await.unwrap();

    // The second request's kept fields alone are over the cap: no one could answer it, so it is denied at once.
    let rest = events_until(&mut client, |body| matches!(body, Body::TurnEnded { .. })).await;
    let kinds: Vec<String> = rest.iter().map(|event| event.body.type_name()).collect();
    assert_eq!(kinds, ["answered", "withheld", "answered", "turn_ended"], "{kinds:?}");
    assert!(matches!(&rest[1].body, Body::Withheld { of, .. } if of == "permission") && rest[1].cut.is_some());
    assert!(matches!(&rest[2].body, Body::Answered { decision: Decision::Deny, message: Some(why), .. } if why.contains("too large")));
    let started = provider_session(&served, &id);
    let denied = served.mock.received(&started).iter().filter(|command| matches!(command, harness::driver::Command::Answer { decision: Decision::Deny, .. })).count();
    assert_eq!(denied, 2, "the agent heard both denials");
}

#[tokio::test]
async fn serve_a_client_turned_away_because_too_many_are_proving_is_told_why() {
    let served = serve_with(SCRIPT, Limits { proving: 1, ..Limits::default() });
    let _held = UnixStream::connect(served.dir.join(SOCKET)).await.unwrap();
    match Client::connect(&served.dir, &served.token).await {
        Err(Error::Said(why)) => assert!(why.contains("still proving"), "{why}"),
        other => panic!("expected a refusal that says why, got {:?}", other.err()),
    }
}

#[tokio::test]
async fn limits_a_message_over_the_limit_from_another_client_closes_its_connection_with_1009() {
    let served = serve(SCRIPT);
    let (mut ws, hello) = raw(&served).await;
    ws.send(Message::text(json!(Proof { proof: encode(&served.token.answer(hello.as_bytes())) }).to_string())).await.unwrap();
    ws.next().await;
    let big = json!({ "id": 1, "op": "send", "session": "s", "text": "v".repeat(harness::api::MAX_MESSAGE) });
    let _ = ws.send(Message::text(big.to_string())).await;
    let mut code = None;
    while let Ok(Some(Ok(message))) = tokio::time::timeout(Duration::from_secs(60), ws.next()).await {
        if let Message::Close(frame) = message {
            code = frame.map(|frame| u16::from(frame.code));
            break;
        }
    }
    assert_eq!(code, Some(1009), "closed as too big");
}

/// Says one line per prompt, then waits for the next.
const ONE_A_PROMPT: &str = r#"{"prompt": null}
{"say": "one"}
{"end": "done"}
{"prompt": null}
{"say": "two"}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn tokens_a_watching_connection_of_a_revoked_token_gets_nothing_after_the_revoke_answers() {
    let served = serve(ONE_A_PROMPT);
    let mut first = connect(&served).await;
    let other = Token::random();
    first.call(Op::TokenNew { stored_key: encode(&other.stored_key()) }).await.unwrap();
    let id = open_as(&mut first, true, false).await;
    first.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    events_until(&mut first, |body| matches!(body, Body::TurnEnded { .. })).await;
    let mut watcher = Client::connect(&served.dir, &other).await.unwrap();
    watcher.call(Op::Watch { session: id.clone(), after: 0 }).await.unwrap();
    let seen = served.harness.events(&id, 0).unwrap().len();
    for _ in 0..seen {
        next_event(&mut watcher).await;
    }
    let listed = first.call(Op::TokenList).await.unwrap();
    let other_id = listed.as_array().unwrap().iter().find(|row| row["yours"] == json!(false)).unwrap()["id"].as_i64().unwrap();
    first.call(Op::TokenRevoke { token: other_id }).await.unwrap();
    // A locked session's text, made after the revoke has answered.
    first.call(Op::Send { session: id.clone(), text: "again".into() }).await.unwrap();
    events_until(&mut first, |body| matches!(body, Body::TurnEnded { .. })).await;
    match tokio::time::timeout(Duration::from_secs(60), watcher.push()).await.unwrap() {
        Ok(None) | Err(_) => {}
        Ok(Some(push)) => panic!("the revoked connection got {push:?}"),
    }
}

#[tokio::test]
async fn locked_a_client_past_the_backlog_is_told_events_were_lost() {
    let says = 3_000;
    let script: String = std::iter::once("{\"prompt\": null}".to_owned())
        .chain((0..says).map(|n| format!("{{\"say\": \"{n} {}\"}}", "x".repeat(400))))
        .chain(std::iter::once("{\"end\": \"done\"}".to_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let settings = harness::session::Settings { locked_backlog: 100, ..settings(4) };
    let served = serve_set(&script, Limits::default(), settings);
    let mut slow = connect(&served).await;
    let id = open_as(&mut slow, true, false).await;
    let mut done = served.harness.subscribe(&id).unwrap();
    slow.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    // The client reads nothing until the session has closed.
    loop {
        match done.recv().await {
            Ok(event) if event.body == Body::Closed => break,
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(e) => panic!("{e}"),
        }
    }
    let mut got = vec![];
    let end = loop {
        match tokio::time::timeout(Duration::from_secs(60), slow.push()).await.unwrap().unwrap() {
            Some(Push::Event { event, .. }) => got.push(event),
            other => break other,
        }
    };
    assert!(matches!(&end, Some(Push::Lost { reason, .. }) if reason.contains("events were lost") && reason.contains("100")), "{end:?}");
    let seqs: Vec<u64> = got.iter().map(|event| event.seq).collect();
    assert_eq!(seqs, (1..=got.len() as u64).collect::<Vec<_>>(), "what came, came in order and whole");
    assert!(got.len() < says, "not all of it");
}

#[tokio::test]
async fn events_an_unlocked_client_that_stops_reading_reads_what_it_missed_from_the_store() {
    let says = 3_000;
    let script: String = std::iter::once("{\"prompt\": null}".to_owned())
        .chain((0..says).map(|n| format!("{{\"say\": \"{n} {}\"}}", "x".repeat(400))))
        .chain(std::iter::once("{\"end\": \"done\"}".to_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let settings = harness::session::Settings { locked_backlog: 100, ..settings(4) };
    let served = serve_set(&script, Limits::default(), settings);
    let mut slow = connect(&served).await;
    let id = open(&mut slow).await;
    let mut done = served.harness.subscribe(&id).unwrap();
    slow.call(Op::Send { session: id.clone(), text: "go".into() }).await.unwrap();
    loop {
        match done.recv().await {
            Ok(event) if event.body == Body::Closed => break,
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(e) => panic!("{e}"),
        }
    }
    let mut got = vec![];
    while let Some(Push::Event { event, .. }) = tokio::time::timeout(Duration::from_secs(60), slow.push()).await.unwrap().unwrap() {
        got.push(event);
    }
    assert!(got == served.harness.events(&id, 0).unwrap(), "every event once, in order, whole: the store has them");
}

#[tokio::test]
async fn serve_aborting_the_server_stops_its_sweeper_and_frees_the_data_folder() {
    let (_tmp, dir) = data_dir();
    let first = Token::random();
    let server = Server::bind(&dir, move || Some(first), vec![], settings(4)).unwrap();
    let task = tokio::spawn(server.run());
    tokio::task::yield_now().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let mut opened = harness::store::Store::open(&dir);
    for _ in 0..1000 {
        if opened.is_ok() {
            break;
        }
        // The sweeper's task ends on the runtime's next turn.
        tokio::task::yield_now().await;
        opened = harness::store::Store::open(&dir);
    }
    assert!(opened.is_ok(), "nothing holds the harness, so the folder is free");
}
