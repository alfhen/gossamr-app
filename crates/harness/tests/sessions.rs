mod common;

use std::sync::Arc;

use common::*;
use harness::driver::{Capabilities, Command, Driver, Launch, Link};
use harness::event::{Body, Decision, PermissionKind, TurnEnd};
use harness::session::{Harness, Open};
use harness::store::Store;
use serde_json::json;
use tokio::sync::mpsc;

fn provider_session(started: &Body) -> String {
    match started {
        Body::Started { provider_session, .. } => provider_session.clone(),
        other => panic!("expected started, got {other:?}"),
    }
}

const LIFE: &str = r#"
{"prompt": null}
{"say": "working on it"}
{"tool": {"id": "x", "name": "Bash", "input": {"command": "ls"}}}
{"permission": {"kind": "command", "tool": "Bash", "input": {"command": "ls"}}}
{"tool_result": {"id": "x", "output": "README.md"}}
{"end": "done"}
{"prompt": null}
"#;

#[tokio::test]
async fn life_a_mock_session_goes_from_prompt_through_text_tool_call_and_permission_to_its_turn_end() {
    let (_tmp, dir) = data_dir();
    let mock = mock(LIFE);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false);
    harness.send(&id, "list the files").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    assert_eq!(types(&asked), ["started", "prompted", "text", "tool_call", "permission"]);
    let Body::Permission { id: request, kind, tool, input } = &asked[4].body else { unreachable!() };
    assert_eq!((*kind, tool.as_str(), input), (PermissionKind::Command, "Bash", &json!({"command": "ls"})));
    let Body::ToolCall { id: call, .. } = &asked[3].body else { unreachable!() };
    harness.answer(&id, request, Decision::Allow).unwrap();
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(types(&rest), ["answered", "tool_result", "turn_ended"]);
    assert!(matches!(&rest[1].body, Body::ToolResult { id, .. } if id == call), "the result names its call: {rest:?}");
    assert_eq!(rest[2].body, Body::TurnEnded { how: TurnEnd::Done });

    let ps = provider_session(&asked[0].body);
    let answer = Command::Answer { id: request.clone(), decision: Decision::Allow };
    assert_eq!(mock.received(&ps), [Command::Prompt("list the files".into()), answer]);
    let live: Vec<_> = asked.into_iter().chain(rest).collect();
    assert_eq!(harness.events(&id, 0).unwrap(), live, "the store holds what the client saw, in the same order");
    assert!(live.windows(2).all(|pair| pair[1].seq == pair[0].seq + 1) && live[0].seq == 1);
}

#[tokio::test]
async fn life_a_cancel_ends_the_running_turn_and_the_next_prompt_runs() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"say": "started"}
        {"sleep": 60000}
        {"say": "never"}
        {"end": "done"}
        {"prompt": null}
        {"say": "second"}
        {"end": "done"}"#,
    );
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false);
    harness.send(&id, "one").unwrap();
    until(&mut events, |body| matches!(body, Body::Text { .. })).await;
    harness.cancel(&id).unwrap();
    assert_eq!(next(&mut events).await.body, Body::TurnEnded { how: TurnEnd::Cancelled });
    harness.send(&id, "two").unwrap();
    let second = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(types(&second), ["prompted", "text", "turn_ended"]);
    assert_eq!(second[1].body, Body::Text { text: "second".into() }, "the cancelled turn's rest is never played");
}

#[tokio::test]
async fn life_a_failure_is_an_event_and_ends_the_turn() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"fail": "the model is not available"}
        {"prompt": null}
        {"say": "ok"}"#,
    );
    let harness = harness(&dir, &mock, 1);
    let (id, mut events) = open(&harness, false);
    harness.send(&id, "one").unwrap();
    let failed = until(&mut events, |body| matches!(body, Body::Failed { .. })).await;
    assert_eq!(failed.last().unwrap().body, Body::Failed { reason: "the model is not available".into() });
    // With a limit of one, the next turn starts only if the failure gave its slot back.
    harness.send(&id, "two").unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&rest), ["prompted", "text", "failed", "closed"]);
    assert_eq!(rest[2].body, Body::Failed { reason: "the agent stopped in the middle of a turn".into() });
    assert!(harness.send(&id, "three").is_err(), "a closed session takes no request");
}

#[tokio::test]
async fn limit_a_session_past_the_turn_limit_waits_until_a_slot_frees() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"permission": {"kind": "tool", "tool": "Read"}}
        {"end": "done"}"#,
    );
    let harness = harness(&dir, &mock, 1);
    let (first, mut first_events) = open(&harness, false);
    let (second, mut second_events) = open(&harness, false);
    harness.send(&first, "one").unwrap();
    let asked = until(&mut first_events, |body| matches!(body, Body::Permission { .. })).await;
    harness.send(&second, "two").unwrap();
    let waiting = until(&mut second_events, |body| *body == Body::Waiting).await;
    assert_eq!(types(&waiting), ["started", "waiting"]);
    quiet(&mut second_events, 200).await;
    assert!(mock.received(&provider_session(&waiting[0].body)).is_empty(), "the prompt is held, not sent");

    let Body::Permission { id: request, .. } = &asked.last().unwrap().body else { unreachable!() };
    harness.answer(&first, request, Decision::Deny).unwrap();
    until(&mut first_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let started = until(&mut second_events, |body| matches!(body, Body::Permission { .. })).await;
    assert_eq!(types(&started), ["prompted", "permission"]);
}

