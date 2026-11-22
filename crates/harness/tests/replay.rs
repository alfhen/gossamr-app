mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use harness::event::{Body, Decision, Event, PermissionKind, TurnEnd};
use harness::mock::{Mock, Script};
use harness::run::drive;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spikes/acp/fixtures")
}

/// Plays `fixture` with its recorded client, `answers` first, and returns every event.
async fn replay(fixture: &Path, answers: Vec<Decision>) -> Vec<Event> {
    let (_tmp, dir) = data_dir();
    let mock = Mock::new(Script::load(fixture).unwrap());
    let harness = harness(&dir, &mock, 4);
    let client = mock.client();
    let (id, events) = open(&harness, false);
    let mut seen = vec![];
    let play = drive(&harness, &id, events, client, answers, None, |event| seen.push(event.clone()));
    tokio::time::timeout(Duration::from_secs(10), play).await.unwrap_or_else(|_| panic!("{} did not end", fixture.display()));
    seen
}

fn permissions(events: &[Event]) -> Vec<(PermissionKind, Decision)> {
    let mut asked = vec![];
    for event in events {
        match &event.body {
            Body::Permission { kind, .. } => asked.push((*kind, None)),
            Body::Answered { decision, .. } => asked.last_mut().expect("an answer follows a request").1 = Some(*decision),
            _ => {}
        }
    }
    asked.into_iter().map(|(kind, decision)| (kind, decision.expect("every request was answered"))).collect()
}

#[tokio::test]
async fn replay_every_fixture_of_the_chosen_drivers_plays_to_its_end() {
    let mut played = 0;
    for path in ["claude/native", "codex/app-server", "gemini/acp"] {
        let mut files: Vec<PathBuf> = std::fs::read_dir(fixtures().join(path)).unwrap().map(|entry| entry.unwrap().path()).collect();
        files.retain(|file| file.extension().is_some_and(|ext| ext == "jsonl") && !file.to_string_lossy().ends_with(".mcp-log.jsonl"));
        files.sort();
        assert!(files.len() > 10, "{path} has its fixtures");
        for file in files {
            let events = replay(&file, vec![]).await;
            assert_eq!(events.first().map(|event| event.body.type_name()).as_deref(), Some("started"), "{}", file.display());
            assert_eq!(events.last().map(|event| &event.body), Some(&Body::Closed), "{}", file.display());
            let diverged = events.iter().any(|event| matches!(&event.body, Body::Failed { reason } if reason.starts_with("the replay")));
            assert!(!diverged, "{} diverged from its recording", file.display());
            played += 1;
        }
    }
    assert!(played >= 100, "played {played}");
}

#[tokio::test]
async fn replay_codex_app_server_gives_command_file_change_and_permissions_requests_with_their_kind() {
    let codex = fixtures().join("codex/app-server");
    let command = replay(&codex.join("2-permission.jsonl"), vec![]).await;
    use {Decision::*, PermissionKind::*};
    assert_eq!(permissions(&command), [(Command, Allow), (Command, Deny), (Command, Allow)]);
    let file_change = replay(&codex.join("2-filechange-approval.jsonl"), vec![]).await;
    assert_eq!(permissions(&file_change), [(FileChange, Allow), (FileChange, Deny)]);
    let granted = replay(&codex.join("2-permissions-approval.jsonl"), vec![]).await;
    assert_eq!(permissions(&granted), [(Permissions, Allow), (Permissions, Deny)]);
    let other_server = replay(&codex.join("r1-two-servers.jsonl"), vec![]).await;
    assert_eq!(permissions(&other_server), [(Tool, Allow)], "another server's tool asks through an elicitation");
    for events in [&command, &file_change, &granted] {
        assert_eq!(events.iter().rev().nth(1).map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }));
    }
}

