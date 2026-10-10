//! Pip's assistant runs. An `AgentProvider` drives one agent (a CLI, an API) against Pip's local MCP tools and reports
//! neutral events; `AgentService` prepares each run's prompt and screen context and routes events to the page.

pub mod autostart;
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
pub(crate) mod conformance;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::auth::Scope;
use crate::config::AppConfig;
use crate::db::PipTurn;
use crate::domain::{ClonePlan, ProposalQuery, StateKind};
use crate::error::{Error, Result};
use crate::inbox::Core;
use context::ScreenContext;
use images::ImageInput;
use mcp::McpServer;
use queue::{Enqueued, QueueItem, Removed, TurnQueue};
use sandbox::Sandbox;
use supervisor::{event_line, WakeFacts, WAKE_REQUEST};

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
    /// this, never a provider.
    Queued { ahead: usize },
    /// The turn left the queue and its provider is starting. Only `AgentService` says this, never a provider.
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
    /// The working folder. A `Sandbox` can only be made by `Sandbox::prepare`, so no provider is started anywhere else.
    pub sandbox: Sandbox,
    /// Continues an earlier session where the provider can. Never needed for correctness: the prompt is complete.
    pub session: Option<String>,
    /// Screenshots sent with the prompt, inline. Only given to a provider with `vision`.
    pub images: Vec<ImageInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentCaps {
    pub mcp: bool,
    pub resume: bool,
    pub streaming: bool,
    /// The agent can read the person's local code. No provider does yet; the prompt says so when one does.
    pub reads_code: bool,
    /// The agent starts with no way to change files or reach anything but the MCP endpoint.
    pub read_only_sandbox: bool,
    /// The agent takes images inline with the prompt.
    pub vision: bool,
}

/// What Pip's run tools need from the agent-run service, and nothing that starts, stops or answers a run.
#[async_trait]
pub trait RunPlanner: Send + Sync {
    /// Whether agents are turned on; the run tools say so instead of answering when they are not.
    fn enabled(&self) -> bool;

    /// Where a run in `repo` would be set up: the clone to use, its default branch and a fresh worktree name for
    /// ticket `key` titled `title`. The error is in words Pip can pass on.
    async fn plan(&self, repo: &str, key: &str, title: &str) -> std::result::Result<ClonePlan, String>;
}

pub type EventStream = mpsc::UnboundedReceiver<AgentEvent>;

/// Every provider must pass the suite in `conformance.rs`.
#[async_trait]
pub trait AgentProvider: Send + Sync {
    fn id(&self) -> &'static str;

    fn capabilities(&self) -> AgentCaps;

    /// Starts a run. The stream ends with exactly one `Done`, including after a cancel or a crash, and once it has
    /// ended nothing of the run is still executing.
    async fn run(&self, req: AgentRequest) -> Result<EventStream>;

    /// Stops the run; its stream then ends with a failed `Done`. Unknown or finished runs are ignored.
    fn cancel(&self, run_id: &str);
}

/// The conversation a request belongs to when the page doesn't say: Pip's general conversation, outside any workstream.
pub const GENERAL_CONVERSATION: &str = "general";

/// What the general conversation was called before workstreams; its turns were moved to `general`.
const LEGACY_WORKSPACE_CONVERSATION: &str = "workspace";

/// A workstream's conversation is `ws:<id>`.
const WORKSTREAM_PREFIX: &str = "ws:";

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
    /// the classic drawer. `workspace` is read as `general`.
    #[serde(default = "general", deserialize_with = "conversation")]
    pub conversation: String,
    /// How the page showed the question, kept with it so the conversation reads the same after a restart.
    #[serde(default)]
    pub meta: Option<TurnMeta>,
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

/// Why a wake never ran: its workstream was held, advised or closed before it started. Its facts count as not woken,
/// so the supervisor wakes Pip for them once the workstream is set going again.
pub const WAKE_HELD: &str = "Held before it started";

/// How a wake that couldn't be started ends: Pip never saw its facts, so they count as not woken.
pub const WAKE_NOT_STARTED: &str = "Couldn't start";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    pub request_id: String,
    #[serde(flatten)]
    pub event: AgentEvent,
}

