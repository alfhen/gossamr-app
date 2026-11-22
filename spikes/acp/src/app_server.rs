//! `codex app-server` over stdio: initialize, a thread, turns, approvals answered by the driver.

use crate::rpc::{Rpc, is_notification, is_request};
use crate::{Common, Turn};
use serde_json::{Map, Value, json};
use std::time::Duration;

pub fn run(o: &Common) {
    let t = o.transcript();
    let mut rpc = Rpc::new(o.spawn(t.clone()), false);
    let setup = Duration::from_secs(120);

    let init = rpc.request("initialize", json!({ "clientInfo": { "name": "acp_spike", "title": "acp-spike", "version": env!("CARGO_PKG_VERSION") } }));
    if !matches!(rpc.wait(init, setup, &mut |_, _| {}), Some(Ok(_))) {
        t.note("initialize_failed", json!(null));
        rpc.a.finish(Duration::from_secs(5));
        return;
    }
    rpc.notify("initialized", json!({}));

    if o.list_only {
        for (method, params) in [
            ("model/list", json!({})),
            ("account/read", json!({ "refreshToken": false })),
            ("config/read", json!({})),
            ("mcpServerStatus/list", json!({})),
            ("skills/list", json!({})),
            ("hooks/list", json!({})),
        ] {
            let r = rpc.request(method, params);
            rpc.wait(r, setup, &mut |_, _| {});
        }
    }

    let mut config = Map::new();
    if let Some(url) = &o.mcp_url {
        let mut server = json!({ "url": url, "default_tools_approval_mode": "approve" });
        // A token variable the driver does not pass on (MCP_*) goes over stdin as a header, so the agent's
        // environment never holds it; any other name is handed to codex by name.
        match (&o.mcp_token_env, o.mcp_token()) {
            (Some(name), Some(tok)) if name.starts_with("MCP_") => {
                server["http_headers"] = json!({ "Authorization": format!("Bearer {tok}") })
            }
            (Some(name), _) => server["bearer_token_env_var"] = json!(name),
            _ => {}
        }
        if let Some(s) = o.mcp_tool_timeout {
            server["tool_timeout_sec"] = json!(s);
        }
        config.insert("mcp_servers".into(), json!({ "spike": server }));
    }
    // `thread.KEY=json` and `turn.KEY=json` go into the thread/start (or resume) and turn/start parameters;
    // anything else is a config override. A `sandbox_mode` override makes app-server write project trust to
    // $CODEX_HOME/config.toml (0.171.0), so a sandbox for a check goes in as `thread.sandbox` instead.
    let parse = |v: &str| serde_json::from_str(v).unwrap_or_else(|_| json!(v));
    let mut thread_extra = Map::new();
    let mut turn_extra = Map::new();
    for kv in &o.set_config {
        if let Some((k, v)) = kv.split_once('=') {
            if let Some(k) = k.strip_prefix("thread.") {
                thread_extra.insert(k.into(), parse(v));
            } else if let Some(k) = k.strip_prefix("turn.") {
                turn_extra.insert(k.into(), parse(v));
            } else {
                config.insert(k.into(), parse(v));
            }
        }
    }
    let mut params = json!({ "cwd": o.cwd });
    for (k, v) in thread_extra {
        params[k] = v;
    }
    if !config.is_empty() {
        params["config"] = Value::Object(config);
    }
    if let Some(m) = &o.model {
        params["model"] = json!(m);
    }
    if let Some(mode) = &o.mode {
        params["approvalPolicy"] = json!(mode);
    }
    let (method, params) = match &o.resume {
        Some(id) => {
            params["threadId"] = json!(id);
            ("thread/resume", params)
        }
        None => ("thread/start", params),
    };
    let r = rpc.request(method, params);
    let thread = match rpc.wait(r, setup, &mut |rpc, m| side(rpc, m, o, None)) {
        Some(Ok(v)) => v,
        other => {
            t.note("thread_failed", json!({ "answer": other.map(|r| r.err()) }));
            rpc.a.close_stdin();
            rpc.a.finish(Duration::from_secs(10));
            return;
        }
    };
    let tid = thread["thread"]["id"]
        .as_str()
        .map(String::from)
        .or_else(|| o.resume.clone())
        .unwrap_or_default();
    t.note("thread", json!({ "id": tid, "method": method }));
    rpc.a.note_processes("after_thread");

    if !o.list_only {
        for (i, p) in o.prompt.iter().enumerate() {
            let mut turn = Turn::new(i, o);
            let mut params = json!({ "threadId": tid, "input": [{ "type": "text", "text": p }] });
            if let Some(e) = &o.effort {
                params["effort"] = json!(e);
            }
            for (k, v) in &turn_extra {
                params[k.as_str()] = v.clone();
            }
            let r = rpc.request("turn/start", params);
            let mut turn_id: Option<String> = None;
            let mut done = None;
            rpc.pump(Duration::from_secs_f64(o.turn_timeout), &mut |rpc, m| {
                if turn.due_to_cancel()
                    && let Some(tu) = &turn_id
                {
                    turn.cancelled = true;
                    rpc.request("turn/interrupt", json!({ "threadId": tid, "turnId": tu }));
                }
                let Some(m) = m else { return false };
                if m["id"].as_i64() == Some(r) && m.get("method").is_none() {
                    turn_id = m["result"]["turn"]["id"].as_str().map(String::from);
                    if m.get("error").is_some() {
                        done = Some(m.clone());
                        return true;
                    }
                }
                if m["method"] == "turn/completed" {
                    done = Some(m["params"].clone());
                    return true;
                }
                side(rpc, Some(m), o, Some(&mut turn));
                false
            });
            t.note("turn_end", json!({ "turn": i, "completed": done.map(|d| d["turn"]["status"].clone()), "ms": turn.started.elapsed().as_millis() as u64 }));
            rpc.a.note_processes("after_turn");
        }
    }
    if o.keep_open > 0.0 {
        rpc.pump(Duration::from_secs_f64(o.keep_open), &mut |rpc, m| {
            side(rpc, m, o, None);
            false
        });
    }
    rpc.a.close_stdin();
    rpc.a.finish(Duration::from_secs_f64(o.exit_wait));
}

