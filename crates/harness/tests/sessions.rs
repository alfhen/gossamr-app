mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use harness::driver::{Capabilities, Command, Driver, Launch, Link};
use harness::error::Error;
use harness::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use harness::session::Harness;
use harness::store::Store;
use serde_json::json;
use tokio::sync::{broadcast, mpsc};

fn provider_session(started: &Body) -> String {
    match started {
        Body::Started { provider_session, .. } => provider_session.clone(),
        other => panic!("expected started, got {other:?}"),
    }
}

fn permission_id(body: &Body) -> String {
    match body {
        Body::Permission { id, .. } => id.clone(),
        other => panic!("expected a permission request, got {other:?}"),
    }
}

async fn ask(events: &mut broadcast::Receiver<harness::event::Event>) -> String {
    permission_id(&until(events, |body| matches!(body, Body::Permission { .. })).await.last().unwrap().body)
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
    let (id, mut events) = open(&harness, false).await;
    harness.send(&id, "list the files").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    assert_eq!(types(&asked), ["started", "prompted", "turn_started", "text", "tool_call", "permission"]);
    let Body::Permission { id: request, kind, tool, input } = &asked[5].body else { unreachable!() };
    assert_eq!((*kind, tool.as_str(), input), (PermissionKind::Command, "Bash", &json!({"command": "ls"})));
    harness.answer(&id, request, Decision::Allow, None).unwrap();
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(types(&rest), ["answered", "tool_result", "turn_ended"]);
    assert_eq!(rest[2].body, Body::TurnEnded { how: TurnEnd::Done });

    let ps = provider_session(&asked[0].body);
    let answer = Command::Answer { id: "p1".into(), decision: Decision::Allow, message: None };
    assert_eq!(mock.received(&ps), [Command::Prompt("list the files".into()), answer], "the driver gets its own id back");
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
        {"end": "done"}
        {"prompt": null}"#,
    );
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    harness.send(&id, "one").unwrap();
    until(&mut events, |body| matches!(body, Body::Text { .. })).await;
    harness.cancel(&id).unwrap();
    assert_eq!(next(&mut events).await.body, Body::TurnEnded { how: TurnEnd::Cancelled });
    harness.send(&id, "two").unwrap();
    let second = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(types(&second), ["prompted", "turn_started", "text", "turn_ended"]);
    assert_eq!(second[2].body, Body::Text { text: "second".into() }, "the cancelled turn's rest is never played");
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
    let (id, mut events) = open(&harness, false).await;
    harness.send(&id, "one").unwrap();
    let failed = until(&mut events, |body| matches!(body, Body::Failed { .. })).await;
    let reason = "the model is not available".to_owned();
    assert_eq!(failed.last().unwrap().body, Body::Failed { kind: FailKind::Provider, reason });
    // With a limit of one, the next turn starts only if the failure gave its slot back.
    harness.send(&id, "two").unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&rest), ["prompted", "turn_started", "text", "failed", "closed"]);
    let reason = "the agent stopped in the middle of a turn".to_owned();
    assert_eq!(rest[3].body, Body::Failed { kind: FailKind::AgentStopped, reason });
    assert!(harness.send(&id, "three").is_err(), "a closed session takes no request");
}

#[tokio::test]
async fn life_a_store_that_fails_stops_the_session_and_says_so() {
    let (_tmp, dir) = data_dir();
    let mock = mock(LIFE);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute_batch("ALTER TABLE events RENAME TO gone").unwrap();
    harness.send(&id, "list the files").unwrap();
    let failed = next(&mut events).await;
    assert_eq!(failed.seq, 0, "no number could be given");
    assert!(matches!(&failed.body, Body::Failed { kind: FailKind::Harness, reason } if reason.starts_with("the store could not keep")));
    let closed = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(closed.last().unwrap().seq, 0);
    assert!(!mock.received(&ps).iter().any(|c| matches!(c, Command::Prompt(_))), "a prompt that could not be recorded is not sent");
}

