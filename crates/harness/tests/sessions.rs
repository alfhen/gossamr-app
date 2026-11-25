mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use harness::driver::{Capabilities, Command, Driver, Launch, Link, OpenError};
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
    assert_eq!(next(&mut second_events).await.body, Body::PromptsDropped, "no turn end without a turn start");
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
        vec![("slow".into(), Arc::new(Stopper { going: Going::Slowly })), ("mock".into(), Arc::new(mock(LIFE)))];
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
    assert!(matches!(harness.clean_up(&slow).await, Err(Error::Running(_))), "no clean-up while it runs");
    let gone = until(&mut slow_events, |body| *body == Body::Closed).await;
    assert_eq!(types(&gone), ["text", "failed", "closed"], "what the agent says while it stops is kept, and its open turn ends");
    until(&mut other_events, |body| matches!(body, Body::Prompted { .. })).await;
    assert!(stopped.elapsed() >= Duration::from_millis(200), "the slot was held until the agent had gone");
}

#[tokio::test]
async fn limit_an_agent_that_will_not_stop_is_killed_after_the_grace_and_the_session_says_so() {
    let (_tmp, dir) = data_dir();
    let killed = Arc::new(Mutex::new(false));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("stubborn".into(), Arc::new(Stopper { going: Going::WhenKilled(killed.clone()) }))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));
    let (id, mut events) = open_on(&harness, "stubborn", false).await;
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert!(*killed.lock().unwrap(), "the driver was told to kill");
    let reason = "the agent was still running 300 ms after the stop, so the driver was told to kill it".to_owned();
    assert_eq!(types(&rest), ["started", "failed", "closed"]);
    assert_eq!(rest[1].body, Body::Failed { kind: FailKind::AgentStopped, reason });
}

#[tokio::test]
async fn limit_an_agent_that_ignores_stop_and_kill_keeps_its_session_taken_until_it_goes() {
    let (_tmp, dir) = data_dir();
    let let_go = Arc::new(tokio::sync::Notify::new());
    let drivers: Vec<(String, Arc<dyn Driver>)> =
        vec![("stuck".into(), Arc::new(Stopper { going: Going::WhenLet(let_go.clone()) })), ("mock".into(), Arc::new(mock(LIFE)))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));
    let (id, mut events) = open_on(&harness, "stuck", false).await;
    harness.send(&id, "run").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnStarted)).await;
    let (other, mut other_events) = open(&harness, false).await;
    harness.send(&other, "next").unwrap();
    until(&mut other_events, |body| *body == Body::Waiting).await;
    harness.close(&id).unwrap();
    let stuck = until(&mut events, |body| matches!(body, Body::Failed { kind: FailKind::Stuck, .. })).await;
    assert_eq!(types(&stuck), ["failed", "failed"], "told to kill, then stuck: {stuck:?}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(matches!(harness.resume(&id).await, Err(Error::Running(_))), "never freed on a timer");
    assert!(matches!(harness.clean_up(&id).await, Err(Error::Running(_))));
    quiet(&mut other_events, 100).await;
    assert!(!harness.events(&other, 0).unwrap().iter().any(|event| matches!(event.body, Body::Prompted { .. })), "its slot is still taken");

    let_go.notify_one();
    until(&mut events, |body| *body == Body::Closed).await;
    until(&mut other_events, |body| matches!(body, Body::Prompted { .. })).await;
    assert!(!matches!(harness.resume(&id).await, Err(Error::Running(_))), "free once the agent has gone");
}

#[tokio::test]
async fn limit_a_stopping_session_refuses_requests() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("slow".into(), Arc::new(Stopper { going: Going::Slowly }))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));
    let (id, mut events) = open_on(&harness, "slow", false).await;
    harness.close(&id).unwrap();
    assert!(matches!(harness.send(&id, "late"), Err(Error::NotRunning(_))));
    assert!(matches!(harness.answer(&id, "p1", Decision::Allow, None), Err(Error::NotRunning(_))));
    assert!(matches!(harness.tool_result(&id, "c1", json!(1), false), Err(Error::NotRunning(_))));
    until(&mut events, |body| *body == Body::Closed).await;
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
            other => panic!("a locked session's `{}` event was stored whole", other.type_name()),
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

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
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
        output.send(Body::Text { text: format!("last: sk-ant-api03-{} and done", "y".repeat(40)) }).unwrap();
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
    let live = until(&mut events, |body| matches!(body, Body::Text { text } if text.starts_with("last"))).await;
    let token = token.lock().unwrap().clone();
    assert_eq!(token.len(), 64);
    let shown = serde_json::to_string(&live).unwrap();
    // A failure names the case and where it showed, never the token or the payload.
    assert!(shown.contains("my token is <redacted> and my key is <redacted>"), "the text is not masked as expected");
    let leaks = [("the session's token", token.as_str()), ("an Anthropic key", "sk-ant-api03-"), ("a GitHub token", "ghp_"), ("the end of a key", "yyyyyyyy")];
    for (label, leak) in leaks {
        assert!(!shown.contains(leak), "{label} reached the client");
    }
    assert!(shown.contains("last: <redacted> and done"), "the last text is not masked as expected");

    let stored = harness.events(&id, 0).unwrap();
    assert!(stored == live, "the store holds the masked events");
    let (rows, disk) = (every_row(&dir), bytes_on_disk(&dir));
    for (label, leak) in leaks {
        assert!(!rows.contains(leak), "{label} is in a table");
        assert!(!contains(&disk, leak), "{label} is in the store's files");
    }
}

/// Fails to open, quoting its token as a careless provider error could.
struct Refuser;

impl Driver for Refuser {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let message = format!("not signed in; tried token {}", launch.tools_token.expose());
        Err(OpenError { kind: FailKind::SignedOut, message })
    }
}

#[tokio::test]
async fn redact_a_drivers_error_is_masked_keeps_its_kind_and_frees_the_session() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("refuser".into(), Arc::new(Refuser))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let spec = harness::session::Open { provider: "refuser".into(), locked: false, cwd: "/nowhere".into(), ..Default::default() };
    match harness.open(spec).await {
        Err(Error::Open { kind, message }) => {
            assert_eq!(kind, FailKind::SignedOut, "the kind reaches the client");
            assert!(message == "not signed in; tried token <redacted>", "the error is not masked as expected");
        }
        Ok(_) => panic!("the open did not fail"),
        Err(_) => panic!("the open failed some other way"),
    }
}

