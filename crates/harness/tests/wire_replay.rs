//! The wire replay (`test-support/wire-replay`) against a client that plays the recording's own client lines, as a
//! driver that does what the recorded one did.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

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

struct Run {
    /// Shared with the watchdog, which kills the replay if a test still waits on it after a minute. A child is
    /// signalled only while it is unreaped, under this lock, so its pid cannot have been reused.
    child: Arc<Mutex<Child>>,
    watchdog: Option<Sender<()>>,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    out: Option<tempfile::TempDir>,
}

fn start(fixture: &Path, args: &[&str], env: &[(&str, &str)]) -> Run {
    let out = tempfile::tempdir().unwrap();
    let mut child = Command::new(REPLAY)
        .args(args)
        .env_clear()
        .envs(env.iter().copied())
        .env("WIRE_REPLAY_FIXTURE", fixture)
        .env("WIRE_REPLAY_OUT", out.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (stdin, stdout) = (child.stdin.take(), BufReader::new(child.stdout.take().unwrap()));
    let child = Arc::new(Mutex::new(child));
    let (watchdog, cancelled) = std::sync::mpsc::channel::<()>();
    let watched = child.clone();
    std::thread::spawn(move || {
        if cancelled.recv_timeout(Duration::from_secs(60)) == Err(RecvTimeoutError::Timeout) {
            let mut child = watched.lock().unwrap();
            if child.try_wait().unwrap().is_none() {
                let _ = child.kill();
            }
        }
    });
    Run { child, watchdog: Some(watchdog), stdin, stdout, out: Some(out) }
}

impl Run {
    fn send(&mut self, line: &Value) {
        // A replay that refused a line has gone; what it says is in its report.
        let _ = writeln!(self.stdin.as_mut().expect("stdin is open"), "{line}");
    }

    /// Both lines in one write, so the replay reads them at once. A pipe keeps a write whole only up to `PIPE_BUF`, 512
    /// bytes on macOS: past that the pipe may split it, and the second line may then truly come later.
    fn send_together(&mut self, first: &Value, second: &Value) {
        let both = format!("{first}\n{second}\n");
        assert!(both.len() <= 512, "a pair of {} bytes may be split by the pipe", both.len());
        let _ = self.stdin.as_mut().expect("stdin is open").write_all(both.as_bytes());
    }

    fn read(&mut self) -> Option<Value> {
        let mut line = String::new();
        (self.stdout.read_line(&mut line).unwrap() > 0).then(|| serde_json::from_str(&line).expect("the replay writes JSON lines"))
    }

    fn close(&mut self) {
        self.stdin = None;
    }

    /// Its exit code, or None when it says it stays; a staying replay is then killed.
    fn end(mut self) -> (Option<i32>, String, tempfile::TempDir) {
        self.close();
        self.end_open()
    }

    /// As `end`, with stdin left as it is.
    fn end_open(mut self) -> (Option<i32>, String, tempfile::TempDir) {
        let mut stderr = BufReader::new(self.child.lock().unwrap().stderr.take().unwrap());
        let (mut said, mut line) = (String::new(), String::new());
        while stderr.read_line(&mut line).unwrap() > 0 {
            // The replay's own line, whole: recorded stderr comes as JSON strings and cannot match it.
            if line.trim_end() == "wire-replay: staying until signalled" {
                let mut child = self.child.lock().unwrap();
                child.kill().unwrap();
                child.wait().unwrap();
                self.watchdog = None;
                return (None, said, self.out.take().unwrap());
            }
            said.push_str(&line);
            line.clear();
        }
        let code = self.child.lock().unwrap().wait().unwrap().code();
        self.watchdog = None;
        (code, said, self.out.take().unwrap())
    }
}

impl Drop for Run {
    /// A test that fails mid-play leaves no replay behind.
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn report(out: &tempfile::TempDir) -> String {
    std::fs::read_to_string(out.path().join("report.txt")).unwrap_or_default()
}

fn is_id_field(key: &str) -> bool {
    matches!(key, "id" | "uuid") || ["_id", "Id", "_ids", "Ids"].iter().any(|end| key.ends_with(end))
}

/// Learns which live id each recorded one became, from a line the replay wrote and the recorded line it plays.
fn learn(recorded: &Value, live: &Value, key: &str, ids: &mut HashMap<String, String>) {
    match (recorded, live) {
        (Value::Object(want), Value::Object(got)) => {
            want.iter().filter_map(|(key, field)| Some((key, field, got.get(key)?))).for_each(|(key, field, got)| learn(field, got, key, ids))
        }
        (Value::Array(want), Value::Array(got)) => want.iter().zip(got).for_each(|(want, got)| learn(want, got, key, ids)),
        (Value::String(want), Value::String(got)) if is_id_field(key) => {
            ids.insert(want.clone(), got.clone());
        }
        _ => {}
    }
}

fn mapped(value: &Value, key: &str, ids: &HashMap<String, String>) -> Value {
    match value {
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, field)| (key.clone(), mapped(field, key, ids))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|item| mapped(item, key, ids)).collect()),
        Value::String(text) if is_id_field(key) => Value::from(ids.get(text).cloned().unwrap_or_else(|| text.clone())),
        other => other.clone(),
    }
}

fn is_config(data: &Value) -> bool {
    data["type"] == "control_request" && data["request"]["subtype"] == "mcp_set_servers"
}

/// Changes the client line it is given.
type Change = fn(&mut Value);