#[tokio::test]
async fn answer_a_late_answer_after_a_resume_is_refused_and_reaches_no_request() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"permission": {"kind": "command", "tool": "Bash", "input": {"command": "rm -rf build"}}}
        {"end": "done"}
        {"prompt": null}
        {"permission": {"kind": "command", "tool": "Bash", "input": {"command": "git push --force"}}}
        {"end": "done"}"#,
    );
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    harness.send(&id, "clean").unwrap();
    let first = ask(&mut events).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let mut events = harness.resume(&id).await.unwrap();
    harness.send(&id, "push").unwrap();
    let second = ask(&mut events).await;
    assert_ne!(first, second, "the driver numbers its requests again after a resume; the harness does not");

    match harness.answer(&id, &first, Decision::Allow, None) {
        Err(Error::NotOpen(late)) => assert_eq!(late, first),
        other => panic!("a late answer must be refused, got {other:?}"),
    }
    quiet(&mut events, 200).await;
    let stored = harness.events(&id, 0).unwrap();
    assert!(!stored.iter().any(|event| matches!(&event.body, Body::Answered { .. })), "the late answer was not recorded");
    harness.answer(&id, &second, Decision::Deny, Some("not on main".into())).unwrap();
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let message = Some("not on main".to_owned());
    assert_eq!(rest[0].body, Body::Answered { id: second, decision: Decision::Deny, message });
}

#[tokio::test]
async fn answer_an_id_that_never_was_or_is_answered_or_whose_turn_ended_is_refused() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"permission": {"kind": "tool", "tool": "Read"}}
        {"permission": {"kind": "tool", "tool": "Read"}}
        {"end": "done"}
        {"prompt": null}"#,
    );
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    harness.send(&id, "go").unwrap();
    let first = ask(&mut events).await;
    assert!(matches!(harness.answer(&id, "p77", Decision::Allow, None), Err(Error::NotOpen(_))));
    harness.answer(&id, &first, Decision::Allow, None).unwrap();
    assert!(matches!(harness.answer(&id, &first, Decision::Allow, None), Err(Error::NotOpen(_))), "once only");
    let second = ask(&mut events).await;
    harness.cancel(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert!(matches!(harness.answer(&id, &second, Decision::Allow, None), Err(Error::NotOpen(_))), "its turn ended");
    let answered = harness.events(&id, 0).unwrap().into_iter().filter(|event| matches!(event.body, Body::Answered { .. })).count();
    assert_eq!(answered, 1);
}

#[tokio::test]
async fn limit_a_session_past_the_turn_limit_waits_until_a_slot_frees() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"permission": {"kind": "tool", "tool": "Read"}}
        {"end": "done"}
        {"prompt": null}"#,
    );
    let harness = harness(&dir, &mock, 1);
    let (first, mut first_events) = open(&harness, false).await;
    let (second, mut second_events) = open(&harness, false).await;
    harness.send(&first, "one").unwrap();
    let request = ask(&mut first_events).await;
    harness.send(&second, "two").unwrap();
    let waiting = until(&mut second_events, |body| *body == Body::Waiting).await;
    assert_eq!(types(&waiting), ["started", "waiting"]);
    quiet(&mut second_events, 200).await;
    assert!(mock.received(&provider_session(&waiting[0].body)).is_empty(), "the prompt is held, not sent");

    harness.answer(&first, &request, Decision::Deny, None).unwrap();
    until(&mut first_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let started = until(&mut second_events, |body| matches!(body, Body::Permission { .. })).await;
    assert_eq!(types(&started), ["prompted", "turn_started", "permission"]);
}

#[tokio::test]
async fn limit_a_cancel_while_waiting_drops_the_prompt_and_frees_nothing() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"sleep": 60000}
        {"prompt": null}"#,
    );
    let harness = harness(&dir, &mock, 1);
    let (first, mut first_events) = open(&harness, false).await;
    let (second, mut second_events) = open(&harness, false).await;
    harness.send(&first, "one").unwrap();
    until(&mut first_events, |body| matches!(body, Body::TurnStarted)).await;
    harness.send(&second, "two").unwrap();
    until(&mut second_events, |body| *body == Body::Waiting).await;
    harness.cancel(&second).unwrap();
    assert_eq!(next(&mut second_events).await.body, Body::TurnEnded { how: TurnEnd::Cancelled });
    harness.cancel(&first).unwrap();
    until(&mut first_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    quiet(&mut second_events, 200).await;
}