fn side(rpc: &mut Rpc, m: Option<&Value>, o: &Common, turn: Option<&mut Turn>) {
    let Some(m) = m else { return };
    if is_notification(m) {
        if m["method"] == "item/agentMessage/delta"
            && let Some(turn) = turn
        {
            turn.saw_text(&rpc.a.t);
        }
        return;
    }
    if !is_request(m) {
        return;
    }
    let id = m["id"].clone();
    let method = m["method"].as_str().unwrap_or("").to_string();
    let approval = method.ends_with("requestApproval")
        || method == "applyPatchApproval"
        || method == "execCommandApproval";
    if approval {
        let allow = match turn {
            Some(turn) => turn.decide(o.permission),
            None => Some(false),
        };
        let Some(allow) = allow else {
            rpc.a.t.note("permission_left_open", json!({ "id": id }));
            return;
        };
        let decision = match (method.as_str(), allow) {
            ("applyPatchApproval" | "execCommandApproval", true) => json!("approved"),
            ("applyPatchApproval" | "execCommandApproval", false) => json!("denied"),
            ("item/permissions/requestApproval", true) => json!("accept"),
            (_, true) => json!("accept"),
            (_, false) => json!("decline"),
        };
        rpc.a.t.note(
            "permission_answer",
            json!({ "method": method, "allow": allow }),
        );
        rpc.respond(&id, json!({ "decision": decision }));
        return;
    }
    rpc.a
        .t
        .note("client_method_refused", json!({ "method": method }));
    rpc.error(&id, -32601, "not supported by the spike");
}
