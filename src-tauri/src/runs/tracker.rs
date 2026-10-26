//! Keeps the signed-in account's runs current from `claude agents`, records what they do, and tells the person when
//! one needs them.
//!
//! The public listing decides each run's state; a job's `state.json` and timeline only supply words, and everything
//! taken from them is redacted and capped before it is stored. Sessions that match no run are ignored.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Timelike, Utc};

use super::limits;
use super::notices::{stuck_runs, Group, Key, Need, Outgoing, Settings as NoticeSettings, Waiting, GENERAL};
use super::cli::{AgentEntry, JobInfo, ShortId};
use super::redact::redact;
use super::service::{belongs_to, RunService};
use super::state::{self, map_state, parse_at, progress_at};
use super::toolchain::Toolchain;
use crate::domain::{Intent, Origin, ProposalQuery, ProposalState, Run, RunEvent, RunKind, RunQuery, RunState, StateKind};
use crate::notify::Notice;

pub const POLL_BUSY: Duration = Duration::from_secs(4);
pub const POLL_IDLE: Duration = Duration::from_secs(30);
/// A finished run is watched this long after it ended, in case its session is still open and the person carries on.
const WATCH_FINISHED: chrono::Duration = chrono::Duration::hours(6);
/// A stopped run's session is listed as stopped within seconds, but until then it can still look alive; it is not
/// taken for a session that carried on before this long has passed.
const STOPPED_SETTLE: chrono::Duration = chrono::Duration::seconds(60);
/// Focusing the window this soon after a notification opens the run it was about.
pub const OPEN_WINDOW: Duration = Duration::from_secs(30);

pub(crate) const NEEDS_KEPT: usize = 500;
const DETAIL_KEPT: usize = 500;
const EVENT_TEXT_KEPT: usize = 500;
const EVENT_DETAIL_KEPT: usize = 2_048;
pub(super) const RESULT_KEPT: usize = 20_000;
const SUMMARY_KEPT: usize = 2_000;
const REPLY_KEPT: usize = 1_000;

/// Why a run is worth interrupting for. Being quiet is not one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attention {
    Needs,
    Done,
    /// Finished, and a comment for its ticket is waiting as a draft.
    Drafted,
    /// Finished, and a new ticket from its result is waiting as a draft.
    DraftedTicket,
    /// Finished, and a breakdown into subtasks is waiting as a draft.
    Breakdown,
    /// A Plan run finished, and a description update that adds its plan is waiting as a draft.
    PlanDrafted,
    Failed,
    /// Gossamr stopped it for passing a limit.
    Limit,
}

pub trait RunNotifier: Send + Sync {
    /// A run's news, one call per event. Whatever listens for it (the supervisor) hears everything; the system
    /// notifications are chosen apart (`announce`).
    fn notify(&self, run: &Run, why: Attention);

    /// A system notification the person should get (`notices::Board`). Whether it was delivered: a notice that wasn't
    /// is offered again at the next poll. A notifier with nothing to show has delivered it.
    fn announce(&self, _notice: &Outgoing) -> bool {
        true
    }

    /// Whether the person is looking at the app, so a notification would only repeat what they can see.
    fn watching(&self) -> bool {
        false
    }
}

pub struct NoNotices;

impl RunNotifier for NoNotices {
    fn notify(&self, _run: &Run, _why: Attention) {}
}

/// A session whose process is alive and that is not at rest, the only kind a finished run can be taken up by again.
fn is_active(entry: &AgentEntry) -> bool {
    entry.pid.is_some() && matches!(entry.state.as_deref(), Some("working" | "blocked")) && entry.status.as_deref() != Some("idle")
}

/// Whether the session listed for a run at rest has started working or asking again. A finished run only counts a
/// session that is not at its prompt; a stopped one also counts a session waiting on a question, which Claude lists as
/// idle. Gossamr's own answer in flight (`unsent_answer`) and a stop that is still settling don't count.
pub(super) fn revived(entry: &AgentEntry, run: &Run, now: DateTime<Utc>) -> bool {
    match run.state {
        RunState::Done => is_active(entry),
        RunState::Stopped => {
            let settled = run.ended_at.is_some_and(|at| now - at >= STOPPED_SETTLE);
            let alive = entry.pid.is_some()
                && match entry.state.as_deref() {
                    Some("blocked") => true,
                    Some("working") => entry.status.as_deref() != Some("idle"),
                    _ => false,
                };
            settled && alive && run.unsent_answer.is_none()
        }
        _ => false,
    }
}

