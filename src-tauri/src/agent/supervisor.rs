//! The supervisor, a waker: it wakes Pip in a workstream when one of the workstream's runs reaches a state that needs
//! Pip, and starts nothing.
//!
//! It hears about runs from the run tracker (`RunNotifier::notify`, called while `RunService.launching` is held, so it
//! only ever spawns) and from its own periodic sweep, which catches what the tracker never says: a run stopped from
//! outside Gossamr, a run finishing again after a continuation that drafted nothing, a run that finished while the
//! workstream was paused. A run the person or Pip stopped wakes nobody.
//!
//! A wake is Pip's ordinary turn in the workstream's conversation, asked with a prompt Rust writes from ids, roles,
//! states and counts only (`event_line`), never an agent's words. Each `(workstream, run, state)` wakes
//! Pip at most once: it is recorded as a `wake` line in the workstream's audit, which is also what a restart rebuilds
//! from. A paused workstream gets no wakes. Too many wakes pause it (`Core::admit_wake`). A wake the subscription
//! refused, or that couldn't start, gives its facts back and holds the workstream's wakes off for a backoff; the sweep
//! then wakes Pip for them again.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{AgentEvent, AgentService, Update, WakeSink, REMOVED, WAKE_NOT_STARTED, WAKE_PAUSED};
use crate::auth::Scope;
use crate::domain::{Actor, Origin, ProposalQuery, Role, Run, RunState, StateKind, Workstream, WorkstreamEvent};
use crate::error::{Error, Result};
use crate::inbox::Core;
use crate::runs::tracker::{Attention, RunNotifier};
use crate::tracker::Connection;

/// How often the sweep looks over the runs of open workstreams.
pub const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// The first wait before Pip is woken again in a workstream where a wake hit the quota or couldn't start; each further
/// miss doubles it, up to `BACKOFF_MAX`.
pub const BACKOFF_FIRST: Duration = Duration::from_secs(60);
pub const BACKOFF_MAX: Duration = Duration::from_secs(60 * 60);

/// What Pip is asked in a wake turn, after the `[Event]` block that says what happened.
pub const WAKE_REQUEST: &str = "Nobody wrote this: Gossamr woke you because of the [Event] above. Read what you need, take the next \
     step the person asked for if one is due, tell the person in your reply about any agent you start, and reply in at most three short lines.";

/// What a run did that wakes Pip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WakeState {
    Done,
    Failed,
    Stopped,
    NeedsAnswer,
    NeedsPermission,
    SystemBlocked,
    /// A finished build's pull request was found after Pip was told it was still to come.
    PullRequest,
}

impl WakeState {
    pub fn as_str(self) -> &'static str {
        match self {
            WakeState::Done => "done",
            WakeState::Failed => "failed",
            WakeState::Stopped => "stopped",
            WakeState::NeedsAnswer => "needs_answer",
            WakeState::NeedsPermission => "needs_permission",
            WakeState::SystemBlocked => "system_blocked",
            WakeState::PullRequest => "pr_found",
        }
    }

    fn words(self) -> &'static str {
        match self {
            WakeState::Done => "Done",
            WakeState::Failed => "Failed",
            WakeState::Stopped => "Stopped",
            WakeState::NeedsAnswer => "Needs an answer",
            WakeState::NeedsPermission => "Needs permission",
            WakeState::SystemBlocked => "Blocked on sign-in",
            WakeState::PullRequest => "Pull request found",
        }
    }

    /// What the tracker's notice `why` about `run` means. Every finish with or without a draft is `Done`.
    pub fn of_attention(run: &Run, why: Attention) -> Self {
        match why {
            Attention::Needs => match run.state {
                RunState::NeedsPermission => WakeState::NeedsPermission,
                RunState::SystemBlocked => WakeState::SystemBlocked,
                _ => WakeState::NeedsAnswer,
            },
            Attention::Done => WakeState::Done,
            Attention::Failed => WakeState::Failed,
        }
    }

    /// A run at rest, or waiting on the person, as the sweep finds it; `None` while it is under way, or while it is
    /// stopped only to be woken with a message (a failed wake leaves the reason on
    /// the run, so that one is reported). A question asked while the workstream was paused is noticed this way once it is
    /// resumed, keyed by when it was asked.
    pub fn of_run(run: &Run) -> Option<Self> {
        match run.state {
            RunState::Done => Some(WakeState::Done),
            RunState::Failed => Some(WakeState::Failed),
            RunState::Stopped if run.unsent_answer.is_some() && run.error.is_none() => None,
            RunState::Stopped => Some(WakeState::Stopped),
            RunState::NeedsAnswer => Some(WakeState::NeedsAnswer),
            RunState::NeedsPermission => Some(WakeState::NeedsPermission),
            RunState::SystemBlocked => Some(WakeState::SystemBlocked),
            _ => None,
        }
    }
}

