//! The supervisor: wakes Pip in a workstream it manages when one of the workstream's runs needs it, and starts nothing.
//!
//! It hears about runs from the run tracker (`RunNotifier::notify`, called while `RunService.launching` is held, so it
//! only ever spawns) and from its own periodic sweep, which catches what the tracker never says: a run the person
//! stopped, a run finishing again after a continuation that drafted nothing, a finish with drafting turned off.
//!
//! A wake is Pip's ordinary turn in the workstream's conversation, asked with a prompt Rust writes from ids, kinds,
//! states, counts and parsed flags only (`event_line`), never an agent's words. Each `(workstream, run, state)` wakes
//! Pip at most once: it is recorded as a `wake` line in the workstream's audit, which is also what a restart rebuilds
//! from. Budgets, the daily cap, quota backoff and tripwires hold the workstream rather than wake it.
//!
//! Before it wakes Pip it applies the auto-start rules (`autostart.rs`): a routine handoff after a finished run starts
//! from the kind's template with the handoffs Core fills, and a review that blocks sends its build a fix round. It
//! launches only those and runs a person approved (`launch_waiting`), always from its own task, never under the run
//! service's lock. It reaches the rest of the app only through `SupervisorCore`, which has no tracker and nothing that
//! approves, comments, transitions or creates anything in Jira, and Pip only through `WakeQueue`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::autostart::{self, Decision, PullHead, ReportFacts, RuleInput, Slots};
use super::{AgentEvent, AgentService, RunPlanner, Update, UpdateSink, WAKE_HELD, WAKE_NOT_STARTED};
use crate::auth::Scope;
use crate::config::AgentSettings;
use crate::domain::workstream::{budget_level, run_labels, BudgetLevel, Mode, Rule, HELD_BUDGET, HELD_DAILY, HELD_QUOTA};
use crate::domain::{has_markers, Actor, ClonePlan, ItemRef, ProposalQuery, Run, RunKind, RunQuery, RunSpec, RunState, StateKind, Workstream, WorkstreamEvent};
use crate::error::{Error, Result};
use crate::inbox::{Admitted, Core, WakeAdmission, WorkstreamView};
use crate::runs::report::{Resolved, ReviewVerdict, StoredReport};
use crate::runs::service::RunService;
use crate::runs::tracker::{Attention, RunNotifier};
use crate::tracker::Connection;

/// How often the sweep looks over the runs of managed workstreams.
pub const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// The first wait before a wake that hit the quota is tried again; each further miss doubles it, up to `BACKOFF_MAX`.
pub const BACKOFF_FIRST: Duration = Duration::from_secs(60);
pub const BACKOFF_MAX: Duration = Duration::from_secs(60 * 60);

/// What Pip is asked in a wake turn, after the `[Event]` block that says what happened.
pub const WAKE_REQUEST: &str = "Nobody wrote this: Gossamr woke you because of the [Event] above. Read what you need, draft the \
     next step if one is due, and reply in at most three short lines.";

/// What a run did that wakes Pip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WakeState {
    Done,
    Failed,
    Stopped,
    /// Gossamr stopped it for passing a limit.
    Limit,
    NeedsAnswer,
    NeedsPermission,
    SystemBlocked,
}

impl WakeState {
    pub fn as_str(self) -> &'static str {
        match self {
            WakeState::Done => "done",
            WakeState::Failed => "failed",
            WakeState::Stopped => "stopped",
            WakeState::Limit => "limit",
            WakeState::NeedsAnswer => "needs_answer",
            WakeState::NeedsPermission => "needs_permission",
            WakeState::SystemBlocked => "system_blocked",
        }
    }

    fn words(self) -> &'static str {
        match self {
            WakeState::Done => "Done",
            WakeState::Failed => "Failed",
            WakeState::Stopped => "Stopped",
            WakeState::Limit => "Stopped at a limit",
            WakeState::NeedsAnswer => "Needs an answer",
            WakeState::NeedsPermission => "Needs permission",
            WakeState::SystemBlocked => "Blocked on sign-in",
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
            Attention::Done | Attention::Drafted | Attention::DraftedTicket | Attention::Breakdown | Attention::PlanDrafted => WakeState::Done,
            Attention::Failed => WakeState::Failed,
            Attention::Limit => WakeState::Limit,
        }
    }

    /// A run at rest, or waiting on the person, as the sweep finds it; `None` while it is under way. A question asked
    /// while the workstream was held is noticed this way once it is set going again, keyed by when it was asked.
    pub fn of_run(run: &Run) -> Option<Self> {
        match run.state {
            RunState::Done => Some(WakeState::Done),
            RunState::Failed => Some(WakeState::Failed),
            RunState::Stopped if run.stopped_by_limit => Some(WakeState::Limit),
            RunState::Stopped => Some(WakeState::Stopped),
            RunState::NeedsAnswer => Some(WakeState::NeedsAnswer),
            RunState::NeedsPermission => Some(WakeState::NeedsPermission),
            RunState::SystemBlocked => Some(WakeState::SystemBlocked),
            _ => None,
        }
    }
}

/// One thing that happened to a run, as Pip is told it: ids, kinds, states, counts and parsed flags, nothing an agent
/// wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeFact {
    pub run: String,
    pub kind: RunKind,
    pub state: WakeState,
    /// The state part of the idempotency key: the state, and for one reached again after the person carried on, when.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mark: String,
    #[serde(default)]
    pub plan_recommended: Option<bool>,
    #[serde(default)]
    pub verdict: Option<ReviewVerdict>,
    #[serde(default)]
    pub blocking: u32,
    #[serde(default)]
    pub drafts: u32,
    /// What the auto-start rules did after this run: the run they started, by kind and the workstream's label for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<Started>,
    /// The fix round they sent the build, by number and the build's label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix_round: Option<FixRoundSent>,
    /// The review still blocks after the last fix round, so the person decides.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exhausted: bool,
    /// The build's review waits for a sync to find its pull request.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub waiting_for_pr: bool,
}

/// A run an auto-start rule started, as a wake names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub kind: RunKind,
    /// `R2`: the workstream's label, never anything that reads as a ticket.
    pub label: String,
}

/// A fix round the rules sent, as a wake names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixRoundSent {
    pub round: u32,
    pub build: String,
}

impl WakeFact {
    /// The fact `state` of `run` with no flags yet; its mark tells a finish after a continuation from the first one.
    pub fn new(run: &Run, state: WakeState) -> Self {
        WakeFact {
            run: run.id.clone(),
            kind: run.spec.kind,
            state,
            mark: mark(run, state),
            plan_recommended: None,
            verdict: None,
            blocking: 0,
            drafts: 0,
            started: None,
            fix_round: None,
            exhausted: false,
            waiting_for_pr: false,
        }
    }