const HOLD: &str = r#"{"capabilities": {"tool_call_limit_ms": 200}}
{"prompt": null}
{"call": {"name": "choose", "input": {"question": "which colour?"}}}
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
    assert_eq!(name, "choose");
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert!(sent.elapsed() >= Duration::from_millis(200), "held until the limit");
    assert_eq!(types(&rest), ["tool_result", "tool_result", "text", "turn_ended"]);
    assert_eq!(rest[0].body, Body::ToolResult { id: call.clone(), output: json!("timed out after 200 ms"), error: true });
    assert!(matches!(&rest[1].body, Body::ToolResult { output, error: true, .. } if *output == json!("timed out after 200 ms")), "the agent says what it got");
    assert_eq!(mock.replies(&ps), [Ok(harness::tools::Reply::failed("timed out after 200 ms"))], "the agent's call was cut");
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
    harness.clean_up(&id).await.unwrap();
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
    assert!(matches!(harness.resume(&id).await, Err(Error::Open { .. })));
    assert!(matches!(harness.send(&id, "x"), Err(Error::NotRunning(_))), "no reservation is left behind");
    assert!(matches!(harness.resume(&id).await, Err(Error::Open { .. })), "and it can be tried again");
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
    let tools = harness::tools::ToolsEndpoint::unattached();
    let launch = Launch { cwd: "/".into(), locked: false, model: None, login: None, effort: None, resume: None, tools_token: harness::driver::Secret::random(), tools, result_schema: None, env: vec![] };
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
        r#"{"capabilities": {"deny_ends_turn": true, "tool_call_limit_ms": 180000, "stop_kills_process_tree": true, "runs_locked_profile": false, "starts_turns_unprompted": true, "stop_takes_up_to_ms": 30000}}
        {"prompt": null}"#,
    );
    let expected = Capabilities {
        deny_ends_turn: true,
        tool_call_limit_ms: Some(180_000),
        stop_kills_process_tree: true,
        runs_locked_profile: false,
        starts_turns_unprompted: true,
        stop_takes_up_to_ms: Some(30_000),
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

#[tokio::test]
async fn retention_a_catch_up_read_writes_nothing() {
    let (_tmp, dir) = data_dir();
    let harness = harness(&dir, &mock(LIFE), 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    let old = harness::store::now_ms() - harness::store::KEEP_MS - 1;
    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute("UPDATE events SET ms = ?1 WHERE seq = 1", [old]).unwrap();
    let before = std::fs::read(dir.join("harness.sqlite")).unwrap();
    let stored = harness.events(&id, 0).unwrap();
    let (watched, more, _, _live) = harness.watch(&id, 0).unwrap();
    assert!(!more);
    assert!(std::fs::read(dir.join("harness.sqlite")).unwrap() == before, "the store file is unchanged by the reads");
    assert!(matches!(&stored[0].body, Body::Started { .. }), "a read does not sweep: {stored:?}");
    assert_eq!(stored, watched);
    open(&harness, false).await;
    assert!(matches!(&harness.events(&id, 0).unwrap()[0].body, Body::Started { .. }), "nor does opening a session");
    assert_eq!(harness.sweep().unwrap(), 1, "the sweep, run on its own, withholds the old event");
    assert!(matches!(&harness.events(&id, 0).unwrap()[0].body, Body::Withheld { of, .. } if of == "started"));
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
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("slow".into(), Arc::new(Stopper { going: Going::Slowly }))];
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

/// Plays lists of events: one list per open, taken in order, with `{token}` replaced by the session's tools token.
/// With `on_prompt` it plays its list on every prompt instead of at once.
struct Says {
    lists: Mutex<std::collections::VecDeque<Vec<Body>>>,
    on_prompt: bool,
    panics: bool,
}

impl Says {
    fn new(lists: Vec<Vec<Body>>, on_prompt: bool) -> Says {
        Says { lists: Mutex::new(lists.into()), on_prompt, panics: false }
    }
}

impl Driver for Says {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        assert!(!self.panics, "a driver that panics as it opens");
        let token = launch.tools_token.expose().to_owned();
        let list = self.lists.lock().unwrap().pop_front().unwrap_or_default();
        let list: Vec<Body> = list
            .into_iter()
            .map(|body| serde_json::from_str(&serde_json::to_string(&body).unwrap().replace("{token}", &token)).unwrap())
            .collect();
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        output.send(Body::Started { provider_session: format!("says-{}", harness::driver::random_hex(4)), resumed: false }).unwrap();
        if !self.on_prompt {
            list.iter().for_each(|body| output.send(body.clone()).unwrap());
        }
        let on_prompt = self.on_prompt;
        tokio::spawn(async move {
            while let Some(command) = commands_rx.recv().await {
                match command {
                    Command::Prompt(_) if on_prompt => list.iter().for_each(|body| {
                        let _ = output.send(body.clone());
                    }),
                    Command::Stop => return,
                    _ => {}
                }
            }
        });
        Ok(Link { commands, output: receiver })
    }
}

/// The example of each shape whose secret has no fixed end, so that a secret written straight after it can look like
/// more of it.
fn open_ended() -> Vec<&'static harness::redact::Shape> {
    harness::redact::SHAPES
        .iter()
        .filter(|shape| {
            let example = (shape.example)();
            let pattern = regex::Regex::new(&format!("^(?:{})", shape.pattern)).unwrap();
            pattern.find(&format!("{example}Ab3")).is_some_and(|found| found.end() > example.len())
        })
        .collect()
}

/// Whether an 8-character stretch of `secret` after its first `public` characters is among `seen`'s stretches.
fn leaks(seen: &std::collections::HashSet<&[u8]>, public: usize, secret: &str) -> bool {
    secret.as_bytes()[public..].windows(8).any(|window| seen.contains(window))
}

#[tokio::test]
async fn redact_a_secret_glued_straight_onto_an_open_ended_token_is_masked_with_it_in_the_store_and_for_every_client() {
    let (_tmp, dir) = data_dir();
    let open_ended = open_ended();
    assert!(open_ended.len() >= 10, "most shapes have no fixed end");
    let mut pairs = vec![];
    for first in &open_ended {
        for second in harness::redact::SHAPES.iter().filter(|shape| shape.name != first.name) {
            pairs.push((first.name, second.name, format!("{}{}", (first.example)(), (second.example)())));
        }
    }
    let says: Vec<Body> = pairs.iter().map(|(_, _, glued)| Body::Text { text: format!("note: {glued} end") }).collect();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("says".into(), Arc::new(Says::new(vec![says], false)))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "says", false).await;
    let mut shown = vec![];
    while shown.len() < pairs.len() {
        let body = next(&mut events).await.body;
        if let Body::Text { .. } = body {
            shown.push(body);
        }
    }
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let disk = bytes_on_disk(&dir);
    let disk: std::collections::HashSet<&[u8]> = disk.windows(8).collect();
    for ((first, second, glued), body) in pairs.iter().zip(&shown) {
        assert!(*body == Body::Text { text: "note: <redacted> end".into() }, "{first} then {second}: not masked as expected");
        let public = harness::redact::SHAPES.iter().find(|shape| shape.name == *first).unwrap().markers.iter().map(|marker| marker.len()).min().unwrap();
        assert!(!leaks(&disk, public, glued), "{first} then {second}: in the store's files");
    }
    assert!(pairs.len() > 140, "{} pairs", pairs.len());
}

fn example(name: &str) -> String {
    (harness::redact::SHAPES.iter().find(|shape| shape.name == name).expect("a shape of that name").example)()
}

/// A case's label, its text, and the secrets in it, each with how many of its first characters are public.
type Case = (String, String, Vec<(String, usize)>);

