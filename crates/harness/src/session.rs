//! Sessions: each runs on its own task between the client's requests and its driver, and every event it has goes
//! through redaction into the store and out to the clients that listen.
//!
//! Turns come from the driver: a turn runs from its `turn_started` to its `turn_ended` or `failed`, and a driver that
//! breaks that pairing fails the turn loudly. The harness holds a limit on how many sessions are in a turn at once. A
//! prompt waits while its session is in a turn, and past the limit it waits for a slot and says so. A turn the agent
//! starts by itself takes a slot too, even past the limit, since it has begun before the harness sees it; the next
//! prompted turn then waits.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::{Notify, broadcast, oneshot};

use crate::driver::{Capabilities, Command, Driver, Launch, Link, OpenError, Secret, random_hex};
use crate::error::{Error, Result};
use crate::event::{Body, Decision, Event, FailKind};
use crate::redact;
use crate::store::{Listed, Store, now_ms};
use crate::tools::{Endpoint, Reply, ToolCall};

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub turn_limit: usize,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { turn_limit: 4 }
    }
}

/// The reason of the `failed` a session records when it cannot be resumed. `resume` refuses a session whose last
/// stored event is this, so a provider id the store failed to clear is never used.
pub const CANNOT_RESUME: &str = "the provider's session id looks like a secret, so it is not kept, the session cannot be resumed and it stops";

/// How long a stopped agent may take to go when its driver does not say: above the 15 s `agy acp` was seen to take
/// while a command ran.
pub const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct Harness {
    inner: Arc<Inner>,
}

// Lock order: `live`, then `store`, then a session's `open`, `questions` or `watchers`.
struct Inner {
    /// None once the harness has shut down, which frees the data folder.
    store: Mutex<Option<Store>>,
    drivers: HashMap<String, Arc<dyn Driver>>,
    turns: Arc<Turns>,
    live: Mutex<HashMap<String, Live>>,
    starts: AtomicU64,
    /// Set under `live` by `shutdown`: no session starts after it.
    closing: AtomicBool,
    /// Told each time a session leaves `live`.
    left: Notify,
}

#[derive(Clone)]
struct Live {
    requests: UnboundedSender<Request>,
    events: broadcast::Sender<Event>,
    /// Which start of the session this is, so a task that ends removes only its own entry.
    start: u64,
    /// Open permission requests, by the harness's id.
    open: Arc<Mutex<HashMap<String, OpenRequest>>>,
    /// Stop was taken: the session takes no more requests while its agent goes.
    stopping: Arc<AtomicBool>,
    /// Questions the agent asked that no one has answered.
    questions: Arc<Mutex<HashSet<String>>>,
    /// Clients that get every event while they listen, however far behind they fall: a locked session's events are
    /// not in the store, so a client that lost one could not read it back.
    watchers: Arc<Mutex<Vec<UnboundedSender<Event>>>>,
}

struct OpenRequest {
    driver_id: String,
    /// An answer is on its way to the task, which checks the request is still open before it records or sends it.
    answered: bool,
}

enum Request {
    Prompt(String),
    Answer { id: String, decision: Decision, message: Option<String> },
    ToolResult { id: String, reply: Reply },
    Cancel,
    Stop,
    HandOver,
}

#[derive(Debug, Clone, Default)]
pub struct Open {
    pub provider: String,
    /// Pip's profile. Its events reach the live client only; the store keeps their fields that are not private.
    pub locked: bool,
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// The session ends when the client that opened it leaves, and is never resumed. The API closes it.
    pub ends_with_client: bool,
}

impl Harness {
    pub fn new(store: Store, drivers: Vec<(String, Arc<dyn Driver>)>, settings: Settings) -> Harness {
        Harness {
            inner: Arc::new(Inner {
                store: Mutex::new(Some(store)),
                drivers: drivers.into_iter().collect(),
                turns: Arc::new(Turns { limit: settings.turn_limit, state: Mutex::new(TurnsState::default()) }),
                live: Mutex::new(HashMap::new()),
                starts: AtomicU64::new(0),
                closing: AtomicBool::new(false),
                left: Notify::new(),
            }),
        }
    }

    /// Starts a session. The receiver gets every event from the first.
    pub async fn open(&self, spec: Open) -> Result<(String, broadcast::Receiver<Event>)> {
        self.open_watched(spec, None)
    }

    /// Starts a session; `watcher`, if any, gets every event from the first and never falls behind.
    pub fn open_watched(&self, spec: Open, watcher: Option<UnboundedSender<Event>>) -> Result<(String, broadcast::Receiver<Event>)> {
        let driver = self.driver(&spec.provider)?;
        let id = random_hex(8);
        self.inner.with_store(|store| {
            store.create_session(&id, &spec.provider, spec.locked, &spec.cwd, spec.model.as_deref())?;
            if spec.ends_with_client {
                store.set_ends_with_client(&id)?;
            }
            Ok(())
        })?;
        let plan = Plan { driver, cwd: spec.cwd, locked: spec.locked, model: spec.model, resume: None };
        let events = self.start(&id, watcher, |_| Ok(plan))?;
        Ok((id, events))
    }