#[tokio::test]
async fn limit_a_cancel_while_waiting_drops_the_prompt_and_frees_nothing() {
    let (_tmp, dir) = data_dir();
    let mock = mock(r#"{"prompt": null}
        {"sleep": 60000}"#);
    let harness = harness(&dir, &mock, 1);
    let (first, mut first_events) = open(&harness, false);
    let (second, mut second_events) = open(&harness, false);
    harness.send(&first, "one").unwrap();
    until(&mut first_events, |body| matches!(body, Body::Prompted { .. })).await;
    harness.send(&second, "two").unwrap();
    until(&mut second_events, |body| *body == Body::Waiting).await;
    harness.cancel(&second).unwrap();
    assert_eq!(next(&mut second_events).await.body, Body::TurnEnded { how: TurnEnd::Cancelled });
    harness.cancel(&first).unwrap();
    until(&mut first_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    quiet(&mut second_events, 200).await;
}

#[tokio::test]
async fn locked_a_locked_sessions_text_is_in_no_table() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"say": "pip-says-marmalade"}
        {"tool": {"name": "read_ticket", "input": {"key": "pip-reads-marmalade"}}}
        {"end": "done"}"#,
    );
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, true);
    harness.send(&id, "pip-hears-marmalade").unwrap();
    let live = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(live[2].body, Body::Text { text: "pip-says-marmalade".into() }, "the live client gets the text");

    let stored = harness.events(&id, 0).unwrap();
    assert_eq!(stored.iter().map(|event| event.seq).collect::<Vec<_>>(), live.iter().map(|event| event.seq).collect::<Vec<_>>());
    for (stored, live) in stored.iter().zip(&live) {
        assert_eq!(stored.body, Body::Withheld { of: live.body.type_name() });
    }
    assert!(!every_row(&dir).contains("marmalade"), "no table holds the text, the tool input or the prompt");
    assert!(!contains(&bytes_on_disk(&dir), "marmalade"), "no byte of the store's files does either");
}

/// Says its own tools token, and token shapes, as an agent could. Keeps the token so the test can look for it.
struct Tattler(Arc<std::sync::Mutex<String>>);

impl Driver for Tattler {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, String> {
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        let token = launch.tools_token.expose().to_owned();
        *self.0.lock().unwrap() = token.clone();
        output.send(Body::Started { provider_session: "tattler".into(), resumed: false }).unwrap();
        let text = format!("my token is {token} and my key is sk-ant-api03-{}", "x".repeat(40));
        output.send(Body::Text { text }).unwrap();
        let input = json!({ "headers": { "Authorization": format!("Bearer {token}") }, "env": [format!("GH_TOKEN=ghp_{}", "a".repeat(36))] });
        output.send(Body::ToolCall { id: "t1".into(), name: "curl".into(), input }).unwrap();
        tokio::spawn(async move {
            let _output = output;
            while commands_rx.recv().await.is_some_and(|command| command != Command::Stop) {}
        });
        Ok(Link { commands, output: receiver })
    }
}

#[tokio::test]
async fn redact_a_secret_in_agent_text_never_reaches_the_store() {
    let (_tmp, dir) = data_dir();
    let token = Arc::new(std::sync::Mutex::new(String::new()));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("tattler".into(), Arc::new(Tattler(token.clone())))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, 4);
    let spec = Open { provider: "tattler".into(), locked: false, cwd: "/nowhere".into(), model: None };
    let (id, mut events) = harness.open(spec).unwrap();
    let live = until(&mut events, |body| matches!(body, Body::ToolCall { .. })).await;
    let token = token.lock().unwrap().clone();
    assert_eq!(token.len(), 64);
    let shown = serde_json::to_string(&live).unwrap();
    assert!(shown.contains("my token is <redacted> and my key is <redacted>"), "{shown}");
    let leaks = [token.as_str(), "sk-ant-api03-", "ghp_"];
    for leak in leaks {
        assert!(!shown.contains(leak), "{leak} reached the client: {shown}");
    }
    assert_eq!(serde_json::to_string(&harness.events(&id, 0).unwrap()).unwrap(), shown, "the store holds the masked events");
    let (rows, disk) = (every_row(&dir), bytes_on_disk(&dir));
    for leak in leaks {
        assert!(!rows.contains(leak), "{leak} is in a table");
        assert!(!contains(&disk, leak), "{leak} is in the store's files");
    }
}

