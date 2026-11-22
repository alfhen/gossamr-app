//! The mock provider: an agent that plays a script, in-process, one step per line. It has the capabilities its script
//! names, calls client tools through the session's tools endpoint as a real agent would, and can be resumed by its
//! provider session id with a new token.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use crate::driver::{Capabilities, Command, Driver, Launch, Link, OpenError, random_hex};
use crate::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use crate::tools::{Endpoint, Reply};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Waits for a prompt, then starts a turn. The text, if any, is what the script's client would send.
    Prompt(Option<String>),
    /// Starts a turn with no prompt, as an agent does after a background task ends.
    Turn,
    Say(String),
    /// A piece of streamed text. A script sends the whole block with `say` after its pieces, as a driver must.
    Delta(String),
    Tool { id: Option<String>, name: String, #[serde(default)] input: Value },
    ToolResult { id: Option<String>, #[serde(default)] output: Value, #[serde(default)] error: bool },
    /// Asks and waits for the answer.
    Permission { kind: PermissionKind, tool: String, #[serde(default)] input: Value },
    /// Calls a client tool through the session's tools endpoint and waits for its result or its cut.
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

/// One provider session of the mock. `run` counts its starts; only the latest start may move `at`.
#[derive(Default)]
struct Play {
    at: usize,
    run: u64,
    tokens: Vec<String>,
    received: Vec<Command>,
    replies: Vec<Result<Reply, String>>,
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

    /// What each of the agent's client tool calls got back: the client's result, or why it was cut.
    pub fn replies(&self, provider_session: &str) -> Vec<Result<Reply, String>> {
        self.plays().get(provider_session).map(|play| play.replies.clone()).unwrap_or_default()
    }

    fn plays(&self) -> MutexGuard<'_, HashMap<String, Play>> {
        self.inner.plays.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The play of `key` if `run` is still its latest start.
    fn play<T>(&self, key: &str, run: u64, f: impl FnOnce(&mut Play, &[Step]) -> T) -> Option<T> {
        let mut plays = self.plays();
        let play = plays.get_mut(key).filter(|play| play.run == run)?;
        Some(f(play, &self.inner.script.steps))
    }

    fn next_step(&self, key: &str, run: u64) -> Option<Step> {
        self.play(key, run, |play, steps| {
            let step = steps.get(play.at).cloned();
            play.at += 1;
            step
        })
        .flatten()
    }

    /// Moves past the rest of the running turn, to the next prompt.
    fn skip_turn(&self, key: &str, run: u64) {
        self.play(key, run, |play, steps| {
            while play.at < steps.len() && !matches!(steps[play.at], Step::Prompt(_)) {
                play.at += 1;
            }
        });
    }
}

impl Driver for Mock {
    fn capabilities(&self) -> Capabilities {
        self.inner.script.capabilities
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        let token = launch.tools_token.expose().to_owned();
        let resumed = launch.resume.is_some();
        let (key, run) = match launch.resume {
            Some(key) => {
                let mut plays = self.plays();
                let message = format!("the mock has no session {key}");
                let play = plays.get_mut(&key).ok_or(OpenError { kind: FailKind::Provider, message })?;
                play.tokens.push(token.clone());
                play.run += 1;
                let run = play.run;
                drop(plays);
                // The turn the stop cut is lost, as it is on every real provider.
                self.skip_turn(&key, run);
                (key, run)
            }
            None => {
                let key = format!("mock-{}", random_hex(8));
                self.plays().insert(key.clone(), Play { tokens: vec![token.clone()], ..Play::default() });
                (key, 0)
            }
        };
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output_tx, output) = mpsc::unbounded_channel();
        let _ = output_tx.send(Body::Started { provider_session: key.clone(), resumed });
        let player = Player {
            mock: self.clone(),
            key,
            run,
            token,
            tools: launch.tools,
            commands: commands_rx,
            output: output_tx,
            ids: 0,
            last_tool: String::new(),
            prompts: VecDeque::new(),
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
    run: u64,
    token: String,
    tools: Arc<Endpoint>,
    commands: UnboundedReceiver<Command>,
    output: UnboundedSender<Body>,
    ids: u64,
    last_tool: String,
    /// Prompts that came while the mock was not waiting for one, kept for the next prompt step, as a provider would.
    prompts: VecDeque<String>,
}

impl Player {
    async fn play(mut self) {
        let caps = self.mock.inner.script.capabilities;
        loop {
            // A real agent's events come one at a time; so do the mock's.
            tokio::task::yield_now().await;
            let Some(step) = self.mock.next_step(&self.key, self.run) else { return };
            let got = match step {
                Step::Prompt(_) => {
                    let got = match self.prompts.pop_front() {
                        Some(_) => Got::Go,
                        None => self.wait(|c| matches!(c, Command::Prompt(_)), false).await,
                    };
                    match got {
                        Got::Go | Got::Matched(_) => self.send(Body::TurnStarted),
                        other => other,
                    }
                }
                Step::Turn => self.send(Body::TurnStarted),
                Step::Say(text) => self.send(Body::Text { text }),
                Step::Delta(text) => self.send(Body::TextDelta { text }),
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
                Step::Fail(reason) => self.send(Body::Failed { kind: FailKind::Provider, reason }),
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
                            self.mock.skip_turn(&self.key, self.run);
                            self.send(Body::TurnEnded { how: TurnEnd::Denied })
                        }
                        got => got,
                    }
                }
                Step::Call { name, input } => {
                    let (tools, token) = (self.tools.clone(), self.token.clone());
                    let call = async move { tools.call(&token, &name, input).await };
                    let (mock, key, run) = (self.mock.clone(), self.key.clone(), self.run);
                    tokio::select! {
                        reply = call => {
                            mock.play(&key, run, |play, _| play.replies.push(reply));
                            Got::Go
                        }
                        got = self.wait(|_| false, true) => got,
                    }
                }
            };
            match got {
                Got::Go | Got::Matched(_) => {}
                Got::Cancelled => {
                    self.mock.skip_turn(&self.key, self.run);
                    self.send(Body::TurnEnded { how: TurnEnd::Cancelled });
                }
                Got::Stopped => {
                    // A resume starts again at the step that was waiting, or past the turn it was in.
                    self.mock.play(&self.key, self.run, |play, _| play.at -= 1);
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

    /// Waits for the command `accept` takes. A prompt that comes meanwhile is kept for the next prompt step; a cancel
    /// outside a turn and any other command are received and passed over.
    async fn wait(&mut self, accept: impl Fn(&Command) -> bool, in_turn: bool) -> Got {
        loop {
            let Some(command) = self.commands.recv().await else { return Got::Stopped };
            self.mock.play(&self.key, self.run, |play, _| play.received.push(command.clone()));
            match command {
                Command::Stop | Command::Kill => return Got::Stopped,
                command if accept(&command) => return Got::Matched(command),
                Command::Cancel if in_turn => return Got::Cancelled,
                Command::Prompt(text) => self.prompts.push_back(text),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::Secret;

    fn launch(resume: Option<String>) -> Launch {
        let tools = Arc::new(Endpoint::unattached("t"));
        Launch { cwd: "/".into(), locked: false, model: None, resume, tools_token: Secret::random(), tools }
    }

    #[tokio::test]
    async fn mock_a_start_that_was_resumed_over_cannot_move_the_new_one() {
        let script = Script::parse("{\"prompt\": null}\n{\"say\": \"one\"}\n{\"end\": \"done\"}\n{\"prompt\": null}").unwrap();
        let mock = Mock::new(script);
        let mut old = mock.open(launch(None)).unwrap();
        let Some(Body::Started { provider_session, .. }) = old.output.recv().await else { panic!() };
        // A resume while the old start still runs, as after a stop grace that ran out.
        let mut new = mock.open(launch(Some(provider_session))).unwrap();
        old.commands.send(Command::Prompt("stale".into())).unwrap();
        while let Some(body) = old.output.recv().await {
            assert!(!matches!(body, Body::TurnStarted | Body::Text { .. }), "the old start played a step: {body:?}");
        }
        new.commands.send(Command::Prompt("fresh".into())).unwrap();
        let mut said = vec![];
        while let Some(body) = tokio::time::timeout(Duration::from_secs(5), new.output.recv()).await.unwrap() {
            said.push(body.type_name());
            if said.last().is_some_and(|last| last == "turn_ended") {
                break;
            }
        }
        assert_eq!(said, ["started", "turn_started", "text", "turn_ended"], "the new start plays the turn from its start");
    }
}
