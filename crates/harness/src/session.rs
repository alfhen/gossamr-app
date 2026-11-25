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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::{Notify, broadcast, oneshot};

use crate::driver::{Capabilities, Command, Driver, Launch, Link, OpenError, Secret, random_hex};
use crate::error::{Error, Result};
use crate::event::{Body, Decision, Event, FailKind, QuestionEnd, TurnEnd};
use crate::redact;
use crate::store::{Listed, NewSession, Store, now_ms};
use crate::tools::{ASK, Endpoints, RESULT, Reply, ToolCall, ToolSpec, check_tools, endpoint_name};
use crate::work::{Setup, Work, valid_effort};

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub turn_limit: usize,
    /// How far a client of a locked session may fall behind, in events and in bytes; see `LOCKED_BACKLOG`.
    pub locked_backlog: usize,
    pub locked_backlog_bytes: usize,
    /// How many calls a session may make to its tools endpoint while the harness runs.
    pub tool_calls: u32,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings { turn_limit: 4, locked_backlog: LOCKED_BACKLOG, locked_backlog_bytes: LOCKED_BACKLOG_BYTES, tool_calls: TOOL_CALLS }
    }
}

/// How many calls a session may make to its tools endpoint while the harness runs: well above what a long session of
/// the app's agents made (they were held to 200 reads and asks).
pub const TOOL_CALLS: u32 = 2000;

/// What a call of a client tool fails with when no client listens to the session.
pub const CLIENT_AWAY: &str = "the client is away, so no one can answer this call";

/// How many events a client of a locked session may fall behind before its watch ends with "events were lost". A locked
/// session's events are not in the store, so within this a client misses none; past it, the harness holds no more for
/// it.
pub const LOCKED_BACKLOG: usize = 1 << 16;
/// How many bytes of events, as JSON, a client of a locked session may fall behind by, under the same rule.
pub const LOCKED_BACKLOG_BYTES: usize = 64 << 20;

/// The reason of the `failed` a session records when it cannot be resumed; the session's row is marked with it.
pub const CANNOT_RESUME: &str = "the provider's session id looks like a secret, so it is not kept, the session cannot be resumed and it stops";

/// What `ask` returns when the provider would cut the call before the answer comes.
pub const QUESTION_PENDING: &str = "question pending, end your turn: the answer comes as your next prompt";
/// How long before a provider's limit on a call `ask` returns: this, or a quarter of the limit when that is less.
pub const ASK_MARGIN: Duration = Duration::from_secs(10);
/// The longest question `ask` takes, in characters.
pub const QUESTION_CHARS: usize = 4000;

/// What a call still held when its session ends gets back.
const ENDED: &str = "the session has ended";

/// How long a stopped agent may take to go when its driver does not say: above the 15 s `agy acp` was seen to take
/// while a command ran.
pub const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct Harness {
    inner: Arc<Inner>,
}

// Lock order: `live`, then `store`, then a session's `open`, `questions` or `watchers`. `endpoints` is taken after
// `live`, or alone.
struct Inner {
    /// None once the harness has shut down, which frees the data folder.
    store: Mutex<Option<Store>>,
    drivers: HashMap<String, Arc<dyn Driver>>,
    turns: Arc<Turns>,
    live: Mutex<HashMap<String, Live>>,
    /// Sessions whose clean-up is removing their worktree: none of them starts meanwhile. Taken under `live`.
    cleaning: Mutex<HashSet<String>>,
    setup: Arc<Setup>,
    starts: AtomicU64,
    /// Set under `live` by `shutdown`: no session starts after it.
    closing: AtomicBool,
    /// Told each time a session leaves `live`, or says it is stuck.
    left: Notify,
    locked_backlog: usize,
    locked_backlog_bytes: usize,
    /// The stored key of each token revoked, for the connections that proved it.
    revoked: broadcast::Sender<[u8; 32]>,
    /// The tools endpoint, bound when the first session starts.
    endpoints: Mutex<Option<Arc<Endpoints>>>,
    tool_calls: u32,
    #[cfg(test)]
    hooks: tests::Hooks,
}

/// A client of a locked session: every event while it keeps up within the backlog, and `lost` once it has not. Each
/// event goes with its size, which `bytes` counts until the client has taken it.
pub(crate) struct Watcher {
    events: mpsc::Sender<(Event, usize)>,
    lost: Arc<AtomicBool>,
    bytes: Arc<AtomicUsize>,
    most: usize,
}

/// Where a client's live events come from. A locked session's events are not in the store, so its client gets them on
/// a channel of its own and is told if it fell too far behind; any other client reads what it missed from the store.
pub enum Feed {
    Locked { events: mpsc::Receiver<(Event, usize)>, lost: Arc<AtomicBool>, bytes: Arc<AtomicUsize> },
    Stored(broadcast::Receiver<Event>),
}

impl Feed {
    fn locked(backlog: usize, most: usize) -> (Watcher, Feed) {
        let (events, receiver) = mpsc::channel(backlog);
        let (lost, bytes) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        (Watcher { events, lost: lost.clone(), bytes: bytes.clone(), most }, Feed::Locked { events: receiver, lost, bytes })
    }
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
    /// A locked session's clients; see `Feed`.
    watchers: Arc<Mutex<Vec<Watcher>>>,
    locked: bool,
    /// The agent has not gone though it was killed: `shutdown` stops waiting for it.
    stuck: Arc<AtomicBool>,
    /// The name its tools endpoint is served under.
    endpoint: String,
}

struct OpenRequest {
    driver_id: String,
    /// An answer is on its way to the task, which checks the request is still open before it records or sends it.
    answered: bool,
    /// What it asks was cut to fit an event, so the person has not seen all of it: it can only be denied.
    cut: bool,
}

enum Request {
    Prompt(String),
    /// An answer to an open question: to its held `ask` call, or else as the next prompt, before those already queued.
    AnswerAsk { question: String, text: String },
    Answer { id: String, decision: Decision, message: Option<String> },
    ToolResult { id: String, reply: Reply },
    Cancel,
    Stop,
    HandOver,
    /// The harness shuts down: the session stops, and its open question stays open for after the restart.
    Shutdown,
    /// "Carry on" after a resume: sent once nothing forbids it, checked in the step that sends it.
    CarryOn(String),
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
    /// The login folder as typed; None is the provider's usual setup. See `Setup::agent_env`.
    pub login: Option<String>,
    pub effort: Option<String>,
    /// The clone and branch of a session that named a repo; `cwd` is then its worktree, which clean-up removes.
    pub work: Option<Work>,
    /// The tools the client offers; each call is a `client_tool_call` event it answers. See `tools::check_tools`.
    pub tools: Vec<ToolSpec>,
    /// The JSON Schema the session's `result` must fit.
    pub result_schema: Option<Value>,
    /// Said to the session's clients as its first events, before the agent's own.
    pub notices: Vec<String>,
}

impl Harness {
    pub fn new(store: Store, drivers: Vec<(String, Arc<dyn Driver>)>, settings: Settings) -> Harness {
        Harness::with_setup(store, drivers, settings, Arc::new(Setup::default()))
    }

    /// A harness whose sessions take their environment, logins and clones from `setup`.
    pub fn with_setup(store: Store, drivers: Vec<(String, Arc<dyn Driver>)>, settings: Settings, setup: Arc<Setup>) -> Harness {
        Harness {
            inner: Arc::new(Inner {
                store: Mutex::new(Some(store)),
                drivers: drivers.into_iter().collect(),
                turns: Arc::new(Turns { limit: settings.turn_limit, state: Mutex::new(TurnsState::default()) }),
                live: Mutex::new(HashMap::new()),
                cleaning: Mutex::new(HashSet::new()),
                setup,
                starts: AtomicU64::new(0),
                closing: AtomicBool::new(false),
                left: Notify::new(),
                // A channel takes at least one and at most this many.
                locked_backlog: settings.locked_backlog.clamp(1, tokio::sync::Semaphore::MAX_PERMITS),
                locked_backlog_bytes: settings.locked_backlog_bytes,
                revoked: broadcast::channel(16).0,
                endpoints: Mutex::new(None),
                tool_calls: settings.tool_calls,
                #[cfg(test)]
                hooks: tests::Hooks::default(),
            }),
        }
    }

