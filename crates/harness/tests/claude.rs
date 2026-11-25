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
use harness::process::{self, Listing, Process};
use harness::session::{Harness, Open};
use harness::store::Store;
use harness::work::Setup;
use serde_json::{Value, json};
use tokio::sync::broadcast;

const REPLAY: &str = env!("CARGO_BIN_EXE_wire-replay");

/// How long the replay waits for quiet before it writes a line a prompt or interrupt follows. A driver line sent in
/// reaction to an earlier line is caught only if it comes within this. Here a reaction goes from the replay's pipe
/// through the driver's reader, the session and the driver's writer, four tasks a loaded machine can each hold back:
/// five times the replay's default leaves room for that. Each prompt after the first costs one wait.
const QUIET_MS: &str = "500";

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
    rig_on(fixture, extra, None, None)
}

/// As `rig`, on the data folder `data` when one is given, so a second harness opens the first one's store.
fn rig_on(fixture: &Path, extra: &[(&str, &str)], data: Option<&Path>, store: Option<Store>) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out");
    let data = data.map_or_else(|| tmp.path().join("data"), Path::to_path_buf);
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
    env.push(("WIRE_REPLAY_QUIET_MS".into(), QUIET_MS.into()));
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
    let store = store.unwrap_or_else(|| Store::open(&data).unwrap());
    let harness = Harness::with_setup(store, vec![("claude".into(), Arc::new(driver))], settings(4), Arc::new(setup));
    Rig { tmp, out, harness, written }
}

