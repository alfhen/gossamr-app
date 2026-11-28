//! The wire replay: a fake provider CLI that plays an H0 recording over stdio. It writes the recording's `from_agent`
//! lines with the recorded run's ids mapped to this run's, and checks each line the driver sends against the recorded
//! `to_agent` line on what a replay needs (`docs/plan-harness.md`, H6). A driver run against it is then compared with
//! H2's converter. Only test builds have it (`required-features = ["testing"]`).
//!
//! `WIRE_REPLAY_FIXTURE` names the recording. `WIRE_REPLAY_OUT` names a folder that gets `argv.json`, `env.json` (every
//! variable's name, and the values of `SHOWN` and `WIRE_REPLAY_*` only), `pid`, `stdin` (whether fd 0 is a pipe),
//! `sent.jsonl` (each line received) and, on a mismatch, `report.txt`, which names the recorded line and the field and
//! never a payload. A mismatch exits 3.
//! `argv.json` and `sent.jsonl` go through the harness's `redact`, and a server's header values in `sent.jsonl` are
//! written `<redacted>`. With `WIRE_REPLAY_SECRET_FILE` naming a file that holds a secret, that secret is masked too, and
//! `secret.json` names the variables whose value holds it and counts the arguments that do. `WIRE_REPLAY_DEADLINE_MS`,
//! `WIRE_REPLAY_QUIET_MS` and `WIRE_REPLAY_PROGRESS` (a FIFO that gets the seq of each agent line as it is written) serve
//! tests. With `WIRE_REPLAY_IGNORE_TERM` set it ignores SIGTERM, as an agent that will not stop does.
//!
//! What is compared, for Claude's native stream: the line's `type`, a control request's subtype, a prompt's text, role
//! and image types, an answer's fields, and every id by the mapping. The config requests named in `CONFIG` are not
//! compared: the replay answers each one it is sent with success and skips the recording's own, with their answers.
//! Where the recording gives the tools endpoint before its first prompt, the driver must too, with an HTTP server and its
//! URL. The recorded endpoint's server name becomes the driver's when the driver names one server: the recording's one
//! server, or of several the one whose tools the recorded `--allowedTools` names.
//!
//! What is compared, for `codex app-server`'s JSON-RPC: each line's method, a request's id by the mapping (answers the
//! replay plays carry the driver's id), a prompt's text, and the thread and turn ids of a prompt and an interrupt.
//! Where the recording's `thread/start` or `thread/resume` names servers in its config, the driver's must too, each
//! with a URL; the recorded endpoint is the server approved without asking, and its name becomes the driver's. A
//! `thread/resume` binds the recorded thread id to the driver's. `initialize`'s client info and the rest of a thread's
//! config are not compared. A prompt (`turn/start`) follows the `turn/completed` before it.
//!
//! What is compared, for ACP (`agy acp`, JSON-RPC with `jsonrpc`): as for app-server, each line's method, a request's
//! id, and a prompt's text, here the text blocks of `session/prompt` other than the driver's guard (a block whose
//! `_meta.gossamr` is `guard`); an answer to a permission request carries the replay's id and the recorded `outcome`;
//! the session id of every request maps to the replay's, and `session/load` binds the recorded one to the driver's.
//! Where the recorded `session/new` or `session/load` names servers, the driver's must name one, an `http` server with
//! a URL and an `Authorization` header. `session/set_config_option` is a config line: the replay answers the driver's
//! and skips the recording's, with their answers. A recorded server's tool names are kept, so the recorded endpoint's
//! calls are no own tool of the driver's; a recording written for a test names the driver's endpoint `<endpoint>`,
//! which the replay replaces with the server name the driver gave. `WIRE_REPLAY_PACE` (a factor, 1 for the recorded
//! pace) writes each agent line no sooner than its recorded `ms` times the factor after the start. A `driver` note
//! `spawn_child` with `detail.ms` starts a `sleep` of that long as the replay's own child, in a group of its own, and
//! writes its pid to `child.pid`, as agy's command would be its child.
//!
//! When a line may come: a prompt follows the `result` before it, and an interrupt the last agent line before it that is
//! not a `stream_event`. Before the replay writes such a line it waits until stdin has been quiet for
//! `WIRE_REPLAY_QUIET_MS` (100 ms by default), so a prompt or interrupt the driver sends on reading an earlier line comes
//! before it and is refused, on every run. An answer may come at any time after its request, which the id mapping
//! proves it follows. The first prompt follows nothing: every recording sends it after `initialize`'s answer, but none
//! shows what the CLI does with one sent before it, so it is not refused.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use harness::redact;

use serde_json::{Map, Value, json};

/// How long the replay waits for a line the recording expects from the driver, unless `WIRE_REPLAY_DEADLINE_MS` says.
const DEADLINE: Duration = Duration::from_secs(30);

/// How long stdin must be quiet before the replay writes a line that a later prompt or interrupt follows, unless
/// `WIRE_REPLAY_QUIET_MS` says.
const QUIET: Duration = Duration::from_millis(100);

/// A line the driver sent: how many agent lines the replay had written when its first byte was read, and when its
/// last was.
struct Arrived {
    text: String,
    stamp: usize,
    at: Instant,
}

/// When the reader last read from stdin.
type Heard = Arc<Mutex<Option<Instant>>>;

/// The line the replay writes on stderr when it stays.
const STAYING: &str = "wire-replay: staying until signalled";

/// What the replay does once the recording has been played.
#[derive(Debug, PartialEq)]
enum End {
    Exit,
    /// The recorded agent outlived its stdin (a background task, or a driver killed mid-turn): stay until signalled.
    Stay,
}