    /// Adds what the auto-start rules did after this fact's run.
    fn with_note(mut self, note: Option<&Note>) -> Self {
        match note {
            Some(Note::Started(started)) => self.started = Some(started.clone()),
            Some(Note::FixRound(sent)) => self.fix_round = Some(sent.clone()),
            Some(Note::Exhausted) => self.exhausted = true,
            Some(Note::WaitingForPr) => self.waiting_for_pr = true,
            None => {}
        }
        self
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
        WakeState::Done | WakeState::Stopped | WakeState::Limit => match run.continued_at {
            Some(at) => format!("{base}@{}", at.timestamp()),
            None => base.to_string(),
        },
        WakeState::Failed => base.to_string(),
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

/// What one pass of the auto-start rules came to.
#[derive(Default)]
struct RuleOutcome {
    /// What they did, by the run they followed.
    notes: HashMap<String, Note>,
    /// They started a run, which waits to be launched.
    started: bool,
    /// A run they were about to act on holds a data marker: the pass stopped there.
    marked: Option<String>,
}

/// What the auto-start rules did after a run, for its wake.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Note {
    Started(Started),
    FixRound(FixRoundSent),
    Exhausted,
    WaitingForPr,
}

/// A run id as it may appear in a wake prompt: never anything `keys_in` would take for a ticket.
fn shown_id(id: &str) -> Option<&str> {
    let plain = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (plain && super::context::keys_in(id).is_empty()).then_some(id)
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// `[Event] run abc12345 (triage) Done; plan recommended: yes; 2 drafts`
fn fact_line(f: &WakeFact) -> String {
    let run = match shown_id(&f.run) {
        Some(id) => format!("run {id}"),
        None => "a run".to_string(),
    };
    let mut line = format!("[Event] {run} ({}) {}", f.kind.as_str(), f.state.words());
    if let Some(yes) = f.plan_recommended {
        line.push_str(if yes { "; plan recommended: yes" } else { "; plan recommended: no" });
    }
    if let Some(verdict) = f.verdict {
        line.push_str(match verdict {
            ReviewVerdict::Pass => "; verdict: pass",
            ReviewVerdict::Blocking => "; verdict: blocking",
        });
        if f.blocking > 0 {
            line.push_str(&format!("; {}", plural(f.blocking, "blocking finding", "blocking findings")));
        }
    }
    if f.drafts > 0 {
        line.push_str(&format!("; {}", plural(f.drafts, "draft", "drafts")));
    }
    let label = |l: &str| shown_id(l).filter(|l| l.len() <= 8).map_or_else(|| "a run".to_string(), String::from);
    if let Some(s) = &f.started {
        line.push_str(&format!("; started {} {} automatically", s.kind.as_str(), label(&s.label)));
    }
    if let Some(r) = &f.fix_round {
        line.push_str(&format!("; sent fix round {} to build {}", r.round, label(&r.build)));
    }
    if f.exhausted {
        line.push_str(&format!("; review still blocking after {} fix rounds", autostart::FIX_ROUNDS_MAX));
    }
    if f.waiting_for_pr {
        line.push_str("; waiting for its pull request");
    }
    line
}

/// The wake prompt's event lines, one per fact. Only ids, kinds, states, counts and parsed flags.
pub fn event_line(facts: &WakeFacts) -> String {
    facts.facts.iter().map(fact_line).collect::<Vec<_>>().join("\n")
}

/// Whether to wake Pip for a fact, and whether the workstream is to be held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WakeDecision {
    pub wake: bool,
    /// The hold this brings: `budget` when this wake uses up the budget (it still runs) or it was used up already,
    /// `daily_cap` when today's wakes are used up.
    pub hold: Option<&'static str>,
    /// The budget level once this wake is counted.
    pub level: BudgetLevel,
}

/// Whether a fact about `ws` wakes Pip. Only an open workstream in Manage mode that isn't held, for a fact it wasn't
/// woken for yet, within its budget and today's cap across workstreams (`daily_cap` 0 is no cap). Mirrored by
/// `decideWake` in src/backend/mockSupervisor.ts; both run src/backend/supervisor.fixtures.json.
pub fn decide_wake(ws: &Workstream, woken: bool, daily_used: u32, daily_cap: u32) -> WakeDecision {
    let level = budget_level(ws);
    let no = |hold| WakeDecision { wake: false, hold, level };
    if ws.closed_at.is_some() || ws.mode != Mode::Manage || ws.held_reason.is_some() || woken {
        return no(None);
    }
    if level == BudgetLevel::Spent {
        return no(Some(HELD_BUDGET));
    }
    if daily_cap > 0 && daily_used >= daily_cap {
        return no(Some(HELD_DAILY));
    }
    let mut after = ws.clone();
    after.spent.auto_turns += 1;
    after.spent.wakes += 1;
    let level = budget_level(&after);
    WakeDecision { wake: true, hold: (level == BudgetLevel::Spent).then_some(HELD_BUDGET), level }
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

/// The tripwires that can fire in a workstream, in the order they are checked.
pub const TRIP_MARKER: &str = "marker";
pub const TRIP_BASIS: &str = "basis_drift";
pub const TRIP_FAILURE: &str = "repeated_failure";
pub const TRIP_REFUSED: &str = "chain_refused";

/// Failures of one kind, and refusals of Pip's chain steps, that trip a workstream.
const FAILURES_TRIP: usize = 2;
const REFUSALS_TRIP: usize = 3;

/// Whether any of `texts` holds a data marker, as written or once the characters that don't show are taken out.
pub fn marked(texts: &[&str]) -> bool {
    let hit = |t: &str| has_markers(t) || crate::runs::result::has_output_markers(t);
    texts.iter().any(|t| hit(t) || hit(&crate::runs::result::visible(t)))
}

/// From where tripwires count: the person's last change of mode or resume (its place in the audit and its time), else
/// the workstream's opening. What the person saw and set going again doesn't trip it again.
fn counting_since(events: &[WorkstreamEvent], opened: DateTime<Utc>) -> (u32, DateTime<Utc>) {
    events
        .iter()
        .filter(|e| e.actor == Actor::Person && matches!(e.action.as_str(), "mode_set" | "resumed"))
        .map(|e| (e.seq, e.at))
        .max()
        .map_or((0, opened), |(seq, at)| (seq, at.max(opened)))
}

/// What the tripwires see of a workstream.
pub struct TripInput<'a> {
    pub ws: &'a Workstream,
    /// A run woken now whose output holds a data marker.
    pub marked: Option<&'a str>,
    /// The basis fields its ticket drifted from (`drifted` in inbox/workstreams.rs); empty when it didn't.
    pub drifted: &'a [&'static str],
    pub runs: &'a [Run],
    pub events: &'a [WorkstreamEvent],
}