#[tokio::test]
async fn redact_every_secret_after_any_escape_encoding_letter_or_digit_is_masked_and_a_readable_path_is_not() {
    let (_tmp, dir) = data_dir();
    let (ghs, slack, anthropic) = (example("GitHub token"), example("Slack token"), example("Anthropic key"));
    let ghp = format!("ghp_{}", &ghs[4..]);
    let mut cases: Vec<Case> = vec![
        // Review, round 5.
        ("a Google OAuth token in an encoded query".into(), format!("GET /cb?next=%3Faccess_token%3D{} 302", example("Google OAuth token")), vec![(example("Google OAuth token"), 5)]),
        ("an encoded bearer JWT".into(), format!("Authorization%3A%20Bearer%20{}", example("JWT")), vec![(example("JWT"), 3)]),
        ("an Anthropic key after an escaped newline".into(), format!(r#"{{"keys":"first\n{anthropic}"}}"#), vec![(anthropic.clone(), 7)]),
        ("a GitHub token after an escaped tab".into(), format!(r"GITHUB\t{ghs}"), vec![(ghs.clone(), 4)]),
        ("a GitHub token after a word".into(), format!("token{ghs}"), vec![(ghs.clone(), 4)]),
        ("a GitHub token after a digit".into(), format!("v2{ghs}"), vec![(ghs.clone(), 4)]),
        // Verify, round 5.
        ("two GitHub tokens split by an escaped newline".into(), format!(r#"$ cat tokens.json {{"tokens": "{ghp}\n{ghs}"}}"#), vec![(ghp.clone(), 4), (ghs.clone(), 4)]),
        ("an Anthropic key in a doubly encoded query".into(), format!("GET /cb?redirect=https%3A%2F%2Fapp.example.com%2F%3Fkey%3D{anthropic} 302"), vec![(anthropic.clone(), 7)]),
        ("a Slack token after an escaped newline".into(), format!(r"{{'SLACK': 'x\n{slack}'}}"), vec![(slack.clone(), 5)]),
    ];
    // Every shape after each escape, encoding, letter and digit, review round 6's among them: coloured output raw and
    // JSON-escaped, JSON `\u` escapes, a URL encoded twice, quoted-printable, and C, shell and Python escapes.
    let befores = [
        r"\n", r"\t", r"\r", "%3D", "%20", "%253D", "=3D", r"\x3d", r"\0", "\x1b[32m", r"\u001b[32m", r"\u003c", r"\u003d", "<", "=", "x",
        "9",
    ];
    for shape in harness::redact::SHAPES {
        let secret = (shape.example)();
        let public = shape.markers.iter().map(|marker| marker.len()).min().unwrap();
        for before in befores {
            cases.push((format!("{} after {before:?}", shape.name), format!("v {before}{secret} end"), vec![(secret.clone(), public)]));
        }
    }
    // Verify, round 6: a bare `sk-` key whose body has no digit, or no upper-case letter, after an escape the body
    // rule alone would not count.
    let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let lower = "abcdefghijklmnopqrstuvwxyz0123456789";
    let pick = |from: &str, n: usize| (0..48).map(|i| from.as_bytes()[(i * n + 5) % from.len()] as char).collect::<String>();
    for (what, key) in [("no digit", format!("sk-{}", pick(letters, 7))), ("no upper case", format!("sk-{}", pick(lower, 11)))] {
        for before in [r"\n", "%3D"] {
            cases.push((format!("an OpenAI key with {what} after {before:?}"), format!("v {before}{key} end"), vec![(key.clone(), 3)]));
        }
    }
    // Bare `sk-` inside a readable word is no key.
    let readable = [
        "Edited .claude/worktrees/fix-task-list-rendering-in-the-sidebar-panel/src/main.rs today",
        "docs/risk-assessment-for-the-billing-migration-2024-q3-final.md",
        "Whisk-Together-The-Eggs-And-Flour-In-A-Large-Bowl-Until-Smooth",
    ];
    let says: Vec<Body> = cases.iter().map(|(_, text, _)| text.as_str()).chain(readable).map(|text| Body::Text { text: text.into() }).collect();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("says".into(), Arc::new(Says::new(vec![says], false)))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "says", false).await;
    let mut shown = vec![];
    while shown.len() < cases.len() + readable.len() {
        if let Body::Text { text } = next(&mut events).await.body {
            shown.push(text);
        }
    }
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let disk = bytes_on_disk(&dir);
    let disk: std::collections::HashSet<&[u8]> = disk.windows(8).collect();
    // A failure names the case by its number and shape, never the text or what the client was shown.
    for (n, ((label, _, secrets), shown)) in cases.iter().zip(&shown).enumerate() {
        let seen: std::collections::HashSet<&[u8]> = shown.as_bytes().windows(8).collect();
        for (secret, public) in secrets {
            assert!(!leaks(&seen, *public, secret), "case {n}, {label}: reached the client");
            assert!(!leaks(&disk, *public, secret), "case {n}, {label}: in the store's files");
        }
    }
    for (text, shown) in readable.iter().zip(&shown[cases.len()..]) {
        assert_eq!(text, shown, "a readable path is stored as it is");
    }
}

#[tokio::test]
async fn turn_a_driver_that_starts_a_turn_inside_a_turn_or_ends_one_it_never_started_fails_it() {
    let (_tmp, dir) = data_dir();
    let twice = vec![Body::TurnStarted, Body::Text { text: "one".into() }, Body::TurnStarted, Body::TurnEnded { how: TurnEnd::Done }];
    let unstarted = vec![Body::TurnEnded { how: TurnEnd::Done }];
    let says = Says::new(vec![twice, unstarted], true);
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("says".into(), Arc::new(says))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(1));

    let (id, mut events) = open_on(&harness, "says", false).await;
    harness.send(&id, "go").unwrap();
    let turn = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(types(&turn), ["started", "prompted", "turn_started", "text", "failed", "turn_started", "turn_ended"]);
    assert_eq!(turn[4].body, Body::Failed { kind: FailKind::Driver, reason: "the driver started a turn while one was running".into() });

    let (other, mut other_events) = open_on(&harness, "says", false).await;
    harness.send(&other, "go").unwrap();
    let turn = until(&mut other_events, |body| matches!(body, Body::Failed { .. })).await;
    assert_eq!(types(&turn), ["started", "prompted", "failed"], "the stray end is not passed on");
    assert_eq!(turn[2].body, Body::Failed { kind: FailKind::Driver, reason: "the driver ended a turn it never started".into() });
    // Both turns gave their slot back: with a limit of one, a third prompt runs.
    harness.send(&id, "again").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
}

#[tokio::test]
async fn answer_an_answer_that_races_its_turns_end_is_never_recorded_or_sent() {
    let (_tmp, dir) = data_dir();
    let puppet = Puppet::default();
    let harness = on_puppet(&dir, &puppet, 4);
    let (id, mut events) = open_on(&harness, "puppet", false).await;
    harness.send(&id, "go").unwrap();
    until(&mut events, |body| matches!(body, Body::Prompted { .. })).await;
    puppet.say(0, Body::TurnStarted);
    puppet.say(0, Body::Permission { id: "d1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: json!({}) });
    let request = ask(&mut events).await;
    // With no yield between them, the turn's end is in the session's input before the answer is.
    puppet.say(0, Body::TurnEnded { how: TurnEnd::Done });
    harness.answer(&id, &request, Decision::Allow, None).expect("the request was still open when answered");
    let ended = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    quiet(&mut events, 200).await;
    assert_eq!(types(&ended), ["turn_ended"]);
    let stored = types(&harness.events(&id, 0).unwrap());
    assert!(!stored.contains(&"answered".to_owned()), "an answer was recorded after its turn ended: {stored:?}");
    let answers = puppet.commands.lock().unwrap().iter().filter(|command| matches!(command, Command::Answer { .. })).count();
    assert_eq!(answers, 0, "an answer reached the driver after its turn ended");
}

#[tokio::test]
async fn resume_a_driver_that_panics_as_it_opens_leaves_the_session_free() {
    let (_tmp, dir) = data_dir();
    let mut says = Says::new(vec![], false);
    says.panics = true;
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("panics".into(), Arc::new(says))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let spec = harness::session::Open { provider: "panics".into(), locked: false, cwd: "/nowhere".into(), ..Default::default() };
    let opening = harness.clone();
    let opened = tokio::spawn(async move { opening.open(spec).await.map(|(id, _)| id) }).await;
    assert!(opened.unwrap_err().is_panic());
    let row: String = rusqlite::Connection::open(dir.join("harness.sqlite"))
        .unwrap()
        .query_row("SELECT id FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert!(matches!(harness.clean_up(&row).await, Ok(())), "no reservation is left behind");
}

#[tokio::test]
async fn hold_a_client_tool_call_ended_by_a_close_gets_its_end() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&HOLD.replace("200", "60000"));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "ask me").unwrap();
    let held = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
    let Body::ClientToolCall { id: call, .. } = &held.last().unwrap().body else { unreachable!() };
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    let ended = Body::ToolResult { id: call.clone(), output: json!("the session has ended"), error: true };
    assert_eq!(rest[0].body, ended, "{rest:?}");
    // The session answers the call before it stops the agent, but the answer crosses HTTP and the stop does not, so
    // the agent may be stopped first. Either way it hears nothing else.
    let replies = mock.replies(&ps);
    assert!(replies.is_empty() || replies == [Ok(harness::tools::Reply::failed("the session has ended"))], "{replies:?}");
}

#[tokio::test]
async fn hold_a_tool_result_or_a_cut_that_cannot_be_recorded_does_not_reach_the_agent() {
    for cut in [false, true] {
        let (_tmp, dir) = data_dir();
        let limit = if cut { "200" } else { "60000" };
        let mock = mock(&HOLD.replace("200", limit));
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        let ps = provider_session(&next(&mut events).await.body);
        harness.send(&id, "ask me").unwrap();
        let held = until(&mut events, |body| matches!(body, Body::ClientToolCall { .. })).await;
        let Body::ClientToolCall { id: call, .. } = &held.last().unwrap().body else { unreachable!() };
        rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute_batch("ALTER TABLE events RENAME TO gone").unwrap();
        if !cut {
            harness.tool_result(&id, call, json!("blue"), false).unwrap();
        }
        until(&mut events, |body| *body == Body::Closed).await;
        let replies = mock.replies(&ps);
        let ended = Ok(harness::tools::Reply::failed("the session has ended"));
        assert!(replies.iter().all(|reply| *reply == ended), "cut {cut}: nothing unrecorded reached the agent: {replies:?}");
    }
}

/// A driver the test plays by hand: it writes the agent's events straight into each start's output, with no task
/// between, so the session sees them in the order the test chose. Every command is recorded; a stop closes the
/// output, or with `kill_ends` only a kill does, after sending those events.
#[derive(Clone, Default)]
struct Puppet {
    outputs: Arc<Mutex<Vec<Option<mpsc::UnboundedSender<Body>>>>>,
    commands: Arc<Mutex<Vec<Command>>>,
    kill_ends: Option<Vec<Body>>,
    stop_ms: Option<u64>,
}

impl Puppet {
    fn say(&self, start: usize, body: Body) {
        self.outputs.lock().unwrap()[start].as_ref().expect("the start's output is open").send(body).unwrap();
    }

    fn prompts(&self) -> Vec<String> {
        self.commands.lock().unwrap().iter().filter_map(|command| if let Command::Prompt(text) = command { Some(text.clone()) } else { None }).collect()
    }
}

impl Driver for Puppet {
    fn capabilities(&self) -> Capabilities {
        Capabilities { stop_takes_up_to_ms: self.stop_ms, ..Capabilities::default() }
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
        let (output, receiver) = mpsc::unbounded_channel();
        let start = {
            let mut outputs = self.outputs.lock().unwrap();
            outputs.push(Some(output));
            outputs.len() - 1
        };
        self.say(start, Body::Started { provider_session: format!("puppet-{start}"), resumed: start > 0 });
        let puppet = self.clone();
        tokio::spawn(async move {
            while let Some(command) = commands_rx.recv().await {
                puppet.commands.lock().unwrap().push(command.clone());
                let ends = match (&command, &puppet.kill_ends) {
                    (Command::Stop, None) => Some(vec![]),
                    (Command::Kill, Some(last)) => Some(last.clone()),
                    _ => None,
                };
                if let Some(last) = ends {
                    last.into_iter().for_each(|body| puppet.say(start, body));
                    puppet.outputs.lock().unwrap()[start] = None;
                    return;
                }
            }
        });
        Ok(Link { commands, output: receiver })
    }
}

fn on_puppet(dir: &std::path::Path, puppet: &Puppet, limit: usize) -> Harness {
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("puppet".into(), Arc::new(puppet.clone()))];
    Harness::new(Store::open(dir).unwrap(), drivers, settings(limit))
}

#[tokio::test]
async fn stop_a_prompt_queued_behind_a_turn_does_not_reach_the_agent_after_close() {
    let (_tmp, dir) = data_dir();
    let puppet = Puppet::default();
    let harness = on_puppet(&dir, &puppet, 4);
    let (id, mut events) = open_on(&harness, "puppet", false).await;
    harness.send(&id, "one").unwrap();
    until(&mut events, |body| matches!(body, Body::Prompted { .. })).await;
    puppet.say(0, Body::TurnStarted);
    until(&mut events, |body| *body == Body::TurnStarted).await;
    // With no yield between them: "two" waits behind the turn, the turn ends, and the session is closed.
    harness.send(&id, "two").unwrap();
    puppet.say(0, Body::TurnEnded { how: TurnEnd::Done });
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&rest), ["turn_ended", "prompts_dropped", "closed"], "the client hears the queued prompt was dropped");
    assert_eq!(puppet.prompts(), ["one"], "the queued prompt never reached the agent");
    assert_eq!(*puppet.commands.lock().unwrap(), [Command::Prompt("one".into()), Command::Stop], "Stop is the last command");
}

