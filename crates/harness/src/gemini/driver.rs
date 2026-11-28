//! The Gemini driver: the person's own `agy acp`, the vendor's program speaking ACP on stdio, one process per session.
//! Gemini has one login and no login folder (H0, row 7). The tools endpoint goes in `session/new` and `session/load`
//! `mcpServers` under its per-session name, with its token in `headers` only, so it travels on stdin and is in no argv
//! and no environment. agy keeps that header in its own conversation database (H0, row 5); the token stops working when
//! the session ends or is resumed, as every session's does.
//!
//! agy asks before each tool call, the endpoint's own among them. The driver answers `allow_once` by itself only when a
//! request names exactly `mcp_<name>_<tool>` for one of the endpoint's tools; every other request goes to the client. A
//! deny ends agy's turn with no reply (H0, row 2), so that turn ends `denied`. agy reports a flat-name clash between
//! two servers as text and `end_turn` (H0, R1); that turn fails.
//!
//! agy may end a turn while a command it started runs, then report the command and write a message by itself, with no
//! prompt (H0, `r7-background`). The driver notes agy's descendants while it runs: while one runs with no prompted turn,
//! the session is busy after its turn ended (`background`). A message agy starts by itself opens a turn of its own, which
//! has no end marker: it ends once agy has said nothing for `QUIET`, no descendant runs, and no tool call of it is open
//! short of agy's own cut and a margin. Each turn's text is masked on its own, so a secret the pause splits shows its
//! tail unmasked, as in H2's replay; only the secrets the harness knows are masked wherever they fall. The session sends
//! a prompt only once such a turn has ended, so the session never has two turns open. agy, if still in its message,
//! finishes it and then answers (H0, `r8-prompt-during-unprompted`): what it says after the prompt goes in the prompted
//! turn, which ends with that prompt's `end_turn`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;

use crate::binary::CliPlaces;
use crate::claude::driver::{LINE_MAX, Lines, write};
use crate::driver::{AgentEnd, Capabilities, Command, Driver, EndReport, Launch, Link, OpenError, guard};
use crate::env::RunEnv;
use crate::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use crate::process::{self, Process};
use crate::provider::Provider;

/// agy cuts an MCP call at 180 s, and no field or flag sets it (H0, `5-hold-default`). `ask` returns before this.
pub const TOOL_CALL_LIMIT_MS: u64 = 180_000;

/// How long past agy's cut an open MCP call still holds a turn agy started by itself.
pub const CUT_MARGIN: Duration = Duration::from_secs(10);

/// How long agy must say nothing before a turn it started by itself can end. H0's recordings pause up to 6.6 s between
/// messages while agy thinks; the inferred end is a boundary, not a promise.
pub const QUIET: Duration = Duration::from_secs(15);

/// The text agy sends, with `end_turn`, when two servers' tools flatten to one name (H0, R1).
pub const CONFLICT: &str = "failed to construct executor: tool name conflict";

/// How long a stopped agent has before its process group gets SIGTERM.
pub const TERM_AFTER: Duration = Duration::from_secs(3);

/// How long the session waits for a stopped agent before it says kill. `agy acp` took 15.7 s to exit while a command
/// ran (H0, row 3), so a stop does not wait for that.
pub const STOP_TAKES_UP_TO: Duration = Duration::from_secs(10);

/// How long agy has to answer `initialize`, the session and its options before the session fails.
pub const SETUP_WITHIN: Duration = Duration::from_secs(60);

/// How often the driver notes agy's process tree, which also tells when a command it left running has ended.
const TREE_EVERY: Duration = Duration::from_secs(1);

const STDERR_KEPT: usize = 500;

/// The waits the driver keeps; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub term_after: Duration,
    pub stop_takes_up_to: Duration,
    pub setup_within: Duration,
    pub quiet: Duration,
    /// How long an open MCP call holds an unprompted turn: agy's cut and the margin.
    pub cut: Duration,
    pub tree_every: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        let cut = Duration::from_millis(TOOL_CALL_LIMIT_MS) + CUT_MARGIN;
        Timing { term_after: TERM_AFTER, stop_takes_up_to: STOP_TAKES_UP_TO, setup_within: SETUP_WITHIN, quiet: QUIET, cut, tree_every: TREE_EVERY }
    }
}