/// The tripwire that fires, with the run it is about. A marker in a child's output, the ticket drifting from its basis,
/// the same kind of step failing twice, or Pip asking three times for a chain step Gossamr refused.
pub fn tripwire_of(input: &TripInput) -> Option<(&'static str, Option<String>)> {
    if let Some(run) = input.marked {
        return Some((TRIP_MARKER, Some(run.to_string())));
    }
    if !input.drifted.is_empty() {
        return Some((TRIP_BASIS, None));
    }
    let (since_seq, since) = counting_since(input.events, input.ws.created_at);
    let failed: Vec<&Run> = input.runs.iter().filter(|r| r.state == RunState::Failed && r.ended_at.unwrap_or(r.last_progress_at) >= since).collect();
    let mut repeated: Vec<&Run> = failed.iter().copied().filter(|r| failed.iter().filter(|f| f.spec.kind == r.spec.kind).count() >= FAILURES_TRIP).collect();
    repeated.sort_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id)));
    if let Some(last) = repeated.last() {
        return Some((TRIP_FAILURE, Some(last.id.clone())));
    }
    let refused = input.events.iter().filter(|e| e.actor == Actor::Pip && e.action == "chain_refused" && e.seq > since_seq).count();
    (refused >= REFUSALS_TRIP).then_some((TRIP_REFUSED, None))
}

/// Everything the supervisor may do, and nothing more: read runs, workstreams, reports and the audit; write audit lines
/// and a workstream's hold, mode and spend; ask where a run would go, start a run an auto-start rule produced, send a fix
/// round, launch runs that wait, and stop a run. There is deliberately no tracker or registry here, nor anything that
/// approves a draft or comments on, transitions, creates subtasks under or attaches to a Jira item: orchestration can't
/// write to Jira, whatever it is told. Nor is there anything that posts to GitHub: posting a review is the person's
/// alone (`Core::post_review_draft`, from their approval). The supervisor holds only this.
#[async_trait]
pub trait SupervisorCore: Send + Sync {
    async fn scope(&self) -> Result<Scope>;
    /// The account's open workstreams.
    async fn workstreams(&self, scope: &Scope) -> Result<Vec<WorkstreamView>>;
    async fn workstream(&self, scope: &Scope, id: &str) -> Result<Option<WorkstreamView>>;
    async fn workstream_events(&self, scope: &Scope, id: &str) -> Result<Vec<WorkstreamEvent>>;
    /// The runs linked to workstream `ws`.
    async fn linked_runs(&self, scope: &Scope, ws: &str) -> Result<Vec<Run>>;
    async fn resolved_of(&self, run: &Run) -> Result<Resolved>;
    async fn report_stored(&self, run_id: &str) -> Result<Option<StoredReport>>;
    /// How many drafts made from `run` wait for the person.
    async fn drafts_waiting_from(&self, scope: &Scope, run: &Run) -> Result<u32>;
    async fn record_event(&self, scope: &Scope, event: WorkstreamEvent) -> Result<()>;
    async fn admit_wake(&self, scope: &Scope, ws: &str, facts: &[WakeFact], ask: &WakeAdmission) -> Result<Admitted>;
    /// Charges a wake admitted to merge that the queue made a turn of its own after all (`Core::charge_wake`).
    async fn charge_wake(&self, scope: &Scope, ws: &str, at: DateTime<Utc>) -> Result<bool>;
    /// Trips `ws` for `kind` about `run`; `fields` are the basis fields that drifted, for a basis-drift tripwire.
    async fn trip_workstream(&self, scope: &Scope, ws: &str, kind: &str, run: Option<&str>, fields: &[&str]) -> Result<Workstream>;
    async fn hold_workstream(&self, scope: &Scope, ws: &str, reason: &str) -> Result<Workstream>;
    async fn lift_workstream_hold(&self, scope: &Scope, ws: &str, reason: &str) -> Result<Option<Workstream>>;
    async fn workstream_basis_drift(&self, scope: &Scope, ws: &str) -> Result<Option<Vec<&'static str>>>;
    /// Whether the person approved the Gossamr Plan draft of the plan run `run`.
    async fn plan_approved_of(&self, run: &Run) -> Result<bool>;
    /// The pull request a build opened, as a sync cached it, with its head commit.
    fn pull_head_of(&self, run: &Run) -> Result<Option<PullHead>>;
    fn request_code_sync(&self);
    /// Whether runs can be started at all: Agents are on and the run service is there.
    fn runs_enabled(&self) -> bool;
    /// Where a run in `repo` on ticket `item` would be set up.
    async fn plan(&self, repo: &str, item: &ItemRef) -> Result<ClonePlan>;
    /// Starts the run an auto-start rule produced. Refused with `NOT_ON_ITS_OWN` when the workstream no longer starts
    /// steps on its own or the rule was switched off.
    async fn autostart_run(&self, scope: &Scope, spec: RunSpec, rule: Rule, after_run: &str) -> Result<Run>;
    /// Sends build `run_id` fix round `message` for the blocking review `review`. Refused with `NOT_ON_ITS_OWN` when
    /// the workstream no longer starts steps on its own.
    async fn send_fix_round(&self, run_id: &str, review: &str, message: &str) -> Result<Run>;
    async fn launch_waiting(&self) -> Result<Vec<String>>;
    /// Stops a run as the person's Stop does. Nothing in the supervisor stops a run yet: a hold lets running children
    /// carry on, and only the person stops a workstream.
    #[allow(dead_code)]
    async fn stop_run(&self, run_id: &str) -> Result<Run>;
}

/// The app's `SupervisorCore`: Core for reading and the audit, and the run service, bound once it exists, for what
/// plans, starts, sends and stops runs.
pub struct CoreFacade {
    core: Arc<Core>,
    runs: OnceLock<Weak<RunService>>,
}

impl CoreFacade {
    pub fn new(core: Arc<Core>) -> Arc<Self> {
        Arc::new(CoreFacade { core, runs: OnceLock::new() })
    }

    /// Lets the facade plan, start, send and stop runs. Until then those are refused.
    pub fn bind_runs(&self, runs: &Arc<RunService>) {
        let _ = self.runs.set(Arc::downgrade(runs));
    }

    fn runs(&self) -> Result<Arc<RunService>> {
        self.runs.get().and_then(Weak::upgrade).ok_or_else(|| Error::Proposal("the run service isn't ready".into()))
    }
}

#[async_trait]
impl SupervisorCore for CoreFacade {
    async fn scope(&self) -> Result<Scope> {
        self.core.scope().await
    }

    async fn workstreams(&self, scope: &Scope) -> Result<Vec<WorkstreamView>> {
        self.core.workstreams(scope, false).await
    }

    async fn workstream(&self, scope: &Scope, id: &str) -> Result<Option<WorkstreamView>> {
        self.core.workstream(scope, id).await
    }

