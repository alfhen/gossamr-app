//! Claude Code as Pip's agent: the user's installed `claude` run headlessly with Pip's MCP tools and nothing else. The
//! flags, environment and stream parser are the harness's (`harness::claude`); this runs a turn and reports it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(test)]
use async_trait::async_trait;
use harness::claude::pip::{self, Image, Turn};
use harness::claude::stream::{self, Line, Usage};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::agent::{AgentEvent, AgentRequest, EventStream, TurnUsage, mcp};
use crate::error::Result;

pub use harness::claude::pip::Launch;

const RUN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct ClaudeCodeProvider {
    running: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    #[cfg(test)]
    stand_in: Option<Arc<dyn StandIn>>,
}

/// A scripted agent that tests put where the `claude` process would be.
#[cfg(test)]
#[async_trait]
pub(crate) trait StandIn: Send + Sync {
    async fn run(&self, req: AgentRequest) -> Result<EventStream>;

    fn cancel(&self, run_id: &str);
}

/// The run's id, its prompt, and the turn the harness builds the flags from.
fn split(req: AgentRequest) -> (String, String, Turn) {
    let images = req.images.into_iter().map(|i| Image { media_type: i.media_type, data: i.data }).collect();
    let turn = Turn {
        launch: req.launch,
        system: req.system,
        mcp_url: req.mcp.url,
        mcp_token: req.mcp.token,
        cwd: req.sandbox.path().to_path_buf(),
        session: req.session,
        images,
    };
    (req.run_id, req.prompt, turn)
}

fn event(line: Line) -> AgentEvent {
    match line {
        Line::Started { session_id } => AgentEvent::Started { session_id },
        Line::Text { text } => AgentEvent::Text { text },
        Line::Tool { name, input } => AgentEvent::Tool { label: tool_label(&name, &input) },
        Line::Done { session_id, ok, message, usage } => AgentEvent::Done { session_id, ok, message, usage: usage.map(turn_usage) },
    }
}

fn turn_usage(u: Usage) -> TurnUsage {
    TurnUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_tokens: u.cache_creation_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cost_usd: u.cost_usd,
    }
}

/// A short, human description of a tool call, e.g. `Read src/main.rs` or `Looked up CA-412`.
fn tool_label(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().unwrap_or_default();
    let short_path = |p: &str| p.rsplit('/').take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("/");
    match name.rsplit("__").next().unwrap_or(name) {
        "Read" => format!("Read {}", short_path(s("file_path"))),
        "Grep" => format!("Searched the code for “{}”", s("pattern")),
        "Glob" => format!("Listed files matching {}", s("pattern")),
        "Bash" => format!("Ran {}", s("command").lines().next().unwrap_or_default()),
        other => mcp::tool_label(other, input).unwrap_or_else(|| format!("Used {other}")),
    }
}

impl ClaudeCodeProvider {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub(crate) fn standing_in(stand_in: Arc<dyn StandIn>) -> Self {
        Self { stand_in: Some(stand_in), ..Self::default() }
    }

    /// `claude` as the environment `shell` finds it. A stand-in is always found.
    pub fn find(&self, shell: &crate::runs::env::RunEnv) -> Option<PathBuf> {
        #[cfg(test)]
        if self.stand_in.is_some() {
            return Some(PathBuf::from("claude"));
        }
        crate::runs::toolchain::find_binary(crate::connections::Driver::Claude, shell)
    }