fn main() -> ExitCode {
    // The Codex driver's shape check, before it starts app-server: every name it relies on is there.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [sub, generate, flag, folder] = &args[..]
        && (sub.as_str(), generate.as_str(), flag.as_str()) == ("app-server", "generate-json-schema", "--out")
    {
        return schema(Path::new(folder));
    }
    let (Some(fixture), Some(out)) = (std::env::var_os("WIRE_REPLAY_FIXTURE"), std::env::var_os("WIRE_REPLAY_OUT")) else {
        eprintln!("wire-replay: WIRE_REPLAY_FIXTURE and WIRE_REPLAY_OUT must be set");
        return ExitCode::from(2);
    };
    let out = PathBuf::from(out);
    let argv: Vec<String> = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    let vars: Vec<(String, String)> = std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect();
    if std::env::var_os("WIRE_REPLAY_IGNORE_TERM").is_some() {
        // SAFETY: setting a signal's disposition to ignore runs no handler code.
        unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
    }
    let secret = match std::env::var_os("WIRE_REPLAY_SECRET_FILE").map(std::fs::read_to_string) {
        Some(Ok(secret)) => Some(secret.trim().to_owned()).filter(|secret| !secret.is_empty()),
        Some(Err(e)) => return refuse(&out, &format!("cannot read the secret file: {e}")),
        None => None,
    };
    // The secret is counted where it is and kept out of every file written, with any token shape.
    let secrets: Vec<String> = secret.iter().cloned().collect();
    let shown: Vec<String> = argv.iter().map(|arg| redact::text(arg, &secrets)).collect();
    let written = std::fs::write(out.join("argv.json"), Value::from(shown).to_string())
        .and_then(|()| std::fs::write(out.join("env.json"), Value::Object(environment(&vars)).to_string()))
        .and_then(|()| std::fs::write(out.join("pid"), std::process::id().to_string()))
        .and_then(|()| std::fs::write(out.join("stdin"), stdin_kind()))
        .and_then(|()| match &secret {
            Some(secret) => std::fs::write(out.join("secret.json"), holding(secret, &vars, &argv).to_string()),
            None => Ok(()),
        });
    let recording = match (written, load(Path::new(&fixture))) {
        (Ok(()), Ok(recording)) => recording,
        (Err(e), _) => return refuse(&out, &format!("cannot write the out folder: {e}")),
        (_, Err(e)) => return refuse(&out, &e),
    };
    let Ok(sent) = std::fs::File::create(out.join("sent.jsonl")) else { return refuse(&out, "cannot write sent.jsonl") };
    let ms = |name: &str, default: Duration| std::env::var(name).ok().and_then(|ms| ms.parse().ok()).map_or(default, Duration::from_millis);
    let (deadline, quiet) = (ms("WIRE_REPLAY_DEADLINE_MS", DEADLINE), ms("WIRE_REPLAY_QUIET_MS", QUIET));
    // A FIFO the test made, to learn which agent lines the replay has written without waiting on a timer.
    let progress = match std::env::var_os("WIRE_REPLAY_PROGRESS") {
        Some(path) => match std::fs::OpenOptions::new().write(true).open(path) {
            Ok(fifo) => Some(fifo),
            Err(e) => return refuse(&out, &format!("cannot open the progress FIFO: {e}")),
        },
        None => None,
    };
    let written = Arc::new(AtomicUsize::new(0));
    let (lines, input) = std::sync::mpsc::channel();
    let (reading, heard) = (written.clone(), Heard::default());
    let hearing = heard.clone();
    std::thread::spawn(move || read_stdin(&reading, &hearing, sent, &secrets, &lines));
    let mut replay = Replay::new(recording);
    (replay.deadline, replay.quiet, replay.heard, replay.progress) = (deadline, quiet, heard, progress);
    replay.pace = std::env::var("WIRE_REPLAY_PACE").ok().and_then(|pace| pace.parse().ok());
    replay.out = out.clone();
    match replay.play(&input, &written, &mut std::io::stdout().lock(), &mut std::io::stderr().lock()) {
        Ok(End::Exit) => ExitCode::SUCCESS,
        Ok(End::Stay) => {
            // Tests read this line to know the replay stays, rather than waiting to see that it did not exit. Recorded
            // stderr is written as JSON strings, so it never starts with this.
            eprintln!("{STAYING}");
            loop {
                std::thread::park();
            }
        }
        Err(mismatch) => refuse(&out, &mismatch),
    }
}

/// The schema files the Codex driver reads, listing every name it needs.
fn schema(folder: &Path) -> ExitCode {
    let files = harness::codex::driver::NEEDED.iter().map(|(file, names)| {
        let entries: Vec<Value> = names.iter().map(|name| json!({"properties": {"method": {"enum": [name]}}})).collect();
        std::fs::write(folder.join(file), json!({"oneOf": entries}).to_string())
    });
    match files.collect::<std::io::Result<Vec<()>>>() {
        Ok(_) => ExitCode::SUCCESS,
        Err(_) => ExitCode::from(1),
    }
}

/// What fd 0 is: a driver must give its agent a pipe it owns, never the harness's own stdin.
fn stdin_kind() -> &'static str {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: `stat` is as large as the call writes.
    if unsafe { libc::fstat(0, stat.as_mut_ptr()) } != 0 {
        return "closed";
    }
    // SAFETY: the call filled it.
    let mode = unsafe { stat.assume_init() }.st_mode;
    if mode & libc::S_IFMT == libc::S_IFIFO { "pipe" } else { "not a pipe" }
}

/// Reads the driver's lines as they come. Each is stamped with how many agent lines the replay had written when the
/// read that brought its first byte returned, so a line is never stamped later than it began to come, and with the
/// moment its last byte was read, which its deadline is judged by. Each line is kept in `sent` first: a line that
/// cannot be kept fails the replay, so a test never reads a partial `sent.jsonl` as the whole.
fn read_stdin(written: &AtomicUsize, heard: &Heard, mut sent: std::fs::File, secrets: &[String], lines: &Sender<Result<Arrived, String>>) {
    let (mut stdin, mut pending, mut chunk) = (std::io::stdin().lock(), Vec::new(), vec![0u8; 64 * 1024]);
    let mut deliver = |line: &[u8], stamp: usize, at: Instant| {
        let text = String::from_utf8_lossy(line).into_owned();
        if let Err(e) = writeln!(sent, "{}", kept(&text, secrets)).and_then(|()| sent.flush()) {
            let _ = lines.send(Err(format!("cannot write sent.jsonl: {e}")));
            return false;
        }
        lines.send(Ok(Arrived { text, stamp, at })).is_ok()
    };
    // The stamp of the read that brought the first byte of what is pending.
    let mut began = None;
    loop {
        let n = match stdin.read(&mut chunk) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                let _ = lines.send(Err(format!("cannot read stdin: {e}")));
                return;
            }
        };
        let at = Instant::now();
        *heard.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(at);
        let stamp = written.load(Ordering::SeqCst);
        if n == 0 {
            // A last line with no newline is still a line: dropped, an extra message would pass unseen.
            if !pending.is_empty() {
                deliver(&pending, began.unwrap_or(stamp), at);
            }
            return;
        }
        if pending.is_empty() {
            began = Some(stamp);
        }
        pending.extend_from_slice(&chunk[..n]);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            if !deliver(&line[..end], began.unwrap_or(stamp), at) {
                return;
            }
            // What follows in this read began in it.
            began = Some(stamp);
        }
    }
}

/// The variables whose values `env.json` shows. Of any other it holds the name only, since values can be secrets.
const SHOWN: &[&str] = &["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"];

fn environment(vars: &[(String, String)]) -> Map<String, Value> {
    let shown = |name: &str| SHOWN.contains(&name) || name.starts_with("WIRE_REPLAY_");
    vars.iter().map(|(name, value)| (name.clone(), if shown(name) { Value::from(value.as_str()) } else { Value::Null })).collect()
}

/// Where the test's secret is: the names of the variables whose value holds it, and how many arguments do.
fn holding(secret: &str, vars: &[(String, String)], argv: &[String]) -> Value {
    let env: Vec<&String> = vars.iter().filter(|(name, value)| name != "WIRE_REPLAY_SECRET_FILE" && value.contains(secret)).map(|(name, _)| name).collect();
    json!({"env": env, "argv": argv.iter().filter(|arg| arg.contains(secret)).count()})
}

