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
use harness::server::Server;
use harness::session::Harness;
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio_tungstenite::tungstenite::Message;

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
    let (tmp, dir) = data_dir();
    let (token, mock) = (Token::random(), common::mock(script));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    let first = token.clone();
    let server = Server::bind(&dir, move || Some(first), drivers, settings(4)).unwrap();
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
    match tokio::time::timeout(Duration::from_secs(10), client.push()).await.expect("a push within 10 s").unwrap() {
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

/// A raw WebSocket on the harness's socket, before any proof, and the challenge it was given.
async fn raw(served: &Served) -> (tokio_tungstenite::WebSocketStream<UnixStream>, [u8; 32]) {
    let stream = UnixStream::connect(served.dir.join(SOCKET)).await.unwrap();
    let (mut ws, _) = tokio_tungstenite::client_async("ws://harness/", stream).await.unwrap();
    let Some(Ok(Message::Text(hello))) = ws.next().await else { panic!("no hello") };
    let hello: Hello = serde_json::from_str(hello.as_str()).unwrap();
    (ws, decode(&hello.challenge).unwrap())
}

/// What the harness says after a first message, until it closes the connection.
async fn after_first(mut ws: tokio_tungstenite::WebSocketStream<UnixStream>, first: Value) -> Vec<Value> {
    ws.send(Message::text(first.to_string())).await.unwrap();
    // A call sent after a refused proof must not be served either.
    let _ = ws.send(Message::text(json!({ "id": 2, "op": "sessions" }).to_string())).await;
    let mut said = vec![];
    while let Ok(Some(Ok(message))) = tokio::time::timeout(Duration::from_secs(10), ws.next()).await {
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
    let (ws, challenge) = raw(&served).await;
    let wrong = json!(Proof { proof: encode(&Token::random().answer(&challenge)) });
    assert!(refused(&after_first(ws, wrong).await), "a wrong token");
    let (ws, challenge) = raw(&served).await;
    let of_tools = json!(Proof { proof: encode(&tools.answer(&challenge)) });
    assert!(refused(&after_first(ws, of_tools).await), "the session's tools token");
    let (ws, _) = raw(&served).await;
    let replayed = json!(Proof { proof: encode(&served.token.answer(&challenge)) });
    assert!(refused(&after_first(ws, replayed).await), "a right answer to another connection's challenge");

    match Client::connect(&served.dir, &tools).await {
        Err(Error::Refused(_)) => {}
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
    let (ws, challenge) = raw(&served).await;
    let wrong = json!(Proof { proof: encode(&Token::random().answer(&challenge)) });
    assert!(refused(&after_first(ws, wrong).await), "`token new` after a wrong proof");
    assert_eq!(served.harness.client_tokens().unwrap(), [served.token.stored_key()], "only the first token");
    assert!(Client::connect(&served.dir, &new).await.is_err(), "the new token opens nothing");

    let mut client = connect(&served).await;
    client.call(Op::TokenNew { stored_key: encode(&new.stored_key()) }).await.unwrap();
    Client::connect(&served.dir, &new).await.expect("added with a valid token, the new one works");
}

#[tokio::test]
async fn auth_the_token_never_crosses_the_socket_a_fake_server_sees_only_the_answer() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = UnixListener::bind(tmp.path().join(SOCKET)).unwrap();
    let challenge = Token::random().stored_key();
    let fake = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let hello = Hello { protocol: PROTOCOL, build: "fake".into(), challenge: encode(&challenge) };
        ws.send(Message::text(serde_json::to_string(&hello).unwrap())).await.unwrap();
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
    let answer = json!(Proof { proof: encode(&token.answer(&challenge)) }).to_string();
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
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), second.push()).await.unwrap().unwrap(), Some(Push::End { session: id.clone() }));

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
    assert!(matches!(wrong, Err(Error::Refused(_))), "an answer to no request is refused: {wrong:?}");
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

    let stored: Vec<Event> = serde_json::from_value(client.call(Op::Events { session: s(), after: 0 }).await.unwrap()).unwrap();
    assert!(stored.iter().all(|event| matches!(event.body, Body::Withheld { .. })), "cleaned up, the payload is gone");
    let sessions = client.call(Op::Sessions).await.unwrap();
    assert_eq!((sessions[0]["id"].as_str(), &sessions[0]["cleaned"], &sessions[0]["running"]), (Some(id.as_str()), &json!(true), &json!(false)));
    assert!(matches!(client.call(Op::Watch { session: "nope".into(), after: 0 }).await, Err(Error::Refused(_))), "no such session");
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
    client.call(Op::Shutdown).await.unwrap();
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
    assert!(matches!(again, Err(Error::Refused(_))), "a question is answered once: {again:?}");
    let answered = events_until(&mut client, |body| *body == Body::Text { text: "thanks".into() }).await;
    assert!(answered.iter().any(|event| event.body == Body::Prompted { text: "this one".into() }), "the answer went as the next prompt");
    events_until(&mut client, |body| matches!(body, Body::TurnEnded { .. })).await;

    client.call(Op::HandOver { session: id.clone() }).await.unwrap();
    let rest = events_until(&mut client, |body| *body == Body::Closed).await;
    assert_eq!(rest.iter().map(|event| event.body.type_name()).collect::<Vec<_>>(), ["handed_over", "closed"]);
    let provider = provider_session(&served, &id);
    let mut resumed = served.harness.resume(&id).await.expect("a session handed over can be resumed");
    assert_eq!(resumed.recv().await.unwrap().body, Body::Started { provider_session: provider, resumed: true });
}