impl Rig {
    /// A locked session declares the tools the locked recordings' server served, since the driver refuses a locked
    /// session whose Claude offers it any tool it does not allow.
    async fn open(&self, locked: bool, model: Option<&str>) -> (String, broadcast::Receiver<Event>) {
        let recorded = |name: &&str| harness::tools::ToolSpec { name: (*name).into(), description: "Recorded.".into(), input_schema: json!({"type": "object"}) };
        let tools = if locked { RECORDED_LOCKED.iter().map(recorded).collect() } else { vec![] };
        let spec = Open { provider: "claude".into(), cwd: self.tmp.path().to_path_buf(), locked, model: model.map(str::to_owned), tools, ..Open::default() };
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
    let (mut seen, mut agent) = play_turns(rig, id, events, acts, results).await;
    rig.harness.close(id).unwrap();
    while !seen.last().is_some_and(|event| matches!(event.body, Body::Closed { .. })) {
        next_within(rig, events, &mut seen, &mut agent).await;
    }
    (seen, agent.expect("the session started"))
}

/// As `drive`, up to the agent's last `result`, with the session left running.
async fn play_turns(rig: &Rig, id: &str, events: &mut broadcast::Receiver<Event>, acts: Vec<Act>, results: usize) -> (Vec<Event>, Option<Process>) {
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
    (seen, agent)
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

/// The harness's own tools, which every session's endpoint serves.
const OWN: &[&str] = &[harness::tools::RESULT, harness::tools::ASK];

/// What `--allowedTools` holds for a session whose endpoint is `name` and serves only the harness's own tools.
fn allowed_for(name: &str) -> String {
    OWN.iter().map(|tool| format!("mcp__{name}__{tool}")).collect::<Vec<_>>().join(",")
}

/// The tools beside the harness's own that the server of every locked recording served.
const RECORDED_LOCKED: &[&str] = &["hold", "ping"];

/// What `--allowedTools` holds for a locked rig's session: the recorded tools it declares, then the harness's own.
fn locked_allowed_for(name: &str) -> String {
    RECORDED_LOCKED.iter().chain(OWN).map(|tool| format!("mcp__{name}__{tool}")).collect::<Vec<_>>().join(",")
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

/// The recorded endpoint's server name, as the replay finds it: the recording's one server, by `mcp_set_servers` or
/// else `--mcp-config`, or of several the one the recorded `--allowedTools` names.
fn recorded_endpoint(lines: &[Value]) -> Option<String> {
    let argv: Vec<&str> = lines[0]["data"]["detail"]["argv"].as_array()?.iter().filter_map(Value::as_str).collect();
    let set = lines.iter().find(|line| line["dir"] == "to_agent" && line["data"]["request"]["subtype"] == "mcp_set_servers");
    let config = argv.iter().position(|arg| *arg == "--mcp-config").and_then(|at| argv.get(at + 1)).and_then(|config| serde_json::from_str::<Value>(config).ok());
    let servers = match (set, &config) {
        (Some(set), _) => set["data"]["request"]["servers"].clone(),
        (None, Some(config)) => config["mcpServers"].clone(),
        (None, None) => return None,
    };
    let servers: Vec<&String> = servers.as_object()?.keys().collect();
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
        // The driver adds usage on purpose; H2's converter gives none, and it has a test of its own.
        let seen: Vec<Event> = seen.into_iter().filter(|event| !matches!(event.body, Body::Usage { .. })).collect();
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
        want.extend(["--allowedTools".into(), allowed_for(&endpoint(&rig).0)]);
        if let Some(model) = model {
            want.extend(["--model".into(), model.into()]);
        }
        want.extend(["--append-system-prompt".into(), harness::driver::guard(&OWN.iter().map(|tool| (*tool).to_owned()).collect::<Vec<_>>())]);
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
    assert_eq!(allowed, Some(allowed_for(&endpoint(&rig).0)), "it allows the endpoint's own tools and nothing else");
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
    want.extend(["--allowedTools".into(), locked_allowed_for(&name), "--model".into(), "haiku".into()]);
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
    assert_eq!(names, ["PATH", "WIRE_REPLAY_FIXTURE", "WIRE_REPLAY_OUT", "WIRE_REPLAY_PROGRESS", "WIRE_REPLAY_QUIET_MS"]);
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
    assert_eq!(names, ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "PATH", "WIRE_REPLAY_FIXTURE", "WIRE_REPLAY_OUT", "WIRE_REPLAY_PROGRESS", "WIRE_REPLAY_QUIET_MS"]);
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
    until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
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
        assert_eq!(allowed, Some(allowed_for(&name)), "{fixture}: only the endpoint's own tools");
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
    assert_eq!(tools, [format!("mcp__{name}__ask"), format!("mcp__{name}__find"), format!("mcp__{name}__result")]);
}

#[tokio::test]
async fn claude_prompts_sent_at_once_each_reach_claude_after_the_result_before_it() {
    // The session holds them and sends each when the driver ends a turn; the replay refuses one that comes before the
    // `result` it follows, and one sent on the line before it is caught by the quiet wait.
    let fixture = native().join("11-locked.jsonl");
    let rig = rig(&fixture, &[]);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = rig.open(true, None).await;
    for act in acts {
        let Act::Prompt(text, _) = act else { panic!("11-locked only prompts") };
        rig.harness.send(&id, text).unwrap();
    }
    // Until the agent has ended as many turns as the recording, or the session closed because the replay refused.
    let mut seen: Vec<Event> = vec![];
    while ends(&seen) < results && !seen.iter().any(|event| matches!(event.body, Body::Closed { .. })) {
        match tokio::time::timeout(Duration::from_secs(30), events.recv()).await.expect("an event within 30 s") {
            Ok(event) => seen.push(event),
            Err(_) => break,
        }
    }
    let _ = rig.harness.close(&id);
    assert_eq!(rig.report(), "", "each prompt came after the result before it");
    assert_eq!(rig.sent().iter().filter(|line| line["type"] == "user").count(), 4);
}

/// The text of the recording's prompts, in order.
fn prompts(fixture: &Path) -> Vec<String> {
    recorded_client(&lines_of(fixture)).0.into_iter().filter_map(|act| match act { Act::Prompt(text, _) => Some(text), _ => None }).collect()
}

/// The driver on its own against the replay of `fixture`, with `extra` in the agent's environment.
fn direct(fixture: &Path, extra: &[(&str, &str)], driver: ClaudeDriver) -> (harness::driver::Link, PathBuf, tempfile::TempDir) {
    direct_as(fixture, extra, driver, false)
}

/// [`direct`], on the locked profile when `locked`.
fn direct_as(fixture: &Path, extra: &[(&str, &str)], driver: ClaudeDriver, locked: bool) -> (harness::driver::Link, PathBuf, tempfile::TempDir) {
    use harness::driver::{Driver, Launch, Secret};
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> =
        [("PATH", "/usr/bin:/bin".to_owned()), ("WIRE_REPLAY_FIXTURE", fixture.display().to_string()), ("WIRE_REPLAY_OUT", out.display().to_string())].into_iter().map(|(k, v)| (k.into(), v.into())).collect();
    env.extend(extra.iter().map(|(k, v)| ((*k).into(), (*v).into())));
    let tools = harness::tools::ToolsEndpoint::unattached();
    let launch = Launch { cwd: tmp.path().into(), locked, model: None, login: None, effort: None, resume: None, tools_token: Secret::random(), tools, result_schema: None, env };
    (driver.open(launch).unwrap(), out, tmp)
}

async fn said_until(link: &mut harness::driver::Link, last: impl Fn(&Body) -> bool) -> Vec<Body> {
    let mut said = vec![];
    while let Some(body) = tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the driver says more within 10 s") {
        let done = last(&body);
        said.push(body);
        if done {
            break;
        }
    }
    said
}

fn replay_process(out: &Path) -> Process {
    let pid: u32 = std::fs::read_to_string(out.join("pid")).unwrap().parse().unwrap();
    Process { pid, started: process::started_of(pid).expect("the replay runs") }
}

#[tokio::test]
async fn claude_a_driver_whose_commands_are_dropped_kills_the_agent_after_its_grace() {
    // 3-background-exit's agent stays after its turn, and this one ignores SIGTERM.
    let fixture = native().join("3-background-exit.jsonl");
    let driver = ClaudeDriver::new(REPLAY.into()).with_graces(Duration::from_millis(200), Duration::from_millis(500));
    let (mut link, out, _tmp) = direct(&fixture, &[("WIRE_REPLAY_IGNORE_TERM", "1")], driver);
    link.commands.send(harness::driver::Command::Prompt(prompts(&fixture).remove(0))).unwrap();
    let asked = said_until(&mut link, |body| matches!(body, Body::Permission { .. })).await;
    let Some(Body::Permission { id, .. }) = asked.last() else { unreachable!() };
    link.commands.send(harness::driver::Command::Answer { id: id.clone(), decision: Decision::Allow, message: None }).unwrap();
    said_until(&mut link, |body| body.ends_turn()).await;
    let agent = replay_process(&out);
    drop(link.commands);
    while tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the agent is killed, and the output closes").is_some() {}
    assert!(!process::alive(&agent), "the agent is gone");
}

#[tokio::test]
async fn claude_a_setup_never_answered_fails_the_session_with_a_reason() {
    let tmp = tempfile::tempdir().unwrap();
    let silent = written(tmp.path(), &[json!({"seq": 1, "ms": 1, "dir": "to_agent", "data": {"type": "control_request", "request_id": "spike-1", "request": {"subtype": "initialize"}}})]);
    let driver = ClaudeDriver::new(REPLAY.into()).with_setup_within(Duration::from_millis(300));
    let (mut link, _out, _tmp) = direct(&silent, &[], driver);
    link.commands.send(harness::driver::Command::Prompt("go".into())).unwrap();
    let said = said_until(&mut link, |body| matches!(body, Body::Failed { .. })).await;
    assert!(matches!(said.last(), Some(Body::Failed { kind: FailKind::Provider, reason }) if reason.contains("setup")), "{said:?}");
    while tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the agent goes").is_some() {}
}

#[tokio::test]
async fn claude_an_agent_that_exits_mid_turn_fails_with_its_last_stderr_line() {
    // The replay refuses a deny where the recording allows, says why on stderr and exits, in the middle of the turn.
    let fixture = native().join("2-permission.jsonl");
    let (mut link, _out, _tmp) = direct(&fixture, &[], ClaudeDriver::new(REPLAY.into()));
    link.commands.send(harness::driver::Command::Prompt(prompts(&fixture).remove(0))).unwrap();
    let asked = said_until(&mut link, |body| matches!(body, Body::Permission { .. })).await;
    let Some(Body::Permission { id, .. }) = asked.last() else { unreachable!() };
    link.commands.send(harness::driver::Command::Answer { id: id.clone(), decision: Decision::Deny, message: None }).unwrap();
    let said = said_until(&mut link, |body| matches!(body, Body::Failed { .. })).await;
    let reason = match said.last() {
        Some(Body::Failed { kind: FailKind::Provider, reason }) => reason.clone(),
        other => panic!("no failure: {other:?}"),
    };
    assert!(reason.starts_with("claude exited in the middle of a turn: ") && reason.contains("the decision differs"), "{reason}");
}

#[tokio::test]
async fn claude_a_locked_refusal_kills_the_agent_at_once() {
    // The fake offers a built-in tool, then holds its output open for 30 s: only the kill ends it.
    let bin = tempfile::tempdir().unwrap();
    let init = r#"{"type":"system","subtype":"init","session_id":"s-1","tools":["Bash"]}"#;
    let claude = harness::testing::fake_cli(&bin.path().join("claude"), &format!("echo '{init}'; exec sleep 30"));
    let (mut link, _out, _tmp) = direct_as(&native().join("6-model.jsonl"), &[], ClaudeDriver::new(claude), true);
    let said = said_until(&mut link, |body| matches!(body, Body::Failed { .. })).await;
    assert!(matches!(said.last(), Some(Body::Failed { reason, .. }) if reason.contains("Bash")), "{said:?}");
    let rest = tokio::time::timeout(Duration::from_secs(10), async { while link.output.recv().await.is_some() {} }).await;
    assert!(rest.is_ok(), "the agent was killed, so its output closed");
}

#[tokio::test]
async fn claude_a_line_with_an_invalid_byte_and_one_over_the_limit_are_skipped_and_the_last_stderr_line_is_masked() {
    // The fake answers `initialize`, writes a line of invalid UTF-8 and one over 32 MiB, then names its session, says
    // the endpoint's line (its token among it) on stderr and exits.
    let bin = tempfile::tempdir().unwrap();
    let body = r#"read -r first
id=$(printf '%s' "$first" | sed 's/.*"request_id":"\([^"]*\)".*/\1/')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{}}}\n' "$id"
read -r servers
printf '\377\376\n'
head -c 34000000 /dev/zero | tr '\0' a; echo
echo '{"type":"system","subtype":"init","session_id":"s-1"}'
printf 'it was given %s\n' "$servers" >&2
exit 1"#;
    let claude = harness::testing::fake_cli(&bin.path().join("claude"), body);
    let (mut link, _out, _tmp) = direct(&native().join("6-model.jsonl"), &[], ClaudeDriver::new(claude));
    let said = said_until(&mut link, |body| matches!(body, Body::Failed { .. })).await;
    assert!(matches!(&said[0], Body::Notice { text } if text.contains("32 MiB")), "the long line gave a notice: {:?}", said.first());
    assert!(matches!(&said[1], Body::Started { provider_session, .. } if provider_session == "s-1"), "it read on past both lines");
    let Some(Body::Failed { reason, .. }) = said.last() else { unreachable!() };
    assert!(reason.starts_with("claude exited") && reason.contains(": it was given ") && reason.contains("Bearer <redacted>"), "the stderr line, masked: {reason}");
}