/// One thing that happened to a run, as Pip is told it: ids, roles, states and counts, nothing an agent
/// wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeFact {
    pub run: String,
    #[serde(alias = "kind")]
    pub role: Role,
    pub state: WakeState,
    /// The state part of the idempotency key: the state, and for one reached again after the person carried on, when.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mark: String,
    #[serde(default)]
    pub drafts: u32,
}

impl WakeFact {
    /// The fact `state` of `run` with no flags yet; its mark tells a finish after a continuation from the first one.
    pub fn new(run: &Run, state: WakeState) -> Self {
        WakeFact { run: run.id.clone(), role: run.spec.role.clone(), state, mark: mark(run, state), drafts: 0 }
    }

    /// The state part of `(workstream, run, state)`.
    pub fn key(&self) -> &str {
        if self.mark.is_empty() {
            self.state.as_str()
        } else {
            &self.mark
        }
    }
}

/// `done`, or `done@<when it was carried on>` for a run that finished again; a question is keyed by when it was asked.
fn mark(run: &Run, state: WakeState) -> String {
    let base = state.as_str();
    match state {
        WakeState::Done | WakeState::Stopped => match run.continued_at {
            Some(at) => format!("{base}@{}", at.timestamp()),
            None => base.to_string(),
        },
        WakeState::Failed | WakeState::PullRequest => base.to_string(),
        WakeState::NeedsAnswer | WakeState::NeedsPermission | WakeState::SystemBlocked => format!("{base}@{}", run.last_progress_at.timestamp()),
    }
}

/// What a wake turn is about: the facts for one workstream, merged while it waits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeFacts {
    pub workstream: String,
    pub facts: Vec<WakeFact>,
}

impl WakeFacts {
    /// Adds `other`'s facts that aren't here already.
    pub fn merge(&mut self, other: &WakeFacts) {
        for f in &other.facts {
            if !self.facts.iter().any(|g| g.run == f.run && g.key() == f.key()) {
                self.facts.push(f.clone());
            }
        }
    }
}

/// A run id as it may appear in a wake prompt: never anything `keys_in` would take for a ticket.
fn shown_id(id: &str) -> Option<&str> {
    let plain = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (plain && super::context::keys_in(id).is_empty()).then_some(id)
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `[Event] run abc12345 (triager) Done; 2 drafts`
fn fact_line(f: &WakeFact) -> String {
    let run = match shown_id(&f.run) {
        Some(id) => format!("run {id}"),
        None => "a run".to_string(),
    };
    let mut line = format!("[Event] {run} ({}) {}", f.role.as_str(), f.state.words());
    if f.drafts > 0 {
        line.push_str(&format!("; {}", plural(f.drafts, "draft", "drafts")));
    }
    line
}

/// The wake prompt's event lines, one per fact. Only ids, roles, states and counts.
pub fn event_line(facts: &WakeFacts) -> String {
    facts.facts.iter().map(fact_line).collect::<Vec<_>>().join("\n")
}

/// The `(run, key)` pairs of `facts`, as a wake turn keeps them.
pub fn fact_keys(facts: &WakeFacts) -> Vec<(String, String)> {
    facts.facts.iter().map(|f| (f.run.clone(), f.key().to_string())).collect()
}

/// What a wake turn is for, the same for any wake of the same facts.
pub fn wake_identity(facts: &WakeFacts) -> String {
    let mut keys: Vec<String> = fact_keys(facts).into_iter().map(|(run, key)| format!("{run}\0{key}")).collect();
    keys.sort();
    format!("{}\0{}", facts.workstream, keys.join("\0"))
}

/// Whether a turn ended because the person's subscription said no: a rate or usage limit, or sign-in trouble.
pub fn is_quota_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    [
        "rate limit",
        "rate-limit",
        "rate_limit",
        "usage limit",
        "too many requests",
        "429",
        "overloaded",
        "quota",
        "authentication",
        "unauthorized",
        "401",
        "invalid api key",
        "/login",
        "not logged in",
        "oauth token",
    ]
    .iter()
    .any(|p| m.contains(p))
}