    /// Starts a session. The receiver gets every event from the first.
    pub async fn open(&self, spec: Open) -> Result<(String, broadcast::Receiver<Event>)> {
        let (id, events, _) = self.open_watched(spec)?;
        Ok((id, events))
    }

    /// Starts a session, with a client's feed of its events from the first.
    pub fn open_watched(&self, spec: Open) -> Result<(String, broadcast::Receiver<Event>, Feed)> {
        let (watcher, feed) = match spec.locked {
            true => {
                let (watcher, feed) = Feed::locked(self.inner.locked_backlog, self.inner.locked_backlog_bytes);
                (Some(watcher), Some(feed))
            }
            false => (None, None),
        };
        let driver = self.check_open(&spec.provider, spec.login.as_deref(), spec.effort.as_deref())?;
        check_tools(&spec.tools, spec.result_schema.as_ref())?;
        let id = random_hex(8);
        let endpoint = endpoint_name();
        // The row is made where the start checks for a shutdown, so a refused open leaves none.
        let (events, second) = self.start(&id, watcher, false, |store| {
            let new = NewSession {
                provider: &spec.provider,
                locked: spec.locked,
                cwd: &spec.cwd,
                model: spec.model.as_deref(),
                login: spec.login.as_deref(),
                effort: spec.effort.as_deref(),
                work: spec.work.as_ref(),
                endpoint: Some(&endpoint),
                tools: &spec.tools,
                result_schema: spec.result_schema.as_ref(),
            };
            store.insert_session(&id, &new)?;
            if spec.ends_with_client {
                store.set_ends_with_client(&id)?;
            }
            let Open { provider, cwd, locked, model, login, effort, notices, tools, result_schema, .. } = spec;
            Ok(Plan { driver, provider, cwd, locked, model, login, effort, resume: None, notices, endpoint, tools, result_schema })
        })?;
        Ok((id, events, feed.unwrap_or(Feed::Stored(second))))
    }

    /// What `open` refuses of a provider, a login and an effort, before any row is made or anything is cloned.
    pub fn check_open(&self, provider: &str, login: Option<&str>, effort: Option<&str>) -> Result<Arc<dyn Driver>> {
        let driver = self.driver(provider)?;
        if effort.is_some_and(|effort| !valid_effort(effort)) {
            return Err(Error::Refused("an effort is a lowercase word of at most 16 letters".into()));
        }
        self.inner.setup.agent_env(provider, login)?;
        Ok(driver)
    }

    /// Starts a session again by its provider's session id, with a new tools token. A running or cleaned-up session
    /// is refused, and so is one that ends with its client, one marked as one that cannot be resumed, and one handed
    /// over to Terminal: that one only through `take_back`.
    pub async fn resume(&self, id: &str) -> Result<broadcast::Receiver<Event>> {
        self.resume_from(id, false, false)
    }

    /// Resumes a session that is not running, and with `carry_on` sends it that prompt. Whether "carry on" may be sent
    /// is checked under the lock the start takes, and again in the step that sends it: a question, a permission
    /// request, a stop or a hand-over that comes first means it is not sent, and the session says so.
    pub async fn resume_with(&self, id: &str, carry_on: Option<String>) -> Result<broadcast::Receiver<Event>> {
        let events = self.resume_from(id, false, carry_on.is_some())?;
        if let Some(text) = carry_on {
            self.request(id, Request::CarryOn(text))?;
        }
        Ok(events)
    }

    /// Resumes a session handed over to Terminal, once the person has said they took it back from there.
    pub async fn take_back(&self, id: &str) -> Result<broadcast::Receiver<Event>> {
        self.resume_from(id, true, false)
    }