/// A line as `sent.jsonl` keeps it: a server's header values, a token among them, are written `<redacted>`, and every
/// other string goes through `redact` with the test's secret.
fn kept(text: &str, secrets: &[String]) -> String {
    let Ok(mut line) = serde_json::from_str::<Value>(text) else { return "<a line that is not JSON>".to_owned() };
    if let Some(servers) = line.get_mut("request").and_then(|request| request.get_mut("servers")).and_then(Value::as_object_mut) {
        for headers in servers.values_mut().filter_map(|server| server.get_mut("headers")).filter_map(Value::as_object_mut) {
            headers.values_mut().for_each(|value| *value = Value::from(redact::MASK));
        }
    }
    if let Some(servers) = line.pointer_mut("/params/config/mcp_servers").and_then(Value::as_object_mut) {
        for headers in servers.values_mut().filter_map(|server| server.get_mut("http_headers")).filter_map(Value::as_object_mut) {
            headers.values_mut().for_each(|value| *value = Value::from(redact::MASK));
        }
    }
    if let Some(servers) = line.pointer_mut("/params/mcpServers").and_then(Value::as_array_mut) {
        for header in servers.iter_mut().filter_map(|server| server.get_mut("headers")).filter_map(Value::as_array_mut).flatten() {
            header["value"] = Value::from(redact::MASK);
        }
    }
    redact::each_string(&mut line, &mut |text| *text = redact::text(text, secrets));
    line.to_string()
}

fn refuse(out: &Path, why: &str) -> ExitCode {
    let _ = std::fs::write(out.join("report.txt"), format!("{why}\n"));
    eprintln!("wire-replay: {why}");
    ExitCode::from(3)
}

/// One line of an H0 transcript.
#[derive(Debug, Clone)]
struct Recorded {
    seq: u64,
    ms: u64,
    dir: String,
    data: Value,
}

fn load(path: &Path) -> Result<Vec<Recorded>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read the recording: {e}"))?;
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(at, line)| {
            let line: Value = serde_json::from_str(line).map_err(|_| format!("line {} of the recording is not JSON", at + 1))?;
            let seq = line["seq"].as_u64().unwrap_or(at as u64 + 1);
            Ok(Recorded { seq, ms: line["ms"].as_u64().unwrap_or(0), dir: line["dir"].as_str().unwrap_or_default().to_owned(), data: line["data"].clone() })
        })
        .collect()
}

struct Replay {
    lines: Vec<Recorded>,
    deadline: Duration,
    quiet: Duration,
    heard: Heard,
    progress: Option<std::fs::File>,
    /// The seq of each agent line written, in order.
    played: Vec<u64>,
    ids: Ids,
    /// Recorded request ids whose answers are not played: answers to config requests.
    skipped: HashSet<String>,
    /// The input of each `can_use_tool` the replay sent, by its live id: an allow must run exactly that.
    asked: HashMap<String, Value>,
    /// The driver gave the tools endpoint, by a well-formed `mcp_set_servers`.
    endpoint: bool,
    prompted: bool,
    /// The recording speaks `codex app-server`'s JSON-RPC, or ACP's.
    rpc: bool,
    acp: bool,
    /// Agent lines go out no sooner than their recorded `ms` times this, from `begun`.
    pace: Option<f64>,
    begun: Instant,
    out: PathBuf,
    /// The server name the driver gave its endpoint in `session/new` or `session/load`.
    endpoint_name: Option<String>,
}

impl Replay {
    fn new(lines: Vec<Recorded>) -> Replay {
        let (ids, asked) = (Ids::default(), HashMap::new());
        let (begun, out) = (Instant::now(), PathBuf::new());
        Replay { lines, deadline: DEADLINE, quiet: QUIET, heard: Heard::default(), progress: None, played: vec![], ids, skipped: HashSet::new(), asked, endpoint: false, prompted: false, rpc: false, acp: false, pace: None, begun, out, endpoint_name: None }
    }

    /// Waits until stdin has been quiet for `quiet`, so a driver that reacts to a line already written has sent what it
    /// sends before the next one is. A driver that never stops writing holds the replay no longer than its deadline.
    fn hush(&self) {
        let began = Instant::now();
        loop {
            let heard = self.heard.lock().unwrap_or_else(std::sync::PoisonError::into_inner).map_or(began, |heard| heard.max(began));
            let (now, until) = (Instant::now(), (heard + self.quiet).min(began + self.deadline));
            if now >= until {
                return;
            }
            std::thread::sleep(until - now);
        }
    }

    fn play(mut self, input: &Receiver<Result<Arrived, String>>, written: &AtomicUsize, stdout: &mut impl Write, stderr: &mut impl Write) -> Result<End, String> {
        let (mut closed, mut stays) = (false, false);
        let lines = std::mem::take(&mut self.lines);
        self.rpc = lines.iter().find(|line| line.dir == "to_agent").is_some_and(|line| line.data.get("method").is_some() && line.data.get("type").is_none());
        self.acp = lines.iter().find(|line| line.dir == "to_agent").is_some_and(|line| line.data.get("jsonrpc").is_some());
        if self.acp {
            let named = lines.iter().filter(|line| line.dir == "to_agent").find_map(|line| line.data["params"]["sessionId"].as_str());
            let started = || lines.iter().filter(|line| line.dir == "from_agent").find_map(|line| line.data["result"]["sessionId"].as_str());
            self.ids.recorded_session = named.or_else(started).unwrap_or_default().to_owned();
        }
        if self.rpc && !self.acp {
            self.ids.recorded_servers = approved_servers(&lines);
        }
        // Where the recording gives the endpoint before its first prompt, the driver must too.
        let first_prompt = lines.iter().position(|line| line.dir == "to_agent" && is_prompt(&line.data)).unwrap_or(lines.len());
        // ACP's config line sets an option, not the endpoint, which `session/new` gives.
        let endpoint_at = lines[..first_prompt].iter().find(|line| line.dir == "to_agent" && is_config(&line.data) && !self.acp).map(|line| line.seq);
        self.skipped = lines.iter().filter(|line| line.dir == "to_agent" && is_config(&line.data)).map(|line| request_id(&line.data)).collect();
        self.ids.recorded_allowed = recorded_allowed(&lines);
        if !self.rpc {
            self.ids.recorded_servers = configured_servers(&lines);
        }
        let follows = follows(&lines, &self.skipped);
        let waited_for: HashSet<u64> = follows.values().copied().collect();
        for line in &lines {
            match (line.dir.as_str(), line.data["note"].as_str()) {
                ("from_agent", _) => {
                    if !plays(line, &self.skipped) {
                        continue;
                    }
                    if waited_for.contains(&line.seq) {
                        self.hush();
                    }
                    if let Some(pace) = self.pace {
                        let due = self.begun + Duration::from_secs_f64(line.ms as f64 * pace / 1000.0);
                        std::thread::sleep(due.saturating_duration_since(Instant::now()));
                    }
                    let mut data = line.data.clone();
                    if let Some(name) = &self.endpoint_name {
                        redact::each_string(&mut data, &mut |text| *text = text.replace("<endpoint>", name));
                    }
                    // Taken before the mapping, which gives a string id a fresh one of its own.
                    let recorded_id = data.get("id").map(Value::to_string);
                    self.ids.agent(&mut data);
                    if self.rpc && data.get("method").is_none() {
                        // An answer to the driver's request carries the driver's id.
                        if let Some(sent) = recorded_id.and_then(|id| self.ids.rpc.get(&id)).cloned() {
                            data["id"] = sent;
                        }
                    }
                    if data["request"]["subtype"] == "can_use_tool"
                        && let Some(id) = data["request_id"].as_str()
                    {
                        self.asked.insert(id.to_owned(), data["request"]["input"].clone());
                    }
                    // Counted before it is written: a driver can answer a line only once it is in the pipe, so an
                    // answer always sees the count, and only a line sent before it can be stamped early.
                    self.played.push(line.seq);
                    written.store(self.played.len(), Ordering::SeqCst);
                    writeln!(stdout, "{data}").and_then(|()| stdout.flush()).map_err(|e| format!("cannot write stdout: {e}"))?;
                    if let Some(progress) = &mut self.progress {
                        let _ = writeln!(progress, "{}", line.seq).and_then(|()| progress.flush());
                    }
                }
                ("stderr", _) => {
                    // As one JSON string per line, so no recorded text can read as one of the replay's own lines.
                    let text = line.data.as_str().map_or_else(|| line.data.to_string(), str::to_owned);
                    let _ = writeln!(stderr, "{}", Value::from(text));
                }
                ("to_agent", _) if is_config(&line.data) => {
                    // A recorded config request the driver may or may not send; its answer is the replay's own.
                    self.ids.servers(&line.data);
                }
                ("to_agent", _) => {
                    let (place, never) = (format!("line {}", line.seq), format!("line {}: the driver never sent {}", line.seq, what(&line.data)));
                    let Some((sent, stamp)) = self.next(input, stdout, &place, Some(&never))? else {
                        return Err(format!("line {}: stdin closed where the recording has {}", line.seq, what(&line.data)));
                    };
                    if is_prompt(&line.data) && !std::mem::replace(&mut self.prompted, true)
                        && let Some(at) = endpoint_at.filter(|_| !self.endpoint)
                    {
                        return Err(format!("line {}: the driver sent its first prompt before it gave the tools endpoint, which the recording gives at line {at}", line.seq));
                    }
                    self.compare(line, &sent)?;
                    // A prompt during a turn, or an interrupt before the line it stops.
                    let written_at = |after: &u64| self.played.iter().position(|seq| seq == after);
                    if let Some(after) = follows.get(&line.seq).filter(|after| written_at(after).is_some_and(|at| stamp <= at)) {
                        return Err(format!("line {}: {} came before line {after} was written, the line it follows", line.seq, what(&sent)));
                    }
                }
                ("driver", Some("close_stdin")) => {
                    let (place, open) = (format!("line {}", line.seq), format!("line {}: the driver did not close stdin where the recording does", line.seq));
                    if let Some((sent, _)) = self.next(input, stdout, &place, Some(&open))? {
                        return Err(format!("line {}: the driver sent {} where the recording closes stdin", line.seq, what(&sent)));
                    }
                    closed = true;
                }
                ("driver", Some("still_running_killing")) => stays = true,
                ("driver", Some("spawn_child")) => self.spawn_child(line.data["detail"]["ms"].as_u64().unwrap_or(0))?,
                // What came after a signal is the signal's doing, not the driver's.
                ("driver", Some("signal")) => break,
                _ => {}
            }
        }
        if !closed {
            // The recorded agent was killed or stays: the driver may take as long as it likes to close stdin.
            if let Some((sent, _)) = self.next(input, stdout, "after the recording ended", None)? {
                return Err(format!("the driver sent {} after the recording ended", what(&sent)));
            }
            stays = true;
        }
        Ok(if stays { End::Stay } else { End::Exit })
    }