/// The wait before the next retry after `current`: doubled, at most `BACKOFF_MAX`.
pub fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(BACKOFF_MAX)
}

/// The `(run, key)` facts the audit says Pip was woken for: each `wake` line, unless a later `wake_dropped` line took
/// it back because the wake never started.
pub fn woken_in(events: &[WorkstreamEvent]) -> HashSet<(String, String)> {
    let mut lines: Vec<&WorkstreamEvent> = events.iter().filter(|e| e.actor == Actor::Supervisor && matches!(e.action.as_str(), "wake" | "wake_dropped")).collect();
    lines.sort_by_key(|e| e.seq);
    let mut woken = HashSet::new();
    for e in lines {
        let (Some(run), Some(key)) = (&e.run_id, &e.detail) else { continue };
        if e.action == "wake" {
            woken.insert((run.clone(), key.clone()));
        } else {
            woken.remove(&(run.clone(), key.clone()));
        }
    }
    woken
}

/// Whether a wake turn that ended with `status` and `error` reached Pip, which is what the ceilings count: not one that
/// never started, or that the subscription refused.
pub fn reached_pip(status: &str, error: Option<&str>) -> bool {
    status != "queued" && !error.is_some_and(|e| e == WAKE_PAUSED || e == REMOVED || e == crate::db::NEVER_RAN || e.starts_with(WAKE_NOT_STARTED) || is_quota_error(e))
}

/// Whether the person or Pip stopped `run` since it last carried on.
fn stopped_on_purpose(events: &[WorkstreamEvent], run: &Run) -> bool {
    events.iter().any(|e| matches!(e.actor, Actor::Person | Actor::Pip) && e.action == "run_stopped" && e.run_id.as_deref() == Some(run.id.as_str()) && run.continued_at.is_none_or(|at| e.at >= at))
}

fn settling_after_resume(run: &Run, now: DateTime<Utc>) -> bool {
    run.error.is_none() && run.continued_at.is_some_and(|at| now.signed_duration_since(at).to_std().map_or(true, |age| age < SWEEP_EVERY * 2))
}

/// Tells every notifier in turn: today's notices and the supervisor.
pub struct FanoutNotifier(pub Vec<Arc<dyn RunNotifier>>);

impl RunNotifier for FanoutNotifier {
    fn notify(&self, run: &Run, why: Attention) {
        for n in &self.0 {
            n.notify(run, why);
        }
    }

    fn announce(&self, notice: &crate::runs::notices::Outgoing) -> bool {
        // Every notifier is told; delivered only when none failed, so a failure is retried rather than lost.
        let mut delivered = true;
        for n in &self.0 {
            delivered &= n.announce(notice);
        }
        delivered
    }

    fn watching(&self) -> bool {
        self.0.iter().any(|n| n.watching())
    }
}

/// Sends a wake turn's events to the page, with the conversation they belong to.
pub type Emit = Arc<dyn Fn(&str, Update) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Quota {
    /// The wait the next miss starts.
    next: Duration,
    /// Whether a backoff is running.
    pending: bool,
}

pub struct Supervisor {
    core: Arc<Core>,
    /// Bound once the agent service exists, which is after the run service the supervisor listens to.
    agent: OnceLock<Weak<AgentService>>,
    me: Weak<Supervisor>,
    emit: Emit,
    /// Told the connection whenever a workstream was paused or its ticket drifted.
    changed: Arc<dyn Fn(&str) + Send + Sync>,
    /// One fact at a time, so a notice and a sweep about the same run can't both wake Pip.
    work: tokio::sync::Mutex<()>,
    /// `(workstream, run, state)` woken already; rebuilt from the audit's `wake` lines.
    seen: Mutex<HashSet<(String, String, String)>>,
    quota: Mutex<HashMap<String, Quota>>,
}

impl Supervisor {
    pub fn new(core: Arc<Core>, emit: Emit, changed: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        Arc::new_cyclic(|me| Supervisor { core, agent: OnceLock::new(), me: me.clone(), emit, changed, work: tokio::sync::Mutex::new(()), seen: Mutex::new(HashSet::new()), quota: Mutex::new(HashMap::new()) })
    }