    /// Starts a run. The stream ends with exactly one `Done`, including after a cancel or a crash, and once it has
    /// ended nothing of the run is still executing.
    pub async fn run(&self, req: AgentRequest) -> Result<EventStream> {
        #[cfg(test)]
        if let Some(stand_in) = &self.stand_in {
            return stand_in.run(req).await;
        }
        let (run_id, prompt, turn) = split(req);
        let mut child = pip::command(&turn)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        // The prompt goes through stdin so long ticket context never hits argument limits or shell quoting.
        let mut stdin = child.stdin.take().expect("piped");
        let input = if turn.images.is_empty() { prompt } else { pip::user_message(&prompt, &turn.images) };
        stdin.write_all(input.as_bytes()).await?;

        // Registered before stdin closes, since Claude starts work (and may call the MCP tools) on EOF.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.running.lock().expect("lock poisoned").insert(run_id.clone(), cancel_tx);
        drop(stdin);

        let (tx, rx) = mpsc::unbounded_channel();
        let running = self.running.clone();
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
                    let Some(ev) = stream::parse_line(&line).map(event) else { continue };
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
            running.lock().expect("lock poisoned").remove(&run_id);
            if !finished {
                let tail = stderr_tail.await.unwrap_or_default();
                let message = outcome.map(String::from).unwrap_or(if tail.is_empty() { "Claude exited unexpectedly".into() } else { tail });
                let _ = tx.send(AgentEvent::Done { session_id: session, ok: false, message: Some(message), usage: None });
            }
        });
        Ok(rx)
    }

    /// Stops the run; its stream then ends with a failed `Done`. Unknown or finished runs are ignored.
    pub fn cancel(&self, run_id: &str) {
        #[cfg(test)]
        if let Some(stand_in) = &self.stand_in {
            return stand_in.cancel(run_id);
        }
        if let Some(tx) = self.running.lock().expect("lock poisoned").remove(run_id) {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::McpEndpoint;
    use crate::agent::images::ImageInput;
    use crate::agent::sandbox::Sandbox;
    use crate::runs::provider_env::ProviderEnv;

    fn request(session: Option<&str>) -> AgentRequest {
        AgentRequest {
            run_id: "r".into(),
            system: "sys".into(),
            prompt: "p".into(),
            mcp: McpEndpoint { url: "http://127.0.0.1:1/mcp/r".into(), token: "tok".into() },
            sandbox: Sandbox::prepare(&std::env::temp_dir().join(format!("gossamr-claude-args-{}", std::process::id()))).unwrap(),
            session: session.map(String::from),
            images: Vec::new(),
            launch: Launch { binary: PathBuf::from("claude"), env: ProviderEnv::none(), model: Some("sonnet".into()), effort: Some("medium".into()) },
        }
    }

    /// The argv `main` built before the flags moved into the harness, for the same request. serde_json sorts keys here, as
    /// it did there: no crate of the workspace turns on its `preserve_order`.
    #[test]
    fn pips_argv_is_todays_byte_for_byte() {
        let req = request(Some("s-1"));
        let sandbox = req.sandbox.path().to_path_buf();
        let (_, prompt, turn) = split(req);
        let today = [
            "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "sonnet", "--effort", "medium",
            "--permission-mode", "dontAsk", "--tools", "", "--allowedTools", "mcp__gossamr", "--setting-sources", "", "--disable-slash-commands",
            "--strict-mcp-config", "--mcp-config",
            r#"{"mcpServers":{"gossamr":{"headers":{"Authorization":"Bearer ${GOSSAMR_MCP_TOKEN}"},"type":"http","url":"http://127.0.0.1:1/mcp/r"}}}"#,
            "--append-system-prompt", "sys", "--resume", "s-1",
        ];
        let cmd = pip::command(&turn);
        let argv: Vec<String> = cmd.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(argv, today, "the argv the spawned command has, the only way the app reaches it");
        assert_eq!(cmd.as_std().get_current_dir(), Some(sandbox.as_path()), "Pip runs in the request's sandbox");
        assert_eq!(prompt, "p");
        let envs: Vec<_> = cmd.as_std().get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        let expected = [("CLAUDECODE", None), ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", Some("1")), ("GOSSAMR_MCP_TOKEN", Some("tok"))];
        let expected: Vec<_> = expected.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect();
        assert_eq!(envs, expected, "only the token, auto memory off and the nesting variable removed");
    }

    #[test]
    fn images_ride_in_the_turn_as_they_came() {
        let mut req = request(None);
        req.images = vec![crate::agent::images::tests::png()];
        let (_, _, turn) = split(req);
        let ImageInput { media_type, data } = crate::agent::images::tests::png();
        assert_eq!(turn.images, [Image { media_type, data }]);
    }

    fn parsed(line: &str) -> Option<AgentEvent> {
        stream::parse_line(line).map(event)
    }

    #[test]
    fn tool_calls_are_worded_for_the_panel() {
        assert_eq!(
            parsed(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Read","input":{"file_path":"/a/b/src/main.rs"}}]}}"#),
            Some(AgentEvent::Tool { label: "Read src/main.rs".into() })
        );
        assert_eq!(
            parsed(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__gossamr__get_item","input":{"key":"CA-1"}}]}}"#),
            Some(AgentEvent::Tool { label: "Looked up CA-1".into() })
        );
    }

    #[test]
    fn serialises_with_camel_case_fields() {
        let v = serde_json::to_value(AgentEvent::Started { session_id: "s".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "started", "sessionId": "s" }));
    }

    #[test]
    fn a_results_usage_serialises_in_camel_case_and_a_result_without_one_as_before() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.0123,
            "usage":{"input_tokens":120,"output_tokens":45,"cache_creation_input_tokens":300,"cache_read_input_tokens":900}}"#;
        let v = serde_json::to_value(parsed(line).unwrap()).unwrap();
        assert_eq!(v["usage"], serde_json::json!({ "inputTokens": 120, "outputTokens": 45, "cacheCreationTokens": 300, "cacheReadTokens": 900, "costUsd": 0.0123 }));
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.5}"#;
        let v = serde_json::to_value(parsed(line).unwrap()).unwrap();
        assert_eq!(v, serde_json::json!({ "type": "done", "sessionId": "s1", "ok": true, "message": null }));
    }

    /// A real run with a screenshot attached, sent the way the app sends it. Needs Claude Code installed and signed in.
    #[tokio::test]
    #[ignore]
    async fn claude_code_sees_an_attached_image() {
        let mut req = request(None);
        req.prompt = "What single colour fills this image? Reply with just the colour name.".into();
        req.launch.binary = crate::runs::binary::find_claude().expect("claude installed");
        req.images = vec![ImageInput { media_type: "image/png".into(), data: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IyJCU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJ3LED3QqzauAAAAAElFTkSuQmCC".into() }];
        let events = ClaudeCodeProvider::new().run(req).await.unwrap();
        let mut text = String::new();
        let mut events = events;
        let mut ok = false;
        let mut why = None;
        while let Some(e) = events.recv().await {
            match e {
                AgentEvent::Text { text: t } => text.push_str(&t),
                AgentEvent::Done { ok: o, message, .. } => (ok, why) = (o, message),
                _ => {}
            }
        }
        assert!(ok && text.to_lowercase().contains("red"), "{text} {why:?}");
    }
}