#[tokio::test]
async fn limit_a_turn_the_agent_starts_by_itself_takes_a_slot_and_a_prompt_waits_for_its_end() {
    let (_tmp, dir) = data_dir();
    let unprompted = mock(
        r#"{"prompt": null}
        {"say": "first"}
        {"end": "done"}
        "turn"
        {"permission": {"kind": "tool", "tool": "Workflow"}}
        {"end": "done"}
        {"prompt": null}
        {"say": "after"}
        {"end": "done"}
        {"prompt": null}"#,
    );
    let other = mock(r#"{"prompt": null}
        {"say": "other"}
        {"end": "done"}
        {"prompt": null}"#);
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("a".into(), Arc::new(unprompted)), ("b".into(), Arc::new(other))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));
    let (a, mut a_events) = open_on(&harness, "a", false).await;
    let (b, mut b_events) = open_on(&harness, "b", false).await;
    harness.send(&a, "one").unwrap();
    until(&mut a_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let by_itself = until(&mut a_events, |body| matches!(body, Body::Permission { .. })).await;
    assert_eq!(types(&by_itself), ["turn_started", "permission"], "no prompt started it");
    let request = permission_id(&by_itself[1].body);

    harness.send(&a, "two").unwrap();
    harness.send(&b, "three").unwrap();
    until(&mut b_events, |body| *body == Body::Waiting).await;
    quiet(&mut a_events, 200).await;

    harness.answer(&a, &request, Decision::Allow, None).unwrap();
    let a_rest = until(&mut a_events, |body| *body == Body::Waiting).await;
    assert_eq!(types(&a_rest), ["answered", "turn_ended", "waiting"], "A's prompt waits behind B, which came first");
    until(&mut b_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let a_after = until(&mut a_events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(types(&a_after), ["prompted", "turn_started", "text", "turn_ended"]);
}

#[tokio::test]
async fn limit_a_stopped_session_keeps_its_slot_until_its_agent_has_gone() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> =
        vec![("slow".into(), Arc::new(SlowToStop { kill: None })), ("mock".into(), Arc::new(mock(LIFE)))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));
    let (slow, mut slow_events) = open_on(&harness, "slow", false).await;
    let (other, mut other_events) = open(&harness, false).await;
    harness.send(&slow, "run something long").unwrap();
    until(&mut slow_events, |body| matches!(body, Body::TurnStarted)).await;
    harness.send(&other, "next").unwrap();
    until(&mut other_events, |body| *body == Body::Waiting).await;
    let stopped = Instant::now();
    harness.close(&slow).unwrap();
    assert!(matches!(harness.resume(&slow).await, Err(Error::Running(_))), "no resume while the old agent runs");
    assert!(matches!(harness.clean_up(&slow), Err(Error::Running(_))), "no clean-up while it runs");
    let gone = until(&mut slow_events, |body| *body == Body::Closed).await;
    assert_eq!(types(&gone), ["text", "closed"], "what the agent says while it stops is kept");
    until(&mut other_events, |body| matches!(body, Body::Prompted { .. })).await;
    assert!(stopped.elapsed() >= Duration::from_millis(200), "the slot was held until the agent had gone");
}

#[tokio::test]
async fn limit_an_agent_that_will_not_stop_is_killed_after_the_grace_and_the_session_says_so() {
    let (_tmp, dir) = data_dir();
    let killed = Arc::new(Mutex::new(false));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("stubborn".into(), Arc::new(SlowToStop { kill: Some(killed.clone()) }))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));
    let (id, mut events) = open_on(&harness, "stubborn", false).await;
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert!(*killed.lock().unwrap(), "the driver was told to kill");
    let reason = "the agent was still running 300 ms after the stop, so it was killed".to_owned();
    assert!(rest.iter().any(|event| event.body == Body::Failed { kind: FailKind::AgentStopped, reason: reason.clone() }), "{rest:?}");
}