#[tokio::test]
async fn claude_the_setup_deadline_ends_once_setup_is_answered() {
    let fixture = native().join("6-model.jsonl");
    // Counted from the open, which includes the system's first check of a newly built replay: seconds, under load.
    let within = Duration::from_secs(5);
    let opened = tokio::time::Instant::now();
    let (mut link, _out, _tmp) = direct(&fixture, &[], ClaudeDriver::new(REPLAY.into()).with_setup_within(within));
    link.commands.send(harness::driver::Command::Prompt(prompts(&fixture).remove(0))).unwrap();
    let said = said_until(&mut link, |body| body.ends_turn()).await;
    assert_eq!(said.last(), Some(&Body::TurnEnded { how: harness::event::TurnEnd::Done }), "{said:?}");
    // Nothing comes once the deadline has long passed: no failure for a setup that was answered.
    let quiet = tokio::time::timeout_at(opened + within + Duration::from_secs(1), link.output.recv()).await;
    assert!(quiet.is_err(), "nothing after the turn: {quiet:?}");
    link.commands.send(harness::driver::Command::Stop).unwrap();
    while tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the agent goes").is_some() {}
}

#[tokio::test]
async fn claude_an_agent_that_exits_before_any_prompt_fails_with_its_last_stderr_line_masked() {
    // As an older CLI that lacks one of the flags does: it says so on stderr and exits before reading a prompt.
    let bin = tempfile::tempdir().unwrap();
    let said = "error: unknown option '--disable-slash-commands' (proxy http://me:hunter2@proxy.test:8080)";
    let claude = harness::testing::fake_cli(&bin.path().join("claude"), &format!("echo \"{said}\" >&2; exit 1"));
    let (mut link, _out, _tmp) = direct(&native().join("6-model.jsonl"), &[], ClaudeDriver::new(claude));
    let said = said_until(&mut link, |body| matches!(body, Body::Failed { .. })).await;
    assert_eq!(
        said.last(),
        Some(&Body::Failed { kind: FailKind::Provider, reason: "claude exited: error: unknown option '--disable-slash-commands' (proxy http://<redacted>@proxy.test:8080)".into() }),
        "{said:?}"
    );
    while tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the agent goes").is_some() {}
}

