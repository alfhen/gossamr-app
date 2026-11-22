//! The mock provider: an agent that plays a script, in-process. A script is a harness script (one step per line) or an
//! H0 transcript, which [`fixture`] turns into one. A script holds both sides: what the agent says, and what the
//! recorded client did at each point it waited (`client` publishes that, for `harness run`). Ids in a script are the
//! script's own and are mapped to fresh ones as it plays, so no recorded id, pid or port reaches an event.

pub mod fixture;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;

use crate::driver::{Capabilities, Command, Driver, Launch, Link, random_hex};
use crate::event::{Body, Decision, PermissionKind, TurnEnd};
use crate::redact::each_string;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Waits for a prompt; the text is what the recorded client sent.
    Prompt(Option<String>),
    Say(String),
    Tool { id: Option<String>, name: String, #[serde(default)] input: Value },
    ToolResult { id: Option<String>, #[serde(default)] output: Value, #[serde(default)] error: bool },
    /// Asks and waits for the answer. `answer` is the recorded one; a replay answered otherwise fails.
    Permission { kind: PermissionKind, tool: String, #[serde(default)] input: Value, answer: Option<Decision> },
    /// Calls a client tool and holds the call up to the tool-call limit. `result` is what the recorded client posted.
    Call { name: String, #[serde(default)] input: Value, result: Option<Value> },
    Question(String),
    Sleep(u64),
    /// Waits for the client to cancel.
    Cancel,
    End(TurnEnd),
    Fail(String),
}

/// A value in a recording that belongs to the recorded run, and what it is mapped to as the script plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Session,
    Id,
    Pid,
    Port,
}

#[derive(Debug, Clone, Default)]
pub struct Script {
    pub capabilities: Capabilities,
    pub steps: Vec<Step>,
    /// A recording: the mock plays only what was recorded and invents no step of its own.
    pub replay: bool,
    pub recorded: Vec<(String, Recorded)>,
}

impl Script {
    /// Reads a harness script, or an H0 transcript (lines with `seq` and `dir`).
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
        if lines.first().is_some_and(|(_, first)| first.get("seq").is_some() && first.get("dir").is_some()) {
            return Ok(fixture::convert(&lines.into_iter().map(|(_, line)| line).collect::<Vec<_>>()));
        }
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

/// What the script's recorded client did where the mock now waits.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientAction {
    Prompt(Option<String>),
    Answer { id: String, decision: Option<Decision> },
    ToolResult { id: String, output: Option<Value> },
    Cancel,
}

#[derive(Clone)]
pub struct Mock {
    inner: Arc<Inner>,
}

struct Inner {
    script: Script,
    plays: Mutex<HashMap<String, Play>>,
    client: watch::Sender<Option<ClientAction>>,
}

#[derive(Default)]
struct Play {
    at: usize,
    tokens: Vec<String>,
    received: Vec<Command>,
}

impl Mock {
    pub fn new(script: Script) -> Mock {
        Mock { inner: Arc::new(Inner { script, plays: Mutex::new(HashMap::new()), client: watch::channel(None).0 }) }
    }

    /// What the recorded client did where the mock waits now, or `None` while it does not wait.
    pub fn client(&self) -> watch::Receiver<Option<ClientAction>> {
        self.inner.client.subscribe()
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

    fn finish(&self, key: &str) {
        if let Some(play) = self.plays().get_mut(key) {
            play.at = self.inner.script.steps.len();
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
        let port = launch.tools_url.as_deref().and_then(|url| url.rsplit(':').next()?.split('/').next()?.parse().ok());
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output_tx, output) = mpsc::unbounded_channel();
        let _ = output_tx.send(Body::Started { provider_session: key.clone(), resumed });
        let player = Player {
            mock: self.clone(),
            mapper: Mapper::new(&self.inner.script.recorded, &key, port.unwrap_or(0)),
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
    mapper: Mapper,
    commands: UnboundedReceiver<Command>,
    output: UnboundedSender<Body>,
    ids: u64,
    last_tool: String,
}

impl Player {
    async fn play(mut self) {
        let caps = self.mock.inner.script.capabilities;
        let replay = self.mock.inner.script.replay;
        while let Some(step) = self.mock.next_step(&self.key) {
            let got = match step {
                Step::Prompt(recorded) => self.wait(ClientAction::Prompt(recorded), |c| matches!(c, Command::Prompt(_)), false).await,
                Step::Say(text) => self.send(Body::Text { text }),
                Step::Tool { id, name, input } => {
                    let id = id.map(|id| self.mapper.text(&id)).unwrap_or_else(|| self.fresh("t"));
                    self.last_tool = id.clone();
                    self.send(Body::ToolCall { id, name, input })
                }
                Step::ToolResult { id, output, error } => {
                    let id = id.map(|id| self.mapper.text(&id)).unwrap_or_else(|| self.last_tool.clone());
                    self.send(Body::ToolResult { id, output, error })
                }
                Step::Question(text) => {
                    let id = self.fresh("q");
                    self.send(Body::Question { id, text })
                }
                Step::End(how) => self.send(Body::TurnEnded { how }),
                Step::Fail(reason) => self.send(Body::Failed { reason }),
                Step::Sleep(ms) => match tokio::time::timeout(Duration::from_millis(ms), self.wait_for(|_| false, true)).await {
                    Ok(got) => got,
                    Err(_) => Got::Go,
                },
                Step::Cancel => self.wait(ClientAction::Cancel, |c| *c == Command::Cancel, false).await,
                Step::Permission { kind, tool, input, answer } => {
                    let id = self.fresh("p");
                    self.send(Body::Permission { id: id.clone(), kind, tool, input });
                    let action = ClientAction::Answer { id: id.clone(), decision: answer };
                    match self.wait(action, |c| matches!(c, Command::Answer { id: got, .. } if *got == id), true).await {
                        Got::Matched(Command::Answer { decision, .. }) if answer.is_some_and(|recorded| recorded != decision) => {
                            self.mock.finish(&self.key);
                            let reason = format!("the replay was answered {decision:?} where the recording has {answer:?}");
                            self.send(Body::Failed { reason })
                        }
                        Got::Matched(Command::Answer { decision: Decision::Deny, .. }) if caps.deny_ends_turn && !replay => {
                            self.mock.skip_turn(&self.key);
                            self.send(Body::TurnEnded { how: TurnEnd::Denied })
                        }
                        got => got,
                    }
                }
                Step::Call { name, input, result } => {
                    let id = self.fresh("c");
                    self.send(Body::ClientToolCall { id: id.clone(), name, input });
                    let limit = Duration::from_millis(caps.tool_call_limit_ms.unwrap_or(u64::MAX));
                    let action = ClientAction::ToolResult { id: id.clone(), output: result };
                    let wait = self.wait(action, |c| matches!(c, Command::ToolResult { id: got, .. } if *got == id), true);
                    match tokio::time::timeout(limit, wait).await {
                        Ok(Got::Matched(Command::ToolResult { output, error, .. })) => self.send(Body::ToolResult { id, output, error }),
                        Ok(got) => got,
                        Err(_) => {
                            let _ = self.mock.inner.client.send(None);
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

    fn send(&mut self, mut body: Body) -> Got {
        self.mapper.body(&mut body);
        match self.output.send(body) {
            Ok(()) => Got::Go,
            Err(_) => Got::Stopped,
        }
    }

    fn fresh(&mut self, prefix: &str) -> String {
        self.ids += 1;
        format!("{prefix}{}", self.ids)
    }

    /// Publishes what the recorded client did here, then waits for the command `accept` takes.
    async fn wait(&mut self, action: ClientAction, accept: impl Fn(&Command) -> bool, in_turn: bool) -> Got {
        let _ = self.mock.inner.client.send(Some(action));
        let got = self.wait_for(accept, in_turn).await;
        let _ = self.mock.inner.client.send(None);
        got
    }

    /// A cancel outside a turn, and any command `accept` does not take, is received and passed over.
    async fn wait_for(&mut self, accept: impl Fn(&Command) -> bool, in_turn: bool) -> Got {
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

/// Maps the recorded run's values to this play's: its session id, a fresh id per recorded id, this process's pid, and
/// the session's tools port.
struct Mapper {
    to: HashMap<String, String>,
    pattern: Option<Regex>,
}

impl Mapper {
    fn new(recorded: &[(String, Recorded)], session: &str, port: u16) -> Mapper {
        let mut to = HashMap::new();
        for (n, (value, kind)) in recorded.iter().enumerate() {
            let live = match kind {
                Recorded::Session => session.to_owned(),
                Recorded::Id => format!("id{n}"),
                Recorded::Pid => std::process::id().to_string(),
                Recorded::Port => format!("{}:{port}", value.rsplit_once(':').map_or("", |(host, _)| host)),
            };
            to.entry(value.clone()).or_insert(live);
        }
        let mut keys: Vec<&String> = to.keys().collect();
        keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
        let alternation = keys.iter().map(|key| regex::escape(key)).collect::<Vec<_>>().join("|");
        let pattern = (!keys.is_empty()).then(|| Regex::new(&format!(r"\b(?:{alternation})\b")).expect("escaped keys compile"));
        Mapper { to, pattern }
    }

    fn text(&self, s: &str) -> String {
        match &self.pattern {
            Some(pattern) => pattern.replace_all(s, |caps: &regex::Captures<'_>| self.to[&caps[0]].clone()).into_owned(),
            None => s.to_owned(),
        }
    }

    fn body(&self, body: &mut Body) {
        if self.pattern.is_none() {
            return;
        }
        let mut value = serde_json::to_value(&*body).expect("a body always serializes");
        each_string(&mut value, &mut |s| *s = self.text(s));
        *body = serde_json::from_value(value).expect("mapping a string keeps the body's shape");
    }
}