#[tokio::test]
async fn locked_a_locked_sessions_text_is_in_no_table_and_its_other_fields_are_kept() {
    let (_tmp, dir) = data_dir();
    let mock = mock(
        r#"{"prompt": null}
        {"say": "pip-says-marmalade"}
        {"tool": {"name": "read_ticket", "input": {"key": "pip-reads-marmalade"}}}
        {"permission": {"kind": "tool", "tool": "read_ticket", "input": {"key": "pip-asks-marmalade"}}}
        {"end": "done"}"#,
    );
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, true).await;
    harness.send(&id, "pip-hears-marmalade").unwrap();
    let mut live = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    let request = permission_id(&live.last().unwrap().body);
    harness.answer(&id, &request, Decision::Deny, Some("marmalade is private".into())).unwrap();
    live.extend(until(&mut events, |body| *body == Body::Closed).await);
    assert!(live.iter().any(|event| event.body == Body::Text { text: "pip-says-marmalade".into() }), "the live client gets the text");

    let stored = harness.events(&id, 0).unwrap();
    assert_eq!(stored.iter().map(|event| event.seq).collect::<Vec<_>>(), live.iter().map(|event| event.seq).collect::<Vec<_>>());
    let kept: Vec<(String, serde_json::Value)> = stored
        .iter()
        .map(|event| match &event.body {
            Body::Withheld { of, kept } => (of.clone(), serde_json::Value::Object(kept.clone())),
            other => panic!("a locked session's event was stored whole: {other:?}"),
        })
        .collect();
    assert!(kept.contains(&("permission".into(), json!({"id": request, "kind": "tool", "tool": "read_ticket"}))), "{kept:?}");
    assert!(kept.contains(&("answered".into(), json!({"id": request, "decision": "deny"}))), "{kept:?}");
    assert!(kept.contains(&("turn_ended".into(), json!({"how": "done"}))), "{kept:?}");
    assert!(!every_row(&dir).contains("marmalade"), "no table holds the text, the inputs, the prompt or the deny message");
    assert!(!contains(&bytes_on_disk(&dir), "marmalade"), "no byte of the store's files does either");
}

/// Says its own tools token, and token shapes, as an agent could. Keeps the token so the test can look for it.
struct Tattler(Arc<Mutex<String>>);

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
        let input = json!({
            "headers": { "Authorization": format!("Bearer {token}") },
            "env": [format!("GH_TOKEN=ghp_{}", "a".repeat(36))],
            token.clone(): "a secret can be a key",
        });
        output.send(Body::ToolCall { id: "t1".into(), name: "curl".into(), input }).unwrap();
        // A token cut between two pieces of streamed text.
        output.send(Body::TextDelta { text: "streamed: sk-ant-api03-".into() }).unwrap();
        output.send(Body::TextDelta { text: format!("{} and done", "y".repeat(40)) }).unwrap();
        output.send(Body::Text { text: format!("streamed: sk-ant-api03-{} and done", "y".repeat(40)) }).unwrap();
        tokio::spawn(async move {
            let _output = output;
            while commands_rx.recv().await.is_some_and(|command| command != Command::Stop) {}
        });
        Ok(Link { commands, output: receiver })
    }
}

#[tokio::test]
async fn redact_a_secret_in_agent_text_never_reaches_the_store_or_a_client() {
    let (_tmp, dir) = data_dir();
    let token = Arc::new(Mutex::new(String::new()));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("tattler".into(), Arc::new(Tattler(token.clone())))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "tattler", false).await;
    let live = until(&mut events, |body| matches!(body, Body::Text { text } if text.starts_with("streamed"))).await;
    let token = token.lock().unwrap().clone();
    assert_eq!(token.len(), 64);
    let shown = serde_json::to_string(&live).unwrap();
    assert!(shown.contains("my token is <redacted> and my key is <redacted>"), "{shown}");
    let leaks = [token.as_str(), "sk-ant-api03-", "ghp_", "yyyyyyyy"];
    for leak in leaks {
        assert!(!shown.contains(leak), "{leak} reached the client: {shown}");
    }
    let deltas: String = live.iter().filter_map(|event| match &event.body { Body::TextDelta { text } => Some(text.as_str()), _ => None }).collect();
    assert_eq!(deltas, "streamed: <redacted> and done", "the cut token is masked whole in what the client sees");
    assert!(live.iter().all(|event| !matches!(event.body, Body::TextDelta { .. }) || event.seq == 0), "deltas are not numbered");

    let stored = harness.events(&id, 0).unwrap();
    assert!(stored.iter().all(|event| !matches!(event.body, Body::TextDelta { .. })), "deltas are never stored");
    let stored_whole: Vec<_> = live.iter().filter(|event| event.seq != 0).cloned().collect();
    assert_eq!(stored, stored_whole, "the store holds the masked events");
    let (rows, disk) = (every_row(&dir), bytes_on_disk(&dir));
    for leak in leaks {
        assert!(!rows.contains(leak), "{leak} is in a table");
        assert!(!contains(&disk, leak), "{leak} is in the store's files");
    }
}

