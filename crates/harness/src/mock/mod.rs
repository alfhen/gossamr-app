//! The mock provider: an agent that plays a script, in-process, one step per line. It has the capabilities its script
//! names, holds a client tool call no longer than its tool-call limit, and can be resumed by its provider session id
//! with a new token.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::driver::{Capabilities, Command, Driver, Launch, Link, random_hex};
use crate::event::{Body, Decision, PermissionKind, TurnEnd};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Waits for a prompt. The text, if any, is what the script's client would send.
    Prompt(Option<String>),
    Say(String),
    Tool { id: Option<String>, name: String, #[serde(default)] input: Value },
    ToolResult { id: Option<String>, #[serde(default)] output: Value, #[serde(default)] error: bool },
    /// Asks and waits for the answer.
    Permission { kind: PermissionKind, tool: String, #[serde(default)] input: Value },
    /// Calls a client tool and holds the call up to the tool-call limit.
    Call { name: String, #[serde(default)] input: Value },
    Question(String),
    Sleep(u64),
    /// Waits for the client to cancel.
    Cancel,
    End(TurnEnd),
    Fail(String),
}

#[derive(Debug, Clone, Default)]
pub struct Script {
    pub capabilities: Capabilities,
    pub steps: Vec<Step>,
}

impl Script {
    /// Reads a harness script.
    pub fn load(path: &Path) -> Result<Script, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Script::parse(&text).map_err(|e| format!("{}:{e}", path.display()))
    }

    /// A harness script has one step per line, and may start with a `{"capabilities": ...}` line.
    pub fn parse(text: &str) -> Result<Script, String> {
        let lines = text
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(n, line)| serde_json::from_str(line).map(|value: Value| (n + 1, value)).map_err(|e| format!("{}: {e}", n + 1)))
            .collect::<Result<Vec<_>, String>>()?;
        let mut script = Script::default();
        for (n, line) in lines {
            let bad = |e: serde_json::Error| format!("{n}: {e}");
            match line.get("capabilities") {
                Some(caps) => script.capabilities = serde_json::from_value(caps.clone()).map_err(bad)?,
                None => script.steps.push(serde_json::from_value(line).map_err(bad)?),
            }
        }
        Ok(script)
    }
}

#[derive(Clone)]
pub struct Mock {
    inner: Arc<Inner>,
}

struct Inner {
    script: Script,
    plays: Mutex<HashMap<String, Play>>,
}

#[derive(Default)]
struct Play {
    at: usize,
    tokens: Vec<String>,
    received: Vec<Command>,
}

impl Mock {
    pub fn new(script: Script) -> Mock {
        Mock { inner: Arc::new(Inner { script, plays: Mutex::new(HashMap::new()) }) }
    }

    /// Every command the agent with this provider session id received, in order.
    pub fn received(&self, provider_session: &str) -> Vec<Command> {
        self.plays().get(provider_session).map(|play| play.received.clone()).unwrap_or_default()
    }

    /// The tools tokens the agent was given, one per start or resume.
    pub fn tokens(&self, provider_session: &str) -> Vec<String> {
        self.plays().get(provider_session).map(|play| play.tokens.clone()).unwrap_or_default()
    }

    fn plays(&self) -> MutexGuard<'_, HashMap<String, Play>> {
        self.inner.plays.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn next_step(&self, key: &str) -> Option<Step> {
        let mut plays = self.plays();
        let play = plays.get_mut(key)?;
        let step = self.inner.script.steps.get(play.at).cloned();
        play.at += 1;
        step
    }

    /// Moves past the rest of the running turn, to the next prompt.
    fn skip_turn(&self, key: &str) {
        let steps = &self.inner.script.steps;
        if let Some(play) = self.plays().get_mut(key) {
            while play.at < steps.len() && !matches!(steps[play.at], Step::Prompt(_)) {
                play.at += 1;
            }
        }
    }
}

impl Driver for Mock {
    fn capabilities(&self) -> Capabilities {
        self.inner.script.capabilities
    }

    fn open(&self, launch: Launch) -> Result<Link, String> {
        let token = launch.tools_token.expose().to_owned();
        let resumed = launch.resume.is_some();
        let key = match launch.resume {
            Some(key) => {
                let mut plays = self.plays();
                let play = plays.get_mut(&key).ok_or_else(|| format!("the mock has no session {key}"))?;
                play.tokens.push(token);
                drop(plays);
                // The turn the drop cut is lost, as it is on every real provider.
                self.skip_turn(&key);
                key
            }
            None => {
                let key = format!("mock-{}", random_hex(8));
                self.plays().insert(key.clone(), Play { tokens: vec![token], ..Play::default() });
                key
            }
        };
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output_tx, output) = mpsc::unbounded_channel();
        let _ = output_tx.send(Body::Started { provider_session: key.clone(), resumed });
        let player = Player {
            mock: self.clone(),
            key,
            commands: commands_rx,
            output: output_tx,
            ids: 0,
            last_tool: String::new(),
        };
        tokio::spawn(player.play());
        Ok(Link { commands, output })
    }
}