    async fn workstream_events(&self, scope: &Scope, id: &str) -> Result<Vec<WorkstreamEvent>> {
        self.core.workstream_events(scope, id).await
    }

    async fn linked_runs(&self, scope: &Scope, ws: &str) -> Result<Vec<Run>> {
        self.core.runs_list(&RunQuery { connection_id: Some(Connection::jira_id(scope)), workstream: Some(ws.to_string()), ..Default::default() }).await
    }

    async fn resolved_of(&self, run: &Run) -> Result<Resolved> {
        self.core.resolved_of(run).await
    }

    async fn report_stored(&self, run_id: &str) -> Result<Option<StoredReport>> {
        self.core.report_stored(run_id).await
    }

    async fn drafts_waiting_from(&self, scope: &Scope, run: &Run) -> Result<u32> {
        let open = ProposalQuery { states: Some(vec![StateKind::Pending]), workstream: run.spec.workstream.clone(), ..Default::default() };
        let drafts = self.core.proposals_in(scope, &open).await?;
        Ok(drafts.iter().filter(|p| matches!(&p.origin, crate::domain::Origin::Run { run_id, .. } if *run_id == run.id)).count() as u32)
    }

    async fn record_event(&self, scope: &Scope, event: WorkstreamEvent) -> Result<()> {
        self.core.record_workstream_event(scope, event).await.map(drop)
    }

    async fn admit_wake(&self, scope: &Scope, ws: &str, facts: &[WakeFact], ask: &WakeAdmission) -> Result<Admitted> {
        self.core.admit_wake(scope, ws, facts, ask).await
    }

    async fn charge_wake(&self, scope: &Scope, ws: &str, at: DateTime<Utc>) -> Result<bool> {
        self.core.charge_wake(scope, ws, at).await
    }

    async fn trip_workstream(&self, scope: &Scope, ws: &str, kind: &str, run: Option<&str>, fields: &[&str]) -> Result<Workstream> {
        self.core.trip_workstream(scope, ws, kind, run, fields).await
    }

    async fn hold_workstream(&self, scope: &Scope, ws: &str, reason: &str) -> Result<Workstream> {
        self.core.hold_workstream(scope, ws, reason, Actor::Supervisor).await
    }

    async fn lift_workstream_hold(&self, scope: &Scope, ws: &str, reason: &str) -> Result<Option<Workstream>> {
        self.core.lift_workstream_hold(scope, ws, reason, Actor::Supervisor).await
    }

    async fn workstream_basis_drift(&self, scope: &Scope, ws: &str) -> Result<Option<Vec<&'static str>>> {
        self.core.workstream_basis_drift(scope, ws).await
    }

    async fn plan_approved_of(&self, run: &Run) -> Result<bool> {
        self.core.plan_approved_of(run).await
    }

    fn pull_head_of(&self, run: &Run) -> Result<Option<PullHead>> {
        Ok(self.core.pull_head_of(run)?.map(|(number, sha)| PullHead { number, sha }))
    }

    fn request_code_sync(&self) {
        self.core.request_code_sync();
    }

    fn runs_enabled(&self) -> bool {
        self.runs().is_ok_and(|r| r.is_enabled())
    }

    async fn plan(&self, repo: &str, item: &ItemRef) -> Result<ClonePlan> {
        let runs = self.runs()?;
        let title = self.core.cache_item(item).await?.map(|w| w.title).unwrap_or_default();
        runs.plan(repo, &item.key, &title).await.map_err(Error::Proposal)
    }

    async fn autostart_run(&self, scope: &Scope, spec: RunSpec, rule: Rule, after_run: &str) -> Result<Run> {
        let runs = self.runs()?;
        runs.ensure_enabled()?;
        self.core.autostart_run(scope, spec, rule, after_run, &runs.settings()).await
    }

    async fn send_fix_round(&self, run_id: &str, review: &str, message: &str) -> Result<Run> {
        self.runs()?.send_fix_round(run_id, review, message).await
    }

    async fn launch_waiting(&self) -> Result<Vec<String>> {
        self.runs()?.launch_waiting().await
    }

    async fn stop_run(&self, run_id: &str) -> Result<Run> {
        self.runs()?.stop(run_id).await
    }
}

/// What the audit's `autostart` and `autostart_failed` lines say a rule did after `src`: `<rule> after <run>`, and for a
/// build's review `build_review after <build>@<head commit>`, since each new commit of its pull request earns a review.
fn rule_detail(rule: Rule, src: &str, pr: Option<&PullHead>) -> String {
    match (rule, pr) {
        (Rule::BuildReview, Some(head)) => format!("{} after {src}@{}", rule.as_str(), head.sha.as_deref().unwrap_or_default()),
        _ => format!("{} after {src}", rule.as_str()),
    }
}

