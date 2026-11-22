//! The agent process: spawned with piped stdio, every line recorded as it arrives.

use crate::transcript::{Dir, Transcript};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

pub enum Msg {
    Json(Value),
    Text(String),
}

pub struct Agent {
    pub child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Option<String>>,
    pub t: Transcript,
    stdout_closed: bool,
}

pub fn inherited_from_host(name: &str) -> bool {
    [
        "CLAUDE",
        "ANTHROPIC_",
        "MCP_",
        "AI_AGENT",
        "CODEX_",
        "OPENAI_",
    ]
    .iter()
    .any(|p| name.starts_with(p))
}

pub fn spawn(
    command: &[String],
    cwd: &Path,
    env: &[(String, String)],
    remove: &[String],
    t: Transcript,
) -> std::io::Result<Agent> {
    let (program, args) = command.split_first().expect("a command after --");
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Run from inside a Claude Code session, the driver inherits that session's own variables (its API proxy,
    // a messaging token, account ids). A harness starts agents from the person's shell, so they are dropped.
    for (k, _) in std::env::vars() {
        if inherited_from_host(&k) {
            cmd.env_remove(&k);
        }
    }
    for k in remove {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn()?;
    t.note(
        "spawned",
        json!({ "pid": child.id(), "driver_pid": std::process::id(), "argv": command, "cwd": cwd }),
    );
    let stdin = child.stdin.take();
    let (tx, rx) = channel();
    let out = child.stdout.take().unwrap();
    let t_out = t.clone();
    let tx_out = tx.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            t_out.line(Dir::FromAgent, &line);
            if tx_out.send(Some(line)).is_err() {
                break;
            }
        }
        let _ = tx_out.send(None);
    });
    let err = child.stderr.take().unwrap();
    let t_err = t.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(err).lines() {
            let Ok(line) = line else { break };
            t_err.record(Dir::Stderr, &Value::String(line));
        }
    });
    Ok(Agent {
        child,
        stdin,
        rx,
        t,
        stdout_closed: false,
    })
}

impl Agent {
    pub fn send(&mut self, v: &Value) {
        self.t.record(Dir::ToAgent, v);
        match self.stdin.as_mut() {
            Some(s) => {
                if let Err(e) = writeln!(s, "{v}").and_then(|_| s.flush()) {
                    self.t.note("write_failed", json!(e.to_string()));
                }
            }
            None => self.t.note("write_after_close", json!(null)),
        }
    }

    /// The next stdout message, or None on timeout or end of stream.
    pub fn next(&mut self, timeout: Duration) -> Option<Msg> {
        if self.stdout_closed {
            return None;
        }
        match self.rx.recv_timeout(timeout) {
            Ok(Some(line)) => Some(match serde_json::from_str(&line) {
                Ok(v) => Msg::Json(v),
                Err(_) => Msg::Text(line),
            }),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                self.stdout_closed = true;
                self.t.note("stdout_closed", json!(null));
                None
            }
            Err(RecvTimeoutError::Timeout) => None,
        }
    }

    pub fn closed(&self) -> bool {
        self.stdout_closed
    }

    pub fn signal(&self, sig: i32) {
        self.t
            .note("signal", json!({ "sig": sig, "pid": self.child.id() }));
        unsafe {
            libc::kill(self.child.id() as i32, sig);
        }
    }

    pub fn close_stdin(&mut self) {
        self.t.note("close_stdin", json!(null));
        self.stdin = None;
    }

    /// Waits for the agent to exit by itself; kills it after `timeout` and says so.
    pub fn finish(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let start = Instant::now();
        loop {
            if let Ok(Some(st)) = self.child.try_wait() {
                self.t.note("exited", json!({ "status": st.to_string(), "after_ms": start.elapsed().as_millis() as u64 }));
                return Some(st);
            }
            if start.elapsed() > timeout {
                self.t.note(
                    "still_running_killing",
                    json!({ "after_ms": start.elapsed().as_millis() as u64 }),
                );
                self.signal(libc::SIGTERM);
                std::thread::sleep(Duration::from_secs(3));
                if let Ok(None) = self.child.try_wait() {
                    self.signal(libc::SIGKILL);
                }
                let st = self.child.wait().ok();
                self.t
                    .note("exited", json!({ "status": st.map(|s| s.to_string()) }));
                return None;
            }
            // Drain stdout so a chatty agent never blocks on a full pipe while it shuts down.
            let _ = self.next(Duration::from_millis(100));
        }
    }

    /// Pids of the agent's descendants right now (`pgrep -P`, recursively), for the process count.
    pub fn descendants(&self) -> Vec<(u32, String)> {
        fn kids(pid: u32, out: &mut Vec<(u32, String)>) {
            let Ok(o) = Command::new("pgrep")
                .arg("-P")
                .arg(pid.to_string())
                .output()
            else {
                return;
            };
            for p in String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .filter_map(|s| s.parse::<u32>().ok())
            {
                let comm = Command::new("ps")
                    .args(["-o", "comm=", "-p", &p.to_string()])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                    .unwrap_or_default();
                out.push((p, comm));
                kids(p, out);
            }
        }
        let mut out = Vec::new();
        kids(self.child.id(), &mut out);
        out
    }

    pub fn note_processes(&self, when: &str) {
        let d = self.descendants();
        self.t.note("processes", json!({ "when": when, "agent_pid": self.child.id(), "descendants": d.iter().map(|(p, c)| json!({"pid": p, "comm": c})).collect::<Vec<_>>() }));
    }
}
