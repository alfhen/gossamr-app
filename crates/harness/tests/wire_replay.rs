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

    /// Both lines in one write, so the replay reads them at once.
    fn send_together(&mut self, first: &Value, second: &Value) {
        let _ = write!(self.stdin.as_mut().expect("stdin is open"), "{first}\n{second}\n");
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
    // A prompt written with `initialize`, before its answer.
    let prompt = refused("2-permission.jsonl", Client { early: Some(5), ..Client::default() });
    assert_eq!(prompt, "line 5: user came before line 3 was written, after the start\n");
    // An interrupt written with the allow, before the tool started (line 27, `task_started`).
    let interrupt = refused("3-cancel.jsonl", Client { early: Some(28), ..Client::default() });
    assert_eq!(interrupt, "line 28: control_request interrupt came before line 27 was written, after line 21\n");
    // The next prompt written with the interrupt, while the cancelled turn still runs: before its `result`, line 33.
    let during = refused("3-cancel.jsonl", Client { early: Some(36), ..Client::default() });
    assert_eq!(during, "line 36: user came before line 33 was written, after line 27\n");
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
        assert_eq!(report(&out), "the driver sent mcp_set_servers with a server that is not http with a url\n");
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
    assert_eq!(env["ONE_VARIABLE"], "its value");
    let sent = std::fs::read_to_string(out.path().join("sent.jsonl")).unwrap();
    assert_eq!(sent, format!("{initialize}\n"));
}

#[test]
fn wire_replay_ends_as_its_agent_did() {
    for (fixture, code) in [("2-permission.jsonl", Some(0)), ("3-background-exit.jsonl", None), ("4-kill.jsonl", None)] {
        let (_, ended, _, out) = play(&native().join(fixture), Client::default());
        assert_eq!((ended, report(&out)), (code, String::new()), "{fixture}");
    }
}