    /// Lets the supervisor wake Pip. Until this is called every notice and sweep does nothing.
    pub fn bind(&self, agent: &Arc<AgentService>) {
        let _ = self.agent.set(Arc::downgrade(agent));
    }

    /// Pip's agent service, while it is alive.
    fn agent(&self) -> Option<Arc<AgentService>> {
        self.agent.get().and_then(Weak::upgrade)
    }

    /// Sweeps every `SWEEP_EVERY` for the life of the app.
    pub async fn run_sweeps(self: Arc<Self>) {
        loop {
            tokio::time::sleep(SWEEP_EVERY).await;
            self.sweep_at(Utc::now()).await;
        }
    }

    /// One sweep at `now`: every open workstream that isn't paused has its ticket checked for drift, and each linked
    /// run at rest that Pip wasn't woken for yet becomes a fact.
    pub async fn sweep_at(&self, now: DateTime<Utc>) {
        if self.agent().is_none() {
            return;
        }
        let Ok(scope) = self.core.scope().await else { return };
        let Ok(views) = self.core.workstreams(&scope, false).await else { return };
        for view in views {
            let ws = &view.workstream;
            if ws.paused_reason.is_some() {
                continue;
            }
            let Ok(runs) = self.linked(&scope, &ws.id).await else { continue };
            let Ok(events) = self.core.workstream_events(&scope, &ws.id).await else { continue };
            let woken = woken_in(&events);
            let is_new = |fact: &WakeFact| !woken.contains(&(fact.run.clone(), fact.key().to_string()));
            let mut facts = Vec::new();
            for run in &runs {
                let Some(state) = WakeState::of_run(run) else { continue };
                if state == WakeState::Stopped && (stopped_on_purpose(&events, run) || settling_after_resume(run, now)) {
                    continue;
                }
                if is_new(&WakeFact::new(run, state)) {
                    facts.push(self.fact_of(&scope, run, state).await);
                }
            }
            self.handle(&ws.id, facts, now).await;
        }
    }

    async fn linked(&self, scope: &Scope, ws: &str) -> Result<Vec<Run>> {
        self.core.runs_in(scope, &crate::domain::RunQuery { workstream: Some(ws.to_string()), ..Default::default() }).await
    }

    /// The fact `state` of `run` and how many drafts it left waiting.
    async fn fact_of(&self, scope: &Scope, run: &Run, state: WakeState) -> WakeFact {
        let mut fact = WakeFact::new(run, state);
        if state != WakeState::Done {
            return fact;
        }
        let open = ProposalQuery { states: Some(vec![StateKind::Pending]), workstream: run.spec.workstream.clone(), ..Default::default() };
        if let Ok(drafts) = self.core.proposals_in(scope, &open).await {
            fact.drafts = drafts.iter().filter(|p| matches!(&p.origin, Origin::Run { run_id, .. } if *run_id == run.id)).count() as u32;
        }
        fact
    }

    async fn on_run(self: Arc<Self>, run: Run, why: Attention) {
        let Some(ws) = run.spec.workstream.clone() else { return };
        let Ok(scope) = self.core.scope().await else { return };
        if Connection::jira_id(&scope) != run.connection_id {
            return;
        }
        let state = WakeState::of_attention(&run, why);
        let fact = self.fact_of(&scope, &run, state).await;
        self.handle(&ws, vec![fact], Utc::now()).await;
    }

    /// Whether `(ws, run, key)` was woken, from memory and the workstream's audit, where a later `wake_dropped` line
    /// takes a wake back.
    fn woken(&self, ws: &str, events: &[WorkstreamEvent]) -> HashSet<(String, String)> {
        let mut seen = self.seen.lock().expect("lock poisoned");
        for e in events.iter().filter(|e| e.actor == Actor::Supervisor && e.action == "wake_dropped") {
            if let (Some(run), Some(state)) = (&e.run_id, &e.detail) {
                seen.remove(&(ws.to_string(), run.clone(), state.clone()));
            }
        }
        for (run, state) in woken_in(events) {
            seen.insert((ws.to_string(), run, state));
        }
        seen.iter().filter(|(w, _, _)| w == ws).map(|(_, r, s)| (r.clone(), s.clone())).collect()
    }