#[tokio::test]
async fn stop_a_slot_granted_after_close_sends_no_prompt_and_is_given_back_while_the_agent_stops() {
    let (_tmp, dir) = data_dir();
    // The agent goes only when killed, a second after the stop, so the second session is still stopping below.
    let puppet = Puppet { kill_ends: Some(vec![]), stop_ms: Some(1_000), ..Puppet::default() };
    let harness = on_puppet(&dir, &puppet, 1);
    let (first, mut first_events) = open_on(&harness, "puppet", false).await;
    let (second, mut second_events) = open_on(&harness, "puppet", false).await;
    harness.send(&first, "one").unwrap();
    until(&mut first_events, |body| matches!(body, Body::Prompted { .. })).await;
    puppet.say(0, Body::TurnStarted);
    harness.send(&second, "two").unwrap();
    until(&mut second_events, |body| *body == Body::Waiting).await;
    // The first turn ends, which grants the second its slot, and the second is closed before it runs.
    puppet.say(0, Body::TurnEnded { how: TurnEnd::Done });
    harness.close(&second).unwrap();
    let asked = Instant::now();
    while !puppet.commands.lock().unwrap().contains(&Command::Stop) {
        assert!(asked.elapsed() < Duration::from_secs(5), "the second session never told its agent to stop");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    harness.send(&first, "again").unwrap();
    let asked = until(&mut first_events, |body| matches!(body, Body::Prompted { .. } | Body::Waiting)).await;
    assert!(matches!(asked.last().unwrap().body, Body::Prompted { .. }), "the only slot is free while the second agent stops");
    assert!(!puppet.commands.lock().unwrap().contains(&Command::Kill), "the second agent was still stopping");
    until(&mut second_events, |body| *body == Body::Closed).await;
    assert_eq!(puppet.prompts(), ["one", "again"], "the granted prompt never reached the agent");
}

#[tokio::test]
async fn stop_a_turn_open_at_close_gets_exactly_one_end_before_closed() {
    let (_tmp, dir) = data_dir();
    // The agent goes at once, with its turn open.
    let puppet = Puppet::default();
    let harness = on_puppet(&dir, &puppet, 4);
    let (id, mut events) = open_on(&harness, "puppet", false).await;
    harness.send(&id, "one").unwrap();
    until(&mut events, |body| matches!(body, Body::Prompted { .. })).await;
    puppet.say(0, Body::TurnStarted);
    until(&mut events, |body| *body == Body::TurnStarted).await;
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&rest), ["failed", "closed"], "the open turn ends once");
    assert!(matches!(&rest[0].body, Body::Failed { kind: FailKind::AgentStopped, .. }));

    // The agent goes only when killed, and ends its turn as it does: the kill diagnostic already ended it.
    let (_tmp, dir) = data_dir();
    let puppet = Puppet { kill_ends: Some(vec![Body::TurnEnded { how: TurnEnd::Done }]), stop_ms: Some(100), ..Puppet::default() };
    let harness = on_puppet(&dir, &puppet, 4);
    let (id, mut events) = open_on(&harness, "puppet", false).await;
    harness.send(&id, "one").unwrap();
    until(&mut events, |body| matches!(body, Body::Prompted { .. })).await;
    puppet.say(0, Body::TurnStarted);
    until(&mut events, |body| *body == Body::TurnStarted).await;
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&rest), ["failed", "closed"], "one end, not the diagnostic and the agent's own: {rest:?}");
}

#[tokio::test]
async fn stop_a_prompt_the_driver_does_not_take_fails_the_session_where_the_store_can_say_so() {
    let (_tmp, dir) = data_dir();
    // A driver that stops reading commands at once and closes its output once the test has seen the prompt.
    struct Deaf(Arc<tokio::sync::Notify>);
    impl Driver for Deaf {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
            let (commands, commands_rx) = mpsc::unbounded_channel::<Command>();
            drop(commands_rx);
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: "deaf".into(), resumed: false }).unwrap();
            let close = self.0.clone();
            tokio::spawn(async move {
                close.notified().await;
                drop(output);
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let close = Arc::new(tokio::sync::Notify::new());
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("deaf".into(), Arc::new(Deaf(close.clone())))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "deaf", false).await;
    harness.send(&id, "one").unwrap();
    let mut rest = until(&mut events, |body| matches!(body, Body::Prompted { .. })).await;
    close.notify_one();
    rest.extend(until(&mut events, |body| *body == Body::Closed).await);
    assert_eq!(types(&rest), ["started", "prompted", "failed", "closed"]);
    assert!(rest.iter().all(|event| event.seq > 0), "every event is recorded: {rest:?}");
    let stored = types(&harness.events(&id, 0).unwrap());
    assert_eq!(stored, ["started", "prompted", "failed", "closed"]);
}