pub struct GeminiDriver {
    binary: Binary,
    timing: Timing,
}

enum Binary { At(PathBuf), Found(CliPlaces) }

impl GeminiDriver {
    pub fn new(binary: PathBuf) -> GeminiDriver {
        GeminiDriver { binary: Binary::At(binary), timing: Timing::default() }
    }

    /// A driver that finds `agy` when a session opens, as `providers` looks for it.
    pub fn found(places: CliPlaces) -> GeminiDriver {
        GeminiDriver { binary: Binary::Found(places), timing: Timing::default() }
    }

    pub fn with_timing(self, timing: Timing) -> GeminiDriver {
        GeminiDriver { timing, ..self }
    }

    fn binary(&self, launch: &Launch) -> Result<PathBuf, OpenError> {
        match &self.binary {
            Binary::At(binary) => Ok(binary.clone()),
            Binary::Found(places) => places
                .find(Provider::Gemini, &RunEnv::from_pairs(launch.env.iter().cloned()))
                .ok_or_else(|| OpenError { kind: FailKind::Provider, message: "agy was not found".into() }),
        }
    }

    fn start(&self, launch: Launch, end: Option<EndReport>) -> Result<Link, OpenError> {
        if launch.locked {
            // agy keeps its built-in tools whatever it is given (H0, row 11), so it cannot run Pip's lockdown.
            return Err(OpenError { kind: FailKind::Provider, message: "Gemini cannot run a locked session: no setting removes its own tools".into() });
        }
        let binary = self.binary(&launch)?;
        let mut command = tokio::process::Command::new(&binary);
        command.arg("acp").env_clear().envs(launch.env.iter().map(|(k, v)| (k, v))).current_dir(&launch.cwd);
        command.process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| OpenError { kind: FailKind::Provider, message: format!("agy could not be started: {e}") })?;
        let pid = child.id().expect("a child that was just spawned has a pid");
        let Some(started) = process::started_of(pid) else {
            let _ = child.start_kill();
            return Err(OpenError { kind: FailKind::Provider, message: "agy started, but its start time could not be read, so it could not be stopped safely".into() });
        };
        let process = Process { pid, started };
        let (stdin, stdout, stderr) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output, output_rx) = mpsc::unbounded_channel();
        let (lines, lines_rx) = mpsc::unbounded_channel();
        tokio::spawn(write(stdin, lines_rx));
        let last_said = Arc::new(Mutex::new(None::<String>));
        let keeping = last_said.clone();
        let secrets = [launch.tools_token.expose().to_owned()];
        let stderr = tokio::spawn(async move {
            let mut stderr = Lines::new(BufReader::new(stderr));
            while let Ok(Some((line, _))) = stderr.next(LINE_MAX).await {
                if !line.trim().is_empty() {
                    let masked = crate::redact::text(&line, &secrets).chars().take(STDERR_KEPT).collect();
                    *keeping.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(masked);
                }
            }
        });
        let acp = Acp::new(lines, output, &launch, self.timing);
        let (noted, tree) = tokio::sync::watch::channel(vec![]);
        let agent = Agent { child: Some(child), process: process.clone(), acp, timing: self.timing, stderr: (stderr, last_said), end, sent: vec![], tree: vec![], noted };
        tokio::spawn(agent.run(BufReader::new(stdout), commands_rx));
        Ok(Link { commands, output: output_rx, process: Some(process), tree: Some(tree) })
    }
}

