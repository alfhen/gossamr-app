//! A fake `codex app-server` for the Codex driver's tests: it records every request and plays a small turn. Only test
//! builds have it (`required-features = ["testing"]`).
//!
//! `FAKE_APP_SERVER_OUT` names a folder that gets `argv.json`, `env.json` (every variable's name, and the values of
//! `CODEX_HOME` and `FAKE_APP_SERVER_*` only), `pid`, `requests.jsonl` (each line received, with every header value
//! written `<redacted>` and the token masked anywhere else) and, once a request carries a bearer token in a server's
//! `Authorization` header, `secret.json`: the variables whose value holds that token, how many arguments do, and how
//! many requests carry it in that header. The token is learned from the header, so no test writes it down.
//!
//! `app-server generate-json-schema --out <folder>` writes the three schema files the driver reads, without the names
//! `FAKE_APP_SERVER_MISSING` lists (comma-separated). `FAKE_APP_SERVER_VERSION` is the version `initialize` names
//! (0.171.0 by default). With `FAKE_APP_SERVER_WARN` set, `initialize` is followed by a `configWarning` and a
//! `deprecationNotice`. `FAKE_APP_SERVER_TURN` says what a turn does: `done` (the default) says one message, reports
//! its usage and completes; `command` starts `sleep 60` in a process group of its own, writes its pid to
//! `command.pid`, and waits for `turn/interrupt`, which leaves the sleep running, as Codex does (H0, row 3). At the
//! end of stdin it exits and leaves any sleep it started; with `FAKE_APP_SERVER_STAY` set it ignores SIGTERM and stays
//! instead, as an agent that will not stop does; with `FAKE_APP_SERVER_EXIT_ON_INTERRUPT` set, `turn/interrupt` makes it
//! exit at once, as an app-server that crashed, leaving its sleep. `background` starts, in a group of its own, a shell
//! that starts `sleep 60` a moment later, writes its pid to `inner.pid` and exits, as `npm run dev &` does: the sleep is
//! then no child of app-server's, only a member of the shell's group. `escape` starts a shell that sends this program's
//! `sleep 60` to the background in a session of its own and exits at once; once the sleep has written its pid to
//! `escaped.pid`, `item/started` follows. The sleep is then in no tree or group app-server leads to. `approval` sends the request `FAKE_APP_SERVER_APPROVAL` names, as id
//! 900, and completes the turn once it is answered.
//!
//! `sleep <seconds> [<pid file> [<child's pid file>]]` only sleeps, with no `FAKE_APP_SERVER_OUT` needed, once it has
//! written its pid to the file. With a second file it first starts a child of its own that does the same with that
//! file. Unlike Apple's `/bin/sleep`, whose environment macOS hides from other processes, it shows the harness the
//! environment it started with.

use std::io::{BufRead, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use harness::redact;
use serde_json::{Value, json};

const CLIENT: &[&str] = &["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt"];
const SERVER: &[&str] = &["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"];

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let ["sleep", seconds, ref files @ ..] = argv.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        if let [_, child] = files {
            let me = std::env::current_exe().unwrap_or_default();
            let _ = std::process::Command::new(me).args(["sleep", seconds, child]).spawn();
            let given = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !Path::new(child).exists() && std::time::Instant::now() < given {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        if let [pid_file, ..] = files {
            let written = Path::new(pid_file).with_extension("part");
            let _ = std::fs::write(&written, std::process::id().to_string()).and_then(|()| std::fs::rename(&written, pid_file));
        }
        std::thread::sleep(std::time::Duration::from_secs(seconds.parse().unwrap_or(60)));
        return ExitCode::SUCCESS;
    }
    let Some(out) = std::env::var_os("FAKE_APP_SERVER_OUT").map(PathBuf::from) else {
        eprintln!("fake-codex-app-server: FAKE_APP_SERVER_OUT must be set");
        return ExitCode::from(2);
    };
    match argv.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["app-server", "generate-json-schema", "--out", folder] => schema(Path::new(folder)),
        ["app-server"] => serve(&out, &argv),
        _ => {
            eprintln!("fake-codex-app-server: unexpected arguments");
            ExitCode::from(2)
        }
    }
}

fn schema(folder: &Path) -> ExitCode {
    let missing = std::env::var("FAKE_APP_SERVER_MISSING").unwrap_or_default();
    let listed = |names: &[&str]| {
        let entries: Vec<Value> = names.iter().filter(|name| !missing.split(',').any(|gone| gone == **name)).map(|name| json!({"properties": {"method": {"enum": [name]}}})).collect();
        json!({"oneOf": entries}).to_string()
    };
    let written = std::fs::write(folder.join("ClientRequest.json"), listed(CLIENT))
        .and_then(|()| std::fs::write(folder.join("ServerRequest.json"), listed(SERVER)))
        .and_then(|()| std::fs::write(folder.join("ServerNotification.json"), listed(&["turn/completed"])));
    if written.is_ok() { ExitCode::SUCCESS } else { ExitCode::from(1) }
}