    /// Starts a session again by its provider's session id, with a new tools token. A running or cleaned-up session
    /// is refused, and so is one that ends with its client or whose last stored event says it cannot be resumed.
    pub async fn resume(&self, id: &str) -> Result<broadcast::Receiver<Event>> {
        self.start(id, None, |store| {
            let row = store.session(id)?;
            if row.cleaned {
                return Err(Error::CleanedUp(id.to_owned()));
            }
            if row.ends_with_client {
                return Err(Error::EndedWithClient(id.to_owned()));
            }
            if store.last_event(id)?.is_some_and(|last| matches!(last.body, Body::Failed { reason, .. } if reason == CANNOT_RESUME)) {
                return Err(Error::CannotResume(id.to_owned()));
            }
            let provider_session =
                row.provider_session.ok_or_else(|| Error::Driver(format!("session {id} has no provider session id to resume")))?;
            Ok(Plan { driver: self.driver(&row.provider)?, cwd: row.cwd, locked: row.locked, model: row.model, resume: Some(provider_session) })
        })
    }

    /// Sends a prompt. One sent while a turn runs waits for that turn to end.
    pub fn send(&self, id: &str, text: impl Into<String>) -> Result<()> {
        self.request(id, Request::Prompt(text.into()))
    }

    /// Answers an open permission request, once. A deny can say why. An id that is not open is refused. An answer that
    /// loses the race with its turn's end (accepted here, but the turn ended before the session dispatched it) is
    /// dropped: it is neither recorded nor sent, and the client hears nothing more of it than the turn's end.
    pub fn answer(&self, id: &str, request: &str, decision: Decision, message: Option<String>) -> Result<()> {
        let live = self.taking(id)?;
        {
            let mut open = live.open.lock().unwrap_or_else(|p| p.into_inner());
            match open.get_mut(request) {
                Some(entry) if !entry.answered => entry.answered = true,
                _ => return Err(Error::NotOpen(request.to_owned())),
            }
        }
        let answer = Request::Answer { id: request.to_owned(), decision, message };
        live.requests.send(answer).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Answers an open question, once. Until `ask` holds the agent's call (H5b), the answer goes to the agent as the
    /// next prompt.
    pub fn answer_question(&self, id: &str, question: &str, text: String) -> Result<()> {
        let live = self.taking(id)?;
        if !live.questions.lock().unwrap_or_else(|p| p.into_inner()).remove(question) {
            return Err(Error::NoQuestion(question.to_owned()));
        }
        live.requests.send(Request::Prompt(text)).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Posts the result of a client tool call. A call that was already cut is passed over.
    pub fn tool_result(&self, id: &str, call: &str, output: Value, error: bool) -> Result<()> {
        self.request(id, Request::ToolResult { id: call.to_owned(), reply: Reply { output, error } })
    }

    /// Cancels the running turn, or a prompt that waits for a slot.
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.request(id, Request::Cancel)
    }

    /// Stops the session. It is closed once its agent has gone, which its `closed` event says; until then it takes no
    /// more requests.
    pub fn close(&self, id: &str) -> Result<()> {
        self.stop(id, Request::Stop)
    }

    /// Closes the session as handed over to Terminal, which its `handed_over` event says. Its provider id is kept,
    /// so it can be resumed there or later.
    pub fn hand_over(&self, id: &str) -> Result<()> {
        self.stop(id, Request::HandOver)
    }

    fn stop(&self, id: &str, request: Request) -> Result<()> {
        let live = self.live(id)?;
        live.stopping.store(true, Ordering::Relaxed);
        live.requests.send(request).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Stops every session, waits until each has recorded its `closed`, and frees the data folder. Nothing starts
    /// after it. An agent that never goes keeps it waiting, as it keeps its session taken.
    pub async fn shutdown(&self) {
        let running: Vec<Live> = {
            let live = self.inner.live();
            self.inner.closing.store(true, Ordering::Relaxed);
            live.values().cloned().collect()
        };
        for live in running {
            live.stopping.store(true, Ordering::Relaxed);
            let _ = live.requests.send(Request::Stop);
        }
        loop {
            let left = self.inner.left.notified();
            tokio::pin!(left);
            left.as_mut().enable();
            if self.inner.live().is_empty() {
                break;
            }
            left.await;
        }
        *self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Drops payload past 30 days and deletes old sessions' event rows; see `Store::sweep`.
    pub fn sweep(&self) -> Result<usize> {
        self.inner.with_store(|store| store.sweep(now_ms()))
    }

    /// Sweeps every `every`, first one `every` from now, until the harness shuts down. `swept` counts the sweeps.
    pub fn sweep_on_timer(&self, every: Duration) -> (tokio::task::JoinHandle<()>, tokio::sync::watch::Receiver<u64>) {
        let (count, swept) = tokio::sync::watch::channel(0);
        let harness = self.clone();
        let task = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                timer.tick().await;
                if let Err(e) = harness.sweep() {
                    eprintln!("harness: the sweep failed: {e}");
                    if matches!(e, Error::ShutDown) {
                        return;
                    }
                }
                count.send_modify(|n| *n += 1);
            }
        });
        (task, swept)
    }

