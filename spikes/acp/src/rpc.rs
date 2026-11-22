//! JSON-RPC 2.0 over newline-delimited stdio: ACP and `codex app-server` both speak it.

use crate::agent::{Agent, Msg};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub struct Rpc {
    pub a: Agent,
    next: i64,
    /// `codex app-server` leaves out `"jsonrpc":"2.0"`; ACP requires it.
    with_version: bool,
}

pub fn is_request(m: &Value) -> bool {
    m.get("method").is_some() && m.get("id").is_some()
}

pub fn is_notification(m: &Value) -> bool {
    m.get("method").is_some() && m.get("id").is_none()
}

impl Rpc {
    pub fn new(a: Agent, with_version: bool) -> Self {
        Rpc {
            a,
            next: 0,
            with_version,
        }
    }

    fn envelope(&self, mut v: Value) -> Value {
        if self.with_version {
            v["jsonrpc"] = json!("2.0");
        }
        v
    }

    pub fn request(&mut self, method: &str, params: Value) -> i64 {
        self.next += 1;
        let id = self.next;
        let v = self.envelope(json!({ "id": id, "method": method, "params": params }));
        self.a.send(&v);
        id
    }

    pub fn notify(&mut self, method: &str, params: Value) {
        let v = self.envelope(json!({ "method": method, "params": params }));
        self.a.send(&v);
    }

    pub fn respond(&mut self, id: &Value, result: Value) {
        let v = self.envelope(json!({ "id": id, "result": result }));
        self.a.send(&v);
    }

    pub fn error(&mut self, id: &Value, code: i64, message: &str) {
        let v = self.envelope(json!({ "id": id, "error": { "code": code, "message": message } }));
        self.a.send(&v);
    }

    /// Feeds every message (and a `None` tick every 200 ms) to `on` until it returns true.
    /// False when `timeout` passes or the agent closes its stdout.
    pub fn pump(
        &mut self,
        timeout: Duration,
        on: &mut dyn FnMut(&mut Rpc, Option<&Value>) -> bool,
    ) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            match self.a.next(Duration::from_millis(200)) {
                Some(Msg::Json(v)) => {
                    if on(self, Some(&v)) {
                        return true;
                    }
                }
                Some(Msg::Text(_)) => {}
                None => {
                    if self.a.closed() {
                        return false;
                    }
                    if on(self, None) {
                        return true;
                    }
                }
            }
        }
        self.a
            .t
            .note("timeout", json!({ "after_s": timeout.as_secs() }));
        false
    }

    /// Waits for the answer to request `id`. Every other message goes to `on`.
    pub fn wait(
        &mut self,
        id: i64,
        timeout: Duration,
        on: &mut dyn FnMut(&mut Rpc, Option<&Value>),
    ) -> Option<Result<Value, Value>> {
        let mut out = None;
        self.pump(timeout, &mut |rpc, m| {
            if let Some(m) = m
                && m.get("id").and_then(Value::as_i64) == Some(id)
                && m.get("method").is_none()
            {
                out = Some(match m.get("error") {
                    Some(e) => Err(e.clone()),
                    None => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
                });
                return true;
            }
            on(rpc, m);
            false
        });
        out
    }
}