impl Driver for GeminiDriver {
    fn capabilities(&self) -> Capabilities {
        let stop_takes_up_to_ms = Some(self.timing.stop_takes_up_to.as_millis() as u64);
        Capabilities { deny_ends_turn: true, tool_call_limit_ms: Some(TOOL_CALL_LIMIT_MS), stop_kills_process_tree: true, runs_locked_profile: false, starts_turns_unprompted: true, stop_takes_up_to_ms }
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        self.start(launch, None)
    }

    fn open_reporting(&self, launch: Launch, end: EndReport) -> Result<Link, OpenError> {
        self.start(launch, Some(end))
    }
}

/// A model or an effort only when the person chose one other than the default (AGENTS.md rule 4).
fn chosen(value: &Option<String>) -> Option<String> {
    value.clone().filter(|value| value != crate::provider::DEFAULT_MODEL)
}

/// `session/new`, or `session/load` of the session's own id: its folder and the endpoint, its token in `headers`.
pub fn session_request(launch: &Launch) -> (&'static str, Value) {
    let header = json!({"name": "Authorization", "value": format!("Bearer {}", launch.tools_token.expose())});
    let server = json!({"type": "http", "name": launch.tools.name, "url": launch.tools.url, "headers": [header]});
    let mut params = json!({"cwd": launch.cwd, "mcpServers": [server]});
    match &launch.resume {
        Some(session) => {
            params["sessionId"] = Value::from(session.as_str());
            ("session/load", params)
        }
        None => ("session/new", params),
    }
}

struct Agent {
    child: Option<Child>,
    process: Process,
    acp: Acp,
    timing: Timing,
    stderr: (tokio::task::JoinHandle<()>, Arc<Mutex<Option<String>>>),
    end: Option<EndReport>,
    sent: Vec<libc::c_int>,
    /// What agy has started, noted while it runs, so what outlives it can be stopped.
    tree: Vec<Process>,
    noted: tokio::sync::watch::Sender<Vec<Process>>,
}