enum Got {
    Go,
    Matched(Command),
    Cancelled,
    Stopped,
}

struct Player {
    mock: Mock,
    key: String,
    commands: UnboundedReceiver<Command>,
    output: UnboundedSender<Body>,
    ids: u64,
    last_tool: String,
}

impl Player {
    async fn play(mut self) {
        let caps = self.mock.inner.script.capabilities;
        while let Some(step) = self.mock.next_step(&self.key) {
            let got = match step {
                Step::Prompt(_) => self.wait(|c| matches!(c, Command::Prompt(_)), false).await,
                Step::Say(text) => self.send(Body::Text { text }),
                Step::Tool { id, name, input } => {
                    let id = id.unwrap_or_else(|| self.fresh("t"));
                    self.last_tool = id.clone();
                    self.send(Body::ToolCall { id, name, input })
                }
                Step::ToolResult { id, output, error } => {
                    let id = id.unwrap_or_else(|| self.last_tool.clone());
                    self.send(Body::ToolResult { id, output, error })
                }
                Step::Question(text) => {
                    let id = self.fresh("q");
                    self.send(Body::Question { id, text })
                }
                Step::End(how) => self.send(Body::TurnEnded { how }),
                Step::Fail(reason) => self.send(Body::Failed { reason }),
                Step::Sleep(ms) => match tokio::time::timeout(Duration::from_millis(ms), self.wait(|_| false, true)).await {
                    Ok(got) => got,
                    Err(_) => Got::Go,
                },
                Step::Cancel => self.wait(|c| *c == Command::Cancel, false).await,
                Step::Permission { kind, tool, input } => {
                    let id = self.fresh("p");
                    self.send(Body::Permission { id: id.clone(), kind, tool, input });
                    match self.wait(|c| matches!(c, Command::Answer { id: got, .. } if *got == id), true).await {
                        Got::Matched(Command::Answer { decision: Decision::Deny, .. }) if caps.deny_ends_turn => {
                            self.mock.skip_turn(&self.key);
                            self.send(Body::TurnEnded { how: TurnEnd::Denied })
                        }
                        got => got,
                    }
                }
                Step::Call { name, input } => {
                    let id = self.fresh("c");
                    self.send(Body::ClientToolCall { id: id.clone(), name, input });
                    let limit = Duration::from_millis(caps.tool_call_limit_ms.unwrap_or(u64::MAX));
                    let wait = self.wait(|c| matches!(c, Command::ToolResult { id: got, .. } if *got == id), true);
                    match tokio::time::timeout(limit, wait).await {
                        Ok(Got::Matched(Command::ToolResult { output, error, .. })) => self.send(Body::ToolResult { id, output, error }),
                        Ok(got) => got,
                        Err(_) => {
                            let output = json!(format!("timed out after {} s", limit.as_secs()));
                            self.send(Body::ToolResult { id, output, error: true })
                        }
                    }
                }
            };
            match got {
                Got::Go | Got::Matched(_) => {}
                Got::Cancelled => {
                    self.mock.skip_turn(&self.key);
                    self.send(Body::TurnEnded { how: TurnEnd::Cancelled });
                }
                Got::Stopped => {
                    // A resume starts again at the step that was waiting, or past the turn it was in.
                    if let Some(play) = self.mock.plays().get_mut(&self.key) {
                        play.at -= 1;
                    }
                    return;
                }
            }
        }
    }

    fn send(&mut self, body: Body) -> Got {
        match self.output.send(body) {
            Ok(()) => Got::Go,
            Err(_) => Got::Stopped,
        }
    }

    fn fresh(&mut self, prefix: &str) -> String {
        self.ids += 1;
        format!("{prefix}{}", self.ids)
    }

    /// Waits for the command `accept` takes. A cancel outside a turn, and any other command, is received and passed
    /// over.
    async fn wait(&mut self, accept: impl Fn(&Command) -> bool, in_turn: bool) -> Got {
        loop {
            let Some(command) = self.commands.recv().await else { return Got::Stopped };
            if let Some(play) = self.mock.plays().get_mut(&self.key) {
                play.received.push(command.clone());
            }
            match command {
                Command::Stop => return Got::Stopped,
                command if accept(&command) => return Got::Matched(command),
                Command::Cancel if in_turn => return Got::Cancelled,
                _ => {}
            }
        }
    }
}
