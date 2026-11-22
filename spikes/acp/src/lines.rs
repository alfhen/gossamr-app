//! Drivers with no request/response protocol: `agy -p` stream-json, and one-shot commands.

use crate::agent::Msg;
use crate::{Common, Turn};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn is_text(v: &Value) -> bool {
    let kind = v
        .get("event")
        .or_else(|| v.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    kind.contains("text") || kind.contains("message") && !kind.contains("user")
}

/// `agy -p --input-format stream-json --output-format stream-json`: one user event per prompt.
/// A turn ends at an event named `result`. Cancel is SIGINT, since the stream has no cancel message.
pub fn agy_stream(o: &Common) {
    let t = o.transcript();
    let mut a = o.spawn(t.clone());
    for (i, p) in o.prompt.iter().enumerate() {
        let mut turn = Turn::new(i, o);
        a.send(&json!({ "event": "user", "message": { "content": p } }));
        let mut ended = None;
        while turn.started.elapsed() < Duration::from_secs_f64(o.turn_timeout) {
            if turn.due_to_cancel() {
                turn.cancelled = true;
                a.signal(libc::SIGINT);
            }
            match a.next(Duration::from_millis(200)) {
                Some(Msg::Json(v)) => {
                    let kind = v
                        .get("event")
                        .or_else(|| v.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if kind == "result" {
                        ended = Some(v);
                        break;
                    }
                    if is_text(&v) {
                        turn.saw_text(&a.t);
                    }
                }
                _ if a.closed() => break,
                _ => {}
            }
        }
        t.note("turn_end", json!({ "turn": i, "result": ended.is_some(), "ms": turn.started.elapsed().as_millis() as u64 }));
        a.note_processes("after_turn");
    }
    if o.keep_open > 0.0 {
        let s = Instant::now();
        while s.elapsed() < Duration::from_secs_f64(o.keep_open) && !a.closed() {
            let _ = a.next(Duration::from_millis(200));
        }
    }
    a.close_stdin();
    a.finish(Duration::from_secs_f64(o.exit_wait));
}

/// A one-shot command. stdin is closed at once; `--cancel-after` sends SIGINT.
pub fn raw(o: &Common) {
    let t = o.transcript();
    let mut a = o.spawn(t.clone());
    a.close_stdin();
    let mut turn = Turn::new(0, o);
    let mut counted = false;
    while turn.started.elapsed() < Duration::from_secs_f64(o.turn_timeout) && !a.closed() {
        if turn.due_to_cancel() {
            turn.cancelled = true;
            a.note_processes("before_cancel");
            a.signal(libc::SIGINT);
        }
        if let Some(Msg::Json(v)) = a.next(Duration::from_millis(200)) {
            if is_text(&v) || v["item"]["type"] == "agent_message" {
                turn.saw_text(&a.t);
            }
            if !counted && turn.started.elapsed() > Duration::from_secs(3) {
                counted = true;
                a.note_processes("running");
            }
        }
    }
    t.note(
        "turn_end",
        json!({ "turn": 0, "ms": turn.started.elapsed().as_millis() as u64 }),
    );
    a.finish(Duration::from_secs_f64(o.exit_wait));
}