    fn resume_from(&self, id: &str, taken_back: bool, carry_on: bool) -> Result<broadcast::Receiver<Event>> {
        self.start(id, None, taken_back, |store| {
            let row = store.session(id)?;
            if row.cleaned {
                return Err(Error::CleanedUp(id.to_owned()));
            }
            if row.ends_with_client {
                return Err(Error::EndedWithClient(id.to_owned()));
            }
            if row.cannot_resume {
                return Err(Error::CannotResume(id.to_owned()));
            }
            if row.handed_over && !taken_back {
                return Err(Error::HandedOver(id.to_owned()));
            }
            if row.given_up {
                return Err(Error::Refused(format!("a shutdown gave up on session {id}'s agent, which may still run, so it is not resumed")));
            }
            if carry_on {
                if let Some(why) = &row.no_carry_on {
                    return Err(Error::Refused(format!("session {id} may not carry on: {why}")));
                }
                if let Some(question) = store.open_question(id)? {
                    return Err(Error::Refused(format!("session {id} may not carry on: question {question} is open, and its answer is the next prompt")));
                }
            }
            let provider_session =
                row.provider_session.ok_or_else(|| Error::Driver(format!("session {id} has no provider session id to resume")))?;
            // A clean-up cut short after the worktree went leaves nothing to resume in.
            if row.work.is_some() && row.cwd.symlink_metadata().is_err() {
                return Err(Error::Refused(format!("session {id}'s worktree is gone, so it can't be resumed: clean it up")));
            }
            // A later session may have the same branch, and so the same folder, again: it is that session's now.
            if let Some(work) = &row.work
                && store.worktree_owner(work)?.as_deref() != Some(id)
            {
                return Err(Error::Refused(format!("another session works in session {id}'s worktree now, so it can't be resumed")));
            }
            let driver = self.driver(&row.provider)?;
            let endpoint = match row.endpoint {
                Some(endpoint) => endpoint,
                None => {
                    let endpoint = endpoint_name();
                    store.set_endpoint(id, &endpoint)?;
                    endpoint
                }
            };
            let (provider, cwd, locked, model, login, effort) = (row.provider, row.cwd, row.locked, row.model, row.login, row.effort);
            if let Some(schema) = &row.result_schema {
                // A row from before the harness checked schemas may hold rules it would skip.
                crate::schema::check(schema).map_err(|why| Error::Refused(format!("this session's result schema cannot be checked, so it is not resumed: {why}")))?;
            }
            let (tools, result_schema, resume) = (row.tools, row.result_schema, Some(provider_session));
            Ok(Plan { driver, provider, cwd, locked, model, login, effort, resume, notices: Vec::new(), endpoint, tools, result_schema })
        })
        .map(|(events, _)| events)
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
                Some(entry) if !entry.answered => {
                    if entry.cut && decision == Decision::Allow {
                        return Err(Error::Refused(format!("{request} was cut to fit, so not all it asks is shown: it can only be denied")));
                    }
                    entry.answered = true;
                }
                _ => return Err(Error::NotOpen(request.to_owned())),
            }
        }
        let answer = Request::Answer { id: request.to_owned(), decision, message };
        live.requests.send(answer).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Answers an open question, once. The answer goes to the agent's `ask` call if the session still holds it, and
    /// otherwise as the next prompt, after the running turn and before any prompt sent while the question was open. A
    /// session that is not running is resumed first, with a new tools token, when the question is still open in the
    /// store.
    pub async fn answer_question(&self, id: &str, question: &str, text: String) -> Result<()> {
        let live = match self.taking(id) {
            Ok(live) => live,
            Err(_) if self.inner.with_store(|store| store.open_question(id))?.as_deref() == Some(question) => {
                drop(self.resume(id).await?);
                self.taking(id)?
            }
            Err(e) => return Err(e),
        };
        if !live.questions.lock().unwrap_or_else(|p| p.into_inner()).remove(question) {
            return Err(Error::NoQuestion(question.to_owned()));
        }
        let answer = Request::AnswerAsk { question: question.to_owned(), text };
        live.requests.send(answer).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// The session's open question, asked through `ask` and kept in the store: its id.
    pub fn open_question(&self, id: &str) -> Result<Option<String>> {
        self.inner.with_store(|store| store.open_question(id))
    }

    /// Whether the harness may send the session "carry on" (H10): never while a question is open, since its answer is
    /// the next prompt. The refusal names the question.
    pub fn may_carry_on(&self, id: &str) -> Result<()> {
        let live = self.live(id).ok().and_then(|live| live.questions.lock().unwrap_or_else(|p| p.into_inner()).iter().next().cloned());
        match live.or(self.open_question(id)?) {
            Some(question) => Err(Error::Refused(format!("question {question} is open: its answer is the next prompt, not \"carry on\""))),
            None => Ok(()),
        }
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

    /// The first stop wins: a hand over after another stop is refused, as it would be dropped with the session's other
    /// requests, and a close after one has nothing more to do.
    fn stop(&self, id: &str, request: Request) -> Result<()> {
        let live = self.live(id)?;
        let already = live.stopping.swap(true, Ordering::Relaxed);
        #[cfg(test)]
        self.inner.hooks.after_stop_flag();
        if already {
            return match request {
                Request::HandOver => Err(Error::Refused(format!("session {id} is already stopping, so it was not handed over"))),
                _ => Ok(()),
            };
        }
        live.requests.send(request).map_err(|_| Error::NotRunning(id.to_owned()))
    }

    /// Stops every session, waits until each has recorded its `closed` or said its agent is stuck, and frees the data
    /// folder. Nothing starts after it. A stuck session gets a last `failed` that says the harness gave up on it, and
    /// is named in what this returns; its agent may still run, for the next start to find.
    pub async fn shutdown(&self) -> Vec<String> {
        let running: Vec<Live> = {
            let live = self.inner.live();
            self.inner.closing.store(true, Ordering::Relaxed);
            live.values().cloned().collect()
        };
        // As in `stop`, the first stop wins: a hand over already on its way is not overtaken.
        for live in running {
            if !live.stopping.swap(true, Ordering::Relaxed) {
                let _ = live.requests.send(Request::Shutdown);
            }
        }
        #[cfg(test)]
        self.inner.hooks.after_shutdown_stops();
        loop {
            let left = self.inner.left.notified();
            tokio::pin!(left);
            left.as_mut().enable();
            if self.inner.live().values().all(|live| live.stuck.load(Ordering::Relaxed)) {
                break;
            }
            left.await;
        }
        let live = self.inner.live();
        let mut store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let stuck: Vec<String> = live.keys().cloned().collect();
        if let Some(store) = store.as_ref() {
            for id in &stuck {
                let reason = "the harness shut down without waiting longer for this agent, which may still run".to_owned();
                let _ = store.append(id, &Body::Failed { kind: FailKind::Stuck, reason }, now_ms());
                let _ = store.set_given_up(id);
            }
        }
        *store = None;
        stuck
    }

    /// Drops payload past 30 days and deletes old sessions' event rows, but never a running session's; see
    /// `Store::sweep`.
    pub fn sweep(&self) -> Result<usize> {
        let live = self.inner.live();
        let running: Vec<String> = live.keys().cloned().collect();
        self.inner.with_store(|store| store.sweep_except(now_ms(), &running))
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

    /// Revokes a token and tells the connections that proved it, which end.
    pub fn revoke_client_token(&self, id: i64) -> Result<()> {
        let key = self.inner.with_store(|store| store.revoke_client_token(id))?;
        let _ = self.inner.revoked.send(key);
        Ok(())
    }

    /// How far a client of a locked session may fall behind: events, and bytes.
    pub fn locked_backlog(&self) -> (usize, usize) {
        (self.inner.locked_backlog, self.inner.locked_backlog_bytes)
    }

    /// The stored keys of tokens as they are revoked.
    pub fn revocations(&self) -> broadcast::Receiver<[u8; 32]> {
        self.inner.revoked.subscribe()
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

    /// Removes a session that named a repo's worktree and branch, never forcing: what git keeps, the session keeps,
    /// and clean-up is refused. Then drops the session's payload. A running session is refused.
    pub async fn clean_up(&self, id: &str) -> Result<()> {
        // Under the lock a start takes the session by, so a resume cannot start from a row being cleaned up.
        let work = {
            let live = self.inner.live();
            if live.contains_key(id) {
                return Err(Error::Running(id.to_owned()));
            }
            let row = self.inner.with_store(|store| store.session(id))?;
            // A worktree has one owner among the sessions not cleaned up that name it (`Store::worktree_owner`); only
            // the owner's clean-up removes it. Asked before the reservation, so a failed read leaves none behind.
            let owned = match &row.work {
                Some(work) if !row.cleaned => self.inner.with_store(|store| store.worktree_owner(work))?.as_deref() == Some(id),
                _ => false,
            };
            let mut cleaning = self.inner.cleaning.lock().unwrap_or_else(|p| p.into_inner());
            if !cleaning.insert(id.to_owned()) {
                return Err(Error::Running(id.to_owned()));
            }
            row.work.filter(|_| owned).map(|work| (work, row.cwd))
        };
        let _cleaning = Cleaning { inner: &self.inner, id };
        if let Some((work, worktree)) = work {
            // If what follows fails, the row still names the worktree that is gone, and `resume` refuses it.
            self.inner.setup.remove(&work, &worktree).await?;
        }
        self.inner.with_store(|store| store.clean_up(id))
    }

    /// The stored events after `after`. A read writes nothing: the sweep runs on its timer.
    pub fn events(&self, id: &str, after: u64) -> Result<Vec<Event>> {
        Ok(self.events_page(id, after, u64::MAX, usize::MAX)?.0)
    }

    /// The stored events after `after`, until they would pass `budget` bytes as JSON, and whether more follow.
    pub fn events_page(&self, id: &str, after: u64, upto: u64, budget: usize) -> Result<(Vec<Event>, bool)> {
        self.inner.with_store(|store| {
            store.session(id)?;
            store.events_page(id, after, upto, budget)
        })
    }

    /// The stored events after `after`, and, while the session runs, a receiver of every event from the moment of the
    /// read, which never falls behind. Both under the store's lock, which a session holds while it stores and sends an
    /// event, so an event is in one or the other and never both. A locked session's events come from the store
    /// withheld, and whole only to a receiver. The first page of them comes here, with whether more follow and the
    /// number of the last stored at that moment: the rest are for `events_page` up to that number, and every later
    /// event comes to the receiver, whole.
    pub fn watch(&self, id: &str, after: u64) -> Result<(Vec<Event>, bool, u64, Option<Feed>)> {
        let live = self.inner.live();
        self.inner.with_store(|store| {
            store.session(id)?;
            let receiver = live.get(id).map(|live| match live.locked {
                true => {
                    let (watcher, feed) = Feed::locked(self.inner.locked_backlog, self.inner.locked_backlog_bytes);
                    live.watchers.lock().unwrap_or_else(|p| p.into_inner()).push(watcher);
                    feed
                }
                false => Feed::Stored(live.events.subscribe()),
            });
            let upto = store.last_seq(id)?;
            let (page, more) = store.events_page(id, after, upto, crate::api::PAGE_BYTES)?;
            Ok((page, more, upto, receiver))
        })
    }

    pub fn subscribe(&self, id: &str) -> Result<broadcast::Receiver<Event>> {
        Ok(self.live(id)?.events.subscribe())
    }

    /// Where sessions take their environment, logins and clones from.
    pub fn setup(&self) -> &Arc<Setup> {
        &self.inner.setup
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
    /// Two receivers, both made before the task starts, so neither misses its first events. `taken_back` clears the
    /// hand-over mark once the agent has opened and before the task can end.
    fn start(
        &self,
        id: &str,
        watcher: Option<Watcher>,
        taken_back: bool,
        plan: impl FnOnce(&Store) -> Result<Plan>,
    ) -> Result<(broadcast::Receiver<Event>, broadcast::Receiver<Event>)> {
        let token = Secret::random();
        let secrets = vec![token.expose().to_owned()];
        let (events, receiver) = broadcast::channel(1024);
        let second = events.subscribe();
        let (requests, requests_rx) = mpsc::unbounded_channel();
        let (calls, calls_rx) = mpsc::unbounded_channel();
        let start = self.inner.starts.fetch_add(1, Ordering::Relaxed);
        let open = Arc::new(Mutex::new(HashMap::new()));
        let stopping = Arc::new(AtomicBool::new(false));
        let questions = Arc::new(Mutex::new(HashSet::new()));
        let watchers = Arc::new(Mutex::new(watcher.into_iter().collect()));
        let stuck = Arc::new(AtomicBool::new(false));
        let endpoints = self.inner.endpoints()?;
        #[cfg(test)]
        self.inner.hooks.before_reserve();
        let Plan { driver, provider, cwd, locked, model, login, effort, resume, notices, endpoint, tools, result_schema } = {
            let mut live = self.inner.live();
            if self.inner.closing.load(Ordering::Relaxed) {
                return Err(Error::ShutDown);
            }
            if live.contains_key(id) || self.inner.cleaning.lock().unwrap_or_else(|p| p.into_inner()).contains(id) {
                return Err(Error::Running(id.to_owned()));
            }
            let plan = self.inner.with_store(plan)?;
            // A question asked before the last stop of the harness is still open.
            if let Some(asked) = self.inner.with_store(|store| store.open_question(id))? {
                questions.lock().unwrap_or_else(|p| p.into_inner()).insert(asked);
            }
            let entry = Live {
                requests,
                events: events.clone(),
                start,
                open: open.clone(),
                stopping: stopping.clone(),
                questions: questions.clone(),
                watchers: watchers.clone(),
                locked: plan.locked,
                stuck: stuck.clone(),
                endpoint: plan.endpoint.clone(),
            };
            live.insert(id.to_owned(), entry);
            plan
        };
        // Freed again if the driver fails to open, or panics.
        let reserved = Reserved { inner: &self.inner, id, start, kept: false };
        let tools = endpoints.register(&endpoint, (id, start), &token, (tools, result_schema.clone()), calls, &provider);
        let env = agent_env(self.inner.setup.agent_env(&provider, login.as_deref())?.into_pairs());
        let schema = result_schema.clone();
        let launch = Launch { cwd, locked, model, login, effort, resume, tools_token: token, tools, result_schema, env };
        let caps = driver.capabilities();
        // A first start that fails keeps its row's work: the caller discards the worktree, and if that fails, the
        // failed session's own clean-up removes it, as the owner while no session that ran names it.
        let link = driver.open(launch).map_err(|OpenError { kind, message }| Error::Open { kind, message: redact::text(&message, &secrets) })?;
        // While the session is still taken: a take-back that failed to open keeps the mark, and a later hand over's
        // mark is never cleared by this one.
        if taken_back {
            self.inner.with_store(|store| store.set_handed_over(id, false))?;
        }
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
            stuck,
            endpoint,
            result_schema: schema,
            broken: AtomicBool::new(false),
        };
        for text in notices {
            task.emit(Body::Notice { text });
        }
        tokio::spawn(task.run(link, caps, requests_rx, calls_rx));
        #[cfg(test)]
        self.inner.hooks.after_spawn(id);
        Ok((receiver, second))
    }
}

/// The environment an agent gets: the harness's own, without a client token.
pub fn agent_env(vars: impl Iterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    vars.filter(|(name, _)| name != crate::cli::TOKEN_VARIABLE).collect()
}

/// What a start opens.
struct Plan {
    driver: Arc<dyn Driver>,
    provider: String,
    cwd: PathBuf,
    locked: bool,
    model: Option<String>,
    login: Option<String>,
    effort: Option<String>,
    resume: Option<String>,
    endpoint: String,
    tools: Vec<ToolSpec>,
    result_schema: Option<Value>,
    notices: Vec<String>,
}

/// A session's place in `cleaning`, given up however its clean-up ends.
struct Cleaning<'a> {
    inner: &'a Inner,
    id: &'a str,
}

impl Drop for Cleaning<'_> {
    fn drop(&mut self) {
        self.inner.cleaning.lock().unwrap_or_else(|p| p.into_inner()).remove(self.id);
    }
}

/// A start's tools endpoint, forgotten however its task ends.
struct Serving {
    inner: Arc<Inner>,
    name: String,
    start: u64,
}

impl Drop for Serving {
    fn drop(&mut self) {
        self.inner.forget_endpoint(&self.name, self.start);
    }
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

    /// Removes the session's live entry if it is still this start's, and stops serving its tools endpoint.
    fn forget(&self, id: &str, start: u64) {
        let mut live = self.live();
        if let Some(entry) = live.get(id).filter(|entry| entry.start == start) {
            self.forget_endpoint(&entry.endpoint, start);
            live.remove(id);
            self.left.notify_waiters();
        }
    }

    fn forget_endpoint(&self, name: &str, start: u64) {
        if let Some(endpoints) = self.endpoints.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            endpoints.forget(name, start);
        }
    }

    /// The tools endpoint, bound on first use.
    fn endpoints(&self) -> Result<Arc<Endpoints>> {
        let mut endpoints = self.endpoints.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(endpoints) = endpoints.as_ref() {
            return Ok(endpoints.clone());
        }
        let bound = Arc::new(Endpoints::bind(self.tool_calls)?);
        *endpoints = Some(bound.clone());
        Ok(bound)
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
    watchers: Arc<Mutex<Vec<Watcher>>>,
    stuck: Arc<AtomicBool>,
    endpoint: String,
    /// What a result must fit: checked again here when masking changed it.
    result_schema: Option<Value>,
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
        // A task that panics still stops serving its endpoint, so its token stops working.
        let _serving = Serving { inner: self.inner.clone(), name: self.endpoint.clone(), start: self.start };
        let turns = self.inner.turns.clone();
        let mut queued: VecDeque<String> = VecDeque::new();
        let mut turn = Turn::Idle;
        let mut slot: Option<Slot> = None;
        let mut waiting: Option<oneshot::Receiver<()>> = None;
        let mut held_calls: HashMap<String, oneshot::Sender<Reply>> = HashMap::new();
        // The `ask` call held for the open question, and when it must return by.
        let mut held_ask: Option<(String, oneshot::Sender<Reply>)> = None;
        let (ask_cut, mut ask_cuts) = mpsc::unbounded_channel::<String>();
        let (cut, mut cuts) = mpsc::unbounded_channel::<String>();
        let mut calls_open = true;
        // "Carry on" waiting to be sent, and whether the store says it may not be.
        let mut carry_on: Option<String> = None;
        let mut blocked = self.inner.with_store(|store| store.session(&self.id)).is_ok_and(|row| row.no_carry_on.is_some());
        let stopped = 'run: loop {
            if self.broken.load(Ordering::Relaxed) {
                break true;
            }
            // Once Stop is taken, no prompt reaches the agent.
            let stopping = self.stopping.load(Ordering::Relaxed);
            // Checked and queued in one step of this task, which alone opens questions and permission requests.
            if turn == Turn::Idle && waiting.is_none() && queued.is_empty() && !stopping
                && let Some(text) = carry_on.take()
            {
                let open = self.questions.lock().unwrap_or_else(|p| p.into_inner()).iter().next().cloned();
                match open.or_else(|| self.open_requests().keys().next().cloned()) {
                    Some(open) => {
                        self.emit(Body::Notice { text: format!("\"carry on\" was not sent: {open} is open") });
                    }
                    None if blocked => {
                        self.emit(Body::Notice { text: "\"carry on\" was not sent: the session may not carry on".into() });
                    }
                    None => queued.push_back(text),
                }
            }
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
                        // A turn after the one that forbade it: "carry on" may follow this one.
                        if blocked && !self.forbid_carry_on(None, &mut blocked) {
                            break 'run true;
                        }
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
                        let asked = redact::body(Body::Permission { id: id.clone(), kind, tool, input }, &self.secrets);
                        match crate::event::fit(asked, crate::event::EVENT_MAX) {
                            (body @ Body::Withheld { .. }, cut) => {
                                // Too large to show even cut, so no one could answer it: denied at once, and said so.
                                let message = Some("the request was too large for the harness to show, so it was denied".to_owned());
                                if self.keep(body, cut) && self.emit(Body::Answered { id, decision: Decision::Deny, message: message.clone() }) {
                                    let _ = link.commands.send(Command::Answer { id: driver_id, decision: Decision::Deny, message });
                                }
                            }
                            (body, cut) => {
                                self.open_requests().insert(id, OpenRequest { driver_id, answered: false, cut: cut.is_some() });
                                self.keep(body, cut);
                            }
                        }
                    }
                    Some(question @ Body::Question { .. }) => {
                        // The id the client sees, after redaction, is the one its answer names.
                        let question = redact::body(question, &self.secrets);
                        if let Body::Question { id, .. } = &question {
                            self.questions.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone());
                        }
                        self.emit(question);
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
                        let denied = body == Body::TurnEnded { how: TurnEnd::Denied };
                        self.emit(body);
                        if denied {
                            self.close_questions(QuestionEnd::Denied, &mut held_ask);
                            self.forbid_carry_on(Some("a deny ended its last turn"), &mut blocked);
                        }
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
                    Some(ToolCall { name, input, reply, .. }) if name == RESULT => {
                        let _ = reply.send(self.result(input));
                    }
                    Some(ToolCall { name, input, reply, arrived }) if name == ASK => {
                        #[cfg(test)]
                        self.inner.hooks.before_ask();
                        if let Some(id) = self.ask(input, reply, &mut held_ask) {
                            let wait = caps.tool_call_limit_ms.map_or(crate::ask::ASK_WAIT, |limit| {
                                let limit = Duration::from_millis(limit);
                                crate::ask::ASK_WAIT.min(limit - ASK_MARGIN.min(limit / 4))
                            });
                            let ask_cut = ask_cut.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep_until(arrived + wait).await;
                                let _ = ask_cut.send(id);
                            });
                        }
                    }
                    Some(ToolCall { name, input, reply, arrived }) => {
                        let id = format!("c{}", random_hex(8));
                        let called = redact::body(Body::ClientToolCall { id: id.clone(), name, input }, &self.secrets);
                        let (called, cut_by) = crate::event::fit(called, crate::event::EVENT_MAX);
                        let oversize = cut_by.is_some() || matches!(called, Body::Withheld { .. });
                        // Unrecorded, the agent hears only that the session ended.
                        if !self.keep(called, cut_by) {
                            continue 'run;
                        }
                        // After the call is sent: sending it drops a locked session's client that fell behind.
                        let failed = match () {
                            _ if !self.client_present() => Some(CLIENT_AWAY.to_owned()),
                            _ if oversize => {
                                Some(format!("the call's input is over the {}-byte limit of an event, so the client could not see all of it", crate::event::EVENT_MAX))
                            }
                            _ => None,
                        };
                        if let Some(reason) = failed {
                            if self.emit(Body::ToolResult { id, output: json!(reason), error: true }) {
                                let _ = reply.send(Reply::failed(reason));
                            }
                            continue 'run;
                        }
                        held_calls.insert(id.clone(), reply);
                        if let Some(limit) = caps.tool_call_limit_ms {
                            let cut = cut.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep_until(arrived + Duration::from_millis(limit)).await;
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
                            let _ = reply.send(Reply::failed(reason));
                        }
                    }
                }
                Some(id) = ask_cuts.recv() => {
                    // The question stays open: its answer comes as the next prompt.
                    if let Some((_, reply)) = held_ask.take_if(|(held, _)| *held == id) {
                        let _ = reply.send(Reply { output: json!(QUESTION_PENDING), error: false });
                    }
                }
                request = requests.recv() => match request {
                    Some(Request::Prompt(text)) => queued.push_back(text),
                    Some(Request::AnswerAsk { question, text }) => {
                        if !self.close_question(&question, QuestionEnd::Answered) {
                            continue 'run;
                        }
                        match held_ask.take_if(|(held, _)| *held == question) {
                            Some((_, reply)) => {
                                let _ = reply.send(Reply { output: json!(text), error: false });
                            }
                            None => queued.push_front(text),
                        }
                    }
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
                            let _ = held.send(reply);
                        }
                    }
                    Some(Request::HandOver) => {
                        self.close_questions(QuestionEnd::HandedOver, &mut held_ask);
                        // Marked before it is said, so a resume never starts a session Terminal now holds.
                        match self.inner.with_store(|store| store.set_handed_over(&self.id, true)) {
                            Ok(()) => {
                                self.emit(Body::HandedOver);
                            }
                            Err(e) => self.store_failed(&e),
                        }
                        break 'run true;
                    }
                    Some(Request::Stop) => {
                        self.close_questions(QuestionEnd::Stopped, &mut held_ask);
                        self.forbid_carry_on(Some("it was stopped"), &mut blocked);
                        break 'run true;
                    }
                    Some(Request::CarryOn(text)) => carry_on = Some(text),
                    Some(Request::Shutdown) | None => break 'run true,
                },
            }
        };
        self.stopping.store(true, Ordering::Relaxed);
        if !blocked && !self.open_requests().is_empty() {
            self.forbid_carry_on(Some("a permission request was open when it stopped"), &mut blocked);
        }
        self.open_requests().clear();
        // `send` took these, so the client hears they never reached the agent: those queued here, and those still on
        // their way when the agent went.
        requests.close();
        let mut unsent = !queued.is_empty() || carry_on.is_some();
        while let Ok(request) = requests.try_recv() {
            unsent |= matches!(request, Request::Prompt(_) | Request::AnswerAsk { .. } | Request::CarryOn(_));
        }
        if unsent {
            self.emit(Body::PromptsDropped);
        }
        // No new call reaches the session now: an agent that waits for one while it stops hears that it ended.
        calls.close();
        while let Ok(ToolCall { reply, .. }) = calls.try_recv() {
            let _ = reply.send(Reply::failed(ENDED));
        }
        for (id, reply) in held_calls {
            self.emit(Body::ToolResult { id, output: json!(ENDED), error: true });
            let _ = reply.send(Reply::failed(ENDED));
        }
        if let Some((_, reply)) = held_ask.take() {
            let _ = reply.send(Reply::failed(ENDED));
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
        // Before `closed`, so a client that has seen it finds the token refused.
        self.inner.forget_endpoint(&self.endpoint, self.start);
        #[cfg(test)]
        self.inner.hooks.before_closed();
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
            self.stuck.store(true, Ordering::Relaxed);
            self.inner.left.notify_waiters();
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
    /// An id that is not kept is cleared in the same transaction that marks the row and records the `failed` that says
    /// so: `resume` reads the mark, which a locked session's withheld events or the sweep cannot take away.
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
        let failed = Body::Failed { kind: FailKind::Driver, reason: CANNOT_RESUME.to_owned() };
        let store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match store.as_ref().ok_or(Error::ShutDown).and_then(|store| store.refuse_resume(&self.id, &failed, now_ms())) {
            Ok(event) => self.publish(event),
            Err(e) => {
                drop(store);
                self.store_failed(&e);
            }
        }
        false
    }

    /// Puts up the agent's question, kept in the store and said in a `question` event, and gives its id for the call to
    /// be held. A question while one is open, or one that is empty or too long, is refused at once, with no event.
    fn ask(&self, input: Value, reply: oneshot::Sender<Reply>, held: &mut Option<(String, oneshot::Sender<Reply>)>) -> Option<String> {
        let refused = match input["question"].as_str().map(str::trim).filter(|text| !text.is_empty()) {
            None => Err("question: required, what you need decided or answered".to_owned()),
            Some(text) if text.chars().count() > QUESTION_CHARS => Err(format!("a question is at most {QUESTION_CHARS} characters")),
            Some(text) => match self.questions.lock().unwrap_or_else(|p| p.into_inner()).iter().next() {
                Some(open) => Err(format!("question {open} is open: wait for its answer, or end your turn; its answer comes as your next prompt")),
                None => Ok(text.to_owned()),
            },
        };
        let text = match refused {
            Ok(text) => text,
            Err(why) => {
                let _ = reply.send(Reply::failed(why));
                return None;
            }
        };
        let id = format!("q{}", random_hex(8));
        if let Err(e) = self.inner.with_store(|store| store.ask(&self.id, &id, now_ms())) {
            self.store_failed(&e);
            let _ = reply.send(Reply::failed(ENDED));
            return None;
        }
        self.questions.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone());
        if !self.emit(Body::Question { id: id.clone(), text }) {
            let _ = reply.send(Reply::failed(ENDED));
            return None;
        }
        *held = Some((id.clone(), reply));
        Some(id)
    }

    /// Keeps why "carry on" may not be sent, or that it may again. False when the store could not take it.
    fn forbid_carry_on(&self, why: Option<&str>, blocked: &mut bool) -> bool {
        *blocked = why.is_some();
        match self.inner.with_store(|store| store.set_no_carry_on(&self.id, why)) {
            Ok(()) => true,
            Err(e) => {
                self.store_failed(&e);
                false
            }
        }
    }

    /// Closes a question: in the store, in the open set and in a `question_closed` event. False when the store could
    /// not take it, and the session stops.
    fn close_question(&self, id: &str, how: QuestionEnd) -> bool {
        self.questions.lock().unwrap_or_else(|p| p.into_inner()).remove(id);
        if let Err(e) = self.inner.with_store(|store| store.close_question(&self.id, id, how, now_ms())) {
            self.store_failed(&e);
            return false;
        }
        self.emit(Body::QuestionClosed { id: id.to_owned(), how })
    }

    /// Closes every open question, and tells a held `ask` call why.
    fn close_questions(&self, how: QuestionEnd, held: &mut Option<(String, oneshot::Sender<Reply>)>) {
        let open: Vec<String> = self.questions.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect();
        for id in open {
            self.close_question(&id, how);
        }
        if let Some((_, reply)) = held.take() {
            let _ = reply.send(Reply::failed(format!("the question was closed: {}", serde_json::to_value(how).ok().and_then(|how| how.as_str().map(str::to_owned)).unwrap_or_default())));
        }
    }

    /// Takes the agent's result, which the endpoint has checked against the schema: a `result` event, unless a question
    /// is open, or the result is too large to keep whole. A result that could not be recorded is not taken.
    fn result(&self, data: Value) -> Reply {
        let open: Vec<String> = self.questions.lock().unwrap_or_else(|p| p.into_inner()).iter().cloned().collect();
        if !open.is_empty() {
            return Reply::failed(format!("a question is open ({}): wait for its answer, then give your result", open.join(", ")));
        }
        let masked = redact::body(Body::Result { data: data.clone() }, &self.secrets);
        if let (Body::Result { data: shown }, Some(schema)) = (&masked, &self.result_schema)
            && *shown != data
        {
            let misfits = crate::schema::misfits(schema, shown);
            if !misfits.is_empty() {
                let why = misfits.join("; ");
                return Reply::failed(format!("parts of the result look like secrets and were masked, and masked it does not fit its schema, so it was not taken: {why}"));
            }
        }
        let (body, cut) = crate::event::fit(masked, crate::event::EVENT_MAX);
        if cut.is_some() {
            return Reply::failed(format!("the result is over the {}-byte limit of an event, so it was not taken: give a shorter one", crate::event::EVENT_MAX));
        }
        match self.keep(body, None) {
            true => Reply { output: json!("the result was recorded"), error: false },
            false => Reply::failed(ENDED),
        }
    }

    /// Someone listens to the session's events and can answer its calls: a client that watches it, or the one that
    /// opened it in-process.
    fn client_present(&self) -> bool {
        self.events.receiver_count() > 0 || self.watchers.lock().unwrap_or_else(|p| p.into_inner()).iter().any(|watcher| !watcher.events.is_closed())
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
        // Cut after redaction, so a secret cut in half is masked whole first.
        let (body, cut) = crate::event::fit(redact::body(body, &self.secrets), crate::event::EVENT_MAX);
        self.keep(body, cut)
    }

    /// `emit` for a body already redacted and fitted.
    fn keep(&self, body: Body, cut: Option<u64>) -> bool {
        if self.broken.load(Ordering::Relaxed) {
            if body == Body::Closed {
                self.publish(Event { seq: 0, ms: now_ms(), body, cut: None });
            }
            return false;
        }
        // Stored and sent under the store's lock, as `watch` reads and registers under it: a client's read and its live
        // events never overlap, so a locked session's whole event is never taken for the withheld copy the read gave.
        let store = self.inner.store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match store.as_ref().ok_or(Error::ShutDown).and_then(|store| store.append_cut(&self.id, &body, now_ms(), cut)) {
            Ok(event) => {
                #[cfg(test)]
                self.inner.hooks.before_publish();
                self.publish(event);
                true
            }
            Err(e) => {
                drop(store);
                self.store_failed(&e);
                if body == Body::Closed {
                    self.publish(Event { seq: 0, ms: now_ms(), body, cut: None });
                }
                false
            }
        }
    }

    /// Sends the event to the session's clients. A watcher that has gone is dropped, and so is one past its backlog,
    /// which is marked as having lost events.
    fn publish(&self, event: Event) {
        let mut watchers = self.watchers.lock().unwrap_or_else(|p| p.into_inner());
        if !watchers.is_empty() {
            let size = serde_json::to_string(&event).map_or(0, |text| text.len());
            watchers.retain(|watcher| {
                if watcher.bytes.load(Ordering::Relaxed) + size > watcher.most {
                    watcher.lost.store(true, Ordering::Relaxed);
                    return false;
                }
                match watcher.events.try_send((event.clone(), size)) {
                    Ok(()) => {
                        watcher.bytes.fetch_add(size, Ordering::Relaxed);
                        true
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        watcher.lost.store(true, Ordering::Relaxed);
                        false
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => false,
                }
            });
        }
        drop(watchers);
        let _ = self.events.send(event);
    }

    /// Breaks the session on a store that failed: its clients get one `failed`, numbered 0, and it stops.
    fn store_failed(&self, e: &Error) {
        eprintln!("harness: session {}: {e}", self.id);
        if !self.broken.swap(true, Ordering::Relaxed) {
            let reason = format!("the store could not keep this session's events, so it stops: {e}");
            let body = Body::Failed { kind: FailKind::Harness, reason };
                    self.publish(Event { seq: 0, ms: now_ms(), body, cut: None });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::{Mock, Script};

    type Hook = Box<dyn FnOnce() + Send>;
    type IdHook = Box<dyn FnOnce(&str) + Send>;

    /// Moments a test can act at, each set on one harness so tests that run at the same time never take each other's.
    /// Each runs once.
    #[derive(Default)]
    pub(super) struct Hooks {
        /// Just before a task records its `closed`.
        before_closed: Mutex<Option<Hook>>,
        /// Told when a start is about to take the session's lock to reserve it.
        before_reserve: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        /// Just after a session's task is spawned, with its id.
        after_spawn: Mutex<Option<IdHook>>,
        /// Just after an event is stored and before it is sent.
        before_publish: Mutex<Option<Hook>>,
        /// Just after a stop has taken the session's stop flag, before it sends its request.
        after_stop_flag: Mutex<Option<Hook>>,
        /// Just after `shutdown` has told the sessions to stop.
        after_shutdown_stops: Mutex<Option<Hook>>,
        /// Just as the session takes an `ask` call off the endpoint.
        before_ask: Mutex<Option<Hook>>,
    }

    fn take<T>(slot: &Mutex<Option<T>>) -> Option<T> {
        slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    }

    fn set<T>(slot: &Mutex<Option<T>>, hook: T) {
        *slot.lock().unwrap() = Some(hook);
    }

    impl Hooks {
        pub(super) fn before_ask(&self) {
            if let Some(hook) = take(&self.before_ask) {
                hook();
            }
        }

        pub(super) fn before_closed(&self) {
            if let Some(hook) = take(&self.before_closed) {
                hook();
            }
        }

        pub(super) fn before_reserve(&self) {
            if let Some(reached) = take(&self.before_reserve) {
                let _ = reached.send(());
            }
        }

        pub(super) fn after_spawn(&self, id: &str) {
            if let Some(hook) = take(&self.after_spawn) {
                hook(id);
            }
        }

        pub(super) fn before_publish(&self) {
            if let Some(hook) = take(&self.before_publish) {
                hook();
            }
        }

        pub(super) fn after_stop_flag(&self) {
            if let Some(hook) = take(&self.after_stop_flag) {
                hook();
            }
        }

        pub(super) fn after_shutdown_stops(&self) {
            if let Some(hook) = take(&self.after_shutdown_stops) {
                hook();
            }
        }
    }

    /// Holds a session's start until its first event is stored, and says whether it was within the time given.
    fn hold_start_until_an_event(harness: &Harness) -> Arc<AtomicBool> {
        let (seen, reading) = (Arc::new(AtomicBool::new(false)), harness.clone());
        let kept = seen.clone();
        set(&harness.inner.hooks.after_spawn, Box::new(move |id: &str| {
            let given = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < given {
                if reading.events(id, 0).is_ok_and(|events| !events.is_empty()) {
                    kept.store(true, Ordering::Relaxed);
                    return;
                }
                std::thread::yield_now();
            }
        }) as IdHook);
        seen
    }

    fn starts_and_closes(harness: &Harness, id: &str) -> Vec<String> {
        let events = harness.events(id, 0).unwrap_or_default();
        events.into_iter().map(|event| event.body.type_name()).filter(|kind| kind == "started" || kind == "closed").collect()
    }

    /// A driver the test speaks for: it keeps each start's output, records every command, and goes on a stop.
    #[derive(Clone, Default)]
    struct Hand {
        output: Arc<Mutex<Option<mpsc::UnboundedSender<Body>>>>,
        commands: Arc<Mutex<Vec<Command>>>,
    }

    impl Driver for Hand {
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }

        fn open(&self, launch: Launch) -> std::result::Result<Link, OpenError> {
            let (commands, mut received) = mpsc::unbounded_channel();
            let (output, receiver) = mpsc::unbounded_channel();
            output.send(Body::Started { provider_session: "hand".into(), resumed: launch.resume.is_some() }).unwrap();
            *self.output.lock().unwrap() = Some(output);
            let (kept, seen) = (self.output.clone(), self.commands.clone());
            tokio::spawn(async move {
                while let Some(command) = received.recv().await {
                    let stop = matches!(command, Command::Stop | Command::Kill);
                    seen.lock().unwrap().push(command);
                    if stop {
                        kept.lock().unwrap().take();
                        return;
                    }
                }
            });
            Ok(Link { commands, output: receiver })
        }
    }

    #[tokio::test]
    async fn carry_on_a_question_between_the_check_and_the_send_stops_it() {
        for raised in [Body::Question { id: "q9".into(), text: "which?".into() }, Body::Permission { id: "x".into(), kind: crate::event::PermissionKind::Command, tool: "Bash".into(), input: json!({}) }] {
            let tmp = tempfile::tempdir().unwrap();
            let hand = Hand::default();
            let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("hand".into(), Arc::new(hand.clone()))];
            let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
            let (id, mut events) = harness.open(Open { provider: "hand".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
            events.recv().await.unwrap();
            assert!(harness.shutdown().await.is_empty());
            drop(harness);
            // The lock outlives the shutdown by a moment while the session's task ends.
            let given = std::time::Instant::now() + Duration::from_secs(10);
            let store = loop {
                match Store::open(&tmp.path().join("data")) {
                    Err(Error::InUse(_)) if std::time::Instant::now() < given => tokio::time::sleep(Duration::from_millis(10)).await,
                    opened => break opened.unwrap(),
                }
            };
            let harness = Harness::new(store, vec![("hand".into(), Arc::new(hand.clone()) as Arc<dyn Driver>)], Settings::default());
            // The agent raises it after the resume's check passed, and before "carry on" is sent.
            let speaking = hand.output.clone();
            let body = raised.clone();
            set(&harness.inner.hooks.after_spawn, Box::new(move |_: &str| {
                speaking.lock().unwrap().as_ref().unwrap().send(body).ok();
            }) as IdHook);
            let mut events = harness.resume_with(&id, Some("carry on".into())).await.unwrap();
            let said = loop {
                let event = tokio::time::timeout(Duration::from_secs(10), events.recv()).await.expect("an event").unwrap();
                if let Body::Notice { text } = event.body {
                    break text;
                }
            };
            assert!(said.starts_with("\"carry on\" was not sent"), "{said}");
            assert!(!hand.commands.lock().unwrap().iter().any(|command| matches!(command, Command::Prompt(_))), "{raised:?}: nothing was sent");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ask_the_early_return_is_measured_from_the_calls_start_not_from_when_the_session_took_it() {
        let tmp = tempfile::tempdir().unwrap();
        let limit = 3000;
        let script = format!("{{\"capabilities\": {{\"tool_call_limit_ms\": {limit}}}}}\n{{\"prompt\": null}}\n{{\"call\": {{\"name\": \"ask\", \"input\": {{\"question\": \"q?\"}}}}}}\n{{\"end\": \"done\"}}\n{{\"prompt\": null}}");
        let mock = Mock::new(Script::parse(&script).unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let (id, mut events) = harness.open(Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
        let Ok(Event { body: Body::Started { provider_session, .. }, .. }) = events.recv().await else { panic!("started first") };
        // The session takes the call half the limit after it reached the endpoint, as when it is busy.
        set(&harness.inner.hooks.before_ask, Box::new(|| std::thread::sleep(Duration::from_millis(1500))) as Hook);
        let sent = std::time::Instant::now();
        harness.send(&id, "go").unwrap();
        while events.recv().await.is_ok_and(|event| !matches!(event.body, Body::TurnEnded { .. })) {}
        assert_eq!(mock.replies(&provider_session), [Ok(Reply { output: json!(QUESTION_PENDING), error: false })]);
        // From the session's own moment it would return at 1500 + 2250 ms, past the limit.
        assert!(sent.elapsed() < Duration::from_millis(limit), "returned before the limit, from the call's start: {:?}", sent.elapsed());
    }

    #[tokio::test]
    async fn tools_endpoint_a_session_task_that_panics_stops_serving_its_endpoint() {
        let tmp = tempfile::tempdir().unwrap();
        let mock = Mock::new(Script::parse("{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let (id, mut events) = harness.open(Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
        events.recv().await.unwrap();
        let name = harness.inner.live().get(&id).unwrap().endpoint.clone();
        let endpoints = harness.inner.endpoints().unwrap();
        assert!(endpoints.serves(&name));
        set(&harness.inner.hooks.before_publish, Box::new(|| -> () { panic!("the test's panic in the session task") }) as Hook);
        harness.send(&id, "go").unwrap();
        let given = std::time::Instant::now() + Duration::from_secs(10);
        while endpoints.serves(&name) && std::time::Instant::now() < given {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(!endpoints.serves(&name), "the endpoint of a task that panicked is forgotten");
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
        let hooks = harness.clone();
        set(&harness.inner.hooks.before_closed, Box::new(move || {
            // A client resumes from another thread at this moment. The hook waits until the resume has reached its
            // reservation, then gives its start a bounded time to record `started`: it can only if the lock this
            // task holds does not guard the reservation.
            let (reached, reaches) = std::sync::mpsc::channel();
            set(&hooks.inner.hooks.before_reserve, reached);
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
        }) as Hook);
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
        // The script waits for a second prompt, so the test can make a live event after the watch's read.
        let mock = Mock::new(Script::parse("{\"prompt\": null}\n{\"say\": \"x\"}\n{\"end\": \"done\"}\n{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let spec = Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), ..Open::default() };
        let (id, mut events) = harness.open(spec).await.unwrap();
        events.recv().await.unwrap();
        let (watching, id_for_hook) = (harness.clone(), id.clone());
        let watched: Arc<Mutex<Option<std::thread::JoinHandle<_>>>> = Arc::default();
        let kept = watched.clone();
        set(&harness.inner.hooks.before_publish, Box::new(move || {
            // A client watches from another thread at this moment. The hook gives it a bounded time to read: it can
            // only if the session does not hold the store's lock while it sends.
            let (done, finished) = std::sync::mpsc::channel();
            *kept.lock().unwrap() = Some(std::thread::spawn(move || {
                let watch = watching.watch(&id_for_hook, 0).unwrap();
                let _ = done.send(());
                watch
            }));
            let _ = finished.recv_timeout(Duration::from_millis(500));
        }) as Hook);
        harness.send(&id, "go").unwrap();
        while events.recv().await.is_ok_and(|event| event.body != Body::TurnStarted) {}
        let handle = watched.lock().unwrap().take().expect("the hook ran");
        let (stored, _, _, receiver) = handle.join().unwrap();
        let Some(Feed::Locked { events: mut receiver, .. }) = receiver else { panic!("a locked session's feed") };
        let last = stored.last().map_or(0, |event| event.seq);
        harness.send(&id, "again").unwrap();
        let (first_live, _) = tokio::time::timeout(Duration::from_secs(10), receiver.recv()).await.expect("a live event").unwrap();
        assert!(first_live.seq == last + 1, "the read ends at {last}, the live events start at {}", first_live.seq);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn events_an_unlocked_sessions_feed_has_the_events_published_before_open_returns() {
        let tmp = tempfile::tempdir().unwrap();
        let mock = Mock::new(Script::parse("{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let seen = hold_start_until_an_event(&harness);
        let (_, _, feed) = harness.open_watched(Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() }).unwrap();
        assert!(seen.load(Ordering::Relaxed), "the session published its `started` before `open_watched` returned");
        let Feed::Stored(mut events) = feed else { panic!("an unlocked session's feed") };
        let first = tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap().unwrap();
        assert!(first.seq == 1 && matches!(first.body, Body::Started { .. }), "{first:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn events_a_sessions_open_receiver_has_the_events_published_before_open_returns() {
        let tmp = tempfile::tempdir().unwrap();
        let mock = Mock::new(Script::parse("{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let seen = hold_start_until_an_event(&harness);
        let (_, mut events) = harness.open(Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
        assert!(seen.load(Ordering::Relaxed), "the session published its `started` before `open` returned");
        let first = tokio::time::timeout(Duration::from_secs(10), events.recv()).await.unwrap().unwrap();
        assert!(first.seq == 1 && matches!(first.body, Body::Started { .. }), "{first:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hand_over_a_take_back_clears_the_mark_before_the_session_can_end() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        let mock = Mock::new(Script::parse("{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&dir).unwrap(), drivers, Settings::default());
        let (id, mut events) = harness.open(Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
        harness.hand_over(&id).unwrap();
        while events.recv().await.is_ok_and(|event| event.body != Body::Closed) {}
        // What the row says the moment the task exists: from then on it could end and be handed over again.
        let seen: Arc<Mutex<Option<bool>>> = Arc::default();
        let (kept, file) = (seen.clone(), dir.join("harness.sqlite"));
        set(&harness.inner.hooks.after_spawn, Box::new(move |id: &str| {
            let raw = rusqlite::Connection::open(&file).unwrap();
            let marked: bool = raw.query_row("SELECT handed_over FROM sessions WHERE id = ?1", [id], |row| row.get(0)).unwrap();
            *kept.lock().unwrap() = Some(marked);
        }) as IdHook);
        harness.take_back(&id).await.unwrap();
        assert_eq!(*seen.lock().unwrap(), Some(false), "cleared before the task was spawned");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hand_over_one_that_took_the_stop_is_not_overtaken_by_a_shutdown() {
        let tmp = tempfile::tempdir().unwrap();
        let mock = Mock::new(Script::parse("{\"prompt\": null}").unwrap());
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock))];
        let harness = Harness::new(Store::open(&tmp.path().join("data")).unwrap(), drivers, Settings::default());
        let (id, mut events) = harness.open(Open { provider: "mock".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
        events.recv().await.unwrap();
        let (stops_sent, stopped) = std::sync::mpsc::channel();
        set(&harness.inner.hooks.after_shutdown_stops, Box::new(move || {
            let _ = stops_sent.send(());
        }) as Hook);
        // A shutdown runs from another thread between the hand over's flag and its request, and tells the sessions to
        // stop before the hand over's request is sent.
        let (shutting, worker) = (harness.clone(), Arc::new(Mutex::new(None)));
        let kept = worker.clone();
        set(&harness.inner.hooks.after_stop_flag, Box::new(move || {
            *kept.lock().unwrap() = Some(std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(shutting.shutdown())
            }));
            stopped.recv_timeout(Duration::from_secs(10)).expect("the shutdown told the sessions to stop");
        }) as Hook);
        harness.hand_over(&id).unwrap();
        let mut seen = vec![];
        while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_secs(10), events.recv()).await {
            let closed = event.body == Body::Closed;
            seen.push(event.body);
            if closed {
                break;
            }
        }
        assert!(seen.contains(&Body::HandedOver), "the hand over took effect: {seen:?}");
        let left = worker.lock().unwrap().take().expect("the hook ran").join().unwrap();
        assert!(left.is_empty());
    }
}
