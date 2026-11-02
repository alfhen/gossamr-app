//! Pip's assistant runs. `ClaudeCodeProvider` drives the user's `claude` against Pip's local MCP tools and reports
//! events; `AgentService` prepares each run's prompt and screen context and routes events to the page.

mod agent_tools;
pub mod context;
mod drafts;
mod github;
pub mod images;
pub mod mcp;
pub mod queue;
mod runs;
pub mod sandbox;
pub mod supervisor;
pub mod workstream;

#[cfg(test)]
mod real_tests;
#[cfg(test)]
pub(crate) mod world;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::auth::Scope;
use crate::claude::{ClaudeCodeProvider, Launch};
use crate::model_choice::ModelChoice;
use crate::db::PipTurn;
use crate::domain::{ClonePlan, ProposalQuery, Run, StateKind};
use crate::runs::message::Delivery;
use crate::error::{Error, Result};
use crate::inbox::Core;
use context::ScreenContext;
use images::ImageInput;
use mcp::McpServer;
use queue::{Enqueued, QueueItem, Removed, TurnQueue};
use sandbox::Sandbox;
use supervisor::{event_line, fact_keys, wake_identity, WakeFacts, WAKE_REQUEST};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Started { session_id: String },
    Text { text: String },
    /// A step the agent took, in words a person can read.
    Tool { label: String },
    Done {
        session_id: Option<String>,
        ok: bool,
        message: Option<String>,
        /// What the turn cost, when the provider reports it.
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<TurnUsage>,
    },
    /// The turn waits behind `ahead` turns of its conversation, or for room when that is 0. Only `AgentService` says
    /// this, never the provider.
    Queued { ahead: usize },
    /// The turn left the queue and its provider is starting. Only `AgentService` says this, never the provider.
    Running,
}

impl AgentEvent {
    /// Whether this is about the turn queue rather than from the agent itself.
    pub fn is_queue_news(&self) -> bool {
        matches!(self, AgentEvent::Queued { .. } | AgentEvent::Running)
    }
}

/// The tokens and money one turn used, as the provider reported them. A turn stopped before its provider reported has
/// none: the Claude CLI reports usage only in its closing `result` line, which a stopped process never writes, so totals
/// built from these undercount stopped turns.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: Option<f64>,
}

/// Pip's local MCP server, the only tool surface a run is given. The token is valid for this one run.
#[derive(Clone)]
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for McpEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpEndpoint").field("url", &self.url).finish_non_exhaustive()
    }
}

pub struct AgentRequest {
    pub run_id: String,
    pub system: String,
    /// Screen context, open drafts and the person's request, already composed.
    pub prompt: String,
    pub mcp: McpEndpoint,
    /// The working folder. A `Sandbox` can only be made by `Sandbox::prepare`, so no run is started anywhere else.
    pub sandbox: Sandbox,
    /// Continues an earlier session. Never needed for correctness: the prompt is complete.
    pub session: Option<String>,
    /// Screenshots sent with the prompt, inline.
    pub images: Vec<ImageInput>,
    pub launch: Launch,
}

/// What Pip's agent tools need from the agent-run service: where a run would be set up, and to start, message and stop
/// one. Everything but `plan` is Pip's own action and is recorded as Pip's.
#[async_trait]
pub trait AgentDriver: Send + Sync {
    /// Where a run in `repo` would be set up: the clone to use, its default branch and a fresh worktree name for
    /// ticket `key` titled `title`. The error is in words Pip can pass on.
    async fn plan(&self, repo: &str, key: &str, title: &str) -> std::result::Result<ClonePlan, String>;

    /// Why no agent could start now because of Claude itself (missing, or signed out), in words Pip can pass on; `None`
    /// when it can, or when that can't be told.
    async fn unready(&self) -> Option<String> {
        None
    }

    /// Hands the queued run to the launcher in the background: first marked as waiting for a slot
    /// when the cap or an earlier run holds it back. Returns the run as it then stands.
    async fn begin(self: Arc<Self>, run_id: String) -> Result<Run>;

    /// Sends Pip's `text` to the agent, by what it is doing; see `runs::message`.
    async fn message(&self, run_id: &str, text: &str) -> Result<(Run, Delivery)>;

    /// Stops the agent, and lets a run waiting for its slot take it.
    async fn stop(self: Arc<Self>, run_id: String) -> Result<Run>;
}

pub type EventStream = mpsc::UnboundedReceiver<AgentEvent>;

/// The conversation a request belongs to when the page doesn't say: Pip's general conversation, outside any workstream.
pub const GENERAL_CONVERSATION: &str = "general";

/// What the general conversation was called before workstreams; its turns were moved to `general`.
const LEGACY_WORKSPACE_CONVERSATION: &str = "workspace";

/// A workstream's conversation is `ws:<id>`.
pub(crate) const WORKSTREAM_PREFIX: &str = "ws:";

fn general() -> String {
    GENERAL_CONVERSATION.into()
}

/// The conversation `raw` names, with the legacy `workspace` read as `general` so a page that still sends it keeps
/// working.
pub fn conversation_id(raw: &str) -> String {
    match raw {
        LEGACY_WORKSPACE_CONVERSATION => GENERAL_CONVERSATION.into(),
        other => other.into(),
    }
}

/// The connection a conversation id names and the conversation's own name. A workstream's id and a bare name name no connection.
pub fn split_conversation(id: &str) -> (Option<&str>, &str) {
    if id.starts_with(WORKSTREAM_PREFIX) {
        return (None, id);
    }
    match id.rsplit_once(':') {
        Some((connection, name)) if !connection.is_empty() && !name.is_empty() => (Some(connection), name),
        _ => (None, id),
    }
}

/// The key a turn on `connection_id` is kept under: `<connection>:<name>`, so no two Jira connections share a conversation,
/// a session or a model choice. A workstream's `ws:<id>` is kept as it is; the workstream has one connection already.
pub fn conversation_in(raw: &str, connection_id: &str) -> String {
    let raw = conversation_id(raw);
    if raw.starts_with(WORKSTREAM_PREFIX) {
        return raw;
    }
    format!("{connection_id}:{}", split_conversation(&raw).1)
}

/// The workstream whose conversation `conversation` is, if it is one.
pub fn workstream_of_conversation(conversation: &str) -> Option<&str> {
    conversation.strip_prefix(WORKSTREAM_PREFIX).filter(|id| !id.is_empty())
}

fn conversation<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<String, D::Error> {
    Ok(conversation_id(&String::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    pub request_id: String,
    pub prompt: String,
    pub session_id: Option<String>,
    #[serde(default)]
    pub context: ScreenContext,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    /// Where the turn is kept: `general` for the Pip pane, `ws:<id>` for a workstream's conversation, a ticket key for
    /// the classic drawer. `workspace` is read as `general`. A `<connection>:` in front names the connection the person
    /// picked, as `connection_id` does; the turn is kept under the connection it ran on.
    #[serde(default = "general", deserialize_with = "conversation")]
    pub conversation: String,
    /// How the page showed the question, kept with it so the conversation reads the same after a restart.
    #[serde(default)]
    pub meta: Option<TurnMeta>,
    /// The instance and model to run on. Checked in Rust before it reaches the command line. Without one the turn takes
    /// its conversation's last choice, else the Settings default.
    #[serde(default)]
    pub model: Option<ModelChoice>,
    /// The connection the person picked in the drawer, for a conversation with no ticket. Checked in Rust: it must be
    /// registered and on. A workstream's connection or the open ticket's takes precedence.
    #[serde(default)]
    pub connection_id: Option<String>,
    /// For a wake turn only: the `[Event]` lines Rust wrote. Never taken from the page.
    #[serde(skip)]
    pub event: Option<String>,
}

/// What the page showed with a question besides its words. Images are counted, not kept.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnMeta {
    pub quote: Option<String>,
    pub looking: Option<String>,
    pub image_count: u32,
    /// The short line the person's bubble shows when the prompt is an instruction the page wrote for Pip ("Discuss this
    /// review"). Display only: it is kept with the turn and never sent to Claude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shown: Option<String>,
}

/// The most of a `shown` line that is kept, in characters.
const SHOWN_MAX_CHARS: usize = 200;

/// A `shown` line as it is kept: trimmed, cut to `SHOWN_MAX_CHARS`, and none when nothing is left.
fn shown_line(shown: Option<String>) -> Option<String> {
    let line = shown?.trim().to_string();
    if line.is_empty() {
        return None;
    }
    Some(match line.char_indices().nth(SHOWN_MAX_CHARS) {
        Some((cut, _)) => line[..cut].trim_end().to_string(),
        None => line,
    })
}

/// What a turn has said and done so far, kept in memory while it runs so a reloaded page can show it.
#[derive(Debug, Clone, Default)]
struct LiveTurn {
    text: String,
    steps: Vec<String>,
}

/// What became of a question when it was sent: started straight away, or queued behind `ahead` turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOutcome {
    pub queued: bool,
    pub ahead: usize,
}

/// Why a turn that was taken out of the queue never ran.
pub const REMOVED: &str = "Removed before it started";

/// Why a wake never ran: its workstream was paused or closed before it started. Its facts count as not woken, so the
/// supervisor wakes Pip for them once the workstream is resumed.
pub const WAKE_PAUSED: &str = "Paused before it started";

/// How a wake that couldn't be started ends: Pip never saw its facts, so they count as not woken.
pub const WAKE_NOT_STARTED: &str = "Couldn't start";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub request_id: String,
    #[serde(flatten)]
    pub event: AgentEvent,
}

pub type UpdateSink = Arc<dyn Fn(Update) + Send + Sync>;

/// Where a wake's events go, told the wake's facts as they stand when an event happens: those of a wake merged into one
/// still waiting are in them.
pub type WakeSink = Arc<dyn Fn(&WakeFacts, Update) + Send + Sync>;

fn bound(sink: &WakeSink, facts: &WakeFacts) -> UpdateSink {
    let (sink, facts) = (sink.clone(), facts.clone());
    Arc::new(move |u| sink(&facts, u))
}

/// A wake turn that is running, kept so a person's message in its conversation can stop it and queue it again.
struct WakeInFlight {
    conversation: String,
    scope: Scope,
    facts: WakeFacts,
    sink: WakeSink,
}

/// What became of a wake queued in a conversation that already had one waiting.
enum WakeEntered {
    Merged(String),
    Entered(Enqueued<QueueItem>),
}

pub struct AgentService {
    core: Arc<Core>,
    mcp: McpServer,
    provider: ClaudeCodeProvider,
    live: Mutex<HashMap<String, LiveTurn>>,
    queue: Mutex<TurnQueue<QueueItem>>,
    /// Turns stopped while their provider was still starting; it is stopped as soon as it has.
    stop_early: Mutex<HashSet<String>>,
    /// Request ids `ask` is recording and queueing, so the same id sent twice at once is taken only once.
    sending: Mutex<HashSet<String>>,
    /// Wake turns running now, by request id.
    wakes: Mutex<HashMap<String, WakeInFlight>>,
}

/// A request id reserved in `AgentService::sending` until `ask` is done with it.
struct Sending<'a> {
    set: &'a Mutex<HashSet<String>>,
    id: String,
}

impl Drop for Sending<'_> {
    fn drop(&mut self) {
        self.set.lock().expect("lock poisoned").remove(&self.id);
    }
}

