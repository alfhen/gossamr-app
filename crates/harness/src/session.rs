//! Sessions: each runs on its own task between the client's requests and its driver, and every event it has goes
//! through redaction into the store and out to the clients that listen.
//!
//! The harness holds a limit on how many sessions are in a turn at once. A prompt past the limit waits, and says so.
//! A turn the agent starts by itself takes no slot: it has begun before the harness sees it, so nothing can hold it
//! back, and a stray event after a turn's end would otherwise hold a slot for good.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast};

use crate::driver::{Command, Driver, Launch, Link, Secret, random_hex};
use crate::error::{Error, Result};
use crate::event::{Body, Decision, Event, TurnEnd};
use crate::redact;
use crate::store::{Store, now_ms};

pub const DEFAULT_TURN_LIMIT: usize = 4;

/// How long a stopped agent may take to go. Until it has gone, or this has passed, its slot and its session id stay
/// taken, so neither another turn nor a resume of the same session can start beside it.
const STOP_GRACE: Duration = Duration::from_secs(10);

/// How often a running harness drops payload older than 30 days.
const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub struct Harness {
    inner: Arc<Inner>,
}

struct Inner {
    store: Mutex<Store>,
    drivers: HashMap<String, Arc<dyn Driver>>,
    slots: Arc<Semaphore>,
    live: Mutex<HashMap<String, Live>>,
    starts: AtomicU64,
}

#[derive(Clone)]
struct Live {
    requests: UnboundedSender<Command>,
    events: broadcast::Sender<Event>,
    /// Which start of the session this is, so a task that ends removes only its own entry.
    start: u64,
}

pub struct Open {
    pub provider: String,
    /// Pip's profile. Its events reach the live client only; the store keeps their number and kind.
    pub locked: bool,
    pub cwd: PathBuf,
    pub model: Option<String>,
}