fn serve(out: &Path, argv: &[String]) -> ExitCode {
    let stays = std::env::var_os("FAKE_APP_SERVER_STAY").is_some();
    if stays {
        // SAFETY: setting a signal's disposition to ignore runs no handler code.
        unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
    }
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let shown = |name: &str| name == "CODEX_HOME" || name.starts_with("FAKE_APP_SERVER_");
    let env: serde_json::Map<String, Value> = vars.iter().map(|(name, value)| (name.clone(), if shown(name) { Value::from(value.as_str()) } else { Value::Null })).collect();
    let mut secret: Option<String> = None;
    let shown_argv = |secrets: &[String]| Value::from(argv.iter().map(|arg| redact::text(arg, secrets)).collect::<Vec<_>>()).to_string();
    let _ = std::fs::write(out.join("argv.json"), shown_argv(&[]));
    let _ = std::fs::write(out.join("env.json"), Value::Object(env).to_string());
    let _ = std::fs::write(out.join("pid"), std::process::id().to_string());
    let Ok(mut requests) = std::fs::File::create(out.join("requests.jsonl")) else { return ExitCode::from(1) };
    let mut fake = Fake { out: out.to_owned(), turns: 0, turn: None, headers: 0 };
    let stdin = std::io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        if secret.is_none() {
            secret = bearer(&request);
            // Written again with the token masked, now that it is known.
            if let Some(token) = &secret {
                let _ = std::fs::write(out.join("argv.json"), shown_argv(std::slice::from_ref(token)));
            }
        }
        if let Some(secret) = &secret {
            fake.headers += usize::from(carries(&request, secret));
            let held = json!({
                "env": vars.iter().filter(|(_, value)| value.contains(secret.as_str())).map(|(name, _)| name).collect::<Vec<_>>(),
                "argv": argv.iter().filter(|arg| arg.contains(secret.as_str())).count(),
                "headers": fake.headers,
            });
            let _ = std::fs::write(out.join("secret.json"), held.to_string());
        }
        let _ = writeln!(requests, "{}", kept(request.clone(), &secret.iter().cloned().collect::<Vec<_>>())).and_then(|()| requests.flush());
        fake.answer(&request);
    }
    if stays {
        loop {
            std::thread::park();
        }
    }
    ExitCode::SUCCESS
}

/// The bearer token the first of a request's servers carries in its `Authorization` header.
fn bearer(request: &Value) -> Option<String> {
    let servers = request["params"]["config"]["mcp_servers"].as_object()?;
    servers.values().find_map(|server| server["http_headers"]["Authorization"].as_str()?.strip_prefix("Bearer ").map(str::to_owned))
}

/// Whether a request names `secret` as an `Authorization` header of one of its thread's servers.
fn carries(request: &Value, secret: &str) -> bool {
    let servers = request["params"]["config"]["mcp_servers"].as_object().into_iter().flatten();
    servers.into_iter().any(|(_, server)| server["http_headers"]["Authorization"].as_str().is_some_and(|header| header == format!("Bearer {secret}")))
}

/// A request as `requests.jsonl` keeps it: every header value written `<redacted>`, the secret masked anywhere else.
fn kept(mut request: Value, secrets: &[String]) -> Value {
    if let Some(servers) = request.pointer_mut("/params/config/mcp_servers").and_then(Value::as_object_mut) {
        for headers in servers.values_mut().filter_map(|server| server.get_mut("http_headers")).filter_map(Value::as_object_mut) {
            headers.values_mut().for_each(|value| *value = Value::from(redact::MASK));
        }
    }
    redact::each_string(&mut request, &mut |text| *text = redact::text(text, secrets));
    request
}

struct Fake {
    out: PathBuf,
    turns: u64,
    /// The running turn's id.
    turn: Option<String>,
    headers: usize,
}

impl Fake {
    fn say(&self, line: Value) {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{line}").and_then(|()| stdout.flush());
    }

    fn notify(&self, method: &str, params: Value) {
        self.say(json!({"method": method, "params": params}));
    }