/// Fails to open, quoting its token as a careless provider error could.
struct Refuser;

impl Driver for Refuser {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, String> {
        Err(format!("could not start with token {}", launch.tools_token.expose()))
    }
}

#[tokio::test]
async fn redact_a_drivers_error_is_masked_and_frees_the_session() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("refuser".into(), Arc::new(Refuser))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let spec = harness::session::Open { provider: "refuser".into(), locked: false, cwd: "/nowhere".into(), model: None };
    match harness.open(spec).await {
        Err(Error::Driver(message)) => assert_eq!(message, "could not start with token <redacted>"),
        other => panic!("{:?}", other.map(|(id, _)| id)),
    }
}

const HOLD: &str = r#"{"capabilities": {"tool_call_limit_ms": 200}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "which colour?"}}}
{"say": "after"}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn hold_a_client_tool_call_held_past_the_limit_is_cut_with_a_timeout_result() {
    let (_tmp, dir) = data_dir();
    let mock = mock(HOLD);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    let sent = Instant::now();
    harness.send(&id, "ask me").unwrap();
    let held = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let Body::ClientToolCall { id: call, name, .. } = &held.last().unwrap().body else { unreachable!() };
    assert_eq!(name, "ask");
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert!(sent.elapsed() >= Duration::from_millis(200), "held until the limit");
    assert_eq!(types(&rest), ["tool_result", "text", "turn_ended"]);
    assert_eq!(rest[0].body, Body::ToolResult { id: call.clone(), output: json!("timed out after 200 ms"), error: true });
    assert_eq!(mock.replies(&ps), [Err("timed out after 200 ms".to_owned())], "the agent's call was cut");
    harness.tool_result(&id, call, json!("blue"), false).unwrap();
    quiet(&mut events, 100).await;
}

