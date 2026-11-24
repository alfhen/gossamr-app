//! The mock provider: an agent that plays a script, in-process. It has the capabilities its script names, calls client
//! tools through the session's tools endpoint as a real agent would, and can be resumed by its provider session id
//! with a new token. A script is a harness script (one step per line) or an H0 transcript, which [`fixture`] turns
//! into one. A script holds both sides: what the agent says, and what the recorded client did at each point it
//! waited (`client` publishes that, for `harness run`). Recorded ids, pids and ports are mapped to the play's own as
//! it plays, so none reaches an event.

pub mod fixture;

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use aho_corasick::AhoCorasick;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::watch;

use crate::driver::{Capabilities, Command, Driver, Launch, Link, OpenError, random_hex};
use crate::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use crate::redact::each_string;
use crate::tools::{Endpoint, Reply};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Waits for a prompt, then starts a turn. The text, if any, is what the script's client would send.
    Prompt(Option<String>),
    /// Starts a turn with no prompt, as an agent does after a background task ends.
    Turn,
    Say(String),
    Tool { id: Option<String>, name: String, #[serde(default)] input: Value },
    ToolResult { id: Option<String>, #[serde(default)] output: Value, #[serde(default)] error: bool },
    /// Asks and waits for the answer. `answer` is the recorded one; a replay answered otherwise fails.
    Permission { kind: PermissionKind, tool: String, #[serde(default)] input: Value, answer: Option<Decision> },
    /// Calls a client tool through the session's tools endpoint and waits for its result or its cut. `result` is
    /// what the recorded client posted.
    Call { name: String, #[serde(default)] input: Value, result: Option<Value> },
    Question(String),
    Sleep(u64),
    /// Waits for the client to cancel.
    Cancel,
    End(TurnEnd),
    Fail(String),
}

/// A value in a recording that belongs to the recorded run, and what it is mapped to as the script plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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

/// The largest script or recording read. H0's largest recording is 200 KB.
pub const MAX_SCRIPT_BYTES: u64 = 16 << 20;

impl Script {
    /// Reads a harness script, or an H0 transcript (lines with `seq` and `dir`). An error names the file and the
    /// line, never what the line holds.
    pub fn load(path: &Path) -> Result<Script, String> {
        let at = |e: String| format!("{}:{}{e}", path.display(), if e.starts_with(|c: char| c.is_ascii_digit()) { "" } else { " " });
        let too_big = |size: u64| at(format!("too big: {size} bytes, over the {MAX_SCRIPT_BYTES} a script may have"));
        let file = std::fs::File::open(path).map_err(|e| at(e.to_string()))?;
        let size = file.metadata().map_err(|e| at(e.to_string()))?.len();
        if size > MAX_SCRIPT_BYTES {
            return Err(too_big(size));
        }
        // The file may grow after its size was read, so no more than the limit is read either.
        let mut text = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(file, MAX_SCRIPT_BYTES + 1), &mut text).map_err(|e| at(e.to_string()))?;
        if text.len() as u64 > MAX_SCRIPT_BYTES {
            return Err(too_big(text.len() as u64));
        }
        Script::parse(&text).map_err(at)
    }

    /// A harness script has one step per line, and may start with a `{"capabilities": ...}` line.
    pub fn parse(text: &str) -> Result<Script, String> {
        // A data error quotes the value it could not take, so only its kind is told.
        let bad = |n: usize, e: serde_json::Error| match e.classify() {
            serde_json::error::Category::Data => format!("{n}: not a step this harness knows"),
            _ => format!("{n}: not JSON, {e}"),
        };
        let lines = text
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(n, line)| serde_json::from_str(line).map(|value: Value| (n + 1, value)).map_err(|e| bad(n + 1, e)))
            .collect::<Result<Vec<_>, String>>()?;
        if lines.is_empty() {
            return Err("no steps".into());
        }
        if lines.first().is_some_and(|(_, first)| first.get("seq").is_some() && first.get("dir").is_some()) {
            return fixture::convert(&lines);
        }
        let mut script = Script::default();
        for (n, line) in lines {
            match line.get("capabilities") {
                Some(caps) => script.capabilities = serde_json::from_value(caps.clone()).map_err(|e| bad(n, e))?,
                None => script.steps.push(serde_json::from_value(line).map_err(|e| bad(n, e))?),
            }
        }
        if script.steps.is_empty() {
            return Err("no steps".into());
        }
        Ok(script)
    }
}

/// What the script's recorded client did where the mock now waits. The ids are the session's, so the client takes
/// them from the request it last saw.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientAction {
    /// A prompt, with its recorded text if it has one; with none, the script waits for one with steps still to play.
    Prompt(Option<String>),
    Answer(Option<Decision>),
    ToolResult(Option<Value>),
    Cancel,
    /// Nothing is left to play: the recorded client closes the session.
    Close,
}