    fn answer(&mut self, request: &Value) {
        let (id, params) = (&request["id"], &request["params"]);
        match request["method"].as_str() {
            Some("initialize") => {
                let version = std::env::var("FAKE_APP_SERVER_VERSION").unwrap_or_else(|_| "0.171.0".into());
                let agent = format!("gossamr/{version} (fake; arm64) unknown (gossamr; 0.1.0)");
                self.say(json!({"id": id, "result": {"userAgent": agent, "codexHome": "$HOME/.codex", "platformFamily": "unix", "platformOs": "macos"}}));
                if std::env::var_os("FAKE_APP_SERVER_WARN").is_some() {
                    self.notify("configWarning", json!({"summary": "A config key is unknown.", "details": "See the docs."}));
                    self.notify("deprecationNotice", json!({"summary": "An old setting is deprecated."}));
                }
            }
            Some("initialized") => {}
            Some("thread/start") => {
                self.say(json!({"id": id, "result": {"thread": {"id": "thr-fake-1"}}}));
                self.notify("thread/started", json!({"thread": {"id": "thr-fake-1"}}));
            }
            Some("thread/resume") => self.say(json!({"id": id, "result": {"thread": {"id": params["threadId"]}}})),
            Some("turn/start") => self.turn_start(id, params),
            Some("turn/interrupt") if std::env::var_os("FAKE_APP_SERVER_EXIT_ON_INTERRUPT").is_some() => std::process::exit(0),
            Some("turn/interrupt") => {
                self.say(json!({"id": id, "result": {}}));
                if let Some(turn) = self.turn.take() {
                    self.notify("turn/completed", json!({"threadId": params["threadId"], "turn": {"id": turn, "status": "interrupted"}}));
                }
            }
            Some(_) if !id.is_null() => self.say(json!({"id": id, "error": {"code": -32601, "message": "unknown method"}})),
            // The answer to the approval it asked: the turn goes on to its end.
            None if *id == 900 => {
                if let Some(turn) = self.turn.take() {
                    self.notify("turn/completed", json!({"threadId": "thr-fake-1", "turn": {"id": turn, "status": "completed"}}));
                }
            }
            _ => {}
        }
    }

    fn turn_start(&mut self, id: &Value, params: &Value) {
        self.turns += 1;
        let (n, thread) = (self.turns, params["threadId"].clone());
        let turn = format!("turn-fake-{n}");
        self.turn = Some(turn.clone());
        self.say(json!({"id": id, "result": {"turn": {"id": turn, "status": "inProgress"}}}));
        self.notify("turn/started", json!({"threadId": thread, "turn": {"id": turn}}));
        if std::env::var("FAKE_APP_SERVER_TURN").as_deref() == Ok("background") {
            let (shell, inner) = (self.out.join("shell.pid"), self.out.join("inner.pid"));
            let script = format!("echo $$ > '{}'; sleep 0.3; /bin/sleep 60 & echo $! > '{}'", shell.display(), inner.display());
            let _ = std::process::Command::new("/bin/sh").args(["-c", &script]).process_group(0).spawn();
            self.notify("item/started", json!({"threadId": thread, "turnId": turn, "item": {"type": "commandExecution", "id": format!("cmd-{n}"), "command": "sleep 60 &"}}));
            return;
        }
        if std::env::var("FAKE_APP_SERVER_TURN").as_deref() == Ok("escape") {
            let escaped = self.out.join("escaped.pid");
            let me = std::env::current_exe().unwrap_or_default();
            let script = format!("/usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' '{}' sleep 60 '{}' &", me.display(), escaped.display());
            if let Ok(mut shell) = std::process::Command::new("/bin/sh").args(["-c", &script]).process_group(0).spawn() {
                let _ = shell.wait();
            }
            // Not before the sleep runs as itself: until then it is perl, whose environment macOS hides.
            let given = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !escaped.exists() && std::time::Instant::now() < given {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            self.notify("item/started", json!({"threadId": thread, "turnId": turn, "item": {"type": "commandExecution", "id": format!("cmd-{n}"), "command": "sleep 60 &"}}));
            return;
        }
        if std::env::var("FAKE_APP_SERVER_TURN").as_deref() == Ok("approval") {
            let method = std::env::var("FAKE_APP_SERVER_APPROVAL").unwrap_or_default();
            self.say(json!({"id": 900, "method": method, "params": {"threadId": thread, "turnId": turn, "itemId": format!("item-{n}")}}));
            return;
        }
        if std::env::var("FAKE_APP_SERVER_TURN").as_deref() == Ok("command") {
            let sleep = std::process::Command::new("/bin/sleep").arg("60").process_group(0).spawn();
            if let Ok(sleep) = sleep {
                let _ = std::fs::write(self.out.join("command.pid"), sleep.id().to_string());
            }
            self.notify("item/started", json!({"threadId": thread, "turnId": turn, "item": {"type": "commandExecution", "id": format!("cmd-{n}"), "command": "sleep 60"}}));
            return;
        }
        self.notify("item/completed", json!({"threadId": thread, "turnId": turn, "item": {"type": "agentMessage", "id": format!("msg-{n}"), "text": "done"}}));
        let total = json!({"inputTokens": 100 * n, "cachedInputTokens": 40 * n, "outputTokens": 10 * n, "reasoningOutputTokens": 0, "totalTokens": 110 * n});
        let last = json!({"inputTokens": 100, "cachedInputTokens": 40, "outputTokens": 10, "reasoningOutputTokens": 0, "totalTokens": 110});
        self.notify("thread/tokenUsage/updated", json!({"threadId": thread, "turnId": turn, "tokenUsage": {"last": last, "total": total}}));
        self.turn = None;
        self.notify("turn/completed", json!({"threadId": thread, "turn": {"id": turn, "status": "completed"}}));
    }
}