    pub fn sessions(&self) -> Result<Vec<Listed>> {
        let live = self.inner.live();
        let mut listed = self.inner.with_store(Store::sessions)?;
        for session in &mut listed {
            session.running = live.contains_key(&session.id);
        }
        Ok(listed)
    }

    /// The stored keys of the client tokens.
    pub fn client_tokens(&self) -> Result<Vec<crate::store::ClientToken>> {
        self.inner.with_store(Store::client_tokens)
    }

    pub fn revoke_client_token(&self, id: i64) -> Result<()> {
        self.inner.with_store(|store| store.revoke_client_token(id))
    }

    pub fn add_client_token(&self, stored_key: &[u8; 32]) -> Result<()> {
        self.inner.with_store(|store| store.add_client_token(stored_key))
    }

    /// The providers, by name, with what each can do.
    pub fn providers(&self) -> Vec<(String, Capabilities)> {
        let mut providers: Vec<_> = self.inner.drivers.iter().map(|(name, driver)| (name.clone(), driver.capabilities())).collect();
        providers.sort_by(|a, b| a.0.cmp(&b.0));
        providers
    }

    /// Drops a closed session's payload from the store. A session that still runs is refused: close it first.
    pub fn clean_up(&self, id: &str) -> Result<()> {
        // Under the lock a start takes the session by, so a resume cannot start from a row being cleaned up.
        let live = self.inner.live();
        if live.contains_key(id) {
            return Err(Error::Running(id.to_owned()));
        }
        self.inner.with_store(|store| store.clean_up(id))
    }

    /// The stored events after `after`. A read writes nothing: the sweep runs on its timer.
    pub fn events(&self, id: &str, after: u64) -> Result<Vec<Event>> {
        self.inner.with_store(|store| {
            store.session(id)?;
            store.events(id, after)
        })
    }

    /// The stored events after `after`, and, while the session runs, a receiver of every event from the moment of the
    /// read, which never falls behind. Both under the store's lock, which a session holds while it stores and sends an
    /// event, so an event is in one or the other and never both. A locked session's events come from the store
    /// withheld, and whole only to a receiver.
    pub fn watch(&self, id: &str, after: u64) -> Result<(Vec<Event>, Option<UnboundedReceiver<Event>>)> {
        let live = self.inner.live();
        self.inner.with_store(|store| {
            store.session(id)?;
            let receiver = live.get(id).map(|live| {
                let (watcher, receiver) = mpsc::unbounded_channel();
                live.watchers.lock().unwrap_or_else(|p| p.into_inner()).push(watcher);
                receiver
            });
            Ok((store.events(id, after)?, receiver))
        })
    }

    pub fn subscribe(&self, id: &str) -> Result<broadcast::Receiver<Event>> {
        Ok(self.live(id)?.events.subscribe())
    }

    fn driver(&self, provider: &str) -> Result<Arc<dyn Driver>> {
        self.inner.drivers.get(provider).cloned().ok_or_else(|| Error::NoSuchProvider(provider.to_owned()))
    }

    fn live(&self, id: &str) -> Result<Live> {
        self.inner.live().get(id).cloned().ok_or_else(|| Error::NotRunning(id.to_owned()))
    }

    /// The session's live entry, if it still takes requests.
    fn taking(&self, id: &str) -> Result<Live> {
        let live = self.live(id)?;
        if live.stopping.load(Ordering::Relaxed) {
            return Err(Error::NotRunning(id.to_owned()));
        }
        Ok(live)
    }

