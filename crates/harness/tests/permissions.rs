//! Who settles a session's permission prompts after it opened: a client's later choice reaches the running agent and
//! every later start, and never a locked session.

mod common;

use common::*;
use harness::driver::{Command, Permissions};
use harness::event::Body;

const WAITS: &str = r#"{"prompt": null}
{"say": "one"}
{"end": "done"}
{"prompt": null}
{"say": "two"}
{"end": "done"}
{"prompt": null}"#;

fn listed(harness: &harness::session::Harness, id: &str) -> Permissions {
    harness.sessions().unwrap().into_iter().find(|row| row.id == id).expect("listed").permissions
}

fn provider_session(body: &Body) -> String {
    match body {
        Body::Started { provider_session, .. } => provider_session.clone(),
        other => panic!("expected started, got {other:?}"),
    }
}

#[tokio::test]
async fn permissions_a_running_agent_gets_the_new_choice_ahead_of_the_next_prompt_and_its_row_keeps_it() {
    let (_tmp, dir) = data_dir();
    let mock = mock(WAITS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "first").unwrap();
    until(&mut events, |body| body.ends_turn()).await;
    harness.set_permissions(&id, Some(Permissions::Auto)).unwrap();
    harness.send(&id, "second").unwrap();
    until(&mut events, |body| body.ends_turn()).await;
    let received = mock.received(&ps);
    let switched = received.iter().position(|command| *command == Command::SetPermissions(Permissions::Auto)).expect("the agent got the switch");
    let prompted = received.iter().position(|command| *command == Command::Prompt("second".into())).unwrap();
    assert!(switched < prompted, "before the prompt sent after it: {received:?}");
    assert_eq!(listed(&harness, &id), Permissions::Auto, "kept for the next start");
    harness.set_permissions(&id, None).unwrap();
    assert_eq!(listed(&harness, &id), Permissions::Auto, "none changes nothing");
    assert_eq!(received.iter().filter(|command| matches!(command, Command::SetPermissions(_))).count(), 1);
}

#[tokio::test]
async fn permissions_a_locked_session_is_never_switched_and_its_row_never_changes() {
    let (_tmp, dir) = data_dir();
    let mock = mock(WAITS);
    let harness = harness(&dir, &mock, 4);
    let spec = harness::session::Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), tools: tools(), permissions: Permissions::Auto, ..Default::default() };
    let (id, mut events) = harness.open(spec).await.unwrap();
    assert_eq!(listed(&harness, &id), Permissions::Ask, "opened asking for Auto, it keeps nothing a switch would not");
    let ps = provider_session(&next(&mut events).await.body);
    for permissions in [Permissions::Auto, Permissions::Ask, Permissions::Auto] {
        harness.set_permissions(&id, Some(permissions)).unwrap();
    }
    harness.send(&id, "first").unwrap();
    until(&mut events, |body| body.ends_turn()).await;
    assert!(!mock.received(&ps).iter().any(|command| matches!(command, Command::SetPermissions(_))), "{:?}", mock.received(&ps));
    assert_eq!(listed(&harness, &id), Permissions::Ask);
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    harness.set_permissions(&id, Some(Permissions::Auto)).unwrap();
    assert_eq!(listed(&harness, &id), Permissions::Ask, "nor once it is closed");
}