/// Recording a turn is best effort, and a sign-out mid-turn is expected to refuse it.
fn recorded(r: Result<()>) {
    match r {
        Ok(()) | Err(Error::SiteChanged) | Err(Error::NotSignedIn) => {}
        Err(e) => eprintln!("couldn't record Pip's turn: {e}"),
    }
}

impl AgentService {
    pub fn new(core: Arc<Core>, mcp: McpServer) -> Self {
        Self::with_provider(core, mcp, ClaudeCodeProvider::new())
    }

    fn with_provider(core: Arc<Core>, mcp: McpServer, provider: ClaudeCodeProvider) -> Self {
        Self {
            core,
            mcp,
            provider,
            live: Mutex::new(HashMap::new()),
            queue: Mutex::new(TurnQueue::default()),
            stop_early: Mutex::new(HashSet::new()),
            sending: Mutex::new(HashSet::new()),
            wakes: Mutex::new(HashMap::new()),
        }
    }

    /// Stops a turn. One still waiting is taken out of the queue and ends failed without starting; the running one is
    /// stopped by its provider, and the next waiting turn of its conversation then starts.
    pub async fn cancel(&self, request_id: &str) {
        self.cancel_with(request_id, REMOVED).await;
    }

    /// `cancel`, saying `why` for a turn that never started. A running wake is forgotten at once, so a person's message
    /// in its conversation can't queue it again.
    async fn cancel_with(&self, request_id: &str, why: &str) {
        let removed = {
            let mut queue = self.queue.lock().expect("lock poisoned");
            let removed = queue.remove(request_id);
            if matches!(removed, Removed::InFlight) {
                // Its provider may still be starting and not know the run yet; `start` stops it once it does. Marked
                // under the queue's lock, so the turn can't end in between and leave the mark behind.
                self.stop_early.lock().expect("lock poisoned").insert(request_id.to_string());
            }
            removed
        };
        match removed {
            Removed::Waiting(item) => {
                let (scope, sink) = match item {
                    QueueItem::User { scope, sink, .. } => (scope, sink),
                    QueueItem::Wake { scope, facts, sink } => (scope, bound(&sink, &facts)),
                };
                recorded(self.core.pip_turn_finish(&scope, request_id, "", false, Some(why), None, None).await);
                sink(Update { request_id: request_id.to_string(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(why.into()), usage: None } });
            }
            Removed::InFlight => {
                self.wakes.lock().expect("lock poisoned").remove(request_id);
                self.provider.cancel(request_id);
            }
            Removed::Unknown => {}
        }
    }

    /// The turns of `conversation`, with what any turn still running has said so far.
    pub async fn turns(&self, conversation: &str) -> Result<Vec<PipTurn>> {
        let mut turns = self.core.pip_turns(conversation).await?;
        let live = self.live.lock().expect("lock poisoned");
        for t in turns.iter_mut().filter(|t| t.status == "running" || t.status == "queued") {
            if let Some(l) = live.get(&t.request_id) {
                t.text = l.text.clone();
                t.steps = l.steps.clone();
            }
        }
        Ok(turns)
    }

    /// Queues a question. It starts now when its conversation has nothing running and there is room, and otherwise
    /// once the turns ahead of it have ended; either way its events go to `sink`. In a workstream's conversation a
    /// person's message also takes out the wakes waiting and stops a wake running; their facts are queued again behind
    /// the message.
    pub async fn ask(self: &Arc<Self>, mut req: AskRequest, sink: UpdateSink) -> Result<AskOutcome> {
        req.conversation = conversation_id(&req.conversation);
        req.event = None;
        // Checked and reserved under the queue's lock, and held until the turn is queued, so a second send of the same id
        // can't pass the check while the first is still being recorded.
        let _sending = {
            let queue = self.queue.lock().expect("lock poisoned");
            let mut sending = self.sending.lock().expect("lock poisoned");
            if queue.position(&req.request_id).is_some() || !sending.insert(req.request_id.clone()) {
                return Err(Error::Claude("That question was already sent.".into()));
            }
            Sending { set: &self.sending, id: req.request_id.clone() }
        };
        let drawer = req.connection_id.as_deref().or(split_conversation(&req.conversation).0);
        let scope = self.core.pip_scope(workstream_of_conversation(&req.conversation), req.context.item.as_ref(), drawer).await?;
        req.conversation = conversation_in(&req.conversation, &scope.connection_id);
        let mut meta = req.meta.clone().unwrap_or_else(|| TurnMeta { image_count: req.images.len() as u32, ..Default::default() });
        meta.shown = shown_line(meta.shown.take());
        // Kept as waiting until its provider has started, so a reload shows it either way.
        recorded(self.core.pip_turn_begin(&scope, &req.conversation, &req.request_id, &req.prompt, &meta, "queued").await);
        // A choice the page sent is refused now, not when the turns ahead of it end. `start` checks again for a state that
        // changes while the turn waits.
        if let Some(asked) = req.model.clone() {
            if let Err(e) = self.core.pip_launch(Some(&asked), |shell| self.provider.find(shell)).await {
                recorded(self.core.pip_turn_finish(&scope, &req.request_id, "", false, Some(&e.to_string()), None, None).await);
                return Err(e);
            }
        }
        let workstream = workstream_of_conversation(&req.conversation).map(str::to_string);
        if let Some(id) = workstream.as_ref().filter(|_| meta.shown.is_none()) {
            // What the person types answers a question Pip asked in this workstream, if one is open; a line the page
            // wrote for them (`shown`) doesn't.
            recorded(self.core.clear_pip_ask(&scope, id, "answered").await.map(drop));
        }
        let mut again = Vec::new();
        if workstream.is_some() {
            let waiting = self.queue.lock().expect("lock poisoned").waiting_wakes(&req.conversation);
            for id in waiting {
                if let Some(QueueItem::Wake { scope, facts, sink }) = self.queue.lock().expect("lock poisoned").waiting(&id) {
                    again.push((scope.clone(), facts.clone(), sink.clone()));
                }
                self.cancel(&id).await;
            }
        }
        let (conversation, run_id) = (req.conversation.clone(), req.request_id.clone());
        let item = QueueItem::User { scope: scope.clone(), req: Box::new(req), sink: sink.clone() };
        let entered = self.queue.lock().expect("lock poisoned").enqueue(&conversation, &run_id, item);
        if workstream.is_some() {
            let running = {
                let mut wakes = self.wakes.lock().expect("lock poisoned");
                let id = wakes.iter().find(|(_, w)| w.conversation == conversation).map(|(id, _)| id.clone());
                id.and_then(|id| wakes.remove(&id).map(|w| (id, w)))
            };
            if let Some((id, wake)) = running {
                self.cancel(&id).await;
                again.insert(0, (wake.scope, wake.facts, wake.sink));
            }
            for (scope, facts, sink) in again {
                if let Err(e) = self.queue_wake(scope, conversation.clone(), facts, sink).await {
                    eprintln!("couldn't queue Pip's wake again after the person's message: {e}");
                }
            }
        }
        match entered {
            Enqueued::Start(QueueItem::Wake { .. }) => unreachable!("a person's question was queued"),
            Enqueued::Start(QueueItem::User { scope, req, sink }) => match self.start(scope.clone(), *req, sink).await {
                Ok(()) => Ok(AskOutcome { queued: false, ahead: 0 }),
                Err(e) => {
                    recorded(self.core.pip_turn_finish(&scope, &run_id, "", false, Some(&e.to_string()), None, None).await);
                    self.release(&run_id, None);
                    Err(e)
                }
            },
            Enqueued::Waiting { ahead } => {
                sink(Update { request_id: run_id, event: AgentEvent::Queued { ahead } });
                Ok(AskOutcome { queued: true, ahead })
            }
        }
    }

    /// Wakes Pip in workstream `ws_id` with `facts`: a turn of its conversation that gives way to the person's messages.
    /// While another wake waits there, the facts are merged into that one instead. The turn is kept with its event lines
    /// as its prompt and kind `wake`, and asked like any other.
    pub async fn wake(self: &Arc<Self>, ws_id: &str, facts: WakeFacts, sink: WakeSink) -> Result<()> {
        let scope = self.core.workstream_scope(ws_id).await?;
        self.queue_wake(scope, format!("{WORKSTREAM_PREFIX}{ws_id}"), facts, sink).await
    }

    async fn queue_wake(self: &Arc<Self>, scope: Scope, conversation: String, facts: WakeFacts, sink: WakeSink) -> Result<()> {
        let request_id = format!("wake-{}", crate::proposals::new_id()?);
        recorded(self.core.pip_wake_begin(&scope, &conversation, &request_id, &event_line(&facts), &fact_keys(&facts), "queued").await);
        let told = bound(&sink, &facts);
        let entered = {
            let mut queue = self.queue.lock().expect("lock poisoned");
            match queue.merge_wake(&conversation, &facts) {
                Some(id) => WakeEntered::Merged(id),
                None => WakeEntered::Entered(queue.enqueue(&conversation, &request_id, QueueItem::Wake { scope: scope.clone(), facts, sink: sink.clone() })),
            }
        };
        match entered {
            WakeEntered::Merged(id) => {
                recorded(self.core.pip_turn_forget(&scope, &request_id).await);
                let waiting = {
                    let queue = self.queue.lock().expect("lock poisoned");
                    match queue.waiting(&id) {
                        Some(QueueItem::Wake { facts, sink, .. }) => Some((event_line(facts), fact_keys(facts), bound(sink, facts), queue.position(&id).unwrap_or(0))),
                        _ => None,
                    }
                };
                if let Some((lines, keys, sink, ahead)) = waiting {
                    recorded(self.core.pip_wake_lines(&scope, &id, &lines, &keys).await);
                    // The page reads the merged lines from the stored turn when it hears of the wake again.
                    sink(Update { request_id: id, event: AgentEvent::Queued { ahead } });
                }
                Ok(())
            }
            WakeEntered::Entered(Enqueued::Start(QueueItem::Wake { scope, facts, sink })) => self.start_wake(request_id, scope, facts, sink).await,
            WakeEntered::Entered(Enqueued::Start(QueueItem::User { .. })) => unreachable!("a wake was queued"),
            WakeEntered::Entered(Enqueued::Waiting { ahead }) => {
                told(Update { request_id, event: AgentEvent::Queued { ahead } });
                Ok(())
            }
        }
    }