fn topic(run: &Run) -> &str {
    run.item.as_ref().map_or_else(|| run.spec.repo.as_str(), |i| i.key.as_str())
}

pub fn notice_text(run: &Run, why: Attention) -> Notice {
    let topic = topic(run);
    match why {
        Attention::Needs => {
            let body = match run.state {
                RunState::NeedsPermission => "Claude wants to run a command".to_owned(),
                RunState::SystemBlocked => "Claude needs you to sign in".to_owned(),
                _ => run.needs.clone().unwrap_or_else(|| super::state::WAITING_FOR_YOU.to_owned()),
            };
            Notice { title: format!("{topic} needs you"), body }
        }
        Attention::Limit => Notice { title: format!("{topic} was stopped"), body: run.error.clone().unwrap_or_else(|| "It passed a limit".into()) },
        Attention::Drafted => Notice { title: format!("Draft ready on {topic}"), body: "An agent finished. Read its comment before anything is posted".into() },
        Attention::PlanDrafted => Notice { title: format!("Plan finished on {topic}"), body: "Description update ready. Read it before anything is written to the ticket".into() },
        Attention::Breakdown => Notice { title: format!("Breakdown proposed on {topic}"), body: "An agent finished. Read the subtasks before anything is created".into() },
        Attention::DraftedTicket => Notice { title: "Draft ticket ready".into(), body: format!("An agent finished in {topic}. Read the ticket before anything is created") },
        Attention::Done => Notice { title: format!("{topic} finished"), body: "Open it to see what it found".into() },
        Attention::Failed => {
            let title = match run.error.as_deref() {
                Some(state::PROCESS_ENDED) => format!("{topic} stopped unexpectedly"),
                Some(state::LOST) => format!("{topic} lost its session"),
                _ => format!("{topic} couldn't start"),
            };
            Notice { title, body: run.error.clone().unwrap_or_else(|| "Something went wrong".into()) }
        }
    }
}

/// The run a notification was about, for a short while. The notification plugin has no click handler on desktop, so
/// the window gaining focus soon afterwards is the click.
#[derive(Default)]
pub struct OpenOnFocus {
    pending: Mutex<Option<(String, Instant)>>,
}

impl OpenOnFocus {
    pub fn record(&self, run_id: &str, at: Instant) {
        *self.pending.lock().expect("pending run lock poisoned") = Some((run_id.to_owned(), at));
    }

    /// The run to open, once: later calls and calls after the window give nothing.
    pub fn take(&self, now: Instant) -> Option<String> {
        let (run_id, at) = self.pending.lock().expect("pending run lock poisoned").take()?;
        (now.saturating_duration_since(at) <= OPEN_WINDOW).then_some(run_id)
    }
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

pub(super) fn cleaned(s: &str, max: usize) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| cut(&redact(s), max))
}

/// A run's final answer, redacted and within `RESULT_KEPT`, with the sections drafts are made from kept whole.
pub(super) fn cleaned_answer(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| super::result::keep_within(&redact(s), RESULT_KEPT))
}

/// The timeline as events, in order. Redacted and cut here, so a line compares equal to the event stored from it.
fn events_of(run: &Run, job: &JobInfo) -> Vec<RunEvent> {
    let mut at = run.launched_at.unwrap_or(run.queued_at);
    job.timeline
        .iter()
        .filter_map(|line| {
            // A line without a time keeps the last line's, so the same timeline always gives the same events.
            at = line.at.as_deref().and_then(parse_at).unwrap_or(at);
            // Stored times have whole seconds, so a line is only found again by its time when this one does too.
            let at = at.with_nanosecond(0).unwrap_or(at);
            let main = line.text.as_deref().and_then(|t| cleaned(t, EVENT_TEXT_KEPT));
            let detail = line.detail.as_deref().and_then(|d| cleaned(d, EVENT_DETAIL_KEPT));
            let (text, detail) = match main {
                Some(text) => {
                    let detail = detail.filter(|d| *d != text);
                    (text, detail)
                }
                None => (cut(detail.as_deref()?, EVENT_TEXT_KEPT), None),
            };
            Some(RunEvent { run_id: run.id.clone(), seq: 0, at, kind: line.state.clone().unwrap_or_else(|| "update".into()), text, detail })
        })
        .collect()
}

