//! Runs the user's installed Claude Code headlessly for the Ask Claude panel.

pub mod mcp;
pub mod sessions;
pub mod stream;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::error::{Error, Result};
use crate::inbox::Core;
use mcp::McpServer;
use stream::{parse_line, ClaudeEvent};

const RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// Pinned rather than inherited from the user's Claude Code default, which may be a slower, costlier model.
const MODEL: &str = "sonnet";
const EFFORT: &str = "medium";

/// Built-in tools Claude may use. With `--permission-mode dontAsk`, anything outside `ALLOWED` is refused, so it can
/// read the repo and git history but not edit files or run other commands.
const TOOLS: &str = "Read,Grep,Glob,Bash";
const ALLOWED: &str = "mcp__jira-inbox,Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(git branch:*)";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub request_id: String,
    pub ticket_key: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub request_id: String,
    #[serde(flatten)]
    pub event: ClaudeEvent,
}

pub type UpdateSink = Arc<dyn Fn(Update) + Send + Sync>;

pub struct Claude {
    core: Arc<Core>,
    mcp: McpServer,
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl Claude {
    pub fn new(core: Arc<Core>, mcp: McpServer) -> Self {
        Self { core, mcp, running: Mutex::new(HashMap::new()) }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(tx) = self.running.lock().expect("lock poisoned").remove(request_id) {
            let _ = tx.send(());
        }
    }

    pub async fn ask(self: &Arc<Self>, req: AskRequest, sink: UpdateSink) -> Result<()> {
        let binary = find_claude().ok_or_else(|| {
            Error::Claude("Claude Code isn't installed, or isn't on your PATH. Install it from code.claude.com.".into())
        })?;
        let scope = self.core.scope().await?;
        let ticket = self.core.ticket(&scope, &req.ticket_key).await?;
        let cwd = req
            .cwd
            .clone()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .or_else(dirs::home_dir)
            .ok_or_else(|| Error::Claude("no working folder for Claude".into()))?;

        let mut cmd = Command::new(binary);
        cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
            .args(["--model", MODEL, "--effort", EFFORT])
            .args(["--permission-mode", "dontAsk", "--tools", TOOLS, "--allowedTools", ALLOWED])
            .args(["--strict-mcp-config", "--mcp-config", &self.mcp.config_json(&req.request_id)])
            .args(["--append-system-prompt", &system_prompt(&req.ticket_key)]);
        if let Some(id) = &req.session_id {
            cmd.args(["--resume", id]);
        }
        // Launched from inside a Claude Code session, the child would otherwise think it's nested.
        cmd.current_dir(&cwd)
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;

        // The prompt goes through stdin so long ticket context never hits argument limits or shell quoting.
        let mut stdin = child.stdin.take().expect("piped");
        let prompt = format!("{}\n\n{}", ticket_context(&ticket), req.prompt.trim());
        stdin.write_all(prompt.as_bytes()).await?;

        // Registered before stdin closes, since Claude starts work (and may call the MCP tools) on EOF.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.running.lock().expect("lock poisoned").insert(req.request_id.clone(), cancel_tx);
        self.mcp.runs.lock().expect("lock poisoned").insert(req.request_id.clone(), scope);
        drop(stdin);

        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let request_id = req.request_id.clone();
            let emit = |event: ClaudeEvent| sink(Update { request_id: request_id.clone(), event });
            let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();
            let stderr = child.stderr.take().expect("piped");
            let stderr_tail = tauri::async_runtime::spawn(async move {
                let mut tail = String::new();
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    tail = l;
                }
                tail
            });

            let mut session: Option<String> = None;
            let mut finished = false;
            let read = async {
                while let Ok(Some(line)) = lines.next_line().await {
                    let Some(ev) = parse_line(&line) else { continue };
                    match &ev {
                        ClaudeEvent::Started { session_id } => session = Some(session_id.clone()),
                        ClaudeEvent::Done { session_id, .. } => {
                            session = session_id.clone().or(session.take());
                            finished = true;
                        }
                        _ => {}
                    }
                    emit(ev);
                }
            };
            let outcome = tokio::select! {
                _ = read => None,
                _ = cancel_rx => Some("Stopped"),
                _ = tokio::time::sleep(RUN_TIMEOUT) => Some("Claude took longer than 10 minutes and was stopped"),
            };
            if outcome.is_some() {
                let _ = child.kill().await;
            }
            let _ = child.wait().await;
            if !finished {
                let tail = stderr_tail.await.unwrap_or_default();
                let message = outcome.map(String::from).unwrap_or(if tail.is_empty() { "Claude exited unexpectedly".into() } else { tail });
                emit(ClaudeEvent::Done { session_id: session.clone(), ok: false, message: Some(message) });
            }
            if let Some(id) = session {
                let _ = this.core.remember_claude_session(&req.ticket_key, &id, &cwd.to_string_lossy()).await;
            }
            this.running.lock().expect("lock poisoned").remove(&request_id);
            this.mcp.runs.lock().expect("lock poisoned").remove(&request_id);
        });
        Ok(())
    }
}

