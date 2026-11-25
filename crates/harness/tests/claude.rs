//! The Claude driver against the wire replay (`test-support/wire-replay`), which plays H0's `claude/native`
//! recordings and checks every line the driver sends.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use harness::claude::driver::ClaudeDriver;
use harness::env::RunEnv;
use harness::event::{Body, Decision, Event, FailKind, PermissionKind};
use harness::process::{self, Process};
use harness::session::{Harness, Open};
use harness::store::Store;
use harness::work::Setup;
use serde_json::{Value, json};
use tokio::sync::broadcast;

const REPLAY: &str = env!("CARGO_BIN_EXE_wire-replay");

fn native() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spikes/acp/fixtures/claude/native")
}

fn fixtures() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(native()).unwrap().map(|entry| entry.unwrap().path()).collect();
    files.retain(|file| file.extension().is_some_and(|ext| ext == "jsonl") && !file.to_string_lossy().ends_with(".mcp-log.jsonl"));
    files.sort();
    files
}

fn name(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

fn lines_of(fixture: &Path) -> Vec<Value> {
    std::fs::read_to_string(fixture).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

/// Writes `lines` as a recording in `dir`.
fn written(dir: &Path, lines: &[Value]) -> PathBuf {
    let path = dir.join("made.jsonl");
    std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    path
}

struct Rig {
    tmp: tempfile::TempDir,
    out: PathBuf,
    harness: Harness,
}

/// A harness whose `claude` is the wire replay of `fixture`, on a shell environment that holds only what the replay
/// needs and `extra`.
fn rig(fixture: &Path, extra: &[(&str, &str)]) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let (out, data) = (tmp.path().join("out"), tmp.path().join("data"));
    std::fs::create_dir_all(&out).unwrap();
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("WIRE_REPLAY_FIXTURE".into(), fixture.display().to_string()),
        ("WIRE_REPLAY_OUT".into(), out.display().to_string()),
    ];
    env.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    let setup = Setup::new(None, data.clone()).with_shell_env(RunEnv::from_pairs(env));
    let driver = ClaudeDriver::new(REPLAY.into()).with_graces(Duration::from_millis(300), Duration::from_millis(1_500));
    let harness = Harness::with_setup(Store::open(&data).unwrap(), vec![("claude".into(), Arc::new(driver))], settings(4), Arc::new(setup));
    Rig { tmp, out, harness }
}

impl Rig {
    async fn open(&self, locked: bool, model: Option<&str>) -> (String, broadcast::Receiver<Event>) {
        let spec = Open { provider: "claude".into(), cwd: self.tmp.path().to_path_buf(), locked, model: model.map(str::to_owned), ..Open::default() };
        self.harness.open(spec).await.unwrap()
    }

    fn report(&self) -> String {
        std::fs::read_to_string(self.out.join("report.txt")).unwrap_or_default()
    }

    fn argv(&self) -> Vec<String> {
        serde_json::from_slice(&std::fs::read(self.out.join("argv.json")).unwrap()).unwrap()
    }