    /// The driver's next line that is not a config request, with its stamp, answering each config request on the way;
    /// None at EOF. `place` names, in a report, the recorded line the replay waits for. With `late`, a line that does
    /// not arrive within the deadline fails the replay with that report.
    fn next(&mut self, input: &Receiver<Result<Arrived, String>>, stdout: &mut impl Write, place: &str, late: Option<&str>) -> Result<Option<(Value, usize)>, String> {
        // One deadline for the line, which blank lines and config requests on the way do not move. It is judged by when
        // a line arrived, so one that came in time is taken however late the replay looks.
        let until = Instant::now() + self.deadline;
        let late_by = |late: &str| format!("{late} within {} ms", self.deadline.as_millis());
        loop {
            let arrived = match late {
                Some(late) => match input.recv_timeout(until.saturating_duration_since(Instant::now())) {
                    Ok(arrived) => arrived,
                    Err(RecvTimeoutError::Timeout) => return Err(late_by(late)),
                    Err(RecvTimeoutError::Disconnected) => return Ok(None),
                },
                None => match input.recv() {
                    Ok(arrived) => arrived,
                    Err(_) => return Ok(None),
                },
            };
            let Arrived { text: line, stamp, at } = arrived?;
            if let Some(late) = late.filter(|_| at > until) {
                return Err(late_by(late));
            }
            if line.trim().is_empty() {
                continue;
            }
            let sent: Value = serde_json::from_str(&line).map_err(|_| format!("{place}: the driver sent a line that is not JSON"))?;
            if !is_config(&sent) {
                return Ok(Some((sent, stamp)));
            }
            if self.acp {
                // A chosen model or effort: answered as set, its session id the replay's.
                if !self.ids.maps(&self.recorded_session(), &sent["params"]["sessionId"]) {
                    return Err(format!("{place}: the driver set a config option on another session"));
                }
                let answer = json!({"jsonrpc": "2.0", "id": sent["id"], "result": {"configOptions": []}});
                writeln!(stdout, "{answer}").and_then(|()| stdout.flush()).map_err(|e| format!("cannot write stdout: {e}"))?;
                continue;
            }
            self.ids.claim(&sent["request_id"]).map_err(|why| format!("{place}: {why}"))?;
            // A server the agent could not reach is never answered as added.
            let servers = sent["request"]["servers"].as_object().filter(|servers| !servers.is_empty());
            let reachable = |server: &Value| server["type"] == "http" && server["url"].as_str().is_some_and(|url| !url.is_empty());
            if !servers.is_some_and(|servers| servers.values().all(reachable)) {
                return Err(format!("{place}: the driver sent mcp_set_servers with a server that is not http with a url"));
            }
            self.endpoint = true;
            self.ids.sent_servers(&sent);
            let answer = json!({"type": "control_response", "response": {"subtype": "success", "request_id": sent["request_id"], "response": config_answer(&sent)}});
            writeln!(stdout, "{answer}").and_then(|()| stdout.flush()).map_err(|e| format!("cannot write stdout: {e}"))?;
        }
    }