impl Agent {
    async fn run(mut self, stdout: BufReader<tokio::process::ChildStdout>, mut commands: UnboundedReceiver<Command>) {
        let at = |after: Duration| Some(Instant::now() + after);
        let mut stdout = Lines::new(stdout);
        let mut child = self.child.take().expect("run once");
        let (mut term_at, mut kill_at, mut setup_until) = (None, None, at(self.timing.setup_within));
        let (mut going, mut listening) = (false, true);
        let mut exited = None;
        let mut tree_every = tokio::time::interval(self.timing.tree_every);
        let until = |when: Option<Instant>| async move {
            match when {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        loop {
            if self.acp.ready {
                setup_until = None;
            }
            tokio::select! {
                biased;
                line = stdout.next(LINE_MAX) => match line {
                    Ok(Some((_, true))) => self.acp.emit(Body::Notice { text: format!("agy wrote a line over {} MiB, which was skipped.", LINE_MAX >> 20) }),
                    Ok(Some((line, false))) => {
                        self.acp.read(&line);
                        if std::mem::take(&mut self.acp.look) {
                            let running = self.note_tree();
                            self.acp.tick(running);
                        }
                        if self.acp.broken && !going {
                            going = true;
                            self.kill();
                        }
                    }
                    Ok(None) | Err(_) => break,
                },
                status = child.wait() => {
                    exited = status.ok();
                    break;
                }
                command = commands.recv(), if listening => match command {
                    Some(Command::Prompt(text)) => self.acp.prompt(text),
                    Some(Command::Answer { id, decision, .. }) => self.acp.answer(&id, decision),
                    Some(Command::Cancel) => self.acp.cancel(),
                    // agy's own permission settings decide; Gossamr's choice is Claude's alone.
                    Some(Command::SetPermissions(_)) => {}
                    Some(Command::Stop) => {
                        going = true;
                        self.go();
                        term_at = term_at.or(at(self.timing.term_after));
                    }
                    None => {
                        (going, listening) = (true, false);
                        self.go();
                        term_at = term_at.or(at(self.timing.term_after));
                        kill_at = at(self.timing.stop_takes_up_to);
                    }
                    Some(Command::Kill) => {
                        going = true;
                        self.kill();
                    }
                },
                () = until(term_at) => {
                    term_at = None;
                    self.sent.push(libc::SIGTERM);
                    let _ = process::signal_group(&self.process, libc::SIGTERM);
                    for left in &self.tree {
                        let _ = process::signal(left, libc::SIGTERM);
                    }
                }
                () = until(kill_at) => {
                    kill_at = None;
                    self.kill();
                }
                _ = tree_every.tick() => {
                    let running = self.note_tree();
                    if !going {
                        self.acp.tick(running);
                    }
                }
                () = until(setup_until) => {
                    setup_until = None;
                    going = true;
                    self.acp.fail(FailKind::Provider, format!("agy did not start its session within {} s", self.timing.setup_within.as_secs_f32()));
                    self.kill();
                }
            }
        }
        self.note_tree();
        if process::alive(&self.process) {
            self.sent.push(libc::SIGKILL);
        }
        let _ = process::kill_group(&self.process);
        self.kill_tree();
        let status = match exited {
            Some(status) => Some(status),
            None => child.wait().await.ok(),
        };
        let ended = status.and_then(|status| match (status.code(), status.signal()) {
            (Some(code), _) => Some(AgentEnd::Exited(code)),
            (None, Some(signal)) => Some(AgentEnd::Signalled { signal, sent: self.sent.contains(&signal) }),
            (None, None) => None,
        });
        if !going {
            let _ = tokio::time::timeout(Duration::from_secs(1), &mut self.stderr.0).await;
            let said = self.stderr.1.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
            let mut how = if self.acp.turn.is_some() { "agy exited in the middle of a turn" } else { "agy exited" }.to_owned();
            if let Some(AgentEnd::Signalled { signal, sent: false }) = ended {
                how.push_str(&format!(", ended by signal {signal}"));
            }
            let cut = self.acp.turn.is_some() && matches!(ended, Some(AgentEnd::Signalled { signal: libc::SIGTERM | libc::SIGHUP | libc::SIGINT, sent: false }));
            let reason = match said {
                Some(said) => format!("{how}: {said}"),
                None => how,
            };
            self.acp.fail(if cut { FailKind::AgentStopped } else { FailKind::Provider }, reason);
        }
        if let (Some(end), Some(ended)) = (self.end.take(), ended) {
            end.send(ended);
        }
    }

    /// Notes the process tree while agy still leads it, then closes stdin, which is how it is told to go.
    fn go(&mut self) {
        self.note_tree();
        self.acp.lines = None;
    }

    /// Notes what agy has started, and says whether any of it runs now.
    fn note_tree(&mut self) -> bool {
        self.tree.retain(|left| !process::nothing_has(left.pid) && process::started_of(left.pid).is_none_or(|started| started == left.started));
        let now = process::descendants(&self.process);
        for found in &now {
            if !self.tree.contains(found) {
                self.tree.push(found.clone());
            }
        }
        self.noted.send_if_modified(|noted| {
            let changed = *noted != self.tree;
            noted.clone_from(&self.tree);
            changed
        });
        !now.is_empty()
    }

    fn kill(&mut self) {
        self.note_tree();
        self.sent.push(libc::SIGKILL);
        let _ = process::kill_group(&self.process);
        self.kill_tree();
    }

    fn kill_tree(&self) {
        for left in &self.tree {
            let _ = process::signal(left, libc::SIGKILL);
            process::kill_led_group(left);
        }
    }
}

/// The running turn. A prompted one has the id of its `session/prompt`, whose answer ends it.
#[derive(Default)]
struct Turn {
    request: Option<u64>,
    cancelled: bool,
    denied: bool,
    conflict: bool,
    /// Tool calls with no `completed` or `failed` update that are not commands, and when each began: an MCP call held
    /// on the session's own endpoint among them. A command counts through agy's descendants instead.
    open_calls: HashMap<String, Instant>,
}

#[derive(Clone, Copy, PartialEq)]
enum Asked {
    Initialize,
    Session,
    Option,
    Prompt,
}

/// The ACP conversation with agy, apart from the process.
struct Acp {
    lines: Option<UnboundedSender<String>>,
    output: UnboundedSender<Body>,
    timing: Timing,
    next: u64,
    asked: HashMap<u64, Asked>,
    session_request: Option<(&'static str, Value)>,
    /// The config options to set once the session is up: a chosen model and effort.
    options: Vec<(&'static str, String)>,
    options_left: usize,
    session: Option<String>,
    /// The session's own id, when this start loads it.
    resumed: Option<String>,
    /// The session is up and its options are set, so a prompt can go.
    ready: bool,
    /// `session/load` is not answered yet: the updates before its answer replay the session's history.
    loading: bool,
    allowed: Vec<String>,
    /// The guard, until the first prompt of this start takes it.
    guard: Option<String>,
    turn: Option<Turn>,
    held: VecDeque<String>,
    text: String,
    /// Tool calls with no result yet, of any turn: a command can finish in a later one.
    calls: HashSet<String>,
    /// agy's open permission requests, by their id, with the options each offered.
    permissions: HashMap<String, Value>,
    /// The session said it is busy after its turn ended, and has not said it stopped being.
    busy: bool,
    heard: Instant,
    /// A line changed what runs, so the process tree should be looked at now.
    look: bool,
    broken: bool,
}

impl Acp {
    fn new(lines: UnboundedSender<String>, output: UnboundedSender<Body>, launch: &Launch, timing: Timing) -> Acp {
        if let Some(session) = &launch.resume {
            let _ = output.send(Body::Started { provider_session: session.clone(), resumed: true });
        }
        let options: Vec<(&'static str, String)> = [("model", chosen(&launch.model)), ("thought_level", chosen(&launch.effort))].into_iter().filter_map(|(id, value)| Some((id, value?))).collect();
        let mut acp = Acp {
            lines: Some(lines),
            output,
            timing,
            next: 0,
            asked: HashMap::new(),
            session_request: Some(session_request(launch)),
            options_left: options.len(),
            options,
            session: None,
            resumed: launch.resume.clone(),
            ready: false,
            loading: false,
            allowed: launch.tools.allowed.clone(),
            guard: Some(guard(&launch.tools.tools)),
            turn: None,
            held: VecDeque::new(),
            text: String::new(),
            calls: HashSet::new(),
            permissions: HashMap::new(),
            busy: false,
            heard: Instant::now(),
            look: false,
            broken: false,
        };
        let capabilities = json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false});
        let client = json!({"name": "gossamr", "title": "Gossamr", "version": env!("CARGO_PKG_VERSION")});
        acp.request(Asked::Initialize, "initialize", json!({"protocolVersion": 1, "clientCapabilities": capabilities, "clientInfo": client}));
        acp
    }

    fn send(&mut self, mut line: Value) {
        line["jsonrpc"] = Value::from("2.0");
        if let Some(lines) = &self.lines {
            let _ = lines.send(line.to_string());
        }
    }

    fn request(&mut self, asked: Asked, method: &str, params: Value) -> u64 {
        self.next += 1;
        self.asked.insert(self.next, asked);
        self.send(json!({"id": self.next, "method": method, "params": params}));
        self.next
    }

    fn emit(&self, body: Body) {
        let _ = self.output.send(body);
    }

    fn fail(&mut self, kind: FailKind, reason: String) {
        self.turn = None;
        self.held.clear();
        self.text.clear();
        self.emit(Body::Failed { kind, reason });
    }

    fn setup_failed(&mut self, kind: FailKind, reason: String) {
        self.fail(kind, reason);
        self.broken = true;
    }

    fn flush(&mut self) {
        if self.text.trim().is_empty() {
            self.text.clear();
            return;
        }
        let text = std::mem::take(&mut self.text);
        self.unprompted_turn();
        if let Some(turn) = &mut self.turn {
            turn.conflict |= text.contains(CONFLICT);
        }
        self.emit(Body::Text { text });
    }

    /// What agy says with no turn running opens a turn of its own.
    fn unprompted_turn(&mut self) {
        if self.turn.is_none() {
            self.emit(Body::TurnStarted);
            self.turn = Some(Turn::default());
        }
    }

    fn end(&mut self, body: Body) {
        self.flush();
        self.turn = None;
        self.look = true;
        self.emit(body);
        self.next_prompt();
    }

    fn next_prompt(&mut self) {
        if let Some(text) = self.held.pop_front() {
            self.prompt(text);
        }
    }

    fn prompt(&mut self, text: String) {
        let Some(session) = self.session.clone().filter(|_| self.ready && self.turn.is_none()) else {
            self.held.push_back(text);
            return;
        };
        let mut blocks = vec![];
        if let Some(guard) = self.guard.take() {
            blocks.push(json!({"type": "text", "text": guard, "_meta": {"gossamr": "guard"}}));
        }
        blocks.push(json!({"type": "text", "text": text}));
        self.emit(Body::TurnStarted);
        let id = self.request(Asked::Prompt, "session/prompt", json!({"sessionId": session, "prompt": blocks}));
        self.turn = Some(Turn { request: Some(id), ..Turn::default() });
    }

    fn cancel(&mut self) {
        if self.turn.is_none() {
            if self.held.pop_front().is_some() {
                // A prompt that waits never reaches agy: its turn ends cancelled, as a sent one's would.
                self.emit(Body::TurnStarted);
                self.emit(Body::TurnEnded { how: TurnEnd::Cancelled });
            }
            return;
        }
        let Some(turn) = self.turn.as_mut().filter(|turn| !turn.cancelled) else { return };
        turn.cancelled = true;
        let prompted = turn.request.is_some();
        if let Some(session) = self.session.clone() {
            self.send(json!({"method": "session/cancel", "params": {"sessionId": session}}));
        }
        // ACP: a client that cancels answers each open permission request `cancelled`.
        for (id, _) in std::mem::take(&mut self.permissions) {
            self.send(json!({"id": id, "result": {"outcome": {"outcome": "cancelled"}}}));
            self.emit(Body::PermissionClosed { id });
        }
        if !prompted {
            self.end(Body::TurnEnded { how: TurnEnd::Cancelled });
        }
    }

    fn answer(&mut self, id: &str, decision: Decision) {
        let Some(options) = self.permissions.remove(id) else { return };
        let kind = if decision == Decision::Allow { "allow_once" } else { "reject_once" };
        let option = options.as_array().into_iter().flatten().find(|option| option["kind"] == kind).and_then(|option| option["optionId"].as_str());
        let outcome = option.map_or_else(|| json!({"outcome": "cancelled"}), |option| json!({"outcome": "selected", "optionId": option}));
        let key: Value = serde_json::from_str(id).unwrap_or_else(|_| Value::from(id));
        self.send(json!({"id": key, "result": {"outcome": outcome}}));
        if let Some(turn) = self.turn.as_mut().filter(|_| decision == Decision::Deny) {
            turn.denied = true;
        }
    }

    fn read(&mut self, line: &str) {
        let Ok(line) = serde_json::from_str::<Value>(line) else { return };
        self.heard = Instant::now();
        match (line["method"].as_str(), line.get("id")) {
            (Some(method), Some(id)) => self.asks(method, id.clone(), &line["params"]),
            (Some("session/update"), None) if !self.loading => self.updated(&line["params"]["update"]),
            (Some(_), None) => {}
            (None, Some(id)) => {
                let (request, asked) = (id.as_u64(), id.as_u64().and_then(|id| self.asked.remove(&id)));
                self.answered(request, asked, &line);
            }
            (None, None) => {}
        }
    }

    fn asks(&mut self, method: &str, id: Value, params: &Value) {
        if method != "session/request_permission" {
            return self.send(json!({"id": id, "error": {"code": -32601, "message": "not supported by this client"}}));
        }
        let call = &params["toolCall"];
        let options = params["options"].clone();
        let key = id.to_string();
        if call["name"].as_str().is_some_and(|name| self.allowed.iter().any(|own| own == name)) {
            // A call to the session's own endpoint, by its exact full name: allowed without asking the person.
            self.permissions.insert(key.clone(), options);
            return self.answer(&key, Decision::Allow);
        }
        self.flush();
        self.unprompted_turn();
        let kind = match call["kind"].as_str() {
            Some("execute") => PermissionKind::Command,
            Some("edit" | "delete" | "move") => PermissionKind::FileChange,
            _ => PermissionKind::Tool,
        };
        self.permissions.insert(key.clone(), options);
        self.emit(Body::Permission { id: key, kind, tool: tool_name(call), input: tool_input(call) });
    }

    fn updated(&mut self, update: &Value) {
        match update["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                self.unprompted_turn();
                self.text.push_str(update["content"]["text"].as_str().unwrap_or_default());
            }
            Some("tool_call") => {
                self.flush();
                self.unprompted_turn();
                let id = field(update, "toolCallId", "tool_call_id").as_str().unwrap_or_default().to_owned();
                self.emit(Body::ToolCall { id: id.clone(), name: tool_name(update), input: tool_input(update) });
                self.calls.insert(id.clone());
                if let Some(turn) = self.turn.as_mut().filter(|_| update["kind"] != "execute") {
                    turn.open_calls.insert(id, Instant::now());
                }
                self.look = true;
                self.finished(update);
            }
            Some("tool_call_update") => self.finished(update),
            // agy sends one per message or step: it closes a message, never a turn.
            Some("usage_update") => self.flush(),
            _ => {}
        }
    }

    /// A tool call's `completed` or `failed` update gives its result, once.
    fn finished(&mut self, update: &Value) {
        let Some(status @ ("completed" | "failed")) = update["status"].as_str() else { return };
        let id = field(update, "toolCallId", "tool_call_id").as_str().unwrap_or_default().to_owned();
        if let Some(turn) = &mut self.turn {
            turn.open_calls.remove(&id);
        }
        if !self.calls.remove(&id) {
            return;
        }
        self.flush();
        let output = [field(update, "rawOutput", "raw_output"), &update["content"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or_default();
        self.emit(Body::ToolResult { id, output, error: status == "failed" });
        self.look = true;
    }

    fn answered(&mut self, request: Option<u64>, asked: Option<Asked>, line: &Value) {
        let error = line.get("error").map(|error| error["message"].as_str().unwrap_or("agy refused the request").to_owned());
        let result = &line["result"];
        match (asked, error) {
            (Some(Asked::Initialize), None) => {
                let loads = result["agentCapabilities"]["loadSession"] == true || result["agentCapabilities"]["load_session"] == true;
                if self.resumed.is_some() && !loads {
                    return self.setup_failed(FailKind::VersionNotSupported, "this agy version cannot load a session, so it cannot be resumed".into());
                }
                if let Some((method, params)) = self.session_request.take() {
                    self.loading = method == "session/load";
                    self.request(Asked::Session, method, params);
                }
            }
            (Some(Asked::Session), None) => {
                self.loading = false;
                // A loaded session's history is not this start's: what it said there is dropped.
                self.text.clear();
                let session = match (result["sessionId"].as_str(), &self.resumed) {
                    (_, Some(loaded)) => loaded.clone(),
                    (Some(session), None) => session.to_owned(),
                    (None, None) => return self.setup_failed(FailKind::Provider, "agy started a session with no id".into()),
                };
                if self.resumed.is_none() {
                    self.emit(Body::Started { provider_session: session.clone(), resumed: false });
                }
                self.session = Some(session.clone());
                for (option, value) in std::mem::take(&mut self.options) {
                    self.request(Asked::Option, "session/set_config_option", json!({"sessionId": session, "configId": option, "value": value}));
                }
                self.options_done();
            }
            (Some(Asked::Option), None) => {
                self.options_left -= 1;
                self.options_done();
            }
            (Some(Asked::Prompt), error) if self.turn.as_ref().is_some_and(|turn| turn.request == request) => {
                self.flush();
                let turn = self.turn.as_ref().expect("checked");
                if let Some(used) = usage(&result["usage"]) {
                    self.emit(used);
                }
                let body = match (error, result["stopReason"].as_str()) {
                    (Some(error), _) => Body::Failed { kind: FailKind::Provider, reason: error },
                    (None, Some("end_turn")) if turn.conflict => Body::Failed { kind: FailKind::Provider, reason: format!("agy could not start its tools: {CONFLICT}. Another MCP server's tool has the same flat name as one of the session's own.") },
                    (None, Some("end_turn")) if turn.denied => Body::TurnEnded { how: TurnEnd::Denied },
                    (None, Some("end_turn")) => Body::TurnEnded { how: TurnEnd::Done },
                    (None, Some("cancelled")) => Body::TurnEnded { how: TurnEnd::Cancelled },
                    (None, other) => Body::Failed { kind: FailKind::Provider, reason: format!("the turn stopped: {}", other.unwrap_or("with no reason")) },
                };
                self.permissions.clear();
                self.end(body);
            }
            (Some(Asked::Initialize | Asked::Session | Asked::Option), Some(error)) => self.setup_failed(FailKind::Provider, error),
            (Some(Asked::Prompt) | None, _) => {}
        }
    }

    fn options_done(&mut self) {
        if self.options_left == 0 && self.session.is_some() && !self.ready {
            self.ready = true;
            self.next_prompt();
        }
    }

    /// What the process tree says: whether a command agy started runs. While one runs with no prompted turn the session
    /// is busy after its turn ended; and a turn agy started by itself ends once it has been quiet with nothing open.
    fn tick(&mut self, running: bool) {
        let prompted = self.turn.as_ref().is_some_and(|turn| turn.request.is_some());
        if running != self.busy && (self.busy || !prompted) {
            self.busy = running;
            self.emit(Body::Background { running });
        }
        let now = Instant::now();
        let quiet = now.duration_since(self.heard) >= self.timing.quiet;
        let open = |turn: &Turn| turn.open_calls.values().any(|began| now.duration_since(*began) < self.timing.cut);
        if quiet && !running && self.turn.as_ref().is_some_and(|turn| turn.request.is_none() && !open(turn)) {
            self.end(Body::TurnEnded { how: TurnEnd::Done });
        }
    }
}

/// A field agy sends in camelCase, or its snake_case copy.
fn field<'a>(value: &'a Value, camel: &str, snake: &str) -> &'a Value {
    if value[camel].is_null() { &value[snake] } else { &value[camel] }
}

/// The tool's identifier: agy's own `name`. With none, a fixed word: ACP's title is often the command line, which goes
/// into the input instead.
fn tool_name(call: &Value) -> String {
    call["name"].as_str().unwrap_or("tool").to_owned()
}

fn tool_input(call: &Value) -> Value {
    let input = [field(call, "rawInput", "raw_input"), &call["args"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or_default();
    match (call["name"].is_null(), call["title"].as_str()) {
        (true, Some(title)) => match input {
            Value::Object(mut fields) => {
                fields.insert("title".into(), json!(title));
                Value::Object(fields)
            }
            other => json!({"title": title, "input": other}),
        },
        _ => input,
    }
}

/// A turn's usage from its `session/prompt` answer. agy's `usage_update` gives only the context used and its size, so
/// the tokens come from here; agy counts cached reads apart from input already.
fn usage(usage: &Value) -> Option<Body> {
    let count = |field: &str| usage[field].as_u64().unwrap_or(0);
    usage.is_object().then(|| Body::Usage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cache_read_tokens: count("cachedReadTokens"),
        cache_creation_tokens: count("cachedWriteTokens"),
        cost_usd: None,
    })
}