#[tokio::test]
async fn stop_an_agent_that_calls_a_tool_as_it_stops_hears_the_session_ended_and_goes() {
    let (_tmp, dir) = data_dir();
    let heard = Arc::new(Mutex::new(None));
    // On Stop it calls the session's tools endpoint and goes only once the call returns.
    struct Caller(Arc<Mutex<Option<std::result::Result<harness::tools::Reply, String>>>>);
    impl Driver for Caller {
        fn capabilities(&self) -> Capabilities {
            Capabilities { stop_takes_up_to_ms: Some(10_000), ..Capabilities::default() }
        }
        fn open(&self, launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel();
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: "caller".into(), resumed: false }).unwrap();
            let heard = self.0.clone();
            tokio::spawn(async move {
                let _output = output;
                while let Some(command) = commands_rx.recv().await {
                    if command == Command::Stop {
                        let reply = launch.tools.call(launch.tools_token.expose(), "choose", json!({})).await;
                        *heard.lock().unwrap() = Some(reply);
                        return;
                    }
                }
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("caller".into(), Arc::new(Caller(heard.clone())))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "caller", false).await;
    let stopped = Instant::now();
    harness.close(&id).unwrap();
    let rest = until(&mut events, |body| *body == Body::Closed).await;
    assert!(stopped.elapsed() < Duration::from_secs(5), "the agent was not held until the grace ran out");
    assert_eq!(types(&rest), ["started", "closed"]);
    assert_eq!(heard.lock().unwrap().clone(), Some(Ok(harness::tools::Reply::failed("the session has ended"))));
}

#[tokio::test]
async fn redact_a_provider_session_id_that_holds_a_secret_is_not_kept_and_the_session_stops() {
    let (_tmp, dir) = data_dir();
    let secret = example("GitHub token");
    let received: Arc<Mutex<Vec<Command>>> = Arc::default();
    struct Leaky(String, Arc<Mutex<Vec<Command>>>);
    impl Driver for Leaky {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: format!("session-{}", self.0), resumed: false }).unwrap();
            let received = self.1.clone();
            tokio::spawn(async move {
                let _output = output;
                while let Some(command) = commands_rx.recv().await {
                    received.lock().unwrap().push(command.clone());
                    if command == Command::Stop {
                        return;
                    }
                }
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("leaky".into(), Arc::new(Leaky(secret.clone(), received.clone())))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "leaky", false).await;
    // A prompt is waiting when the session reads the agent's `started`.
    harness.send(&id, "one").unwrap();
    let all = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&all), ["started", "failed", "prompts_dropped", "closed"], "the session stopped, and said the prompt never went");
    assert_eq!(*received.lock().unwrap(), [Command::Stop], "no prompt reached the agent");
    assert!(!every_row(&dir).contains(&secret[4..]), "the id's secret is in no table");
    assert!(matches!(harness.resume(&id).await, Err(Error::CannotResume(_))), "a session with no kept id cannot be resumed");
}