#[tokio::test]
async fn claude_each_result_gives_a_usage_event_before_its_turns_end() {
    for fixture in fixtures() {
        let results: Vec<Value> = lines_of(&fixture).into_iter().filter(|line| line["dir"] == "from_agent" && line["data"]["type"] == "result").map(|line| line["data"].clone()).collect();
        let (_, seen) = play(&fixture).await;
        let used: Vec<(u64, u64)> = seen.iter().filter_map(|event| match event.body { Body::Usage { input_tokens, output_tokens, .. } => Some((input_tokens, output_tokens)), _ => None }).collect();
        let want: Vec<(u64, u64)> = results.iter().filter(|result| result["usage"].is_object()).map(|result| (result["usage"]["input_tokens"].as_u64().unwrap(), result["usage"]["output_tokens"].as_u64().unwrap())).collect();
        assert_eq!(used, want, "{}: one usage per result that has one, as counted", name(&fixture));
        for (at, _) in seen.iter().enumerate().filter(|(_, event)| matches!(event.body, Body::Usage { .. })) {
            assert!(seen[at + 1].body.ends_turn(), "{}: usage comes just before its turn's end", name(&fixture));
        }
    }
}

fn provider_session(seen: &[Event]) -> String {
    seen.iter().find_map(|event| match &event.body { Body::Started { provider_session, .. } => Some(provider_session.clone()), _ => None }).expect("the session started")
}

