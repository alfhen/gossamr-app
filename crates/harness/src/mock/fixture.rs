//! Turns an H0 transcript (`spikes/acp/fixtures/<provider>/<path>/<check>.jsonl`) into a mock script. It reads the
//! three wires the chosen drivers speak: Claude's native stream-json, `codex app-server` and ACP (`agy acp`). The
//! client's lines become the points where the script waits; the agent's become what it says. Recorded ids, pids and
//! ports are listed so the mock maps them as it plays.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::{Recorded, Script, Step};
use crate::driver::Capabilities;
use crate::event::{Decision, PermissionKind, TurnEnd};

#[derive(Clone, Copy, PartialEq)]
enum Wire {
    Claude,
    AppServer,
    Acp,
}

/// The line's wire, by its shape: ACP is JSON-RPC with `jsonrpc`, app-server is JSON-RPC without it, and Claude's
/// lines have a `type` of its own. Any other shape (`codex exec --json`, agy's print mode) is none of them.
fn wire(data: &Value) -> Option<Wire> {
    const CLAUDE: &[&str] = &["system", "assistant", "user", "result", "control_request", "control_response", "stream_event"];
    if data.get("jsonrpc").is_some() {
        Some(Wire::Acp)
    } else if data.get("method").is_some() || data.get("id").is_some() && (data.get("result").is_some() || data.get("error").is_some()) {
        Some(Wire::AppServer)
    } else {
        data["type"].as_str().filter(|kind| CLAUDE.contains(kind)).map(|_| Wire::Claude)
    }
}

fn capabilities(wire: Option<Wire>) -> Capabilities {
    match wire {
        Some(Wire::Claude) => Capabilities {
            tool_call_limit_ms: Some(600_000),
            stop_kills_process_tree: true,
            runs_locked_profile: true,
            starts_turns_unprompted: true,
            ..Capabilities::default()
        },
        Some(Wire::AppServer) => {
            Capabilities { tool_call_limit_ms: Some(600_000), stop_kills_process_tree: true, ..Capabilities::default() }
        }
        Some(Wire::Acp) => Capabilities {
            deny_ends_turn: true,
            tool_call_limit_ms: Some(180_000),
            stop_kills_process_tree: true,
            starts_turns_unprompted: true,
            ..Capabilities::default()
        },
        None => Capabilities::default(),
    }
}

/// Converts the transcript's `(line number, line)`s. A recording that cannot be replayed faithfully is refused with
/// the line that shows it, never played in part.
pub fn convert(numbered: &[(usize, Value)]) -> Result<Script, String> {
    let lines: Vec<Value> = numbered.iter().map(|(_, line)| line.clone()).collect();
    let mut c = Converter::default();
    for (at, line) in lines.iter().enumerate() {
        c.line = numbered[at].0;
        if c.ends_at.is_some_and(|end| line["ms"].as_u64().is_some_and(|ms| ms >= end)) {
            c.end_quietly();
        }
        let data = &line["data"];
        let dir = line["dir"].as_str();
        collect(data, "", dir == Some("driver"), &mut c.recorded);
        if data["note"] == "processes" {
            c.descendants = descendants(data);
        }
        c.now = line["ms"].as_u64().unwrap_or(c.now);
        if !data.is_object() || !matches!(dir, Some("to_agent" | "from_agent")) {
            continue;
        }
        let wire = match c.wire {
            Some(wire) => wire,
            None => *c.wire.insert(wire(data).ok_or_else(|| format!("{}: unknown transcript format", c.line))?),
        };
        c.pair(dir == Some("to_agent"), wire, data);
        match (dir, wire) {
            (Some("to_agent"), Wire::Claude) => c.claude_client(data),
            (Some("to_agent"), _) => c.rpc_client(data),
            (Some("from_agent"), Wire::Claude) => c.claude_agent(data, &lines[at + 1..]),
            (Some("from_agent"), Wire::AppServer) => c.app_server_agent(data, &lines[at + 1..]),
            (Some("from_agent"), Wire::Acp) => {
                c.acp_agent(data, &lines[at + 1..]);
                c.end_when_quiet(line, &lines[at + 1..]);
            }
            _ => {}
        }
        if let Some(error) = c.error.take() {
            return Err(error);
        }
    }
    if c.ends_at.is_some() {
        c.end_quietly();
    }
    c.flush();
    if !c.held.is_empty() {
        return Err("a prompt was sent while a turn ran, and the recording never ends that turn".into());
    }
    if !c.steps.iter().any(|step| matches!(step, Step::Prompt(_) | Step::Turn | Step::Fail(_))) {
        return Err("no turn in this recording".into());
    }
    let mut seen = HashSet::new();
    let recorded = c.recorded.into_iter().filter(|(value, _)| seen.insert(value.clone())).collect();
    Ok(Script { capabilities: capabilities(c.wire), steps: c.steps, replay: true, recorded })
}