/// What is not stored yet: everything after the newest stored event, found by content and failing that by time.
fn unseen(all: Vec<RunEvent>, stored: Option<&RunEvent>) -> Vec<RunEvent> {
    let Some(last) = stored else { return all };
    let same = |e: &RunEvent| (e.at, &e.kind, &e.text, &e.detail) == (last.at, &last.kind, &last.text, &last.detail);
    match all.iter().rposition(same) {
        Some(i) => all.into_iter().skip(i + 1).collect(),
        None => all.into_iter().filter(|e| e.at > last.at).collect(),
    }
}

pub struct Polled {
    /// Some run is under way, so the next look should be soon.
    pub busy: bool,
}

impl RunService {
    pub async fn poll(&self) -> Polled {
        let polled = self.poll_with(Utc::now).await;
        self.announce_notices(Utc::now()).await;
        polled
    }

    /// One look at `claude agents` for every unfinished run of the signed-in account, at the time `now`.
    pub async fn poll_at(&self, now: DateTime<Utc>) -> Polled {
        let polled = self.poll_with(|| now).await;
        self.announce_notices(now).await;
        polled
    }

    /// The listing is read and applied while holding the launch lock, with the time taken after the lock was won. A
    /// listing read before waiting for it can predate an answer that stops and wakes a session, and applying it
    /// afterwards puts the run back to `Stopped`.
    async fn poll_with(&self, clock: impl Fn() -> DateTime<Utc>) -> Polled {
        let idle = Polled { busy: false };
        let now = clock();
        let Ok(_not_recovering) = self.recovery.try_lock() else { return Polled { busy: true } };
        let unfinished = [
            RunState::Queued,
            RunState::Launching,
            RunState::Working,
            RunState::NeedsAnswer,
            RunState::NeedsPermission,
            RunState::SystemBlocked,
            RunState::Unknown,
        ];
        let Ok(runs) = self.core.runs_list(&RunQuery { states: Some(unfinished.to_vec()), ..RunQuery::default() }).await else { return idle };
        let waiting = self.awaiting_answer(now).await;
        let finished = self.recently_finished(now).await;
        if runs.is_empty() && waiting.is_empty() && finished.is_empty() {
            return idle;
        }
        // A run waiting for a slot counts: the next look should be soon, so it starts promptly once one frees.
        let mut busy = runs.iter().any(|r| r.state != RunState::Queued || r.slot_wait_since.is_some()) || !waiting.is_empty();
        let Ok(tc) = self.tools.get().await else { return Polled { busy } };
        self.collect_answers(&tc, &waiting).await;
        let config_dir = self.claude_config_dir(&tc).await;

        let turn = self.launching.lock().await;
        let now = clock();
        let Ok(entries) = tc.cli.agents(true).await else { return Polled { busy } };
        busy |= finished.iter().any(|r| entries.iter().any(|e| belongs_to(e, r) && revived(e, r, now)));
        let mut changed = HashSet::new();
        for id in self.adopt_continuations(&entries, &finished, now).await {
            changed.insert(id);
        }
        let mut reviewed = Vec::new();
        for listed in runs.iter().chain(&finished) {
            match self.track(&tc, config_dir.as_deref(), &entries, &listed.id, now, &mut reviewed).await {
                Ok(Some(connection_id)) => {
                    changed.insert(connection_id);
                }
                Ok(None) => {}
                Err(e) => eprintln!("couldn't track run {}: {e}", listed.id),
            }
        }
        // A review's GitHub draft reads the pull request, which can take a while, so launches don't wait for it.
        drop(turn);
        changed.iter().for_each(|c| (self.changed)(c));
        for run in &reviewed {
            self.draft_review(run).await;
        }
        Polled { busy }
    }

    /// Tells the notifier a run's news. A need is found by `announce_notices` from what waits, not from this call.
    pub(super) fn notify_run(&self, run: &Run, why: Attention) {
        self.notifier.notify(run, why);
    }

