//! Parses `claude -p --output-format stream-json --include-partial-messages` output into neutral agent events.

use serde_json::Value;

use crate::agent::{mcp, AgentEvent};

pub fn parse_line(line: &str) -> Option<AgentEvent> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["type"].as_str()? {
        "system" if v["subtype"] == "init" => Some(AgentEvent::Started { session_id: v["session_id"].as_str()?.into() }),
        "stream_event" => {
            let e = &v["event"];
            (e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta")
                .then(|| AgentEvent::Text { text: e["delta"]["text"].as_str().unwrap_or_default().into() })
        }
        // Text arrives through deltas; complete assistant messages are only used for tool calls.
        "assistant" => v["message"]["content"]
            .as_array()?
            .iter()
            .find(|c| c["type"] == "tool_use")
            .map(|c| AgentEvent::Tool { label: tool_label(c["name"].as_str().unwrap_or("tool"), &c["input"]) }),
        "result" => {
            let ok = v["is_error"] != true && v["subtype"] == "success";
            Some(AgentEvent::Done {
                session_id: v["session_id"].as_str().map(String::from),
                ok,
                message: (!ok).then(|| v["result"].as_str().or(v["subtype"].as_str()).unwrap_or("Claude stopped").to_string()),
            })
        }
        _ => None,
    }
}

/// A short, human description of a tool call, e.g. `Read src/main.rs` or `Looked up CA-412`.
fn tool_label(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or_default();
    let short_path = |p: &str| p.rsplit('/').take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/");
    match name.rsplit("__").next().unwrap_or(name) {
        "Read" => format!("Read {}", short_path(s("file_path"))),
        "Grep" => format!("Searched the code for “{}”", s("pattern")),
        "Glob" => format!("Listed files matching {}", s("pattern")),
        "Bash" => format!("Ran {}", s("command").lines().next().unwrap_or_default()),
        other => mcp::tool_label(other, input).unwrap_or_else(|| format!("Used {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_event_types_the_panel_uses() {
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init","session_id":"s1"}"#),
            Some(AgentEvent::Started { session_id: "s1".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#),
            Some(AgentEvent::Text { text: "Hi".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/src/main.rs"}}]}}"#),
            Some(AgentEvent::Tool { label: "Read src/main.rs".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__gossamr__get_item","input":{"key":"CA-1"}}]}}"#),
            Some(AgentEvent::Tool { label: "Looked up CA-1".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}"#),
            Some(AgentEvent::Done { session_id: Some("s1".into()), ok: true, message: None })
        );
    }

    #[test]
    fn serialises_with_camel_case_fields() {
        let v = serde_json::to_value(AgentEvent::Started { session_id: "s".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "started", "sessionId": "s" }));
    }

    #[test]
    fn reports_failures_and_ignores_noise() {
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#),
            Some(AgentEvent::Done { session_id: None, ok: false, message: Some("error_max_turns".into()) })
        );
        assert_eq!(parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}"#), None);
        assert_eq!(parse_line(r#"{"type":"rate_limit_event"}"#), None);
        assert_eq!(parse_line("not json"), None);
    }
}