/// How the client strays from the recording, if it does.
#[derive(Default)]
struct Client {
    /// Its config requests are not sent.
    skip_config: bool,
    /// Sent before the first line.
    first: Option<Value>,
    /// Changes the client line at this seq.
    change: Option<(u64, Change)>,
    /// Closes stdin before the line at this seq.
    close_before: Option<u64>,
    /// Sent after the recording's last line.
    after: Option<Value>,
    /// The client line at this seq goes in one write with the client line before it, as a driver that does not wait
    /// for what the agent says in between.
    early: Option<u64>,
    /// Stops before the line at this seq and keeps stdin open.
    stall_before: Option<u64>,
    /// Added to the replay's environment.
    env: &'static [(&'static str, &'static str)],
}

/// Plays `fixture`'s client against the replay: each agent line is read and its ids learned, and each client line is
/// sent with them mapped and with the client's own request ids. Returns what was read and how the replay ended.
fn play(fixture: &Path, client: Client) -> (Vec<Value>, Option<i32>, String, tempfile::TempDir) {
    let lines = lines_of(fixture);
    let mut run = start(fixture, &[], client.env);
    let (mut ids, mut read, mut config_ids) = (HashMap::new(), vec![], vec![]);
    // The client line written early, which is then not sent again at its place.
    let early = client.early.and_then(|seq| lines.iter().find(|line| line["seq"] == seq).cloned());
    let before_early = early.as_ref().and_then(|early| {
        let at = lines.iter().position(|line| line["seq"] == early["seq"]).unwrap();
        lines[..at].iter().rev().find(|line| line["dir"] == "to_agent" && !is_config(&line["data"])).map(|line| line["seq"].clone())
    });
    if let Some(first) = &client.first {
        run.send(first);
        read.extend(run.read());
    }
    for line in &lines {
        let (dir, data, seq) = (line["dir"].as_str().unwrap_or_default(), &line["data"], line["seq"].as_u64().unwrap());
        if dir == "driver" && data["note"] == "signal" {
            break;
        }
        if client.close_before == Some(seq) {
            run.close();
            break;
        }
        if client.stall_before == Some(seq) {
            let (code, said, out) = run.end_open();
            return (read, code, said, out);
        }
        if early.as_ref().is_some_and(|early| early["seq"] == seq) {
            continue;
        }
        match dir {
            "from_agent" if config_ids.contains(&data["response"]["request_id"]) => {}
            "from_agent" => match run.read() {
                Some(live) => {
                    learn(data, &live, "", &mut ids);
                    read.push(live);
                }
                None => break,
            },
            "to_agent" if is_config(data) => {
                config_ids.push(data["request_id"].clone());
                if !client.skip_config {
                    let mut sent = data.clone();
                    sent["request_id"] = json!(format!("client-{seq}"));
                    run.send(&sent);
                    read.extend(run.read());
                }
            }
            "to_agent" => {
                let mut sent = mapped(data, "", &ids);
                if data["type"] == "control_request" {
                    sent["request_id"] = json!(format!("client-{seq}"));
                    ids.insert(data["request_id"].as_str().unwrap().to_owned(), format!("client-{seq}"));
                }
                if let Some((_, change)) = client.change.filter(|(at, _)| *at == seq) {
                    change(&mut sent);
                }
                match early.as_ref().filter(|_| before_early.as_ref() == Some(&line["seq"])) {
                    Some(early) => {
                        let mut next = mapped(&early["data"], "", &ids);
                        if next["type"] == "control_request" {
                            next["request_id"] = json!(format!("client-{}", early["seq"]));
                        }
                        run.send_together(&sent, &next);
                    }
                    None => run.send(&sent),
                }
            }
            "driver" if data["note"] == "close_stdin" => {
                if let Some(after) = &client.after {
                    run.send(after);
                }
                run.close();
            }
            _ => {}
        }
    }
    if let Some(after) = client.after.as_ref().filter(|_| run.stdin.is_some()) {
        run.send(after);
    }
    let (code, said, out) = run.end();
    (read, code, said, out)
}

#[test]
fn wire_replay_every_claude_native_fixture_plays_clean_against_its_own_client() {
    let files = fixtures();
    assert!(files.len() > 30, "the claude/native fixtures are there");
    for fixture in files {
        let lines = lines_of(&fixture);
        let (read, code, _, out) = play(&fixture, Client::default());
        assert_eq!(report(&out), "", "{} reports a mismatch", name(&fixture));
        let agent = lines.iter().take_while(|line| line["data"]["note"] != "signal").filter(|line| line["dir"] == "from_agent").count();
        assert_eq!(read.len(), agent, "{}: every agent line is played once", name(&fixture));
        let closes = lines.iter().any(|line| line["data"]["note"] == "close_stdin");
        let stays = lines.iter().any(|line| line["data"]["note"] == "still_running_killing") || !closes;
        assert_eq!(code, if stays { None } else { Some(0) }, "{} ends as its agent did", name(&fixture));
    }
}

/// The recording's own values in id fields of its agent lines.
fn recorded_ids(fixture: &Path) -> Vec<String> {
    fn walk(value: &Value, key: &str, out: &mut Vec<String>) {
        match value {
            Value::Object(fields) => fields.iter().for_each(|(key, field)| walk(field, key, out)),
            Value::Array(items) => items.iter().for_each(|item| walk(item, key, out)),
            Value::String(text) if is_id_field(key) && text.len() > 8 => out.push(text.clone()),
            _ => {}
        }
    }
    let mut out = vec![];
    for line in lines_of(fixture).iter().filter(|line| line["dir"] == "from_agent") {
        walk(&line["data"], "", &mut out);
    }
    out.sort();
    out.dedup();
    out
}

