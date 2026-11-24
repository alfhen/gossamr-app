//! The transport, token and origin checks of an MCP server on loopback (streamable HTTP, JSON responses only), shared
//! by the harness's tools endpoint and the app's server.

use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

fn is_loopback_host(host: &str, port: u16) -> bool {
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")].iter().any(|h| h.eq_ignore_ascii_case(host))
}

fn is_loopback_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://") else { return false };
    let host = rest.split([':', '/']).next().unwrap_or_default();
    host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost")
}

/// A browser page can be made to post here; the Host check stops DNS rebinding and an Origin that isn't loopback stops
/// the page itself. The CLI sends neither a foreign Host nor a foreign Origin.
pub fn local_request(headers: &HeaderMap, port: u16) -> bool {
    let host_ok = headers.get("host").and_then(|h| h.to_str().ok()).is_some_and(|h| is_loopback_host(h, port));
    let origin_ok = headers.get("origin").is_none_or(|o| o.to_str().is_ok_and(is_loopback_origin));
    host_ok && origin_ok
}

// Constant-time so the token can't be guessed byte by byte by another local process.
pub fn same_token(given: &str, token: &str) -> bool {
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}

/// The JSON-RPC message in `body`, or the status to refuse it with.
pub fn message(body: &[u8]) -> std::result::Result<Value, StatusCode> {
    match serde_json::from_slice::<Value>(body) {
        Ok(msg) if msg.is_object() => Ok(msg),
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

/// Who answers `initialize`.
#[derive(Debug, Clone, Copy)]
pub struct ServerInfo<'a> {
    pub name: &'a str,
    pub version: &'a str,
}

/// What an MCP request gets back: no body for a notification, else a JSON-RPC reply.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Accepted,
    Reply(Value),
}

impl Answer {
    pub fn status(&self) -> StatusCode {
        match self {
            Answer::Accepted => StatusCode::ACCEPTED,
            Answer::Reply(_) => StatusCode::OK,
        }
    }
}

/// Answers `msg` as an MCP server with `tools`; a `tools/call` is `call`'s to answer, with a result or a JSON-RPC error.
pub async fn rpc(msg: Value, info: ServerInfo<'_>, tools: impl FnOnce() -> Vec<Value>, call: impl Future<Output = Result<Value, Value>>) -> Answer {
    // Notifications carry no id and get no body.
    let Some(id) = msg.get("id").cloned() else {
        return Answer::Accepted;
    };
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => Ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": info.name, "version": info.version }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call.await,
        _ => Err(json!({ "code": -32601, "message": "Method not found" })),
    };
    Answer::Reply(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        pairs.iter().map(|(name, value)| (http::HeaderName::from_static(name), value.parse().unwrap())).collect()
    }

    #[test]
    fn tools_endpoint_a_request_from_a_web_page_or_for_another_host_is_refused() {
        for host in ["127.0.0.1:4000", "localhost:4000", "LOCALHOST:4000"] {
            assert!(local_request(&headers(&[("host", host)]), 4000), "{host}");
            assert!(local_request(&headers(&[("host", host), ("origin", "http://127.0.0.1:9")]), 4000), "{host}");
        }
        // A rebinding page reaches loopback under its own name; the port must be this server's too.
        for host in ["evil.example:4000", "127.0.0.1:4001", "127.0.0.1", "localhost.evil.example:4000", "0.0.0.0:4000", "[::1]:4000"] {
            assert!(!local_request(&headers(&[("host", host)]), 4000), "{host}");
        }
        assert!(!local_request(&HeaderMap::new(), 4000), "no Host");
        for origin in ["https://evil.example", "http://evil.example", "null", "http://127.0.0.1.evil.example", "https://localhost", "file://"] {
            assert!(!local_request(&headers(&[("host", "127.0.0.1:4000"), ("origin", origin)]), 4000), "{origin}");
        }
    }

    #[test]
    fn tools_endpoint_the_token_compare_takes_only_the_same_token() {
        assert!(same_token("abc", "abc"));
        for other in ["abd", "ab", "abcd", ""] {
            assert!(!same_token(other, "abc"), "{other}");
        }
        assert_eq!(bearer(&headers(&[("authorization", "Bearer t")])), Some("t"));
        assert_eq!(bearer(&headers(&[("authorization", "Basic t")])), None);
    }

    #[tokio::test]
    async fn tools_endpoint_a_notification_gets_no_body_and_an_unknown_method_an_error() {
        let info = ServerInfo { name: "n", version: "1" };
        let none = || -> Vec<Value> { vec![] };
        assert_eq!(rpc(json!({"method": "notifications/initialized"}), info, none, async { Ok(json!({})) }).await, Answer::Accepted);
        let Answer::Reply(reply) = rpc(json!({"id": 3, "method": "resources/list"}), info, none, async { Ok(json!({})) }).await else { panic!() };
        assert_eq!(reply["error"]["code"], -32601);
        assert_eq!(message(b"[1]"), Err(StatusCode::BAD_REQUEST), "a batch is refused");
    }
}