const HOLD: &str = r#"{"capabilities": {"tool_call_limit_ms": 200}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "which colour?"}}}
{"say": "after"}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn hold_a_client_tool_call_held_past_the_mock_limit_is_cut_with_a_timeout_result() {
    let (_tmp, dir) = data_dir();
    let mock = mock(HOLD);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false);
    harness.send(&id, "ask me").unwrap();
    let held = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let called = std::time::Instant::now();
    let Body::ClientToolCall { id: call, name, .. } = &held.last().unwrap().body else { unreachable!() };
    assert_eq!(name, "ask");
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert!(called.elapsed() >= std::time::Duration::from_millis(150), "held until the limit");
    assert_eq!(types(&rest), ["tool_result", "text", "turn_ended"]);
    assert_eq!(rest[0].body, Body::ToolResult { id: call.clone(), output: json!("timed out after 0 s"), error: true });
    let late = harness.tool_result(&id, call, json!("blue"), false);
    assert!(late.is_ok(), "a late result is taken and passed over");
}

#[tokio::test]
async fn hold_a_result_in_time_reaches_the_mock() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&HOLD.replace("200", "60000"));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false);
    harness.send(&id, "ask me").unwrap();
    let held = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let Body::ClientToolCall { id: call, .. } = &held.last().unwrap().body else { unreachable!() };
    harness.tool_result(&id, call, json!("blue"), false).unwrap();
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(rest[0].body, Body::ToolResult { id: call.clone(), output: json!("blue"), error: false });
    let received = mock.received(&provider_session(&held[0].body));
    assert_eq!(received[1], Command::ToolResult { id: call.clone(), output: json!("blue"), error: false });
}

const TURNS: &str = r#"{"prompt": null}
{"say": "one"}
{"end": "done"}
{"prompt": null}
{"say": "two"}
{"permission": {"kind": "command", "tool": "Bash"}}
{"say": "the rest of two"}
{"end": "done"}
{"prompt": null}
{"say": "three"}
{"end": "done"}"#;

#[tokio::test]
async fn resume_a_resumed_mock_session_gets_a_new_token_and_goes_on_from_where_it_stopped() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false);
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "first").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    harness.close(&id).unwrap();
    let closed = until(&mut events, |body| *body == Body::Closed).await;
    drop(harness);

    // The harness restarts on the same data folder; the agent goes on by its provider session id.
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    let harness = Harness::new(reopen(&dir).await, drivers, 4);
    let mut events = harness.resume(&id).unwrap();
    let started = next(&mut events).await;
    assert_eq!(started.body, Body::Started { provider_session: ps.clone(), resumed: true });
    assert_eq!(started.seq, closed.last().unwrap().seq + 1, "the numbers go on after a restart");
    let tokens = mock.tokens(&ps);
    assert_eq!(tokens.len(), 2);
    assert_ne!(tokens[0], tokens[1], "a resume gets a new token, never the old one");
    assert!(harness.resume(&id).is_err(), "a running session is not resumed twice");

    harness.send(&id, "second").unwrap();
    until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let mut events = harness.resume(&id).unwrap();
    next(&mut events).await;
    harness.send(&id, "third").unwrap();
    let third = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(third[1].body, Body::Text { text: "three".into() }, "the turn the stop cut is lost: {third:?}");
    assert_eq!(mock.tokens(&ps).len(), 3);
}

#[tokio::test]
async fn caps_the_mock_takes_its_capabilities_from_its_script() {
    let mock = mock(
        r#"{"capabilities": {"deny_ends_turn": true, "tool_call_limit_ms": 180000, "stop_kills_process_tree": true, "runs_locked_profile": false, "starts_turns_unprompted": true}}
        {"prompt": null}"#,
    );
    let expected = Capabilities {
        deny_ends_turn: true,
        tool_call_limit_ms: Some(180_000),
        stop_kills_process_tree: true,
        runs_locked_profile: false,
        starts_turns_unprompted: true,
    };
    assert_eq!(mock.capabilities(), expected);
    let unknown = harness::mock::Script::parse(r#"{"capabilities": {"deny_ends_turn": true, "codex": true}}"#);
    assert!(unknown.is_err(), "a flag the harness does not know is refused, not ignored");
}

#[tokio::test]
async fn caps_a_deny_ends_the_turn_where_the_script_says_so() {
    let (_tmp, dir) = data_dir();
    let script = r#"{"prompt": null}
        {"permission": {"kind": "command", "tool": "run_command"}}
        {"say": "never"}
        {"end": "done"}
        {"prompt": null}
        {"say": "next"}
        {"end": "done"}"#;
    for (deny_ends_turn, after) in [(true, "denied"), (false, "text")] {
        let mock = mock(&format!("{{\"capabilities\": {{\"deny_ends_turn\": {deny_ends_turn}}}}}\n{script}"));
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false);
        harness.send(&id, "go").unwrap();
        let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
        let Body::Permission { id: request, .. } = &asked.last().unwrap().body else { unreachable!() };
        harness.answer(&id, request, Decision::Deny).unwrap();
        let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
        let shown = match &rest[1].body {
            Body::TurnEnded { how: TurnEnd::Denied } => "denied",
            Body::Text { .. } => "text",
            other => panic!("{other:?}"),
        };
        assert_eq!(shown, after, "deny_ends_turn {deny_ends_turn}");
        harness.close(&id).unwrap();
        until(&mut events, |body| *body == Body::Closed).await;
        drop(harness);
        drop(reopen(&dir).await);
    }
}