#[test]
fn wire_replay_maps_the_agents_ids_to_fresh_ones_and_answers_with_the_clients() {
    for fixture in fixtures() {
        let (read, _, _, out) = play(&fixture, Client::default());
        assert_eq!(report(&out), "", "{}", name(&fixture));
        let shown: String = read.iter().map(Value::to_string).collect();
        let recorded = recorded_ids(&fixture);
        assert!(recorded.len() > 5, "{} has ids of its own", name(&fixture));
        for (n, id) in recorded.iter().enumerate() {
            assert!(!shown.contains(id.as_str()), "{}: recorded id {n} reached stdout", name(&fixture));
        }
    }
    let (read, code, _, out) = play(&native().join("2-permission.jsonl"), Client::default());
    assert_eq!((code, report(&out)), (Some(0), String::new()));
    let answer = read.iter().find(|line| line["type"] == "control_response").unwrap();
    assert_eq!(answer["response"]["request_id"], "client-2", "the answer to initialize carries the client's id");
    let asks: Vec<&Value> = read.iter().filter(|line| line["request"]["subtype"] == "can_use_tool").collect();
    assert_eq!(asks.len(), 2);
    assert_ne!(asks[0]["request_id"], asks[1]["request_id"]);
}

#[test]
fn wire_replay_maps_an_answer_only_by_the_id_it_sent() {
    // The client answers the first `can_use_tool` with the recorded id, not the one the replay sent.
    let fixture = native().join("2-permission.jsonl");
    let client = Client { change: Some((30, |sent| sent["response"]["request_id"] = json!("4b00fe4a-5e30-45fa-bc99-156e4df0bc3d"))), ..Client::default() };
    let (_, code, _, out) = play(&fixture, client);
    assert_eq!(code, Some(3));
    assert!(report(&out).starts_with("line 30: the request id differs"), "{}", report(&out));
}

fn refused(fixture: &str, client: Client) -> String {
    let (_, code, said, out) = play(&native().join(fixture), client);
    assert_eq!(code, Some(3), "{fixture} is refused");
    let report = report(&out);
    assert!(said.contains(report.trim()), "the report is said on stderr too");
    report
}

#[test]
fn wire_replay_a_prompt_with_other_text_is_refused_without_its_text() {
    let report = refused("2-permission.jsonl", Client { change: Some((5, |sent| sent["message"]["content"][0]["text"] = json!("another prompt, secret-ish"))), ..Client::default() });
    assert_eq!(report, "line 5: the prompt's text differs from the recording's user\n");
    assert!(!report.contains("secret") && !report.contains("echo"));
}

#[test]
fn wire_replay_a_decision_other_than_the_recordings_is_refused() {
    let report = refused("2-permission.jsonl", Client { change: Some((55, |sent| sent["response"]["response"]["behavior"] = json!("allow"))), ..Client::default() });
    assert_eq!(report, "line 55: the decision differs from the recording's control_response\n");
}

#[test]
fn wire_replay_an_allow_with_another_input_or_none_is_refused() {
    let changed = refused("2-permission.jsonl", Client { change: Some((30, |sent| sent["response"]["response"]["updatedInput"]["command"] = json!("rm -rf ."))), ..Client::default() });
    assert_eq!(changed, "line 30: the allowed input differs from the recording's control_response\n");
    assert!(!changed.contains("rm -rf"), "the report holds no payload");
    let missing = refused("2-permission.jsonl", Client { change: Some((30, |sent| _ = sent["response"]["response"].as_object_mut().unwrap().remove("updatedInput"))), ..Client::default() });
    assert_eq!(missing, "line 30: the allowed input differs from the recording's control_response\n");
}

#[test]
fn wire_replay_a_deny_with_another_message_is_refused() {
    let report = refused("2-permission.jsonl", Client { change: Some((55, |sent| sent["response"]["response"]["message"] = json!("no"))), ..Client::default() });
    assert_eq!(report, "line 55: the deny's message differs from the recording's control_response\n");
}

#[test]
fn wire_replay_a_prompt_with_another_role_or_other_images_is_refused() {
    let role = refused("2-permission.jsonl", Client { change: Some((5, |sent| sent["message"]["role"] = json!("assistant"))), ..Client::default() });
    assert_eq!(role, "line 5: the prompt's role differs from the recording's user\n");
    let image = |sent: &mut Value| sent["message"]["content"].as_array_mut().unwrap().push(json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA=="}}));
    let images = refused("2-permission.jsonl", Client { change: Some((5, image)), ..Client::default() });
    assert_eq!(images, "line 5: the prompt's set of images differs from the recording's user\n");
}

#[test]
fn wire_replay_a_line_sent_before_the_agent_line_it_follows_is_refused_with_both_lines() {
    // The first prompt follows nothing: written with `initialize`, before its answer, it is not refused.
    let (_, code, _, out) = play(&native().join("2-permission.jsonl"), Client { early: Some(5), ..Client::default() });
    assert_eq!((code, report(&out)), (Some(0), String::new()));
    // An interrupt written with the allow, before the tool started (`task_started`). 3-cancel's own allow is too long
    // to share one write with it, so a short recording of the same shape.
    let tmp = tempfile::tempdir().unwrap();
    let request = "0c0d0e0f-1a2b-4c3d-8e9f-a0b1c2d3e4f5";
    let line = |seq: u64, dir: &str, data: Value| json!({"seq": seq, "ms": seq, "dir": dir, "data": data});
    let short = tmp.path().join("interrupt.jsonl");
    let lines = [
        line(1, "to_agent", json!({"type": "control_request", "request_id": "spike-1", "request": {"subtype": "initialize"}})),
        line(2, "from_agent", json!({"type": "control_response", "response": {"subtype": "success", "request_id": "spike-1", "response": {}}})),
        line(3, "to_agent", json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "go"}]}})),
        line(5, "from_agent", json!({"type": "control_request", "request_id": request, "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ping"}}})),
        line(6, "to_agent", json!({"type": "control_response", "response": {"subtype": "success", "request_id": request, "response": {"behavior": "allow", "updatedInput": {"command": "ping"}}}})),
        line(7, "from_agent", json!({"type": "system", "subtype": "task_started"})),
        line(8, "to_agent", json!({"type": "control_request", "request_id": "spike-2", "request": {"subtype": "interrupt"}})),
        line(9, "from_agent", json!({"type": "result", "subtype": "error_during_execution", "is_error": true})),
        line(10, "driver", json!({"note": "close_stdin"})),
    ];
    std::fs::write(&short, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    let (_, code, _, out) = play(&short, Client { early: Some(8), ..Client::default() });
    assert_eq!((code, report(&out)), (Some(3), "line 8: control_request interrupt came before line 7 was written, the line it follows\n".to_owned()));
    let (_, code, _, out) = play(&short, Client::default());
    assert_eq!((code, report(&out)), (Some(0), String::new()), "sent after it, the interrupt is in time");
    // The next prompt written with the interrupt, while the cancelled turn still runs: before its `result`, line 33.
    let during = refused("3-cancel.jsonl", Client { early: Some(36), ..Client::default() });
    assert_eq!(during, "line 36: user came before line 33 was written, the line it follows\n");
}