impl Harness {
    /// Call it inside a Tokio runtime: the harness sweeps old payload on a task of its own.
    pub fn new(store: Store, drivers: Vec<(String, Arc<dyn Driver>)>, turn_limit: usize) -> Harness {
        let inner = Arc::new(Inner {
            store: Mutex::new(store),
            drivers: drivers.into_iter().collect(),
            slots: Arc::new(Semaphore::new(turn_limit)),
            live: Mutex::new(HashMap::new()),
            starts: AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&inner);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_EVERY).await;
                let Some(inner) = weak.upgrade() else { return };
                if let Err(e) = inner.store().sweep(now_ms()) {
                    eprintln!("harness: sweeping old payload: {e}");
                }
            }
        });
        Harness { inner }
    }

    /// Starts a session. The receiver gets every event from the first.
    pub fn open(&self, spec: Open) -> Result<(String, broadcast::Receiver<Event>)> {
        let driver = self.driver(&spec.provider)?;
        let id = random_hex(8);
        let store = self.inner.store();
        store.sweep(now_ms())?;
        store.create_session(&id, &spec.provider, spec.locked, &spec.cwd, spec.model.as_deref())?;
        drop(store);
        let launch = Launch {
            cwd: spec.cwd,
            locked: spec.locked,
            model: spec.model,
            resume: None,
            tools_token: Secret::random(),
            tools_url: None,
        };
        let events = self.start(&id, driver, launch)?;
        Ok((id, events))
    }

    /// Starts a session again by its provider's session id, with a new tools token.
    pub fn resume(&self, id: &str) -> Result<broadcast::Receiver<Event>> {
        let row = self.inner.store().session(id)?;
        let provider_session =
            row.provider_session.ok_or_else(|| Error::Driver(format!("session {id} never started at its provider")))?;
        let launch = Launch {
            cwd: row.cwd,
            locked: row.locked,
            model: row.model,
            resume: Some(provider_session),
            tools_token: Secret::random(),
            tools_url: None,
        };
        self.start(id, self.driver(&row.provider)?, launch)
    }

    /// Sends a prompt. One sent while a turn runs waits for that turn to end.
    pub fn send(&self, id: &str, text: impl Into<String>) -> Result<()> {
        self.request(id, Command::Prompt(text.into()))
    }

    pub fn answer(&self, id: &str, request: &str, decision: Decision) -> Result<()> {
        self.request(id, Command::Answer { id: request.to_owned(), decision })
    }

    pub fn tool_result(&self, id: &str, call: &str, output: Value, error: bool) -> Result<()> {
        self.request(id, Command::ToolResult { id: call.to_owned(), output, error })
    }

    /// Cancels the running turn, or a prompt that waits for a slot.
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.request(id, Command::Cancel)
    }

    pub fn close(&self, id: &str) -> Result<()> {
        self.request(id, Command::Stop)
    }

    /// Closes the session if it runs and drops its payload from the store.
    pub fn clean_up(&self, id: &str) -> Result<()> {
        let _ = self.close(id);
        self.inner.store().clean_up(id)
    }

    pub fn events(&self, id: &str, after: u64) -> Result<Vec<Event>> {
        let store = self.inner.store();
        store.sweep(now_ms())?;
        store.events(id, after)
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

    fn request(&self, id: &str, command: Command) -> Result<()> {
        self.live(id)?.requests.send(command).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Takes the session's id before the driver opens, so two starts of one session cannot both open it.
    fn start(&self, id: &str, driver: Arc<dyn Driver>, launch: Launch) -> Result<broadcast::Receiver<Event>> {
        let secrets = vec![launch.tools_token.expose().to_owned()];
        let (events, receiver) = broadcast::channel(1024);
        let (requests, requests_rx) = mpsc::unbounded_channel();
        let start = self.inner.starts.fetch_add(1, Ordering::Relaxed);
        {
            let mut live = self.inner.live();
            if live.contains_key(id) {
                return Err(Error::Running(id.to_owned()));
            }
            live.insert(id.to_owned(), Live { requests, events: events.clone(), start });
        }
        let link = driver.open(launch).map_err(|e| {
            self.inner.forget(id, start);
            Error::Driver(e)
        })?;
        let task = Task { inner: self.inner.clone(), id: id.to_owned(), secrets, events, start, broken: AtomicBool::new(false) };
        tokio::spawn(task.run(link, requests_rx));
        Ok(receiver)
    }
}

impl Inner {
    /// Removes the session's live entry if it is still this start's.
    fn forget(&self, id: &str, start: u64) {
        let mut live = self.live();
        if live.get(id).is_some_and(|entry| entry.start == start) {
            live.remove(id);
        }
    }

    fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn live(&self) -> MutexGuard<'_, HashMap<String, Live>> {
        self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

type Acquiring = Pin<Box<dyn Future<Output = OwnedSemaphorePermit> + Send>>;

struct Task {
    inner: Arc<Inner>,
    id: String,
    secrets: Vec<String>,
    events: broadcast::Sender<Event>,
    start: u64,
    /// The store failed to take an event. The session stops: nothing more is sent that could not be recorded.
    broken: AtomicBool,
}

impl Task {
    async fn run(self, mut link: Link, mut requests: UnboundedReceiver<Command>) {
        let mut queued: VecDeque<String> = VecDeque::new();
        let mut slot: Option<OwnedSemaphorePermit> = None;
        let mut acquiring: Option<Acquiring> = None;
        let stopped = 'run: loop {
            if slot.is_none() && acquiring.is_none() && !queued.is_empty() {
                match self.inner.slots.clone().try_acquire_owned() {
                    Ok(permit) => slot = Some(self.prompt(&link, permit, &mut queued)),
                    Err(_) => {
                        self.emit(Body::Waiting);
                        let slots = self.inner.slots.clone();
                        acquiring = Some(Box::pin(async move {
                            slots.acquire_owned().await.expect("the harness never closes its semaphore")
                        }));
                    }
                }
            }
            if self.broken.load(Ordering::Relaxed) {
                let _ = link.commands.send(Command::Stop);
                break true;
            }
            // The agent's events go first, so what it said is in the record before what the client asked next.
            tokio::select! {
                biased;
                output = link.output.recv() => match output {
                    Some(body) => {
                        if body.ends_turn() {
                            slot = None;
                        }
                        if let Body::Started { provider_session, .. } = &body
                            && let Err(e) = self.inner.store().set_provider_session(&self.id, provider_session)
                        {
                            eprintln!("harness: session {}: {e}", self.id);
                        }
                        self.emit(body);
                    }
                    None => {
                        if slot.is_some() {
                            self.emit(Body::Failed { reason: "the agent stopped in the middle of a turn".into() });
                        }
                        break 'run false;
                    }
                },
                permit = async { acquiring.as_mut().expect("the branch runs only while acquiring").await },
                    if acquiring.is_some() => {
                    acquiring = None;
                    slot = Some(self.prompt(&link, permit, &mut queued));
                }
                request = requests.recv() => match request {
                    Some(Command::Prompt(text)) => queued.push_back(text),
                    Some(Command::Cancel) if acquiring.is_some() => {
                        acquiring = None;
                        queued.clear();
                        self.emit(Body::TurnEnded { how: TurnEnd::Cancelled });
                    }
                    Some(Command::Answer { id, decision }) => {
                        self.emit(Body::Answered { id: id.clone(), decision });
                        let _ = link.commands.send(Command::Answer { id, decision });
                    }
                    Some(Command::Stop) | None => {
                        let _ = link.commands.send(Command::Stop);
                        break 'run true;
                    }
                    Some(other) => {
                        let _ = link.commands.send(other);
                    }
                },
            }
        };
        if stopped {
            let gone = async {
                while let Some(body) = link.output.recv().await {
                    self.emit(body);
                }
            };
            if tokio::time::timeout(STOP_GRACE, gone).await.is_err() {
                eprintln!("harness: session {}: the agent was still running {} s after the stop", self.id, STOP_GRACE.as_secs());
            }
        }
        drop(slot);
        self.inner.forget(&self.id, self.start);
        self.emit(Body::Closed);
    }

    fn prompt(&self, link: &Link, permit: OwnedSemaphorePermit, queued: &mut VecDeque<String>) -> OwnedSemaphorePermit {
        let text = queued.pop_front().expect("a prompt is queued");
        if self.emit(Body::Prompted { text: text.clone() }) {
            let _ = link.commands.send(Command::Prompt(text));
        }
        permit
    }

    /// Stores the event and sends it to the session's clients. When the store fails, the clients get one `failed` event
    /// and the last `closed`, numbered 0 since no number could be given, and the session stops.
    fn emit(&self, body: Body) -> bool {
        let body = redact::body(body, &self.secrets);
        let stored = self.inner.store().append(&self.id, &body, now_ms());
        match stored {
            Ok(event) => {
                let _ = self.events.send(event);
                true
            }
            Err(e) => {
                eprintln!("harness: session {}: {e}", self.id);
                if !self.broken.swap(true, Ordering::Relaxed) {
                    let reason = format!("the store could not keep this session's events, so it stops: {e}");
                    let _ = self.events.send(Event { seq: 0, ms: now_ms(), body: Body::Failed { reason } });
                }
                if body == Body::Closed {
                    let _ = self.events.send(Event { seq: 0, ms: now_ms(), body });
                }
                false
            }
        }
    }
}