#[tokio::test]
async fn redact_a_resumed_session_whose_agent_names_a_secret_id_drops_the_earlier_id_and_cannot_be_resumed_again() {
    let (_tmp, dir) = data_dir();
    let secret = example("GitHub token");
    // Starts under a plain id; a resume says it now goes by an id that holds a secret.
    struct Renamed(String, Arc<Mutex<Vec<Option<String>>>>);
    impl Driver for Renamed {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
            let (output, receiver) = mpsc::unbounded_channel();
            let provider_session = if launch.resume.is_some() { format!("session-{}", self.0) } else { "plain-first".to_owned() };
            self.1.lock().unwrap().push(launch.resume.clone());
            output.send(Body::Started { provider_session, resumed: launch.resume.is_some() }).unwrap();
            tokio::spawn(async move {
                let _output = output;
                while commands_rx.recv().await.is_some_and(|command| command != Command::Stop) {}
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let opens: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("renamed".into(), Arc::new(Renamed(secret.clone(), opens.clone())))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "renamed", false).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let mut resumed = harness.resume(&id).await.unwrap();
    let all = until(&mut resumed, |body| *body == Body::Closed).await;
    assert_eq!(types(&all), ["started", "failed", "closed"], "the resumed session stopped");
    assert!(!every_row(&dir).contains(&secret[4..]), "the id's secret is in no table");
    let again = harness.resume(&id).await;
    assert!(
        matches!(&again, Err(Error::CannotResume(_))),
        "the earlier id no longer names the agent's session, so it is not resumed by"
    );
    assert_eq!(*opens.lock().unwrap(), [None, Some("plain-first".to_owned())], "the refused resume reached no driver");
}

#[tokio::test]
async fn resume_a_provider_session_id_the_store_will_not_write_breaks_the_session_and_it_cannot_be_resumed() {
    let (_tmp, dir) = data_dir();
    let puppet = Puppet::default();
    let harness = on_puppet(&dir, &puppet, 4);
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute_batch("CREATE TRIGGER refuse_id BEFORE UPDATE OF provider_session ON sessions BEGIN SELECT RAISE(ABORT, 'refused'); END;")
        .unwrap();
    let (id, mut events) = open_on(&harness, "puppet", false).await;
    let all = until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(types(&all), ["failed", "closed"], "the session stops on its broken store");
    assert!(matches!(all[0].body, Body::Failed { kind: FailKind::Harness, .. }));
    assert!(all.iter().all(|event| event.seq == 0), "nothing is stored after the failed write");
    raw.execute_batch("DROP TRIGGER refuse_id").unwrap();
    let again = harness.resume(&id).await;
    assert!(matches!(&again, Err(Error::Driver(reason)) if reason.contains("no provider session id")), "no id was kept");
}

#[tokio::test]
async fn resume_a_session_closed_before_its_agent_said_it_started_keeps_the_id_and_resumes() {
    let (_tmp, dir) = data_dir();
    // Says it started only once it is told to stop, then goes; a resume goes at once.
    struct Late;
    impl Driver for Late {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
            let (output, receiver) = mpsc::unbounded_channel();
            let resumed = launch.resume.is_some();
            tokio::spawn(async move {
                while let Some(command) = commands_rx.recv().await {
                    if command == Command::Stop {
                        let _ = output.send(Body::Started { provider_session: "late".into(), resumed });
                        return;
                    }
                }
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("late".into(), Arc::new(Late))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "late", false).await;
    harness.close(&id).unwrap();
    assert_eq!(types(&until(&mut events, |body| *body == Body::Closed).await), ["started", "closed"]);
    let mut resumed = harness.resume(&id).await.expect("the id the agent gave as it went was kept");
    harness.close(&id).unwrap();
    assert_eq!(types(&until(&mut resumed, |body| *body == Body::Closed).await), ["started", "closed"]);
}


/// Takes the store's lock again and again on another thread, so a step that needs it waits, as under load. It
/// pauses between reads, or an unfair lock would starve the sessions.
fn hammer(harness: &Harness, id: &str, pause: Duration) -> (Arc<AtomicBool>, std::thread::JoinHandle<()>) {
    let stop = Arc::new(AtomicBool::new(false));
    let (harness, id, done) = (harness.clone(), id.to_owned(), stop.clone());
    let thread = std::thread::spawn(move || {
        while !done.load(Ordering::Relaxed) {
            let _ = harness.events(&id, 0);
            std::thread::sleep(pause);
        }
    });
    (stop, thread)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn race_clean_up_and_resume_of_one_session_are_never_both_taken() {
    let (_tmp, dir) = data_dir();
    let puppet = Puppet::default();
    let harness = on_puppet(&dir, &puppet, 4);
    let (first, _) = open_on(&harness, "puppet", false).await;
    let (stop, thread) = hammer(&harness, &first, Duration::from_micros(300));
    let mut both = 0;
    for _ in 0..300 {
        let (id, mut events) = open_on(&harness, "puppet", false).await;
        harness.close(&id).unwrap();
        until(&mut events, |body| *body == Body::Closed).await;
        let (a, b, id_a, id_b) = (harness.clone(), harness.clone(), id.clone(), id.clone());
        let cleaning = tokio::spawn(async move { a.clean_up(&id_a).await.is_ok() });
        let resuming = tokio::spawn(async move { b.resume(&id_b).await.ok() });
        let (cleaned, resumed) = (cleaning.await.unwrap(), resuming.await.unwrap());
        if let Some(mut events) = resumed {
            both += usize::from(cleaned);
            harness.close(&id).unwrap();
            until(&mut events, |body| *body == Body::Closed).await;
        }
    }
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    assert_eq!(both, 0, "a resume started from a session that clean-up took, {both} times in 300");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn race_a_slot_given_back_while_a_prompt_starts_to_wait_reaches_that_prompt() {
    let (_tmp, dir) = data_dir();
    let script = "{\"prompt\": null}\n{\"end\": \"done\"}\n".repeat(400);
    let mock = mock(&script);
    let harness = harness(&dir, &mock, 1);
    let (a, mut a_events) = open(&harness, false).await;
    let (b, mut b_events) = open(&harness, false).await;
    let (stop, thread) = hammer(&harness, &a, Duration::from_micros(300));
    for _ in 0..300 {
        harness.send(&a, "a").unwrap();
        harness.send(&b, "b").unwrap();
        for events in [&mut a_events, &mut b_events] {
            tokio::time::timeout(Duration::from_secs(5), until(events, |body| matches!(body, Body::TurnEnded { .. })))
                .await
                .expect("a prompt waited with a slot free");
        }
    }
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
}

#[tokio::test]
async fn locked_a_client_that_falls_behind_misses_no_event() {
    let (_tmp, dir) = data_dir();
    let says = 3_000;
    let script: String = std::iter::once("{\"prompt\": null}".to_owned())
        .chain((0..says).map(|n| format!("{{\"say\": \"line {n}\"}}")))
        .chain(std::iter::once("{\"end\": \"done\"}".to_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let harness = harness(&dir, &mock(&script), 4);
    let spec = harness::session::Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), ..Default::default() };
    let (id, mut events, feed) = harness.open_watched(spec).unwrap();
    let harness::session::Feed::Locked { events: mut watched, .. } = feed else { panic!("a locked session's feed drops none") };
    harness.send(&id, "go").unwrap();
    // The watcher is not read until the session has closed, far more events than the live channel holds.
    loop {
        match events.recv().await {
            Ok(event) if event.body == Body::Closed => break,
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(e) => panic!("{e}"),
        }
    }
    let mut got = vec![];
    while let Ok((event, _)) = watched.try_recv() {
        got.push(event);
    }
    let seqs: Vec<u64> = got.iter().map(|event| event.seq).collect();
    assert_eq!(seqs, (1..=got.len() as u64).collect::<Vec<_>>(), "every event, in order");
    assert_eq!(got.last().map(|event| &event.body), Some(&Body::Closed), "through to `closed`");
    assert_eq!(got.last().unwrap().seq, harness.events(&id, 0).unwrap().last().unwrap().seq, "the feed ends where the session did");
    let texts: Vec<&Body> = got.iter().map(|event| &event.body).filter(|body| matches!(body, Body::Text { .. })).collect();
    assert_eq!(texts.len(), says);
    assert_eq!(*texts[says - 1], Body::Text { text: format!("line {}", says - 1) }, "whole, not withheld");
    assert!(harness.events(&id, 0).unwrap().iter().all(|event| matches!(event.body, Body::Withheld { .. })), "and none of it stored");
}

#[tokio::test]
async fn resume_a_locked_session_that_said_it_cannot_be_resumed_stays_refused_after_a_reopen_and_with_its_rows_gone() {
    let (_tmp, dir) = data_dir();
    struct Secretive(String);
    impl Driver for Secretive {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: format!("session-{}", self.0), resumed: false }).unwrap();
            tokio::spawn(async move {
                let _output = output;
                while commands_rx.recv().await.is_some_and(|command| command != Command::Stop) {}
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("secretive".into(), Arc::new(Secretive(example("GitHub token"))))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers.clone(), settings(4));
    let (id, mut events) = open_on(&harness, "secretive", true).await;
    until(&mut events, |body| *body == Body::Closed).await;
    harness.shutdown().await;
    drop(harness);
    // A locked session's `failed` keeps no reason, and the sweep can delete the rows: the mark is on the session.
    rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute("DELETE FROM events WHERE session = ?1", [&id]).unwrap();
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    assert!(matches!(harness.resume(&id).await, Err(Error::CannotResume(_))), "refused after a reopen, with no event left");
}

#[tokio::test]
async fn locked_a_watch_reads_its_backlog_a_page_at_a_time() {
    let (_tmp, dir) = data_dir();
    let store = Store::open(&dir).unwrap();
    store.create_session("a", "mock", false, std::path::Path::new("/a"), None).unwrap();
    for n in 0..12 {
        store.append("a", &Body::Text { text: format!("{n} {}", "b".repeat(500_000)) }, 0).unwrap();
    }
    let harness = harness_on(store, &mock(LIFE), 4);
    let (page, more, upto, _live) = harness.watch("a", 0).unwrap();
    assert!(more, "6 MB of backlog is more than a page");
    assert!(serde_json::to_string(&page).unwrap().len() <= harness::api::PAGE_BYTES, "one page at most");
    assert_eq!(upto, 12, "the read stops where the session was when the watch began");
}

#[tokio::test]
async fn shutdown_stops_waiting_for_an_agent_that_ignores_stop_and_kill_and_frees_the_data_folder() {
    let (_tmp, dir) = data_dir();
    let let_go = Arc::new(tokio::sync::Notify::new());
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("stuck".into(), Arc::new(Stopper { going: Going::WhenLet(let_go.clone()) })), ("mock".into(), Arc::new(mock(LIFE)))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (stuck, mut events) = open_on(&harness, "stuck", false).await;
    harness.send(&stuck, "run").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnStarted)).await;
    let (gone, _) = open(&harness, false).await;
    let left = tokio::time::timeout(Duration::from_secs(30), harness.shutdown()).await.expect("shutdown does not wait for ever");
    assert_eq!(left, std::slice::from_ref(&stuck), "it names the session it gave up on");
    let store = Store::open(&dir).expect("the data folder is free");
    let last = store.events(&stuck, 0).unwrap().pop().unwrap();
    assert!(matches!(&last.body, Body::Failed { kind: FailKind::Stuck, reason } if reason.contains("shut down")), "{last:?}");
    assert_eq!(store.events(&gone, 0).unwrap().pop().unwrap().body, Body::Closed, "the others closed");
    let_go.notify_one();
}

#[tokio::test]
async fn sweep_leaves_the_rows_of_a_running_session() {
    let (_tmp, dir) = data_dir();
    let harness = harness(&dir, &mock(LIFE), 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    // As if its last event were 91 days old, while it still runs.
    let old = harness::store::now_ms() - 91 * 24 * 60 * 60 * 1000;
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    raw.execute("UPDATE events SET ms = ?1", [old]).unwrap();
    raw.execute("UPDATE sessions SET last_ms = ?1", [old]).unwrap();
    harness.sweep().unwrap();
    assert!(!harness.events(&id, 0).unwrap().is_empty(), "a running session's rows stay");
}

#[tokio::test]
async fn hand_over_a_take_back_that_fails_leaves_the_session_handed_over() {
    let (_tmp, dir) = data_dir();
    let harness = harness(&dir, &mock("{\"prompt\": null}"), 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.hand_over(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    harness.shutdown().await;
    drop(harness);
    // A new harness whose mock never had this session, so taking it back cannot open the agent.
    let harness = harness_on(Store::open(&dir).unwrap(), &mock("{\"prompt\": null}"), 4);
    assert!(matches!(harness.take_back(&id).await, Err(Error::Open { .. })), "the agent could not be opened");
    assert!(matches!(harness.resume(&id).await, Err(Error::HandedOver(_))), "so it is still handed over");
}

#[tokio::test]
async fn locked_a_backlog_of_zero_is_taken_as_one_and_opens() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock(LIFE)))];
    let settings = harness::session::Settings { locked_backlog: 0, ..settings(4) };
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings);
    let spec = harness::session::Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), ..Default::default() };
    assert!(harness.open_watched(spec).is_ok(), "no panic for a zero capacity");
}

#[tokio::test]
async fn question_one_whose_id_redaction_changes_is_answered_by_the_id_the_client_saw() {
    let (_tmp, dir) = data_dir();
    struct Asker(String);
    impl Driver for Asker {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: "asker".into(), resumed: false }).unwrap();
            output.send(Body::Question { id: format!("q-{}", self.0), text: "which?".into() }).unwrap();
            tokio::spawn(async move {
                let _output = output;
                while commands_rx.recv().await.is_some_and(|command| command != Command::Stop) {}
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("asker".into(), Arc::new(Asker(example("GitHub token"))))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "asker", false).await;
    let asked = until(&mut events, |body| matches!(body, Body::Question { .. })).await;
    let Body::Question { id: seen, .. } = &asked.last().unwrap().body else { unreachable!() };
    harness.answer_question(&id, seen, "this one".into()).expect("the id the client saw is the open one");
}