/// A driver that acts on what it reads, as a real one does: each client line goes on reading the agent line `on` names
/// for it, and otherwise an answer on reading its request, at once, and any other line on reading the agent line before
/// it. Returns how the replay ended and its report.
fn react(fixture: &Path, on: &[(u64, u64)]) -> (Option<i32>, String) {
    let lines = lines_of(fixture);
    let lines = &lines[..lines.iter().position(|line| line["data"]["note"] == "signal").unwrap_or(lines.len())];
    let configs: Vec<&Value> = lines.iter().filter(|line| line["dir"] == "to_agent" && is_config(&line["data"])).map(|line| &line["data"]["request_id"]).collect();
    let plays = |line: &&Value| line["dir"] == "from_agent" && !configs.contains(&&line["data"]["response"]["request_id"]);
    let seq = |line: &Value| line["seq"].as_u64().unwrap();
    // Each client line or close, with the agent line it goes on (0: before any).
    let (mut sends, mut last) = (vec![], 0);
    for line in lines {
        if plays(&line) {
            last = seq(line);
        } else if line["dir"] == "to_agent" || line["data"]["note"] == "close_stdin" {
            let request = &line["data"]["response"]["request_id"];
            let asked = lines.iter().find(|ask| ask["dir"] == "from_agent" && line["data"]["type"] == "control_response" && ask["data"]["request_id"] == *request);
            let default = asked.map_or(last, seq);
            sends.push((on.iter().find(|(at, _)| *at == seq(line)).map_or(default, |(_, on)| *on), line));
        }
    }
    let mut run = start(fixture, &[], &[]);
    let (mut ids, mut mine) = (HashMap::new(), vec![]);
    let send = |run: &mut Run, ids: &mut HashMap<String, String>, mine: &mut Vec<Value>, after: u64| {
        for (_, line) in sends.iter().filter(|(on, _)| *on == after) {
            if line["data"]["note"] == "close_stdin" {
                run.close();
                continue;
            }
            let mut sent = mapped(&line["data"], "", ids);
            if sent["type"] == "control_request" {
                let id = format!("client-{}", line["seq"]);
                if is_config(&sent) {
                    mine.push(json!(id));
                } else {
                    ids.insert(line["data"]["request_id"].as_str().unwrap().to_owned(), id.clone());
                }
                sent["request_id"] = json!(id);
            }
            if run.stdin.is_some() {
                run.send(&sent);
            }
        }
    };
    send(&mut run, &mut ids, &mut mine, 0);
    for agent in lines.iter().filter(plays) {
        // The replay's own answers to config requests are not in the recording.
        let live = loop {
            match run.read() {
                Some(live) if live["type"] == "control_response" && mine.contains(&live["response"]["request_id"]) => {}
                other => break other,
            }
        };
        let Some(live) = live else { break };
        learn(&agent["data"], &live, "", &mut ids);
        send(&mut run, &mut ids, &mut mine, seq(agent));
    }
    let (code, _, out) = run.end();
    (code, report(&out))
}

#[test]
fn wire_replay_a_driver_that_answers_each_request_on_sight_plays_clean_every_time() {
    // Each recording has `stream_event` lines between a request and its answer, which such a driver answers before.
    for fixture in ["2-permission.jsonl", "5-mcp.jsonl"] {
        for run in 0..50 {
            assert_eq!(react(&native().join(fixture), &[]), (Some(0), String::new()), "{fixture}, run {run}");
        }
    }
}

#[test]
fn wire_replay_an_answer_on_sight_passes_when_a_long_line_follows_its_request() {
    // A copy of 2-permission with a 300 KB `stream_event` after the first request: the replay is still writing it, or
    // blocked on it, when the answer comes.
    let tmp = tempfile::tempdir().unwrap();
    let copy = tmp.path().join("long.jsonl");
    let mut lines = vec![];
    for mut line in lines_of(&native().join("2-permission.jsonl")) {
        let seq = line["seq"].as_u64().unwrap() * 10;
        line["seq"] = json!(seq);
        lines.push(line.to_string());
        if seq == 270 {
            let long = json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "x".repeat(300_000)}}});
            lines.push(json!({"seq": 275, "ms": 0, "dir": "from_agent", "data": long}).to_string());
        }
    }
    std::fs::write(&copy, lines.join("\n")).unwrap();
    for run in 0..5 {
        assert_eq!(react(&copy, &[]), (Some(0), String::new()), "run {run}");
    }
}