    fn env(&self) -> serde_json::Map<String, Value> {
        serde_json::from_slice::<Value>(&std::fs::read(self.out.join("env.json")).unwrap()).unwrap().as_object().unwrap().clone()
    }

    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.out.join("sent.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    /// The replay's process, read while it runs.
    fn process(&self) -> Process {
        let pid: u32 = std::fs::read_to_string(self.out.join("pid")).unwrap().parse().unwrap();
        Process { pid, started: process::started_of(pid).expect("the replay runs") }
    }
}

/// What the recorded client did, in order.
#[derive(Debug, Clone, PartialEq)]
enum Act {
    Prompt(String),
    Answer(Decision),
    Cancel,
}

fn texts(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The recorded client's acts and how many `result`s the agent sent, up to a signal the recording's driver sent.
fn recorded_client(lines: &[Value]) -> (Vec<Act>, usize) {
    let (mut acts, mut results) = (vec![], 0);
    for line in lines.iter().take_while(|line| line["data"]["note"] != "signal") {
        let data = &line["data"];
        match (line["dir"].as_str(), data["type"].as_str()) {
            (Some("to_agent"), Some("user")) => acts.push(Act::Prompt(texts(&data["message"]["content"]))),
            (Some("to_agent"), Some("control_response")) => {
                acts.push(Act::Answer(if data["response"]["response"]["behavior"] == "allow" { Decision::Allow } else { Decision::Deny }))
            }
            (Some("to_agent"), Some("control_request")) if data["request"]["subtype"] == "interrupt" => acts.push(Act::Cancel),
            (Some("from_agent"), Some("result")) => results += 1,
            _ => {}
        }
    }
    (acts, results)
}

/// The next event into `seen`. The replay's process is read at the session's `started`, while it surely runs: it
/// leaves only once stdin closes.
async fn next_within(rig: &Rig, events: &mut broadcast::Receiver<Event>, seen: &mut Vec<Event>, agent: &mut Option<Process>) {
    let event = tokio::time::timeout(Duration::from_secs(30), events.recv()).await.expect("an event within 30 s").unwrap();
    if agent.is_none() && matches!(event.body, Body::Started { .. }) {
        *agent = Some(rig.process());
    }
    seen.push(event);
}

fn ends(seen: &[Event]) -> usize {
    seen.iter().filter(|event| matches!(event.body, Body::TurnEnded { .. } | Body::Failed { kind: FailKind::Provider, .. })).count()
}

/// Plays the recorded client through the session: prompts are sent at once (the session holds them while a turn runs),
/// each answer waits for its request, a cancel waits for a running turn. Once the agent has sent as many `result`s as
/// the recording, the session is closed. Every event up to `closed`.
async fn drive(rig: &Rig, id: &str, events: &mut broadcast::Receiver<Event>, acts: Vec<Act>, results: usize) -> (Vec<Event>, Process) {
    let (mut seen, mut agent) = (vec![], None);
    let mut answered = 0;
    for act in acts {
        match act {
            Act::Prompt(text) => rig.harness.send(id, text).unwrap(),
            Act::Answer(decision) => loop {
                let asked: Vec<&str> = seen.iter().filter_map(|event: &Event| match &event.body { Body::Permission { id, .. } => Some(id.as_str()), _ => None }).collect();
                if let Some(request) = asked.get(answered) {
                    rig.harness.answer(id, request, decision, None).unwrap();
                    answered += 1;
                    break;
                }
                next_within(rig, events, &mut seen, &mut agent).await;
            },
            Act::Cancel => {
                while !seen.iter().rev().find(|event| matches!(event.body, Body::TurnStarted) || event.body.ends_turn()).is_some_and(|event| event.body == Body::TurnStarted) {
                    next_within(rig, events, &mut seen, &mut agent).await;
                }
                rig.harness.cancel(id).unwrap();
            }
        }
    }
    while ends(&seen) < results {
        next_within(rig, events, &mut seen, &mut agent).await;
    }
    rig.harness.close(id).unwrap();
    while !seen.last().is_some_and(|event| event.body == Body::Closed) {
        next_within(rig, events, &mut seen, &mut agent).await;
    }
    (seen, agent.expect("the session started"))
}

async fn play(fixture: &Path) -> (Rig, Vec<Event>) {
    let rig = rig(fixture, &[]);
    let (acts, results) = recorded_client(&lines_of(fixture));
    let (id, mut events) = rig.open(false, None).await;
    let (seen, _) = drive(&rig, &id, &mut events, acts, results).await;
    (rig, seen)
}

/// The driver's projection with its first `started` moved to the front, where the mock sends it: Claude names its
/// session only in `init`, after the first prompt (findings row 11), so the driver can say it no sooner.
fn as_the_mock_orders_it(mut lines: Vec<String>) -> Vec<String> {
    let started = lines.iter().position(|line| line == "started").expect("the session starts");
    let first_turn = lines.iter().position(|line| line == "turn_started").expect("a turn starts");
    assert!(first_turn < started, "the driver names the session only after its first turn began: {lines:?}");
    let line = lines.remove(started);
    lines.insert(0, line);
    lines
}

/// The events with the session's id written as the mock writes its own, `mock-` and 16 hex digits. The mock names
/// its session so wherever the recording held the recorded id, free text among it, so a text or output that holds the
/// id is 15 characters shorter in the golden file per time it holds it (`14-workflow-run`'s Workflow result holds it
/// four times, `3-background-exit`'s Bash result once). The replay keeps the recording's length.
fn as_the_mock_names_the_session(events: &[Event]) -> Vec<Event> {
    let Some(session) = events.iter().find_map(|event| match &event.body { Body::Started { provider_session, .. } => Some(provider_session.clone()), _ => None }) else {
        return events.to_vec();
    };
    let text = serde_json::to_string(events).unwrap().replace(&session, "mock-0000000000000000");
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn claude_every_native_fixture_projects_as_its_golden_file() {
    let goldens = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/claude/native");
    let mut differ = vec![];
    for fixture in fixtures() {
        let (rig, seen) = play(&fixture).await;
        assert_eq!(rig.report(), "", "{}: the replay refused a line", name(&fixture));
        let got = as_the_mock_orders_it(project(&as_the_mock_names_the_session(&seen))).join("\n") + "\n";
        let want = std::fs::read_to_string(goldens.join(name(&fixture)).with_extension("txt")).unwrap();
        if got != want {
            differ.push((name(&fixture), got, want));
        }
    }
    let names: Vec<&String> = differ.iter().map(|(name, ..)| name).collect();
    for (name, got, want) in &differ {
        eprintln!("== {name}\n-- driver\n{got}-- golden\n{want}");
    }
    assert!(differ.is_empty(), "the driver's projection differs from the golden file for {names:?}");
}

#[tokio::test]
async fn claude_turns_are_counted_by_result() {
    let (_, seen) = play(&native().join("14-workflow-run.jsonl")).await;
    let kinds = types(&seen);
    let count = |kind: &str| kinds.iter().filter(|seen| *seen == kind).count();
    assert_eq!((count("prompted"), count("turn_started"), count("turn_ended")), (1, 2, 2), "{kinds:?}");
}

#[tokio::test]
async fn claude_the_normal_profiles_argv_is_exactly_the_stream_flags_a_model_and_the_guard() {
    let fixture = native().join("6-model.jsonl");
    for model in [None, Some("haiku")] {
        let rig = rig(&fixture, &[]);
        let (acts, results) = recorded_client(&lines_of(&fixture));
        let (id, mut events) = rig.open(false, model).await;
        drive(&rig, &id, &mut events, acts, results).await;
        let mut want: Vec<String> = harness::claude::driver::STREAM.iter().map(|flag| (*flag).to_owned()).collect();
        if let Some(model) = model {
            want.extend(["--model".into(), model.into()]);
        }
        want.extend(["--append-system-prompt".into(), harness::driver::GUARD.into()]);
        assert_eq!(rig.argv(), want);
        assert_eq!(&want[..9], ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"]);
    }
}

#[tokio::test]
async fn claude_the_normal_profile_passes_no_restricting_flag() {
    let (rig, _) = play(&native().join("6-model.jsonl")).await;
    let argv = rig.argv();
    for flag in [
        "--tools", "--disallowedTools", "--allowedTools", "--permission-mode", "--setting-sources", "--strict-mcp-config", "--disable-slash-commands",
        "--settings", "--agents", "--agent", "--add-dir", "--plugin-dir", "--mcp-config", "--bare", "--safe-mode", "--restricted",
        "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
    ] {
        assert!(!argv.iter().any(|arg| arg == flag), "{flag}");
    }
}

#[tokio::test]
async fn claude_the_locked_profiles_argv_is_pips_lockdown_without_a_config_file_or_a_prefix_rule() {
    let fixture = native().join("11-locked.jsonl");
    let rig = rig(&fixture, &[]);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = rig.open(true, Some("haiku")).await;
    drive(&rig, &id, &mut events, acts, results).await;
    let mut want: Vec<String> = harness::claude::driver::STREAM.iter().map(|flag| (*flag).to_owned()).collect();
    want.extend(["--permission-mode", "dontAsk", "--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config", "--model", "haiku"].map(String::from));
    assert_eq!(rig.argv(), want);
    assert!(!rig.argv().iter().any(|arg| arg.contains("mcp__")), "no prefix rule");
    assert_eq!(rig.env()["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
}

#[tokio::test]
async fn claude_the_child_gets_the_launch_environment_and_nothing_else() {
    let (normal, _) = play(&native().join("6-model.jsonl")).await;
    let mut names: Vec<String> = normal.env().keys().cloned().collect();
    // macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts.
    names.retain(|name| name != "__CF_USER_TEXT_ENCODING");
    names.sort();
    assert_eq!(names, ["PATH", "WIRE_REPLAY_FIXTURE", "WIRE_REPLAY_OUT"]);
    let (locked, _) = {
        let fixture = native().join("11-locked.jsonl");
        let rig = rig(&fixture, &[]);
        let (acts, results) = recorded_client(&lines_of(&fixture));
        let (id, mut events) = rig.open(true, None).await;
        let (seen, _) = drive(&rig, &id, &mut events, acts, results).await;
        (rig, seen)
    };
    let mut names: Vec<String> = locked.env().keys().cloned().collect();
    names.retain(|name| name != "__CF_USER_TEXT_ENCODING");
    names.sort();
    assert_eq!(names, ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "PATH", "WIRE_REPLAY_FIXTURE", "WIRE_REPLAY_OUT"]);
}

#[tokio::test]
async fn claude_initialize_goes_first() {
    let (rig, _) = play(&native().join("2-permission.jsonl")).await;
    let sent = rig.sent();
    assert_eq!(sent[0]["type"], "control_request");
    assert_eq!(sent[0]["request"]["subtype"], "initialize");
    assert_eq!(sent[1]["type"], "user", "then the prompt");
}

#[tokio::test]
async fn claude_permissions_are_answered_in_the_shape_claude_reads() {
    let (rig, seen) = play(&native().join("2-permission.jsonl")).await;
    let kinds: Vec<PermissionKind> = seen.iter().filter_map(|event| match &event.body { Body::Permission { kind, .. } => Some(*kind), _ => None }).collect();
    assert_eq!(kinds, [PermissionKind::Command, PermissionKind::Command]);
    let answers: Vec<Value> = rig.sent().into_iter().filter(|line| line["type"] == "control_response").collect();
    assert_eq!(answers[0]["response"]["response"]["behavior"], "allow");
    assert_eq!(answers[0]["response"]["response"]["updatedInput"]["command"], "echo one > a.txt", "an allow runs the input as it was asked");
    assert_eq!(answers[1]["response"]["response"]["behavior"], "deny");
    assert!(answers[1]["response"]["response"]["message"].is_string(), "a deny says why");
}

#[tokio::test]
async fn claude_a_withdrawn_permission_closes_and_a_later_answer_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let request = "0c0d0e0f-1a2b-4c3d-8e9f-a0b1c2d3e4f5";
    let session = "1c1d1e1f-2a2b-4c3d-8e9f-b0b1c2d3e4f5";
    let line = |seq: u64, dir: &str, data: Value| json!({"seq": seq, "ms": seq, "dir": dir, "data": data});
    let fixture = written(tmp.path(), &[
        line(1, "to_agent", json!({"type": "control_request", "request_id": "spike-1", "request": {"subtype": "initialize"}})),
        line(2, "from_agent", json!({"type": "control_response", "response": {"subtype": "success", "request_id": "spike-1", "response": {}}})),
        line(3, "to_agent", json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "go"}]}})),
        line(4, "from_agent", json!({"type": "system", "subtype": "init", "session_id": session})),
        line(5, "from_agent", json!({"type": "control_request", "request_id": request, "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}})),
        line(6, "from_agent", json!({"type": "control_cancel_request", "request_id": request})),
        line(7, "from_agent", json!({"type": "result", "subtype": "success", "is_error": false, "result": "done", "session_id": session})),
        line(8, "driver", json!({"note": "close_stdin"})),
    ]);
    let rig = rig(&fixture, &[]);
    let (id, mut events) = rig.open(false, None).await;
    rig.harness.send(&id, "go").unwrap();
    let seen = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let asked = seen.iter().find_map(|event| match &event.body { Body::Permission { id, .. } => Some(id.clone()), _ => None }).unwrap();
    let closed = seen.iter().find_map(|event| match &event.body { Body::PermissionClosed { id } => Some(id.clone()), _ => None });
    assert_eq!(closed.as_deref(), Some(asked.as_str()), "the close names the harness's id of the request");
    assert!(matches!(rig.harness.answer(&id, &asked, Decision::Allow, None), Err(harness::error::Error::NotOpen(_))));
    rig.harness.close(&id).unwrap();
    until(&mut events, |body| *body == Body::Closed).await;
    assert_eq!(rig.report(), "", "no answer reached the agent");
}

#[tokio::test]
async fn claude_cancel_sends_interrupt() {
    let (rig, seen) = play(&native().join("3-cancel.jsonl")).await;
    let interrupts = rig.sent().iter().filter(|line| line["request"]["subtype"] == "interrupt").count();
    assert_eq!(interrupts, 1);
    assert_eq!(rig.report(), "");
    let ends: Vec<&Body> = seen.iter().map(|event| &event.body).filter(|body| body.ends_turn()).collect();
    assert_eq!(ends, [&Body::TurnEnded { how: harness::event::TurnEnd::Cancelled }, &Body::TurnEnded { how: harness::event::TurnEnd::Done }]);
}

/// Plays `fixture` and returns the replay's process as it ran, and every event.
async fn play_watching(fixture: &Path, extra: &[(&str, &str)]) -> (Rig, Process, Vec<Event>) {
    let rig = rig(fixture, extra);
    let (acts, results) = recorded_client(&lines_of(fixture));
    let (id, mut events) = rig.open(false, None).await;
    let (seen, agent) = drive(&rig, &id, &mut events, acts, results).await;
    (rig, agent, seen)
}

#[tokio::test]
async fn claude_stop_closes_stdin_and_a_background_task_gets_its_group_ended() {
    for fixture in ["2-permission.jsonl", "3-background-exit.jsonl"] {
        let (rig, agent, seen) = play_watching(&native().join(fixture), &[]).await;
        assert_eq!(rig.report(), "", "{fixture}");
        assert!(!seen.iter().any(|event| matches!(event.body, Body::Failed { .. })), "{fixture}: {:?}", types(&seen));
        assert!(!process::alive(&agent), "{fixture}: the agent is gone once the session is closed");
    }
}

#[tokio::test]
async fn claude_kill_ends_an_agent_that_ignores_sigterm() {
    let (_, agent, seen) = play_watching(&native().join("3-background-exit.jsonl"), &[("WIRE_REPLAY_IGNORE_TERM", "1")]).await;
    let failed: Vec<&Body> = seen.iter().map(|event| &event.body).filter(|body| matches!(body, Body::Failed { .. })).collect();
    assert!(matches!(failed[..], [Body::Failed { kind: FailKind::AgentStopped, .. }]), "the session told the driver to kill: {failed:?}");
    assert!(!process::alive(&agent), "the agent is gone once the session is closed");
}