#[derive(Clone)]
pub struct Mock {
    inner: Arc<Inner>,
}

struct Inner {
    script: Script,
    plays: Mutex<HashMap<String, Play>>,
    client: watch::Sender<Option<ClientAction>>,
    /// The recorded client drives the play, so a replay waits for it only so long, and for its close.
    recorded: AtomicBool,
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
        Mock { inner: Arc::new(Inner { script, plays: Mutex::new(HashMap::new()), client: watch::channel(None).0, recorded: AtomicBool::new(false) }) }
    }

    /// What the recorded client did where the mock waits now, or `None` while it does not wait. It holds one action
    /// at a time, so it serves one session of the mock at a time, as `harness run` opens. Taking it makes that client
    /// the one a replay waits for: at most `CLIENT_LIMIT` each time, and for its close after the last turn. Any other
    /// client is waited for as a provider waits.
    pub fn client(&self) -> watch::Receiver<Option<ClientAction>> {
        self.inner.recorded.store(true, Ordering::Relaxed);
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
            play.at += usize::from(step.is_some());
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

    fn finish(&self, key: &str, run: u64) {
        self.play(key, run, |play, steps| play.at = steps.len());
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
        let mapper = Mapper::new(&self.inner.script.recorded, &key).map_err(|message| OpenError { kind: FailKind::Provider, message })?;
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (output_tx, output) = mpsc::unbounded_channel();
        let _ = output_tx.send(Body::Started { provider_session: key.clone(), resumed });
        let player = Player {
            mock: self.clone(),
            mapper,
            key,
            run,
            token,
            tools: launch.tools,
            commands: commands_rx,
            output: output_tx,
            ids: 0,
            last_tool: String::new(),
            prompts: VecDeque::new(),
            in_turn: false,
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
    /// A replay's client did what the recording does not have, or not what it has; the replay ends, failed.
    Diverged(String),
}

/// How long a replay waits for its client to do what the recording's client did.
const CLIENT_LIMIT: Duration = Duration::from_secs(30);

struct Player {
    mock: Mock,
    key: String,
    mapper: Mapper,
    run: u64,
    token: String,
    tools: Arc<Endpoint>,
    commands: UnboundedReceiver<Command>,
    output: UnboundedSender<Body>,
    ids: u64,
    last_tool: String,
    /// Prompts that came while the mock was not waiting for one, kept for the next prompt step, as a provider would.
    prompts: VecDeque<String>,
    in_turn: bool,
}

impl Player {
    async fn play(mut self) {
        let caps = self.mock.inner.script.capabilities;
        let replay = self.mock.inner.script.replay;
        loop {
            // A real agent's events come one at a time; so do the mock's.
            tokio::task::yield_now().await;
            let Some(step) = self.mock.next_step(&self.key, self.run) else {
                // A replayed agent stays up after its last turn, as a provider does, so a prompt or cancel the
                // recording does not have still reaches it; the recorded client is told the recording is over.
                if replay && !self.in_turn {
                    let got = match self.mock.inner.recorded.load(Ordering::Relaxed) {
                        true => self.wait_for(ClientAction::Close, |_| false, false).await,
                        false => self.wait(|_| false, false).await,
                    };
                    if let Got::Diverged(reason) = got {
                        self.send(Body::Failed { kind: FailKind::Provider, reason });
                    }
                }
                return;
            };
            let got = match step {
                Step::Prompt(recorded) => {
                    let got = match self.prompts.pop_front() {
                        Some(_) => Got::Go,
                        None => {
                            let remain = self.mock.play(&self.key, self.run, |play, steps| play.at < steps.len()).unwrap_or(false);
                            let action = match recorded {
                                Some(text) => ClientAction::Prompt(Some(self.mapper.text(&text))),
                                None if remain => ClientAction::Prompt(None),
                                None => ClientAction::Close,
                            };
                            self.wait_for(action, |c| matches!(c, Command::Prompt(_)), false).await
                        }
                    };
                    match got {
                        Got::Go | Got::Matched(_) => self.send(Body::TurnStarted),
                        other => other,
                    }
                }
                Step::Turn => self.send(Body::TurnStarted),
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
                Step::Fail(reason) => self.send(Body::Failed { kind: FailKind::Provider, reason }),
                Step::Sleep(ms) => match tokio::time::timeout(Duration::from_millis(ms), self.wait(|_| false, true)).await {
                    Ok(got) => got,
                    Err(_) => Got::Go,
                },
                Step::Cancel => self.wait_for(ClientAction::Cancel, |c| *c == Command::Cancel, false).await,
                Step::Permission { kind, tool, input, answer } => {
                    let id = self.fresh("p");
                    self.send(Body::Permission { id: id.clone(), kind, tool, input });
                    let accept = |c: &Command| matches!(c, Command::Answer { id: got, .. } if *got == id);
                    match self.wait_for(ClientAction::Answer(answer), accept, true).await {
                        Got::Matched(Command::Answer { decision, .. }) if answer.is_some_and(|recorded| recorded != decision) => {
                            Got::Diverged(format!("the replay was answered {decision:?} where the recording has {answer:?}"))
                        }
                        Got::Matched(Command::Answer { decision: Decision::Deny, .. }) if caps.deny_ends_turn && !replay => {
                            self.mock.skip_turn(&self.key, self.run);
                            self.send(Body::TurnEnded { how: TurnEnd::Denied })
                        }
                        got => got,
                    }
                }
                Step::Call { name, input, result } => {
                    let _ = self.mock.inner.client.send(Some(ClientAction::ToolResult(result)));
                    let (tools, token) = (self.tools.clone(), self.token.clone());
                    let call = async move { tools.call(&token, &name, input).await };
                    let (mock, key, run) = (self.mock.clone(), self.key.clone(), self.run);
                    // A reply that is ready is taken before a stop, as an agent reads what it was sent.
                    let got = tokio::select! {
                        biased;
                        reply = call => {
                            mock.play(&key, run, |play, _| play.replies.push(reply));
                            Got::Go
                        }
                        got = self.wait(|_| false, true) => got,
                    };
                    let _ = self.mock.inner.client.send(None);
                    got
                }
            };
            match got {
                Got::Go | Got::Matched(_) => {}
                Got::Cancelled => {
                    self.mock.skip_turn(&self.key, self.run);
                    self.send(Body::TurnEnded { how: TurnEnd::Cancelled });
                }
                // A diverged replay plays nothing more, and says so once.
                Got::Diverged(reason) => {
                    self.mock.finish(&self.key, self.run);
                    self.send(Body::Failed { kind: FailKind::Provider, reason });
                    return;
                }
                Got::Stopped => {
                    // A resume starts again at the step that was waiting, or past the turn it was in.
                    self.mock.play(&self.key, self.run, |play, _| play.at -= 1);
                    return;
                }
            }
        }
    }

    fn send(&mut self, mut body: Body) -> Got {
        match body {
            Body::TurnStarted => self.in_turn = true,
            Body::TurnEnded { .. } | Body::Failed { .. } => self.in_turn = false,
            _ => {}
        }
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
    /// A replay waits for the recorded client at most `CLIENT_LIMIT`.
    async fn wait_for(&mut self, action: ClientAction, accept: impl Fn(&Command) -> bool, in_turn: bool) -> Got {
        let what = match action {
            ClientAction::Prompt(_) => "prompt",
            ClientAction::Answer(_) => "answer",
            ClientAction::ToolResult(_) => "tool result",
            ClientAction::Cancel => "cancel",
            ClientAction::Close => "close",
        };
        let _ = self.mock.inner.client.send(Some(action));
        let got = match self.mock.inner.script.replay && self.mock.inner.recorded.load(Ordering::Relaxed) {
            true => tokio::time::timeout(CLIENT_LIMIT, self.wait(accept, in_turn)).await.unwrap_or_else(|_| {
                Got::Diverged(format!("the recorded client's {what} did not come within {} s", CLIENT_LIMIT.as_secs()))
            }),
            false => self.wait(accept, in_turn).await,
        };
        let _ = self.mock.inner.client.send(None);
        got
    }

    /// Waits for the command `accept` takes. A prompt that comes meanwhile is kept for the next prompt step; a cancel
    /// outside a turn and any other command are received and passed over. In a replay, a cancel or a prompt the
    /// recording does not have here is a divergence.
    async fn wait(&mut self, accept: impl Fn(&Command) -> bool, in_turn: bool) -> Got {
        loop {
            let Some(command) = self.commands.recv().await else { return Got::Stopped };
            // A start that was resumed over is stopped: what it is sent is not its own any more.
            if self.mock.play(&self.key, self.run, |play, _| play.received.push(command.clone())).is_none() {
                return Got::Stopped;
            }
            match command {
                Command::Stop | Command::Kill => return Got::Stopped,
                command if accept(&command) => return Got::Matched(command),
                Command::Cancel if self.mock.inner.script.replay => return Got::Diverged("the replay was cancelled where the recording was not".into()),
                Command::Prompt(_) if self.mock.inner.script.replay => return Got::Diverged("the replay was prompted where the recording was not".into()),
                Command::Cancel if in_turn => return Got::Cancelled,
                Command::Prompt(text) => self.prompts.push_back(text),
                _ => {}
            }
        }
    }
}

/// Maps the recorded run's values to this play's: a session id per recorded session (this play's for the first), a
/// fresh id per recorded id, a port per recorded loopback port (port 0 for the first, until the session has a tools
/// endpoint with a port), and this process's pid. Sessions, ids and ports are mapped as whole words wherever they
/// stand; a pid only in a field that names one, since the same number in free text may be anything.
struct Mapper {
    to: HashMap<String, String>,
    words: Option<(AhoCorasick, Vec<String>)>,
    pids: HashMap<String, u32>,
}

impl Mapper {
    fn new(recorded: &[(String, Recorded)], session: &str) -> Result<Mapper, String> {
        let (mut to, mut pids, mut counts) = (HashMap::new(), HashMap::new(), HashMap::new());
        for (value, kind) in recorded {
            if to.contains_key(value) || pids.contains_key(value) {
                continue;
            }
            let n = *counts.entry(*kind).and_modify(|n| *n += 1).or_insert(0);
            let live = match kind {
                Recorded::Pid => {
                    pids.insert(value.clone(), std::process::id());
                    continue;
                }
                Recorded::Session if n == 0 => session.to_owned(),
                Recorded::Session => format!("{session}-{n}"),
                Recorded::Id => format!("id{n}"),
                Recorded::Port => format!("{}:{n}", value.rsplit_once(':').map_or("", |(host, _)| host)),
            };
            to.insert(value.clone(), live);
        }
        let keys: Vec<String> = to.keys().cloned().collect();
        let words = match keys.is_empty() {
            true => None,
            false => Some((AhoCorasick::new(&keys).map_err(|e| e.to_string())?, keys)),
        };
        Ok(Mapper { to, words, pids })
    }

    fn text(&self, s: &str) -> String {
        let Some((finder, keys)) = &self.words else { return s.to_owned() };
        let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        // Each whole word, leftmost and then longest: a match that is no whole word does not hide one inside it.
        let mut words: Vec<_> = finder
            .find_overlapping_iter(s)
            .filter(|found| !word(s[..found.start()].chars().next_back()) && !word(s[found.end()..].chars().next()))
            .collect();
        words.sort_by_key(|found| (found.start(), std::cmp::Reverse(found.end())));
        let (mut out, mut last) = (String::with_capacity(s.len()), 0);
        for found in words {
            if found.start() < last {
                continue;
            }
            out.push_str(&s[last..found.start()]);
            out.push_str(&self.to[&keys[found.pattern().as_usize()]]);
            last = found.end();
        }
        out.push_str(&s[last..]);
        out
    }

    fn pids_in(&self, value: &mut Value) {
        match value {
            Value::Object(fields) => {
                for (key, field) in fields.iter_mut() {
                    let recorded = match &*field {
                        Value::Number(n) => Some(n.to_string()),
                        Value::String(s) => Some(s.clone()),
                        _ => None,
                    };
                    match recorded.and_then(|r| self.pids.get(&r)).filter(|_| fixture::field_kind(key) == Some(Recorded::Pid)) {
                        Some(pid) if field.is_number() => *field = Value::from(*pid),
                        Some(pid) => *field = Value::from(pid.to_string()),
                        None => self.pids_in(field),
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.pids_in(item)),
            _ => {}
        }
    }

    fn body(&self, body: &mut Body) {
        if self.to.is_empty() && self.pids.is_empty() {
            return;
        }
        let mut value = serde_json::to_value(&*body).expect("a body always serializes");
        self.pids_in(&mut value);
        each_string(&mut value, &mut |s| *s = self.text(s));
        *body = serde_json::from_value(value).expect("mapping an id-shaped word or a pid keeps the body's shape");
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

    #[test]
    fn mock_a_recorded_id_inside_a_longer_one_that_is_no_whole_word_is_still_mapped() {
        let recorded = [("item-aaaaaa-call-bbbbbb".to_owned(), Recorded::Id), ("call-bbbbbb".to_owned(), Recorded::Id)];
        let mapper = Mapper::new(&recorded, "s").unwrap();
        assert_eq!(mapper.text("xitem-aaaaaa-call-bbbbbb"), "xitem-aaaaaa-id1");
        assert_eq!(mapper.text("item-aaaaaa-call-bbbbbb and call-bbbbbb"), "id0 and id1", "the longest whole word wins");
        // The review's case: a recorded uuid glued after a recorded call id.
        let uuid = "0a0b0c0d-1111-4222-8333-444455556666";
        let recorded = [(format!("call_x-{uuid}"), Recorded::Id), (uuid.to_owned(), Recorded::Id)];
        assert_eq!(Mapper::new(&recorded, "s").unwrap().text(&format!("zcall_x-{uuid}")), "zcall_x-id1");
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

    #[tokio::test]
    async fn mock_an_old_start_stopped_inside_a_step_after_a_resume_cannot_move_the_new_one() {
        let lines = ["{\"prompt\": null}", "{\"sleep\": 60000}", "{\"end\": \"done\"}", "{\"prompt\": null}", "{\"say\": \"two\"}", "{\"end\": \"done\"}"];
        let mock = Mock::new(Script::parse(&lines.join("\n")).unwrap());
        let mut old = mock.open(launch(None)).unwrap();
        let Some(Body::Started { provider_session, .. }) = old.output.recv().await else { panic!() };
        old.commands.send(Command::Prompt("one".into())).unwrap();
        assert_eq!(old.output.recv().await, Some(Body::TurnStarted));
        while mock.plays()[&provider_session].at < 2 {
            tokio::task::yield_now().await;
        }
        // The old start is now inside its sleep.
        // A resume while the old start still sleeps, as after a stop grace that ran out.
        let mut new = mock.open(launch(Some(provider_session.clone()))).unwrap();
        new.output.recv().await;
        new.commands.send(Command::Prompt("two".into())).unwrap();
        let mut said = vec![];
        for _ in 0..3 {
            said.push(tokio::time::timeout(Duration::from_secs(5), new.output.recv()).await.unwrap().unwrap());
        }
        assert_eq!(said[1], Body::Text { text: "two".into() });
        let at = mock.plays()[&provider_session].at;
        old.commands.send(Command::Stop).unwrap();
        assert_eq!(old.output.recv().await, None, "the old start ends");
        assert_eq!(mock.plays()[&provider_session].at, at, "its stop did not move the new start's place");
    }

    #[tokio::test]
    async fn mock_a_start_resumed_over_while_it_waits_for_a_prompt_takes_no_command() {
        let mock = Mock::new(Script::parse("{\"prompt\": null}\n{\"say\": \"one\"}").unwrap());
        let mut old = mock.open(launch(None)).unwrap();
        let Some(Body::Started { provider_session, .. }) = old.output.recv().await else { panic!() };
        // The old start has taken its prompt step and waits in it.
        while mock.plays()[&provider_session].at < 1 {
            tokio::task::yield_now().await;
        }
        let _new = mock.open(launch(Some(provider_session.clone()))).unwrap();
        old.commands.send(Command::Prompt("stale".into())).unwrap();
        assert_eq!(old.output.recv().await, None, "the old start went, and played nothing");
        assert!(mock.received(&provider_session).is_empty(), "the stale prompt is not the new start's");
    }
}