#[tokio::test]
async fn hold_a_result_in_time_reaches_the_agent_through_the_tools_endpoint() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&HOLD.replace("200", "60000"));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "ask me").unwrap();
    let held = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let Body::ClientToolCall { id: call, .. } = &held.last().unwrap().body else { unreachable!() };
    harness.tool_result(&id, call, json!("blue"), false).unwrap();
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(rest[0].body, Body::ToolResult { id: call.clone(), output: json!("blue"), error: false });
    let reply = harness::tools::Reply { output: json!("blue"), error: false };
    assert_eq!(mock.replies(&ps), [Ok(reply)]);
    assert!(!mock.received(&ps).iter().any(|c| !matches!(c, Command::Prompt(_))), "the result did not go through the driver");
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
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn resume_a_resumed_mock_session_gets_a_new_token_and_goes_on_from_where_it_stopped() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "first").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    harness.close(&id).unwrap();
    let closed = until(&mut events, |body| *body == Body::Closed).await;
    drop(harness);

    // The harness restarts on the same data folder; the agent goes on by its provider session id.
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    let mut events = harness.resume(&id).await.unwrap();
    let started = next(&mut events).await;
    assert_eq!(started.body, Body::Started { provider_session: ps.clone(), resumed: true });
    assert_eq!(started.seq, closed.last().unwrap().seq + 1, "the numbers go on after a restart");
    let tokens = mock.tokens(&ps);
    assert_eq!(tokens.len(), 2);
    assert_ne!(tokens[0], tokens[1], "a resume gets a new token, never the old one");
    assert!(matches!(harness.resume(&id).await, Err(Error::Running(_))), "a running session is not resumed twice");

    harness.send(&id, "second").unwrap();
    ask(&mut events).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let mut events = harness.resume(&id).await.unwrap();
    next(&mut events).await;
    harness.send(&id, "third").unwrap();
    let third = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(third[2].body, Body::Text { text: "three".into() }, "the turn the stop cut is lost: {third:?}");
    assert_eq!(mock.tokens(&ps).len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_two_resumes_at_once_one_wins_and_one_is_refused() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    for _ in 0..100 {
        let both = [0, 1].map(|_| {
            let (harness, id) = (harness.clone(), id.clone());
            tokio::spawn(async move { harness.resume(&id).await })
        });
        let mut won = vec![];
        for resume in both {
            match resume.await.unwrap() {
                Ok(events) => won.push(events),
                Err(Error::Running(_)) => {}
                Err(e) => panic!("{e}"),
            }
        }
        assert_eq!(won.len(), 1, "exactly one resume wins");
        harness.close(&id).unwrap();
        until(&mut won[0], |body| *body == Body::Closed).await;
    }
    assert_eq!(mock.tokens(&ps).len(), 101, "one start and a hundred resumes, never two at once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_close_then_resume_then_send_with_no_sleep_plays_the_turn_every_time() {
    let (_tmp, dir) = data_dir();
    let turn = "{\"prompt\": null}\n{\"say\": \"answered\"}\n{\"end\": \"done\"}\n";
    let mock = mock(&turn.repeat(101));
    let harness = harness(&dir, &mock, 1);
    let (id, _) = open(&harness, false).await;
    for _ in 0..100 {
        harness.close(&id).unwrap();
        let mut events = loop {
            match harness.resume(&id).await {
                Ok(events) => break events,
                Err(Error::Running(_)) => tokio::task::yield_now().await,
                Err(e) => panic!("{e}"),
            }
        };
        harness.send(&id, "go").unwrap();
        let turn = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
        assert_eq!(types(&turn), ["started", "prompted", "turn_started", "text", "turn_ended"]);
    }
}

#[tokio::test]
async fn resume_a_cleaned_up_session_is_refused() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    harness.clean_up(&id).unwrap();
    assert!(matches!(harness.resume(&id).await, Err(Error::CleanedUp(_))));
}

#[tokio::test]
async fn resume_a_resume_that_cannot_open_leaves_the_session_free() {
    let (_tmp, dir) = data_dir();
    let harness = harness(&dir, &mock(TURNS), 4);
    let (id, mut events) = open(&harness, false).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    drop(harness);
    // A mock that never saw the session cannot resume it.
    let harness = harness_on(reopen(&dir).await, &mock(TURNS), 4);
    assert!(matches!(harness.resume(&id).await, Err(Error::Driver(_))));
    assert!(matches!(harness.send(&id, "x"), Err(Error::NotRunning(_))), "no reservation is left behind");
    assert!(matches!(harness.resume(&id).await, Err(Error::Driver(_))), "and it can be tried again");
}

#[tokio::test]
async fn mock_a_prompt_that_comes_while_the_mock_waits_is_kept_for_the_next_turn() {
    let mock = mock(
        r#"{"prompt": null}
        {"sleep": 100}
        {"say": "one"}
        {"end": "done"}
        {"prompt": null}
        {"say": "two"}
        {"end": "done"}"#,
    );
    let tools = Arc::new(harness::tools::Endpoint::unattached("t"));
    let launch = Launch { cwd: "/".into(), locked: false, model: None, resume: None, tools_token: harness::driver::Secret::random(), tools };
    let mut link = mock.open(launch).unwrap();
    link.commands.send(Command::Prompt("first".into())).unwrap();
    link.commands.send(Command::Prompt("second, early".into())).unwrap();
    let mut texts = vec![];
    while let Some(body) = tokio::time::timeout(Duration::from_secs(5), link.output.recv()).await.unwrap() {
        if let Body::Text { text } = body {
            texts.push(text);
        }
    }
    assert_eq!(texts, ["one", "two"], "the early prompt started the second turn");
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
    let script = r#"{"prompt": null}
        {"permission": {"kind": "command", "tool": "run_command"}}
        {"say": "never"}
        {"end": "done"}
        {"prompt": null}"#;
    for (deny_ends_turn, after) in [(true, "denied"), (false, "text")] {
        let (_tmp, dir) = data_dir();
        let mock = mock(&format!("{{\"capabilities\": {{\"deny_ends_turn\": {deny_ends_turn}}}}}\n{script}"));
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        harness.send(&id, "go").unwrap();
        let request = ask(&mut events).await;
        harness.answer(&id, &request, Decision::Deny, None).unwrap();
        let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
        let shown = match &rest[1].body {
            Body::TurnEnded { how: TurnEnd::Denied } => "denied",
            Body::Text { .. } => "text",
            other => panic!("{other:?}"),
        };
        assert_eq!(shown, after, "deny_ends_turn {deny_ends_turn}");
    }
}