#[tokio::test]
async fn hand_over_after_a_close_is_refused_and_the_session_closes_as_closed() {
    let (_tmp, dir) = data_dir();
    let harness = harness(&dir, &mock("{\"prompt\": null}"), 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.close(&id).unwrap();
    assert!(harness.hand_over(&id).is_err(), "the close came first, so the hand over would be dropped");
    let seen = until(&mut events, |body| *body == Body::Closed).await;
    assert!(!seen.iter().any(|event| event.body == Body::HandedOver), "{seen:?}");
}

#[tokio::test]
async fn shutdown_an_open_it_refuses_leaves_no_session_row() {
    let (_tmp, dir) = data_dir();
    let let_go = Arc::new(tokio::sync::Notify::new());
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("stuck".into(), Arc::new(Stopper { going: Going::WhenLet(let_go.clone()) })), ("mock".into(), Arc::new(mock(LIFE)))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (stuck, mut events) = open_on(&harness, "stuck", false).await;
    harness.send(&stuck, "run").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnStarted)).await;
    // The store stays open while shutdown waits for the stuck agent, so a refused open could still make a row.
    let stopping = harness.clone();
    let shutting = tokio::spawn(async move { stopping.shutdown().await });
    let mut opened = 0;
    loop {
        match harness.open(harness::session::Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Default::default() }).await {
            Ok(_) => opened += 1,
            Err(Error::ShutDown) => break,
            Err(e) => panic!("{e}"),
        }
        tokio::task::yield_now().await;
    }
    tokio::time::timeout(Duration::from_secs(30), shutting).await.expect("shutdown does not wait for ever").unwrap();
    let_go.notify_one();
    let raw = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    let rows: i64 = raw.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0)).unwrap();
    assert_eq!(rows, 1 + opened, "only the sessions that started have rows");
}

#[tokio::test]
async fn question_an_answer_reaches_the_agent_before_prompts_sent_while_it_was_open() {
    let (_tmp, dir) = data_dir();
    /// Asks a question and a permission in its first turn, which ends when the test says.
    struct Questioner {
        end: Arc<tokio::sync::Notify>,
    }
    impl Driver for Questioner {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
            let (commands, mut commands_rx) = mpsc::unbounded_channel::<Command>();
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: "questioner".into(), resumed: false }).unwrap();
            let end = self.end.clone();
            tokio::spawn(async move {
                let mut first = true;
                while let Some(command) = commands_rx.recv().await {
                    match command {
                        Command::Prompt(_) => {
                            let _ = output.send(Body::TurnStarted);
                            if std::mem::take(&mut first) {
                                let _ = output.send(Body::Question { id: "q1".into(), text: "which?".into() });
                                let _ = output.send(Body::Permission { id: "d1".into(), kind: PermissionKind::Command, tool: "Bash".into(), input: json!({}) });
                                end.notified().await;
                            }
                            let _ = output.send(Body::TurnEnded { how: TurnEnd::Done });
                        }
                        Command::Stop => return,
                        _ => {}
                    }
                }
            });
            Ok(Link { commands, output: receiver })
        }
    }
    let end = Arc::new(tokio::sync::Notify::new());
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("questioner".into(), Arc::new(Questioner { end: end.clone() }))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = open_on(&harness, "questioner", false).await;
    harness.send(&id, "first").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    let request = permission_id(&asked.last().unwrap().body);
    let question = asked.iter().find_map(|event| match &event.body {
        Body::Question { id, .. } => Some(id.clone()),
        _ => None,
    });
    harness.send(&id, "later").unwrap();
    harness.answer_question(&id, &question.expect("the question came first"), "blue".into()).unwrap();
    // Requests are taken in order, so once this answer is recorded the two before it are queued.
    harness.answer(&id, &request, Decision::Allow, None).unwrap();
    until(&mut events, |body| matches!(body, Body::Answered { .. })).await;
    end.notify_one();
    let mut prompted = vec![];
    while prompted.len() < 2 {
        if let Body::Prompted { text } = next(&mut events).await.body {
            prompted.push(text);
        }
    }
    assert_eq!(prompted, ["blue", "later"], "the answer went first");
}

/// A home folder with a login folder of its own, `~/.claude-work`, and a captured shell that sets Claude's login.
struct Machine {
    _tmp: tempfile::TempDir,
    dir: std::path::PathBuf,
    home: std::path::PathBuf,
    seer: Seer,
}

fn machine() -> Machine {
    let (tmp, dir) = data_dir();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".claude-work")).unwrap();
    let home = home.canonicalize().unwrap();
    Machine { _tmp: tmp, dir, home, seer: Seer::default() }
}

fn setup_of(m: &Machine) -> harness::work::Setup {
    let shell = harness::env::RunEnv::from_pairs([
        ("PATH", "/usr/bin:/bin".to_owned()),
        ("CLAUDE_CONFIG_DIR", m.home.join(".claude-shell").display().to_string()),
        ("ANTHROPIC_API_KEY", "sk-shell".to_owned()),
    ]);
    harness::work::Setup::new(Some(m.home.clone()), m.dir.clone()).with_shell_env(shell)
}

fn on(m: &Machine, store: Store, setup: harness::work::Setup) -> Harness {
    let drivers: Vec<(String, Arc<dyn Driver>)> = ["claude", "gemini", "mock"].map(|name| (name.to_owned(), Arc::new(m.seer.clone()) as Arc<dyn Driver>)).into();
    Harness::with_setup(store, drivers, settings(4), Arc::new(setup))
}

fn claude(login: Option<&str>, effort: Option<&str>) -> harness::session::Open {
    harness::session::Open { provider: "claude".into(), cwd: "/nowhere".into(), login: login.map(Into::into), effort: effort.map(Into::into), ..Default::default() }
}

#[tokio::test]
async fn a_sessions_login_and_effort_reach_its_driver() {
    let m = machine();
    let harness = on(&m, Store::open(&m.dir).unwrap(), setup_of(&m));
    let (_, mut events) = harness.open(claude(Some("~/.claude-work"), Some("high"))).await.unwrap();
    next(&mut events).await;
    let (_, mut events) = harness.open(claude(None, None)).await.unwrap();
    next(&mut events).await;
    let [own, usual] = <[Seen; 2]>::try_from(m.seer.starts()).unwrap();
    assert_eq!((own.login.as_deref(), own.effort.as_deref()), (Some("~/.claude-work"), Some("high")));
    let work = m.home.join(".claude-work").display().to_string();
    assert_eq!((own.var("CLAUDE_CONFIG_DIR"), own.var("ANTHROPIC_API_KEY")), (Some(work), None), "a folder drops the shell's login");
    assert_eq!(own.var("PATH").as_deref(), Some("/usr/bin:/bin"), "the rest is the captured shell's");
    let shell = m.home.join(".claude-shell").display().to_string();
    assert_eq!((usual.login.clone(), usual.effort.clone(), usual.var("CLAUDE_CONFIG_DIR"), usual.var("ANTHROPIC_API_KEY")), (None, None, Some(shell), Some("sk-shell".into())));
}

#[tokio::test]
async fn login_one_the_harness_cannot_run_as_is_refused_at_open_and_starts_nothing() {
    let m = machine();
    std::fs::create_dir_all(m.home.join(".claude")).unwrap();
    let harness = on(&m, Store::open(&m.dir).unwrap(), setup_of(&m));
    let refused = [
        claude(Some("~/.claude-missing"), None),
        claude(Some("/tmp"), None),
        claude(Some("~/.claude"), None),
        claude(Some("~"), None),
        claude(Some("~/../elsewhere"), None),
        harness::session::Open { provider: "gemini".into(), cwd: "/nowhere".into(), login: Some("~/.claude-work".into()), ..Default::default() },
        harness::session::Open { provider: "mock".into(), cwd: "/nowhere".into(), login: Some("~/.claude-work".into()), ..Default::default() },
        claude(None, Some("High")),
        claude(None, Some("--max")),
    ];
    for (at, spec) in refused.into_iter().enumerate() {
        match harness.open(spec).await {
            Err(Error::Refused(why)) => assert!(!why.contains(&*m.home.to_string_lossy()), "{at}: the refusal names no full path"),
            other => panic!("{at}: expected a refusal, got {:?}", other.map(|(id, _)| id)),
        }
    }
    assert!(m.seer.starts().is_empty(), "no agent started");
    assert!(harness.sessions().unwrap().is_empty(), "and no session row was made");
}

#[tokio::test]
async fn login_the_usual_one_needs_a_captured_shell_and_a_folder_does_not() {
    let m = machine();
    let harness = on(&m, Store::open(&m.dir).unwrap(), harness::work::Setup::new(Some(m.home.clone()), m.dir.clone()));
    assert!(matches!(harness.open(claude(None, None)).await, Err(Error::Refused(_))), "the usual login is the shell's, which is unknown");
    let (_, mut events) = harness.open(claude(Some("~/.claude-work"), None)).await.unwrap();
    next(&mut events).await;
    assert_eq!(m.seer.starts().len(), 1);
}