#[test]
fn wire_replay_a_prompt_or_interrupt_sent_on_reading_a_line_before_the_one_it_follows_is_refused_every_time() {
    let fixture = native().join("11-locked.jsonl");
    let lines = lines_of(&fixture);
    let seq = |line: &Value| line["seq"].as_u64().unwrap();
    // Each later prompt, sent on reading the agent line just before the `result` it follows.
    let early: Vec<(u64, u64, u64)> = lines
        .iter()
        .filter(|line| line["dir"] == "to_agent" && line["data"]["type"] == "user")
        .skip(1)
        .map(|prompt| {
            let before: Vec<&Value> = lines.iter().take_while(|line| seq(line) < seq(prompt)).filter(|line| line["dir"] == "from_agent").collect();
            let result = before.iter().rposition(|line| line["data"]["type"] == "result").unwrap();
            (seq(prompt), seq(before[result]), seq(before[result - 1]))
        })
        .collect();
    assert_eq!(early.len(), 3, "11-locked has three later prompts");
    for run in 0..20 {
        let (prompt, result, on) = early[run % early.len()];
        let want = format!("line {prompt}: user came before line {result} was written, the line it follows\n");
        assert_eq!(react(&fixture, &[(prompt, on)]), (Some(3), want), "run {run}");
    }
    // r2-ask's second prompt on reading line 31, a status line in the middle of the first turn.
    for run in 0..20 {
        let want = "line 76: user came before line 73 was written, the line it follows\n".to_owned();
        assert_eq!(react(&native().join("r2-ask.jsonl"), &[(76, 31)]), (Some(3), want), "run {run}");
    }
    // 3-cancel's interrupt on reading line 24, before the tool started at line 27.
    for run in 0..20 {
        let want = "line 28: control_request interrupt came before line 27 was written, the line it follows\n".to_owned();
        assert_eq!(react(&native().join("3-cancel.jsonl"), &[(28, 24)]), (Some(3), want), "run {run}");
    }
    // Each sent where it belongs plays clean.
    for fixture in ["11-locked.jsonl", "r2-ask.jsonl", "3-cancel.jsonl"] {
        assert_eq!(react(&native().join(fixture), &[]), (Some(0), String::new()), "{fixture}");
    }
}

#[test]
fn wire_replay_a_prompt_begun_before_the_line_it_follows_is_early_though_it_ends_after() {
    let tmp = tempfile::tempdir().unwrap();
    let line = |seq: u64, dir: &str, data: Value| json!({"seq": seq, "ms": seq, "dir": dir, "data": data});
    let prompt = |text: &str| json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}});
    let short = tmp.path().join("split.jsonl");
    let lines = [
        line(1, "to_agent", json!({"type": "control_request", "request_id": "spike-1", "request": {"subtype": "initialize"}})),
        line(2, "from_agent", json!({"type": "control_response", "response": {"subtype": "success", "request_id": "spike-1", "response": {}}})),
        line(3, "to_agent", prompt("go")),
        line(4, "from_agent", json!({"type": "system", "subtype": "status"})),
        line(5, "from_agent", json!({"type": "result", "subtype": "success", "is_error": false})),
        line(6, "to_agent", prompt("more")),
        line(7, "from_agent", json!({"type": "result", "subtype": "success", "is_error": false})),
        line(8, "driver", json!({"note": "close_stdin"})),
    ];
    std::fs::write(&short, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    let mut run = start(&short, &[], &[]);
    run.send(&json!({"type": "control_request", "request_id": "c-1", "request": {"subtype": "initialize"}}));
    run.read().unwrap();
    run.send(&prompt("go"));
    assert_eq!(run.read().unwrap()["subtype"], "status");
    // Half of the next prompt mid-turn, the rest once the turn's `result` is out.
    let more = format!("{}\n", prompt("more"));
    let (half, rest) = more.split_at(more.len() / 2);
    let stdin = run.stdin.as_mut().unwrap();
    stdin.write_all(half.as_bytes()).unwrap();
    stdin.flush().unwrap();
    assert_eq!(run.read().unwrap()["type"], "result");
    let _ = run.stdin.as_mut().unwrap().write_all(rest.as_bytes());
    let (code, _, out) = run.end();
    assert_eq!((code, report(&out)), (Some(3), "line 6: user came before line 5 was written, the line it follows\n".to_owned()));
}