    /// Starts wake turn `request_id`. When it cannot start it ends failed through its own sink, and the queue moves on.
    /// A wake whose workstream was paused or closed after it was queued never starts: it ends with `WAKE_PAUSED`,
    /// however it got here (queued behind a turn, queued again behind the person's message, or just admitted).
    async fn start_wake(self: &Arc<Self>, request_id: String, scope: Scope, facts: WakeFacts, wake_sink: WakeSink) -> Result<()> {
        let conversation = format!("{WORKSTREAM_PREFIX}{}", facts.workstream);
        let sink = bound(&wake_sink, &facts);
        if !self.wakes_allowed(&scope, &facts.workstream).await {
            recorded(self.core.pip_turn_finish(&scope, &request_id, "", false, Some(WAKE_PAUSED), None, None).await);
            sink(Update { request_id: request_id.clone(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(WAKE_PAUSED.into()), usage: None } });
            self.release(&request_id, None);
            return Ok(());
        }
        let req = AskRequest {
            request_id: request_id.clone(),
            prompt: WAKE_REQUEST.into(),
            session_id: self.queue.lock().expect("lock poisoned").session(&conversation),
            context: ScreenContext::default(),
            images: Vec::new(),
            conversation: conversation.clone(),
            meta: None,
            model: None,
            connection_id: None,
            event: Some(event_line(&facts)),
        };
        self.wakes.lock().expect("lock poisoned").insert(request_id.clone(), WakeInFlight { conversation, scope: scope.clone(), facts, sink: wake_sink });
        if let Err(e) = self.start(scope.clone(), req, sink.clone()).await {
            self.wakes.lock().expect("lock poisoned").remove(&request_id);
            let message = format!("{WAKE_NOT_STARTED}: {e}");
            recorded(self.core.pip_turn_finish(&scope, &request_id, "", false, Some(&message), None, None).await);
            sink(Update { request_id: request_id.clone(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(message.clone()), usage: None } });
            self.release(&request_id, None);
            // Its sink was told, which the caller can tell from the error.
            return Err(Error::Claude(message));
        }
        Ok(())
    }

    /// Whether workstream `ws_id` may have Pip woken in it now: it is open and not paused.
    async fn wakes_allowed(&self, scope: &Scope, ws_id: &str) -> bool {
        let Ok(Some(view)) = self.core.workstream(scope, ws_id).await else { return false };
        view.workstream.closed_at.is_none() && view.workstream.paused_reason.is_none()
    }

    /// Stops every turn of workstream `ws_id`'s conversation, those waiting first so none starts in between, as
    /// closing or pausing it does. A wake that never started ends with `WAKE_PAUSED`.
    pub async fn cancel_workstream_turns(&self, ws_id: &str) {
        let conversation = format!("{WORKSTREAM_PREFIX}{ws_id}");
        let turns = self.queue.lock().expect("lock poisoned").turns_of(&conversation);
        for id in turns.iter().rev() {
            let why = if self.is_wake(id) { WAKE_PAUSED } else { REMOVED };
            self.cancel_with(id, why).await;
        }
    }

    /// Stops the wakes of workstream `ws_id`, waiting or running, and leaves the person's turns be: what the supervisor's
    /// own pause does.
    pub async fn cancel_workstream_wakes(&self, ws_id: &str) {
        let conversation = format!("{WORKSTREAM_PREFIX}{ws_id}");
        let turns = self.queue.lock().expect("lock poisoned").turns_of(&conversation);
        for id in turns.iter().rev().filter(|id| self.is_wake(id)) {
            self.cancel_with(id, WAKE_PAUSED).await;
        }
    }

    /// Whether `request_id` is a wake, waiting or running.
    fn is_wake(&self, request_id: &str) -> bool {
        self.wakes.lock().expect("lock poisoned").contains_key(request_id) || matches!(self.queue.lock().expect("lock poisoned").waiting(request_id), Some(QueueItem::Wake { .. }))
    }

    /// Ends `run_id`'s place in the queue and starts what may run now.
    fn release(self: &Arc<Self>, run_id: &str, session: Option<String>) {
        let next = {
            let mut queue = self.queue.lock().expect("lock poisoned");
            self.stop_early.lock().expect("lock poisoned").remove(run_id);
            queue.finished(run_id, session)
        };
        for (id, item) in next {
            let this = self.clone();
            tokio::spawn(async move { this.start_queued(id, item).await });
        }
    }

    /// Starts a turn that waited. A turn sent without a session continues the one its conversation's last turn ended
    /// with. When it cannot start it ends failed through its own sink, and the queue moves on.
    async fn start_queued(self: Arc<Self>, id: String, item: QueueItem) {
        let (scope, mut req, sink) = match item {
            QueueItem::User { scope, req, sink } => (scope, *req, sink),
            QueueItem::Wake { scope, facts, sink } => {
                // A failure was already told through its sink.
                let _ = self.start_wake(id, scope, facts, sink).await;
                return;
            }
        };
        if req.session_id.is_none() {
            req.session_id = self.queue.lock().expect("lock poisoned").session(&req.conversation);
        }
        let run_id = req.request_id.clone();
        if let Err(e) = self.start(scope.clone(), req, sink.clone()).await {
            recorded(self.core.pip_turn_finish(&scope, &run_id, "", false, Some(&e.to_string()), None, None).await);
            sink(Update { request_id: run_id.clone(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(e.to_string()), usage: None } });
            self.release(&run_id, None);
        }
    }

    async fn start(self: &Arc<Self>, scope: Scope, req: AskRequest, sink: UpdateSink) -> Result<()> {
        images::validate(&req.images)?;
        let choice = self.core.pip_choice(&req.conversation, req.model.clone()).await?;
        let (instance, launch) = self.core.pip_launch(choice.as_ref(), |shell| self.provider.find(shell)).await?;
        // A turn in a workstream's conversation works in that workstream, which must be an open one of this account.
        let mut workstream = match workstream_of_conversation(&req.conversation) {
            Some(id) => Some(workstream::for_turn(&self.core, &scope, id).await?),
            None => None,
        };
        if let Some(ws) = workstream.as_mut() {
            ws.event = req.event.clone();
        }

        let mut context = req.context.in_connection(&scope.connection_id).only_in(&scope.connection_id);
        if let Some(name) = self.core.off_name(&scope.connection_id) {
            context.item = None;
            context.selection.clear();
            context.tracker_off = Some(name);
        }
        let mut handed = mcp::Keyed::default();
        context::keys_in(&req.prompt).iter().for_each(|key| handed.hand(&scope, key));
        if let Some(key) = workstream.as_ref().and_then(|w| w.workstream.item_key.as_ref()) {
            handed.hand(&scope, key);
        }
        if let Some(r) = &context.item {
            handed.hand(&scope, &r.key);
            context.unwatched_item = !self.core.is_item_watched(&scope, &r.key).await?;
        }
        let mut read = mcp::Keyed::default();
        let item = match &context.item {
            Some(r) => {
                let (ticket, seen) = self.core.ticket_for_pip(&scope, &r.key).await?;
                let text = mcp::describe_with(&ticket, &seen.description);
                read.insert(&scope, &r.key, seen);
                Some(text)
            }
            None => None,
        };
        let links = match &context.item {
            Some(r) => self.core.dev_links(r).unwrap_or_default(),
            None => Vec::new(),
        };
        let open = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
        let drafts = self.core.proposals_in(&scope, &open).await?;
        let runs = runs::context_runs(&self.core, &scope, &handed).await;
        let sandbox = Sandbox::prepare(&self.core.data_dir())?;
        // A workstream's conversation continues its own session when the page has none to give.
        let asked = req.session_id.or_else(|| workstream.as_ref().and_then(|w| w.workstream.pip_session.clone()));
        let session = match asked {
            Some(id) if self.core.is_pip_session(&id, &instance, &scope.connection_id).await? => Some(id),
            _ => None,
        };

        let run_id = req.request_id.clone();
        let agent_req = AgentRequest {
            run_id: run_id.clone(),
            system: self.system_prompt(&scope).await?,
            prompt: context::compose(&context, item.as_deref(), &links, &drafts, &runs, workstream.as_ref(), &req.prompt),
            mcp: self.mcp.endpoint(&run_id)?,
            sandbox,
            session,
            images: req.images,
            launch,
        };

        // Registered before the run starts, since the agent may call the tools straight away.
        let workstream_id = workstream.map(|w| w.workstream.id);
        let wake = self.wakes.lock().expect("lock poisoned").get(&run_id).map(|w| wake_identity(&w.facts));
        let pip = mcp::PipRun { scope: scope.clone(), handed, read, workstream: workstream_id.clone(), starts: 0, wake };
        self.mcp.runs.lock().expect("lock poisoned").insert(run_id.clone(), pip);
        self.live.lock().expect("lock poisoned").insert(run_id.clone(), LiveTurn::default());
        recorded(self.core.pip_turn_status(&scope, &run_id, "running").await);
        sink(Update { request_id: run_id.clone(), event: AgentEvent::Running });
        let mut events = match self.provider.run(agent_req).await {
            Ok(e) => e,
            Err(e) => {
                self.finish(&run_id);
                return Err(e);
            }
        };
        // Kept only once the provider has started the turn, so a refused choice never becomes the conversation's last one.
        if let Some(choice) = &choice {
            recorded(self.core.pip_turn_model(&scope, &req.request_id, choice).await);
        }
        if self.stop_early.lock().expect("lock poisoned").remove(&run_id) {
            self.provider.cancel(&run_id);
        }

        let this = self.clone();
        let key = context.item.map(|r| r.key);
        tokio::spawn(async move {
            let mut session = None;
            let mut ended = false;
            while let Some(event) = events.recv().await {
                // A provider never says these; the queue's own are sent by `ask` and `start`.
                if event.is_queue_news() {
                    continue;
                }
                match &event {
                    AgentEvent::Started { session_id } => session = Some(session_id.clone()),
                    AgentEvent::Text { text } => this.live_turn(&run_id, |l| l.text.push_str(text)),
                    AgentEvent::Tool { label } => {
                        this.live_turn(&run_id, |l| l.steps.push(label.clone()));
                        recorded(this.core.pip_turn_step(&scope, &run_id, label).await);
                    }
                    AgentEvent::Queued { .. } | AgentEvent::Running => {}
                    AgentEvent::Done { session_id, ok, message, usage } => {
                        if let Some(id) = session_id {
                            session = Some(id.clone());
                        }
                        let text = this.live.lock().expect("lock poisoned").get(&run_id).map(|l| l.text.clone()).unwrap_or_default();
                        let error = message.as_deref().or((!ok).then_some("Pip stopped"));
                        recorded(this.core.pip_turn_finish(&scope, &run_id, &text, *ok, error, session.as_deref(), usage.as_ref()).await);
                        ended = true;
                    }
                }
                sink(Update { request_id: run_id.clone(), event });
            }
            if !ended {
                let text = this.live.lock().expect("lock poisoned").get(&run_id).map(|l| l.text.clone()).unwrap_or_default();
                recorded(this.core.pip_turn_finish(&scope, &run_id, &text, false, Some("Pip stopped"), session.as_deref(), None).await);
            }
            if let Some(id) = &session {
                let _ = this.core.remember_claude_session(&scope, key.as_deref(), id, &instance).await;
                if let Some(ws) = &workstream_id {
                    recorded(this.core.set_workstream_session(&scope, ws, id, &instance).await);
                }
            }
            this.finish(&run_id);
            this.release(&run_id, session);
        });
        Ok(())
    }

    async fn system_prompt(&self, scope: &Scope) -> Result<String> {
        let prompt = context::system_prompt(self.core.can_edit_text(scope)?);
        Ok(match self.core.pip_site(scope).await {
            Some(site) => format!("{prompt} {}", context::site_note(&site)),
            None => prompt,
        })
    }

    fn live_turn(&self, run_id: &str, f: impl FnOnce(&mut LiveTurn)) {
        if let Some(l) = self.live.lock().expect("lock poisoned").get_mut(run_id) {
            f(l);
        }
    }