#[tokio::test]
async fn a_sessions_login_effort_and_work_survive_a_restart_and_reach_the_driver_on_resume() {
    let m = machine();
    let worktree = m.home.join("Gossamr/agents/acme/webshop+worktrees/harness-1");
    std::fs::create_dir_all(&worktree).unwrap();
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "harness-1".into(), clone: m.home.join("Gossamr/agents/acme/webshop") };
    let harness = on(&m, Store::open(&m.dir).unwrap(), setup_of(&m));
    let spec = harness::session::Open { cwd: worktree.clone(), work: Some(work.clone()), ..claude(Some("~/.claude-work"), Some("xhigh")) };
    let (id, mut events) = harness.open(spec).await.unwrap();
    next(&mut events).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    drop(harness);

    let store = reopen(&m.dir).await;
    let row = store.session(&id).unwrap();
    assert_eq!((row.login.as_deref(), row.effort.as_deref(), row.work.as_ref()), (Some("~/.claude-work"), Some("xhigh"), Some(&work)));
    let harness = on(&m, store, setup_of(&m));
    let mut events = harness.resume(&id).await.unwrap();
    next(&mut events).await;
    let resumed = m.seer.starts().pop().unwrap();
    assert_eq!((resumed.resume.as_deref(), resumed.login.as_deref(), resumed.effort.as_deref()), (Some("seer-1"), Some("~/.claude-work"), Some("xhigh")));
    assert_eq!((resumed.cwd.clone(), resumed.var("CLAUDE_CONFIG_DIR")), (worktree.clone(), Some(m.home.join(".claude-work").display().to_string())));
    let listed = harness.sessions().unwrap();
    assert_eq!((listed[0].repo.as_deref(), listed[0].branch.as_deref(), listed[0].login.as_deref(), listed[0].effort.as_deref()), (Some("acme/webshop"), Some("harness-1"), Some("~/.claude-work"), Some("xhigh")));

    harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    std::fs::remove_dir_all(&worktree).unwrap();
    assert!(matches!(harness.resume(&id).await, Err(Error::Refused(_))), "a session whose worktree is gone isn't resumed");
}

#[tokio::test]
async fn login_the_work_root_is_refused_and_no_agent_starts_before_the_shell_was_read() {
    let m = machine();
    let clone = m.home.join("Gossamr/agents/acme/webshop");
    std::fs::create_dir_all(&clone).unwrap();
    let harness = on(&m, Store::open(&m.dir).unwrap(), setup_of(&m));
    assert!(matches!(harness.open(claude(Some("~/Gossamr/agents/acme/webshop"), None)).await, Err(Error::Refused(_))), "a clone is not a login");
    for holder in ["~/Gossamr", "~/Gossamr/agents"] {
        assert!(matches!(harness.open(claude(Some(holder), None)).await, Err(Error::Refused(_))), "{holder} holds the work root");
    }
    drop(harness);
    let unread = harness::work::Setup::new(Some(m.home.clone()), m.dir.clone()).with_shell_program("/nonexistent/shell");
    let harness = on(&m, reopen(&m.dir).await, unread);
    match harness.open(claude(Some("~/.claude-work"), None)).await {
        Err(Error::Refused(why)) => assert!(why.contains("hasn't been read"), "{why}"),
        other => panic!("expected a refusal, got {:?}", other.map(|(id, _)| id)),
    }
    assert!(m.seer.starts().is_empty(), "not even on the harness's own environment");
    let (_, mut events) = harness.open(harness::session::Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Default::default() }).await.unwrap();
    next(&mut events).await;
    assert_eq!(m.seer.starts().len(), 1, "a provider outside the table needs no shell");
}

/// Refuses every open.
struct NoGo;

impl Driver for NoGo {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        Err(OpenError { kind: FailKind::Provider, message: "no".into() })
    }
}

#[tokio::test]
async fn the_latest_start_owns_a_worktree_even_one_that_failed_after_an_earlier_session_lost_it() {
    let m = machine();
    let worktree = m.home.join("Gossamr/agents/acme/webshop+worktrees/harness-1");
    std::fs::create_dir_all(&worktree).unwrap();
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "harness-1".into(), clone: m.home.join("Gossamr/agents/acme/webshop") };
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("claude".into(), Arc::new(m.seer.clone())), ("nogo".into(), Arc::new(NoGo))];
    let harness = Harness::with_setup(Store::open(&m.dir).unwrap(), drivers, settings(4), Arc::new(setup_of(&m)));
    let (ran, mut events) = harness.open(harness::session::Open { cwd: worktree.clone(), work: Some(work.clone()), ..claude(None, None) }).await.unwrap();
    next(&mut events).await;
    harness.close(&ran).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    std::fs::remove_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let later = harness::session::Open { provider: "nogo".into(), cwd: worktree.clone(), work: Some(work), ..Default::default() };
    assert!(harness.open(later).await.is_err(), "a later start on the same branch, whose worktree stays on disk, fails");
    let failed = harness.sessions().unwrap().into_iter().map(|s| s.id).find(|id| *id != ran).unwrap();
    let cleaned = harness.clean_up(&failed).await;
    assert!(cleaned.is_err() || !worktree.exists(), "the failed start's clean-up doesn't say done while its worktree is there");
    assert!(matches!(harness.resume(&ran).await, Err(Error::Refused(_))), "the earlier session doesn't resume into a worktree it no longer had");
    assert_eq!(m.seer.starts().len(), 1);
}

#[tokio::test]
async fn resume_refuses_a_session_whose_worktree_another_session_holds_now() {
    let m = machine();
    let worktree = m.home.join("Gossamr/agents/acme/webshop+worktrees/harness-1");
    std::fs::create_dir_all(&worktree).unwrap();
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "harness-1".into(), clone: m.home.join("Gossamr/agents/acme/webshop") };
    let harness = on(&m, Store::open(&m.dir).unwrap(), setup_of(&m));
    let spec = || harness::session::Open { cwd: worktree.clone(), work: Some(work.clone()), ..claude(None, None) };
    let (old, mut events) = harness.open(spec()).await.unwrap();
    next(&mut events).await;
    harness.close(&old).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let mut events = harness.resume(&old).await.unwrap();
    next(&mut events).await;
    harness.close(&old).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;

    let (_later, mut events) = harness.open(spec()).await.unwrap();
    next(&mut events).await;
    assert!(matches!(harness.resume(&old).await, Err(Error::Refused(_))), "the old session doesn't take the later one's worktree");
}

/// Opens and then says nothing, as an agent that has not named its session yet.
struct Mute;

impl Driver for Mute {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        let (commands, mut commands_rx) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel::<Body>();
        tokio::spawn(async move {
            while let Some(command) = commands_rx.recv().await {
                if matches!(command, Command::Stop | Command::Kill) {
                    break;
                }
            }
            drop(output);
        });
        Ok(Link { commands, output: receiver })
    }
}

#[tokio::test]
async fn a_live_session_owns_its_worktree_before_its_provider_id_comes() {
    let m = machine();
    let worktree = m.home.join("Gossamr/agents/acme/webshop+worktrees/harness-1");
    std::fs::create_dir_all(&worktree).unwrap();
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "harness-1".into(), clone: m.home.join("Gossamr/agents/acme/webshop") };
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("claude".into(), Arc::new(m.seer.clone())), ("mute".into(), Arc::new(Mute))];
    let harness = Harness::with_setup(Store::open(&m.dir).unwrap(), drivers, settings(4), Arc::new(setup_of(&m)));
    let (older, mut events) = harness.open(harness::session::Open { cwd: worktree.clone(), work: Some(work.clone()), ..claude(None, None) }).await.unwrap();
    next(&mut events).await;
    harness.close(&older).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    let (_newer, _events) = harness.open(harness::session::Open { provider: "mute".into(), cwd: worktree.clone(), work: Some(work), ..Default::default() }).await.unwrap();
    assert!(matches!(harness.resume(&older).await, Err(Error::Refused(_))), "the older session doesn't resume into a live one's worktree");
    harness.clean_up(&older).await.unwrap();
    assert!(worktree.exists(), "and its clean-up leaves the live session's worktree alone");
}