/// Until the replay has gone: its progress FIFO closes with it.
/// A rig on the data folder of a harness that just shut down, whose store's lock outlives it by a moment. The store
/// is kept, not opened again: a process another test forks meanwhile holds a dropped lock until it execs.
async fn rig_after(fixture: &Path, extra: &[(&str, &str)], data: &Path) -> Rig {
    let store = common::reopen(data).await;
    rig_on(fixture, extra, Some(data), Some(store))
}

/// Until `agent` has exited. A killed process closes its files before it is gone, and nothing else says when.
async fn gone(agent: &Process) {
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while process::alive(agent) {
        assert!(tokio::time::Instant::now() < given, "the agent outlived its kill by 10 s");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn replay_gone(rig: &Rig) {
    let mut written = rig.written.clone();
    tokio::time::timeout(Duration::from_secs(10), async { while written.changed().await.is_ok() {} }).await.expect("the replay goes");
}

/// The argv's `--resume=` values.
fn resumes(argv: &[String]) -> Vec<String> {
    argv.iter().filter_map(|arg| arg.strip_prefix("--resume=")).map(str::to_owned).collect()
}

#[tokio::test]
async fn claude_a_restart_in_the_middle_of_a_turn_stops_the_leftover_and_resumes_once() {
    let (_tmp, data) = data_dir();
    let kill = native().join("4-kill.jsonl");
    let first = rig_on(&kill, &[("WIRE_REPLAY_IGNORE_TERM", "1")], Some(&data), None);
    let (id, mut events) = first.open(false, None).await;
    first.harness.send(&id, prompts(&kill).remove(0)).unwrap();
    let seen = until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
    let asked = seen.iter().find_map(|event| match &event.body { Body::Permission { id, .. } => Some(id.clone()), _ => None }).unwrap();
    first.harness.answer(&id, &asked, Decision::Allow, None).unwrap();
    // The command runs: the recording was cut by a signal there, so the replay stays in the middle of the turn.
    let lines = lines_of(&kill);
    let cut = lines.iter().take_while(|line| line["data"]["note"] != "signal").filter(|line| line["dir"] == "from_agent").last().unwrap()["seq"].as_u64().unwrap();
    played(&first, cut).await;
    let (session, agent) = (provider_session(&seen), first.process());
    // An agent the shutdown cannot stop, as a stuck one: it ignores SIGTERM and its group kill is refused.
    process::seam::refuse_group_kills(agent.pid, 1);
    process::seam::list_group_as(agent.pid, Listing::Full);
    assert_eq!(first.harness.shutdown().await, std::slice::from_ref(&id), "the shutdown gave up on it mid-turn");
    // The shutdown gives up when the session's wait ends, which may be before the driver's kill took the refusal; the
    // next harness's leftover stop must not take it instead.
    let refused = async {
        while !process::seam::sent_to(agent.pid).contains(&libc::SIGKILL) {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), refused).await.expect("the driver tried to kill it");
    assert!(process::alive(&agent), "and it runs on");

    let resume = native().join("4-resume.jsonl");
    let second = rig_after(&resume, &[], &data).await;
    replay_gone(&first).await;
    assert_eq!(process::seam::sent_to(agent.pid).iter().filter(|signal| **signal == libc::SIGKILL).count(), 2, "the next harness killed it as it started");
    gone(&agent).await;
    let mut events = second.harness.resume_with(&id, None).await.unwrap();
    second.harness.send(&id, prompts(&resume).remove(0)).unwrap();
    let seen = until(&mut events, |body| body.ends_turn()).await;
    assert!(seen.iter().any(|event| event.body == Body::Started { provider_session: session.clone(), resumed: true }), "{:?}", types(&seen));
    assert_eq!(resumes(&second.argv()), [session], "one agent, resumed once by its session");
    second.harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    assert_eq!(second.report(), "");
    second.harness.shutdown().await;
    assert_eq!(Store::open(&data).unwrap().agents().unwrap(), [], "its agent gone, nothing is on record");
}

#[tokio::test]
async fn claude_a_resume_starts_claude_by_its_session_and_carry_on_is_the_first_prompt_it_sends() {
    let (_tmp, data) = data_dir();
    // A first start whose turn a deny did not end (Claude goes on after one), then a shutdown: nothing forbids "carry on".
    let fixture = native().join("2-permission.jsonl");
    let first = rig_on(&fixture, &[], Some(&data), None);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = first.open(false, None).await;
    let (seen, _) = play_turns(&first, &id, &mut events, acts, results).await;
    assert!(seen.iter().any(|event| matches!(event.body, Body::Answered { decision: Decision::Deny, .. })));
    let session = provider_session(&seen);
    assert_eq!(first.harness.shutdown().await, Vec::<String>::new());
    let resume = native().join("4-resume.jsonl");
    let second = rig_after(&resume, &[], &data).await;
    let carry_on = prompts(&resume).remove(0);
    let mut events = second.harness.resume_with(&id, Some(carry_on.clone())).await.unwrap();
    let seen = until(&mut events, |body| body.ends_turn()).await;
    assert_eq!(seen.iter().find(|event| matches!(event.body, Body::Started { .. })).map(|event| &event.body), Some(&Body::Started { provider_session: session.clone(), resumed: true }));
    assert_eq!(resumes(&second.argv()), [session]);
    let sent: Vec<Value> = second.sent().into_iter().filter(|line| line["type"] == "user").collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["message"]["content"][0]["text"], carry_on.as_str(), "carry on is the first prompt");
    second.harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    assert_eq!(second.report(), "");
}

#[tokio::test]
async fn claude_no_carry_on_after_a_cancelled_turn() {
    // 3-cancel up to its cancelled turn's `result`, then stdin closes.
    let tmp = tempfile::tempdir().unwrap();
    let mut lines: Vec<Value> = lines_of(&native().join("3-cancel.jsonl")).into_iter().take_while(|line| line["seq"].as_u64() <= Some(33)).collect();
    lines.push(json!({"seq": 34, "ms": 0, "dir": "driver", "data": {"note": "close_stdin"}}));
    let fixture = written(tmp.path(), &lines);
    let (_tmp, data) = data_dir();
    let first = rig_on(&fixture, &[], Some(&data), None);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = first.open(false, None).await;
    let (seen, _) = play_turns(&first, &id, &mut events, acts, results).await;
    let ends: Vec<&Body> = seen.iter().map(|event| &event.body).filter(|body| body.ends_turn()).collect();
    assert_eq!(ends, [&Body::TurnEnded { how: harness::event::TurnEnd::Cancelled }]);
    // A shutdown, not a stop, so the cancel is what forbids it.
    first.harness.shutdown().await;
    assert_eq!(first.report(), "");
    let second = rig_after(&fixture, &[], &data).await;
    let refused = second.harness.resume_with(&id, Some("carry on".into())).await;
    assert!(matches!(&refused, Err(harness::error::Error::Refused(why)) if why.contains("cancelled")), "{:?}", refused.err());
}

#[tokio::test]
async fn claude_a_usage_events_cost_is_its_turns_not_the_processes_total() {
    // 11-locked's `result`s give the process's total so far: 0.00098, 0.00118, 0.00138, 0.00149.
    let fixture = native().join("11-locked.jsonl");
    let totals: Vec<f64> = lines_of(&fixture).into_iter().filter(|line| line["dir"] == "from_agent" && line["data"]["type"] == "result").filter_map(|line| line["data"]["total_cost_usd"].as_f64()).collect();
    let rig = rig(&fixture, &[]);
    let (acts, results) = recorded_client(&lines_of(&fixture));
    let (id, mut events) = rig.open(true, None).await;
    let (seen, _) = drive(&rig, &id, &mut events, acts, results).await;
    let costs: Vec<f64> = seen.iter().filter_map(|event| match event.body { Body::Usage { cost_usd, .. } => cost_usd, _ => None }).collect();
    let turns: Vec<f64> = totals.iter().scan(0.0, |before, total| Some(total - std::mem::replace(before, *total))).collect();
    assert_eq!(costs.len(), 4);
    for (got, want) in costs.iter().zip(&turns) {
        assert!((got - want).abs() < 1e-12, "{costs:?} against {turns:?}");
    }
    assert!((costs.iter().sum::<f64>() - totals[3]).abs() < 1e-12, "they add up to what the process cost");
}
