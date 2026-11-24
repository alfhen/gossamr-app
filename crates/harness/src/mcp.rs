//! The transport, token and origin checks of an MCP server on loopback (streamable HTTP, JSON responses only), shared
//! by the harness's tools endpoint and the app's server.

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
fn local_request(headers: &HeaderMap, port: u16) -> bool {
    let host_ok = headers.get("host").and_then(|h| h.to_str().ok()).is_some_and(|h| is_loopback_host(h, port));
    let origin_ok = headers.get("origin").is_none_or(|o| o.to_str().is_ok_and(is_loopback_origin));
    host_ok && origin_ok
}

// Constant-time so the token can't be guessed byte by byte by another local process.
fn same_token(given: &str, token: &str) -> bool {
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}

/// The JSON-RPC message in `body`, or the status to refuse it with.
fn message(body: &Bytes) -> std::result::Result<Value, StatusCode> {
    match serde_json::from_slice::<Value>(body) {
        Ok(msg) if msg.is_object() => Ok(msg),
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

/// Answers `msg` as an MCP server with `tools`; a `tools/call` is `call`'s to answer.
async fn rpc(msg: Value, tools: impl FnOnce() -> Vec<Value>, call: impl std::future::Future<Output = Value>) -> Response {
    // Notifications carry no id and get no body.
    let Some(id) = msg.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => Ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "gossamr", "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call.await),
        _ => Err(json!({ "code": -32601, "message": "Method not found" })),
    };
    let reply = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    };
    Json(reply).into_response()
}

