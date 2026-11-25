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
    /// The seq of the last agent line the replay has written, from its progress FIFO.
    written: tokio::sync::watch::Receiver<u64>,
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
    let fifo = tmp.path().join("progress");
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: a valid path and mode.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    env.push(("WIRE_REPLAY_PROGRESS".into(), fifo.display().to_string()));
    let (seen, written) = tokio::sync::watch::channel(0);
    // Opening blocks until the replay opens its end, and the read ends when the replay goes.
    std::thread::spawn(move || {
        let Ok(file) = std::fs::File::open(fifo) else { return };
        for line in std::io::BufRead::lines(std::io::BufReader::new(file)).map_while(Result::ok) {
            if let Ok(seq) = line.parse() {
                seen.send_replace(seq);
            }
        }
    });
    let setup = Setup::new(None, data.clone()).with_shell_env(RunEnv::from_pairs(env));
    let driver = ClaudeDriver::new(REPLAY.into()).with_graces(Duration::from_millis(300), Duration::from_millis(1_500));
    let harness = Harness::with_setup(Store::open(&data).unwrap(), vec![("claude".into(), Arc::new(driver))], settings(4), Arc::new(setup));
    Rig { tmp, out, harness, written }
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

/// What the recorded client did, in order, each with the seq of the agent line the recording has it follow.
#[derive(Debug, Clone, PartialEq)]
enum Act {
    Prompt(String, u64),
    /// Sent as soon as its request is seen, as a driver does: the real CLI takes an answer any time after its request.
    Answer(Decision),
    Cancel(u64),
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
    let (mut acts, mut results, mut after, mut config) = (vec![], 0, 0, vec![]);
    for line in lines.iter().take_while(|line| line["data"]["note"] != "signal") {
        let data = &line["data"];
        match (line["dir"].as_str(), data["type"].as_str()) {
            (Some("to_agent"), Some("user")) => acts.push(Act::Prompt(texts(&data["message"]["content"]), after)),
            (Some("to_agent"), Some("control_response")) => {
                acts.push(Act::Answer(if data["response"]["response"]["behavior"] == "allow" { Decision::Allow } else { Decision::Deny }))
            }
            (Some("to_agent"), Some("control_request")) if data["request"]["subtype"] == "interrupt" => acts.push(Act::Cancel(after)),
            (Some("to_agent"), Some("control_request")) => config.push(data["request_id"].clone()),
            // The replay does not play the answer to a config request the driver did not send.
            (Some("from_agent"), Some("control_response")) if config.contains(&data["response"]["request_id"]) => {}
            (Some("from_agent"), kind) => {
                after = line["seq"].as_u64().unwrap();
                results += usize::from(kind == Some("result"));
            }
            _ => {}
        }
    }
    (acts, results)
}

