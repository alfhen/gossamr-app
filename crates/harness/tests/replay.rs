mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::*;
use harness::event::{Body, Decision, Event, FailKind, PermissionKind, TurnEnd};
use harness::mock::{ClientAction, MAX_SCRIPT_BYTES, Mock, Script};
use harness::run::drive;
use serde_json::{Value, json};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spikes/acp/fixtures")
}

/// A fixture's name for a failure message: its path under `fixtures()`, or its file name, never an absolute path.
fn name(path: &Path) -> String {
    path.strip_prefix(fixtures()).ok().or(path.file_name().map(Path::new)).unwrap_or(path).display().to_string()
}

fn lines_of(fixture: &str) -> Vec<Value> {
    std::fs::read_to_string(fixtures().join(fixture)).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

/// Writes `lines` as a transcript in a folder of its own.
fn written(lines: &[Value]) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("made.jsonl");
    std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    (tmp, path)
}

/// What loading `path` refused, with the path left out.
fn refused(path: &Path) -> String {
    let error = Script::load(path).err().unwrap_or_else(|| panic!("{} loaded", name(path)));
    error.strip_prefix(&path.display().to_string()).unwrap_or(&error).to_owned()
}

/// Plays `fixture` with its recorded client, `answers` first, and returns every event.
async fn replay(fixture: &Path, answers: Vec<Decision>) -> Vec<Event> {
    let (_tmp, dir) = data_dir();
    let mock = Mock::new(Script::load(fixture).unwrap_or_else(|_| panic!("{} does not load", name(fixture))));
    let harness = harness(&dir, &mock, 4);
    let client = mock.client();
    let (id, events) = open(&harness, false).await;
    let mut seen = vec![];
    let play = drive(&harness, &id, events, client, answers, None, |event| seen.push(event.clone()));
    let followed = tokio::time::timeout(Duration::from_secs(60), play).await.unwrap_or_else(|_| panic!("{} did not end", name(fixture)));
    assert!(followed, "the client of {} missed events or could not act as recorded", name(fixture));
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

/// What a transcript records, counted here apart from the converter, by each wire's own markers.
#[derive(Debug, Default, PartialEq)]
struct Counts {
    prompts: usize,
    permissions: usize,
    tool_calls: usize,
    ends: usize,
    failures: usize,
}

fn recorded(family: &str, lines: &[Value]) -> Counts {
    let mut counts = Counts::default();
    let (mut cancelled, mut loading) = (false, None);
    for line in lines {
        let (data, client) = (&line["data"], line["dir"] == "to_agent");
        if !client && line["dir"] != "from_agent" {
            continue;
        }
        let method = data["method"].as_str().unwrap_or_default();
        match family {
            "claude/native" => match (client, data["type"].as_str().unwrap_or_default()) {
                (true, "user") => (counts.prompts, cancelled) = (counts.prompts + 1, false),
                (true, "control_request") => cancelled |= data["request"]["subtype"] == "interrupt",
                (false, "assistant") => {
                    counts.tool_calls += data["message"]["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "tool_use").count()
                }
                (false, "control_request") => counts.permissions += usize::from(data["request"]["subtype"] == "can_use_tool"),
                (false, "result") if data["subtype"] == "success" && data["is_error"] != true || cancelled => counts.ends += 1,
                (false, "result") => counts.failures += 1,
                _ => {}
            },
            "codex/app-server" => match (client, method) {
                (true, "turn/start") => counts.prompts += 1,
                (false, "item/started") => {
                    counts.tool_calls += usize::from(["commandExecution", "fileChange", "mcpToolCall"].contains(&data["params"]["item"]["type"].as_str().unwrap_or_default()))
                }
                (false, method) if method.ends_with("/requestApproval") || method == "mcpServer/elicitation/request" => counts.permissions += 1,
                (false, "turn/completed") if ["completed", "interrupted"].contains(&data["params"]["turn"]["status"].as_str().unwrap_or_default()) => counts.ends += 1,
                (false, "turn/completed") => counts.failures += 1,
                (false, "") => counts.failures += usize::from(data.get("error").is_some()),
                _ => {}
            },
            _ => match (client, method) {
                (true, "session/load") => loading = Some(data["id"].clone()),
                (false, "") if loading.as_ref() == Some(&data["id"]) => loading = None,
                _ if loading.is_some() => {}
                (true, "session/prompt") => counts.prompts += 1,
                (false, "session/update") => counts.tool_calls += usize::from(data["params"]["update"]["sessionUpdate"] == "tool_call"),
                (false, "session/request_permission") => counts.permissions += 1,
                (false, "") => match data["result"]["stopReason"].as_str() {
                    Some("end_turn" | "cancelled") => counts.ends += 1,
                    Some(_) => counts.failures += 1,
                    None => counts.failures += usize::from(data.get("error").is_some()),
                },
                _ => {}
            },
        }
    }
    counts
}

#[tokio::test]
async fn replay_every_fixture_of_the_chosen_drivers_gives_what_its_recording_has() {
    let mut played = 0;
    for family in ["claude/native", "codex/app-server", "gemini/acp"] {
        let mut files: Vec<PathBuf> = std::fs::read_dir(fixtures().join(family)).unwrap().map(|entry| entry.unwrap().path()).collect();
        files.retain(|file| file.extension().is_some_and(|ext| ext == "jsonl") && !file.to_string_lossy().ends_with(".mcp-log.jsonl"));
        files.sort();
        assert!(files.len() > 10, "{family} has its fixtures");
        for file in files {
            let lines: Vec<Value> = std::fs::read_to_string(&file).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
            let want = recorded(family, &lines);
            if Script::load(&file).is_err() {
                assert!(refused(&file) == ": no turn in this recording" && want.prompts == 0, "{} is refused", name(&file));
                continue;
            }
            let events = replay(&file, vec![]).await;
            let count = |f: &dyn Fn(&Body) -> bool| events.iter().filter(|event| f(&event.body)).count();
            // agy ends a turn it started by itself with no marker of its own, so the replay adds that end.
            let unprompted = events.windows(2).filter(|pair| pair[1].body == Body::TurnStarted && !matches!(pair[0].body, Body::Prompted { .. })).count();
            let got = Counts {
                prompts: count(&|body| matches!(body, Body::Prompted { .. })),
                permissions: count(&|body| matches!(body, Body::Permission { .. })),
                tool_calls: count(&|body| matches!(body, Body::ToolCall { .. })),
                ends: count(&|body| matches!(body, Body::TurnEnded { .. })) - if family == "gemini/acp" { unprompted } else { 0 },
                failures: count(&|body| matches!(body, Body::Failed { kind: FailKind::Provider, .. })),
            };
            assert!(got == want, "{}: the replay gives {got:?}, the recording has {want:?}", name(&file));
            // A recording that stops inside a turn (a kill) ends with the agent stopped, and only then.
            let inferred = if family == "gemini/acp" { unprompted } else { 0 };
            let open = want.prompts + unprompted > want.ends + inferred + want.failures;
            let stopped = count(&|body| matches!(body, Body::Failed { kind: FailKind::AgentStopped, .. }));
            assert!(stopped == usize::from(open), "{}: {stopped} agent-stopped failures", name(&file));
            assert!(events.last().is_some_and(|event| event.body == Body::Closed), "{} does not end closed", name(&file));
            played += 1;
        }
    }
    assert!(played >= 90, "played {played}");
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
        assert!(events.iter().rev().nth(1).is_some_and(|event| event.body == Body::TurnEnded { how: TurnEnd::Done }), "the turn ends done");
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
    assert!(ends == [&Body::TurnEnded { how: TurnEnd::Cancelled }, &Body::TurnEnded { how: TurnEnd::Done }], "cancelled, then done");
    let collision = replay(&fixtures().join("gemini/acp/r1-collision.jsonl"), vec![]).await;
    assert!(collision.iter().any(|event| matches!(&event.body, Body::Text { text } if text.contains("tool name conflict"))));
}

#[tokio::test]
async fn replay_maps_the_fixtures_ids_to_fresh_ones() {
    let events = replay(&fixtures().join("claude/native/2-permission.jsonl"), vec![]).await;
    let shown = serde_json::to_string(&events).unwrap();
    let recorded = ["3fea6374-c3ed-4254-8d20-6333b6edce26", "4b00fe4a-5e30-45fa-bc99-156e4df0bc3d", "toolu_01KX85KeVuBaHQoR3pzBhj2M", "spike-1"];
    for (n, id) in recorded.iter().enumerate() {
        assert!(!shown.contains(id), "recorded id {n} reached an event");
    }
    assert!(shown.contains("\"provider_session\":\"mock-"), "the session is the mock's own");
}

#[tokio::test]
async fn replay_maps_a_recorded_value_only_from_a_field_that_names_it() {
    // A made-up ACP recording. Its pid is never this process's, so the test holds whatever pid it runs as.
    let pid = std::process::id() + 1;
    let (one, two) = ("0f0e0d0c-0b0a-4909-8807-060504030201", "1f1e1d1c-1b1a-4919-8817-161514131211");
    let update = |seq: u64, update: Value| json!({"seq": seq, "ms": seq, "dir": "from_agent", "data": {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": one, "update": update}}});
    let said = format!("wrote {pid} bytes; sessions {one} and {two}; dev server on localhost:5173; item-container ready; call call_123456789");
    let (_tmp, path) = written(&[
        json!({"seq": 1, "ms": 0, "dir": "driver", "data": {"note": "spawned", "detail": {"pid": pid}}}),
        json!({"seq": 2, "ms": 1, "dir": "to_agent", "data": {"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {"sessionId": one, "prompt": [{"type": "text", "text": "go"}]}}}),
        json!({"seq": 3, "ms": 2, "dir": "from_agent", "data": {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": two, "update": {"sessionUpdate": "available_commands_update"}}}}),
        update(4, json!({"sessionUpdate": "tool_call", "toolCallId": "call_123456789", "name": "ping", "rawInput": {
            "pid": pid, "class": "item-container", "servers": [{"url": "http://127.0.0.1:54321/mcp"}, {"url": "http://127.0.0.1:54400/mcp"}]}})),
        update(5, json!({"sessionUpdate": "tool_call", "toolCallId": "call_987654321", "title": "ls -la", "rawInput": {"path": "."}})),
        update(6, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": said}})),
        json!({"seq": 7, "ms": 7, "dir": "from_agent", "data": {"jsonrpc": "2.0", "id": 1, "result": {"stopReason": "end_turn"}}}),
    ]);
    let events = replay(&path, vec![]).await;
    let Body::Started { provider_session, .. } = &events[0].body else { panic!("the first event is not `started`") };
    let calls: Vec<(&String, &String, &Value)> =
        events.iter().filter_map(|event| match &event.body { Body::ToolCall { id, name, input } => Some((id, name, input)), _ => None }).collect();
    let (id, _, input) = calls[0];
    assert!(id != "call_123456789", "the call id is mapped");
    assert!(input["pid"] == json!(std::process::id()), "a pid in a pid field is this process's");
    assert!(input["class"] == "item-container", "an id-shaped word in a field that is no id is kept");
    assert!(input["servers"][0]["url"] == "http://127.0.0.1:0/mcp", "the first port is 0, as the session has no tools endpoint yet");
    assert!(input["servers"][1]["url"] == "http://127.0.0.1:1/mcp", "two recorded ports stay two");
    let (_, untitled, titled) = calls[1];
    assert!(untitled == "tool" && titled["title"] == "ls -la", "a call with no name is `tool`, its title in the input (E44)");
    let text = events.iter().find_map(|event| match &event.body { Body::Text { text } => Some(text.clone()), _ => None }).unwrap();
    let want = format!("wrote {pid} bytes; sessions {provider_session} and {provider_session}-1; dev server on localhost:5173; item-container ready; call {id}");
    assert!(text == want, "only the recorded run's sessions and ids are mapped in free text, each to one of its own");
}

#[tokio::test]
async fn replay_an_answer_that_differs_from_the_recording_fails_the_session() {
    let events = replay(&fixtures().join("claude/native/2-permission.jsonl"), vec![Decision::Deny]).await;
    let failed = events.iter().find_map(|event| match &event.body { Body::Failed { reason, .. } => Some(reason.clone()), _ => None });
    assert_eq!(failed.as_deref(), Some("the replay was answered Deny where the recording has Some(Allow)"));
    assert!(!events.iter().any(|event| matches!(event.body, Body::TurnEnded { .. })), "nothing past the divergence is played");
}

#[tokio::test]
async fn replay_agys_message_after_a_background_command_is_a_turn_of_its_own_that_ends() {
    let events = replay(&fixtures().join("gemini/acp/r7-background.jsonl"), vec![]).await;
    let kinds: Vec<String> = events.iter().map(|event| event.body.type_name()).collect();
    assert!(!events.iter().any(|event| matches!(event.body, Body::Failed { .. })), "{kinds:?}");
    let starts = kinds.iter().filter(|kind| *kind == "turn_started").count();
    let ends = kinds.iter().filter(|kind| *kind == "turn_ended").count();
    assert_eq!((starts, ends), (2, 2), "the prompted turn and the one agy started by itself, each ended: {kinds:?}");
    let unprompted = kinds.iter().rposition(|kind| kind == "turn_started").unwrap();
    assert_ne!(kinds[unprompted - 1], "prompted", "no prompt started the second turn: {kinds:?}");
}

#[tokio::test]
async fn replay_agys_unprompted_turn_with_two_usage_updates_stays_one_turn() {
    // r7-background's unprompted message, sent twice 7 s apart: agy sends a `usage_update` per message, and pauses up
    // to 6.6 s between messages in H0's recordings (`4-resume-mcp`).
    let text = std::fs::read_to_string(fixtures().join("gemini/acp/r7-background.jsonl")).unwrap();
    let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let message: Vec<&serde_json::Value> = lines.iter().filter(|line| (43..=50).contains(&line["seq"].as_u64().unwrap())).collect();
    assert_eq!(message.last().unwrap()["data"]["params"]["update"]["sessionUpdate"], "usage_update");
    let mut twice = vec![];
    for line in &lines {
        twice.push((*line).clone());
        if line["seq"] == 50 {
            for again in &message {
                let mut again = (*again).clone();
                again["ms"] = serde_json::json!(again["ms"].as_u64().unwrap() + 7_000);
                twice.push(again);
            }
        }
    }
    let (tmp, _) = data_dir();
    let fixture = tmp.path().join("r7-twice.jsonl");
    std::fs::write(&fixture, twice.iter().map(|line| line.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
    let events = replay(&fixture, vec![]).await;
    let kinds: Vec<String> = events.iter().map(|event| event.body.type_name()).collect();
    let pairs = |kind: &str| kinds.iter().filter(|seen| *seen == kind).count();
    assert_eq!((pairs("turn_started"), pairs("turn_ended")), (2, 2), "the prompted turn and one unprompted turn: {kinds:?}");
    let unprompted = kinds.iter().rposition(|kind| kind == "turn_started").unwrap();
    let texts = kinds[unprompted..].iter().filter(|kind| *kind == "text").count();
    assert_eq!(texts, 2, "both messages are in the one unprompted turn: {kinds:?}");
}

/// r2-ask's first turn with its prompt and its `end_turn` left out, so agy runs it by itself: it calls `ask`, which is
/// held 20 s with no process running, then writes its message. `change` edits the lines before the replay.
async fn r2_unprompted(change: impl FnOnce(&mut Vec<serde_json::Value>)) -> Vec<String> {
    let text = std::fs::read_to_string(fixtures().join("gemini/acp/r2-ask.jsonl")).unwrap();
    let lines: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let turn = |line: &serde_json::Value| (1_159..26_560).contains(&line["ms"].as_u64().unwrap_or_default());
    let mut unprompted: Vec<serde_json::Value> = lines
        .into_iter()
        .filter(|line| !turn(line) || (line["data"]["method"] != "session/prompt" && line["data"]["result"]["stopReason"].is_null()))
        .take_while(|line| line["ms"].as_u64().unwrap_or_default() < 26_560)
        .collect();
    let held = unprompted.windows(2).map(|pair| pair[1]["ms"].as_u64().unwrap() - pair[0]["ms"].as_u64().unwrap()).max().unwrap();
    assert!(held >= 15_000, "the recording holds the call {held} ms");
    change(&mut unprompted);
    let (tmp, _) = data_dir();
    let fixture = tmp.path().join("r2-unprompted.jsonl");
    std::fs::write(&fixture, unprompted.iter().map(|line| line.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
    replay(&fixture, vec![]).await.iter().map(|event| event.body.type_name()).collect()
}

fn update(line: &serde_json::Value) -> &serde_json::Value {
    &line["data"]["params"]["update"]
}

#[tokio::test]
async fn replay_agys_unprompted_turn_does_not_end_while_its_held_ask_is_open() {
    let kinds = r2_unprompted(|_| {}).await;
    let count = |kind: &str| kinds.iter().filter(|seen| *seen == kind).count();
    assert_eq!((count("prompted"), count("turn_started"), count("turn_ended")), (0, 1, 1), "one unprompted turn: {kinds:?}");
    let ended = kinds.iter().position(|kind| kind == "turn_ended").unwrap();
    let said = kinds.iter().position(|kind| kind == "text").unwrap();
    let result = kinds.iter().position(|kind| kind == "tool_result").unwrap();
    assert!(result < said && said < ended, "the call's result and the message come before the turn ends: {kinds:?}");
}

#[tokio::test]
async fn replay_agys_held_call_with_no_update_holds_its_turn_only_to_agys_cut_and_a_margin() {
    // The `ask` never gets its update, and agy's message comes 200 s after the call, past the 180 s cut.
    let kinds = r2_unprompted(|lines| {
        let asked = lines.iter().find(|line| update(line)["sessionUpdate"] == "tool_call" && update(line)["kind"] == "other").unwrap()["ms"].as_u64().unwrap();
        lines.retain(|line| !(update(line)["sessionUpdate"] == "tool_call_update" && update(line)["status"] == "completed" && line["ms"].as_u64().unwrap() > asked + 1_000));
        for line in lines.iter_mut().filter(|line| line["ms"].as_u64().is_some_and(|ms| ms > asked + 1_000)) {
            line["ms"] = serde_json::json!(line["ms"].as_u64().unwrap() + 180_000);
        }
    })
    .await;
    let count = |kind: &str| kinds.iter().filter(|seen| *seen == kind).count();
    assert_eq!((count("turn_started"), count("turn_ended")), (2, 2), "the held turn ends, and the message is a turn of its own: {kinds:?}");
    let ended = kinds.iter().position(|kind| kind == "turn_ended").unwrap();
    let said = kinds.iter().position(|kind| kind == "text").unwrap();
    assert!(ended < said, "the first turn ends before the late message: {kinds:?}");
}

#[tokio::test]
async fn replay_agys_command_counts_through_its_process_not_its_open_call() {
    // The same held call made a command, with no process of agy's running: the 20 s of quiet ends the turn.
    let kinds = r2_unprompted(|lines| {
        for line in lines.iter_mut().filter(|line| update(line)["sessionUpdate"] == "tool_call") {
            line["data"]["params"]["update"]["kind"] = serde_json::json!("execute");
        }
    })
    .await;
    let count = |kind: &str| kinds.iter().filter(|seen| *seen == kind).count();
    assert_eq!((count("turn_started"), count("turn_ended")), (2, 2), "the quiet ends the turn: {kinds:?}");
}

fn kinds(events: &[Event]) -> Vec<String> {
    events.iter().map(|event| event.body.type_name()).collect()
}

#[tokio::test]
async fn replay_a_prompt_sent_during_agys_unprompted_message_ends_that_turn_and_runs_after_it() {
    // r7-background with a prompt sent in the middle of agy's unprompted message, and agy's answer to it 3 s later.
    let mut lines = vec![];
    for line in lines_of("gemini/acp/r7-background.jsonl") {
        let seq = line["seq"].as_u64().unwrap();
        lines.push(line);
        if seq == 46 {
            let prompt = json!({"jsonrpc": "2.0", "id": 99, "method": "session/prompt", "params": {"prompt": [{"type": "text", "text": "and now?"}]}});
            lines.push(json!({"seq": 1046, "ms": 36_400, "dir": "to_agent", "data": prompt}));
        }
        if seq == 50 {
            lines.push(json!({"seq": 1050, "ms": 39_796, "dir": "from_agent", "data": {"jsonrpc": "2.0", "id": 99, "result": {"stopReason": "end_turn"}}}));
        }
    }
    let (_tmp, path) = written(&lines);
    let kinds = kinds(&replay(&path, vec![]).await);
    let count = |kind: &str| kinds.iter().filter(|seen| *seen == kind).count();
    assert_eq!((count("prompted"), count("turn_started"), count("turn_ended"), count("failed")), (2, 3, 3, 0), "{kinds:?}");
    let second = kinds.iter().rposition(|kind| kind == "prompted").unwrap();
    assert_eq!(kinds[second - 1], "turn_ended", "the unprompted turn ends before the prompt runs: {kinds:?}");
}

#[tokio::test]
async fn replay_a_prompt_sent_during_claudes_unprompted_turn_runs_after_that_turns_result() {
    // 14-workflow-run with a prompt sent while Claude's second turn, which it started by itself, still runs.
    let mut lines = vec![];
    for line in lines_of("claude/native/14-workflow-run.jsonl") {
        let seq = line["seq"].as_u64().unwrap();
        lines.push(line);
        if seq == 114 {
            lines.push(json!({"seq": 1114, "ms": 5_082, "dir": "to_agent", "data": {"type": "user", "message": {"role": "user", "content": "and now?"}}}));
        }
    }
    let (_tmp, path) = written(&lines);
    let kinds = kinds(&replay(&path, vec![]).await);
    let prompted = kinds.iter().rposition(|kind| kind == "prompted").unwrap();
    assert_eq!(kinds[prompted - 1], "turn_ended", "the prompt runs once the turn's own result has ended it: {kinds:?}");
    // The recording stops before Claude answers it, so the agent stops inside that turn.
    assert_eq!(kinds[prompted..], ["prompted", "turn_started", "failed", "closed"], "{kinds:?}");
}

#[tokio::test]
async fn replay_codex_acp_resume_load_plays_to_its_end() {
    let kinds = kinds(&replay(&fixtures().join("codex/acp/4-resume-load.jsonl"), vec![]).await);
    assert!(!kinds.iter().any(|kind| kind == "failed") && kinds.last().is_some_and(|kind| kind == "closed"), "{kinds:?}");
}

#[tokio::test]
async fn replay_a_recording_with_twenty_thousand_ids_maps_them_all() {
    let uuid = |n: u64| format!("{n:08x}-0000-4000-8000-{n:012x}");
    let session = uuid(0);
    let mut lines = vec![json!({"seq": 1, "ms": 0, "dir": "to_agent", "data": {"type": "user", "message": {"role": "user", "content": "go"}}})];
    for n in 1..=20_000 {
        lines.push(json!({"seq": n + 1, "ms": n, "dir": "from_agent", "data": {"type": "stream_event", "uuid": uuid(n), "session_id": session}}));
    }
    let text = format!("the last was {}", uuid(20_000));
    lines.push(json!({"seq": 20_002, "ms": 20_001, "dir": "from_agent", "data": {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}}));
    lines.push(json!({"seq": 20_003, "ms": 20_002, "dir": "from_agent", "data": {"type": "result", "subtype": "success"}}));
    let (_tmp, path) = written(&lines);
    let events = replay(&path, vec![]).await;
    let said = events.iter().find_map(|event| match &event.body { Body::Text { text } => Some(text.clone()), _ => None }).unwrap();
    assert!(said.starts_with("the last was id") && !said.contains(&uuid(20_000)), "the last recorded id is mapped");
    assert_eq!(kinds(&events), ["started", "prompted", "turn_started", "text", "turn_ended", "closed"]);
}

#[tokio::test]
async fn replay_a_reply_or_a_tool_result_that_pairs_with_nothing_is_refused_with_its_line() {
    let lines = lines_of("claude/native/2-permission.jsonl");
    let at = |seq: u64| lines.iter().position(|line| line["seq"] == seq).unwrap();
    let mut reply = lines.clone();
    reply[at(30)]["data"]["response"]["request_id"] = json!("no-such-request");
    let (_tmp, path) = written(&reply);
    assert!(refused(&path) == format!(":{}: a reply to no request", at(30) + 1), "the unpaired reply's line is named");
    let mut result = lines.clone();
    result[at(51)]["data"]["message"]["content"][0]["tool_use_id"] = json!("toolu_0000000000000000000000");
    let (_tmp, path) = written(&result);
    assert!(refused(&path) == format!(":{}: a result for no tool call", at(51) + 1), "the unpaired result's line is named");
}

#[tokio::test]
async fn replay_an_empty_an_unknown_or_a_turnless_recording_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let empty = tmp.path().join("empty.jsonl");
    std::fs::write(&empty, "").unwrap();
    assert!(refused(&empty) == ": no steps", "an empty file");
    let exec = fixtures().join("codex/exec/1-edit-run.jsonl");
    assert!(refused(&exec).ends_with(": unknown transcript format"), "`codex exec --json` is not a wire the converter reads");
    let print = fixtures().join("gemini/print/1-edit-run.jsonl");
    assert!(refused(&print).ends_with(": unknown transcript format"), "nor is agy's print mode");
    assert!(refused(&fixtures().join("gemini/acp/0-list.jsonl")) == ": no turn in this recording", "a recording with no turn");
}

#[tokio::test]
async fn replay_a_recording_over_the_size_limit_is_refused_before_it_is_read() {
    let tmp = tempfile::tempdir().unwrap();
    let big = tmp.path().join("big.jsonl");
    std::fs::File::create(&big).unwrap().set_len(MAX_SCRIPT_BYTES + 1).unwrap();
    assert!(refused(&big) == format!(": too big: {} bytes, over the {MAX_SCRIPT_BYTES} a script may have", MAX_SCRIPT_BYTES + 1));
}

#[tokio::test]
async fn replay_a_secret_split_by_a_pause_inside_a_prompted_message_is_masked_whole() {
    let tail = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8";
    let chunk = |seq: u64, ms: u64, text: &str| {
        let update = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}});
        json!({"seq": seq, "ms": ms, "dir": "from_agent", "data": {"jsonrpc": "2.0", "method": "session/update", "params": {"update": update}}})
    };
    let (_tmp, path) = written(&[
        json!({"seq": 1, "ms": 0, "dir": "to_agent", "data": {"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {"prompt": [{"type": "text", "text": "go"}]}}}),
        chunk(2, 1_000, "the token is ghp_"),
        chunk(3, 17_000, &format!("{tail} ok")),
        json!({"seq": 4, "ms": 17_100, "dir": "from_agent", "data": {"jsonrpc": "2.0", "id": 1, "result": {"stopReason": "end_turn"}}}),
    ]);
    let texts: Vec<String> = replay(&path, vec![]).await.into_iter().filter_map(|event| match event.body { Body::Text { text } => Some(text), _ => None }).collect();
    assert!(texts == ["the token is <redacted> ok"], "the message is one text, masked whole");
}

/// Plays `fixture` with a client that sends each recorded prompt and does nothing else, and calls `act` on each event.
/// A replay that has not closed within 60 s fails the test, on the test runtime's clock.
async fn replay_with(fixture: &Path, act: impl FnMut(&harness::session::Harness, &str, &Event)) -> Vec<Event> {
    let play = replay_acting(fixture, act);
    tokio::time::timeout(Duration::from_secs(60), play).await.unwrap_or_else(|_| panic!("{} did not end", name(fixture)))
}

async fn replay_acting(fixture: &Path, mut act: impl FnMut(&harness::session::Harness, &str, &Event)) -> Vec<Event> {
    let (_tmp, dir) = data_dir();
    let mock = Mock::new(Script::load(fixture).unwrap());
    let harness = harness(&dir, &mock, 4);
    let mut client = mock.client();
    let (id, mut events) = open(&harness, false).await;
    let mut seen = vec![];
    loop {
        tokio::select! {
            event = events.recv() => {
                let event = event.unwrap();
                act(&harness, &id, &event);
                seen.push(event.clone());
                if event.body == Body::Closed {
                    return seen;
                }
            }
            Ok(()) = client.changed() => {
                if let Some(ClientAction::Prompt(Some(text))) = client.borrow_and_update().clone() {
                    harness.send(&id, text).unwrap();
                }
            }
        }
    }
}

fn reason(events: &[Event]) -> Option<String> {
    events.iter().find_map(|event| match &event.body { Body::Failed { reason, .. } => Some(reason.clone()), _ => None })
}

#[tokio::test]
async fn replay_a_cancel_the_recording_does_not_have_fails_the_replay() {
    let fixture = fixtures().join("claude/native/2-permission.jsonl");
    let events = replay_with(&fixture, |harness, id, event| {
        if matches!(event.body, Body::Permission { .. }) {
            harness.cancel(id).unwrap();
        }
    })
    .await;
    assert_eq!(reason(&events).as_deref(), Some("the replay was cancelled where the recording was not"));
}

#[tokio::test(start_paused = true)]
async fn replay_a_recorded_cancel_the_client_never_sends_fails_the_replay_after_a_limit() {
    let events = replay_with(&fixtures().join("codex/app-server/3-cancel.jsonl"), |_, _, _| {}).await;
    assert_eq!(reason(&events).as_deref(), Some("the recorded client's cancel did not come within 30 s"));
}

#[tokio::test]
async fn replay_a_client_that_missed_events_says_it_did_not_follow_the_recording() {
    let (_tmp, dir) = data_dir();
    let mock = Mock::new(Script::load(&fixtures().join("claude/native/2-permission.jsonl")).unwrap());
    let harness = harness(&dir, &mock, 4);
    let (id, _events) = open(&harness, false).await;
    let (sender, lagging) = tokio::sync::broadcast::channel(1);
    for body in [Body::Waiting, Body::Waiting, Body::Closed] {
        sender.send(Event { seq: 0, ms: 0, body, cut: None }).unwrap();
    }
    assert!(!drive(&harness, &id, lagging, mock.client(), vec![], None, |_| {}).await, "a lagged client did not follow");
}

fn acp(seq: u64, ms: u64, dir: &str, data: Value) -> Value {
    let mut data = data;
    data["jsonrpc"] = json!("2.0");
    json!({"seq": seq, "ms": ms, "dir": dir, "data": data})
}

fn acp_update(seq: u64, ms: u64, update: Value) -> Value {
    acp(seq, ms, "from_agent", json!({"method": "session/update", "params": {"update": update}}))
}

fn acp_prompt(seq: u64, ms: u64, id: u64) -> Value {
    acp(seq, ms, "to_agent", json!({"id": id, "method": "session/prompt", "params": {"prompt": [{"type": "text", "text": "go"}]}}))
}

fn acp_end(seq: u64, ms: u64, id: u64) -> Value {
    acp(seq, ms, "from_agent", json!({"id": id, "result": {"stopReason": "end_turn"}}))
}

/// A prompted turn, then a turn agy starts by itself with a call that stays open.
fn acp_unprompted_with_open_call() -> Vec<Value> {
    vec![
        acp_prompt(1, 0, 1),
        acp_end(2, 100, 1),
        acp_update(3, 20_000, json!({"sessionUpdate": "tool_call", "toolCallId": "call_aaaaaaaa", "name": "ask", "kind": "other"})),
    ]
}

#[tokio::test]
async fn replay_a_prompt_sent_while_agys_unprompted_turn_has_a_call_open_runs_after_the_call_completes() {
    let mut lines = acp_unprompted_with_open_call();
    lines.extend([
        acp_prompt(4, 21_000, 2),
        acp_update(5, 22_000, json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_aaaaaaaa", "status": "completed", "rawOutput": "blue"})),
        acp_update(6, 22_100, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "after"}})),
        acp_end(7, 23_000, 2),
    ]);
    let (_tmp, path) = written(&lines);
    let kinds = kinds(&replay(&path, vec![]).await);
    let result = kinds.iter().position(|kind| kind == "tool_result").unwrap();
    let prompted = kinds.iter().rposition(|kind| kind == "prompted").unwrap();
    assert!(result < prompted && kinds[prompted - 1] == "turn_ended", "the call's result is in agy's own turn: {kinds:?}");
    assert_eq!(kinds[prompted..], ["prompted", "turn_started", "text", "turn_ended", "closed"], "{kinds:?}");
}

#[tokio::test]
async fn replay_a_cancel_sent_while_agys_unprompted_turn_waits_out_a_call_comes_before_its_end() {
    let mut lines = acp_unprompted_with_open_call();
    lines.push(acp(4, 21_000, "to_agent", json!({"method": "session/cancel", "params": {}})));
    // agy's next line comes after the call's cut and margin, so the turn ended before it.
    lines.push(acp_update(5, 215_000, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "later"}})));
    let (_tmp, path) = written(&lines);
    let events = replay(&path, vec![]).await;
    let ends: Vec<&Body> = events.iter().map(|event| &event.body).filter(|body| matches!(body, Body::TurnEnded { .. })).collect();
    assert!(ends[1] == &Body::TurnEnded { how: TurnEnd::Cancelled }, "the cancel ends agy's own turn: {:?}", kinds(&events));
}

#[tokio::test]
async fn replay_an_acp_tool_result_with_no_call_id_is_refused() {
    let mut lines = acp_unprompted_with_open_call();
    lines.push(acp_update(4, 20_100, json!({"sessionUpdate": "tool_call_update", "status": "completed"})));
    let (_tmp, path) = written(&lines);
    assert!(refused(&path) == ":4: a tool result with no call id");
}

#[tokio::test]
async fn replay_a_recording_with_timestamps_near_the_largest_number_plays() {
    let near = u64::MAX - 10;
    let (_tmp, path) = written(&[acp_prompt(1, near, 1), acp_update(2, near + 1, json!({"sessionUpdate": "tool_call", "toolCallId": "call_bbbbbbbb", "name": "ask"})), acp_end(3, near + 2, 1)]);
    assert_eq!(kinds(&replay(&path, vec![]).await), ["started", "prompted", "turn_started", "tool_call", "turn_ended", "closed"]);
}

#[tokio::test]
async fn replay_a_prompt_held_behind_a_running_turn_survives_the_steps_that_follow_it() {
    // 14-workflow-run with a prompt sent during the first turn, after its first tool call and before its result.
    let mut lines = vec![];
    for line in lines_of("claude/native/14-workflow-run.jsonl") {
        let seq = line["seq"].as_u64().unwrap();
        lines.push(line);
        if seq == 22 {
            lines.push(json!({"seq": 1022, "ms": 1_700, "dir": "to_agent", "data": {"type": "user", "message": {"role": "user", "content": "and now?"}}}));
        }
    }
    let (_tmp, path) = written(&lines);
    let kinds = kinds(&replay(&path, vec![]).await);
    assert_eq!(kinds.iter().filter(|kind| *kind == "prompted").count(), 2, "the held prompt is played: {kinds:?}");
}

#[tokio::test]
async fn replay_a_recorded_prompt_names_the_play_s_session_not_the_recorded_one() {
    let session = "2f2e2d2c-2b2a-4929-8827-262524232221";
    let prompt = acp(1, 0, "to_agent", json!({"id": 1, "method": "session/prompt", "params": {"sessionId": session, "prompt": [{"type": "text", "text": format!("resume {session}")}]}}));
    let (_tmp, path) = written(&[prompt, acp_end(2, 10, 1)]);
    let events = replay(&path, vec![]).await;
    let Body::Started { provider_session, .. } = &events[0].body else { panic!("the first event is not `started`") };
    let prompted = events.iter().find_map(|event| match &event.body { Body::Prompted { text } => Some(text.clone()), _ => None }).unwrap();
    assert!(prompted == format!("resume {provider_session}"), "the prompt names the play's session");
}

#[tokio::test]
async fn replay_a_script_of_capabilities_alone_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("caps.jsonl");
    std::fs::write(&path, "{\"capabilities\": {}}\n").unwrap();
    assert!(refused(&path) == ": no steps");
}

#[tokio::test]
async fn replay_a_file_that_grows_past_the_limit_as_it_is_read_is_refused() {
    // A pipe has no size to read beforehand, as a file still being written has the wrong one.
    let tmp = tempfile::tempdir().unwrap();
    let pipe = tmp.path().join("pipe.jsonl");
    let name = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let writer = std::thread::spawn({
        let pipe = pipe.clone();
        move || {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().write(true).open(pipe).unwrap();
            let chunk = vec![b' '; 1 << 20];
            for _ in 0..=MAX_SCRIPT_BYTES >> 20 {
                if file.write_all(&chunk).is_err() {
                    return;
                }
            }
        }
    });
    let refusal = refused(&pipe);
    writer.join().unwrap();
    assert!(refusal == format!(": too big: {} bytes, over the {MAX_SCRIPT_BYTES} a script may have", MAX_SCRIPT_BYTES + 1));
}
