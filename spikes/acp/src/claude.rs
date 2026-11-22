//! `claude -p --input-format stream-json --output-format stream-json`: user messages in, events out,
//! and the control protocol both ways (initialize, can_use_tool, interrupt).

use crate::agent::Msg;
use crate::{Common, Turn};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub fn run(o: &Common) {
    let t = o.transcript();
    // With --mcp-via-control the token travels on stdin only, so its variable stays out of claude's environment.
    let remove: Vec<String> = if o.mcp_via_control {
        o.mcp_token_env.iter().cloned().collect()
    } else {
        Vec::new()
    };
    let mut a = o.spawn_without(t.clone(), &remove);
    let mut next = 0u32;
    let mut control = |a: &mut crate::agent::Agent, request: Value| {
        next += 1;
        let id = format!("spike-{next}");
        a.send(&json!({ "type": "control_request", "request_id": id, "request": request }));
        id
    };

    // What the SDK sends first. The answer lists commands, agents, models and the account.
    let init = control(&mut a, json!({ "subtype": "initialize" }));
    await_control(&mut a, &init, o);
    // The SDK's setMcpServers(): the tools endpoint with its header and timeout, over stdin.
    if o.mcp_via_control
        && let Some(url) = &o.mcp_url
    {
        let mut server = json!({ "type": "http", "url": url });
        if let Some(tok) = o.mcp_token() {
            server["headers"] = json!({ "Authorization": format!("Bearer {tok}") });
        }
        if let Some(s) = o.mcp_tool_timeout {
            server["timeout"] = json!(s * 1000);
        }
        let id = control(
            &mut a,
            json!({ "subtype": "mcp_set_servers", "servers": { "spike": server } }),
        );
        await_control(&mut a, &id, o);
    }
    a.note_processes("after_initialize");

    if !o.list_only {
        for (i, p) in o.prompt.iter().enumerate() {
            let mut turn = Turn::new(i, o);
            a.send(&json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": p }] }, "parent_tool_use_id": null, "session_id": "" }));
            let mut result = None;
            while turn.started.elapsed() < Duration::from_secs_f64(o.turn_timeout) {
                if turn.due_to_cancel() {
                    turn.cancelled = true;
                    control(&mut a, json!({ "subtype": "interrupt" }));
                }
                match a.next(Duration::from_millis(200)) {
                    Some(Msg::Json(v)) => {
                        if v["type"] == "result" {
                            result = Some(v);
                            break;
                        }
                        if v["type"] == "stream_event"
                            && v["event"]["delta"]["type"] == "text_delta"
                        {
                            turn.saw_text(&a.t);
                        }
                        answer_control(&mut a, &v, o, Some(&mut turn));
                    }
                    _ if a.closed() => break,
                    _ => {}
                }
            }
            t.note("turn_end", json!({ "turn": i, "subtype": result.as_ref().map(|r| r["subtype"].clone()), "ms": turn.started.elapsed().as_millis() as u64 }));
            a.note_processes("after_turn");
        }
    }
    if o.keep_open > 0.0 {
        let s = Instant::now();
        while s.elapsed() < Duration::from_secs_f64(o.keep_open) && !a.closed() {
            if let Some(Msg::Json(v)) = a.next(Duration::from_millis(200)) {
                answer_control(&mut a, &v, o, None);
            }
        }
    }
    a.close_stdin();
    a.finish(Duration::from_secs_f64(o.exit_wait));
}

/// Waits up to a minute for the answer to control request `id`, answering the agent's own requests meanwhile.
fn await_control(a: &mut crate::agent::Agent, id: &str, o: &Common) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(60) {
        match a.next(Duration::from_millis(200)) {
            Some(Msg::Json(v))
                if v["type"] == "control_response" && v["response"]["request_id"] == id =>
            {
                break;
            }
            Some(Msg::Json(v)) => answer_control(a, &v, o, None),
            _ if a.closed() => break,
            _ => {}
        }
    }
}

fn answer_control(a: &mut crate::agent::Agent, v: &Value, o: &Common, turn: Option<&mut Turn>) {
    if v["type"] != "control_request" {
        return;
    }
    let id = v["request_id"].clone();
    let req = &v["request"];
    match req["subtype"].as_str().unwrap_or("") {
        "can_use_tool" => {
            let allow = match turn {
                Some(t) if !t.cancelled => t.decide(o.permission),
                _ => Some(false),
            };
            let Some(allow) = allow else {
                a.t.note("permission_left_open", json!({ "request_id": id }));
                return;
            };
            a.t.note(
                "permission_answer",
                json!({ "tool": req["tool_name"], "allow": allow }),
            );
            let response = if allow {
                json!({ "behavior": "allow", "updatedInput": req["input"] })
            } else {
                json!({ "behavior": "deny", "message": "The person denied this." })
            };
            a.send(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": id, "response": response } }));
        }
        other => {
            a.t.note("control_refused", json!({ "subtype": other }));
            a.send(&json!({ "type": "control_response", "response": { "subtype": "error", "request_id": id, "error": "not supported by the spike" } }));
        }
    }
}