    fn request(&self, id: &str, request: Request) -> Result<()> {
        self.taking(id)?.requests.send(request).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Takes the session's id before the driver opens, so one session never runs two agents; a failed open frees it.
    /// `plan` reads the session's row under the same lock that clean-up and a task's close take, so a start never
    /// begins from a row being cleaned up, or before the last start's `closed`.
    fn start(&self, id: &str, watcher: Option<UnboundedSender<Event>>, plan: impl FnOnce(&Store) -> Result<Plan>) -> Result<broadcast::Receiver<Event>> {
        let token = Secret::random();
        let secrets = vec![token.expose().to_owned()];
        let (events, receiver) = broadcast::channel(1024);
        let (requests, requests_rx) = mpsc::unbounded_channel();
        let (calls, calls_rx) = mpsc::unbounded_channel();
        let start = self.inner.starts.fetch_add(1, Ordering::Relaxed);
        let open = Arc::new(Mutex::new(HashMap::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        let questions = Arc::new(Mutex::new(HashSet::new()));
        let watchers = Arc::new(Mutex::new(watcher.into_iter().collect()));
        #[cfg(test)]
        tests::before_reserve();
        let Plan { driver, cwd, locked, model, resume } = {
            let mut live = self.inner.live();
            if self.inner.closing.load(Ordering::Relaxed) {
                return Err(Error::ShutDown);
            }
            if live.contains_key(id) {
                return Err(Error::Running(id.to_owned()));
            }
            let plan = self.inner.with_store(plan)?;
            let entry = Live {
                requests,
                events: events.clone(),
                start,
                open: open.clone(),
                stopping: stopping.clone(),
                questions: questions.clone(),
                watchers: watchers.clone(),
            };
            live.insert(id.to_owned(), entry);
            plan
        };
        // Freed again if the driver fails to open, or panics.
        let reserved = Reserved { inner: &self.inner, id, start, kept: false };
        let tools = Arc::new(Endpoint::new(token.expose(), calls));
        let launch = Launch { cwd, locked, model, resume, tools_token: token, tools, env: agent_env(std::env::vars_os()) };
        let caps = driver.capabilities();
        let link = driver.open(launch).map_err(|OpenError { kind, message }| {
            Error::Open { kind, message: redact::text(&message, &secrets) }
        })?;
        reserved.keep();
        let task = Task {
            inner: self.inner.clone(),
            id: id.to_owned(),
            secrets,
            events,
            start,
            open,
            stopping,
            questions,
            watchers,
            broken: AtomicBool::new(false),
        };
        tokio::spawn(task.run(link, caps, requests_rx, calls_rx));
        Ok(receiver)
    }
}

/// The environment an agent gets: the harness's own, without a client token.
pub fn agent_env(vars: impl Iterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    vars.filter(|(name, _)| name != crate::cli::TOKEN_VARIABLE).collect()
}

/// What a start opens.
struct Plan {
    driver: Arc<dyn Driver>,
    cwd: PathBuf,
    locked: bool,
    model: Option<String>,
    resume: Option<String>,
}

/// A session's live entry from the moment it is taken until the driver has opened.
struct Reserved<'a> {
    inner: &'a Inner,
    id: &'a str,
    start: u64,
    kept: bool,
}

impl Reserved<'_> {
    fn keep(mut self) {
        self.kept = true;
    }
}

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        if !self.kept {
            self.inner.forget(self.id, self.start);
        }
    }
}

impl Inner {
    fn with_store<T>(&self, f: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        let store = self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(store.as_ref().ok_or(Error::ShutDown)?)
    }

    fn live(&self) -> MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Removes the session's live entry if it is still this start's.
    fn forget(&self, id: &str, start: u64) {
        let mut live = self.live();
        if live.get(id).is_some_and(|entry| entry.start == start) {
            live.remove(id);
            self.left.notify_waiters();
        }
    }
}

/// The count of sessions in a turn, and the prompts that wait for one to end, first come first served.
struct Turns {
    limit: usize,
    state: Mutex<TurnsState>,
}

#[derive(Default)]
struct TurnsState {
    running: usize,
    waiting: VecDeque<oneshot::Sender<()>>,
}

impl Turns {
    fn state(&self) -> MutexGuard<'_, TurnsState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Takes a slot if one is free and no one waits, or else joins the queue, in one step: a slot given back between
    /// the two would otherwise go to no one.
    fn take_or_wait(&self) -> Option<oneshot::Receiver<()>> {
        let mut state = self.state();
        if state.running < self.limit && state.waiting.is_empty() {
            state.running += 1;
            return None;
        }
        let (grant, granted) = oneshot::channel();
        state.waiting.push_back(grant);
        Some(granted)
    }

    /// Counts a turn that has already begun, past the limit if need be.
    fn force(&self) {
        self.state().running += 1;
    }

    fn give(&self) {
        let mut state = self.state();
        state.running -= 1;
        while state.running < self.limit {
            let Some(next) = state.waiting.pop_front() else { break };
            if next.send(()).is_ok() {
                state.running += 1;
            }
        }
    }