fn system_prompt(key: &str) -> String {
    format!(
        "You are running inside Jira Inbox, a desktop Jira client, helping the user with {key}. \
         Read Jira with the jira-inbox tools (get_ticket, search_tickets, list_transitions). \
         You cannot change Jira yourself. When a comment, a transition or subtasks would help, call propose_comment, \
         propose_transition or propose_subtasks; each becomes a card the user approves, edits or skips, so never say it \
         has been done. You can read files in the working folder and run read-only git commands. \
         Keep replies short and specific, and write comments in the user's voice."
    )
}

fn ticket_context(t: &crate::model::CachedTicket) -> String {
    format!("[Jira ticket {}]\n{}\n\n[Request]", t.key, mcp::describe(t))
}

/// GUI apps on macOS don't inherit the shell PATH, so look where installers put `claude` before asking a login shell.
fn find_claude() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    if let Some(found) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    let out = std::process::Command::new("/bin/zsh").args(["-lc", "command -v claude"]).output().ok()?;
    let path = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Auth;
    use crate::jira::Jira;

    /// Runs the real `claude` CLI against the MCP server and checks a proposal comes back.
    /// Needs Claude Code installed and logged in: `cargo test -- --ignored claude_can_propose`.
    #[tokio::test]
    #[ignore]
    async fn claude_can_propose_through_the_mcp_server() {
        let http = reqwest::Client::new();
        let auth = Arc::new(Auth::load(http.clone()));
        let core = Arc::new(Core::new(auth.clone(), Jira::new(http, auth), std::env::temp_dir()));
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink_got = got.clone();
        let server = McpServer::start(core, "t0ken".into(), Arc::new(move |p| sink_got.lock().unwrap().push(p)))
            .await
            .unwrap();
        let scope = crate::auth::Scope { cloud_id: "test".into(), account_id: "test".into() };
        server.runs.lock().unwrap().insert("req-1".into(), scope);

        let mut cmd = Command::new(find_claude().expect("claude on PATH"));
        cmd.args(["-p", "--output-format", "stream-json", "--verbose"])
            .args(["--permission-mode", "dontAsk", "--tools", TOOLS, "--allowedTools", ALLOWED])
            .args(["--strict-mcp-config", "--mcp-config", &server.config_json("req-1")])
            .env_remove("CLAUDECODE")
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(b"Call the propose_comment tool once with key TEST-1 and body \"Looks good\". Then reply with just: done.")
            .await
            .unwrap();
        drop(stdin);
        let out = child.wait_with_output().await.unwrap();
        eprintln!("stderr: {}", String::from_utf8_lossy(&out.stderr));
        let events: Vec<ClaudeEvent> = String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_line).collect();

        assert!(events.iter().any(|e| matches!(e, ClaudeEvent::Done { ok: true, .. })), "{events:?}");
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 1, "{events:?}");
        assert_eq!(got[0].request_id, "req-1");
        assert!(matches!(&got[0].body, mcp::ProposalBody::Comment { key, .. } if key == "TEST-1"));
    }

    /// With the flags used for Ask Claude, writes outside the repo-reading allowlist are refused.
    #[tokio::test]
    #[ignore]
    async fn claude_cannot_write_files() {
        let target = std::env::temp_dir().join(format!("jira-inbox-write-probe-{}", std::process::id()));
        let _ = std::fs::remove_file(&target);
        let mut child = Command::new(find_claude().expect("claude on PATH"))
            .args(["-p", "--output-format", "stream-json", "--verbose"])
            .args(["--permission-mode", "dontAsk", "--tools", TOOLS, "--allowedTools", ALLOWED])
            .args(["--strict-mcp-config"])
            .env_remove("CLAUDECODE")
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let prompt = format!("Use the Bash tool to run: touch {}  Then reply with done.", target.display());
        stdin.write_all(prompt.as_bytes()).await.unwrap();
        drop(stdin);
        child.wait_with_output().await.unwrap();
        assert!(!target.exists(), "Claude was able to create a file");
    }
}
