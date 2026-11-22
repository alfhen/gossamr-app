//! ACP client. The wire is written by hand so the transcript is exactly what crossed it; every message
//! the agent sends is also parsed into the `agent-client-protocol` 5.5.1 v1 types, and a mismatch is noted.

use crate::rpc::{Rpc, is_notification, is_request};
use crate::{Common, Turn};
use agent_client_protocol::v1::schema as acp;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Duration;

fn check<T: DeserializeOwned>(rpc: &Rpc, what: &str, v: &Value) {
    if let Err(e) = serde_json::from_value::<T>(v.clone()) {
        rpc.a.t.note(
            "schema_mismatch",
            json!({ "type": what, "error": e.to_string() }),
        );
    }
}

fn mcp_servers(o: &Common) -> Value {
    match &o.mcp_url {
        None => json!([]),
        Some(url) => {
            let headers = match o.mcp_token() {
                Some(tok) => json!([{ "name": "Authorization", "value": format!("Bearer {tok}") }]),
                None => json!([]),
            };
            json!([{ "type": "http", "name": "spike", "url": url, "headers": headers }])
        }
    }
}

pub fn run(o: &Common) {
    let t = o.transcript();
    // The MCP token travels in session/new; the adapter's environment does not get the variable.
    let remove: Vec<String> = o.mcp_token_env.iter().cloned().collect();
    let mut rpc = Rpc::new(o.spawn_without(t.clone(), &remove), true);
    let setup = Duration::from_secs(120);

    let init = rpc.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "acp-spike", "version": env!("CARGO_PKG_VERSION") }
        }),
    );
    let Some(Ok(init)) = rpc.wait(init, setup, &mut |r, m| side(r, m, o, None)) else {
        t.note("initialize_failed", json!(null));
        rpc.a.finish(Duration::from_secs(5));
        return;
    };
    check::<acp::InitializeResponse>(&rpc, "InitializeResponse", &init);
    let caps = init
        .get("agentCapabilities")
        .cloned()
        .unwrap_or(Value::Null);

    let (method, params) = match &o.resume {
        None => (
            "session/new",
            json!({ "cwd": o.cwd, "mcpServers": mcp_servers(o) }),
        ),
        Some(id) => {
            let can_load = caps.get("loadSession").and_then(Value::as_bool) == Some(true);
            let m = match o.resume_method.as_str() {
                "load" => "session/load",
                "resume" => "session/resume",
                _ if can_load => "session/load",
                _ => "session/resume",
            };
            (
                m,
                json!({ "sessionId": id, "cwd": o.cwd, "mcpServers": mcp_servers(o) }),
            )
        }
    };
    let mut params = params;
    if let Some(meta) = &o.session_meta {
        params["_meta"] = serde_json::from_str(meta).expect("--session-meta is JSON");
    }
    let req = rpc.request(method, params);
    let session = rpc.wait(req, setup, &mut |r, m| side(r, m, o, None));
    let session = match session {
        Some(Ok(s)) => s,
        other => {
            t.note(
                "session_failed",
                json!({ "method": method, "answer": other.map(|r| r.err()) }),
            );
            rpc.a.close_stdin();
            rpc.a.finish(Duration::from_secs(10));
            return;
        }
    };
    if method == "session/new" {
        check::<acp::NewSessionResponse>(&rpc, "NewSessionResponse", &session);
    }
    let sid = session
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| o.resume.clone())
        .unwrap_or_default();
    t.note("session", json!({ "id": sid, "method": method }));
    rpc.a.note_processes("after_session");

    if let Some(mode) = &o.mode {
        let r = rpc.request(
            "session/set_mode",
            json!({ "sessionId": sid, "modeId": mode }),
        );
        rpc.wait(r, setup, &mut |r, m| side(r, m, o, None));
    }
    if let Some(model) = &o.model {
        let opt = session
            .get("configOptions")
            .and_then(Value::as_array)
            .and_then(|a| {
                a.iter()
                    .find(|c| c.get("category").and_then(Value::as_str) == Some("model"))
            })
            .and_then(|c| c.get("id"))
            .cloned();
        let r = match opt {
            Some(id) => rpc.request(
                "session/set_config_option",
                json!({ "sessionId": sid, "configId": id, "value": model }),
            ),
            None => rpc.request(
                "session/set_model",
                json!({ "sessionId": sid, "modelId": model }),
            ),
        };
        rpc.wait(r, setup, &mut |r, m| side(r, m, o, None));
    }
    for kv in &o.set_config {
        if let Some((id, v)) = kv.split_once('=') {
            let r = rpc.request(
                "session/set_config_option",
                json!({ "sessionId": sid, "configId": id, "value": v }),
            );
            rpc.wait(r, setup, &mut |r, m| side(r, m, o, None));
        }
    }

    if !o.list_only {
        for (i, p) in o.prompt.iter().enumerate() {
            let mut turn = Turn::new(i, o);
            let r = rpc.request(
                "session/prompt",
                json!({ "sessionId": sid, "prompt": [{ "type": "text", "text": p }] }),
            );
            let mut pending: Vec<Value> = Vec::new();
            let ans = rpc.wait(r, Duration::from_secs_f64(o.turn_timeout), &mut |rpc, m| {
                if turn.due_to_cancel() {
                    turn.cancelled = true;
                    rpc.notify("session/cancel", json!({ "sessionId": sid }));
                    for id in pending.drain(..) {
                        rpc.respond(&id, json!({ "outcome": { "outcome": "cancelled" } }));
                    }
                }
                side(rpc, m, o, Some((&mut turn, &mut pending)));
            });
            if let Some(Ok(v)) = &ans {
                check::<acp::PromptResponse>(&rpc, "PromptResponse", v)
            }
            t.note("turn_end", json!({ "turn": i, "answer": ans.map(|r| r.unwrap_or_else(|e| json!({"error": e}))), "ms": turn.started.elapsed().as_millis() as u64 }));
            rpc.a.note_processes("after_turn");
        }
    }

    if o.keep_open > 0.0 {
        rpc.pump(Duration::from_secs_f64(o.keep_open), &mut |r, m| {
            side(r, m, o, None);
            false
        });
    }
    rpc.a.close_stdin();
    rpc.a.finish(Duration::from_secs_f64(o.exit_wait));
}