/// Until the replay has written the agent line `seq`: what the recorded client did next came after it.
async fn played(rig: &Rig, seq: u64) {
    let mut written = rig.written.clone();
    let waited = tokio::time::timeout(Duration::from_secs(30), written.wait_for(|at| *at >= seq)).await.expect("the replay plays on");
    // The progress ends with the replay: what it refused is in its report, which names a line and never a payload.
    assert!(waited.is_ok(), "the replay ended before line {seq}: {}", rig.report());
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
/// each answer goes as soon as its request is seen, a cancel waits for a running turn. Once the agent has sent as many `result`s as
/// the recording, the session is closed. Every event up to `closed`.
async fn drive(rig: &Rig, id: &str, events: &mut broadcast::Receiver<Event>, acts: Vec<Act>, results: usize) -> (Vec<Event>, Process) {
    let (mut seen, mut agent) = (vec![], None);
    let mut answered = 0;
    for act in acts {
        match act {
            Act::Prompt(text, after) => {
                played(rig, after).await;
                rig.harness.send(id, text).unwrap()
            }
            Act::Answer(decision) => loop {
                let asked: Vec<&str> = seen.iter().filter_map(|event: &Event| match &event.body { Body::Permission { id, .. } => Some(id.as_str()), _ => None }).collect();
                if let Some(request) = asked.get(answered) {
                    rig.harness.answer(id, request, decision, None).unwrap();
                    answered += 1;
                    break;
                }
                next_within(rig, events, &mut seen, &mut agent).await;
            },
            Act::Cancel(after) => {
                // Not before the agent line the recording interrupts after (a tool that started), which may give the
                // driver nothing to say: the replay's progress tells it.
                played(rig, after).await;
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

/// The driver's endpoint, as its `mcp_set_servers` gave it: the per-session name and the server.
fn endpoint(rig: &Rig) -> (String, Value) {
    let sent = rig.sent();
    let set = sent.iter().find(|line| line["request"]["subtype"] == "mcp_set_servers").expect("the driver gave the endpoint");
    let servers = set["request"]["servers"].as_object().unwrap();
    assert_eq!(servers.len(), 1, "the driver gives its own server and no other");
    let (name, server) = servers.iter().next().unwrap();
    (name.clone(), server.clone())
}

/// The recorded endpoint's server name, as the replay finds it: the recording's one server, or of several the one the
/// recorded `--allowedTools` names.
fn recorded_endpoint(lines: &[Value]) -> Option<String> {
    let set = lines.iter().find(|line| line["dir"] == "to_agent" && line["data"]["request"]["subtype"] == "mcp_set_servers")?;
    let servers: Vec<&String> = set["data"]["request"]["servers"].as_object()?.keys().collect();
    let argv: Vec<&str> = lines[0]["data"]["detail"]["argv"].as_array()?.iter().filter_map(Value::as_str).collect();
    let allowed = argv.iter().position(|arg| *arg == "--allowedTools").and_then(|at| argv.get(at + 1)).copied().unwrap_or_default();
    match servers[..] {
        [one] => Some(one.clone()),
        _ => servers.into_iter().find(|server| allowed.split(',').any(|tool| tool.starts_with(&format!("mcp__{server}__")))).cloned(),
    }
}

/// The events with the endpoint's tools under the recorded name: the replay gives them the driver's per-session name.
fn as_recorded_tools(events: &[Event], ours: &str, recorded: Option<&str>) -> Vec<Event> {
    let Some(recorded) = recorded else { return events.to_vec() };
    let text = serde_json::to_string(events).unwrap().replace(&format!("mcp__{ours}__"), &format!("mcp__{recorded}__"));
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn claude_every_native_fixture_projects_as_its_golden_file() {
    let goldens = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/claude/native");
    let mut differ = vec![];
    for fixture in fixtures() {
        let (rig, seen) = play(&fixture).await;
        assert_eq!(rig.report(), "", "{}: the replay refused a line", name(&fixture));
        let seen = as_recorded_tools(&seen, &endpoint(&rig).0, recorded_endpoint(&lines_of(&fixture)).as_deref());
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
        want.extend(["--allowedTools".into(), format!("mcp__{}__result", endpoint(&rig).0)]);
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
        "--tools", "--disallowedTools", "--permission-mode", "--setting-sources", "--strict-mcp-config", "--disable-slash-commands",
        "--settings", "--agents", "--agent", "--add-dir", "--plugin-dir", "--mcp-config", "--bare", "--safe-mode", "--restricted",
        "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
    ] {
        assert!(!argv.iter().any(|arg| arg == flag), "{flag}");
    }
    let allowed = argv.iter().position(|arg| arg == "--allowedTools").map(|at| argv[at + 1].clone());
    assert_eq!(allowed, Some(format!("mcp__{}__result", endpoint(&rig).0)), "it allows the endpoint's own tool and nothing else");
}

#[tokio::test]
async fn claude_the_locked_profiles_argv_is_pips_lockdown_without_a_config_file_or_a_prefix_rule() {
    let fixture = native().join("11-locked.jsonl");
    let rig = rig(&fixture, &[]);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = rig.open(true, Some("haiku")).await;
    drive(&rig, &id, &mut events, acts, results).await;
    let mut want: Vec<String> = harness::claude::driver::STREAM.iter().map(|flag| (*flag).to_owned()).collect();
    want.extend(["--permission-mode", "dontAsk", "--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config"].map(String::from));
    let (name, _) = endpoint(&rig);
    want.extend(["--allowedTools".into(), format!("mcp__{name}__result"), "--model".into(), "haiku".into()]);
    assert_eq!(rig.argv(), want, "no `--mcp-config`: the endpoint goes on stdin");
    assert!(!rig.argv().iter().any(|arg| arg == "mcp__gossamr" || arg.ends_with("__")), "no prefix rule");
    assert_eq!(rig.env()["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
}

#[tokio::test]
async fn claude_the_child_gets_the_launch_environment_and_nothing_else() {
    let (normal, _) = play(&native().join("6-model.jsonl")).await;
    let mut names: Vec<String> = normal.env().keys().cloned().collect();
    // macOS adds `__CF_USER_TEXT_ENCODING` to every process it starts.
    names.retain(|name| name != "__CF_USER_TEXT_ENCODING");
    names.sort();
    assert_eq!(names, ["PATH", "WIRE_REPLAY_FIXTURE", "WIRE_REPLAY_OUT", "WIRE_REPLAY_PROGRESS"]);
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
    assert_eq!(names, ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "PATH", "WIRE_REPLAY_FIXTURE", "WIRE_REPLAY_OUT", "WIRE_REPLAY_PROGRESS"]);
}

#[tokio::test]
async fn claude_the_agents_stdin_is_the_drivers_own_pipe() {
    // Run from a test whose own stdin is whatever cargo gives it: the agent must not get that.
    let (rig, _) = play(&native().join("2-permission.jsonl")).await;
    assert_eq!(std::fs::read_to_string(rig.out.join("stdin")).unwrap(), "pipe");
    assert_eq!(rig.sent()[0]["request"]["subtype"], "initialize", "and the driver writes to it");
}

#[tokio::test]
async fn claude_initialize_goes_first() {
    let (rig, _) = play(&native().join("2-permission.jsonl")).await;
    let sent = rig.sent();
    assert_eq!(sent[0]["type"], "control_request");
    assert_eq!(sent[0]["request"]["subtype"], "initialize");
    assert_eq!(sent[1]["request"]["subtype"], "mcp_set_servers", "then the endpoint");
    assert_eq!(sent[2]["type"], "user", "then the prompt");
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

#[tokio::test]
async fn claude_the_endpoint_goes_by_mcp_set_servers_in_both_profiles_with_its_header_and_the_call_limit() {
    for (fixture, locked) in [("6-model.jsonl", false), ("11-locked.jsonl", true)] {
        let fixture = native().join(fixture);
        let rig = rig(&fixture, &[]);
        let (acts, results) = recorded_client(&lines_of(&fixture));
        let (id, mut events) = rig.open(locked, None).await;
        drive(&rig, &id, &mut events, acts, results).await;
        assert_eq!(rig.report(), "");
        let (name, server) = endpoint(&rig);
        assert!(name.len() == 14 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()), "a per-session name of letters and digits");
        assert_eq!(server["type"], "http");
        assert!(server["url"].as_str().is_some_and(|url| url.starts_with("http://127.0.0.1:") && url.ends_with(&format!("/mcp/{name}"))), "on loopback");
        assert_eq!(server["headers"]["Authorization"], "<redacted>", "the token goes in its header, which the replay keeps out of its files");
        assert_eq!(server["timeout"], 600_000, "a call can outwait a question");
        assert!(!rig.argv().iter().any(|arg| arg.contains("--mcp-config")));
    }
}

#[tokio::test]
async fn claude_the_token_is_in_no_argument_and_no_variable_of_the_agent() {
    use harness::driver::{Command, Driver, Launch, Secret};
    let tmp = tempfile::tempdir().unwrap();
    let (out, secret) = (tmp.path().join("out"), tmp.path().join("secret"));
    std::fs::create_dir_all(&out).unwrap();
    let token = Secret::random();
    std::fs::write(&secret, token.expose()).unwrap();
    let fixture = native().join("6-model.jsonl");
    let env: Vec<(std::ffi::OsString, std::ffi::OsString)> = [
        ("PATH", "/usr/bin:/bin".to_owned()),
        ("WIRE_REPLAY_FIXTURE", fixture.display().to_string()),
        ("WIRE_REPLAY_OUT", out.display().to_string()),
        ("WIRE_REPLAY_SECRET_FILE", secret.display().to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    let mut tools = harness::tools::ToolsEndpoint::unattached();
    tools.allowed = vec![format!("mcp__{}__result", tools.name)];
    let launch = Launch { cwd: tmp.path().into(), locked: false, model: None, login: None, effort: None, resume: None, tools_token: token, tools, result_schema: None, env };
    let mut link = ClaudeDriver::new(REPLAY.into()).open(launch).unwrap();
    let Some(Act::Prompt(prompt, _)) = recorded_client(&lines_of(&fixture)).0.into_iter().next() else { panic!("6-model prompts") };
    link.commands.send(Command::Prompt(prompt)).unwrap();
    while let Some(body) = tokio::time::timeout(Duration::from_secs(30), link.output.recv()).await.expect("the turn ends") {
        if body.ends_turn() {
            break;
        }
    }
    link.commands.send(Command::Stop).unwrap();
    while tokio::time::timeout(Duration::from_secs(30), link.output.recv()).await.expect("the agent goes").is_some() {}
    let held: Value = serde_json::from_slice(&std::fs::read(out.join("secret.json")).unwrap()).unwrap();
    assert_eq!(held, json!({"env": [], "argv": 0}), "no variable and no argument holds the token");
    assert_eq!(std::fs::read_to_string(out.join("report.txt")).unwrap_or_default(), "");
    let sent = std::fs::read_to_string(out.join("sent.jsonl")).unwrap();
    assert!(sent.contains("\"Authorization\":\"<redacted>\""), "it went on stdin, in the endpoint's header");
}

#[tokio::test]
async fn claude_a_second_servers_tool_and_a_colliding_name_are_left_to_the_person() {
    // R1: Claude asks for a tool that `--allowedTools` does not name exactly, and the driver never answers for the person.
    for (fixture, other) in [("r1-two-servers.jsonl", "mcp__spkx1be8eb2a__ping"), ("r1-collision.jsonl", "mcp__spka__b_c")] {
        let (rig, seen) = play(&native().join(fixture)).await;
        assert_eq!(rig.report(), "", "{fixture}");
        let (name, _) = endpoint(&rig);
        let allowed = rig.argv().iter().position(|arg| arg == "--allowedTools").map(|at| rig.argv()[at + 1].clone());
        assert_eq!(allowed, Some(format!("mcp__{name}__result")), "{fixture}: only the endpoint's own tool");
        let asked: Vec<String> = seen.iter().filter_map(|event| match &event.body { Body::Permission { tool, .. } => Some(tool.clone()), _ => None }).collect();
        assert_eq!(asked, [other], "{fixture}: the other server's tool reached the person");
        let answers = rig.sent().iter().filter(|line| line["type"] == "control_response").count();
        assert_eq!(answers, 1, "{fixture}: answered once, as the client said");
        let calls: Vec<String> = seen.iter().filter_map(|event| match &event.body { Body::ToolCall { name, .. } => Some(name.clone()), _ => None }).collect();
        assert!(calls.iter().any(|call| call.starts_with(&format!("mcp__{name}__"))), "{fixture}: the endpoint's own tool ran under its name: {calls:?}");
    }
}

#[tokio::test]
async fn claude_on_the_locked_profile_a_call_to_the_sessions_own_tool_runs_unasked() {
    let fixture = native().join("r4-locked-control.jsonl");
    let rig = rig(&fixture, &[]);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = rig.open(true, None).await;
    let (seen, _) = drive(&rig, &id, &mut events, acts, results).await;
    assert_eq!(rig.report(), "");
    let (name, _) = endpoint(&rig);
    assert!(!seen.iter().any(|event| matches!(event.body, Body::Permission { .. })), "nothing asked");
    let call = seen.iter().find_map(|event| match &event.body { Body::ToolCall { id, name: tool, .. } if *tool == format!("mcp__{name}__ping") => Some(id.clone()), _ => None });
    let call = call.expect("the session's own tool was called");
    assert!(seen.iter().any(|event| matches!(&event.body, Body::ToolResult { id, error: false, .. } if *id == call)), "and it answered, not denied");
    let allowed = rig.argv().iter().position(|arg| arg == "--allowedTools").map(|at| rig.argv()[at + 1].clone()).unwrap();
    assert!(allowed.split(',').all(|tool| tool.starts_with(&format!("mcp__{name}__")) && !tool.ends_with("__")), "no prefix rule: {allowed}");
}

#[tokio::test]
async fn claude_a_declared_tool_is_allowed_by_its_exact_name_beside_result() {
    let fixture = native().join("6-model.jsonl");
    let rig = rig(&fixture, &[]);
    let find = harness::tools::ToolSpec { name: "find".into(), description: "Finds a ticket.".into(), input_schema: json!({"type": "object"}) };
    let spec = Open { provider: "claude".into(), cwd: rig.tmp.path().to_path_buf(), tools: vec![find], ..Open::default() };
    let (id, mut events) = rig.harness.open(spec).await.unwrap();
    let (acts, results) = recorded_client(&lines_of(&fixture));
    drive(&rig, &id, &mut events, acts, results).await;
    let (name, _) = endpoint(&rig);
    let allowed = rig.argv().iter().position(|arg| arg == "--allowedTools").map(|at| rig.argv()[at + 1].clone()).unwrap();
    let mut tools: Vec<&str> = allowed.split(',').collect();
    tools.sort();
    assert_eq!(tools, [format!("mcp__{name}__find"), format!("mcp__{name}__result")]);
}