/// Whether what the rules would start after `src` has started already: by a rule (its `autostart` line, or an
/// `autostart_failed` one, which isn't tried again) or by the person (a run of the next kind after it). A build's review
/// counts once per head commit of its pull request: a review read it, or starting one for it failed. A review counts as
/// decided once a fix round went for it, its rounds ran out, or a newer review of the same build exists.
fn already(src: &Run, report: &ReportFacts, runs: &[Run], events: &[WorkstreamEvent], pr: Option<&PullHead>) -> bool {
    let said = |detail: &str| events.iter().any(|e| e.actor == Actor::Supervisor && matches!(e.action.as_str(), "autostart" | "autostart_failed") && e.detail.as_deref() == Some(detail));
    let fired = |rule: Rule| said(&rule_detail(rule, &src.id, None));
    let since = src.ended_at.unwrap_or(src.queued_at);
    let after = |kind: RunKind| runs.iter().any(|r| r.spec.kind == kind && r.id != src.id && r.queued_at >= since);
    match src.spec.kind {
        RunKind::Investigate => fired(Rule::InvestigateTriage) || after(RunKind::Triage) || runs.iter().any(|r| r.spec.findings_from_run.as_deref() == Some(src.id.as_str())),
        RunKind::Triage => fired(Rule::TriagePlan) || after(RunKind::Plan),
        RunKind::Plan => fired(Rule::PlanBuild) || runs.iter().any(|r| r.spec.kind == RunKind::Build && r.spec.plan_from_run.as_deref() == Some(src.id.as_str())),
        RunKind::Build => pr.is_some_and(|head| said(&rule_detail(Rule::BuildReview, &src.id, Some(head)))),
        RunKind::Review => match report.verdict {
            Some(ReviewVerdict::Blocking) => {
                let newer = runs.iter().any(|r| r.spec.kind == RunKind::Review && r.id != src.id && r.spec.build_from_run == src.spec.build_from_run && (r.queued_at, &r.id) > (src.queued_at, &src.id));
                fired(Rule::FixRound) || newer || events.iter().any(|e| e.action == "fix_rounds_exhausted" && e.run_id.as_deref() == Some(src.id.as_str()))
            }
            Some(ReviewVerdict::Pass) => fired(Rule::ReviewVerify) || after(RunKind::Verify),
            None => false,
        },
        RunKind::Verify => false,
    }
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

/// The runs a tripwire named: what they wrote may be hostile, so no rule chains on them (`RuleInput::tripped`).
fn tripped_runs(events: &[WorkstreamEvent]) -> HashSet<&str> {
    events.iter().filter(|e| e.action == "tripwire").filter_map(|e| e.run_id.as_deref()).collect()
}

/// The only part of Pip's agent service the supervisor holds: queue a wake, see whether one waits, and stop a
/// workstream's wakes. The supervisor keeps it as a trait object, so it has no way to Core, and so to the tracker,
/// whatever the agent service itself holds.
#[async_trait]
pub trait WakeQueue: Send + Sync {
    /// Whether the agent service it wakes is still there.
    fn alive(&self) -> bool;
    /// Queues a wake, merged into one waiting when `may_merge` allows and there is one; whether it was merged.
    async fn wake(&self, ws_id: &str, facts: WakeFacts, sink: UpdateSink, may_merge: bool) -> Result<bool>;
    fn has_waiting_wake(&self, conversation: &str) -> bool;
    async fn cancel_workstream_wakes(&self, ws_id: &str);
}

/// Why a wake couldn't be queued at all: Pip's agent service was gone by the time it was asked.
const PIP_NOT_RUNNING: &str = "Pip isn't running";

/// Pip's agent service as a `WakeQueue`, held weakly since the service outlives nothing it is bound to.
struct Wakes(Weak<AgentService>);

#[async_trait]
impl WakeQueue for Wakes {
    fn alive(&self) -> bool {
        self.0.strong_count() > 0
    }

    async fn wake(&self, ws_id: &str, facts: WakeFacts, sink: UpdateSink, may_merge: bool) -> Result<bool> {
        let agent = self.0.upgrade().ok_or_else(|| Error::Claude(PIP_NOT_RUNNING.into()))?;
        agent.wake(ws_id, facts, sink, may_merge).await
    }

    fn has_waiting_wake(&self, conversation: &str) -> bool {
        self.0.upgrade().is_some_and(|a| a.has_waiting_wake(conversation))
    }

    async fn cancel_workstream_wakes(&self, ws_id: &str) {
        if let Some(agent) = self.0.upgrade() {
            agent.cancel_workstream_wakes(ws_id).await;
        }
    }
}

/// Tells every notifier in turn: today's notices and the supervisor.
pub struct FanoutNotifier(pub Vec<Arc<dyn RunNotifier>>);

impl RunNotifier for FanoutNotifier {
    fn notify(&self, run: &Run, why: Attention) {
        for n in &self.0 {
            n.notify(run, why);
        }
    }
}

/// Sends a wake turn's events to the page, with the conversation they belong to.
pub type Emit = Arc<dyn Fn(&str, Update) + Send + Sync>;
/// The agent settings as they are now.
pub type Settings = Arc<dyn Fn() -> AgentSettings + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Quota {
    /// The wait before the next retry.
    next: Duration,
    pending: bool,
}

pub struct Supervisor {
    /// The only way the supervisor reaches the app; it has no tracker and nothing that writes to Jira.
    core: Arc<dyn SupervisorCore>,
    /// Bound once the agent service exists, which is after the run service the supervisor listens to.
    agent: OnceLock<Arc<dyn WakeQueue>>,
    me: Weak<Supervisor>,
    settings: Settings,
    emit: Emit,
    /// Told the connection whenever a workstream was held, tripped or spent.
    changed: Arc<dyn Fn(&str) + Send + Sync>,
    /// One fact at a time, so a notice and a sweep about the same run can't both wake Pip.
    work: tokio::sync::Mutex<()>,
    /// `(workstream, run, state)` woken already; rebuilt from the audit's `wake` lines.
    seen: Mutex<HashSet<(String, String, String)>>,
    quota: Mutex<HashMap<String, Quota>>,
}

impl Supervisor {
    pub fn new(core: Arc<dyn SupervisorCore>, settings: Settings, emit: Emit, changed: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        Arc::new_cyclic(|me| Supervisor {
            core,
            agent: OnceLock::new(),
            me: me.clone(),
            settings,
            emit,
            changed,
            work: tokio::sync::Mutex::new(()),
            seen: Mutex::new(HashSet::new()),
            quota: Mutex::new(HashMap::new()),
        })
    }

    /// Lets the supervisor wake Pip. Until this is called every notice and sweep does nothing.
    pub fn bind(&self, agent: &Arc<AgentService>) {
        let _ = self.agent.set(Arc::new(Wakes(Arc::downgrade(agent))));
    }

    /// Lets the supervisor wake through `queue` instead of an agent service, as a test scripts it.
    #[cfg(test)]
    pub(crate) fn bind_queue(&self, queue: Arc<dyn WakeQueue>) {
        let _ = self.agent.set(queue);
    }

    /// The wake queue, while the agent service it is bound to is alive.
    fn agent(&self) -> Option<Arc<dyn WakeQueue>> {
        self.agent.get().filter(|w| w.alive()).cloned()
    }

    /// Sweeps every `SWEEP_EVERY` for the life of the app.
    pub async fn run_sweeps(self: Arc<Self>) {
        loop {
            tokio::time::sleep(SWEEP_EVERY).await;
            self.sweep_at(Utc::now()).await;
        }
    }

    /// One sweep at `now`: every open workstream in Manage mode that isn't held has its basis captured if it has none,
    /// its tripwires checked, and each linked run at rest that Pip wasn't woken for yet becomes a fact.
    pub async fn sweep_at(&self, now: DateTime<Utc>) {
        if self.agent().is_none() {
            return;
        }
        let Ok(scope) = self.core.scope().await else { return };
        let Ok(views) = self.core.workstreams(&scope).await else { return };
        for view in views {
            let ws = &view.workstream;
            if ws.mode != Mode::Manage || ws.held_reason.is_some() {
                continue;
            }
            let Ok(runs) = self.linked(&scope, &ws.id).await else { continue };
            let mut facts = Vec::new();
            for run in &runs {
                if let Some(state) = WakeState::of_run(run) {
                    facts.push(self.fact_of(&scope, run, state).await);
                }
            }
            self.handle(&ws.id, facts, false, now).await;
        }
    }

    async fn linked(&self, scope: &Scope, ws: &str) -> Result<Vec<Run>> {
        self.core.linked_runs(scope, ws).await
    }

    /// The fact `state` of `run` with its flags: a Triage's plan recommendation, a Review's verdict and blocking
    /// count, and how many drafts it left waiting.
    async fn fact_of(&self, scope: &Scope, run: &Run, state: WakeState) -> WakeFact {
        let mut fact = WakeFact::new(run, state);
        if state != WakeState::Done {
            return fact;
        }
        // Read as the rules read it, so Pip is never told of a recommendation the Triage-to-Plan rule ignored.
        if let Ok(resolved) = self.core.resolved_of(run).await {
            let report = ReportFacts::of(run, &resolved);
            fact.plan_recommended = report.plan_recommended;
            if run.spec.kind == RunKind::Review {
                fact.verdict = report.verdict;
                fact.blocking = report.findings.iter().filter(|f| f.severity == crate::runs::report::Severity::Blocking).count() as u32;
            }
        }
        if let Ok(n) = self.core.drafts_waiting_from(scope, run).await {
            fact.drafts = n;
        }
        fact
    }

    async fn on_run(self: Arc<Self>, run: Run, why: Attention) {
        let Some(ws) = run.spec.workstream.clone() else { return };
        let Ok(scope) = self.core.scope().await else { return };
        if Connection::jira_id(&scope) != run.connection_id {
            return;
        }
        let fact = self.fact_of(&scope, &run, WakeState::of_attention(&run, why)).await;
        self.handle(&ws, vec![fact], false, Utc::now()).await;
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

    /// A wake that never started because its workstream was held, advised or closed first (`WAKE_HELD`): its facts are
    /// taken back with a `wake_dropped` line each, so Pip is woken for them once the workstream is set going again.
    async fn unmark(&self, facts: WakeFacts) {
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

    /// Checks `ws`'s tripwires, applies the auto-start rules, then wakes Pip with `facts` it wasn't woken for yet, as far
    /// as its mode, hold, budget and today's cap allow; what the rules started is launched last, so a wake that holds the
    /// workstream keeps it waiting. `retry` wakes again for facts a quota miss cut short.
    async fn handle(&self, ws_id: &str, facts: Vec<WakeFact>, retry: bool, now: DateTime<Utc>) {
        let _one = self.work.lock().await;
        let Some(agent) = self.agent() else { return };
        let Ok(scope) = self.core.scope().await else { return };
        let Ok(Some(view)) = self.core.workstream(&scope, ws_id).await else { return };
        let ws = view.workstream;
        if ws.closed_at.is_some() || ws.mode != Mode::Manage || ws.held_reason.is_some() {
            return;
        }
        let connection = ws.connection_id.clone();
        let Ok(events) = self.core.workstream_events(&scope, ws_id).await else { return };
        let Ok(runs) = self.linked(&scope, ws_id).await else { return };
        let woken = self.woken(ws_id, &events);
        let mut fresh: Vec<WakeFact> = Vec::new();
        for f in facts {
            let seen = woken.contains(&(f.run.clone(), f.key().to_string()));
            if (retry || !seen) && !fresh.iter().any(|g| g.run == f.run && g.key() == f.key()) {
                fresh.push(f);
            }
        }

        // A run already named in a tripwire was seen by the person, who set the workstream going again; it doesn't trip
        // it again, and no rule chains on it either (`tripped_runs`).
        let tripped = tripped_runs(&events);
        let mut marker = None;
        for f in fresh.iter().filter(|f| !tripped.contains(f.run.as_str())) {
            let Some(run) = runs.iter().find(|r| r.id == f.run) else { continue };
            if self.output_marked(run).await {
                marker = Some(run.id.clone());
                break;
            }
        }
        let drifted = self.core.workstream_basis_drift(&scope, ws_id).await.ok().flatten().unwrap_or_default();
        let input = TripInput { ws: &ws, marked: marker.as_deref(), drifted: &drifted, runs: &runs, events: &events };
        if let Some((kind, run)) = tripwire_of(&input) {
            let fields: &[&str] = if kind == TRIP_BASIS { &drifted } else { &[] };
            self.trip(&scope, &connection, ws_id, kind, run.as_deref(), fields).await;
            return;
        }
        let rules = self.autostart(&scope, &ws, &runs, &events).await;
        if let Some(run) = &rules.marked {
            self.trip(&scope, &connection, ws_id, TRIP_MARKER, Some(run), &[]).await;
            return;
        }
        if !rules.notes.is_empty() {
            (self.changed)(&connection);
        }
        let fresh: Vec<WakeFact> = fresh.into_iter().map(|f| {
            let note = rules.notes.get(&f.run).filter(|_| f.state == WakeState::Done);
            f.with_note(note)
        }).collect();
        self.wake_for(&agent, &scope, ws_id, &connection, fresh, retry, now).await;
        if rules.started {
            // Under the run service's own checks: a workstream the wake just held keeps what started waiting.
            if let Err(e) = self.core.launch_waiting().await {
                eprintln!("couldn't launch the runs started in workstream {ws_id}: {e}");
            }
        }
    }

    /// Holds `ws_id` for tripwire `kind` about `run` (with the basis `fields` that drifted), and stops any wake of it
    /// still waiting or running.
    async fn trip(&self, scope: &Scope, connection: &str, ws_id: &str, kind: &str, run: Option<&str>, fields: &[&str]) {
        if let Err(e) = self.core.trip_workstream(scope, ws_id, kind, run, fields).await {
            eprintln!("couldn't hold workstream {ws_id} for its {kind} tripwire: {e}");
        }
        if let Some(agent) = self.agent() {
            agent.cancel_workstream_wakes(ws_id).await;
        }
        (self.changed)(connection);
    }

    /// Wakes Pip in `ws_id` with `fresh`, as far as the workstream's budget and today's cap allow.
    #[allow(clippy::too_many_arguments)]
    async fn wake_for(&self, agent: &Arc<dyn WakeQueue>, scope: &Scope, ws_id: &str, connection: &str, fresh: Vec<WakeFact>, retry: bool, now: DateTime<Utc>) {
        if fresh.is_empty() {
            return;
        }
        let conversation = format!("ws:{ws_id}");
        let settings = (self.settings)();
        // Only a guess: whether it merges is the queue's to say, under its own lock, and the charge follows that.
        let spend = !agent.has_waiting_wake(&conversation);
        let ask = WakeAdmission {
            spend,
            daily_cap: settings.manager_turns_per_day,
            today: now.date_naive().and_hms_opt(0, 0, 0).expect("midnight exists").and_utc(),
            retry,
            at: now,
        };
        let admitted = match self.core.admit_wake(scope, ws_id, &fresh, &ask).await {
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
                // Held for its budget or today's cap without a wake: one still waiting doesn't run either.
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
        let sink = self.sink(&conversation, facts.clone());
        // A wake charged as a turn of its own stays one; one admitted to merge that found nothing waiting is charged now.
        match agent.wake(ws_id, facts.clone(), sink, !spend).await {
            Ok(false) if !spend => match self.core.charge_wake(scope, ws_id, now).await {
                Ok(true) => (self.changed)(connection),
                Ok(false) => {}
                Err(e) => eprintln!("couldn't count a wake in workstream {ws_id}: {e}"),
            },
            Ok(_) => {}
            Err(e) => {
                // A wake that failed to start was told through its sink, which takes the facts back or retries on
                // the quota. Any other error came before the sink was ever called, so the facts go back here.
                if !matches!(&e, Error::Claude(m) if m.starts_with(WAKE_NOT_STARTED)) {
                    self.unmark(facts).await;
                }
                eprintln!("couldn't wake Pip in workstream {ws_id}: {e}");
            }
        }
    }

    /// Applies the auto-start rules to every finished run of `ws` and says what they did, by the run they followed.
    /// Each rule fires at most once per run (its `autostart` line, or the run it would start, says it did), a review at
    /// most once per pull request commit, and never after a run a tripwire named, nor after a Triage that carried such
    /// a run's findings; a rule that couldn't start says so once in the audit and isn't tried again. Before a rule acts
    /// on a run, that run's own output, and that of the investigation it carried (`autostart::carried`), which the run
    /// it starts carries on by name and never "the newest", is checked for data markers, whether or not it was among the
    /// facts that brought the supervisor here: a marked one stops the pass and trips the workstream. A step the person held, advised or switched off since this pass began is refused where it
    /// is started or sent, and decided again on the next pass.
    async fn autostart(&self, scope: &Scope, ws: &Workstream, runs: &[Run], events: &[WorkstreamEvent]) -> RuleOutcome {
        let settings = (self.settings)();
        let mut out = RuleOutcome::default();
        if !self.core.runs_enabled() {
            return out;
        }
        let tripped = tripped_runs(events);
        let mut done: Vec<&Run> = runs.iter().filter(|r| r.state == RunState::Done).collect();
        done.sort_by(|a, b| (a.ended_at, a.queued_at, &a.id).cmp(&(b.ended_at, b.queued_at, &b.id)));
        for src in done {
            let Ok(resolved) = self.core.resolved_of(src).await else { continue };
            let report = ReportFacts::of(src, &resolved);
            let build = src.spec.build_from_run.as_deref().unwrap_or_default();
            let fix_rounds = events.iter().filter(|e| e.action == "autostart" && e.run_id.as_deref() == Some(build) && e.detail.as_deref().is_some_and(|d| d.starts_with("fix_round after "))).count() as u32;
            let plan_approved = src.spec.kind == RunKind::Plan && self.core.plan_approved_of(src).await.unwrap_or(false);
            let pr = if src.spec.kind == RunKind::Build { self.core.pull_head_of(src).ok().flatten() } else { None };
            let reviewed = runs.iter().filter(|r| r.spec.kind == RunKind::Review && r.spec.build_from_run.as_deref() == Some(src.id.as_str())).map(|r| r.spec.pr_sha.clone()).collect();
            let carried = autostart::carried(src);
            let input = RuleInput {
                source: src,
                report: &report,
                ws,
                settings: &settings,
                fix_rounds,
                plan_approved,
                pr: pr.clone(),
                reviewed,
                already: already(src, &report, runs, events, pr.as_ref()),
                tripped: tripped.contains(src.id.as_str()) || carried.is_some_and(|c| tripped.contains(c)),
            };
            let Some(decision) = autostart::decide(&input) else { continue };
            if matches!(decision, Decision::Start { .. } | Decision::FixRound { .. }) {
                if self.output_marked(src).await {
                    out.marked = Some(src.id.clone());
                    return out;
                }
                // What it carried goes on into the next run, so it is checked here too, whatever brought it here.
                if let Some(c) = carried {
                    let Some(run) = runs.iter().find(|r| r.id == c) else { continue };
                    if self.output_marked(run).await {
                        out.marked = Some(run.id.clone());
                        return out;
                    }
                }
            }
            let note = match decision {
                Decision::Start { rule, kind, .. } => {
                    let Some(item) = src.item.as_ref() else { continue };
                    let slots = Slots { findings_from_run: carried.map(String::from), pr: pr.as_ref().map(|p| p.number), pr_sha: pr.as_ref().and_then(|p| p.sha.clone()) };
                    let spec = match self.core.plan(&src.spec.repo, item).await {
                        Ok(plan) => autostart::spec_for(&decision, src, plan, &slots),
                        Err(e) => {
                            self.not_started(scope, ws, rule, src, pr.as_ref(), &e).await;
                            continue;
                        }
                    };
                    let Some(spec) = spec else { continue };
                    match self.core.autostart_run(scope, spec, rule, &src.id).await {
                        Ok(run) => {
                            out.started = true;
                            let mut all = runs.to_vec();
                            all.push(run.clone());
                            let label = run_labels(&all).into_iter().find(|(id, _)| *id == run.id).map(|(_, l)| l).unwrap_or_default();
                            Note::Started(Started { kind, label })
                        }
                        Err(Error::Proposal(why)) if why == crate::inbox::PR_MOVED => {
                            self.core.request_code_sync();
                            continue;
                        }
                        Err(Error::Proposal(why)) if why == crate::inbox::NOT_ON_ITS_OWN => continue,
                        Err(e) => {
                            self.not_started(scope, ws, rule, src, pr.as_ref(), &e).await;
                            continue;
                        }
                    }
                }
                Decision::FixRound { rule, build_run, message } => match self.core.send_fix_round(&build_run, &src.id, &message).await {
                    Ok(_) => {
                        let label = run_labels(runs).into_iter().find(|(id, _)| *id == build_run).map(|(_, l)| l).unwrap_or_default();
                        Note::FixRound(FixRoundSent { round: fix_rounds + 1, build: label })
                    }
                    Err(Error::Proposal(why)) if why == crate::inbox::NOT_ON_ITS_OWN => continue,
                    Err(e) => {
                        self.not_started(scope, ws, rule, src, None, &e).await;
                        continue;
                    }
                },
                Decision::Exhausted { review_run, .. } => {
                    let line = WorkstreamEvent::new(&ws.id, Actor::Supervisor, "fix_rounds_exhausted", Utc::now()).run(&review_run).detail(autostart::FIX_ROUNDS_MAX.to_string());
                    self.record(scope, line).await;
                    Note::Exhausted
                }
                Decision::WaitingForPr { build_run, .. } => {
                    if !events.iter().any(|e| e.action == "waiting_for_pr" && e.run_id.as_deref() == Some(build_run.as_str())) {
                        self.record(scope, WorkstreamEvent::new(&ws.id, Actor::Supervisor, "waiting_for_pr", Utc::now()).run(&build_run)).await;
                        self.core.request_code_sync();
                    }
                    Note::WaitingForPr
                }
            };
            out.notes.insert(src.id.clone(), note);
        }
        out
    }

    /// A rule that couldn't start, said once in the audit with the rule and the run (and for a build's review, the
    /// commit), never the reason's text; it isn't tried again for that, and Pip is woken for the run as usual.
    async fn not_started(&self, scope: &Scope, ws: &Workstream, rule: Rule, src: &Run, pr: Option<&PullHead>, why: &Error) {
        eprintln!("couldn't start the {} step after run {} in workstream {}: {why}", rule.as_str(), src.id, ws.id);
        self.record(scope, WorkstreamEvent::new(&ws.id, Actor::Supervisor, "autostart_failed", Utc::now()).run(&src.id).detail(rule_detail(rule, &src.id, pr))).await;
    }

    async fn record(&self, scope: &Scope, event: WorkstreamEvent) {
        let action = event.action.clone();
        if let Err(e) = self.core.record_event(scope, event).await {
            eprintln!("couldn't record {action} in a workstream: {e}");
        }
    }

    /// Looks again at every workstream now, from a task of its own: a sync found a pull request, say.
    pub fn nudge(&self) {
        if self.agent().is_none() {
            return;
        }
        let Some(me) = self.me.upgrade() else { return };
        tokio::spawn(async move { me.sweep_at(Utc::now()).await });
    }

    /// The person approved a draft in workstream `ws`, such as a plan's: the rules that wait on that are looked at again.
    pub fn on_proposal_applied(&self, ws: Option<&str>) {
        let (Some(ws), Some(me)) = (ws.map(String::from), self.me.upgrade()) else { return };
        if self.agent().is_none() {
            return;
        }
        tokio::spawn(async move { me.handle(&ws, Vec::new(), false, Utc::now()).await });
    }

    /// Whether a child's result, summary or report holds one of the data markers.
    async fn output_marked(&self, run: &Run) -> bool {
        let mut texts: Vec<String> = [run.result.clone(), run.summary.clone()].into_iter().flatten().collect();
        if let Ok(resolved) = self.core.resolved_of(run).await {
            texts.extend(resolved.note.map(|n| n.text));
            texts.extend(resolved.plan);
            for f in resolved.findings {
                texts.push(f.text);
                texts.extend(f.where_);
            }
        }
        if let Ok(Some(stored)) = self.core.report_stored(&run.id).await {
            if let Some(report) = stored.report {
                texts.extend(report.note);
                texts.extend(report.plan);
                texts.extend(report.findings.into_iter().flat_map(|f| [Some(f.text), f.where_]).flatten());
            }
        }
        marked(&texts.iter().map(String::as_str).collect::<Vec<_>>())
    }

    /// Where a wake turn's events go: to the page, marked as the workstream's and as a wake, and back here to notice a
    /// quota miss.
    fn sink(&self, conversation: &str, facts: WakeFacts) -> UpdateSink {
        let (emit, me, conversation) = (self.emit.clone(), self.me.clone(), conversation.to_string());
        Arc::new(move |u: Update| {
            if let (AgentEvent::Done { ok, message, .. }, Some(me)) = (&u.event, me.upgrade()) {
                if *ok {
                    me.quota_ok(&facts.workstream);
                } else if message.as_deref() == Some(WAKE_HELD) {
                    let facts = facts.clone();
                    tokio::spawn(async move { me.unmark(facts).await });
                } else if message.as_deref().is_some_and(is_quota_error) {
                    let facts = facts.clone();
                    tokio::spawn(async move { me.on_quota(facts).await });
                } else if message.as_deref().is_some_and(|m| m.starts_with(WAKE_NOT_STARTED)) {
                    let facts = facts.clone();
                    tokio::spawn(async move { me.unmark(facts).await });
                }
            }
            emit(&conversation, u);
        })
    }

    fn quota_ok(&self, ws: &str) {
        let mut quota = self.quota.lock().expect("lock poisoned");
        if quota.get(ws).is_some_and(|q| !q.pending) {
            quota.remove(ws);
        }
    }

    /// A wake ended on the quota: holds the workstream and, unless one is pending already, tries once more after the
    /// backoff, which doubles each time up to an hour. Never a loop: each retry is one wake.
    async fn on_quota(self: Arc<Self>, facts: WakeFacts) {
        let ws = facts.workstream.clone();
        if let Ok(scope) = self.core.scope().await {
            match self.core.hold_workstream(&scope, &ws, HELD_QUOTA).await {
                Ok(held) => (self.changed)(&held.connection_id),
                Err(e) => eprintln!("couldn't hold workstream {ws} for the quota: {e}"),
            }
            if let Some(agent) = self.agent() {
                agent.cancel_workstream_wakes(&ws).await;
            }
        }
        let delay = {
            let mut quota = self.quota.lock().expect("lock poisoned");
            let q = quota.entry(ws.clone()).or_insert(Quota { next: BACKOFF_FIRST, pending: false });
            if q.pending {
                return;
            }
            q.pending = true;
            let delay = q.next;
            q.next = next_backoff(delay);
            delay
        };
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            me.retry(facts).await;
        });
    }

    /// The retry after a quota miss: lifts the quota hold, if that is still what holds it, and wakes Pip again. Held
    /// for something else, the facts are let go of, so setting it going wakes Pip for them; no longer held (the person
    /// set it going before the backoff ran out), they are delivered all the same.
    async fn retry(&self, facts: WakeFacts) {
        let ws = facts.workstream.clone();
        if let Some(q) = self.quota.lock().expect("lock poisoned").get_mut(&ws) {
            q.pending = false;
        }
        let Ok(scope) = self.core.scope().await else { return };
        match self.core.lift_workstream_hold(&scope, &ws, HELD_QUOTA).await {
            Ok(Some(lifted)) => (self.changed)(&lifted.connection_id),
            Ok(None) => {
                let held = match self.core.workstream(&scope, &ws).await {
                    Ok(view) => view.is_none_or(|v| v.workstream.held_reason.is_some()),
                    Err(_) => true,
                };
                if held {
                    self.unmark(facts).await;
                    return;
                }
            }
            Err(e) => {
                eprintln!("couldn't lift the quota hold of workstream {ws}: {e}");
                return;
            }
        }
        self.handle(&ws, facts.facts, true, Utc::now()).await;
    }

    /// The pending retry and the backoff the next miss would wait, for `ws`.
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

/// A budget level as the audit's `budget` line and the shared fixture name it.
pub fn level_word(level: BudgetLevel) -> &'static str {
    match level {
        BudgetLevel::Ok => "ok",
        BudgetLevel::Amber => "amber",
        BudgetLevel::Spent => "spent",
    }
}

#[cfg(test)]
mod tests;