/// Everything that is not the answer being waited for: updates, permission requests, client methods.
fn side(rpc: &mut Rpc, m: Option<&Value>, o: &Common, turn: Option<(&mut Turn, &mut Vec<Value>)>) {
    let Some(m) = m else { return };
    if is_notification(m) {
        if m["method"] == "session/update" {
            check::<acp::SessionNotification>(rpc, "SessionNotification", &m["params"]);
            if m["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
                && let Some((turn, _)) = turn
            {
                turn.saw_text(&rpc.a.t);
            }
        }
        return;
    }
    if !is_request(m) {
        return;
    }
    let id = m["id"].clone();
    match m["method"].as_str().unwrap_or("") {
        "session/request_permission" => {
            check::<acp::RequestPermissionRequest>(rpc, "RequestPermissionRequest", &m["params"]);
            let Some((turn, pending)) = turn else {
                rpc.respond(&id, json!({ "outcome": { "outcome": "cancelled" } }));
                return;
            };
            if turn.cancelled {
                rpc.respond(&id, json!({ "outcome": { "outcome": "cancelled" } }));
                return;
            }
            let Some(allow) = turn.decide(o.permission) else {
                rpc.a.t.note("permission_left_open", json!({ "id": id }));
                pending.push(id);
                return;
            };
            let want = if allow { "allow_once" } else { "reject_once" };
            let options = m["params"]["options"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let pick = options
                .iter()
                .find(|op| op["kind"] == want)
                .and_then(|op| op["optionId"].as_str())
                .map(String::from);
            rpc.a.t.note(
                "permission_answer",
                json!({ "allow": allow, "kind": want, "optionId": pick }),
            );
            match pick {
                Some(opt) => rpc.respond(
                    &id,
                    json!({ "outcome": { "outcome": "selected", "optionId": opt } }),
                ),
                None => rpc.respond(&id, json!({ "outcome": { "outcome": "cancelled" } })),
            }
        }
        other => {
            rpc.a
                .t
                .note("client_method_refused", json!({ "method": other }));
            rpc.error(&id, -32601, "method not found");
        }
    }
}
