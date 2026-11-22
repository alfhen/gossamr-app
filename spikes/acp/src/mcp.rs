//! A loopback MCP server over streamable HTTP (JSON answers, no SSE) with a bearer token.
//! Tools: `ping`, and `hold` that answers after `seconds`. Every request is logged without its token.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(clap::Args, Clone)]
pub struct Opts {
    #[arg(long, default_value_t = 0)]
    port: u16,
    /// The variable holding the token every request must carry as `Authorization: Bearer <token>`.
    #[arg(long)]
    token_env: String,
    /// Request log (JSON lines).
    #[arg(long)]
    log: PathBuf,
    /// The bound port is written here.
    #[arg(long)]
    port_file: Option<PathBuf>,
    /// More tools, by name, each answering "pong from <name>" (for names that collide across servers).
    #[arg(long)]
    extra_tool: Vec<String>,
    /// Seconds the `ask` tool waits before it answers that the question is pending.
    #[arg(long, default_value_t = 20.0)]
    ask_after: f64,
}

struct Log {
    file: std::fs::File,
    start: Instant,
}

impl Log {
    fn write(&mut self, v: Value) {
        let mut v = v;
        v["ms"] = json!(self.start.elapsed().as_millis() as u64);
        let _ = writeln!(self.file, "{v}");
        let _ = self.file.flush();
    }
}

pub fn serve(o: &Opts) {
    let token = std::env::var(&o.token_env).expect("token variable set");
    let listener = TcpListener::bind(("127.0.0.1", o.port)).expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    if let Some(p) = &o.port_file {
        std::fs::write(p, port.to_string()).unwrap();
    }
    let log = Arc::new(Mutex::new(Log {
        file: std::fs::File::create(&o.log).unwrap(),
        start: Instant::now(),
    }));
    log.lock()
        .unwrap()
        .write(json!({ "event": "listening", "port": port, "pid": std::process::id() }));
    let opts = Arc::new(o.clone());
    for stream in listener.incoming().flatten() {
        let token = token.clone();
        let log = log.clone();
        let opts = opts.clone();
        std::thread::spawn(move || {
            let _ = handle(stream, &token, &log, &opts);
        });
    }
}

/// The answer the `ask` tool gives once its wait is over: what a harness `ask` returns before a provider's limit.
pub const PENDING: &str = "Question pending: the person has not answered yet. End your turn now; the answer will come as the person's next message.";

fn handle(
    mut stream: TcpStream,
    token: &str,
    log: &Arc<Mutex<Log>>,
    o: &Opts,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    loop {
        let mut request_line = String::new();
        if reader.read_line(&mut request_line)? == 0 {
            return Ok(());
        }
        let mut headers = Vec::new();
        loop {
            let mut h = String::new();
            reader.read_line(&mut h)?;
            let h = h.trim_end().to_string();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
        }
        let header = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        let len: usize = header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0; len];
        reader.read_exact(&mut body)?;
        let method = request_line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        let auth = match header("authorization") {
            None => "missing",
            Some(v) if v == format!("Bearer {token}") => "ok",
            Some(_) => "wrong",
        };
        let rpc: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        log.lock().unwrap().write(json!({
            "event": "request", "http": method, "auth": auth,
            "rpc_method": rpc["method"], "tool": rpc["params"]["name"], "args": rpc["params"]["arguments"],
            "user_agent": header("user-agent"), "header_names": headers.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
        }));
        if auth != "ok" {
            write_response(&mut stream, "401 Unauthorized", None)?;
            continue;
        }
        if method != "POST" {
            write_response(&mut stream, "405 Method Not Allowed", None)?;
            continue;
        }
        let Some(id) = rpc.get("id").cloned() else {
            write_response(&mut stream, "202 Accepted", None)?;
            continue;
        };
        let result = match rpc["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": rpc["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "spike", "version": "0.1.0" }
            }),
            "tools/list" => {
                let mut tools = vec![
                    json!({ "name": "ping", "description": "Answers pong.", "inputSchema": { "type": "object", "properties": {} } }),
                    json!({ "name": "hold", "description": "Waits the given number of seconds, then answers.", "inputSchema": { "type": "object", "properties": { "seconds": { "type": "number" } }, "required": ["seconds"] } }),
                    json!({ "name": "ask", "description": "Asks the person a question and waits for the answer.", "inputSchema": { "type": "object", "properties": { "question": { "type": "string" } }, "required": ["question"] } }),
                ];
                for t in &o.extra_tool {
                    tools.push(json!({ "name": t, "description": "Answers pong with its own name.", "inputSchema": { "type": "object", "properties": {} } }));
                }
                json!({ "tools": tools })
            }
            "tools/call" => match rpc["params"]["name"].as_str() {
                Some("ping") => json!({ "content": [{ "type": "text", "text": "pong" }] }),
                Some("hold") => {
                    let secs = rpc["params"]["arguments"]["seconds"]
                        .as_f64()
                        .unwrap_or(1.0);
                    log.lock()
                        .unwrap()
                        .write(json!({ "event": "hold_start", "seconds": secs }));
                    std::thread::sleep(Duration::from_secs_f64(secs));
                    json!({ "content": [{ "type": "text", "text": format!("held {secs} s") }] })
                }
                Some("ask") => {
                    log.lock().unwrap().write(json!({ "event": "ask_start", "question": rpc["params"]["arguments"]["question"] }));
                    std::thread::sleep(Duration::from_secs_f64(o.ask_after));
                    json!({ "content": [{ "type": "text", "text": PENDING }] })
                }
                Some(t) if o.extra_tool.iter().any(|x| x == t) => {
                    json!({ "content": [{ "type": "text", "text": format!("pong from {t}") }] })
                }
                _ => {
                    json!({ "content": [{ "type": "text", "text": "no such tool" }], "isError": true })
                }
            },
            "ping" => json!({}),
            _ => {
                let body = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } });
                write_response(&mut stream, "200 OK", Some(&body))?;
                continue;
            }
        };
        let body = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        let written = write_response(&mut stream, "200 OK", Some(&body));
        if rpc["params"]["name"] == "hold" {
            log.lock().unwrap().write(json!({ "event": "hold_answered", "written": written.is_ok(), "error": written.as_ref().err().map(|e| e.to_string()) }));
        }
        written?;
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    body: Option<&Value>,
) -> std::io::Result<()> {
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let ctype = if body.is_empty() {
        ""
    } else {
        "Content-Type: application/json\r\n"
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\n{ctype}Content-Length: {}\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}