/// Refuses images the provider can't take, rather than answering as if they weren't there.
fn check_images(images: &[ImageInput], caps: AgentCaps) -> Result<()> {
    images::validate(images)?;
    if !images.is_empty() && !caps.vision {
        return Err(Error::Claude("The assistant you've chosen can't look at images yet. Send the question as text.".into()));
    }
    Ok(())
}

pub type UpdateSink = Arc<dyn Fn(Update) + Send + Sync>;

/// A wake turn that is running, kept so a person's message in its conversation can stop it and queue it again.
struct WakeInFlight {
    conversation: String,
    scope: Scope,
    facts: WakeFacts,
    sink: UpdateSink,
}

/// What became of a wake queued in a conversation that already had one waiting.
enum WakeEntered {
    Merged(String),
    Entered(Enqueued<QueueItem>),
}

pub struct AgentService {
    core: Arc<Core>,
    mcp: McpServer,
    providers: HashMap<&'static str, Arc<dyn AgentProvider>>,
    config: Mutex<AppConfig>,
    running: Mutex<HashMap<String, Arc<dyn AgentProvider>>>,
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
    pub fn new(core: Arc<Core>, mcp: McpServer, providers: Vec<Arc<dyn AgentProvider>>, config: AppConfig) -> Self {
        let providers = providers.into_iter().map(|p| (p.id(), p)).collect();
        Self {
            core,
            mcp,
            providers,
            config: Mutex::new(config),
            running: Mutex::new(HashMap::new()),
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
            Removed::Waiting(QueueItem::User { scope, sink, .. } | QueueItem::Wake { scope, sink, .. }) => {
                recorded(self.core.pip_turn_finish(&scope, request_id, "", false, Some(why), None, None).await);
                sink(Update { request_id: request_id.to_string(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(why.into()), usage: None } });
            }
            Removed::InFlight => {
                self.wakes.lock().expect("lock poisoned").remove(request_id);
                let provider = self.running.lock().expect("lock poisoned").get(request_id).cloned();
                if let Some(p) = provider {
                    p.cancel(request_id);
                }
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
    /// person's message also takes out a wake still waiting, stops a wake running (whose facts are queued again behind
    /// the message), and starts Pip's automatic turns counting from zero.
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
        let scope = self.core.scope().await?;
        let meta = req.meta.clone().unwrap_or_else(|| TurnMeta { image_count: req.images.len() as u32, ..Default::default() });
        // Kept as waiting until its provider has started, so a reload shows it either way.
        recorded(self.core.pip_turn_begin(&scope, &req.conversation, &req.request_id, &req.prompt, &meta, "queued").await);
        let workstream = workstream_of_conversation(&req.conversation).map(str::to_string);
        if let Some(ws) = &workstream {
            let waiting = self.queue.lock().expect("lock poisoned").waiting_wakes(&req.conversation);
            for id in waiting {
                self.cancel(&id).await;
            }
            recorded(self.core.person_wrote_in_workstream(&scope, ws).await);
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
                // It was counted when it was first let through, so it may merge into one waiting.
                if let Err(e) = self.queue_wake(wake.scope, wake.conversation, wake.facts, wake.sink, true).await {
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
    /// While another wake waits there and `may_merge` allows, the facts are merged into that one instead. The turn is
    /// kept with its event lines as its prompt and kind `wake`, and asked like any other, with the manager's role and
    /// tools. Whether the facts were merged: decided here alone, under the queue's lock, so the budget the supervisor
    /// charges is for the turns there really are.
    pub async fn wake(self: &Arc<Self>, ws_id: &str, facts: WakeFacts, sink: UpdateSink, may_merge: bool) -> Result<bool> {
        let scope = self.core.scope().await?;
        self.queue_wake(scope, format!("{WORKSTREAM_PREFIX}{ws_id}"), facts, sink, may_merge).await
    }

    async fn queue_wake(self: &Arc<Self>, scope: Scope, conversation: String, facts: WakeFacts, sink: UpdateSink, may_merge: bool) -> Result<bool> {
        let request_id = format!("wake-{}", crate::proposals::new_id()?);
        recorded(self.core.pip_wake_begin(&scope, &conversation, &request_id, &event_line(&facts), "queued").await);
        let entered = {
            let mut queue = self.queue.lock().expect("lock poisoned");
            let merged = if may_merge { queue.merge_wake(&conversation, &facts) } else { None };
            match merged {
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
                        Some(QueueItem::Wake { facts, sink, .. }) => Some((event_line(facts), sink.clone(), queue.position(&id).unwrap_or(0))),
                        _ => None,
                    }
                };
                if let Some((lines, sink, ahead)) = waiting {
                    recorded(self.core.pip_wake_lines(&scope, &id, &lines).await);
                    // The page reads the merged lines from the stored turn when it hears of the wake again.
                    sink(Update { request_id: id, event: AgentEvent::Queued { ahead } });
                }
                Ok(true)
            }
            WakeEntered::Entered(Enqueued::Start(QueueItem::Wake { scope, facts, sink })) => {
                self.start_wake(request_id, scope, facts, sink).await?;
                Ok(false)
            }
            WakeEntered::Entered(Enqueued::Start(QueueItem::User { .. })) => unreachable!("a wake was queued"),
            WakeEntered::Entered(Enqueued::Waiting { ahead }) => {
                sink(Update { request_id, event: AgentEvent::Queued { ahead } });
                Ok(false)
            }
        }
    }

    /// Starts wake turn `request_id`. When it cannot start it ends failed through its own sink, and the queue moves on.
    /// A wake whose workstream was held, advised or closed after it was queued never starts: it ends with `WAKE_HELD`,
    /// however it got here (queued behind a turn, queued again behind the person's message, or just admitted). Only the
    /// budget's own hold lets it run, since the wake that uses up the budget is the one it holds the workstream after.
    async fn start_wake(self: &Arc<Self>, request_id: String, scope: Scope, facts: WakeFacts, sink: UpdateSink) -> Result<()> {
        let conversation = format!("{WORKSTREAM_PREFIX}{}", facts.workstream);
        if !self.wakes_allowed(&scope, &facts.workstream).await {
            recorded(self.core.pip_turn_finish(&scope, &request_id, "", false, Some(WAKE_HELD), None, None).await);
            sink(Update { request_id: request_id.clone(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(WAKE_HELD.into()), usage: None } });
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
            event: Some(event_line(&facts)),
        };
        self.wakes.lock().expect("lock poisoned").insert(request_id.clone(), WakeInFlight { conversation, scope: scope.clone(), facts, sink: sink.clone() });
        if let Err(e) = self.start(scope.clone(), req, sink.clone()).await {
            self.wakes.lock().expect("lock poisoned").remove(&request_id);
            let message = format!("{WAKE_NOT_STARTED}: {e}");
            recorded(self.core.pip_turn_finish(&scope, &request_id, "", false, Some(&message), None, None).await);
            sink(Update { request_id: request_id.clone(), event: AgentEvent::Done { session_id: None, ok: false, message: Some(message), usage: None } });
            self.release(&request_id, None);
            return Err(e);
        }
        Ok(())
    }

    /// Whether workstream `ws_id` may have Pip woken in it now: open, in Manage mode, and held for nothing but its budget.
    async fn wakes_allowed(&self, scope: &Scope, ws_id: &str) -> bool {
        let Ok(Some(view)) = self.core.workstream(scope, ws_id).await else { return false };
        let ws = view.workstream;
        ws.closed_at.is_none() && ws.mode == crate::domain::workstream::Mode::Manage && ws.held_reason.as_deref().is_none_or(|r| r == crate::domain::workstream::HELD_BUDGET)
    }

    /// Whether a wake waits in `conversation`, so a new one would merge into it rather than be a turn of its own.
    pub fn has_waiting_wake(&self, conversation: &str) -> bool {
        !self.queue.lock().expect("lock poisoned").waiting_wakes(conversation).is_empty()
    }

    /// Stops every turn of workstream `ws_id`'s conversation, those waiting first so none starts in between, as
    /// closing or holding it does. A wake that never started ends with `WAKE_HELD`.
    pub async fn cancel_workstream_turns(&self, ws_id: &str) {
        let conversation = format!("{WORKSTREAM_PREFIX}{ws_id}");
        let turns = self.queue.lock().expect("lock poisoned").turns_of(&conversation);
        for id in turns.iter().rev() {
            let why = if self.is_wake(id) { WAKE_HELD } else { REMOVED };
            self.cancel_with(id, why).await;
        }
    }

    /// Stops the wakes of workstream `ws_id`, waiting or running, and leaves the person's turns be: what a tripwire or a
    /// hold of the supervisor's own does.
    pub async fn cancel_workstream_wakes(&self, ws_id: &str) {
        let conversation = format!("{WORKSTREAM_PREFIX}{ws_id}");
        let turns = self.queue.lock().expect("lock poisoned").turns_of(&conversation);
        for id in turns.iter().rev().filter(|id| self.is_wake(id)) {
            self.cancel_with(id, WAKE_HELD).await;
        }
    }

    /// Whether `request_id` is a wake, waiting or running.
    fn is_wake(&self, request_id: &str) -> bool {
        self.wakes.lock().expect("lock poisoned").contains_key(request_id) || matches!(self.queue.lock().expect("lock poisoned").waiting(request_id), Some(QueueItem::Wake { .. }))
    }

    /// Stops every turn in every workstream's conversation, waiting or running: the person's Hold all.
    pub async fn cancel_all_workstream_turns(&self) {
        let conversations = self.queue.lock().expect("lock poisoned").conversations();
        for c in conversations {
            if let Some(ws) = workstream_of_conversation(&c) {
                self.cancel_workstream_turns(ws).await;
            }
        }
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
        let id = self.config.lock().expect("lock poisoned").agent_provider.clone();
        let provider = self
            .providers
            .get(id.as_str())
            .cloned()
            .ok_or_else(|| Error::Claude(format!("The assistant provider “{id}” isn't available.")))?;
        check_images(&req.images, provider.capabilities())?;
        // A turn in a workstream's conversation works in that workstream, which must be an open one of this account.
        let mut workstream = match workstream_of_conversation(&req.conversation) {
            Some(id) => Some(workstream::for_turn(&self.core, &scope, id).await?),
            None => None,
        };
        if let Some(ws) = workstream.as_mut() {
            ws.event = req.event.clone();
        }

        let mut context = req.context.in_connection(&crate::tracker::Connection::jira_id(&scope));
        let mut handed: std::collections::HashSet<String> = context::keys_in(&req.prompt).into_iter().collect();
        if let Some(key) = workstream.as_ref().and_then(|w| w.workstream.item_key.as_ref()) {
            handed.insert(key.to_uppercase());
        }
        if let Some(r) = &context.item {
            handed.insert(r.key.to_uppercase());
            context.unwatched_item = !self.core.is_item_watched(&scope, &r.key).await?;
        }
        let mut read = std::collections::HashMap::new();
        let item = match &context.item {
            Some(r) => {
                let (ticket, seen) = self.core.ticket_for_pip(&scope, &r.key).await?;
                let text = mcp::describe_with(&ticket, &seen.description);
                read.insert(r.key.to_uppercase(), seen);
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
        let runs = match self.mcp.planner.enabled() {
            true => runs::context_runs(&self.core, &scope, &handed).await,
            false => Vec::new(),
        };
        let sandbox = Sandbox::prepare(&self.core.data_dir())?;
        // A workstream's conversation continues its own session when the page has none to give.
        let asked = req.session_id.or_else(|| workstream.as_ref().and_then(|w| w.workstream.pip_session.clone()));
        let session = match asked.filter(|_| provider.capabilities().resume) {
            Some(id) if self.core.is_pip_session(&id).await? => Some(id),
            _ => None,
        };

        let run_id = req.request_id.clone();
        // In a workstream's conversation Pip manages it: it drafts each next step, and the person still starts each one.
        let role = if workstream.is_some() { context::Role::Manager } else { context::Role::Assistant };
        let agent_req = AgentRequest {
            run_id: run_id.clone(),
            system: context::system_prompt(role, provider.capabilities().reads_code, self.core.can_edit_text(&scope)?),
            prompt: context::compose(&context, item.as_deref(), &links, &drafts, &runs, workstream.as_ref(), &req.prompt),
            mcp: self.mcp.endpoint(&run_id)?,
            sandbox,
            session,
            images: req.images,
        };

        // Registered before the run starts, since the agent may call the tools straight away.
        let workstream_id = workstream.map(|w| w.workstream.id);
        let pip = mcp::PipRun { scope: scope.clone(), handed, read, read_runs: Default::default(), workstream: workstream_id.clone() };
        self.mcp.runs.lock().expect("lock poisoned").insert(run_id.clone(), pip);
        self.running.lock().expect("lock poisoned").insert(run_id.clone(), provider.clone());
        self.live.lock().expect("lock poisoned").insert(run_id.clone(), LiveTurn::default());
        recorded(self.core.pip_turn_status(&scope, &run_id, "running").await);
        sink(Update { request_id: run_id.clone(), event: AgentEvent::Running });
        let mut events = match provider.run(agent_req).await {
            Ok(e) => e,
            Err(e) => {
                self.finish(&run_id);
                return Err(e);
            }
        };
        if self.stop_early.lock().expect("lock poisoned").remove(&run_id) {
            provider.cancel(&run_id);
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
                let _ = this.core.remember_claude_session(key.as_deref(), id).await;
                if let Some(ws) = &workstream_id {
                    recorded(this.core.set_workstream_session(&scope, ws, id).await);
                }
            }
            this.finish(&run_id);
            this.release(&run_id, session);
        });
        Ok(())
    }

    fn live_turn(&self, run_id: &str, f: impl FnOnce(&mut LiveTurn)) {
        if let Some(l) = self.live.lock().expect("lock poisoned").get_mut(run_id) {
            f(l);
        }
    }

    fn finish(&self, run_id: &str) {
        self.wakes.lock().expect("lock poisoned").remove(run_id);
        self.live.lock().expect("lock poisoned").remove(run_id);
        self.running.lock().expect("lock poisoned").remove(run_id);
        self.mcp.runs.lock().expect("lock poisoned").remove(run_id);
        self.mcp.revoke(run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(vision: bool) -> AgentCaps {
        AgentCaps { mcp: true, resume: false, streaming: true, reads_code: false, read_only_sandbox: true, vision }
    }

    #[test]
    fn a_provider_without_vision_refuses_images_instead_of_dropping_them() {
        let images = [images::tests::png()];
        assert!(check_images(&images, caps(true)).is_ok());
        let err = check_images(&images, caps(false)).unwrap_err().to_string();
        assert!(err.contains("can't look at images"));
        assert!(check_images(&[], caps(false)).is_ok());
    }

    #[test]
    fn invalid_images_are_refused_even_for_a_provider_with_vision() {
        let mut bad = images::tests::png();
        bad.media_type = "image/gif".into();
        assert!(check_images(&[bad], caps(true)).is_err());
    }

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
        assert_eq!(kept.meta, Some(TurnMeta { quote: Some("q".into()), looking: Some("CA-1".into()), image_count: 2 }));
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
        assert_eq!(workstream_of_conversation("ws:w1"), Some("w1"));
        for none in ["ws:", "general", "workspace", "CA-1", "w1"] {
            assert_eq!(workstream_of_conversation(none), None, "{none}");
        }
    }

    mod recording {
        use super::*;
        use crate::agent::runs::testing::FakePlanner;
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
        impl AgentProvider for Fake {
            fn id(&self) -> &'static str {
                "fake"
            }

            fn capabilities(&self) -> AgentCaps {
                AgentCaps { mcp: true, resume: false, streaming: true, reads_code: false, read_only_sandbox: true, vision: false }
            }

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
            let config = AppConfig { agent_provider: "fake".into(), ..AppConfig::default() };
            Arc::new(AgentService::new(fx.core.clone(), server, vec![Arc::new(fake)], config))
        }

        fn ask(id: &str) -> AskRequest {
            AskRequest {
                request_id: id.into(),
                prompt: "What changed?".into(),
                session_id: None,
                context: ScreenContext::default(),
                images: Vec::new(),
                conversation: GENERAL_CONVERSATION.into(),
                meta: Some(TurnMeta { quote: None, looking: Some("the board".into()), image_count: 0 }),
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
        async fn a_sign_out_mid_turn_writes_nothing_afterwards() {
            let fx = fixture().await;
            let gate = Arc::new(Notify::new());
            let svc = service(&fx, Fake { events: vec![text("secret")], gate: Some(gate.clone()), refuse: false }).await;
            svc.ask(ask("q1"), Arc::new(|_| {})).await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            fx.core.sign_out().await.unwrap();
            gate.notify_one();
            for _ in 0..100 {
                if svc.live.lock().unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let rows = crate::db::Db::open(&fx.dir.join("inbox-site-me.sqlite")).unwrap();
            assert!(rows.pip_turns(GENERAL_CONVERSATION).unwrap().is_empty());
        }

    mod queueing {
        use super::*;
        use crate::agent::runs::testing::FakePlanner;
        use crate::inbox::testing::{fixture, Fixture};
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
        impl AgentProvider for Fake {
            fn id(&self) -> &'static str {
                "fake"
            }

            fn capabilities(&self) -> AgentCaps {
                AgentCaps { mcp: true, resume: true, streaming: true, reads_code: false, read_only_sandbox: true, vision: false }
            }

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
            let config = AppConfig { agent_provider: "fake".into(), ..AppConfig::default() };
            let svc = Arc::new(AgentService::new(fx.core.clone(), server, vec![Arc::new(fake)], config));
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
            bad.images = vec![images::tests::png()];
            svc.ask(bad, sink.clone()).await.unwrap();
            svc.ask(ask("q3", "A"), sink.clone()).await.unwrap();

            fake.open("q1").await;
            fake.until_started(2).await;
            assert_eq!(fake.started(), ["q1", "q3"]);
            let q2 = events_of(&seen, "q2");
            assert!(matches!(q2.last(), Some(AgentEvent::Done { ok: false, message: Some(m), .. }) if m.contains("can't look at images")), "{q2:?}");
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
            assert!(svc.mcp.runs.lock().unwrap().get("q1").is_some_and(|p| p.handed.contains("CA-1")), "its ticket is handed to Pip");
            let prompt = fake.0.prompts.lock().unwrap().get("q1").cloned().unwrap();
            assert!(prompt.contains(&format!("Id: {} · ticket CA-1 · mode advise · stage Intake", ws.id)) && prompt.contains("[Open drafts in this workstream]"), "{prompt}");
            let system = fake.0.systems.lock().unwrap().get("q1").cloned().unwrap();
            assert!(system.contains(context::MANAGER), "a workstream's turn is the manager's: {system}");
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
            assert!(!general.contains(context::MANAGER) && general.contains("gossamr tools"), "the general conversation's turn is the assistant's: {general}");
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
            assert!(err.contains("no workstream theirs"), "{err}");
            assert_eq!(status(&fx, &format!("ws:{}", closed.id), "q1").await, "failed");
            assert_eq!(status(&fx, "ws:theirs", "q2").await, "failed");
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(fake.started().is_empty(), "nothing ran");
            assert!(svc.mcp.runs.lock().unwrap().is_empty());

            svc.ask(ask("q3", "workspace"), sink).await.unwrap();
            fake.until_started(1).await;
            fake.open("q3").await;
            until_status(&fx, GENERAL_CONVERSATION, "q3", "done").await;
            assert_eq!(fx.core.pip_turns("workspace").await.unwrap()[0].conversation, GENERAL_CONVERSATION, "a legacy name is kept as general");
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
}