#[derive(Default)]
struct Converter {
    wire: Option<Wire>,
    steps: Vec<Step>,
    recorded: Vec<(String, Recorded)>,
    /// ACP streams a message in chunks; they become one text, so a secret split over two chunks is masked whole.
    text: String,
    cancelled: bool,
    in_turn: bool,
    /// The running turn is one the agent started by itself.
    unprompted: bool,
    /// How many processes the agent had running at the last note of the recording's driver.
    descendants: usize,
    /// The id of an ACP `session/load` not yet answered: the updates before its answer replay old history.
    loading: Option<Value>,
    finished: HashSet<String>,
    /// The running turn's tool calls that are not commands, with no `completed` or `failed` update yet, a call held on
    /// the session's own endpoint among them, and when each began. A command counts through its descendant instead.
    open_calls: HashMap<String, u64>,
    /// The running turn's commands with no result yet. They hold no quiet end, but a prompt waits for them.
    open_commands: HashSet<String>,
    /// When the line being read was recorded.
    now: u64,
    /// The line being read, for errors.
    line: usize,
    error: Option<String>,
    /// The agent's requests the client has not answered yet, and its tool calls.
    asked: HashSet<String>,
    called: HashSet<String>,
    /// Prompts sent while a turn ran, with their request ids: a provider plays each once the turn before it has ended.
    held: VecDeque<(String, String)>,
    /// What the client's requests asked for, by id.
    requests: HashMap<String, String>,
    /// When agy's unprompted turn ends, once the client lines recorded before then are read.
    ends_at: Option<u64>,
}

impl Converter {
    /// Adds a step. What the agent says with no turn running starts a turn of its own, as when it goes on by itself
    /// after a background task; a late result of a call it made before does not.
    fn push(&mut self, step: Step) {
        self.flush();
        self.turn_for(&step);
        let ends = matches!(step, Step::End(_) | Step::Fail(_));
        self.in_turn = match step {
            Step::Prompt(_) => true,
            Step::End(_) | Step::Fail(_) => false,
            _ => self.in_turn,
        };
        if !self.in_turn {
            self.open_calls.clear();
            self.open_commands.clear();
        }
        self.unprompted &= self.in_turn && !matches!(step, Step::Prompt(_));
        if let Step::Tool { id: Some(id), .. } = &step {
            self.called.insert(id.clone());
        }
        self.steps.push(step);
        if ends {
            self.ends_at = None;
            if let Some((id, text)) = self.held.pop_front() {
                self.prompt(id, text);
            }
        }
    }

    fn turn_for(&mut self, step: &Step) {
        if !self.in_turn && !matches!(step, Step::Prompt(_) | Step::Cancel | Step::Fail(_) | Step::ToolResult { .. }) {
            self.steps.push(Step::Turn);
            self.in_turn = true;
            self.unprompted = true;
            self.cancelled = false;
        }
    }

    fn flush(&mut self) {
        if !self.text.is_empty() {
            let say = Step::Say(std::mem::take(&mut self.text));
            self.turn_for(&say);
            self.steps.push(say);
        }
    }

    /// A prompt sent while a turn runs waits for that turn's end in the recording.
    fn prompt(&mut self, id: String, text: String) {
        self.flush();
        if self.in_turn {
            self.held.push_back((id, text));
            return self.end_for_held();
        }
        self.cancelled = false;
        self.push(Step::Prompt(Some(text)));
    }

    /// agy ends a turn it started by itself with no marker, and holds a prompt sent meanwhile (H8): that turn ends
    /// where the prompt was sent, or later, once no tool call of it is open.
    fn end_for_held(&mut self) {
        if self.wire == Some(Wire::Acp) && self.in_turn && self.unprompted && !self.held.is_empty() && self.open_calls.is_empty() && self.open_commands.is_empty() {
            self.end_quietly();
        }
    }