#[tokio::test]
async fn replay_the_other_chosen_drivers_give_their_permission_requests_and_turn_ends() {
    let claude = replay(&fixtures().join("claude/native/2-permission.jsonl"), vec![]).await;
    assert_eq!(permissions(&claude), [(PermissionKind::Command, Decision::Allow), (PermissionKind::Command, Decision::Deny)]);
    let gemini = replay(&fixtures().join("gemini/acp/2-permission.jsonl"), vec![]).await;
    assert_eq!(permissions(&gemini), [(PermissionKind::Command, Decision::Allow), (PermissionKind::Command, Decision::Deny)]);
    let cancelled = replay(&fixtures().join("claude/native/3-cancel.jsonl"), vec![]).await;
    let ends: Vec<&Body> = cancelled.iter().map(|event| &event.body).filter(|body| body.ends_turn()).collect();
    assert_eq!(ends, [&Body::TurnEnded { how: TurnEnd::Cancelled }, &Body::TurnEnded { how: TurnEnd::Done }]);
    let collision = replay(&fixtures().join("gemini/acp/r1-collision.jsonl"), vec![]).await;
    assert!(collision.iter().any(|event| matches!(&event.body, Body::Text { text } if text.contains("tool name conflict"))));
}

#[tokio::test]
async fn replay_maps_the_fixtures_ids_pids_and_ports_to_fresh_ones() {
    let events = replay(&fixtures().join("claude/native/2-permission.jsonl"), vec![]).await;
    let shown = serde_json::to_string(&events).unwrap();
    let recorded = ["3fea6374-c3ed-4254-8d20-6333b6edce26", "4b00fe4a-5e30-45fa-bc99-156e4df0bc3d", "toolu_01KX85KeVuBaHQoR3pzBhj2M", "spike-1"];
    for id in recorded {
        assert!(!shown.contains(id), "{id} reached an event");
    }
    assert!(!regex::Regex::new(r"\b7435\b").unwrap().is_match(&shown), "the recorded pid reached an event");
    assert!(shown.contains("\"provider_session\":\"mock-"), "the session is the mock's own");

    // A recording whose agent names its session, a tool call, its pid and a loopback port.
    let transcript = [
        r#"{"seq":1,"ms":0,"dir":"driver","data":{"note":"spawned","detail":{"pid":4242}}}"#,
        r#"{"seq":2,"ms":1,"dir":"to_agent","data":{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"0f0e0d0c-0b0a-4909-8807-060504030201","prompt":[{"type":"text","text":"go"}]}}}"#,
        r#"{"seq":3,"ms":2,"dir":"from_agent","data":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0f0e0d0c-0b0a-4909-8807-060504030201","update":{"sessionUpdate":"tool_call","toolCallId":"call_123456789","name":"ping","args":{"url":"http://127.0.0.1:54321/mcp"}}}}}"#,
        r#"{"seq":4,"ms":3,"dir":"from_agent","data":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0f0e0d0c-0b0a-4909-8807-060504030201","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"session 0f0e0d0c-0b0a-4909-8807-060504030201, pid 4242, "}}}}}"#,
        r#"{"seq":5,"ms":4,"dir":"from_agent","data":{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"0f0e0d0c-0b0a-4909-8807-060504030201","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"call call_123456789 on 127.0.0.1:54321"}}}}}"#,
        r#"{"seq":6,"ms":5,"dir":"from_agent","data":{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}}"#,
    ];
    let (tmp, _) = data_dir();
    let fixture = tmp.path().join("made.jsonl");
    std::fs::write(&fixture, transcript.join("\n")).unwrap();
    let events = replay(&fixture, vec![]).await;
    let Body::Started { provider_session, .. } = &events[0].body else { panic!("{events:?}") };
    let Some(Body::ToolCall { id: call, input, .. }) = events.iter().map(|event| &event.body).find(|body| matches!(body, Body::ToolCall { .. })) else {
        panic!("{events:?}")
    };
    assert_eq!(input["url"], "http://127.0.0.1:0/mcp", "a session with no tools endpoint yet gets port 0");
    let text = events.iter().find_map(|event| match &event.body { Body::Text { text } => Some(text.clone()), _ => None }).unwrap();
    let pid = std::process::id();
    assert_eq!(text, format!("session {provider_session}, pid {pid}, call {call} on 127.0.0.1:0"), "the two chunks are one text");
    assert_ne!(call, "call_123456789");
}

#[tokio::test]
async fn replay_an_answer_that_differs_from_the_recording_fails_the_session() {
    let events = replay(&fixtures().join("claude/native/2-permission.jsonl"), vec![Decision::Deny]).await;
    let failed = events.iter().find_map(|event| match &event.body { Body::Failed { reason } => Some(reason.clone()), _ => None });
    assert_eq!(failed.as_deref(), Some("the replay was answered Deny where the recording has Some(Allow)"));
    assert!(!events.iter().any(|event| matches!(event.body, Body::TurnEnded { .. })), "nothing past the divergence is played");
}