    /// A wake that never ran (its workstream was paused or closed first, the quota refused it, or Pip couldn't start):
    /// its facts are taken back with a `wake_dropped` line each, so Pip is woken for them again.
    async fn unmark(&self, facts: WakeFacts) {
        let _one = self.work.lock().await;
        self.unmark_locked(facts).await;
    }

    async fn unmark_locked(&self, facts: WakeFacts) {
        let ws = facts.workstream.clone();
        {
            let mut seen = self.seen.lock().expect("lock poisoned");
            for f in &facts.facts {
                seen.remove(&(ws.clone(), f.run.clone(), f.key().to_string()));
            }
        }
        let Ok(scope) = self.core.scope().await else { return };
        for f in &facts.facts {
            self.record(&scope, WorkstreamEvent::new(&ws, Actor::Supervisor, "wake_dropped", Utc::now()).run(&f.run).detail(f.key())).await;
        }
    }

    /// Notes the ticket of `ws_id` drifting, then wakes Pip with the `facts` it wasn't woken for yet, unless the
    /// workstream is closed, paused or backing off.
    async fn handle(&self, ws_id: &str, facts: Vec<WakeFact>, now: DateTime<Utc>) {
        let _one = self.work.lock().await;
        let Some(agent) = self.agent() else { return };
        let Ok(scope) = self.core.scope().await else { return };
        let Ok(Some(view)) = self.core.workstream(&scope, ws_id).await else { return };
        let ws = view.workstream;
        if ws.closed_at.is_some() || ws.paused_reason.is_some() {
            return;
        }
        let connection = ws.connection_id.clone();
        match self.core.note_basis_drift(&scope, ws_id).await {
            Ok(true) => (self.changed)(&connection),
            Ok(false) => {}
            Err(e) => eprintln!("couldn't check the ticket of workstream {ws_id} for changes: {e}"),
        }
        if self.backing_off(ws_id) {
            return;
        }
        let Ok(runs) = self.linked(&scope, ws_id).await else { return };
        let Ok(events) = self.core.workstream_events(&scope, ws_id).await else { return };
        let woken = self.woken(ws_id, &events);
        let mut fresh: Vec<WakeFact> = Vec::new();
        for f in facts {
            let Some(run) = runs.iter().find(|run| run.id == f.run) else { continue };
            if Connection::jira_id(&scope) != run.connection_id
                || run.spec.workstream.as_deref() != Some(ws_id)
                || WakeState::of_run(run) != Some(f.state)
                || WakeFact::new(run, f.state).key() != f.key()
                || (f.state == WakeState::Stopped && (stopped_on_purpose(&events, run) || settling_after_resume(run, now)))
            {
                continue;
            }
            let seen = woken.contains(&(f.run.clone(), f.key().to_string()));
            if !seen && !fresh.iter().any(|g| g.run == f.run && g.key() == f.key()) {
                fresh.push(f);
            }
        }
        self.wake_for(&agent, &scope, &ws, fresh, now).await;
    }

    /// Wakes Pip in `ws_id` with `fresh`, unless the workstream has had its ceiling of wakes.
    async fn wake_for(&self, agent: &Arc<AgentService>, scope: &Scope, ws: &Workstream, fresh: Vec<WakeFact>, now: DateTime<Utc>) {
        if fresh.is_empty() {
            return;
        }
        let (ws_id, connection) = (ws.id.as_str(), ws.connection_id.as_str());
        let conversation = format!("{}{ws_id}", super::WORKSTREAM_PREFIX);
        let admitted = match self.core.admit_wake(scope, ws_id, &fresh, now).await {
            Ok(a) => a,
            Err(e) => {
                eprintln!("couldn't record a wake in workstream {ws_id}: {e}");
                return;
            }
        };
        if admitted.changed {
            (self.changed)(connection);
        }
        if admitted.facts.is_empty() {
            if admitted.changed {
                // Paused at its ceiling without a wake: one still waiting doesn't run either.
                agent.cancel_workstream_wakes(ws_id).await;
            }
            return;
        }
        {
            let mut seen = self.seen.lock().expect("lock poisoned");
            for f in &admitted.facts {
                seen.insert((ws_id.to_string(), f.run.clone(), f.key().to_string()));
            }
        }
        let facts = WakeFacts { workstream: ws_id.to_string(), facts: admitted.facts };
        if let Err(e) = agent.wake(ws_id, facts.clone(), self.sink(&conversation)).await {
            // A wake that failed to start was told through its sink, which takes the facts back. Any other error came
            // before the sink was ever called, so the facts go back here.
            if !matches!(&e, Error::Claude(m) if m.starts_with(WAKE_NOT_STARTED)) {
                self.unmark_locked(facts).await;
            }
            eprintln!("couldn't wake Pip in workstream {ws_id}: {e}");
        }
    }