    fn end_quietly(&mut self) {
        self.ends_at = None;
        if self.in_turn && self.unprompted {
            self.push(Step::End(if self.cancelled { TurnEnd::Cancelled } else { TurnEnd::Done }));
        }
    }

    /// Checks that each reply of the client answers a request of the agent's, by its id.
    fn pair(&mut self, client: bool, wire: Wire, data: &Value) {
        let (request, reply) = match wire {
            Wire::Claude if data["type"] == "control_request" => (data["request_id"].clone(), Value::Null),
            Wire::Claude if data["type"] == "control_response" => (Value::Null, data["response"]["request_id"].clone()),
            Wire::Claude => return,
            _ if data.get("method").is_some() => (data["id"].clone(), Value::Null),
            _ => (Value::Null, data["id"].clone()),
        };
        if !client && !request.is_null() {
            self.asked.insert(request.to_string());
        }
        if let Some(method) = data["method"].as_str().filter(|_| client && !request.is_null()) {
            self.requests.insert(request.to_string(), method.to_owned());
        }
        if client && !reply.is_null() && !self.asked.remove(&reply.to_string()) {
            self.fail_at("a reply to no request");
        }
    }

    /// An error reply fails what it answers: a prompt's turn, or the session when it answers setting the session up.
    /// A prompt refused while it was held is never played. An error to any other request (`config/read`, a list) is
    /// the client's affair.
    fn error_reply(&mut self, data: &Value) {
        let id = data["id"].to_string();
        let reason = Step::Fail(str_of(&data["error"]["message"]));
        match self.requests.get(&id).map(String::as_str) {
            Some("turn/start" | "session/prompt") => match self.held.iter().position(|(held, _)| *held == id) {
                Some(at) => drop(self.held.remove(at)),
                None => self.push(reason),
            },
            Some("initialize" | "authenticate" | "session/new" | "session/load" | "thread/start" | "thread/resume") | None => self.push(reason),
            Some(_) => {}
        }
    }

    fn fail_at(&mut self, what: &str) {
        self.error.get_or_insert_with(|| format!("{}: {what}", self.line));
    }

    fn cancel(&mut self) {
        self.cancelled = true;
        self.push(Step::Cancel);
    }

    fn tool_result(&mut self, id: &Value, output: Value, error: bool) {
        match id.as_str() {
            Some(id) if !self.called.contains(id) => self.fail_at("a result for no tool call"),
            Some(id) if self.finished.insert(id.to_owned()) => self.push(Step::ToolResult { id: Some(id.to_owned()), output, error }),
            Some(_) => {}
            None => self.fail_at("a tool result with no call id"),
        }
    }

    fn claude_client(&mut self, data: &Value) {
        match (data["type"].as_str(), data["request"]["subtype"].as_str()) {
            (Some("user"), _) => self.prompt(String::new(), texts(&data["message"]["content"])),
            (Some("control_request"), Some("interrupt")) => self.cancel(),
            _ => {}
        }
    }

    /// The client's side of app-server and ACP, both JSON-RPC.
    fn rpc_client(&mut self, data: &Value) {
        match data["method"].as_str() {
            Some("turn/start") => self.prompt(data["id"].to_string(), texts(&data["params"]["input"])),
            Some("session/prompt") => self.prompt(data["id"].to_string(), texts(&data["params"]["prompt"])),
            Some("turn/interrupt" | "session/cancel") => self.cancel(),
            Some("session/load") => self.loading = Some(data["id"].clone()),
            _ => {}
        }
    }

