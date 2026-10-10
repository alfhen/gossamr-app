//! Keeps the signed-in account's runs current from `claude agents`, records what they do, and tells the person when
//! one needs them.
//!
//! The public listing decides each run's state; a job's `state.json` and timeline only supply words, and everything
//! taken from them is redacted and capped before it is stored. Sessions that match no run are ignored.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Timelike, Utc};

use super::limits;
use super::cli::{AgentEntry, JobInfo, ShortId};
use super::redact::redact;
use super::service::{belongs_to, RunService};
use super::state::{self, map_state, parse_at, progress_at};
use super::toolchain::Toolchain;
use crate::domain::{Run, RunEvent, RunKind, RunQuery, RunState};
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

const NEEDS_KEPT: usize = 500;
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
    fn notify(&self, run: &Run, why: Attention);
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
        self.poll_with(Utc::now).await
    }

    /// One look at `claude agents` for every unfinished run of the signed-in account, at the time `now`.
    pub async fn poll_at(&self, now: DateTime<Utc>) -> Polled {
        self.poll_with(|| now).await
    }

    /// The listing is read and applied while holding the launch lock, with the time taken after the lock was won. A
    /// listing read before waiting for it can predate an answer that stops and wakes a session, and applying it
    /// afterwards puts the run back to `Stopped`.
    async fn poll_with(&self, clock: impl Fn() -> DateTime<Utc>) -> Polled {
        let idle = Polled { busy: false };
        let now = clock();
        if !self.is_enabled() {
            return idle;
        }
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
        let seen = map_state(entry, job.as_ref(), &before, now, misses, idle);
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
                    run.error.clone_from(&overrun);
                    run.stopped_by_limit = true;
                    run.last_progress_at = now;
                    limits::tick(&mut run, now);
                }
                Err(e) => eprintln!("couldn't stop run {run_id} for passing a limit: {e}"),
            }
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
            self.core.save_run(&run).await?;
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
            self.notifier.notify(&run, Attention::Limit);
        } else if run.state != before.state {
            match run.state {
                RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => self.notifier.notify(&run, Attention::Needs),
                // Finishing again after the person carried on is only worth a notice when it makes a draft.
                RunState::Done if before.continued_at.is_none() || drafted.is_some() => self.notifier.notify(&run, drafted.unwrap_or(Attention::Done)),
                RunState::Failed => self.notifier.notify(&run, Attention::Failed),
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
            if self.logged(run, self.core.auto_draft_run_comment(&run.id).await) {
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
        self.ensure_enabled()?;
        self.core.run_events(run_id).await
    }
}

#[cfg(test)]
mod tests;