    fn compare(&mut self, recorded: &Recorded, sent: &Value) -> Result<(), String> {
        if self.rpc {
            return self.compare_rpc(recorded, sent);
        }
        let (want, at) = (&recorded.data, recorded.seq);
        let differs = |field: &str| Err(format!("line {at}: {field} differs from the recording's {}", what(want)));
        if want["type"] != sent["type"] {
            return Err(format!("line {at}: the driver sent {} where the recording has {}", what(sent), what(want)));
        }
        match want["type"].as_str() {
            Some("control_request") => {
                if want["request"]["subtype"] != sent["request"]["subtype"] {
                    return differs("the subtype");
                }
                self.ids.bind(&want["request_id"], &sent["request_id"]).map_err(|why| format!("line {at}: {why}"))
            }
            Some("control_response") => {
                // Exactly the recorded fields at each level: a field more can widen what was allowed
                // (`updatedPermissions`) or end the turn (`interrupt`).
                // As sets: whatever order a map keeps its keys in, the same keys compare equal.
                let keys = |value: &Value| value.as_object().map(|fields| fields.keys().cloned().collect::<BTreeSet<_>>());
                let fields = Err(format!("line {at}: the answer's fields differ from the recording's {}", what(want)));
                if keys(want) != keys(sent) {
                    return fields;
                }
                let (want, sent) = (&want["response"], &sent["response"]);
                if !self.ids.maps(&want["request_id"], &sent["request_id"]) {
                    return differs("the request id");
                }
                if want["subtype"] != sent["subtype"] {
                    return differs("the answer's subtype");
                }
                if keys(want) != keys(sent) {
                    return fields;
                }
                let (want, sent_answer) = (&want["response"], &sent["response"]);
                if want["behavior"] != sent_answer["behavior"] {
                    return differs("the decision");
                }
                match want["behavior"].as_str() {
                    // An allow runs exactly what was asked, as the replay sent it.
                    Some("allow") => {
                        let asked = sent["request_id"].as_str().and_then(|id| self.asked.get(id));
                        if asked.is_none() || sent_answer.get("updatedInput") != asked {
                            return differs("the allowed input");
                        }
                    }
                    _ if want.get("message") != sent_answer.get("message") => return differs("the deny's message"),
                    _ => {}
                }
                let compared = ["behavior", "updatedInput", "message"];
                let other = want.as_object().into_iter().flatten().filter(|(key, _)| !compared.contains(&key.as_str()));
                if keys(want) != keys(sent_answer) || other.into_iter().any(|(key, value)| sent_answer.get(key) != Some(value)) {
                    return fields;
                }
                Ok(())
            }
            Some("user") => {
                let (want, sent) = (&want["message"], &sent["message"]);
                if want["role"] != sent["role"] {
                    return differs("the prompt's role");
                }
                if texts(&want["content"]) != texts(&sent["content"]) {
                    return differs("the prompt's text");
                }
                if images(&want["content"]) != images(&sent["content"]) {
                    return differs("the prompt's set of images");
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl Replay {
    fn compare_rpc(&mut self, recorded: &Recorded, sent: &Value) -> Result<(), String> {
        let (want, at) = (&recorded.data, recorded.seq);
        let differs = |field: &str| Err(format!("line {at}: {field} differs from the recording's {}", what(want)));
        let Some(method) = want["method"].as_str() else {
            // The answer to a request of the agent's: its id as the replay sent it, and the same decision.
            let keys = |value: &Value| value["result"].as_object().map(|fields| fields.keys().cloned().collect::<BTreeSet<_>>());
            return match (sent.get("method"), sent["id"] == want["id"] || self.ids.maps(&want["id"], &sent["id"])) {
                (Some(_), _) => Err(format!("line {at}: the driver sent {} where the recording has {}", what(sent), what(want))),
                (None, false) => differs("the answer's id"),
                _ if keys(want) != keys(sent) => differs("the answer's fields"),
                _ if want["result"]["decision"] != sent["result"]["decision"] || want["result"]["action"] != sent["result"]["action"] => differs("the decision"),
                _ if want["result"]["outcome"] != sent["result"]["outcome"] => differs("the decision"),
                _ => Ok(()),
            };
        };
        if sent["method"] != method {
            return Err(format!("line {at}: the driver sent {} where the recording has {}", what(sent), what(want)));
        }
        if let Some(id) = want.get("id") {
            let fresh = sent.get("id").is_some_and(|id| !id.is_null() && self.ids.chosen.insert(id.to_string()));
            if !fresh {
                return Err(format!("line {at}: the driver's request has no id, or one it used before"));
            }
            self.ids.rpc.insert(id.to_string(), sent["id"].clone());
        }
        let (want, sent) = (&want["params"], &sent["params"]);
        match method {
            "thread/start" | "thread/resume" => {
                let recorded_servers = want["config"]["mcp_servers"].as_object().is_some_and(|servers| !servers.is_empty());
                let servers = sent["config"]["mcp_servers"].as_object().filter(|servers| !servers.is_empty());
                if recorded_servers {
                    let reachable = |server: &Value| server["url"].as_str().is_some_and(|url| !url.is_empty());
                    if !servers.is_some_and(|servers| servers.values().all(reachable)) {
                        return Err(format!("line {at}: the driver's {method} gives no tools endpoint with a url, which the recording gives"));
                    }
                    self.endpoint = true;
                }
                self.ids.sent_servers = servers.map(|servers| servers.keys().cloned().collect()).unwrap_or_default();
                if let (Some(recorded), Some(live)) = (want["threadId"].as_str(), sent["threadId"].as_str()) {
                    self.ids.to.entry(recorded.to_owned()).or_insert_with(|| live.to_owned());
                }
                if method == "thread/resume" && !self.ids.maps(&want["threadId"], &sent["threadId"]) {
                    return differs("the thread id");
                }
                Ok(())
            }
            "session/new" | "session/load" => {
                if want["mcpServers"].as_array().is_some_and(|servers| !servers.is_empty()) {
                    let header = |server: &Value| server["headers"].as_array().into_iter().flatten().any(|header| header["name"] == "Authorization");
                    let reachable = |server: &&Value| server["type"] == "http" && server["url"].as_str().is_some_and(|url| !url.is_empty()) && header(server);
                    let Some(server) = sent["mcpServers"].as_array().into_iter().flatten().find(reachable) else {
                        return Err(format!("line {at}: the driver's {method} gives no http tools endpoint with a url and a header, which the recording gives"));
                    };
                    self.endpoint = true;
                    self.endpoint_name = server["name"].as_str().map(str::to_owned);
                }
                if method == "session/load" {
                    if let (Some(recorded), Some(live)) = (want["sessionId"].as_str(), sent["sessionId"].as_str()) {
                        self.ids.to.entry(recorded.to_owned()).or_insert_with(|| live.to_owned());
                    }
                    if !self.ids.maps(&want["sessionId"], &sent["sessionId"]) {
                        return differs("the session id");
                    }
                }
                Ok(())
            }
            "session/prompt" if texts(&unguarded(&want["prompt"])) != texts(&unguarded(&sent["prompt"])) => differs("the prompt's text"),
            "session/prompt" | "session/cancel" if !self.ids.maps(&want["sessionId"], &sent["sessionId"]) => differs("the session id"),
            "turn/start" if texts(&want["input"]) != texts(&sent["input"]) => differs("the prompt's text"),
            "turn/start" if !self.ids.maps(&want["threadId"], &sent["threadId"]) => differs("the thread id"),
            "turn/interrupt" if !self.ids.maps(&want["threadId"], &sent["threadId"]) || !self.ids.maps(&want["turnId"], &sent["turnId"]) => differs("the interrupted turn"),
            _ => Ok(()),
        }
    }
}

/// A prompt, on any wire.
fn is_prompt(data: &Value) -> bool {
    data["type"] == "user" || data["method"] == "turn/start" || data["method"] == "session/prompt"
}

/// A prompt's blocks without the driver's guard.
fn unguarded(blocks: &Value) -> Value {
    Value::from(blocks.as_array().into_iter().flatten().filter(|block| block["_meta"]["gossamr"] != "guard").cloned().collect::<Vec<_>>())
}

impl Replay {
    /// The recording's own session id: the first a `session/prompt` names, or the one `session/load` loads.
    fn recorded_session(&self) -> Value {
        Value::from(self.ids.recorded_session.clone())
    }

    fn spawn_child(&mut self, ms: u64) -> Result<(), String> {
        use std::os::unix::process::CommandExt;
        // In a group of its own, so only the driver's noted tree leads to it, not the agent's group.
        let mut command = std::process::Command::new("/bin/sleep");
        command.arg(format!("{}", ms as f64 / 1000.0)).process_group(0);
        let mut child = command.spawn().map_err(|e| format!("cannot start the child: {e}"))?;
        std::fs::write(self.out.join("child.pid"), child.id().to_string()).map_err(|e| format!("cannot write child.pid: {e}"))?;
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

/// The servers a recorded app-server thread approved without asking: the endpoint among them.
fn approved_servers(lines: &[Recorded]) -> Vec<String> {
    let thread = lines.iter().find(|line| line.dir == "to_agent" && matches!(line.data["method"].as_str(), Some("thread/start" | "thread/resume")));
    let servers = thread.and_then(|line| line.data["params"]["config"]["mcp_servers"].as_object());
    servers.into_iter().flatten().filter(|(_, server)| server["default_tools_approval_mode"] == "approve").map(|(name, _)| name.clone()).collect()
}

/// The line types and control subtypes a report may name. Anything else is named by a fixed label, so a report
/// never holds text a driver put in those fields.
const TYPES: &[&str] = &["user", "control_request", "control_response", "control_cancel_request", "assistant", "system", "result", "stream_event"];
const SUBTYPES: &[&str] = &["initialize", "interrupt", "can_use_tool", "mcp_set_servers", "set_model", "set_permission_mode"];
const METHODS: &[&str] = &[
    "initialize", "initialized", "thread/start", "thread/resume", "turn/start", "turn/interrupt", "turn/completed", "item/started", "item/completed",
    "session/new", "session/load", "session/prompt", "session/cancel", "session/set_config_option", "session/update", "session/request_permission",
];

/// A line's kind, for a report: its type and a control line's subtype. Never its payload.
fn what(data: &Value) -> String {
    let known = |value: &Value, list: &[&'static str], other: &'static str| match value.as_str() {
        Some(word) => list.iter().find(|known| **known == word).copied().unwrap_or(other),
        None => other,
    };
    if data.get("type").is_none() && (data.get("method").is_some() || data.get("id").is_some()) {
        return match data.get("method") {
            Some(method) => known(method, METHODS, "a request of an unknown method").to_owned(),
            None => "an answer".to_owned(),
        };
    }
    let kind = known(&data["type"], TYPES, "a line of an unknown type");
    match data["request"].get("subtype") {
        Some(subtype) => format!("{kind} {}", known(subtype, SUBTYPES, "of an unknown subtype")),
        None => kind.to_owned(),
    }
}

/// The tools the recorded run's `--allowedTools` named, from the recording's spawn note.
fn recorded_allowed(lines: &[Recorded]) -> Vec<String> {
    let spawned = lines.iter().find(|line| line.dir == "driver" && line.data["note"] == "spawned");
    let argv: Vec<&str> = spawned.and_then(|line| line.data["detail"]["argv"].as_array()).into_iter().flatten().filter_map(Value::as_str).collect();
    let after = argv.iter().position(|arg| *arg == "--allowedTools").and_then(|at| argv.get(at + 1));
    after.into_iter().flat_map(|tools| tools.split([',', ' '])).filter(|tool| !tool.is_empty()).map(str::to_owned).collect()
}

/// The servers the recorded run's `--mcp-config` named, for a recording that gave its endpoint that way. A recorded
/// `mcp_set_servers` names them in its place.
fn configured_servers(lines: &[Recorded]) -> Vec<String> {
    let spawned = lines.iter().find(|line| line.dir == "driver" && line.data["note"] == "spawned");
    let argv: Vec<&str> = spawned.and_then(|line| line.data["detail"]["argv"].as_array()).into_iter().flatten().filter_map(Value::as_str).collect();
    let config = argv.iter().position(|arg| *arg == "--mcp-config").and_then(|at| argv.get(at + 1)).and_then(|config| serde_json::from_str::<Value>(config).ok());
    config.and_then(|config| config["mcpServers"].as_object().map(|servers| servers.keys().cloned().collect())).unwrap_or_default()
}

/// Whether the replay writes this line: an agent line, unless it answers a config request whose answer is the
/// replay's own. An agent's own request is played whatever its id.
fn plays(line: &Recorded, skipped: &HashSet<String>) -> bool {
    let answer = line.data["type"] == "control_response" || line.data.get("jsonrpc").is_some() && line.data.get("method").is_none();
    line.dir == "from_agent" && !(answer && skipped.contains(&request_id(&line.data)))
}

/// For each prompt and interrupt of the driver's, the agent line it follows: a prompt the `result` before it, an
/// interrupt the last line before it that is not a `stream_event`. The first prompt follows nothing.
fn follows(lines: &[Recorded], skipped: &HashSet<String>) -> HashMap<u64, u64> {
    let (mut follows, mut result, mut last) = (HashMap::new(), None, None);
    for line in lines {
        if plays(line, skipped) {
            if line.data["type"] == "result" || line.data["method"] == "turn/completed" || line.data["result"].get("stopReason").is_some() {
                result = Some(line.seq);
            }
            if line.data["type"] != "stream_event" {
                last = Some(line.seq);
            }
        } else if line.dir == "to_agent" {
            let after = match (line.data["type"].as_str(), line.data["request"]["subtype"].as_str(), line.data["method"].as_str()) {
                (Some("user"), ..) | (_, _, Some("turn/start" | "session/prompt")) => result,
                (Some("control_request"), Some("interrupt"), _) | (_, _, Some("turn/interrupt" | "session/cancel")) => last,
                _ => None,
            };
            follows.extend(after.map(|after| (line.seq, after)));
        }
    }
    follows
}

fn request_id(data: &Value) -> String {
    match data.get("jsonrpc") {
        Some(_) => data["id"].to_string(),
        None => data["request_id"].as_str().or(data["response"]["request_id"].as_str()).unwrap_or_default().to_owned(),
    }
}

/// The control requests a driver chooses to send or not, which a replay answers and does not compare: the config lines
/// H6 leaves out. Any other line the recording does not have is a mismatch.
const CONFIG: &[&str] = &["mcp_set_servers"];

fn is_config(data: &Value) -> bool {
    data["type"] == "control_request" && data["request"]["subtype"].as_str().is_some_and(|subtype| CONFIG.contains(&subtype)) || data["method"] == "session/set_config_option"
}

fn config_answer(sent: &Value) -> Value {
    match sent["request"]["subtype"].as_str() {
        Some("mcp_set_servers") => {
            let added: Vec<&String> = sent["request"]["servers"].as_object().map(|servers| servers.keys().collect()).unwrap_or_default();
            json!({"added": added, "removed": [], "errors": {}})
        }
        _ => json!({}),
    }
}

/// A user message's image blocks, by their media types in order.
fn images(content: &Value) -> Vec<Value> {
    content.as_array().into_iter().flatten().filter(|block| block["type"] == "image").map(|block| block["source"]["media_type"].clone()).collect()
}

/// A user message's text: its string content, or its text blocks joined.
fn texts(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// The recorded run's ids and this run's. An id first seen from the agent gets a fresh one of the same shape; an id
/// the driver chose is bound when its line is compared.
#[derive(Default)]
struct Ids {
    to: HashMap<String, String>,
    /// Ids the driver chose, so it cannot answer two requests with one id.
    chosen: HashSet<String>,
    /// The recorded config's server names, and the driver's.
    recorded_servers: Vec<String>,
    /// What the recorded run allowed by `--allowedTools`, which names the endpoint among several servers.
    recorded_allowed: Vec<String>,
    sent_servers: Vec<String>,
    /// A recorded JSON-RPC request id, as JSON, and the driver's.
    rpc: HashMap<String, Value>,
    /// The recorded ACP session's id.
    recorded_session: String,
}

/// ACP's `optionId` and `configId` name what agy offers (`allow`, `model`), not anything of the recorded run's.
fn is_id_field(key: &str) -> bool {
    !matches!(key, "optionId" | "configId") && (matches!(key, "id" | "uuid") || ["_id", "Id", "_ids", "Ids"].iter().any(|end| key.ends_with(end)))
}

impl Ids {
    fn bind(&mut self, recorded: &Value, sent: &Value) -> Result<(), String> {
        let (Some(recorded), Some(sent)) = (recorded.as_str(), sent.as_str()) else {
            return match recorded == sent {
                true => Ok(()),
                false => Err("the request id differs in kind".into()),
            };
        };
        if self.to.values().any(|live| live == sent) || !self.chosen.insert(sent.to_owned()) {
            return Err("the driver used a request id twice".into());
        }
        self.to.insert(recorded.to_owned(), sent.to_owned());
        Ok(())
    }

    /// Takes an id the driver chose for a request the recording does not compare: like any other, used once.
    fn claim(&mut self, sent: &Value) -> Result<(), String> {
        let fresh = sent.as_str().is_some_and(|sent| !self.to.values().any(|live| live == sent) && self.chosen.insert(sent.to_owned()));
        if fresh { Ok(()) } else { Err("the driver used a request id twice, or one that is not a string".into()) }
    }

    fn maps(&self, recorded: &Value, sent: &Value) -> bool {
        recorded.as_str().and_then(|recorded| self.to.get(recorded)).is_some_and(|live| Some(live.as_str()) == sent.as_str())
    }

    fn servers(&mut self, recorded: &Value) {
        if let Some(servers) = recorded["request"]["servers"].as_object() {
            self.recorded_servers = servers.keys().cloned().collect();
        }
    }

    fn sent_servers(&mut self, sent: &Value) {
        if let Some(servers) = sent["request"]["servers"].as_object() {
            self.sent_servers = servers.keys().cloned().collect();
        }
    }

    /// The recorded endpoint's name and the driver's, when the driver names one server.
    fn server(&self) -> Option<(&str, &str)> {
        let allowed = |server: &&String| self.recorded_allowed.iter().any(|tool| tool.starts_with(&format!("mcp__{server}__")));
        let endpoint: Vec<&String> = self.recorded_servers.iter().filter(allowed).collect();
        match (self.recorded_servers.as_slice(), endpoint.as_slice(), self.sent_servers.as_slice()) {
            ([recorded], _, [sent]) => Some((recorded, sent)),
            (_, [recorded], [sent]) => Some((recorded, sent)),
            _ => None,
        }
    }

    /// Maps an agent line in place.
    fn agent(&mut self, value: &mut Value) {
        self.name(value, "");
        // Longest first, so an id inside a longer one (a run id in a script's file name) is not cut.
        let mut known: Vec<(String, String)> = self.to.iter().filter(|(recorded, _)| recorded.len() >= 8).map(|(r, l)| (r.clone(), l.clone())).collect();
        known.sort_by_key(|(recorded, _)| std::cmp::Reverse(recorded.len()));
        let server = self.server().map(|(recorded, sent)| (recorded.to_owned(), sent.to_owned()));
        rewrite(value, "", &known, server.as_ref());
    }

    /// A fresh id for `recorded` that is neither it nor any id already live, so no two requests share one. A short id
    /// whose draws keep colliding gets a numbered suffix instead.
    fn unused(&mut self, recorded: &str) -> String {
        let taken = |ids: &Ids, live: &str| live == recorded || ids.chosen.contains(live) || ids.to.values().any(|seen| seen == live);
        let live = (0..64).map(|_| fresh(recorded)).find(|live| !taken(self, live));
        live.unwrap_or_else(|| (1..).map(|n| format!("{recorded}-{n}")).find(|live| !taken(self, live)).expect("a free suffix"))
    }

    /// Gives every id in an id field its live id, a fresh one where the recording first names it here.
    fn name(&mut self, value: &mut Value, key: &str) {
        match value {
            Value::Object(fields) => fields.iter_mut().for_each(|(key, field)| self.name(field, key)),
            Value::Array(items) => items.iter_mut().for_each(|item| self.name(item, key)),
            Value::String(text) if is_id_field(key) && !text.is_empty() => {
                let live = match self.to.get(text) {
                    Some(live) => live.clone(),
                    None => {
                        let live = self.unused(text);
                        self.to.insert(text.clone(), live.clone());
                        live
                    }
                };
                *text = live;
            }
            _ => {}
        }
    }
}

/// Maps the ids the recording named in map keys (`wire_tool_inputs`) and in free text (a transcript's path, a tool's
/// output), and the recorded endpoint's name in its tool names.
fn rewrite(value: &mut Value, key: &str, known: &[(String, String)], server: Option<&(String, String)>) {
    match value {
        Value::Object(fields) => {
            if fields.keys().any(|key| known.iter().any(|(recorded, _)| recorded == key)) {
                let live = |key: String| known.iter().find(|(recorded, _)| *recorded == key).map_or(key, |(_, live)| live.clone());
                *fields = std::mem::take(fields).into_iter().map(|(key, field)| (live(key), field)).collect();
            }
            fields.iter_mut().for_each(|(key, field)| rewrite(field, key, known, server))
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rewrite(item, key, known, server)),
        Value::String(_) if is_id_field(key) => {}
        Value::String(text) => {
            for (recorded, live) in known {
                if text.contains(recorded.as_str()) {
                    *text = text.replace(recorded.as_str(), live);
                }
            }
            if let Some((recorded, sent)) = server {
                *text = match *text == *recorded {
                    true => sent.clone(),
                    false => text.replace(&format!("mcp__{recorded}__"), &format!("mcp__{sent}__")),
                };
            }
        }
        _ => {}
    }
}

/// A new id of `recorded`'s shape: a lowercase prefix before `_` is kept, and every other letter or digit is drawn
/// again from its own class, so a UUID stays a UUID and `toolu_…` stays `toolu_…`.
fn fresh(recorded: &str) -> String {
    let (prefix, rest) = match recorded.split_once('_') {
        Some((prefix, rest)) if !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_lowercase()) => (format!("{prefix}_"), rest),
        _ => (String::new(), recorded),
    };
    let mut random = vec![0u8; rest.len()];
    getrandom::fill(&mut random).expect("the operating system has a secure random source");
    let drawn: String = rest
        .chars()
        .zip(random)
        .map(|(c, r)| {
            let pick = |set: &[u8]| set[r as usize % set.len()] as char;
            match c {
                '0'..='9' | 'a'..='f' if rest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-') => pick(b"0123456789abcdef"),
                '0'..='9' => pick(b"0123456789"),
                'a'..='z' => pick(b"abcdefghijklmnopqrstuvwxyz"),
                'A'..='Z' => pick(b"ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
                other => other,
            }
        })
        .collect();
    format!("{prefix}{drawn}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plays `recording` with no driver line, as a driver that closed stdin at once.
    fn alone(recording: Vec<Recorded>, stdout: &mut Vec<u8>, stderr: &mut Vec<u8>) -> Result<End, String> {
        let (_, input) = std::sync::mpsc::channel();
        Replay::new(recording).play(&input, &AtomicUsize::new(0), stdout, stderr)
    }

    #[test]
    fn a_fresh_id_keeps_its_shape_and_is_new() {
        let uuid = "3fea6374-c3ed-4254-8d20-6333b6edce26";
        let new = fresh(uuid);
        assert_ne!(new, uuid);
        assert!(new.len() == uuid.len() && new.chars().zip(uuid.chars()).all(|(a, b)| (a == '-') == (b == '-')), "a UUID stays a UUID");
        assert!(new.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-'));
        let tool = fresh("toolu_01KX85KeVuBaHQoR3pzBhj2M");
        assert!(tool.starts_with("toolu_") && tool.len() == "toolu_01KX85KeVuBaHQoR3pzBhj2M".len() && tool != "toolu_01KX85KeVuBaHQoR3pzBhj2M");
    }

    /// A stdout that notes, at each write, how many lines the replay had counted as written.
    struct Seeing<'a> {
        written: &'a AtomicUsize,
        seen: Vec<usize>,
    }

    impl Write for Seeing<'_> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if buf.ends_with(b"\n") {
                self.seen.push(self.written.load(Ordering::SeqCst));
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn an_agent_line_is_counted_before_it_reaches_the_driver() {
        // So an answer to it, however fast, is never stamped early.
        let line = |seq: u64| Recorded { seq, ms: 0, dir: "from_agent".into(), data: json!({"type": "system", "subtype": "status"}) };
        let (_, input) = std::sync::mpsc::channel();
        let written = AtomicUsize::new(0);
        let mut stdout = Seeing { written: &written, seen: vec![] };
        Replay::new(vec![line(1), line(2), line(3)]).play(&input, &written, &mut stdout, &mut vec![]).unwrap();
        assert_eq!(stdout.seen, [1, 2, 3]);
    }

    #[test]
    fn a_line_is_judged_by_when_it_arrived_not_by_when_the_replay_looks() {
        let (lines, input) = std::sync::mpsc::channel();
        let prompt = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
        let (now, line) = (Instant::now(), |text: &str, at: Instant| Ok(Arrived { text: text.into(), stamp: 0, at }));
        let earlier = now.checked_sub(Duration::from_millis(5)).unwrap_or(now);
        for text in ["", "", prompt] {
            lines.send(line(text, earlier)).unwrap();
        }
        let mut replay = Replay::new(vec![]);
        replay.deadline = Duration::ZERO;
        let got = replay.next(&input, &mut vec![], "line 5", Some("line 5: the driver never sent user"));
        assert!(matches!(got, Ok(Some(_))), "queued before its deadline, it is taken although the replay looks after it");
        lines.send(line(prompt, now + Duration::from_secs(60))).unwrap();
        let got = replay.next(&input, &mut vec![], "line 9", Some("line 9: the driver never sent user"));
        assert_eq!(got.err().as_deref(), Some("line 9: the driver never sent user within 0 ms"), "one that arrived after it is not");
    }

    #[test]
    fn recorded_stderr_cannot_read_as_the_stay_line() {
        let recording = vec![Recorded { seq: 1, ms: 0, dir: "stderr".into(), data: Value::from(format!("{STAYING}\nmore")) }];
        let mut stderr = vec![];
        alone(recording, &mut vec![], &mut stderr).unwrap();
        let said = String::from_utf8(stderr).unwrap();
        assert!(!said.lines().any(|line| line == STAYING), "{said:?}");
    }

    #[test]
    fn a_report_names_the_kind_and_never_the_payload() {
        assert_eq!(what(&json!({"type": "control_request", "request": {"subtype": "interrupt"}})), "control_request interrupt");
        assert_eq!(what(&json!({"type": "user", "message": {"content": "a secret prompt"}})), "user");
        assert_eq!(what(&json!({"type": "a secret in the type"})), "a line of an unknown type");
        assert_eq!(what(&json!({"type": "control_request", "request": {"subtype": "a secret"}})), "control_request of an unknown subtype");
        assert_eq!(what(&json!({"type": "control_request", "request": {"subtype": 7}})), "control_request of an unknown subtype");
    }

    #[test]
    fn short_recorded_ids_never_share_a_live_one() {
        let mut ids = Ids::default();
        let mut line = json!({"request_id": "1", "other": {"request_id": "2"}, "more": [{"id": "3"}, {"id": "4"}, {"id": "5"}, {"id": "6"}, {"id": "7"}, {"id": "8"}, {"id": "9"}, {"id": "0"}, {"id": "x"}]});
        ids.agent(&mut line);
        let live: Vec<&String> = ids.to.values().collect();
        let mut unique = live.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), live.len(), "every recorded id has a live id of its own");
        assert!(ids.to.iter().all(|(recorded, live)| recorded != live), "and none is its recorded one");
        assert!(ids.bind(&json!("spike-1"), &json!(ids.to["1"].clone())).is_err(), "a driver id that is already live is refused");
    }

    #[test]
    fn an_app_server_answer_carries_the_drivers_own_id_a_number_or_a_string() {
        for (recorded, live) in [(json!(1), json!(7)), (json!("req-a"), json!("mine-1"))] {
            let line = |seq: u64, dir: &str, data: Value| Recorded { seq, ms: 0, dir: dir.into(), data };
            let recording = vec![
                line(1, "to_agent", json!({"id": recorded, "method": "initialize", "params": {}})),
                line(2, "from_agent", json!({"id": recorded, "result": {"userAgent": "x/0.171.0 (y)"}})),
            ];
            let (lines, input) = std::sync::mpsc::channel();
            let sent = json!({"id": live, "method": "initialize", "params": {"clientInfo": {"name": "any"}}}).to_string();
            lines.send(Ok(Arrived { text: sent, stamp: 0, at: Instant::now() })).unwrap();
            drop(lines);
            let mut out = vec![];
            Replay::new(recording).play(&input, &AtomicUsize::new(0), &mut out, &mut vec![]).unwrap();
            let played: Value = serde_json::from_str(String::from_utf8(out).unwrap().lines().next().unwrap()).unwrap();
            assert_eq!(played["id"], live, "the recorded answer to {recorded} goes back as the answer to the driver's {live}");
        }
    }

    #[test]
    fn an_agents_request_with_a_skipped_config_id_is_still_played() {
        let line = |seq: u64, dir: &str, data: Value| Recorded { seq, ms: 0, dir: dir.into(), data };
        let recording = vec![
            line(1, "to_agent", json!({"type": "control_request", "request_id": "same", "request": {"subtype": "mcp_set_servers", "servers": {}}})),
            line(2, "from_agent", json!({"type": "control_response", "response": {"subtype": "success", "request_id": "same", "response": {}}})),
            line(3, "from_agent", json!({"type": "control_request", "request_id": "same", "request": {"subtype": "can_use_tool"}})),
        ];
        let mut out = vec![];
        let end = alone(recording, &mut out, &mut vec![]).unwrap();
        let played = String::from_utf8(out).unwrap();
        assert_eq!(played.lines().count(), 1, "the answer to the config request is not played; the agent's request is");
        assert!(played.contains("can_use_tool"));
        assert_eq!(end, End::Stay, "a recording that never closes stdin stays");
    }
}