    fn claude_agent(&mut self, data: &Value, after: &[Value]) {
        match data["type"].as_str() {
            Some("assistant") => {
                for block in data["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => self.push(Step::Say(str_of(&block["text"]))),
                        Some("tool_use") => self.push(Step::Tool {
                            id: block["id"].as_str().map(str::to_owned),
                            name: str_of(&block["name"]),
                            input: block["input"].clone(),
                        }),
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for block in data["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] == "tool_result" {
                        let error = block["is_error"].as_bool().unwrap_or(false);
                        self.tool_result(&block["tool_use_id"], block["content"].clone(), error);
                    }
                }
            }
            Some("control_request") if data["request"]["subtype"] == "can_use_tool" => {
                let request = &data["request"];
                let tool = str_of(&request["tool_name"]);
                let kind = match tool.as_str() {
                    "Bash" => PermissionKind::Command,
                    "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => PermissionKind::FileChange,
                    _ => PermissionKind::Tool,
                };
                let answer = after
                    .iter()
                    .filter(|line| line["dir"] == "to_agent")
                    .map(|line| &line["data"]["response"])
                    .find(|response| response["request_id"] == data["request_id"])
                    .map(|response| decision(response["response"]["behavior"] == "allow"));
                self.push(Step::Permission { kind, tool, input: request["input"].clone(), answer });
            }
            Some("result") => {
                let step = match data["subtype"].as_str() {
                    Some("success") if data["is_error"] != true => Step::End(TurnEnd::Done),
                    _ if self.cancelled => Step::End(TurnEnd::Cancelled),
                    subtype => Step::Fail(data["result"].as_str().or(subtype).unwrap_or("the turn failed").to_owned()),
                };
                self.push(step);
            }
            _ => {}
        }
    }