    fn finish(&self, run_id: &str) {
        self.wakes.lock().expect("lock poisoned").remove(run_id);
        self.live.lock().expect("lock poisoned").remove(run_id);
        self.mcp.runs.lock().expect("lock poisoned").remove(run_id);
        self.mcp.revoke(run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ask_request_takes_images_and_works_without_them() {
        let with: AskRequest = serde_json::from_str(
            r#"{"requestId":"r","prompt":"p","sessionId":null,"images":[{"mediaType":"image/png","data":"AAAA"}]}"#,
        )
        .unwrap();
        assert_eq!(with.images[0].media_type, "image/png");
        let without: AskRequest = serde_json::from_str(r#"{"requestId":"r","prompt":"p","sessionId":null}"#).unwrap();
        assert!(without.images.is_empty());
        assert_eq!((without.conversation.as_str(), without.meta), (GENERAL_CONVERSATION, None));

        let kept: AskRequest = serde_json::from_str(
            r#"{"requestId":"r","prompt":"p","sessionId":null,"conversation":"CA-1","meta":{"quote":"q","looking":"CA-1","imageCount":2}}"#,
        )
        .unwrap();
        assert_eq!(kept.conversation, "CA-1");
        assert_eq!(kept.meta, Some(TurnMeta { quote: Some("q".into()), looking: Some("CA-1".into()), image_count: 2, ..Default::default() }));
        let partial: AskRequest = serde_json::from_str(r#"{"requestId":"r","prompt":"p","sessionId":null,"meta":{}}"#).unwrap();
        assert_eq!(partial.meta, Some(TurnMeta::default()));
    }

    #[test]
    fn the_legacy_workspace_conversation_is_read_as_general_and_ws_names_a_workstream() {
        let legacy: AskRequest = serde_json::from_str(r#"{"requestId":"r","prompt":"p","sessionId":null,"conversation":"workspace"}"#).unwrap();
        assert_eq!(legacy.conversation, GENERAL_CONVERSATION);
        let ws: AskRequest = serde_json::from_str(r#"{"requestId":"r","prompt":"p","sessionId":null,"conversation":"ws:w1"}"#).unwrap();
        assert_eq!(ws.conversation, "ws:w1");
        assert_eq!((conversation_id("workspace"), conversation_id("general"), conversation_id("CA-1")), ("general".into(), "general".into(), "CA-1".into()));
        let beta = "jira:cloud:beta";
        assert_eq!(split_conversation(&format!("{beta}:general")), (Some(beta), "general"));
        assert_eq!((split_conversation("general"), split_conversation("ws:w1")), ((None, "general"), (None, "ws:w1")));
        assert_eq!(conversation_in("workspace", beta), format!("{beta}:general"));
        assert_eq!(conversation_in("CA-1", beta), format!("{beta}:CA-1"));
        assert_eq!(conversation_in(&format!("jira:other:acme:general"), beta), format!("{beta}:general"), "a turn is kept under the connection it ran on");
        assert_eq!(conversation_in("ws:w1", beta), "ws:w1");
        assert_eq!(workstream_of_conversation("ws:w1"), Some("w1"));
        for none in ["ws:", "general", "workspace", "CA-1", "w1"] {
            assert_eq!(workstream_of_conversation(none), None, "{none}");
        }
    }

    mod recording {
        use super::*;
        use crate::agent::runs::testing::FakePlanner;
        use crate::claude::StandIn;
        use crate::inbox::testing::{fixture, Fixture};
        use std::time::Duration;
        use tokio::sync::Notify;

        /// Sends `events`, waits for `gate` when there is one, then ends with a `Done` carrying usage. `refuse` makes
        /// `run` itself fail.
        struct Fake {
            events: Vec<AgentEvent>,
            gate: Option<Arc<Notify>>,
            refuse: bool,
        }

        fn usage() -> TurnUsage {
            TurnUsage { input_tokens: 31, output_tokens: 7, cache_creation_tokens: 0, cache_read_tokens: 12, cost_usd: Some(0.0021) }
        }

        #[async_trait]
        impl StandIn for Fake {
            async fn run(&self, _req: AgentRequest) -> Result<EventStream> {
                if self.refuse {
                    return Err(Error::Claude("Claude isn't installed".into()));
                }
                let (tx, rx) = mpsc::unbounded_channel();
                let (events, gate) = (self.events.clone(), self.gate.clone());
                tokio::spawn(async move {
                    let _ = tx.send(AgentEvent::Started { session_id: "sess-1".into() });
                    for e in events {
                        let _ = tx.send(e);
                    }
                    if let Some(g) = gate {
                        g.notified().await;
                    }
                    let _ = tx.send(AgentEvent::Done { session_id: Some("sess-1".into()), ok: true, message: None, usage: Some(usage()) });
                });
                Ok(rx)
            }

            fn cancel(&self, _run_id: &str) {}
        }

        async fn service(fx: &Fixture, fake: Fake) -> Arc<AgentService> {
            let server = McpServer::start(fx.core.clone(), FakePlanner::unused(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
            Arc::new(AgentService::with_provider(fx.core.clone(), server, ClaudeCodeProvider::standing_in(Arc::new(fake))))
        }

        fn ask(id: &str) -> AskRequest {
            AskRequest {
                request_id: id.into(),
                prompt: "What changed?".into(),
                session_id: None,
                context: ScreenContext::default(),
                images: Vec::new(),
                conversation: GENERAL_CONVERSATION.into(),
                meta: Some(TurnMeta { quote: None, looking: Some("the board".into()), image_count: 0, ..Default::default() }),
                model: None,
                connection_id: None,
                event: None,
            }
        }

        async fn settled(svc: &AgentService, id: &str) -> PipTurn {
            for _ in 0..200 {
                let turns = svc.turns(GENERAL_CONVERSATION).await.unwrap();
                if let Some(t) = turns.into_iter().find(|t| t.request_id == id && t.status != "running") {
                    return t;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("turn {id} never finished");
        }

        fn text(t: &str) -> AgentEvent {
            AgentEvent::Text { text: t.into() }
        }

        #[tokio::test]
        async fn a_finished_turn_is_recorded_with_its_text_steps_session_and_usage() {
            let fx = fixture().await;
            let events = vec![AgentEvent::Tool { label: "Looked up CA-1".into() }, text("Two "), text("things.")];
            let svc = service(&fx, Fake { events, gate: None, refuse: false }).await;
            let seen = Arc::new(Mutex::new(Vec::new()));
            let into = seen.clone();
            svc.ask(ask("q1"), Arc::new(move |u| into.lock().unwrap().push(u.event))).await.unwrap();

            let t = settled(&svc, "q1").await;
            assert_eq!((t.status.as_str(), t.text.as_str(), t.prompt.as_str()), ("done", "Two things.", "What changed?"));
            assert_eq!(t.steps, ["Looked up CA-1"]);
            assert_eq!((t.session_id.as_deref(), t.usage), (Some("sess-1"), Some(usage())));
            assert_eq!(t.looking.as_deref(), Some("the board"));
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(matches!(seen.lock().unwrap().last(), Some(AgentEvent::Done { usage: Some(_), .. })), "the page is told the usage too");
        }

        #[tokio::test]
        async fn the_persons_next_message_in_a_workstream_clears_the_question_pip_asked_there_and_nothing_else_does() {
            let fx = fixture().await;
            let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap().id;
            fx.core.pip_asks_person(&fx.scope, &ws, "Shall I build it?").await.unwrap();
            let svc = service(&fx, Fake { events: vec![text("Fine.")], gate: None, refuse: false }).await;
            let open = || async { fx.core.workstream(&fx.scope, &ws).await.unwrap().unwrap().pip_ask };

            svc.ask(ask("q1"), Arc::new(|_| {})).await.unwrap();
            settled(&svc, "q1").await;
            assert!(open().await.is_some(), "a message in General is about nothing Pip asked");

            let mut in_workstream = ask("q2");
            in_workstream.conversation = format!("ws:{ws}");
            svc.ask(in_workstream, Arc::new(|_| {})).await.unwrap();
            assert_eq!(open().await, None);
            let cleared: Vec<_> = fx.core.workstream_events(&fx.scope, &ws).await.unwrap().into_iter().filter(|e| e.action == "pip_ask_cleared").map(|e| (e.actor, e.detail)).collect();
            assert_eq!(cleared, [(crate::domain::Actor::Person, Some("answered".to_string()))]);
        }

        #[tokio::test]
        async fn a_stored_turn_keeps_the_short_line_the_bubble_shows_and_caps_a_long_one() {
            let fx = fixture().await;
            let svc = service(&fx, Fake { events: vec![text("Fine.")], gate: None, refuse: false }).await;
            let mut short = ask("q1");
            short.prompt = "Let's talk about the GitHub review draft p-1: read it with get_proposal.".into();
            short.meta.as_mut().unwrap().shown = Some("  Discuss this review ".into());
            svc.ask(short, Arc::new(|_| {})).await.unwrap();
            let t = settled(&svc, "q1").await;
            assert_eq!(t.shown.as_deref(), Some("Discuss this review"));
            assert!(t.prompt.contains("get_proposal"), "the instruction itself is what is kept as the prompt");

            let mut long = ask("q2");
            long.meta.as_mut().unwrap().shown = Some("é".repeat(SHOWN_MAX_CHARS + 50));
            svc.ask(long, Arc::new(|_| {})).await.unwrap();
            let t = settled(&svc, "q2").await;
            assert_eq!(t.shown.map(|s| s.chars().count()), Some(SHOWN_MAX_CHARS));
            svc.ask(ask("q3"), Arc::new(|_| {})).await.unwrap();
            assert_eq!(settled(&svc, "q3").await.shown, None);
        }

        #[tokio::test]
        async fn a_provider_that_cannot_start_leaves_a_failed_turn() {
            let fx = fixture().await;
            let svc = service(&fx, Fake { events: vec![], gate: None, refuse: true }).await;
            let err = svc.ask(ask("q1"), Arc::new(|_| {})).await.unwrap_err();
            assert!(err.to_string().contains("isn't installed"));
            let turns = svc.turns(GENERAL_CONVERSATION).await.unwrap();
            assert_eq!(turns.len(), 1);
            assert_eq!(turns[0].status, "failed");
            assert!(turns[0].error.as_deref().unwrap_or_default().contains("isn't installed"));
            assert!(svc.live.lock().unwrap().is_empty(), "nothing is left in memory");
        }

        #[tokio::test]
        async fn a_turn_still_running_shows_what_it_has_said_so_far() {
            let fx = fixture().await;
            let gate = Arc::new(Notify::new());
            let events = vec![AgentEvent::Tool { label: "Listed the drafts".into() }, text("Half an ")];
            let svc = service(&fx, Fake { events, gate: Some(gate.clone()), refuse: false }).await;
            svc.ask(ask("q1"), Arc::new(|_| {})).await.unwrap();

            let mut mid = None;
            for _ in 0..200 {
                let turns = svc.turns(GENERAL_CONVERSATION).await.unwrap();
                if turns.first().is_some_and(|t| t.text == "Half an ") {
                    mid = turns.into_iter().next();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let mid = mid.expect("the partial answer is overlaid");
            assert_eq!((mid.status.as_str(), mid.steps.len()), ("running", 1));
            let stored = fx.core.pip_turns(GENERAL_CONVERSATION).await.unwrap();
            assert_eq!((stored[0].text.as_str(), stored[0].steps.len()), ("", 1), "text is written once, on Done; steps as they come");

            gate.notify_one();
            let t = settled(&svc, "q1").await;
            assert_eq!((t.status.as_str(), t.text.as_str()), ("done", "Half an "));
        }

        #[tokio::test]
        async fn removing_jira_mid_turn_writes_nothing_afterwards() {
            let fx = fixture().await;
            let gate = Arc::new(Notify::new());
            let svc = service(&fx, Fake { events: vec![text("secret")], gate: Some(gate.clone()), refuse: false }).await;
            svc.ask(ask("q1"), Arc::new(|_| {})).await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            fx.core.remove_instance(&fx.scope.connection_id).await.unwrap();
            gate.notify_one();
            for _ in 0..100 {
                if svc.live.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let turns = fx.core.pip_turns(GENERAL_CONVERSATION).await.unwrap();
            assert!(!turns.is_empty() && turns.iter().all(|t| t.text.is_empty()), "{turns:?}");
            assert!(turns.iter().all(|t| (t.status.as_str(), t.error.as_deref()) == ("failed", Some(crate::db::DISCONNECTED))), "{turns:?}");
        }

    mod queueing {
        use super::*;
        use crate::agent::runs::testing::FakePlanner;
        use crate::claude::StandIn;
        use crate::inbox::testing::{fixture, fixture_with_two_jira, Fixture};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;
        use tokio::sync::Notify;

        /// Holds every run open until the test opens its gate, and counts how many run at once.
        #[derive(Default)]
        struct Counting {
            now: AtomicUsize,
            most: AtomicUsize,
            /// Each run started, with the session it was asked to continue.
            started: Mutex<Vec<(String, Option<String>)>>,
            /// The prompt each run was given, by run id.
            prompts: Mutex<HashMap<String, String>>,
            /// The system prompt each run was given, by run id.
            systems: Mutex<HashMap<String, String>>,
            gates: Mutex<HashMap<String, Arc<Notify>>>,
            stopped: Mutex<HashSet<String>>,
        }

        #[derive(Clone, Default)]
        struct Fake(Arc<Counting>);

        #[async_trait]
        impl StandIn for Fake {
            async fn run(&self, req: AgentRequest) -> Result<EventStream> {
                let c = self.0.clone();
                c.started.lock().unwrap().push((req.run_id.clone(), req.session.clone()));
                c.prompts.lock().unwrap().insert(req.run_id.clone(), req.prompt.clone());
                c.systems.lock().unwrap().insert(req.run_id.clone(), req.system.clone());
                let now = c.now.fetch_add(1, Ordering::SeqCst) + 1;
                c.most.fetch_max(now, Ordering::SeqCst);
                let gate = Arc::new(Notify::new());
                c.gates.lock().unwrap().insert(req.run_id.clone(), gate.clone());
                let (tx, rx) = mpsc::unbounded_channel();
                let session = req.session.unwrap_or_else(|| format!("sess-{}", req.run_id));
                tokio::spawn(async move {
                    let _ = tx.send(AgentEvent::Started { session_id: session.clone() });
                    gate.notified().await;
                    let stopped = c.stopped.lock().unwrap().contains(&req.run_id);
                    let _ = tx.send(AgentEvent::Text { text: format!("answer {}", req.run_id) });
                    c.now.fetch_sub(1, Ordering::SeqCst);
                    let message = stopped.then(|| "Stopped".to_string());
                    let _ = tx.send(AgentEvent::Done { session_id: Some(session), ok: !stopped, message, usage: None });
                });
                Ok(rx)
            }

            fn cancel(&self, run_id: &str) {
                self.0.stopped.lock().unwrap().insert(run_id.into());
                if let Some(g) = self.0.gates.lock().unwrap().get(run_id) {
                    g.notify_one();
                }
            }
        }

        impl Fake {
            fn started(&self) -> Vec<String> {
                self.0.started.lock().unwrap().iter().map(|(id, _)| id.clone()).collect()
            }

            fn session_of(&self, id: &str) -> Option<String> {
                self.0.started.lock().unwrap().iter().find(|(r, _)| r == id).and_then(|(_, s)| s.clone())
            }

            async fn until_started(&self, n: usize) {
                for _ in 0..300 {
                    if self.started().len() >= n {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                panic!("only {:?} started, waiting for {n}", self.started());
            }

            /// Lets run `id` end, once it has started.
            async fn open(&self, id: &str) {
                for _ in 0..300 {
                    let gate = self.0.gates.lock().unwrap().get(id).cloned();
                    if let Some(g) = gate {
                        g.notify_one();
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                panic!("{id} never started");
            }
        }

        type Seen = Arc<Mutex<Vec<(String, AgentEvent)>>>;

        async fn service(fx: &Fixture, fake: Fake) -> (Arc<AgentService>, Seen, UpdateSink) {
            let server = McpServer::start(fx.core.clone(), FakePlanner::unused(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
            let svc = Arc::new(AgentService::with_provider(fx.core.clone(), server, ClaudeCodeProvider::standing_in(Arc::new(fake))));
            let seen: Seen = Arc::default();
            let into = seen.clone();
            (svc, seen, Arc::new(move |u: Update| into.lock().unwrap().push((u.request_id, u.event))))
        }

        fn ask(id: &str, conversation: &str) -> AskRequest {
            AskRequest {
                request_id: id.into(),
                prompt: format!("question {id}"),
                session_id: None,
                context: ScreenContext::default(),
                images: Vec::new(),
                conversation: conversation.into(),
                meta: None,
                model: None,
                connection_id: None,
                event: None,
            }
        }

        fn events_of(seen: &Seen, id: &str) -> Vec<AgentEvent> {
            seen.lock().unwrap().iter().filter(|(r, _)| r == id).map(|(_, e)| e.clone()).collect()
        }

        async fn status(fx: &Fixture, conversation: &str, id: &str) -> String {
            fx.core.pip_turns(conversation).await.unwrap().into_iter().find(|t| t.request_id == id).map(|t| t.status).unwrap_or_default()
        }

        async fn until_status(fx: &Fixture, conversation: &str, id: &str, want: &str) {
            for _ in 0..300 {
                if status(fx, conversation, id).await == want {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("{id} is {}, never {want}", status(fx, conversation, id).await);
        }

        #[tokio::test]
        async fn turns_in_one_conversation_run_one_after_another_and_continue_the_session() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, seen, sink) = service(&fx, fake.clone()).await;
            assert_eq!(svc.ask(ask("q1", "A"), sink.clone()).await.unwrap(), AskOutcome { queued: false, ahead: 0 });
            assert_eq!(svc.ask(ask("q2", "A"), sink.clone()).await.unwrap(), AskOutcome { queued: true, ahead: 1 });
            assert_eq!(svc.ask(ask("q3", "A"), sink.clone()).await.unwrap(), AskOutcome { queued: true, ahead: 2 });
            fake.until_started(1).await;
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(fake.started(), ["q1"], "the others wait");
            assert_eq!(events_of(&seen, "q2"), [AgentEvent::Queued { ahead: 1 }]);

            fake.open("q1").await;
            fake.until_started(2).await;
            fake.open("q2").await;
            fake.until_started(3).await;
            fake.open("q3").await;
            until_status(&fx, "A", "q3", "done").await;

            assert_eq!(fake.started(), ["q1", "q2", "q3"]);
            assert_eq!(fake.0.most.load(Ordering::SeqCst), 1, "never two at once in one conversation");
            assert_eq!(fake.session_of("q1"), None);
            assert_eq!(fake.session_of("q2").as_deref(), Some("sess-q1"), "a queued turn continues the session the one before it ended with");
            assert_eq!(fake.session_of("q3").as_deref(), Some("sess-q1"));
            let q2 = events_of(&seen, "q2");
            assert_eq!(q2[..2], [AgentEvent::Queued { ahead: 1 }, AgentEvent::Running]);
            assert!(matches!(q2.last(), Some(AgentEvent::Done { ok: true, .. })));
        }

        #[tokio::test]
        async fn a_question_still_being_recorded_cannot_be_sent_again() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            // As a first send of q1 holds it between its check and its place in the queue, while it records the turn.
            svc.sending.lock().unwrap().insert("q1".into());
            assert!(svc.ask(ask("q1", "A"), sink.clone()).await.is_err(), "the second send is refused");
            assert_eq!(status(&fx, "A", "q1").await, "", "and records nothing");
            svc.sending.lock().unwrap().clear();

            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            assert!(svc.sending.lock().unwrap().is_empty(), "a send that went through leaves nothing reserved");
            fake.open("q1").await;
            until_status(&fx, "A", "q1", "done").await;
            assert_eq!(fake.started(), ["q1"]);
        }

        #[tokio::test]
        async fn four_conversations_never_run_more_than_two_at_once() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut outcomes = Vec::new();
            for c in ["A", "B", "C", "D"] {
                outcomes.push(svc.ask(ask(&format!("{c}1"), c), sink.clone()).await.unwrap().queued);
            }
            assert_eq!(outcomes, [false, false, true, true]);
            fake.until_started(2).await;
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(fake.started().len(), 2);

            fake.open("A1").await;
            fake.until_started(3).await;
            fake.open("B1").await;
            fake.until_started(4).await;
            fake.open("C1").await;
            fake.open("D1").await;
            for (c, id) in [("A", "A1"), ("B", "B1"), ("C", "C1"), ("D", "D1")] {
                until_status(&fx, c, id, "done").await;
            }
            assert_eq!(fake.started(), ["A1", "B1", "C1", "D1"], "the oldest waiting turn starts first");
            assert_eq!(fake.0.most.load(Ordering::SeqCst), 2);
        }

        #[tokio::test]
        async fn a_waiting_turn_that_is_cancelled_ends_failed_and_never_starts() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, seen, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            svc.ask(ask("q2", "A"), sink.clone()).await.unwrap();
            svc.ask(ask("q3", "A"), sink.clone()).await.unwrap();
            assert_eq!(status(&fx, "A", "q2").await, "queued");

            svc.cancel("q2").await;
            let q2 = events_of(&seen, "q2");
            assert!(matches!(q2.last(), Some(AgentEvent::Done { ok: false, message: Some(m), .. }) if m == REMOVED), "{q2:?}");
            assert_eq!(status(&fx, "A", "q2").await, "failed");

            fake.open("q1").await;
            fake.until_started(2).await;
            fake.open("q3").await;
            until_status(&fx, "A", "q3", "done").await;
            assert_eq!(fake.started(), ["q1", "q3"]);
            let turns = fx.core.pip_turns("A").await.unwrap();
            assert_eq!(turns.iter().find(|t| t.request_id == "q2").and_then(|t| t.error.as_deref()), Some(REMOVED));
            svc.cancel("q2").await;
            assert_eq!(events_of(&seen, "q2").len(), 2, "cancelling it again does nothing");
        }

        #[tokio::test]
        async fn stopping_the_running_turn_starts_the_next() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, seen, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            svc.ask(ask("q2", "A"), sink.clone()).await.unwrap();
            fake.until_started(1).await;

            svc.cancel("q1").await;
            until_status(&fx, "A", "q1", "failed").await;
            fake.until_started(2).await;
            assert!(matches!(events_of(&seen, "q1").last(), Some(AgentEvent::Done { ok: false, .. })));
            assert!(!fake.0.stopped.lock().unwrap().contains("q2"), "only the running turn is stopped");
            fake.open("q2").await;
            until_status(&fx, "A", "q2", "done").await;
        }

        #[tokio::test]
        async fn a_queued_turn_is_kept_as_queued_then_running_then_done() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            svc.ask(ask("q2", "A"), sink.clone()).await.unwrap();
            assert_eq!(status(&fx, "A", "q2").await, "queued");
            let shown = svc.turns("A").await.unwrap();
            assert_eq!(shown.iter().map(|t| t.status.as_str()).collect::<Vec<_>>(), ["running", "queued"]);

            fake.open("q1").await;
            until_status(&fx, "A", "q2", "running").await;
            fake.open("q2").await;
            until_status(&fx, "A", "q2", "done").await;
            assert_eq!(svc.turns("A").await.unwrap()[1].text, "answer q2");
        }

        #[tokio::test]
        async fn a_queued_turn_that_cannot_start_fails_through_its_own_sink_and_the_queue_moves_on() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, seen, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            let mut bad = ask("q2", "A");
            bad.images = vec![ImageInput { media_type: "image/jpeg".into(), ..images::tests::png() }];
            svc.ask(bad, sink.clone()).await.unwrap();
            svc.ask(ask("q3", "A"), sink.clone()).await.unwrap();

            fake.open("q1").await;
            fake.until_started(2).await;
            assert_eq!(fake.started(), ["q1", "q3"]);
            let q2 = events_of(&seen, "q2");
            assert!(matches!(q2.last(), Some(AgentEvent::Done { ok: false, message: Some(m), .. }) if m.contains("isn't the image/jpeg")), "{q2:?}");
            assert_eq!(status(&fx, "A", "q2").await, "failed");
            fake.open("q3").await;
            until_status(&fx, "A", "q3", "done").await;
        }

        #[tokio::test]
        async fn a_workstream_turn_works_in_it_and_keeps_its_session_on_it() {
            let fx = fixture().await;
            let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
            let conversation = format!("ws:{}", ws.id);
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", &conversation), sink.clone()).await.unwrap();
            fake.until_started(1).await;
            assert_eq!(svc.mcp.runs.lock().unwrap().get("q1").and_then(|p| p.workstream.clone()), Some(ws.id.clone()), "Pip's tools know the workstream");
            assert!(svc.mcp.runs.lock().unwrap().get("q1").is_some_and(|p| p.handed.contains(&p.scope, "CA-1")), "its ticket is handed to Pip");
            let prompt = fake.0.prompts.lock().unwrap().get("q1").cloned().unwrap();
            assert!(prompt.contains(&format!("Id: {} · ticket CA-1 · stage Intake", ws.id)) && prompt.contains("[Open drafts in this workstream]"), "{prompt}");
            let system = fake.0.systems.lock().unwrap().get("q1").cloned().unwrap();
            assert!(system.contains(context::WORKSTREAM), "a workstream's turn has the workstream's guidance: {system}");
            fake.open("q1").await;
            until_status(&fx, &conversation, "q1", "done").await;
            for _ in 0..100 {
                if fx.core.workstream(&fx.scope, &ws.id).await.unwrap().unwrap().workstream.pip_session.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(fx.core.workstream(&fx.scope, &ws.id).await.unwrap().unwrap().workstream.pip_session.as_deref(), Some("sess-q1"));
            assert!(fx.core.pip_turns(GENERAL_CONVERSATION).await.unwrap().is_empty(), "the general conversation is apart");
            svc.ask(ask("g1", GENERAL_CONVERSATION), sink.clone()).await.unwrap();
            fake.until_started(2).await;
            let general = fake.0.systems.lock().unwrap().get("g1").cloned().unwrap();
            assert_eq!(general, system, "every conversation has the same prompt");
            assert!(general.contains("gossamr tools"), "{general}");
            fake.open("g1").await;
            until_status(&fx, GENERAL_CONVERSATION, "g1", "done").await;

            // After a restart the queue knows no session; the workstream's own is continued.
            let fresh = Fake::default();
            let (again, _, sink) = service(&fx, fresh.clone()).await;
            again.ask(ask("q2", &conversation), sink).await.unwrap();
            fresh.until_started(1).await;
            assert_eq!(fresh.session_of("q2").as_deref(), Some("sess-q1"));
            fresh.open("q2").await;
            until_status(&fx, &conversation, "q2", "done").await;
        }

        #[tokio::test]
        async fn a_workstream_turn_with_a_ticket_still_starts_while_its_tracker_is_off() {
            let fx = fixture().await;
            let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
            let conversation = format!("ws:{}", ws.id);
            fx.core.adopt_instances().await;
            fx.core.set_instance_enabled("jira", false).await.unwrap();
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut with_ticket = ask("q1", &conversation);
            with_ticket.context = ScreenContext { item: Some(fx.item("CA-1")), selection: vec![fx.item("CA-2")], ..Default::default() };

            svc.ask(with_ticket, sink.clone()).await.unwrap();

            fake.until_started(1).await;
            let prompt = fake.0.prompts.lock().unwrap().get("q1").cloned().unwrap();
            assert!(prompt.contains("is off, so its tickets are hidden from you"), "{prompt}");
            assert!(!prompt.contains("[Ticket CA-1]") && !prompt.contains("Open item") && !prompt.contains("Selected"), "{prompt}");
            fake.open("q1").await;
            until_status(&fx, &conversation, "q1", "done").await;
        }

        #[tokio::test]
        async fn a_turn_in_a_closed_or_foreign_workstream_fails_without_running() {
            let fx = fixture().await;
            let closed = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
            fx.core.close_workstream(&fx.scope, &closed.id).await.unwrap();
            let mut theirs = fx.core.open_workstream(&fx.scope, None, Some("Theirs".into())).await.unwrap();
            (theirs.id, theirs.connection_id) = ("theirs".into(), "jira:elsewhere:someone".into());
            fx.insert_workstream(&theirs).await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;

            let err = svc.ask(ask("q1", &format!("ws:{}", closed.id)), sink.clone()).await.unwrap_err().to_string();
            assert!(err.contains("is closed"), "{err}");
            let err = svc.ask(ask("q2", "ws:theirs"), sink.clone()).await.unwrap_err().to_string();
            assert!(err.contains("different Jira site or account"), "a workstream of a connection that isn't registered is refused before it is recorded: {err}");
            assert_eq!(status(&fx, &format!("ws:{}", closed.id), "q1").await, "failed");
            assert_eq!(status(&fx, "ws:theirs", "q2").await, "");
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(fake.started().is_empty(), "nothing ran");
            assert!(svc.mcp.runs.lock().unwrap().is_empty());

            svc.ask(ask("q3", "workspace"), sink).await.unwrap();
            fake.until_started(1).await;
            fake.open("q3").await;
            until_status(&fx, GENERAL_CONVERSATION, "q3", "done").await;
            assert_eq!(fx.core.pip_turns("workspace").await.unwrap()[0].conversation, format!("{}:{GENERAL_CONVERSATION}", fx.scope.connection_id), "a legacy name is kept as general");
        }

        fn turn_scope(svc: &AgentService, id: &str) -> Scope {
            svc.mcp.runs.lock().unwrap().get(id).unwrap().scope.clone()
        }

        fn on(connection_id: &str, key: &str) -> crate::domain::ItemRef {
            crate::domain::ItemRef { connection_id: connection_id.into(), external_id: key.into(), key: key.into() }
        }

        #[tokio::test]
        async fn a_turn_with_no_ticket_works_in_the_connection_picked_in_the_drawer_and_a_tickets_beats_the_drawer() {
            let (fx, second) = fixture_with_two_jira().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut drawer = ask("q1", "A");
            drawer.connection_id = Some(second.connection_id.clone());
            let mut ticket = ask("q2", "B");
            ticket.connection_id = Some(second.connection_id.clone());
            ticket.context = ScreenContext { item: Some(on(&fx.scope.connection_id, "CA-1")), ..Default::default() };
            svc.ask(drawer, sink.clone()).await.unwrap();
            svc.ask(ticket, sink.clone()).await.unwrap();
            fake.until_started(2).await;
            assert_eq!(turn_scope(&svc, "q1"), second);
            assert_eq!(turn_scope(&svc, "q2"), fx.scope, "the open ticket's connection wins");

            fake.open("q1").await;
            svc.ask(ask("q3", "C"), sink).await.unwrap();
            fake.until_started(3).await;
            assert_eq!(turn_scope(&svc, "q3"), fx.scope, "else the primary");
        }

        #[tokio::test]
        async fn a_workstreams_connection_wins_and_leaves_out_what_the_page_shows_from_another() {
            let (fx, second) = fixture_with_two_jira().await;
            let ws = fx.core.open_workstream(&second, None, Some("On Beta".into())).await.unwrap();
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut req = ask("q1", &format!("ws:{}", ws.id));
            req.connection_id = Some(fx.scope.connection_id.clone());
            req.context = ScreenContext { item: Some(on(&fx.scope.connection_id, "CA-1")), selection: vec![on(&fx.scope.connection_id, "CA-2")], ..Default::default() };
            svc.ask(req, sink).await.unwrap();
            fake.until_started(1).await;

            assert_eq!(turn_scope(&svc, "q1"), second);
            let prompt = fake.0.prompts.lock().unwrap().get("q1").cloned().unwrap();
            assert!(!prompt.contains("CA-1") && !prompt.contains("CA-2"), "{prompt}");
            let handed = svc.mcp.runs.lock().unwrap().get("q1").unwrap().handed.clone();
            assert!(!handed.contains(&fx.scope, "CA-1") && !handed.contains(&second, "CA-1"));
        }

        #[tokio::test]
        async fn a_connection_that_is_off_or_unknown_is_refused_before_the_turn_is_recorded_or_started() {
            let (fx, second) = fixture_with_two_jira().await;
            fx.core.adopt_instances().await;
            fx.core.set_instance_enabled("jira_2", false).await.unwrap();
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;

            for (n, connection) in [second.connection_id.as_str(), "jira:gone:nobody"].into_iter().enumerate() {
                let mut req = ask(&format!("q{n}"), "A");
                req.connection_id = Some(connection.into());
                assert!(svc.ask(req, sink.clone()).await.is_err(), "{connection}");
            }
            let mut stale_ticket = ask("q9", "A");
            stale_ticket.context = ScreenContext { item: Some(on(&second.connection_id, "CA-1")), ..Default::default() };
            let refused = svc.ask(stale_ticket, sink).await.unwrap_err();
            assert!(refused.to_string().contains("Beta is off"), "{refused}");

            assert!(fx.core.pip_turns("A").await.unwrap().is_empty());
            assert!(fake.started().is_empty());
        }

        #[tokio::test]
        async fn a_session_started_on_one_connection_is_not_resumed_on_another() {
            let (fx, second) = fixture_with_two_jira().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let on_second = |id: &str| {
                let mut req = ask(id, "A");
                req.connection_id = Some(second.connection_id.clone());
                req
            };
            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            fake.until_started(1).await;
            fake.open("q1").await;
            svc.ask(on_second("q2"), sink.clone()).await.unwrap();
            fake.until_started(2).await;
            fake.open("q2").await;
            svc.ask(on_second("q3"), sink).await.unwrap();
            fake.until_started(3).await;

            assert_eq!(fake.session_of("q2"), None, "q1's session read tickets of the other site");
            assert_eq!(fake.session_of("q3").as_deref(), Some("sess-q2"));
            fake.open("q3").await;
            until_status(&fx, &format!("{}:A", second.connection_id), "q3", "done").await;
        }

        #[tokio::test]
        async fn an_open_workstreams_session_is_not_resumed_on_another_connection() {
            let (fx, second) = fixture_with_two_jira().await;
            let ws = fx.core.open_workstream(&second, None, Some("On Beta".into())).await.unwrap();
            fx.core.set_workstream_session(&second, &ws.id, "ws-session", "claude").await.unwrap();
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut on_first = ask("q1", "general");
            on_first.session_id = Some("ws-session".into());
            let mut on_second = ask("q2", "general");
            (on_second.session_id, on_second.connection_id) = (Some("ws-session".into()), Some(second.connection_id.clone()));
            svc.ask(on_first, sink.clone()).await.unwrap();
            svc.ask(on_second, sink).await.unwrap();
            fake.until_started(2).await;

            assert_eq!(fake.session_of("q1"), None, "the workstream's session read Beta's tickets");
            assert_eq!(fake.session_of("q2").as_deref(), Some("ws-session"));
        }

        #[tokio::test]
        async fn each_connection_keeps_its_own_conversation_session_and_model_choice() {
            let (fx, second) = fixture_with_two_jira().await;
            let (first, other) = (fx.scope.connection_id.clone(), second.connection_id.clone());
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let on = |id: &str, connection: &str| {
                let mut req = ask(id, "general");
                req.connection_id = Some(connection.into());
                req
            };
            let mut q1 = on("q1", &first);
            q1.model = Some(ModelChoice { instance_id: "claude".into(), model: "haiku".into(), effort: None });
            svc.ask(q1, sink.clone()).await.unwrap();
            fake.until_started(1).await;
            fake.open("q1").await;
            until_status(&fx, "general", "q1", "done").await;
            // The page keeps one session per conversation it knows, so it sends Acme's session on Beta's turn too.
            let mut q2 = on("q2", &other);
            q2.session_id = Some("sess-q1".into());
            svc.ask(q2, sink.clone()).await.unwrap();
            fake.until_started(2).await;
            fake.open("q2").await;
            until_status(&fx, &format!("{other}:general"), "q2", "done").await;
            let mut q3 = on("q3", &first);
            q3.session_id = Some("sess-q1".into());
            svc.ask(q3, sink).await.unwrap();
            fake.until_started(3).await;

            assert_eq!(fake.session_of("q2"), None, "Acme's session is not Beta's");
            assert_eq!(fake.session_of("q3").as_deref(), Some("sess-q1"), "back on Acme, its own session goes on");
            assert_eq!(fx.core.pip_choice("general", None).await.unwrap().map(|c| c.model), Some("haiku".into()));
            assert_ne!(fx.core.pip_choice(&format!("{other}:general"), None).await.unwrap().map(|c| c.model), Some("haiku".into()), "Acme's model choice is not Beta's");
            let ids = |turns: Vec<crate::db::PipTurn>| turns.into_iter().map(|t| t.request_id).collect::<Vec<_>>();
            assert_eq!(ids(fx.core.pip_turns("general").await.unwrap()), ["q1", "q3"], "a bare name is the primary's");
            assert_eq!(ids(fx.core.pip_turns(&format!("{first}:general")).await.unwrap()), ["q1", "q3"]);
            assert_eq!(ids(fx.core.pip_turns(&format!("{other}:general")).await.unwrap()), ["q2"]);
        }

        #[tokio::test]
        async fn a_conversation_that_names_a_connection_works_there_and_a_stale_one_is_refused() {
            let (fx, second) = fixture_with_two_jira().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", &format!("{}:general", second.connection_id)), sink.clone()).await.unwrap();
            fake.until_started(1).await;
            assert_eq!(turn_scope(&svc, "q1"), second);

            let err = svc.ask(ask("q2", "jira:gone:nobody:general"), sink).await.unwrap_err();
            assert!(matches!(err, Error::SiteChanged), "{err}");
            assert_eq!(fx.core.pip_turns("jira:gone:nobody:general").await.unwrap().len(), 0);
        }

        #[tokio::test]
        async fn a_selection_on_another_connection_is_left_out_and_the_prompt_says_so() {
            let (fx, second) = fixture_with_two_jira().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut req = ask("q1", "general");
            req.prompt = "move CA-1 to Done".into();
            req.context = ScreenContext { selection: vec![on(&second.connection_id, "CA-1")], ..Default::default() };
            svc.ask(req, sink).await.unwrap();
            fake.until_started(1).await;

            assert_eq!(turn_scope(&svc, "q1"), fx.scope, "a selection does not pick the connection");
            let prompt = fake.0.prompts.lock().unwrap().get("q1").cloned().unwrap();
            assert!(!prompt.contains("Selected:") && prompt.contains("1 open or selected ticket(s) are on another site"), "{prompt}");
        }

        #[tokio::test]
        async fn the_system_prompt_names_the_site_only_when_more_than_one_jira_connection_is_on() {
            let fx = fixture().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            svc.ask(ask("q1", "A"), sink).await.unwrap();
            fake.until_started(1).await;
            assert!(!fake.0.systems.lock().unwrap().get("q1").unwrap().contains("This turn works in"));

            let (fx, second) = fixture_with_two_jira().await;
            let fake = Fake::default();
            let (svc, _, sink) = service(&fx, fake.clone()).await;
            let mut req = ask("q2", "A");
            req.connection_id = Some(second.connection_id.clone());
            svc.ask(req, sink).await.unwrap();
            fake.until_started(1).await;
            assert!(fake.0.systems.lock().unwrap().get("q2").unwrap().contains("This turn works in Beta only"));
        }

        #[tokio::test]
        async fn the_same_request_is_not_queued_twice() {
            let fx = fixture().await;
            let (svc, _, sink) = service(&fx, Fake::default()).await;
            svc.ask(ask("q1", "A"), sink.clone()).await.unwrap();
            assert!(svc.ask(ask("q1", "A"), sink.clone()).await.is_err());
        }
    }
    }

    mod instance_and_model {
        use super::*;
        use crate::agent::runs::testing::FakePlanner;
        use crate::claude::StandIn;
        use crate::config::AppConfig;
        use crate::connections::{self, ProviderConfig, ProviderInstance};
        use crate::inbox::testing::{fixture_with_shell, Fixture};
        use crate::runs::env::ShellCapture;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        #[derive(Debug, PartialEq)]
        struct Launched {
            session: Option<String>,
            model: Option<String>,
            effort: Option<String>,
            login: Vec<(String, Option<String>)>,
        }

        #[derive(Default)]
        struct Recorder {
            launched: Mutex<Vec<Launched>>,
            sessions: AtomicUsize,
            hold: std::sync::atomic::AtomicBool,
            held: Mutex<Vec<(mpsc::UnboundedSender<AgentEvent>, String)>>,
        }

        #[async_trait]
        impl StandIn for Recorder {
            async fn run(&self, req: AgentRequest) -> Result<EventStream> {
                let mut cmd = tokio::process::Command::new("claude");
                req.launch.env.apply(&mut cmd);
                let login = cmd.as_std().get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
                self.launched.lock().unwrap().push(Launched { session: req.session.clone(), model: req.launch.model.clone(), effort: req.launch.effort.clone(), login });
                let session = format!("sess-{}", self.sessions.fetch_add(1, Ordering::SeqCst) + 1);
                let (tx, rx) = mpsc::unbounded_channel();
                let _ = tx.send(AgentEvent::Started { session_id: session.clone() });
                if self.hold.load(Ordering::SeqCst) {
                    self.held.lock().unwrap().push((tx, session));
                    return Ok(rx);
                }
                let _ = tx.send(AgentEvent::Done { session_id: Some(session), ok: true, message: None, usage: None });
                Ok(rx)
            }

            fn cancel(&self, _run_id: &str) {}
        }

        impl Recorder {
            fn count(&self) -> usize {
                self.launched.lock().unwrap().len()
            }

            fn finish_held(&self) {
                self.hold.store(false, Ordering::SeqCst);
                for (tx, session) in self.held.lock().unwrap().drain(..) {
                    let _ = tx.send(AgentEvent::Done { session_id: Some(session), ok: true, message: None, usage: None });
                }
            }
        }

        /// The default instance and "Claude work", which has its own folder.
        async fn rig_on(fx: Fixture) -> (Fixture, Arc<AgentService>, Arc<Recorder>) {
            std::fs::create_dir_all(fx.home.join(".claude-work")).unwrap();
            AppConfig::update(&fx.core.data_dir(), |config| {
                config.providers = vec![
                    connections::default_claude(),
                    ProviderInstance {
                        id: "claude_2".into(),
                        display_name: "Claude work".into(),
                        config: ProviderConfig { config_dir: Some("~/.claude-work".into()), ..Default::default() },
                        ..connections::default_claude()
                    },
                ];
            })
            .unwrap();
            let recorder = Arc::new(Recorder::default());
            let server = McpServer::start(fx.core.clone(), FakePlanner::unused(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
            let svc = Arc::new(AgentService::with_provider(fx.core.clone(), server, ClaudeCodeProvider::standing_in(recorder.clone())));
            (fx, svc, recorder)
        }

        async fn rig() -> (Fixture, Arc<AgentService>, Arc<Recorder>) {
            rig_on(fixture_with_shell(ShellCapture::with_env(crate::runs::env::RunEnv::from_pairs([("PATH", "/usr/bin"), ("ANTHROPIC_API_KEY", "sk-shell")]))).await).await
        }

        fn ask(id: &str, conversation: &str, model: Option<ModelChoice>) -> AskRequest {
            AskRequest {
                request_id: id.into(),
                prompt: "Hi".into(),
                session_id: None,
                context: ScreenContext::default(),
                images: Vec::new(),
                conversation: conversation.into(),
                meta: None,
                model,
                connection_id: None,
                event: None,
            }
        }

        fn pick(instance: &str, model: &str, effort: Option<&str>) -> ModelChoice {
            ModelChoice { instance_id: instance.into(), model: model.into(), effort: effort.map(Into::into) }
        }

        async fn done(fx: &Fixture, conversation: &str, id: &str) -> PipTurn {
            for _ in 0..300 {
                if let Some(t) = fx.core.pip_turns(conversation).await.unwrap().into_iter().find(|t| t.request_id == id && t.status != "running" && t.status != "queued") {
                    // The session is recorded just after the turn is.
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    return t;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("turn {id} never finished");
        }

        async fn say(svc: &Arc<AgentService>, req: AskRequest) -> Result<AskOutcome> {
            svc.ask(req, Arc::new(|_| {})).await
        }

        #[tokio::test]
        async fn a_turn_runs_on_the_instance_model_and_effort_the_page_chose_and_keeps_the_choice() {
            let (fx, svc, recorder) = rig().await;
            let choice = pick("claude_2", "opus", Some("high"));
            say(&svc, ask("q1", "general", Some(choice.clone()))).await.unwrap();
            let turn = done(&fx, "general", "q1").await;

            let launched = recorder.launched.lock().unwrap();
            assert_eq!((launched[0].model.as_deref(), launched[0].effort.as_deref()), (Some("opus"), Some("high")));
            let folder = fx.home.join(".claude-work").to_string_lossy().into_owned();
            assert!(launched[0].login.contains(&("CLAUDE_CONFIG_DIR".into(), Some(folder))), "{:?}", launched[0].login);
            assert!(launched[0].login.contains(&("ANTHROPIC_API_KEY".into(), None)), "a key the shell holds can't override the folder's login");
            assert_eq!(turn.model, Some(choice));
        }

        #[tokio::test]
        async fn a_turn_without_a_choice_takes_its_conversations_last_one_and_a_new_conversation_the_settings_default() {
            let (fx, svc, recorder) = rig().await;
            say(&svc, ask("q1", "general", Some(pick("claude_2", "haiku", None)))).await.unwrap();
            done(&fx, "general", "q1").await;
            say(&svc, ask("q2", "general", None)).await.unwrap();
            let again = done(&fx, "general", "q2").await;
            assert_eq!(again.model, Some(pick("claude_2", "haiku", None)));

            say(&svc, ask("q3", "CA-1", None)).await.unwrap();
            let fresh = done(&fx, "CA-1", "q3").await;
            assert_eq!(fresh.model, Some(pick("claude", "sonnet", Some("medium"))), "the default Pip uses");
            let launched = recorder.launched.lock().unwrap();
            assert_eq!(launched.iter().map(|l| l.model.as_deref()).collect::<Vec<_>>(), [Some("haiku"), Some("haiku"), Some("sonnet")]);
            assert_eq!(launched[2].effort.as_deref(), Some("medium"));
        }

        #[tokio::test]
        async fn a_choice_without_an_effort_runs_at_medium_and_keeps_its_own_when_it_has_one() {
            let (fx, svc, recorder) = rig().await;
            say(&svc, ask("q1", "general", Some(pick("claude_2", "opus", None)))).await.unwrap();
            done(&fx, "general", "q1").await;
            say(&svc, ask("q2", "general", Some(pick("claude_2", "opus", Some("high"))))).await.unwrap();
            done(&fx, "general", "q2").await;
            let efforts: Vec<Option<String>> = recorder.launched.lock().unwrap().iter().map(|l| l.effort.clone()).collect();
            assert_eq!(efforts, [Some("medium".into()), Some("high".into())]);
        }

        #[tokio::test]
        async fn a_session_from_before_instances_is_not_resumed_on_any_instance() {
            let (fx, svc, recorder) = rig().await;
            fx.core.with_app_db(|db| db.set_app_meta("pip_sessions", r#"["legacy-1"]"#)).await.unwrap();
            let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap().id;
            fx.core
                .with_app_db(|db| {
                    let mut w = db.workstream(&ws)?.unwrap();
                    w.pip_session = Some("legacy-2".into());
                    db.save_workstream(&w).map(drop)
                })
                .await
                .unwrap();
            let mut question = ask("q1", "general", Some(pick("claude", "sonnet", None)));
            question.session_id = Some("legacy-1".into());
            say(&svc, question).await.unwrap();
            done(&fx, "general", "q1").await;
            let conversation = format!("ws:{ws}");
            say(&svc, ask("q2", &conversation, Some(pick("claude", "sonnet", None)))).await.unwrap();
            done(&fx, &conversation, "q2").await;
            let sessions: Vec<Option<String>> = recorder.launched.lock().unwrap().iter().map(|l| l.session.clone()).collect();
            assert_eq!(sessions, [None, None], "the first turn after the upgrade starts fresh");
        }

        #[tokio::test]
        async fn the_instance_without_a_folder_takes_its_login_variables_from_the_shell() {
            let (fx, svc, recorder) = rig().await;
            say(&svc, ask("q1", "general", Some(pick("claude", "sonnet", None)))).await.unwrap();
            done(&fx, "general", "q1").await;
            let launched = recorder.launched.lock().unwrap();
            assert!(launched[0].login.contains(&("ANTHROPIC_API_KEY".into(), Some("sk-shell".into()))), "{:?}", launched[0].login);
            assert!(launched[0].login.contains(&("CLAUDE_CONFIG_DIR".into(), None)), "a variable the shell lacks is removed, not taken from the app");
        }

        #[tokio::test]
        async fn a_session_is_resumed_only_on_the_instance_that_wrote_it() {
            let (fx, svc, recorder) = rig().await;
            let mut last = None;
            for (id, instance) in [("q1", "claude"), ("q2", "claude_2"), ("q3", "claude_2"), ("q4", "claude")] {
                let mut question = ask(id, "general", Some(pick(instance, "sonnet", None)));
                question.session_id = last.take();
                say(&svc, question).await.unwrap();
                last = done(&fx, "general", id).await.session_id;
            }
            let sessions: Vec<Option<String>> = recorder.launched.lock().unwrap().iter().map(|l| l.session.clone()).collect();
            assert_eq!(sessions, [None, None, Some("sess-2".into()), None], "switching starts fresh, staying continues, and each folder keeps its own");
            assert!(fx.core.is_pip_session("sess-1", "claude", &fx.scope.connection_id).await.unwrap() && !fx.core.is_pip_session("sess-1", "claude_2", &fx.scope.connection_id).await.unwrap());
        }

        #[tokio::test]
        async fn a_workstream_keeps_its_session_with_the_instance_and_does_not_resume_it_on_another() {
            let (fx, svc, recorder) = rig().await;
            let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap().id;
            let conversation = format!("ws:{ws}");
            say(&svc, ask("q1", &conversation, Some(pick("claude_2", "sonnet", None)))).await.unwrap();
            done(&fx, &conversation, "q1").await;
            let kept = fx.core.workstream(&fx.scope, &ws).await.unwrap().unwrap().workstream;
            assert_eq!((kept.pip_session.as_deref(), kept.pip_instance.as_deref()), (Some("sess-1"), Some("claude_2")));

            say(&svc, ask("q2", &conversation, Some(pick("claude", "sonnet", None)))).await.unwrap();
            done(&fx, &conversation, "q2").await;
            let sessions: Vec<Option<String>> = recorder.launched.lock().unwrap().iter().map(|l| l.session.clone()).collect();
            assert_eq!(sessions, [None, None]);
        }

        async fn refused(svc: &Arc<AgentService>, fx: &Fixture, choice: Option<ModelChoice>) -> String {
            let err = say(svc, ask("q9", "general", choice)).await.unwrap_err().to_string();
            let turn = fx.core.pip_turns("general").await.unwrap().into_iter().find(|t| t.request_id == "q9").unwrap();
            assert_eq!((turn.status.as_str(), turn.error.as_deref()), ("failed", Some(err.as_str())));
            fx.core.pip_turn_forget(&fx.scope, "q9").await.unwrap();
            err
        }

        #[tokio::test]
        async fn a_choice_that_cannot_run_is_refused_at_once_in_the_words_of_the_table_and_nothing_starts() {
            let (fx, svc, recorder) = rig().await;
            assert_eq!(refused(&svc, &fx, Some(pick("claude_9", "sonnet", None))).await, "Pick which Claude Pip runs on.");
            assert_eq!(refused(&svc, &fx, Some(pick("claude_2", "default", None))).await, "Pick a model for Pip.");
            assert_eq!(refused(&svc, &fx, Some(pick("claude_2", "sonnet", Some("ludicrous")))).await, "Pick a model for Pip.");
            AppConfig::update(&fx.core.data_dir(), |config| config.providers[1].enabled = false).unwrap();
            assert_eq!(refused(&svc, &fx, Some(pick("claude_2", "sonnet", None))).await, "Pip runs on Claude work, which is off. Turn it on in Settings or pick another.");
            assert_eq!(recorder.count(), 0, "it never falls back to the other instance");
        }

        #[tokio::test]
        async fn a_choice_that_cannot_run_is_refused_at_once_even_behind_a_running_turn() {
            let (fx, svc, recorder) = rig().await;
            AppConfig::update(&fx.core.data_dir(), |config| config.providers[1].enabled = false).unwrap();
            recorder.hold.store(true, Ordering::SeqCst);
            assert!(!say(&svc, ask("q1", "general", Some(pick("claude", "sonnet", None)))).await.unwrap().queued);

            let words = refused(&svc, &fx, Some(pick("claude_2", "sonnet", None))).await;
            assert_eq!(words, "Pip runs on Claude work, which is off. Turn it on in Settings or pick another.");
            assert_eq!(refused(&svc, &fx, Some(pick("claude", "claude-opus-9", None))).await, "Pick a model for Pip.");
            assert_eq!(recorder.count(), 1, "nothing was queued behind the running turn");
            recorder.finish_held();
            done(&fx, "general", "q1").await;
            assert_eq!(recorder.count(), 1);
        }

        #[tokio::test]
        async fn a_refused_choice_is_not_the_conversations_last_one_and_the_next_turn_runs_on_the_one_that_ran() {
            let (fx, svc, recorder) = rig().await;
            say(&svc, ask("q1", "general", Some(pick("claude", "haiku", None)))).await.unwrap();
            done(&fx, "general", "q1").await;
            AppConfig::update(&fx.core.data_dir(), |config| config.providers[1].enabled = false).unwrap();
            refused(&svc, &fx, Some(pick("claude_2", "sonnet", None))).await;
            assert_eq!(fx.core.pip_choice("general", None).await.unwrap(), Some(pick("claude", "haiku", None)));
            say(&svc, ask("q2", "general", None)).await.unwrap();
            done(&fx, "general", "q2").await;
            let models: Vec<Option<String>> = recorder.launched.lock().unwrap().iter().map(|l| l.model.clone()).collect();
            assert_eq!(models, [Some("haiku".into()), Some("haiku".into())]);
        }

        #[tokio::test]
        async fn a_turn_that_fails_before_the_provider_starts_does_not_leave_its_choice_as_the_conversations_last() {
            let (fx, svc, recorder) = rig().await;
            let conversation = "ws:gone";
            let err = say(&svc, ask("q1", conversation, Some(pick("claude_2", "opus", None)))).await.unwrap_err();
            assert!(!err.to_string().is_empty());
            assert_eq!(recorder.count(), 0);
            assert_eq!(fx.core.pip_choice(conversation, None).await.unwrap(), Some(pick("claude", "sonnet", Some("medium"))), "the Settings default");
        }

        #[tokio::test]
        async fn a_hostile_model_string_never_reaches_the_command_line_or_the_conversation() {
            let (fx, svc, recorder) = rig().await;
            for hostile in ["--dangerously-skip-permissions", "opus --tools Bash", "sonnet\n--add-dir /", "$(id)"] {
                for instance in ["claude", "claude_2"] {
                    assert_eq!(refused(&svc, &fx, Some(pick(instance, hostile, None))).await, "Pick a model for Pip.");
                }
            }
            assert_eq!(recorder.count(), 0);
            assert_eq!(fx.core.pip_choice("general", None).await.unwrap(), Some(pick("claude", "sonnet", Some("medium"))), "a refused string is not kept as the conversation's choice");
        }

        #[tokio::test]
        async fn an_unreadable_shell_setup_refuses_the_instance_without_a_folder_and_leaves_one_with_a_folder_running() {
            let (fx, svc, recorder) = rig_on(fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await).await;
            let words = refused(&svc, &fx, Some(pick("claude", "sonnet", None))).await;
            assert!(words.starts_with("Gossamr couldn't read your shell setup"), "{words}");
            assert_eq!(recorder.count(), 0);
            say(&svc, ask("q1", "general", Some(pick("claude_2", "sonnet", None)))).await.unwrap();
            done(&fx, "general", "q1").await;
            assert_eq!(recorder.count(), 1);
        }
    }
}