    /// Stops waiting, and gives back a slot that was granted meanwhile.
    fn give_up(&self, mut granted: oneshot::Receiver<()>) {
        granted.close();
        if granted.try_recv().is_ok() {
            self.give();
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Turn {
    Idle,
    /// A prompt was sent and the driver has not started its turn yet.
    Prompted,
    Running,
}

/// The turn of an agent that is going after a stop.
struct Going {
    turn: Turn,
    /// A stop diagnostic ended the turn, so the agent's own end of it is passed over.
    ended_by_harness: bool,
}

/// A slot of the turn limit, given back when dropped.
struct Slot(Arc<Turns>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.give();
    }
}

struct Task {
    inner: Arc<Inner>,
    id: String,
    secrets: Vec<String>,
    events: broadcast::Sender<Event>,
    start: u64,
    open: Arc<Mutex<HashMap<String, OpenRequest>>>,
    stopping: Arc<AtomicBool>,
    questions: Arc<Mutex<HashSet<String>>>,
    watchers: Arc<Mutex<Vec<UnboundedSender<Event>>>>,
    /// The store failed to take an event. The session stops: nothing more is sent that could not be recorded.
    broken: AtomicBool,
}

impl Task {
    async fn run(
        self,
        mut link: Link,
        caps: Capabilities,
        mut requests: UnboundedReceiver<Request>,
        mut calls: UnboundedReceiver<ToolCall>,
    ) {
        let turns = self.inner.turns.clone();
        let mut queued: VecDeque<String> = VecDeque::new();
        let mut turn = Turn::Idle;
        let mut slot: Option<Slot> = None;
        let mut waiting: Option<oneshot::Receiver<()>> = None;
        let mut held_calls: HashMap<String, oneshot::Sender<std::result::Result<Reply, String>>> = HashMap::new();
        let (cut, mut cuts) = mpsc::unbounded_channel::<String>();
        let mut calls_open = true;
        let stopped = 'run: loop {
            if self.broken.load(Ordering::Relaxed) {
                break true;
            }
            // Once Stop is taken, no prompt reaches the agent.
            let stopping = self.stopping.load(Ordering::Relaxed);
            if turn == Turn::Idle && waiting.is_none() && !queued.is_empty() && !stopping {
                match turns.take_or_wait() {
                    None => {
                        slot = Some(Slot(turns.clone()));
                        match self.prompt(&link, &mut queued) {
                            Some(next) => turn = next,
                            None => break true,
                        }
                    }
                    Some(granted) => {
                        self.emit(Body::Waiting);
                        waiting = Some(granted);
                    }
                }
            }
            if self.broken.load(Ordering::Relaxed) {
                break true;
            }
            // The agent's events go first, so what it said is in the record before what the client asked next.
            tokio::select! {
                biased;
                output = link.output.recv() => match output {
                    Some(Body::TurnStarted) => {
                        if turn == Turn::Running {
                            self.fail(FailKind::Driver, "the driver started a turn while one was running");
                            self.open_requests().clear();
                            slot = None;
                        }
                        if slot.is_none() {
                            if let Some(granted) = waiting.take() {
                                turns.give_up(granted);
                            }
                            turns.force();
                            slot = Some(Slot(turns.clone()));
                        }
                        turn = Turn::Running;
                        self.emit(Body::TurnStarted);
                    }
                    Some(Body::TurnEnded { .. }) if turn != Turn::Running => {
                        turn = Turn::Idle;
                        slot = None;
                        self.open_requests().clear();
                        self.fail(FailKind::Driver, "the driver ended a turn it never started");
                    }
                    Some(Body::Permission { id: driver_id, kind, tool, input }) => {
                        let id = format!("p{}", random_hex(8));
                        self.open_requests().insert(id.clone(), OpenRequest { driver_id, answered: false });
                        self.emit(Body::Permission { id, kind, tool, input });
                    }
                    Some(Body::Question { id, text }) => {
                        self.questions.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone());
                        self.emit(Body::Question { id, text });
                    }
                    Some(body @ Body::Started { .. }) => {
                        if !self.started(body) {
                            break 'run true;
                        }
                    }
                    Some(body) => {
                        if body.ends_turn() {
                            turn = Turn::Idle;
                            slot = None;
                            self.open_requests().clear();
                        }
                        self.emit(body);
                    }
                    None => {
                        if turn != Turn::Idle {
                            self.fail(FailKind::AgentStopped, "the agent stopped in the middle of a turn");
                        }
                        break 'run false;
                    }
                },
                granted = async { waiting.as_mut().expect("the branch runs only while waiting").await },
                    if waiting.is_some() && turn == Turn::Idle => {
                    waiting = None;
                    if granted.is_ok() {
                        // Once stopping, the slot goes back at once: an agent that is slow to go, or never goes,
                        // must not hold it.
                        let granted = Slot(turns.clone());
                        if !self.stopping.load(Ordering::Relaxed) {
                            slot = Some(granted);
                            match self.prompt(&link, &mut queued) {
                                Some(next) => turn = next,
                                None => break 'run true,
                            }
                        }
                    }
                }
                call = calls.recv(), if calls_open => match call {
                    Some(ToolCall { name, input, reply }) => {
                        let id = format!("c{}", random_hex(8));
                        self.emit(Body::ClientToolCall { id: id.clone(), name, input });
                        held_calls.insert(id.clone(), reply);
                        if let Some(limit) = caps.tool_call_limit_ms {
                            let cut = cut.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(limit)).await;
                                let _ = cut.send(id);
                            });
                        }
                    }
                    None => calls_open = false,
                },
                Some(id) = cuts.recv() => {
                    if let Some(reply) = held_calls.remove(&id) {
                        let limit = caps.tool_call_limit_ms.unwrap_or_default();
                        let reason = format!("timed out after {limit} ms");
                        // Unrecorded, the agent hears only that the session ended.
                        if self.emit(Body::ToolResult { id, output: json!(reason), error: true }) {
                            let _ = reply.send(Err(reason));
                        }
                    }
                }
                request = requests.recv() => match request {
                    Some(Request::Prompt(text)) => queued.push_back(text),
                    Some(Request::Cancel) => match waiting.take() {
                        Some(granted) if turn == Turn::Idle => {
                            turns.give_up(granted);
                            queued.clear();
                            self.emit(Body::PromptsDropped);
                        }
                        other => {
                            waiting = other;
                            let _ = link.commands.send(Command::Cancel);
                        }
                    },
                    Some(Request::Answer { id, decision, message }) => {
                        let open = self.open_requests().remove(&id);
                        if let Some(OpenRequest { driver_id, .. }) = open
                            && self.emit(Body::Answered { id, decision, message: message.clone() })
                        {
                            let _ = link.commands.send(Command::Answer { id: driver_id, decision, message });
                        }
                    }
                    Some(Request::ToolResult { id, reply }) => {
                        if let Some(held) = held_calls.remove(&id)
                            && self.emit(Body::ToolResult { id, output: reply.output.clone(), error: reply.error })
                        {
                            let _ = held.send(Ok(reply));
                        }
                    }
                    Some(Request::HandOver) => {
                        self.emit(Body::HandedOver);
                        break 'run true;
                    }
                    Some(Request::Stop) | None => break 'run true,
                },
            }
        };
        self.stopping.store(true, Ordering::Relaxed);
        self.open_requests().clear();
        // `send` took these, so the client hears they never reached the agent.
        if !queued.is_empty() {
            self.emit(Body::PromptsDropped);
        }
        // No new call reaches the session now: an agent that waits for one while it stops hears that it ended.
        calls.close();
        while let Ok(ToolCall { reply, .. }) = calls.try_recv() {
            let _ = reply.send(Err("the session has ended".to_owned()));
        }
        for (id, reply) in held_calls {
            let reason = "the session has ended".to_owned();
            self.emit(Body::ToolResult { id, output: json!(reason), error: true });
            let _ = reply.send(Err(reason));
        }
        if let Some(granted) = waiting.take() {
            turns.give_up(granted);
        }
        if stopped {
            self.wait_until_gone(&mut link, caps, turn).await;
        }
        drop(slot);
        // `closed` is recorded under the lock a start takes the session by, so a resume's `started` comes after it.
        let mut live = self.inner.live();
        #[cfg(test)]
        tests::before_closed();
        self.emit(Body::Closed);
        if live.get(&self.id).is_some_and(|entry| entry.start == self.start) {
            live.remove(&self.id);
            self.inner.left.notify_waiters();
        }
    }

    /// Stops the agent and waits for it to go, keeping what it says. Past the driver's grace it is told to kill; past
    /// a second grace the session says it is stuck. It is never freed on a timer: until the agent's output closes,
    /// its slot and its id stay taken, and resume and clean-up are refused.
    /// A turn still open gets exactly one end: the agent's own, the first stop diagnostic, or, if its output closes
    /// with the turn open, a `failed`.
    async fn wait_until_gone(&self, link: &mut Link, caps: Capabilities, turn: Turn) {
        let mut going = Going { turn, ended_by_harness: false };
        let _ = link.commands.send(Command::Stop);
        let grace = caps.stop_takes_up_to_ms.map_or(DEFAULT_STOP_GRACE, Duration::from_millis);
        let mut gone = self.drain(link, Some(grace), &mut going).await;
        if !gone {
            let _ = link.commands.send(Command::Kill);
            let reason = format!("the agent was still running {} ms after the stop, so the driver was told to kill it", grace.as_millis());
            self.diagnose(&mut going, FailKind::AgentStopped, &reason);
            gone = self.drain(link, Some(grace), &mut going).await;
        }
        if !gone {
            self.diagnose(&mut going, FailKind::Stuck, "the agent has not gone though it was killed; the session stays running until it does");
            self.drain(link, None, &mut going).await;
        }
        if going.turn != Turn::Idle {
            self.fail(FailKind::AgentStopped, "the agent stopped in the middle of a turn");
        }
    }

    /// Says what went wrong while the agent goes; it ends a turn still open, and only that once.
    fn diagnose(&self, going: &mut Going, kind: FailKind, reason: &str) {
        self.fail(kind, reason);
        if going.turn != Turn::Idle {
            *going = Going { turn: Turn::Idle, ended_by_harness: true };
        }
    }

    /// Keeps what the going agent says, but its requests, until its output closes or `limit` passes. True when it
    /// closed. The agent's own end of a turn a diagnostic already ended is passed over.
    async fn drain(&self, link: &mut Link, limit: Option<Duration>, going: &mut Going) -> bool {
        let gone = async {
            while let Some(body) = link.output.recv().await {
                match &body {
                    Body::Permission { .. } => continue,
                    Body::Started { .. } => {
                        self.started(body);
                        continue;
                    }
                    Body::TurnStarted => *going = Going { turn: Turn::Running, ended_by_harness: false },
                    body if body.ends_turn() => {
                        if going.turn == Turn::Idle && going.ended_by_harness {
                            continue;
                        }
                        going.turn = Turn::Idle;
                    }
                    _ => {}
                }
                self.emit(body);
            }
        };
        match limit {
            Some(limit) => tokio::time::timeout(limit, gone).await.is_ok(),
            None => {
                gone.await;
                true
            }
        }
    }

    /// Records a `started`, after keeping its provider session id for a resume. The row keeps the id as it is, so an
    /// id that holds a secret is not kept, and nor is an earlier one, which no longer names the agent's session: the
    /// session says so, and false says it must stop. A row the store would not change is a broken store: the session
    /// never goes on with an id it could not keep or clear.
    /// An id that is not kept is cleared after the `failed` that says so is recorded, so if the clear fails, that
    /// `failed` is the last stored event and `resume` still refuses the session.
    fn started(&self, body: Body) -> bool {
        let Body::Started { provider_session, .. } = &body else { unreachable!("only a `started` is passed") };
        let safe = redact::text(provider_session, &self.secrets) == *provider_session;
        if safe {
            if let Err(e) = self.inner.with_store(|store| store.set_provider_session(&self.id, Some(provider_session))) {
                self.store_failed(&e);
                return false;
            }
            return self.emit(body);
        }
        self.emit(body);
        self.fail(FailKind::Driver, CANNOT_RESUME);
        if let Err(e) = self.inner.with_store(|store| store.set_provider_session(&self.id, None)) {
            self.store_failed(&e);
        }
        false
    }

    fn open_requests(&self) -> MutexGuard<'_, HashMap<String, OpenRequest>> {
        self.open.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sends the next queued prompt once it is recorded; the turn is then prompted until the driver starts it. A prompt
    /// the store would not take is not sent, and the session stops on its broken store. None when the driver no longer
    /// takes commands: the session says so and stops.
    fn prompt(&self, link: &Link, queued: &mut VecDeque<String>) -> Option<Turn> {
        let text = queued.pop_front().expect("a prompt is queued");
        if !self.emit(Body::Prompted { text: text.clone() }) {
            return Some(Turn::Idle);
        }
        if link.commands.send(Command::Prompt(text)).is_err() {
            self.fail(FailKind::AgentStopped, "the agent did not take the prompt: its driver no longer reads commands");
            return None;
        }
        Some(Turn::Prompted)
    }

    fn fail(&self, kind: FailKind, reason: &str) {
        self.emit(Body::Failed { kind, reason: reason.to_owned() });
    }

    /// Stores the event and sends it to the session's clients. True when it was stored. When the store fails, the
    /// clients get one `failed` event and the last `closed`, numbered 0 since no number could be given, and the
    /// session stops; nothing is written after that, even if the store would take it again.
    fn emit(&self, body: Body) -> bool {
        if self.broken.load(Ordering::Relaxed) {
            if body == Body::Closed {
                self.publish(Event { seq: 0, ms: now_ms(), body });
            }
            return false;
        }
        let body = redact::body(body, &self.secrets);
        // Stored and sent under the store's lock, as `watch` reads and registers under it: a client's read and its live
        // events never overlap, so a locked session's whole event is never taken for the withheld copy the read gave.
        let store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match store.as_ref().ok_or(Error::ShutDown).and_then(|store| store.append(&self.id, &body, now_ms())) {
            Ok(event) => {
                #[cfg(test)]
                tests::before_publish();
                self.publish(event);
                true
            }
            Err(e) => {
                drop(store);
                self.store_failed(&e);
                if body == Body::Closed {
                    self.publish(Event { seq: 0, ms: now_ms(), body });
                }
                false
            }
        }
    }

    /// Sends the event to the session's clients. A watcher that has gone is dropped.
    fn publish(&self, event: Event) {
        self.watchers.lock().unwrap_or_else(|p| p.into_inner()).retain(|watcher| watcher.send(event.clone()).is_ok());
        let _ = self.events.send(event);
    }

    /// Breaks the session on a store that failed: its clients get one `failed`, numbered 0, and it stops.
    fn store_failed(&self, e: &Error) {
        eprintln!("harness: session {}: {e}", self.id);
        if !self.broken.swap(true, Ordering::Relaxed) {
            let reason = format!("the store could not keep this session's events, so it stops: {e}");
            let body = Body::Failed { kind: FailKind::Harness, reason };
            self.publish(Event { seq: 0, ms: now_ms(), body });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::{Mock, Script};

    type Hook = Box<dyn FnOnce() + Send>;

    /// Runs once, just before a task records its `closed`.
    static BEFORE_CLOSED: Mutex<Option<Hook>> = Mutex::new(None);

    pub(super) fn before_closed() {
        let hook = BEFORE_CLOSED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// Told once when a start is about to take the session's lock to reserve it.
    static BEFORE_RESERVE: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

    /// Runs once, just after an event is stored and before it is sent.
    static BEFORE_PUBLISH: Mutex<Option<Hook>> = Mutex::new(None);

    pub(super) fn before_publish() {
        let hook = BEFORE_PUBLISH.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(hook) = hook {
            hook();
        }
    }

    pub(super) fn before_reserve() {
        if let Some(reached) = BEFORE_RESERVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() {
            let _ = reached.send(());
        }
    }

    fn starts_and_closes(harness: &Harness, id: &str) -> Vec<String> {
        let events = harness.events(id, 0).unwrap_or_default();
        events.into_iter().map(|event| event.body.type_name()).filter(|kind| kind == "started" || kind == "closed").collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn race_a_resume_tried_just_before_closed_is_recorded_after_it() {
        let tmp = tempfile::tempdir().unwrap();
        let mock = Mock::new(Script::parse("{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let spec = Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() };
        let (id, mut events) = harness.open(spec).await.unwrap();
        let (resuming, resumed_id, id_for_hook) = (harness.clone(), id.clone(), id.clone());
        let worker: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
        let kept = worker.clone();
        *BEFORE_CLOSED.lock().unwrap() = Some(Box::new(move || {
            // A client resumes from another thread at this moment. The hook waits until the resume has reached its
            // reservation, then gives its start a bounded time to record `started`: it can only if the lock this
            // task holds does not guard the reservation.
            let (reached, reaches) = std::sync::mpsc::channel();
            *BEFORE_RESERVE.lock().unwrap() = Some(reached);
            let recorder = resuming.clone();
            *kept.lock().unwrap() = Some(std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                runtime.block_on(async {
                    if resuming.resume(&resumed_id).await.is_ok() {
                        while starts_and_closes(&resuming, &resumed_id).iter().filter(|kind| *kind == "started").count() < 2 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    }
                });
            }));
            reaches.recv_timeout(Duration::from_secs(5)).expect("the resume reached its reservation");
            let given = std::time::Instant::now() + Duration::from_secs(1);
            while std::time::Instant::now() < given && starts_and_closes(&recorder, &id_for_hook).len() < 2 {
                std::thread::sleep(Duration::from_millis(5));
            }
        }));
        harness.close(&id).unwrap();
        while events.recv().await.is_ok_and(|event| event.body != Body::Closed) {}
        for _ in 0..200 {
            if starts_and_closes(&harness, &id).len() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(starts_and_closes(&harness, &id), ["started", "closed", "started"]);
        worker.lock().unwrap().take().expect("the hook ran").join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn race_a_watch_between_an_events_store_and_send_gets_it_once_whole_or_withheld_never_both() {
        let tmp = tempfile::tempdir().unwrap();
        let mock = Mock::new(Script::parse("{\"prompt\": null}\n{\"say\": \"x\"}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let spec = Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), ..Open::default() };
        let (id, mut events) = harness.open(spec).await.unwrap();
        events.recv().await.unwrap();
        let (watching, id_for_hook) = (harness.clone(), id.clone());
        let watched: Arc<Mutex<Option<std::thread::JoinHandle<_>>>> = Arc::default();
        let kept = watched.clone();
        *BEFORE_PUBLISH.lock().unwrap() = Some(Box::new(move || {
            // A client watches from another thread at this moment. The hook gives it a bounded time to read: it can
            // only if the session does not hold the store's lock while it sends.
            let (done, finished) = std::sync::mpsc::channel();
            *kept.lock().unwrap() = Some(std::thread::spawn(move || {
                let watch = watching.watch(&id_for_hook, 0).unwrap();
                let _ = done.send(());
                watch
            }));
            let _ = finished.recv_timeout(Duration::from_millis(500));
        }));
        harness.send(&id, "go").unwrap();
        while events.recv().await.is_ok_and(|event| event.body != Body::TurnStarted) {}
        let handle = watched.lock().unwrap().take().expect("the hook ran");
        let (stored, receiver) = handle.join().unwrap();
        let mut receiver = receiver.expect("the session runs");
        let last = stored.last().map_or(0, |event| event.seq);
        let first_live = receiver.recv().await.unwrap();
        assert!(first_live.seq == last + 1, "the read ends at {last}, the live events start at {}", first_live.seq);
    }
}