    /// Looks at everything that waits on the person and sends the system notifications that are due (`notices`).
    pub(super) async fn announce_notices(&self, now: DateTime<Utc>) {
        let settings = self.settings();
        let settings = NoticeSettings { mode: settings.notifications, digest_every: chrono::Duration::minutes(i64::from(settings.digest_minutes)) };
        let asking = [RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked];
        let Ok(runs) = self.core.runs_list(&RunQuery { states: Some(asking.to_vec()), ..RunQuery::default() }).await else { return };
        let Ok(drafts) = self.core.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..ProposalQuery::default() }).await else { return };
        let drafts: Vec<_> = drafts.into_iter().filter(|p| p.state == ProposalState::Pending).collect();
        // The open workstreams give names, run labels and pauses; the closed ones are only told apart by id,
        // so what belongs to one is skipped without loading it.
        let (views, closed_ids) = match self.core.scope().await {
            Ok(scope) => (self.core.workstreams(&scope, false).await.unwrap_or_default(), self.core.closed_workstream_ids(&scope).await.unwrap_or_default()),
            Err(_) => (Vec::new(), HashSet::new()),
        };
        let view_of = |id: &str| views.iter().find(|v| v.workstream.id == id);
        let closed = |id: &Option<String>| id.as_deref().is_some_and(|id| closed_ids.contains(id));
        let label_of = |id: &str, ws: &Option<String>| ws.as_deref().and_then(view_of).and_then(|v| v.labels.iter().find(|(run, _)| run == id)).map(|(_, l)| l.clone());
        let mut needs: BTreeMap<Key, Vec<Need>> = BTreeMap::new();
        // A run's question, permission or sign-in is something to unblock.
        for run in &runs {
            let ws = run.spec.workstream.clone();
            if closed(&ws) {
                continue;
            }
            let name = label_of(&run.id, &ws).unwrap_or_else(|| topic(run).to_owned());
            let what = match run.state {
                RunState::NeedsPermission => format!("{name} wants to run a command"),
                RunState::SystemBlocked => format!("{name} needs you to sign in"),
                _ => match run.needs.as_deref().map(|n| cut(&n.split_whitespace().collect::<Vec<_>>().join(" "), 100)).filter(|n| !n.is_empty()) {
                    Some(question) => format!("{name} asks: {question}"),
                    None => format!("{name} has a question"),
                },
            };
            needs.entry(ws).or_default().push(Need { group: Group::Unblock, run_id: Some(run.id.clone()), what, since: run.last_progress_at });
        }
        // A failure or a stop at the limit is stuck until dealt with, but only the latest run of its kind on its ticket.
        let Ok(all) = self.core.runs_list(&RunQuery::default()).await else { return };
        for run in stuck_runs(&all, now) {
            let ws = run.spec.workstream.clone();
            if closed(&ws) {
                continue;
            }
            let name = label_of(&run.id, &ws).unwrap_or_else(|| topic(run).to_owned());
            let what = if run.state == RunState::Failed { format!("{name} failed") } else { format!("{name} stopped at its limit") };
            needs.entry(ws).or_default().push(Need { group: Group::Unblock, run_id: Some(run.id.clone()), what, since: run.ended_at.unwrap_or(run.last_progress_at) });
        }
        // A paused workstream waits to be resumed.
        for v in &views {
            if v.workstream.paused_reason.is_some() {
                needs.entry(Some(v.workstream.id.clone())).or_default().push(Need { group: Group::Unblock, run_id: None, what: "It is paused until you resume it".to_owned(), since: v.workstream.created_at });
            }
        }
        // Every pending draft waits for approval, a plan or description rewrite as a decision. A reply drafted to a run's
        // question is part of that question.
        for draft in &drafts {
            let workstream = draft.workstream().map(str::to_owned);
            if closed(&workstream) || matches!(draft.intent, Intent::RunAnswer { .. }) {
                continue;
            }
            let from = match &draft.origin {
                Origin::Run { run_id, .. } => Some(run_id.clone()),
                _ => None,
            };
            let (group, what) = match &draft.intent {
                Intent::Rewrite { .. } => (Group::Decide, "A description update waits for your approval".to_owned()),
                Intent::StartRun { .. } => (Group::Approve, "A run waits for you to start it".to_owned()),
                _ => match from.as_deref().and_then(|id| label_of(id, &workstream)) {
                    Some(name) => (Group::Approve, format!("{name} left a draft for you")),
                    None => (Group::Approve, "A draft waits for your approval".to_owned()),
                },
            };
            needs.entry(workstream).or_default().push(Need { group, run_id: from, what, since: draft.created_at });
        }
        let waiting: Vec<Waiting> = needs.into_iter().map(|(key, needs)| Waiting { key, needs }).collect();
        let name_of = |key: &Key| match key.as_deref() {
            None => GENERAL.to_owned(),
            Some(id) => view_of(id).map(|v| v.workstream.item_key.clone().unwrap_or_else(|| v.workstream.title.clone())).unwrap_or_else(|| "A workstream".to_owned()),
        };
        // A notice counts as told only once it is delivered, so one that fails is offered again at the next poll.
        let watching = self.notifier.watching();
        self.notices.lock().expect("notices lock poisoned").tick(now, &settings, watching, &waiting, &name_of, &mut |notice| self.notifier.announce(notice));
    }

    /// Runs that finished or were stopped lately and still have a worktree: their session may be open at its prompt, or
    /// have been carried on.
    async fn recently_finished(&self, now: DateTime<Utc>) -> Vec<Run> {
        let query = RunQuery { states: Some(vec![RunState::Done, RunState::Stopped]), ..RunQuery::default() };
        let Ok(done) = self.core.runs_list(&query).await else { return Vec::new() };
        done.into_iter().filter(|r| r.short_id.is_some() && r.worktree_removed_at.is_none() && r.ended_at.is_some_and(|at| now - at <= WATCH_FINISHED)).collect()
    }

    /// `jobs/<id>` lives under the config directory `claude auth status` reports, never a hard-coded `~/.claude`.
    pub(super) async fn claude_config_dir(&self, tc: &Toolchain) -> Option<PathBuf> {
        if let Some(known) = self.config_dir.lock().expect("config dir lock poisoned").clone() {
            return Some(known);
        }
        let found = tc.cli.auth_status().await.ok()?.config_directory?;
        *self.config_dir.lock().expect("config dir lock poisoned") = Some(found.clone());
        Some(found)
    }

    /// A run whose agent waits in its `ask` call reads as asking, with that question, whatever the session is listed as
    /// doing: it is working as far as Claude can tell. A run that ended while it waited has nobody left to answer.
    fn with_pending_ask(&self, run_id: &str, mut seen: state::Observed) -> state::Observed {
        let asks = self.core.asks();
        match (asks.question(run_id), seen.state) {
            (Some(question), RunState::Working) => {
                seen.state = RunState::NeedsAnswer;
                seen.text = Some(question);
                seen.idle_polls = 0;
            }
            (Some(_), RunState::Done | RunState::Failed | RunState::Stopped) => asks.cancel(run_id),
            _ => {}
        }
        seen
    }

    /// Applies one run's observation. Returns its connection when anything about it changed.
    /// A Review that reached Done is added to `reviewed`, for its GitHub review draft to be made once the launch lock is
    /// let go (`draft_review`).
    async fn track(&self, tc: &Toolchain, config_dir: Option<&Path>, entries: &[AgentEntry], run_id: &str, now: DateTime<Utc>, reviewed: &mut Vec<Run>) -> crate::error::Result<Option<String>> {
        let Some(before) = self.core.run(run_id).await? else { return Ok(None) };
        if before.state == RunState::Failed || before.worktree_removed_at.is_some() {
            return Ok(None);
        }
        let entry = entries.iter().find(|e| belongs_to(e, &before));
        let finished = matches!(before.state, RunState::Done | RunState::Stopped);
        if finished && !entry.is_some_and(|e| revived(e, &before, now)) {
            return Ok(None);
        }
        let short = before.short_id.clone().or_else(|| entry.and_then(|e| e.id.as_deref().and_then(ShortId::parse)));
        let job = match (entry, config_dir, &short) {
            (Some(_), Some(dir), Some(id)) => tc.cli.job(dir, id).await.ok().flatten(),
            _ => None,
        };
        let misses = self.misses.lock().expect("misses lock poisoned").get(run_id).copied().unwrap_or(0);
        let idle = self.idle_polls.lock().expect("idle polls lock poisoned").get(run_id).copied().unwrap_or(0);
        let seen = self.with_pending_ask(run_id, map_state(entry, job.as_ref(), &before, now, misses, idle));
        for (counts, n) in [(&self.misses, seen.pid_misses), (&self.idle_polls, seen.idle_polls)] {
            let mut all = counts.lock().expect("run counts lock poisoned");
            if n > 0 {
                all.insert(run_id.to_owned(), n);
            } else {
                all.remove(run_id);
            }
        }
        // A finished run is only reopened by its session working or asking again, never by anything else.
        let reopened = finished && matches!(seen.state, RunState::Working | RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked);
        if finished && !reopened {
            return Ok(None);
        }

        let mut run = before.clone();
        if let Some(entry) = entry {
            run.short_id = run.short_id.take().or(short);
            run.session_id = run.session_id.take().or_else(|| entry.session_id.clone());
        }
        if let Some(job) = &job {
            run.last_progress_at = progress_at(&before, job, now);
            run.tokens = job.tokens.or(run.tokens);
            run.last_detail = job.detail.as_deref().and_then(|d| cleaned(d, DETAIL_KEPT)).or(run.last_detail.take());
            run.branch = job.worktree_branch.clone().or(run.branch.take());
        }
        // An Unknown run restarts its unlisted clock when the reason changes, so a listed odd state doesn't count.
        let reason_changed = seen.state == RunState::Unknown && seen.error != before.error;
        if seen.state != before.state || reason_changed {
            run.state = seen.state;
            run.last_progress_at = now;
        }
        if reopened {
            run.continued_at = Some(now);
            run.ended_at = None;
            run.stopped_by_limit = false;
            run.possible_continuations.clear();
        }
        limits::tick(&mut run, now);
        run.needs = match seen.state {
            RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => seen.text.as_deref().and_then(|t| cleaned(t, NEEDS_KEPT)),
            _ => None,
        };
        run.asking = seen.state == RunState::NeedsAnswer && self.core.asks().question(run_id).is_some();
        run.suggested_reply = match seen.state {
            RunState::NeedsAnswer => job.as_ref().and_then(|j| j.suggested_reply.as_deref()).and_then(|r| cleaned(r, REPLY_KEPT)),
            _ => None,
        };
        if seen.state == RunState::Done {
            run.summary = seen.result.as_deref().and_then(|r| cleaned(r, SUMMARY_KEPT));
            let answer = self.read_answer(tc, &run, entry, job.as_ref()).await.and_then(|a| cleaned_answer(&a));
            run.result_complete = answer.is_some();
            run.result = answer.or_else(|| run.summary.clone());
        }
        run.error = matches!(seen.state, RunState::Failed | RunState::Unknown).then(|| seen.error.clone()).flatten();
        let settings = self.settings();
        let mut overrun = None;
        if let (Some(over), Some(id)) = (limits::exceeded(&run, now, &settings), run.short_id.clone()) {
            match tc.cli.stop(&id).await {
                Ok(()) => {
                    overrun = Some(over.reason(&settings));
                    run.state = RunState::Stopped;
                    run.needs = None;
                    run.asking = false;
                    run.error.clone_from(&overrun);
                    run.stopped_by_limit = true;
                    run.last_progress_at = now;
                    limits::tick(&mut run, now);
                }
                Err(e) => eprintln!("couldn't stop run {run_id} for passing a limit: {e}"),
            }
        }
        // Allow once covers the one prompt the person read: once the run is past it or asks something else, the new
        // prompt is theirs to answer again.
        if run.state != RunState::NeedsPermission || run.needs != before.needs {
            run.permission_allowed = None;
        }
        let ended = matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped);
        if ended {
            run.ended_at.get_or_insert(now);
        }

        let mut touched = false;
        if let Some(job) = &job {
            let stored = self.core.run_events(run_id).await?;
            let fresh = unseen(events_of(&run, job), stored.last());
            if !fresh.is_empty() {
                touched = self.core.append_run_events(run_id, &fresh).await? > 0;
            }
        }
        if let Some(reason) = &overrun {
            let event = RunEvent { run_id: run.id.clone(), seq: 0, at: now, kind: "limit".into(), text: reason.clone(), detail: None };
            touched |= self.core.append_run_events(run_id, &[event]).await? > 0;
        }
        if run != before {
            // Where the run is filed is the person's to change while this poll looked (Bring them here, its Undo).
            self.core.save_observed_run(&run).await?;
            touched = true;
        }
        // An answer Pip suggested has nothing left to answer once the run finished or stopped without one, or moved on
        // from the question it answers: answered in Terminal, or asking another. Each draft is held to the question the
        // run asks now, not the one it asked last poll, so a run that was unclear in between still lets go of the
        // answers to what it asked before. Only `answer` takes a run out of a question with the drafts left to it, and it
        // decides them itself. A run that is only unclear for now keeps them.
        let question = super::answer::asked(run.needs.as_deref());
        if run.state != RunState::Unknown && (run.state != before.state || question != super::answer::asked(before.needs.as_deref())) {
            let why = if ended { super::answer::NOT_ASKING } else { super::answer::MOVED_ON };
            match self.core.retire_answer_drafts_not_for(run_id, run.state == RunState::NeedsAnswer, question.as_deref(), why).await {
                Ok(0) => {}
                Ok(_) => (self.drafted)(&run.connection_id),
                Err(e) => eprintln!("couldn't retire the answers suggested for run {run_id}: {e}"),
            }
        }
        if reopened {
            if let Err(e) = self.core.report_stale(run_id).await {
                eprintln!("couldn't mark the report of run {run_id} as older than the follow-up: {e}");
            }
        }
        let drafted = if run.state == RunState::Done && before.state != RunState::Done && settings.draft_on_finish { self.draft_for(&run).await } else { None };
        if run.state == RunState::Done && before.state != RunState::Done && run.spec.kind == RunKind::Review {
            reviewed.push(run.clone());
        }
        // A workstream's build pushed its branch and opened a draft pull request; a review of it waits until a code
        // sync has found that, so one is asked for now rather than at the next interval.
        if run.state == RunState::Done && before.state != RunState::Done && run.spec.kind == RunKind::Build && run.spec.allow_push && run.spec.workstream.is_some() {
            self.core.request_code_sync();
        }
        if run.short_id != before.short_id || reopened {
            self.remember(&run);
        }
        if ended {
            if let Err(e) = self.index.mark_terminal(run_id) {
                eprintln!("couldn't update the run index: {e}");
            }
        }
        if overrun.is_some() {
            self.notify_run(&run, Attention::Limit);
        } else if run.state != before.state {
            match run.state {
                RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => self.notify_run(&run, Attention::Needs),
                // Finishing again after the person carried on is only worth a notice when it makes a draft.
                RunState::Done if before.continued_at.is_none() || drafted.is_some() => self.notify_run(&run, drafted.unwrap_or(Attention::Done)),
                RunState::Failed => self.notify_run(&run, Attention::Failed),
                _ => {}
            }
        }
        Ok(touched.then(|| run.connection_id.clone()))
    }

    /// The drafts a finished run leaves: a comment on its ticket and, for a Triage, its proposed breakdown, for a Plan the
    /// description update that adds its plan; or a new ticket when it has none. A Review's GitHub review draft is made
    /// apart (`draft_review`). `None` when nothing was made. A failure is only logged: the run's result is already
    /// saved, and the sheet's own button still drafts it.
    pub(super) async fn draft_for(&self, run: &Run) -> Option<Attention> {
        let mut why = None;
        if run.item.is_some() {
            if self.logged(run, self.core.auto_draft_run_triage(&run.id).await) {
                why = Some(Attention::Drafted);
            }
            if self.logged(run, self.core.draft_run_subtasks(&run.id).await) {
                why = Some(Attention::Breakdown);
            }
            if run.spec.kind == RunKind::Plan && self.logged(run, self.core.auto_draft_run_plan_description(&run.id).await) {
                why = Some(Attention::PlanDrafted);
            }
        } else if self.logged(run, self.core.auto_draft_run_ticket(&run.id).await) {
            why = Some(Attention::DraftedTicket);
        }
        if why.is_some() {
            (self.drafted)(&run.connection_id);
        }
        why
    }

    /// The GitHub review draft a finished Review leaves, which only the person's approval posts. It is made whatever
    /// `draft_on_finish` says, since nothing else makes one: it writes nothing anywhere until then. It reads the pull
    /// request, so it is never called with the launch lock held. A failure is only logged.
    pub(super) async fn draft_review(&self, run: &Run) {
        if self.logged(run, self.core.auto_draft_run_review(&run.id).await) {
            (self.drafted)(&run.connection_id);
        }
    }

    fn logged(&self, run: &Run, made: crate::error::Result<Option<crate::domain::Proposal>>) -> bool {
        made.unwrap_or_else(|e| {
            eprintln!("couldn't draft from run {}: {e}", run.id);
            None
        })
        .is_some()
    }

    pub async fn events(&self, run_id: &str) -> crate::error::Result<Vec<RunEvent>> {
        self.core.run_events(run_id).await
    }
}

#[cfg(test)]
mod tests;
