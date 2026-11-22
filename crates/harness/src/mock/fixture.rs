//! Turns an H0 transcript (`spikes/acp/fixtures/<provider>/<path>/<check>.jsonl`) into a mock script. It reads the
//! three wires the chosen drivers speak: Claude's native stream-json, `codex app-server` and ACP (`agy acp`). The
//! client's lines become the points where the script waits; the agent's become what it says. Recorded ids, pids and
//! ports are listed so the mock maps them as it plays.

use std::collections::HashSet;
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

/// The line's wire, by its shape: ACP is JSON-RPC with `jsonrpc`, Claude has `type`, app-server has neither.
fn wire(data: &Value) -> Wire {
    if data.get("jsonrpc").is_some() {
        Wire::Acp
    } else if data.get("type").is_some_and(Value::is_string) {
        Wire::Claude
    } else {
        Wire::AppServer
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

pub fn convert(lines: &[Value]) -> Script {
    let mut c = Converter::default();
    for (at, line) in lines.iter().enumerate() {
        let data = &line["data"];
        collect(data, &mut c.recorded);
        let dir = line["dir"].as_str();
        if !data.is_object() || !matches!(dir, Some("to_agent" | "from_agent")) {
            continue;
        }
        let wire = *c.wire.get_or_insert(wire(data));
        match (dir, wire) {
            (Some("to_agent"), Wire::Claude) => c.claude_client(data),
            (Some("to_agent"), _) => c.rpc_client(data),
            (Some("from_agent"), Wire::Claude) => c.claude_agent(data, &lines[at + 1..]),
            (Some("from_agent"), Wire::AppServer) => c.app_server_agent(data, &lines[at + 1..]),
            (Some("from_agent"), Wire::Acp) => c.acp_agent(data, &lines[at + 1..]),
            _ => {}
        }
    }
    c.flush();
    let mut seen = HashSet::new();
    let recorded = c.recorded.into_iter().filter(|(value, _)| seen.insert(value.clone())).collect();
    Script { capabilities: capabilities(c.wire), steps: c.steps, replay: true, recorded }
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
    /// The id of an ACP `session/load` not yet answered: the updates before its answer replay old history.
    loading: Option<Value>,
    finished: HashSet<String>,
}

impl Converter {
    /// Adds a step. What the agent says with no turn running starts a turn of its own, as when it goes on by itself
    /// after a background task; a late result of a call it made before does not.
    fn push(&mut self, step: Step) {
        self.flush();
        self.turn_for(&step);
        self.in_turn = match step {
            Step::Prompt(_) => true,
            Step::End(_) | Step::Fail(_) => false,
            _ => self.in_turn,
        };
        self.unprompted &= self.in_turn && !matches!(step, Step::Prompt(_));
        self.steps.push(step);
    }

    fn turn_for(&mut self, step: &Step) {
        if !self.in_turn && !matches!(step, Step::Prompt(_) | Step::Cancel | Step::Fail(_) | Step::ToolResult { .. }) {
            self.steps.push(Step::Turn);
            self.in_turn = true;
            self.unprompted = true;
        }
    }

    fn flush(&mut self) {
        if !self.text.is_empty() {
            let say = Step::Say(std::mem::take(&mut self.text));
            self.turn_for(&say);
            self.steps.push(say);
        }
    }

    fn prompt(&mut self, text: String) {
        self.cancelled = false;
        self.push(Step::Prompt(Some(text)));
    }

    fn cancel(&mut self) {
        self.cancelled = true;
        self.push(Step::Cancel);
    }

    fn tool_result(&mut self, id: &Value, output: Value, error: bool) {
        if let Some(id) = id.as_str().filter(|id| self.finished.insert((*id).to_owned())) {
            self.push(Step::ToolResult { id: Some(id.to_owned()), output, error });
        }
    }

    fn claude_client(&mut self, data: &Value) {
        match (data["type"].as_str(), data["request"]["subtype"].as_str()) {
            (Some("user"), _) => self.prompt(texts(&data["message"]["content"])),
            (Some("control_request"), Some("interrupt")) => self.cancel(),
            _ => {}
        }
    }

    /// The client's side of app-server and ACP, both JSON-RPC.
    fn rpc_client(&mut self, data: &Value) {
        match data["method"].as_str() {
            Some("turn/start") => self.prompt(texts(&data["params"]["input"])),
            Some("session/prompt") => self.prompt(texts(&data["params"]["prompt"])),
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
            None if data.get("error").is_some() => self.push(Step::Fail(str_of(&data["error"]["message"]))),
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
                        self.push(Step::Tool { id: update["toolCallId"].as_str().map(str::to_owned), name: acp_tool(update), input: acp_input(update) });
                        self.acp_finished(update);
                    }
                    Some("tool_call_update") => self.acp_finished(update),
                    // agy ends a message it sent by itself with its usage and nothing else: that ends the turn.
                    Some("usage_update") => {
                        self.flush();
                        if self.in_turn && self.unprompted {
                            self.push(Step::End(TurnEnd::Done));
                        }
                    }
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
                (None, Some(error)) => self.push(Step::Fail(str_of(&error["message"]))),
                _ => {}
            },
            _ => {}
        }
    }

    fn acp_finished(&mut self, update: &Value) {
        if let Some(status @ ("completed" | "failed")) = update["status"].as_str() {
            let output = [&update["rawOutput"], &update["content"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or_default();
            self.tool_result(&update["toolCallId"], output, status == "failed");
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

fn acp_tool(call: &Value) -> String {
    call["name"].as_str().or(call["title"].as_str()).unwrap_or_default().to_owned()
}

fn acp_input(call: &Value) -> Value {
    [&call["rawInput"], &call["args"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or_default()
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

/// Lists the recorded run's own values found in `value`: session ids, request and item ids, pids, loopback ports.
fn collect(value: &Value, out: &mut Vec<(String, Recorded)>) {
    match value {
        Value::Object(fields) => {
            for (key, field) in fields {
                let kind = match key.as_str() {
                    "session_id" | "sessionId" | "threadId" => Some(Recorded::Session),
                    "pid" | "agent_pid" | "driver_pid" | "processId" => Some(Recorded::Pid),
                    _ => None,
                };
                match (kind, field) {
                    (Some(kind), Value::String(s)) if !s.is_empty() => out.push((s.clone(), kind)),
                    (Some(Recorded::Pid), Value::Number(n)) => out.push((n.to_string(), Recorded::Pid)),
                    _ => collect(field, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect(item, out)),
        Value::String(s) if ID.is_match(s) => out.push((s.clone(), Recorded::Id)),
        Value::String(s) => out.extend(PORT.find_iter(s).map(|port| (port.as_str().to_owned(), Recorded::Port))),
        _ => {}
    }
}