#[test]
fn wire_replay_an_answer_with_a_field_the_recording_lacks_is_refused() {
    // An allow that would allow every later Bash command, and a deny that would end the turn.
    let wider = |sent: &mut Value| {
        sent["response"]["response"]["updatedPermissions"] = json!([{"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "allow", "destination": "session"}])
    };
    let report = refused("2-permission.jsonl", Client { change: Some((30, wider)), ..Client::default() });
    assert_eq!(report, "line 30: the answer's fields differ from the recording's control_response\n");
    let report = refused("2-permission.jsonl", Client { change: Some((55, |sent| sent["response"]["response"]["interrupt"] = json!(true))), ..Client::default() });
    assert_eq!(report, "line 55: the answer's fields differ from the recording's control_response\n");
    let report = refused("2-permission.jsonl", Client { change: Some((55, |sent| sent["response"]["error"] = json!("no"))), ..Client::default() });
    assert_eq!(report, "line 55: the answer's fields differ from the recording's control_response\n");
}

#[test]
fn wire_replay_a_line_never_sent_or_a_stdin_never_closed_is_reported_by_its_deadline() {
    const SHORT: &[(&str, &str)] = &[("WIRE_REPLAY_DEADLINE_MS", "300")];
    let never = refused("2-permission.jsonl", Client { stall_before: Some(5), env: SHORT, ..Client::default() });
    assert_eq!(never, "line 5: the driver never sent user within 300 ms\n");
    let open = refused("2-permission.jsonl", Client { stall_before: Some(130), env: SHORT, ..Client::default() });
    assert_eq!(open, "line 130: the driver did not close stdin where the recording does within 300 ms\n");
}

#[test]
fn wire_replay_writes_each_agent_line_to_the_progress_fifo_as_it_plays_it() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("progress");
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: a valid path and mode.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let reader = {
        let fifo = fifo.clone();
        std::thread::spawn(move || std::fs::read_to_string(fifo).unwrap())
    };
    let fixture = native().join("2-permission.jsonl");
    let progress: &'static str = Box::leak(fifo.display().to_string().into_boxed_str());
    let env: &'static [(&'static str, &'static str)] = Box::leak(vec![("WIRE_REPLAY_PROGRESS", progress)].into_boxed_slice());
    let (_, code, _, out) = play(&fixture, Client { env, ..Client::default() });
    assert_eq!((code, report(&out)), (Some(0), String::new()));
    let seqs: Vec<u64> = reader.join().unwrap().lines().map(|line| line.parse().unwrap()).collect();
    let agent: Vec<u64> = lines_of(&fixture).iter().filter(|line| line["dir"] == "from_agent").map(|line| line["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, agent, "every agent line, in order, as it is written");
}

#[test]
fn wire_replay_a_line_of_another_type_or_subtype_is_refused() {
    // Where the recording interrupts, the client prompts instead.
    let prompt = |sent: &mut Value| *sent = json!({"type": "user", "message": {"role": "user", "content": "go on"}});
    let report = refused("3-cancel.jsonl", Client { change: Some((28, prompt)), ..Client::default() });
    assert_eq!(report, "line 28: the driver sent user where the recording has control_request interrupt\n");
    let report = refused("3-cancel.jsonl", Client { change: Some((2, |sent| sent["request"]["subtype"] = json!("interrupt"))), ..Client::default() });
    assert_eq!(report, "line 2: the subtype differs from the recording's control_request initialize\n");
}

#[test]
fn wire_replay_a_stdin_closed_early_or_a_line_after_the_end_is_refused() {
    let report = refused("3-cancel.jsonl", Client { close_before: Some(28), ..Client::default() });
    assert_eq!(report, "line 28: stdin closed where the recording has control_request interrupt\n");
    let extra = json!({"type": "user", "message": {"role": "user", "content": "one more"}});
    let report = refused("2-permission.jsonl", Client { after: Some(extra.clone()), ..Client::default() });
    assert_eq!(report, "line 130: the driver sent user where the recording closes stdin\n");
    let report = refused("4-kill.jsonl", Client { after: Some(extra), ..Client::default() });
    assert_eq!(report, "the driver sent user after the recording ended\n");
}

#[test]
fn wire_replay_config_lines_the_recording_lacks_are_answered() {
    // 2-permission has no config line: the client sends one first and gets a success naming its server.
    let set = json!({"type": "control_request", "request_id": "mine", "request": {"subtype": "mcp_set_servers", "servers": {"abc123def456": {"type": "http", "url": "http://127.0.0.1:9/mcp", "headers": {"Authorization": "Bearer t"}, "timeout": 600000}}}});
    let (read, code, _, out) = play(&native().join("2-permission.jsonl"), Client { first: Some(set), ..Client::default() });
    assert_eq!((code, report(&out)), (Some(0), String::new()));
    assert_eq!(read[0], json!({"type": "control_response", "response": {"subtype": "success", "request_id": "mine", "response": {"added": ["abc123def456"], "removed": [], "errors": {}}}}));
}

#[test]
fn wire_replay_config_a_driver_that_gives_no_endpoint_where_the_recording_does_is_refused() {
    // 5-mcp-control gives the endpoint at line 4, before its first prompt at line 7.
    let report = refused("5-mcp-control.jsonl", Client { skip_config: true, ..Client::default() });
    assert_eq!(report, "line 7: the driver sent its first prompt before it gave the tools endpoint, which the recording gives at line 4\n");
}

#[test]
fn wire_replay_config_a_server_that_is_not_http_with_a_url_is_refused_never_answered() {
    for server in [json!({"type": "stdio", "command": "x"}), json!({"type": "http"}), json!({"type": "http", "url": ""})] {
        let set = json!({"type": "control_request", "request_id": "mine", "request": {"subtype": "mcp_set_servers", "servers": {"abc": server}}});
        let (read, code, _, out) = play(&native().join("2-permission.jsonl"), Client { first: Some(set), ..Client::default() });
        assert_eq!(code, Some(3), "{server}");
        assert_eq!(report(&out), "line 2: the driver sent mcp_set_servers with a server that is not http with a url\n", "it names the line the replay waited for");
        assert!(!read.iter().any(|line| line["response"]["response"]["added"].is_array()), "no success is made up for it");
    }
    let none = json!({"type": "control_request", "request_id": "mine", "request": {"subtype": "mcp_set_servers", "servers": {}}});
    let (_, code, _, _) = play(&native().join("2-permission.jsonl"), Client { first: Some(none), ..Client::default() });
    assert_eq!(code, Some(3), "no server at all");
}

#[test]
fn wire_replay_config_a_reused_request_id_is_refused() {
    let set = json!({"type": "control_request", "request_id": "client-2", "request": {"subtype": "mcp_set_servers", "servers": {"abc": {"type": "http", "url": "http://127.0.0.1:9/mcp"}}}});
    // The client's initialize then takes the same id, `client-2`.
    let report = refused("2-permission.jsonl", Client { first: Some(set), ..Client::default() });
    assert_eq!(report, "line 2: the driver used a request id twice\n");
}

#[test]
fn wire_replay_a_control_request_that_is_not_named_config_and_not_recorded_is_refused() {
    // A driver that sets its model by a control request the recording lacks, before its first prompt.
    let set_model = json!({"type": "control_request", "request_id": "m-1", "request": {"subtype": "set_model", "model": "haiku"}});
    let report = refused("2-permission.jsonl", Client { change: Some((5, |sent| *sent = json!({"type": "control_request", "request_id": "m-1", "request": {"subtype": "set_model", "model": "haiku"}}))), ..Client::default() });
    assert_eq!(report, "line 5: the driver sent control_request set_model where the recording has user\n");
    let report = refused("4-kill.jsonl", Client { after: Some(set_model), ..Client::default() });
    assert_eq!(report, "the driver sent control_request set_model after the recording ended\n");
}

#[test]
fn wire_replay_config_the_endpoints_name_and_header_are_the_drivers_and_initialize_is_compared_by_subtype() {
    let fixture = native().join("5-mcp-control.jsonl");
    let mine = |sent: &mut Value| {
        sent["request"]["servers"] = json!({"q7w8e9r0t1y2u3": {"type": "http", "url": "http://127.0.0.1:9/mcp/q7w8e9r0t1y2u3", "headers": {"Authorization": "Bearer other"}, "timeout": 900000}})
    };
    let lines = lines_of(&fixture);
    let config = lines.iter().find(|line| line["dir"] == "to_agent" && is_config(&line["data"])).unwrap()["seq"].as_u64().unwrap();
    let mut run = start(&fixture, &[], &[]);
    let mut initialize = lines[1]["data"].clone();
    initialize["request"]["hooks"] = json!({});
    initialize["request_id"] = json!("i-1");
    run.send(&initialize);
    let answered = run.read().unwrap();
    assert_eq!(answered["response"]["request_id"], "i-1", "initialize with fields of the driver's own is answered");
    let mut set = lines.iter().find(|line| line["seq"] == config).unwrap()["data"].clone();
    set["request_id"] = json!("s-1");
    mine(&mut set);
    run.send(&set);
    let prompt = lines.iter().find(|line| line["dir"] == "to_agent" && line["data"]["type"] == "user").unwrap()["data"].clone();
    run.send(&prompt);
    // Up to the agent's first permission request, where the replay waits for the answer.
    let mut said = String::new();
    while let Some(line) = run.read() {
        said.push_str(&line.to_string());
        if line["request"]["subtype"] == "can_use_tool" {
            break;
        }
    }
    assert!(said.contains("\"added\":[\"q7w8e9r0t1y2u3\"]"), "the config answer names the driver's server");
    assert!(said.contains("mcp__q7w8e9r0t1y2u3__ping") && !said.contains("mcp__spike__"), "the recorded endpoint's tools take the driver's name");
}

#[test]
fn wire_replay_config_of_two_recorded_servers_the_one_the_recording_allowed_takes_the_drivers_name() {
    // r1-two-servers recorded the endpoint and a second server, and allowed the endpoint's `ping` by name.
    let fixture = native().join("r1-two-servers.jsonl");
    let lines = lines_of(&fixture);
    let mut run = start(&fixture, &[], &[]);
    let mut initialize = lines[1]["data"].clone();
    initialize["request_id"] = json!("i-1");
    run.send(&initialize);
    run.read().unwrap();
    run.send(&json!({"type": "control_request", "request_id": "s-1", "request": {"subtype": "mcp_set_servers", "servers": {"q7w8e9r0t1y2u3": {"type": "http", "url": "http://127.0.0.1:9/mcp/q7w8e9r0t1y2u3"}}}}));
    run.read().unwrap();
    run.send(&lines.iter().find(|line| line["dir"] == "to_agent" && line["data"]["type"] == "user").unwrap()["data"]);
    let mut said = String::new();
    while let Some(line) = run.read() {
        said.push_str(&line.to_string());
        if line["request"]["subtype"] == "can_use_tool" {
            break;
        }
    }
    assert!(said.contains("mcp__q7w8e9r0t1y2u3__ping") && !said.contains("mcp__spk0f0949ae__"), "the endpoint's tools take the driver's name");
    assert!(said.contains("\"tool_name\":\"mcp__spkx1be8eb2a__ping\""), "the second server keeps its own");
}

#[test]
fn wire_replay_records_its_argv_its_environment_and_each_line_sent() {
    let fixture = native().join("6-model.jsonl");
    let mut run = start(&fixture, &["-p", "--model", "haiku"], &[("ONE_VARIABLE", "its value")]);
    let initialize = json!({"type": "control_request", "request_id": "r-1", "request": {"subtype": "initialize"}});
    run.send(&initialize);
    run.read().unwrap();
    run.close();
    let (_, _, out) = run.end();
    let argv: Value = serde_json::from_slice(&std::fs::read(out.path().join("argv.json")).unwrap()).unwrap();
    assert_eq!(argv, json!(["-p", "--model", "haiku"]));
    let env: Value = serde_json::from_slice(&std::fs::read(out.path().join("env.json")).unwrap()).unwrap();
    assert_eq!(env["ONE_VARIABLE"], Value::Null, "its name only: a value can be a secret");
    assert!(env.as_object().unwrap().contains_key("ONE_VARIABLE"));
    assert!(env["WIRE_REPLAY_FIXTURE"].as_str().is_some_and(|fixture| fixture.ends_with("6-model.jsonl")), "the replay's own are shown");
    let sent = std::fs::read_to_string(out.path().join("sent.jsonl")).unwrap();
    assert_eq!(sent, format!("{initialize}\n"));
}

#[test]
fn wire_replay_records_where_a_secret_is_and_never_a_header_value() {
    let fixture = native().join("2-permission.jsonl");
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret");
    std::fs::write(&secret, "tok-5f2a9c\n").unwrap();
    let secret_file = secret.display().to_string();
    let env = [("WIRE_REPLAY_SECRET_FILE", secret_file.as_str()), ("LEAKED", "Bearer tok-5f2a9c"), ("CLAUDE_CONFIG_DIR", "/a/b")];
    let mut run = start(&fixture, &["--token", "tok-5f2a9c"], &env);
    let set = json!({"type": "control_request", "request_id": "s-1", "request": {"subtype": "mcp_set_servers", "servers": {"abc": {"type": "http", "url": "http://127.0.0.1:9/mcp", "headers": {"Authorization": "Bearer tok-5f2a9c"}}}}});
    run.send(&set);
    run.read().unwrap();
    let (_, _, out) = run.end();
    let held: Value = serde_json::from_slice(&std::fs::read(out.path().join("secret.json")).unwrap()).unwrap();
    assert_eq!(held, json!({"env": ["LEAKED"], "argv": 1}));
    let env: Value = serde_json::from_slice(&std::fs::read(out.path().join("env.json")).unwrap()).unwrap();
    assert_eq!(env["CLAUDE_CONFIG_DIR"], "/a/b", "a login folder is shown");
    for file in ["argv.json", "env.json", "sent.jsonl", "report.txt"] {
        let text = std::fs::read_to_string(out.path().join(file)).unwrap_or_default();
        assert!(!text.contains("tok-5f2a9c"), "{file} holds the secret");
    }
    let sent = std::fs::read_to_string(out.path().join("sent.jsonl")).unwrap();
    assert!(sent.contains("\"Authorization\":\"<redacted>\""), "the header is kept, its value is not");
}

#[test]
fn wire_replay_masks_a_token_or_the_named_secret_in_argv_and_in_every_line_sent() {
    let token = (harness::redact::SHAPES[0].example)();
    let fixture = native().join("2-permission.jsonl");
    // No secret file: a token shape is masked anyway.
    let mut run = start(&fixture, &["--key", &token], &[]);
    run.send(&json!({"type": "control_request", "request_id": "c-1", "request": {"subtype": "initialize", "note": token}}));
    run.read().unwrap();
    let (_, _, out) = run.end();
    for file in ["argv.json", "sent.jsonl"] {
        let text = std::fs::read_to_string(out.path().join(file)).unwrap();
        assert!(!text.contains(&token) && text.contains("<redacted>"), "{file} holds the token");
    }
    // The named secret, outside any header: in a server's URL, in `initialize` and in a prompt.
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret");
    std::fs::write(&secret, "tok-5f2a9c\n").unwrap();
    let secret_file = secret.display().to_string();
    let mut run = start(&fixture, &[], &[("WIRE_REPLAY_SECRET_FILE", secret_file.as_str())]);
    run.send(&json!({"type": "control_request", "request_id": "s-1", "request": {"subtype": "mcp_set_servers", "servers": {"abc": {"type": "http", "url": "http://127.0.0.1:9/mcp?t=tok-5f2a9c"}}}}));
    run.read().unwrap();
    run.send(&json!({"type": "control_request", "request_id": "c-1", "request": {"subtype": "initialize", "hooks": {"tok-5f2a9c": "tok-5f2a9c"}}}));
    run.read().unwrap();
    run.send(&json!({"type": "user", "message": {"role": "user", "content": "use tok-5f2a9c"}}));
    let (_, _, out) = run.end();
    let sent = std::fs::read_to_string(out.path().join("sent.jsonl")).unwrap();
    assert_eq!(sent.lines().count(), 3);
    assert!(!sent.contains("tok-5f2a9c"), "sent.jsonl holds the secret");
}

#[test]
fn wire_replay_a_last_line_with_no_newline_is_still_a_line() {
    let fixture = native().join("4-kill.jsonl");
    let mut run = start(&fixture, &[], &[]);
    run.send(&json!({"type": "control_request", "request_id": "c-1", "request": {"subtype": "initialize"}}));
    run.read().unwrap();
    let prompt = lines_of(&fixture).into_iter().find(|line| line["dir"] == "to_agent" && line["data"]["type"] == "user").unwrap();
    run.send(&prompt["data"]);
    while let Some(line) = run.read() {
        if line["request"]["subtype"] == "can_use_tool" {
            break;
        }
    }
    // Not the answer the recording has: a prompt, with no newline, then stdin closes.
    let _ = write!(run.stdin.as_mut().unwrap(), "{}", json!({"type": "user", "message": {"role": "user", "content": "more"}}));
    let (code, _, out) = run.end();
    assert_eq!((code, report(&out).contains("the driver sent user where the recording has control_response")), (Some(3), true), "{}", report(&out));
}

#[test]
fn wire_replay_lines_on_the_way_do_not_move_the_deadline() {
    let mut run = start(&native().join("2-permission.jsonl"), &[], &[("WIRE_REPLAY_DEADLINE_MS", "400")]);
    run.send(&json!({"type": "control_request", "request_id": "c-1", "request": {"subtype": "initialize"}}));
    run.read().unwrap();
    // Blank lines every 100 ms, never the prompt: the replay still gives up 400 ms after it began to wait.
    let started = std::time::Instant::now();
    let mut blanks = run.stdin.take().unwrap();
    let blanking = std::thread::spawn(move || {
        while started.elapsed() < Duration::from_secs(5) && blanks.write_all(b"\n").is_ok() {
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    let (code, _, out) = run.end_open();
    assert_eq!((code, report(&out)), (Some(3), "line 5: the driver never sent user within 400 ms\n".to_owned()));
    assert!(started.elapsed() < Duration::from_secs(4), "it did not wait past its deadline");
    blanking.join().unwrap();
}

#[test]
fn wire_replay_ends_as_its_agent_did() {
    for (fixture, code) in [("2-permission.jsonl", Some(0)), ("3-background-exit.jsonl", None), ("4-kill.jsonl", None)] {
        let (_, ended, _, out) = play(&native().join(fixture), Client::default());
        assert_eq!((ended, report(&out)), (code, String::new()), "{fixture}");
    }
}
