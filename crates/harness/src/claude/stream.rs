//! Parses `claude -p --output-format stream-json --include-partial-messages` output into the lines Pip's turn uses.

use serde_json::Value;

/// What one line of the stream says, for Pip's turn.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Started { session_id: String },
    Text { text: String },
    /// A tool call; the app words it for the person.
    Tool { name: String, input: Value },
    Done { session_id: Option<String>, ok: bool, message: Option<String>, usage: Option<Usage> },
}

/// The tokens and money one turn used, as its `result` reports them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: Option<f64>,
}

pub fn parse_line(line: &str) -> Option<Line> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["type"].as_str()? {
        "system" if v["subtype"] == "init" => Some(Line::Started { session_id: v["session_id"].as_str()?.into() }),
        "stream_event" => {
            let e = &v["event"];
            (e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta")
                .then(|| Line::Text { text: e["delta"]["text"].as_str().unwrap_or_default().into() })
        }
        // Text arrives through deltas; complete assistant messages are only used for tool calls.
        "assistant" => v["message"]["content"]
            .as_array()?
            .iter()
            .find(|c| c["type"] == "tool_use")
            .map(|c| Line::Tool { name: c["name"].as_str().unwrap_or("tool").into(), input: c["input"].clone() }),
        "result" => {
            let ok = v["is_error"] != true && v["subtype"] == "success";
            Some(Line::Done {
                session_id: v["session_id"].as_str().map(String::from),
                ok,
                message: (!ok).then(|| v["result"].as_str().or(v["subtype"].as_str()).unwrap_or("Claude stopped").to_string()),
                usage: usage_of(&v),
            })
        }
        _ => None,
    }
}

/// The tokens a result reports, and its cost. A result without readable token counts has none, whatever its cost says.
pub fn usage_of(result: &Value) -> Option<Usage> {
    let u = result["usage"].as_object()?;
    let count = |k: &str| match u.get(k) {
        None | Some(Value::Null) => Some(0),
        Some(n) => n.as_u64(),
    };
    Some(Usage {
        input_tokens: u.get("input_tokens")?.as_u64()?,
        output_tokens: u.get("output_tokens")?.as_u64()?,
        cache_creation_tokens: count("cache_creation_input_tokens")?,
        cache_read_tokens: count("cache_read_input_tokens")?,
        cost_usd: result["total_cost_usd"].as_f64().filter(|c| c.is_finite() && *c >= 0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_event_types_the_panel_uses() {
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init","session_id":"s1"}"#),
            Some(Line::Started { session_id: "s1".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#),
            Some(Line::Text { text: "Hi".into() })
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/src/main.rs"}}]}}"#),
            Some(Line::Tool { name: "Read".into(), input: serde_json::json!({ "file_path": "/a/b/src/main.rs" }) })
        );
        assert_eq!(
            parse_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__gossamr__get_item","input":{"key":"CA-1"}}]}}"#),
            Some(Line::Tool { name: "mcp__gossamr__get_item".into(), input: serde_json::json!({ "key": "CA-1" }) })
        );
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}"#),
            Some(Line::Done { session_id: Some("s1".into()), ok: true, message: None, usage: None })
        );
    }

    #[test]
    fn reports_failures_and_ignores_noise() {
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#),
            Some(Line::Done { session_id: None, ok: false, message: Some("error_max_turns".into()), usage: None })
        );
        assert_eq!(parse_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}"#), None);
        assert_eq!(parse_line(r#"{"type":"rate_limit_event"}"#), None);
        assert_eq!(parse_line("not json"), None);
    }

    fn usage(input: u64, output: u64, creation: u64, read: u64, cost: Option<f64>) -> Option<Usage> {
        Some(Usage { input_tokens: input, output_tokens: output, cache_creation_tokens: creation, cache_read_tokens: read, cost_usd: cost })
    }

    fn usage_in(line: &str) -> Option<Usage> {
        match parse_line(line) {
            Some(Line::Done { usage, .. }) => usage,
            other => panic!("not a result: {other:?}"),
        }
    }

    #[test]
    fn a_successful_result_carries_its_usage_and_cost() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.0123,
            "usage":{"input_tokens":120,"output_tokens":45,"cache_creation_input_tokens":300,"cache_read_input_tokens":900}}"#;
        assert_eq!(
            parse_line(line),
            Some(Line::Done { session_id: Some("s1".into()), ok: true, message: None, usage: usage(120, 45, 300, 900, Some(0.0123)) })
        );
    }

    #[test]
    fn a_failed_result_keeps_its_usage() {
        let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"usage":{"input_tokens":7,"output_tokens":2}}"#;
        assert_eq!(
            parse_line(line),
            Some(Line::Done { session_id: None, ok: false, message: Some("error_max_turns".into()), usage: usage(7, 2, 0, 0, None) })
        );
    }

    #[test]
    fn a_result_without_usage_has_none() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.5}"#;
        assert_eq!(usage_in(line), None);
    }

    #[test]
    fn malformed_usage_reads_as_none_without_panicking() {
        for usage in [
            r#""lots""#,
            r#"[1,2]"#,
            r#"{"input_tokens":"12","output_tokens":3}"#,
            r#"{"input_tokens":-1,"output_tokens":3}"#,
            r#"{"output_tokens":3}"#,
            r#"{"input_tokens":1,"output_tokens":3,"cache_read_input_tokens":"x"}"#,
            r#"null"#,
        ] {
            let line = format!(r#"{{"type":"result","subtype":"success","is_error":false,"usage":{usage}}}"#);
            assert_eq!(usage_in(&line), None, "{usage}");
        }
        let odd_cost = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":"free","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":null}}"#;
        assert_eq!(usage_in(odd_cost), usage(1, 2, 0, 0, None));
    }
}