/// Takes a while to go after a stop, as an agent with a command running can; with `kill` set it goes only when killed.
struct SlowToStop {
    kill: Option<Arc<Mutex<bool>>>,
}

impl Driver for SlowToStop {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, _launch: Launch) -> Result<Link, String> {
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        output.send(Body::Started { provider_session: "slow".into(), resumed: false }).unwrap();
        let kill = self.kill.clone();
        tokio::spawn(async move {
            loop {
                match commands_rx.recv().await {
                    Some(Command::Prompt(_)) => {
                        let _ = output.send(Body::TurnStarted);
                    }
                    Some(Command::Stop) if kill.is_none() => break,
                    Some(Command::Kill) => {
                        *kill.as_ref().unwrap().lock().unwrap() = true;
                        return;
                    }
                    None => return,
                    _ => {}
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = output.send(Body::Text { text: "stopped at last".into() });
        });
        Ok(Link { commands, output: receiver })
    }
}

#[tokio::test]
async fn retention_a_running_harness_withholds_payload_once_it_is_30_days_old() {
    let (_tmp, dir) = data_dir();
    let harness = harness(&dir, &mock(LIFE), 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    let old = harness::store::now_ms() - harness::store::KEEP_MS - 1;
    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute("UPDATE events SET ms = ?1 WHERE seq = 1", [old]).unwrap();
    let stored = harness.events(&id, 0).unwrap();
    assert!(matches!(&stored[0].body, Body::Withheld { of, .. } if of == "started"), "a read sweeps first: {stored:?}");
}

#[tokio::test]
async fn life_an_answer_that_cannot_be_recorded_is_not_sent_and_nothing_is_written_after_the_failure() {
    let (_tmp, dir) = data_dir();
    let mock = mock(LIFE);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    harness.send(&id, "list the files").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    let ps = provider_session(&asked[0].body);
    let request = permission_id(&asked.last().unwrap().body);
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute_batch("ALTER TABLE events RENAME TO gone").unwrap();
    harness.answer(&id, &request, Decision::Allow, None).unwrap();
    let failed = next(&mut events).await;
    assert!(matches!(failed.body, Body::Failed { kind: FailKind::Harness, .. }) && failed.seq == 0, "{failed:?}");
    // The store takes writes again before the session has closed.
    raw.execute_batch("ALTER TABLE gone RENAME TO events").unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert!(rest.iter().all(|event| event.seq == 0), "nothing is numbered after the failure: {rest:?}");
    assert!(!mock.received(&ps).iter().any(|c| matches!(c, Command::Answer { .. })), "an answer that could not be recorded is not sent");
    assert_eq!(harness.events(&id, 0).unwrap().len(), asked.len(), "nothing was written after the failure");
}

#[tokio::test]
async fn life_a_store_that_comes_back_after_a_failure_gets_nothing_more_from_the_session() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("slow".into(), Arc::new(SlowToStop { kill: None }))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "slow", false).await;
    next(&mut events).await;
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute_batch("ALTER TABLE events RENAME TO gone").unwrap();
    harness.send(&id, "go").unwrap();
    assert!(matches!(next(&mut events).await.body, Body::Failed { kind: FailKind::Harness, .. }));
    // Back before the agent, which takes 200 ms to stop, has said its last word.
    raw.execute_batch("ALTER TABLE gone RENAME TO events").unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert!(rest.iter().all(|event| event.seq == 0), "{rest:?}");
    assert_eq!(harness.events(&id, 0).unwrap().len(), 1, "only `started`, from before the failure, is stored");
}
