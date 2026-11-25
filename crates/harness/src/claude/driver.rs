//! The Claude driver: the person's own `claude -p` over stream-json on stdio, with `initialize`, `interrupt` and
//! `can_use_tool` on its control channel (`docs/harness-findings.md`, "The driver per provider").
//!
//! Claude names its session only in `init`, after the first prompt, so a new session's `started` comes then. A turn
//! is counted by `result`: Claude may start one by itself after a background task ends, and lines that come after a
//! `result` (a task's notice) start no turn. Stop closes stdin; Claude stays while a background task runs, so after
//! `term_after` the driver ends the agent's process group.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::driver::{Capabilities, Command, Driver, GUARD, Launch, Link, OpenError};
use crate::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use crate::process::{self, Process};

/// The stream flags both profiles start with.
pub const STREAM: &[&str] =
    &["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];

/// Pip's lockdown, for a locked session: no built-in tool, no settings, skills or slash commands, and no MCP server but
/// the session's own. Ticket text is untrusted, so loosening one of these lets it reach files, a shell or the network.
pub const LOCKED: &[&str] = &["--permission-mode", "dontAsk", "--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config"];

/// How long a stopped agent has before its process group gets SIGTERM, while a background task keeps it.
pub const TERM_AFTER: Duration = Duration::from_secs(3);

/// How long the session waits for a stopped agent before it says kill.
pub const STOP_TAKES_UP_TO: Duration = Duration::from_secs(10);

pub struct ClaudeDriver {
    binary: PathBuf,
    term_after: Duration,
    stop_takes_up_to: Duration,
}

impl ClaudeDriver {
    pub fn new(binary: PathBuf) -> ClaudeDriver {
        ClaudeDriver { binary, term_after: TERM_AFTER, stop_takes_up_to: STOP_TAKES_UP_TO }
    }

    /// Shorter waits before SIGTERM and before the session says kill, for tests.
    pub fn with_graces(self, term_after: Duration, stop_takes_up_to: Duration) -> ClaudeDriver {
        ClaudeDriver { term_after, stop_takes_up_to, ..self }
    }
}

/// The argv for `launch`, after the program.
pub fn args(launch: &Launch) -> Vec<String> {
    let mut args: Vec<String> = STREAM.iter().map(|flag| (*flag).to_owned()).collect();
    if launch.locked {
        args.extend(LOCKED.iter().map(|flag| (*flag).to_owned()));
    }
    if let Some(model) = &launch.model {
        args.extend(["--model".to_owned(), model.clone()]);
    }
    if let Some(session) = &launch.resume {
        args.extend(["--resume".to_owned(), session.clone()]);
    }
    if !launch.locked {
        args.extend(["--append-system-prompt".to_owned(), GUARD.to_owned()]);
    }
    args
}

impl Driver for ClaudeDriver {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            deny_ends_turn: false,
            tool_call_limit_ms: Some(600_000),
            stop_kills_process_tree: true,
            runs_locked_profile: true,
            starts_turns_unprompted: true,
            stop_takes_up_to_ms: Some(self.stop_takes_up_to.as_millis() as u64),
        }
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let mut command = tokio::process::Command::new(&self.binary);
        command.args(args(&launch)).env_clear().envs(launch.env.iter().map(|(k, v)| (k, v))).current_dir(&launch.cwd);
        if launch.locked {
            // `--setting-sources` does not cover auto memory, which Claude would otherwise put in its prompt.
            command.env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
        }
        // Its own group, so a stop reaches the commands and background tasks it starts. Its stdin is the driver's own
        // pipe, never the harness's. A driver dropped without a stop, as when its runtime ends, still kills the agent.
        command.process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = command.spawn().map_err(|e| OpenError { kind: FailKind::Provider, message: format!("claude could not be started: {e}") })?;
        let pid = child.id().expect("a child that was just spawned has a pid");
        let started = process::started_of(pid).unwrap_or_default();
        let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (stdin, stdout, stderr) = (stdin.expect("piped"), stdout.expect("piped"), stderr.expect("piped"));
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output, output_rx) = mpsc::unbounded_channel();
        let (lines, lines_rx) = mpsc::unbounded_channel();
        tokio::spawn(write(stdin, lines_rx));
        // Read and dropped, so a CLI that writes much to stderr never blocks on it.
        tokio::spawn(async move {
            let mut stderr = BufReader::new(stderr).lines();
            while let Ok(Some(_)) = stderr.next_line().await {}
        });
        let stream = Stream::new(lines, output, launch.resume.as_deref());
        let agent = Agent { child, process: Process { pid, started }, stream, term_after: self.term_after };
        tokio::spawn(agent.run(BufReader::new(stdout), commands_rx));
        Ok(Link { commands, output: output_rx })
    }
}

