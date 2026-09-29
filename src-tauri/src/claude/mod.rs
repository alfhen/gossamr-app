//! Claude Code as an `AgentProvider`: the user's installed `claude` run headlessly, with only Pip's MCP tools plus
//! read-only repo access.

pub mod sessions;
pub mod stream;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::agent::{AgentCaps, AgentEvent, AgentProvider, AgentRequest, EventStream, McpEndpoint};
use crate::error::{Error, Result};
use stream::parse_line;

const RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// Pinned rather than inherited from the user's Claude Code default, which may be a slower, costlier model.
const MODEL: &str = "sonnet";
const EFFORT: &str = "medium";

/// Built-in tools Claude may use. With `--permission-mode dontAsk`, anything outside `ALLOWED` is refused, so it can
/// read the repo and git history but not edit files, run other commands or reach the network.
const TOOLS: &str = "Read,Grep,Glob,Bash";
const ALLOWED: &str = "mcp__gossamr,Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(git branch:*)";

#[derive(Default)]
pub struct ClaudeCodeProvider {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

fn mcp_config(mcp: &McpEndpoint) -> String {
    json!({
        "mcpServers": {
            "gossamr": { "type": "http", "url": mcp.url, "headers": { "Authorization": format!("Bearer {}", mcp.token) } }
        }
    })
    .to_string()
}

fn args(req: &AgentRequest) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .into_iter()
        .chain(["--model", MODEL, "--effort", EFFORT])
        .chain(["--permission-mode", "dontAsk", "--tools", TOOLS, "--allowedTools", ALLOWED])
        .chain(["--strict-mcp-config", "--mcp-config"])
        .map(String::from)
        .collect();
    a.extend([mcp_config(&req.mcp), "--append-system-prompt".into(), req.system.clone()]);
    if let Some(id) = &req.session {
        a.extend(["--resume".into(), id.clone()]);
    }
    a
}

impl ClaudeCodeProvider {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl AgentProvider for ClaudeCodeProvider {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn capabilities(&self) -> AgentCaps {
        AgentCaps { mcp: true, resume: true, streaming: true, reads_code: true, read_only_sandbox: true }
    }

    async fn run(&self, req: AgentRequest) -> Result<EventStream> {
        let binary = find_claude().ok_or_else(|| {
            Error::Claude("Claude Code isn't installed, or isn't on your PATH. Install it from code.claude.com.".into())
        })?;
        let mut child = Command::new(binary)
            .args(args(&req))
            // Launched from inside a Claude Code session, the child would otherwise think it's nested.
            .current_dir(&req.cwd)
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        // The prompt goes through stdin so long ticket context never hits argument limits or shell quoting.
        let mut stdin = child.stdin.take().expect("piped");
        stdin.write_all(req.prompt.as_bytes()).await?;

        // Registered before stdin closes, since Claude starts work (and may call the MCP tools) on EOF.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.running.lock().expect("lock poisoned").insert(req.run_id.clone(), cancel_tx);
        drop(stdin);

        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();
            let stderr = child.stderr.take().expect("piped");
            let stderr_tail = tokio::spawn(async move {
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
                        AgentEvent::Started { session_id } => session = Some(session_id.clone()),
                        AgentEvent::Done { session_id, .. } => {
                            session = session_id.clone().or(session.take());
                            finished = true;
                        }
                        _ => {}
                    }
                    let _ = tx.send(ev);
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
                let _ = tx.send(AgentEvent::Done { session_id: session, ok: false, message: Some(message) });
            }
        });
        Ok(rx)
    }

    fn cancel(&self, run_id: &str) {
        if let Some(tx) = self.running.lock().expect("lock poisoned").remove(run_id) {
            let _ = tx.send(());
        }
    }
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
    use crate::agent::conformance::{self, Harness};

    fn request(session: Option<&str>) -> AgentRequest {
        AgentRequest {
            run_id: "r".into(),
            system: "sys".into(),
            prompt: "p".into(),
            mcp: McpEndpoint { url: "http://127.0.0.1:1/mcp/r".into(), token: "tok".into() },
            cwd: std::env::temp_dir(),
            session: session.map(String::from),
        }
    }

    #[test]
    fn claude_is_started_read_only_with_only_our_tools_and_repo_reads() {
        let a = args(&request(None));
        let after = |flag: &str| a[a.iter().position(|x| x == flag).unwrap() + 1].clone();
        assert_eq!(after("--permission-mode"), "dontAsk");
        assert_eq!(after("--tools"), TOOLS);
        assert!(a.contains(&"--strict-mcp-config".to_string()), "the user's own MCP servers stay out");
        let servers: serde_json::Value = serde_json::from_str(&after("--mcp-config")).unwrap();
        assert_eq!(servers["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["gossamr"]);
        assert_eq!(servers["mcpServers"]["gossamr"]["headers"]["Authorization"], "Bearer tok");

        for tool in ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"] {
            assert!(!TOOLS.contains(tool) && !ALLOWED.contains(tool), "{tool}");
        }
        let bash: Vec<_> = ALLOWED.split(',').filter(|t| t.starts_with("Bash")).collect();
        assert!(bash.iter().all(|t| t.starts_with("Bash(git ")), "bare Bash would allow anything: {bash:?}");
        assert!(!bash.iter().any(|t| ["push", "fetch", "pull", "clone", "remote"].iter().any(|w| t.contains(w))));
        assert!(ALLOWED.split(',').any(|t| t == "mcp__gossamr"));
    }

    #[test]
    fn a_session_is_resumed_only_when_one_is_given() {
        assert!(!args(&request(None)).contains(&"--resume".to_string()));
        let a = args(&request(Some("s-1")));
        assert_eq!(a[a.iter().position(|x| x == "--resume").unwrap() + 1], "s-1");
    }

    #[test]
    fn it_declares_what_the_suite_relies_on() {
        let caps = ClaudeCodeProvider::new().capabilities();
        assert!(caps.mcp && caps.read_only_sandbox && caps.streaming);
    }

    /// The real CLI against the suite. Needs Claude Code installed and logged in:
    /// `cargo test -- --ignored claude_code_conforms --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn claude_code_conforms() {
        let provider = ClaudeCodeProvider::new();
        let h = Harness::start().await;
        let probes = conformance::Probes {
            propose: "First call get_item for CA-1, then list_proposals, then propose_comment on CA-1 with the body \"Looks good\". Then reply with just: done.".into(),
            write: format!("Use the Bash tool to run: touch {}  Then reply with just: done.", h.write_target().display()),
            reach: format!("Use whatever tools you have to fetch http://127.0.0.1:{}/ping, then reply with just: done.", h.canary_port()),
            list: "Call list_proposals with state open and tell me the ids you see, then stop.".into(),
            hang: "Call list_proposals ten times in a row, one after another, then reply with just: done.".into(),
        };
        conformance::check_all(&provider, &h, &probes).await.unwrap();
    }
}