    fn app_server_agent(&mut self, data: &Value, after: &[Value]) {
        let params = &data["params"];
        let item = &params["item"];
        match data["method"].as_str() {
            Some("item/started") => {
                let (name, input) = match item["type"].as_str() {
                    Some("commandExecution") => ("command".to_owned(), json!({ "command": item["command"] })),
                    Some("fileChange") => ("file_change".to_owned(), json!({ "changes": item["changes"] })),
                    Some("mcpToolCall") => (format!("{}/{}", str_of(&item["server"]), str_of(&item["tool"])), item["arguments"].clone()),
                    _ => return,
                };
                self.push(Step::Tool { id: item["id"].as_str().map(str::to_owned), name, input });
            }
            Some("item/completed") => match item["type"].as_str() {
                Some("agentMessage") => self.push(Step::Say(str_of(&item["text"]))),
                Some("commandExecution" | "fileChange" | "mcpToolCall") => {
                    let output = [&item["aggregatedOutput"], &item["result"], &item["error"]]
                        .into_iter()
                        .find(|output| !output.is_null())
                        .cloned()
                        .unwrap_or_else(|| item["status"].clone());
                    self.tool_result(&item["id"], output, item["status"] != "completed");
                }
                _ => {}
            },
            Some(method @ ("item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "mcpServer/elicitation/request")) => {
                let (kind, tool) = match method {
                    "item/commandExecution/requestApproval" => (PermissionKind::Command, "command".to_owned()),
                    "item/fileChange/requestApproval" => (PermissionKind::FileChange, "file_change".to_owned()),
                    "item/permissions/requestApproval" => (PermissionKind::Permissions, "permissions".to_owned()),
                    _ => (PermissionKind::Tool, str_of(&params["serverName"])),
                };
                let answer = rpc_answer(data, after).map(|result| {
                    let granted = result["permissions"].as_object().is_some_and(|granted| !granted.is_empty());
                    let accepted = result["decision"].as_str().is_some_and(|d| d.starts_with("accept"));
                    decision(accepted || granted || result["action"] == "accept")
                });
                let mut input = params.clone();
                if let Some(fields) = input.as_object_mut() {
                    for id in ["threadId", "turnId", "itemId", "startedAtMs", "environmentId"] {
                        fields.remove(id);
                    }
                }
                self.push(Step::Permission { kind, tool, input, answer });
            }
            Some("turn/completed") => {
                let turn = &params["turn"];
                let step = match turn["status"].as_str() {
                    Some("completed") => Step::End(TurnEnd::Done),
                    Some("interrupted") => Step::End(TurnEnd::Cancelled),
                    status => Step::Fail(turn["error"]["message"].as_str().or(status).unwrap_or("the turn failed").to_owned()),
                };
                self.push(step);
            }
            None if data.get("error").is_some() => self.error_reply(data),
            _ => {}
        }
    }

    fn acp_agent(&mut self, data: &Value, after: &[Value]) {
        if let Some(loading) = &self.loading {
            if data.get("method").is_none() && data["id"] == *loading {
                self.loading = None;
            }
            return;
        }
        let params = &data["params"];
        match data["method"].as_str() {
            Some("session/update") => {
                let update = &params["update"];
                match update["sessionUpdate"].as_str() {
                    Some("agent_message_chunk") => self.text.push_str(update["content"]["text"].as_str().unwrap_or_default()),
                    Some("tool_call") => {
                        let id = update["toolCallId"].as_str().map(str::to_owned);
                        self.push(Step::Tool { id: id.clone(), name: acp_tool(update), input: acp_input(update) });
                        match update["kind"] == "execute" {
                            true => self.open_commands.extend(id),
                            false => self.open_calls.extend(id.map(|id| (id, self.now))),
                        }
                        self.acp_finished(update);
                    }
                    Some("tool_call_update") => self.acp_finished(update),
                    // A `usage_update` closes a message, not a turn.
                    Some("usage_update") => self.flush(),
                    _ => {}
                }
            }
            Some("session/request_permission") => {
                let call = &params["toolCall"];
                let kind = match call["kind"].as_str() {
                    Some("execute") => PermissionKind::Command,
                    Some("edit" | "delete" | "move") => PermissionKind::FileChange,
                    _ => PermissionKind::Tool,
                };
                let answer = rpc_answer(data, after).map(|result| {
                    let chosen = &result["outcome"]["optionId"];
                    let options = params["options"].as_array().into_iter().flatten();
                    let option = options.into_iter().find(|option| option["optionId"] == *chosen);
                    decision(option.is_some_and(|option| option["kind"].as_str().is_some_and(|kind| kind.starts_with("allow"))))
                });
                self.push(Step::Permission { kind, tool: acp_tool(call), input: acp_input(call), answer });
            }
            None => match (data["result"]["stopReason"].as_str(), data.get("error")) {
                (Some("end_turn"), _) => self.push(Step::End(TurnEnd::Done)),
                (Some("cancelled"), _) => self.push(Step::End(TurnEnd::Cancelled)),
                (Some(other), _) => self.push(Step::Fail(format!("the turn stopped: {other}"))),
                (None, Some(_)) => self.error_reply(data),
                _ => {}
            },
            _ => {}
        }
    }

    /// agy ends a turn it started by itself with no marker: it sends a `usage_update` per message or step, not per
    /// turn. So the turn ends late, never early: after `line` only when no agent line comes for `QUIET_MS`, no
    /// process of the agent's runs then, and no tool call of the turn is open (agy holds an MCP call with no process)
    /// short of agy's own cut and a margin, by when agy's next line comes.
    fn end_when_quiet(&mut self, line: &Value, after: &[Value]) {
        let ms = line["ms"].as_u64().unwrap_or_default();
        let until = after.iter().position(|next| next["dir"] == "from_agent").unwrap_or(after.len());
        let next = after.get(until).and_then(|next| next["ms"].as_u64());
        // Elapsed time is compared, so a timestamp near the largest number cannot reach a deadline early.
        if next.is_some_and(|next| next.saturating_sub(ms) < QUIET_MS) {
            return;
        }
        // Quiet: a message streamed so far is whole where it starts a turn of agy's own or ends one. Inside a prompted
        // turn it goes on, so a secret split by the pause is masked whole.
        if self.in_turn && !self.unprompted {
            return;
        }
        let mut notes = after[..until].iter().filter(|note| note["data"]["note"] == "processes" && note["ms"].as_u64().is_some_and(|at| at.saturating_sub(ms) <= QUIET_MS));
        let running = notes.next_back().map_or(self.descendants, |note| descendants(&note["data"]));
        // The turn ends once the quiet and each open call's cut have passed, if agy says nothing before then.
        let end = self.open_calls.values().map(|began| began.saturating_add(MCP_CUT_MS + CUT_MARGIN_MS)).fold(ms.saturating_add(QUIET_MS), u64::max);
        let cut = |next: u64| self.open_calls.values().all(|began| next.saturating_sub(*began) >= MCP_CUT_MS + CUT_MARGIN_MS);
        let ends = running == 0 && next.is_none_or(cut);
        if !self.in_turn || ends {
            self.flush();
        }
        if self.in_turn && self.unprompted && ends {
            // A client line recorded before the end comes first in the turn.
            let before = |line: &Value| line["dir"] == "to_agent" && line["ms"].as_u64().is_some_and(|at| at < end);
            match after[..until].iter().any(before) {
                true => self.ends_at = Some(end),
                false => self.end_quietly(),
            }
        }
    }

    fn acp_finished(&mut self, update: &Value) {
        if let Some(status @ ("completed" | "failed")) = update["status"].as_str() {
            if let Some(id) = update["toolCallId"].as_str() {
                self.open_calls.remove(id);
                self.open_commands.remove(id);
            }
            let output = [&update["rawOutput"], &update["content"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or_default();
            self.tool_result(&update["toolCallId"], output, status == "failed");
            self.end_for_held();
        }
    }
}

fn decision(allow: bool) -> Decision {
    if allow { Decision::Allow } else { Decision::Deny }
}

fn str_of(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// The text of a message's content: a string, or the `text` of each block.
fn texts(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// agy cuts an MCP call at 180 s (H0). Past that and the margin, a call with no update holds no turn open.
const MCP_CUT_MS: u64 = 180_000;
const CUT_MARGIN_MS: u64 = 10_000;

/// How long agy must say nothing, with no process running and no tool call open, before a turn it started by itself
/// counts as ended. H0's recordings pause up to 6.6 s between messages while agy thinks.
const QUIET_MS: u64 = 15_000;

fn descendants(note: &Value) -> usize {
    note["detail"]["descendants"].as_array().map_or(0, Vec::len)
}

/// The tool's identifier. With none, a fixed word: ACP's title is often the command line, which must not be kept as
/// a name after clean-up, so it goes into the input instead.
fn acp_tool(call: &Value) -> String {
    call["name"].as_str().unwrap_or("tool").to_owned()
}

fn acp_input(call: &Value) -> Value {
    let input = [&call["rawInput"], &call["args"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or_default();
    match (call["name"].is_null(), call["title"].as_str()) {
        (true, Some(title)) => match input {
            Value::Object(mut fields) => {
                fields.insert("title".into(), json!(title));
                Value::Object(fields)
            }
            other => json!({ "title": title, "input": other }),
        },
        _ => input,
    }
}

/// The result the recorded client gave to the agent's request `data`.
fn rpc_answer<'a>(data: &Value, after: &'a [Value]) -> Option<&'a Value> {
    after
        .iter()
        .filter(|line| line["dir"] == "to_agent")
        .map(|line| &line["data"])
        .find(|reply| reply["id"] == data["id"] && reply.get("method").is_none())
        .map(|reply| &reply["result"])
}

static ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:toolu|call|exec|msg|rs|item)[_-][A-Za-z0-9_-]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
        .expect("compiles")
});
static PORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:127\.0\.0\.1|localhost):\d{2,5}\b").expect("compiles"));

/// What a field named `key` holds, if it is one of the recorded run's own values.
pub(super) fn field_kind(key: &str) -> Option<Recorded> {
    match key {
        "session_id" | "sessionId" | "threadId" => Some(Recorded::Session),
        "pid" | "agent_pid" | "driver_pid" | "processId" => Some(Recorded::Pid),
        "id" | "uuid" => Some(Recorded::Id),
        key if key.ends_with("Id") || key.ends_with("_id") => Some(Recorded::Id),
        _ => None,
    }
}

/// Lists the recorded run's own values in `value`, each from a field that names it: session ids, id-shaped ids, pids,
/// and loopback ports in a `url` or the driver's own notes. The same number or word in free text is not one.
fn collect(value: &Value, key: &str, driver: bool, out: &mut Vec<(String, Recorded)>) {
    match (value, field_kind(key)) {
        (Value::Object(fields), _) => fields.iter().for_each(|(key, field)| collect(field, key, driver, out)),
        (Value::Array(items), _) => items.iter().for_each(|item| collect(item, key, driver, out)),
        (Value::String(s), Some(kind @ (Recorded::Session | Recorded::Id))) if ID.is_match(s) => out.push((s.clone(), kind)),
        (Value::String(s), Some(Recorded::Pid)) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => out.push((s.clone(), Recorded::Pid)),
        (Value::Number(n), Some(Recorded::Pid)) => out.push((n.to_string(), Recorded::Pid)),
        (Value::String(s), _) if driver || key == "url" => out.extend(PORT.find_iter(s).map(|port| (port.as_str().to_owned(), Recorded::Port))),
        _ => {}
    }
}