    async fn record(&self, scope: &Scope, event: WorkstreamEvent) {
        let action = event.action.clone();
        if let Err(e) = self.core.record_workstream_event(scope, event).await {
            eprintln!("couldn't record {action} in a workstream: {e}");
        }
    }

    /// Where a wake turn's events go: to the page, marked as the workstream's and as a wake, and back here to give the
    /// facts of a wake that never ran, whichever wakes were merged into it, back to the sweep.
    fn sink(&self, conversation: &str) -> WakeSink {
        let (emit, me, conversation) = (self.emit.clone(), self.me.clone(), conversation.to_string());
        Arc::new(move |facts: &WakeFacts, u: Update| {
            if let (AgentEvent::Done { ok, message, .. }, Some(me)) = (&u.event, me.upgrade()) {
                if *ok {
                    me.backoff_over(&facts.workstream);
                } else if message.as_deref() == Some(WAKE_PAUSED) {
                    let facts = facts.clone();
                    tokio::spawn(async move { me.unmark(facts).await });
                } else if message.as_deref().is_some_and(|m| is_quota_error(m) || m.starts_with(WAKE_NOT_STARTED)) {
                    let facts = facts.clone();
                    tokio::spawn(async move { me.back_off(facts).await });
                }
            }
            emit(&conversation, u);
        })
    }

    fn backoff_over(&self, ws: &str) {
        let mut quota = self.quota.lock().expect("lock poisoned");
        if quota.get(ws).is_some_and(|q| !q.pending) {
            quota.remove(ws);
        }
    }

    /// Whether `ws` is waiting out a backoff: nothing wakes Pip there until it is over.
    fn backing_off(&self, ws: &str) -> bool {
        self.quota.lock().expect("lock poisoned").get(ws).is_some_and(|q| q.pending)
    }

    /// A wake ended on the quota or couldn't start: its facts are given back, so the sweep wakes Pip for them again
    /// (after a restart too), and no wake of the workstream's runs until the backoff, which doubles each time up to an
    /// hour, is over.
    async fn back_off(self: Arc<Self>, facts: WakeFacts) {
        let ws = facts.workstream.clone();
        let delay = {
            let mut quota = self.quota.lock().expect("lock poisoned");
            let q = quota.entry(ws.clone()).or_insert(Quota { next: BACKOFF_FIRST, pending: false });
            if q.pending {
                None
            } else {
                q.pending = true;
                let delay = q.next;
                q.next = next_backoff(delay);
                Some(delay)
            }
        };
        if let Some(agent) = self.agent() {
            agent.cancel_workstream_wakes(&ws).await;
        }
        self.unmark(facts).await;
        if let Some(delay) = delay {
            let me = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if let Some(q) = me.quota.lock().expect("lock poisoned").get_mut(&ws) {
                    q.pending = false;
                }
            });
        }
    }

    /// Whether a backoff is running and how long the next miss would wait, for `ws`.
    #[cfg(test)]
    pub(crate) fn quota_state(&self, ws: &str) -> Option<(bool, Duration)> {
        self.quota.lock().unwrap().get(ws).map(|q| (q.pending, q.next))
    }

    /// Forgets what was woken, as a fresh start of the app would.
    #[cfg(test)]
    pub(crate) fn forget(&self) {
        self.seen.lock().unwrap().clear();
    }
}

impl RunNotifier for Supervisor {
    /// Called while the run service holds its launch lock: takes a copy of the run and leaves the work to a task.
    fn notify(&self, run: &Run, why: Attention) {
        if run.spec.workstream.is_none() || self.agent().is_none() {
            return;
        }
        let Some(me) = self.me.upgrade() else { return };
        let run = run.clone();
        tokio::spawn(async move { me.on_run(run, why).await });
    }
}

#[cfg(test)]
mod tests;