/// Writes each line in order. Dropping the sender closes stdin, which is how Claude is told to go.
async fn write(mut stdin: ChildStdin, mut lines: UnboundedReceiver<String>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

struct Agent {
    child: Child,
    process: Process,
    stream: Stream,
    term_after: Duration,
}

/// What the agent and the client say to each other, apart from the process: lines in, events and lines out.
pub struct Stream {
    /// None once stdin is closed.
    lines: Option<UnboundedSender<String>>,
    output: UnboundedSender<Body>,
    /// `started` was sent: at open for a resume, else at the first `init`.
    started: bool,
    turn: bool,
    /// The running turn was interrupted, so its `result` ends it cancelled.
    cancelled: bool,
    /// Prompts sent while a turn Claude started by itself runs; each goes once that turn's `result` is in.
    held: VecDeque<String>,
    /// Open `can_use_tool` requests and the input each asked to run with.
    asked: HashMap<String, Value>,
    requests: u64,
}

impl Agent {
    async fn run(mut self, stdout: BufReader<tokio::process::ChildStdout>, mut commands: UnboundedReceiver<Command>) {
        self.stream.request(json!({"subtype": "initialize"}));
        let mut stdout = stdout.lines();
        let mut term_at: Option<tokio::time::Instant> = None;
        let mut listening = true;
        loop {
            let term = async {
                match term_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                line = stdout.next_line() => match line {
                    Ok(Some(line)) => self.stream.read(&line),
                    Ok(None) | Err(_) => break,
                },
                command = commands.recv(), if listening => match command {
                    Some(Command::Prompt(text)) => self.stream.prompt(text),
                    Some(Command::Answer { id, decision, message }) => self.stream.answer(&id, decision, message),
                    Some(Command::Cancel) => self.stream.cancel(),
                    Some(Command::Stop) | None => {
                        listening &= command.is_some();
                        self.stream.close();
                        term_at.get_or_insert(tokio::time::Instant::now() + self.term_after);
                    }
                    Some(Command::Kill) => self.kill(),
                },
                () = term => {
                    term_at = None;
                    // A background task keeps Claude after stdin closes; the group goes with it.
                    let _ = process::signal_group(&self.process, libc::SIGTERM);
                }
            }
        }
        // Whatever of the group is left goes too. The child is not reaped yet, so its group id is still the agent's.
        self.kill();
        let _ = self.child.wait().await;
    }

    fn kill(&self) {
        let _ = process::kill_group(&self.process);
    }
}

impl Stream {
    /// A resume names its session at once; a new session names it in its first `init`.
    pub fn new(lines: UnboundedSender<String>, output: UnboundedSender<Body>, resume: Option<&str>) -> Stream {
        if let Some(session) = resume {
            let _ = output.send(Body::Started { provider_session: session.to_owned(), resumed: true });
        }
        let (turn, cancelled, held, asked, requests) = (false, false, VecDeque::new(), HashMap::new(), 0);
        Stream { lines: Some(lines), output, started: resume.is_some(), turn, cancelled, held, asked, requests }
    }

    /// Closes stdin, which is how Claude is told to go.
    pub fn close(&mut self) {
        self.lines = None;
    }

    fn send(&self, line: Value) {
        if let Some(lines) = &self.lines {
            let _ = lines.send(line.to_string());
        }
    }

    pub fn request(&mut self, request: Value) {
        self.requests += 1;
        self.send(json!({"type": "control_request", "request_id": format!("gossamr-{}", self.requests), "request": request}));
    }

    fn emit(&self, body: Body) {
        let _ = self.output.send(body);
    }

    /// Opens a turn the agent started by itself, so what it says has one to belong to.
    fn begin(&mut self) {
        if !self.turn {
            self.turn = true;
            self.emit(Body::TurnStarted);
        }
    }

    pub fn prompt(&mut self, text: String) {
        if self.turn {
            self.held.push_back(text);
            return;
        }
        self.begin();
        self.send(json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": null, "session_id": ""}));
    }

    pub fn answer(&mut self, id: &str, decision: Decision, message: Option<String>) {
        let Some(input) = self.asked.remove(id) else { return };
        let response = match decision {
            Decision::Allow => json!({"behavior": "allow", "updatedInput": input}),
            Decision::Deny => json!({"behavior": "deny", "message": message.unwrap_or_else(|| "The person denied this.".to_owned())}),
        };
        self.send(json!({"type": "control_response", "response": {"subtype": "success", "request_id": id, "response": response}}));
    }

    pub fn cancel(&mut self) {
        if self.turn && !self.cancelled {
            self.cancelled = true;
            self.request(json!({"subtype": "interrupt"}));
        }
    }

    pub fn read(&mut self, line: &str) {
        let Ok(line) = serde_json::from_str::<Value>(line) else { return };
        match line["type"].as_str() {
            Some("system") if line["subtype"] == "init" => {
                if !self.started
                    && let Some(session) = line["session_id"].as_str()
                {
                    self.started = true;
                    self.emit(Body::Started { provider_session: session.to_owned(), resumed: false });
                }
                self.begin();
            }
            Some("assistant") => {
                self.begin();
                for block in line["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => self.emit(Body::Text { text: block["text"].as_str().unwrap_or_default().to_owned() }),
                        Some("tool_use") => self.emit(Body::ToolCall {
                            id: block["id"].as_str().unwrap_or_default().to_owned(),
                            name: block["name"].as_str().unwrap_or("tool").to_owned(),
                            input: block["input"].clone(),
                        }),
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for block in line["message"]["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "tool_result") {
                    self.begin();
                    let id = block["tool_use_id"].as_str().unwrap_or_default().to_owned();
                    self.emit(Body::ToolResult { id, output: block["content"].clone(), error: block["is_error"] == true });
                }
            }
            Some("control_request") => self.asks(&line),
            Some("control_cancel_request") => {
                if let Some(id) = line["request_id"].as_str()
                    && self.asked.remove(id).is_some()
                {
                    self.emit(Body::PermissionClosed { id: id.to_owned() });
                }
            }
            Some("result") => self.ended(&line),
            _ => {}
        }
    }

    fn asks(&mut self, line: &Value) {
        let (id, request) = (line["request_id"].as_str().unwrap_or_default().to_owned(), &line["request"]);
        if request["subtype"] != "can_use_tool" {
            // Nothing else is asked of a client that set up no hooks or SDK servers; it is refused, never left waiting.
            let error = json!({"type": "control_response", "response": {"subtype": "error", "request_id": id, "error": "not supported by this client"}});
            self.send(error);
            return;
        }
        self.begin();
        let tool = request["tool_name"].as_str().unwrap_or("tool").to_owned();
        let kind = match tool.as_str() {
            "Bash" => PermissionKind::Command,
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => PermissionKind::FileChange,
            _ => PermissionKind::Tool,
        };
        self.asked.insert(id.clone(), request["input"].clone());
        self.emit(Body::Permission { id, kind, tool, input: request["input"].clone() });
    }

    fn ended(&mut self, result: &Value) {
        self.begin();
        let ok = result["subtype"] == "success" && result["is_error"] != true;
        let body = match (ok, self.cancelled) {
            (true, _) => Body::TurnEnded { how: TurnEnd::Done },
            (false, true) => Body::TurnEnded { how: TurnEnd::Cancelled },
            (false, false) => {
                let reason = result["result"].as_str().or(result["subtype"].as_str()).unwrap_or("the turn failed");
                Body::Failed { kind: FailKind::Provider, reason: reason.to_owned() }
            }
        };
        (self.turn, self.cancelled) = (false, false);
        self.asked.clear();
        self.emit(body);
        if let Some(text) = self.held.pop_front() {
            self.prompt(text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Wire {
        stream: Stream,
        lines: UnboundedReceiver<String>,
        output: UnboundedReceiver<Body>,
    }

    fn wire() -> Wire {
        let ((lines, lines_rx), (output, output_rx)) = (mpsc::unbounded_channel(), mpsc::unbounded_channel());
        Wire { stream: Stream::new(lines, output, None), lines: lines_rx, output: output_rx }
    }

    impl Wire {
        fn agent(&mut self, line: Value) {
            self.stream.read(&line.to_string());
        }

        fn sent(&mut self) -> Vec<Value> {
            std::iter::from_fn(|| self.lines.try_recv().ok()).map(|line| serde_json::from_str(&line).unwrap()).collect()
        }

        fn said(&mut self) -> Vec<Body> {
            std::iter::from_fn(|| self.output.try_recv().ok()).collect()
        }
    }

    fn result() -> Value {
        json!({"type": "result", "subtype": "success", "is_error": false, "result": "ok"})
    }

    fn init() -> Value {
        json!({"type": "system", "subtype": "init", "session_id": "s-1"})
    }

    #[test]
    fn a_prompt_sent_while_claude_runs_a_turn_of_its_own_goes_after_that_turns_result() {
        let mut w = wire();
        w.stream.prompt("one".into());
        w.agent(init());
        w.agent(result());
        // Claude starts a turn by itself, as after a background workflow ends.
        w.agent(init());
        w.sent();
        w.stream.prompt("two".into());
        assert_eq!(w.sent(), Vec::<Value>::new(), "held while that turn runs");
        w.agent(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "pong"}]}}));
        w.agent(result());
        let sent = w.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["message"]["content"][0]["text"], "two");
        let turns: Vec<String> = w.said().iter().map(Body::type_name).filter(|kind| kind.starts_with("turn_")).collect();
        assert_eq!(turns, ["turn_started", "turn_ended", "turn_started", "turn_ended", "turn_started"], "one prompt, two results, then the held prompt");
    }

    #[test]
    fn lines_after_a_result_start_no_turn() {
        let mut w = wire();
        w.stream.prompt("go".into());
        w.agent(init());
        w.agent(result());
        w.said();
        for line in [
            json!({"type": "system", "subtype": "task_notification", "status": "completed"}),
            json!({"type": "system", "subtype": "status", "status": "requesting"}),
            json!({"type": "rate_limit_event"}),
            json!({"type": "stream_event", "event": {"type": "message_start"}}),
        ] {
            w.agent(line);
        }
        assert_eq!(w.said(), Vec::<Body>::new());
    }

    fn can_use_tool(id: &str, tool: &str) -> Value {
        json!({"type": "control_request", "request_id": id, "request": {"subtype": "can_use_tool", "tool_name": tool, "input": {"command": "ls"}}})
    }

    #[test]
    fn a_permission_has_its_kind_and_its_answer_the_shape_claude_reads() {
        let mut w = wire();
        w.stream.prompt("go".into());
        w.sent();
        for (n, (tool, kind)) in [("Bash", PermissionKind::Command), ("Edit", PermissionKind::FileChange), ("mcp__x__y", PermissionKind::Tool)].into_iter().enumerate() {
            w.agent(can_use_tool(&format!("r{n}"), tool));
            let asked = w.said().pop().unwrap();
            assert_eq!(asked, Body::Permission { id: format!("r{n}"), kind, tool: tool.into(), input: json!({"command": "ls"}) });
        }
        w.stream.answer("r0", Decision::Allow, None);
        w.stream.answer("r1", Decision::Deny, Some("not that file".into()));
        w.stream.answer("r2", Decision::Deny, None);
        let sent = w.sent();
        assert_eq!(sent[0]["response"], json!({"subtype": "success", "request_id": "r0", "response": {"behavior": "allow", "updatedInput": {"command": "ls"}}}));
        assert_eq!(sent[1]["response"]["response"], json!({"behavior": "deny", "message": "not that file"}));
        assert_eq!(sent[2]["response"]["response"]["behavior"], "deny");
        w.stream.answer("r0", Decision::Allow, None);
        assert_eq!(w.sent(), Vec::<Value>::new(), "a request is answered once");
    }

    #[test]
    fn a_withdrawn_permission_closes_and_its_answer_is_not_sent() {
        let mut w = wire();
        w.stream.prompt("go".into());
        w.sent();
        w.agent(can_use_tool("r1", "Bash"));
        w.agent(json!({"type": "control_cancel_request", "request_id": "r1"}));
        assert_eq!(w.said().last(), Some(&Body::PermissionClosed { id: "r1".into() }));
        w.stream.answer("r1", Decision::Allow, None);
        assert_eq!(w.sent(), Vec::<Value>::new());
        w.agent(json!({"type": "control_cancel_request", "request_id": "never-asked"}));
        assert_eq!(w.said(), Vec::<Body>::new(), "a withdrawal of nothing open says nothing");
    }

    #[test]
    fn a_control_request_other_than_can_use_tool_is_refused_not_left_waiting() {
        let mut w = wire();
        w.agent(json!({"type": "control_request", "request_id": "h1", "request": {"subtype": "hook_callback"}}));
        let sent = w.sent();
        assert_eq!(sent[0]["response"]["subtype"], "error");
        assert_eq!(sent[0]["response"]["request_id"], "h1");
        assert_eq!(w.said(), Vec::<Body>::new());
    }

    #[test]
    fn cancel_interrupts_a_running_turn_once_and_its_result_ends_it_cancelled() {
        let mut w = wire();
        w.stream.cancel();
        assert_eq!(w.sent(), Vec::<Value>::new(), "no turn, nothing to interrupt");
        w.stream.prompt("go".into());
        w.sent();
        w.stream.cancel();
        w.stream.cancel();
        let sent = w.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["request"]["subtype"], "interrupt");
        w.agent(json!({"type": "result", "subtype": "error_during_execution", "is_error": true}));
        assert_eq!(w.said().last(), Some(&Body::TurnEnded { how: TurnEnd::Cancelled }));
    }

    #[test]
    fn a_new_session_is_named_by_its_first_init_and_a_resume_at_once() {
        let mut w = wire();
        assert_eq!(w.said(), Vec::<Body>::new());
        w.stream.prompt("go".into());
        w.agent(init());
        w.agent(init());
        let started: Vec<Body> = w.said().into_iter().filter(|body| matches!(body, Body::Started { .. })).collect();
        assert_eq!(started, [Body::Started { provider_session: "s-1".into(), resumed: false }]);
        let ((lines, _l), (output, mut said)) = (mpsc::unbounded_channel(), mpsc::unbounded_channel());
        let _resumed = Stream::new(lines, output, Some("s-0"));
        assert_eq!(said.try_recv().ok(), Some(Body::Started { provider_session: "s-0".into(), resumed: true }));
    }

    fn launch(locked: bool, model: Option<&str>, resume: Option<&str>) -> Launch {
        Launch {
            cwd: "/nowhere".into(),
            locked,
            model: model.map(str::to_owned),
            login: None,
            effort: None,
            resume: resume.map(str::to_owned),
            tools_token: crate::driver::Secret::random(),
            tools: std::sync::Arc::new(crate::tools::Endpoint::unattached("t")),
            env: vec![],
        }
    }

    #[test]
    fn the_argv_names_a_model_only_when_chosen_and_a_session_only_on_a_resume() {
        let tail = |launch: &Launch| args(launch)[STREAM.len()..].to_vec();
        assert_eq!(tail(&launch(false, None, None)), ["--append-system-prompt", GUARD]);
        assert_eq!(tail(&launch(false, Some("haiku"), Some("s-1"))), ["--model", "haiku", "--resume", "s-1", "--append-system-prompt", GUARD]);
        let locked = tail(&launch(true, None, Some("s-1")));
        assert_eq!(locked[..LOCKED.len()], *LOCKED);
        assert_eq!(locked[LOCKED.len()..], ["--resume", "s-1"], "a locked session gets no guard: it has no tool to commit with");
    }

    #[test]
    fn the_guard_says_never_to_turn_off_signing_or_hooks_and_to_report_it() {
        assert!(GUARD.contains("Never turn off commit signing or hooks"), "{GUARD}");
        assert!(GUARD.contains("report"), "{GUARD}");
    }
}
