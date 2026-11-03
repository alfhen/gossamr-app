//! Keeps the signed-in account's runs current from `claude agents`, records what they do, and tells the person when
//! one needs them.
//!
//! The public listing decides each run's state; a job's `state.json` and timeline only supply words, and everything
//! taken from them is redacted and capped before it is stored. Sessions that match no run are ignored.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Timelike, Utc};

use super::notices::{stuck_runs, Key, Need, Outgoing, Settings as NoticeSettings, Waiting, GENERAL};
use super::backend::{Observation, Watched};
use super::cli::TimelineLine;
use super::redact::redact;
use super::service::RunService;
use super::state::{self, parse_at};
use crate::db::connection_of;
use crate::domain::{Intent, Origin, ProposalQuery, ProposalState, Run, RunEvent, RunQuery, RunState, StateKind};
use crate::notify::Notice;

pub const POLL_BUSY: Duration = Duration::from_secs(4);
pub const POLL_IDLE: Duration = Duration::from_secs(30);
/// A finished run is watched this long after it ended, in case its session is still open and the person carries on.
const WATCH_FINISHED: chrono::Duration = chrono::Duration::hours(6);
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
    Failed,
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
fn events_of(run: &Run, timeline: &[TimelineLine]) -> Vec<RunEvent> {
    let mut at = run.launched_at.unwrap_or(run.queued_at);
    timeline
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
        self.deliver_queued().await;
        self.announce_notices(Utc::now()).await;
        polled
    }

    /// One look at `claude agents` for every unfinished run of the signed-in account, at the time `now`.
    pub async fn poll_at(&self, now: DateTime<Utc>) -> Polled {
        let polled = self.poll_with(|| now).await;
        self.deliver_queued().await;
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
        let Ok(runs) = self.core.runs_list(&RunQuery { states: Some(RunState::UNFINISHED.to_vec()), ..RunQuery::default() }).await else { return idle };
        let waiting = self.awaiting_answer(now).await;
        let finished = self.recently_finished(now).await;
        if runs.is_empty() && waiting.is_empty() && finished.is_empty() {
            return idle;
        }
        // A run waiting for a slot counts: the next look should be soon, so it starts promptly once one frees.
        let mut busy = runs.iter().any(|r| r.state != RunState::Queued || r.slot_wait_since.is_some()) || !waiting.is_empty();
        let mut waiting_by_instance: BTreeMap<&str, Vec<Run>> = BTreeMap::new();
        for run in &waiting {
            waiting_by_instance.entry(run.instance_id()).or_default().push(run.clone());
        }
        for group in waiting_by_instance.into_values() {
            if let Ok(tc) = self.observing_toolchain_of(&group[0]).await {
                self.collect_answers(&tc, &group).await;
            }
        }

        let turn = self.launching.lock().await;
        let now = clock();
        let mut by_instance: BTreeMap<&str, Vec<&Run>> = BTreeMap::new();
        for run in runs.iter().filter(|r| r.state != RunState::Queued || r.short_id.is_some()).chain(&finished) {
            by_instance.entry(run.instance_id()).or_default().push(run);
        }
        let mut changed = HashSet::new();
        for group in by_instance.into_values() {
            let Ok(tc) = self.observing_toolchain_of(group[0]).await else { continue };
            let dirs = self.folders_of(&tc).await;
            let mut watched = self.watched(&group).await;
            let Ok(mut seen) = tc.backend.observe(&watched, &dirs, now).await else { continue };
            let resting: Vec<Run> = group.iter().filter(|r| finished.iter().any(|f| f.id == r.id)).map(|r| (*r).clone()).collect();
            busy |= resting.iter().any(|r| seen.runs.iter().any(|o| o.run_id == r.id && o.revived));
            let adopted = self.adopt_continuations(&tc.instance_id, &seen.sessions, &resting, now).await;
            if !adopted.is_empty() {
                // A run taken over by a continuation is looked at again as its new session.
                watched = self.watched(&group).await;
                seen.runs = tc.backend.observe(&watched, &dirs, now).await.map(|again| again.runs).unwrap_or_default();
            }
            changed.extend(adopted);
            for w in watched {
                let Some(obs) = seen.runs.iter().find(|o| o.run_id == w.run.id) else { continue };
                match self.track(w.run, obs, now).await {
                    Ok(Some(connection_id)) => {
                        changed.insert(connection_id);
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("couldn't track run {}: {e}", obs.run_id),
                }
            }
        }
        drop(turn);
        changed.iter().for_each(|c| (self.changed)(c));
        Polled { busy }
    }

    /// Tells the notifier a run's news. A need is found by `announce_notices` from what waits, not from this call.
    pub(super) fn notify_run(&self, run: &Run, why: Attention) {
        self.notifier.notify(run, why);
    }

    /// Looks at everything that waits on the person and sends the system notifications that are due (`notices`).
    pub(super) async fn announce_notices(&self, now: DateTime<Utc>) {
        let settings = self.settings();
        let settings = NoticeSettings { mode: settings.notifications };
        let asking = [RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked];
        let Ok(runs) = self.core.runs_list(&RunQuery { states: Some(asking.to_vec()), ..RunQuery::default() }).await else { return };
        let Ok(drafts) = self.core.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..ProposalQuery::default() }).await else { return };
        let drafts: Vec<_> = drafts.into_iter().filter(|p| p.state == ProposalState::Pending && p.superseded_by.is_none() && !matches!(&p.intent, Intent::StartRun { .. } | Intent::FollowUp { .. } | Intent::RunAnswer { .. })).collect();
        // The open workstreams give names, run labels and pauses; the closed ones are only told apart by id,
        // so what belongs to one is skipped without loading it. Each connection is asked for its own.
        let scopes = self.core.scopes().await;
        if scopes.is_empty() {
            return;
        }
        let (mut views, mut closed_ids) = (Vec::new(), HashSet::new());
        for scope in &scopes {
            views.extend(self.core.workstreams(scope, false).await.unwrap_or_default());
            closed_ids.extend(self.core.closed_workstream_ids(scope).await.unwrap_or_default());
        }
        // The connection each item belongs to, because which items were announced is kept in that connection's cache.
        let mut owners: HashMap<String, String> = HashMap::new();
        let view_of = |id: &str| views.iter().find(|v| v.workstream.id == id);
        // What belongs to a closed workstream counts under General, as `needs()` in `src/lib/needs.ts` files it.
        let place = |id: &Option<String>| id.clone().filter(|id| !closed_ids.contains(id));
        let label_of = |id: &str, ws: &Option<String>| ws.as_deref().and_then(view_of).and_then(|v| v.labels.iter().find(|(run, _)| run == id)).map(|(_, l)| l.clone());
        let mut needs: BTreeMap<Key, Vec<Need>> = BTreeMap::new();
        // A run's question, permission prompt or sign-in. The state is in the key: a run that asks again another way is new.
        for run in &runs {
            let ws = place(&run.spec.workstream);
            let name = label_of(&run.id, &ws).unwrap_or_else(|| topic(run).to_owned());
            let what = match run.state {
                RunState::NeedsPermission => format!("{name} wants to run a command"),
                RunState::SystemBlocked => format!("{name} needs you to sign in"),
                _ => match run.needs.as_deref().map(|n| cut(&n.split_whitespace().collect::<Vec<_>>().join(" "), 100)).filter(|n| !n.is_empty()) {
                    Some(question) => format!("{name} asks: {question}"),
                    None => format!("{name} has a question"),
                },
            };
            owners.insert(format!("run:{}:{:?}", run.id, run.state), run.connection_id.clone());
            needs.entry(ws).or_default().push(Need { key: format!("run:{}:{:?}", run.id, run.state), run_id: Some(run.id.clone()), what, since: run.last_progress_at });
        }
        // A failure is stuck until dealt with, but only the latest run of its kind on its ticket.
        let Ok(all) = self.core.runs_list(&RunQuery::default()).await else { return };
        for run in stuck_runs(&all, now) {
            let ws = place(&run.spec.workstream);
            let name = label_of(&run.id, &ws).unwrap_or_else(|| topic(run).to_owned());
            let what = format!("{name} failed");
            owners.insert(format!("run:{}:failed", run.id), run.connection_id.clone());
            needs.entry(ws).or_default().push(Need { key: format!("run:{}:failed", run.id), run_id: Some(run.id.clone()), what, since: run.ended_at.unwrap_or(run.last_progress_at) });
        }
        // A paused workstream waits to be resumed.
        for v in &views {
            if v.workstream.paused_reason.is_some() {
                owners.insert(format!("paused:{}", v.workstream.id), v.workstream.connection_id.clone());
                needs.entry(Some(v.workstream.id.clone())).or_default().push(Need { key: format!("paused:{}", v.workstream.id), run_id: None, what: "It is paused until you resume it".to_owned(), since: v.workstream.created_at });
            }
        }
        // A question Pip asked the person.
        for v in &views {
            if let Some(ask) = &v.pip_ask {
                owners.insert(format!("pip-ask:{}:{}", v.workstream.id, ask.at.timestamp_micros()), v.workstream.connection_id.clone());
                let what = format!("Pip asks: {}", cut(&ask.question.split_whitespace().collect::<Vec<_>>().join(" "), 100));
                needs.entry(Some(v.workstream.id.clone())).or_default().push(Need { key: format!("pip-ask:{}:{}", v.workstream.id, ask.at.timestamp_micros()), run_id: None, what, since: ask.at });
            }
        }
        // Every pending draft waits for approval.
        for draft in &drafts {
            let workstream = place(&draft.workstream().map(str::to_owned));
            let from = match &draft.origin {
                Origin::Run { run_id, .. } => Some(run_id.clone()),
                _ => None,
            };
            let what = match &draft.intent {
                Intent::Rewrite { .. } => "A description update waits for your approval".to_owned(),
                _ => match from.as_deref().and_then(|id| label_of(id, &workstream)) {
                    Some(name) => format!("{name} left a draft for you"),
                    None => "A draft waits for your approval".to_owned(),
                },
            };
            owners.insert(format!("draft:{}", draft.id), connection_of(draft));
            needs.entry(workstream).or_default().push(Need { key: format!("draft:{}", draft.id), run_id: from, what, since: draft.created_at });
        }
        let waiting: Vec<Waiting> = needs.into_iter().map(|(key, needs)| Waiting { key, needs }).collect();
        let name_of = |key: &Key| match key.as_deref() {
            None => GENERAL.to_owned(),
            Some(id) => view_of(id).map(|v| v.workstream.item_key.clone().unwrap_or_else(|| v.workstream.title.clone())).unwrap_or_else(|| "A workstream".to_owned()),
        };
        // A notice counts as told only once it is delivered, so one that fails is offered again at the next poll. What was
        // told is kept, so a restart announces only what is new since.
        let watching = self.notifier.watching();
        if !self.notices.lock().expect("notices lock poisoned").restored() {
            let mut record: Option<BTreeSet<String>> = None;
            for scope in &scopes {
                if let Some(kept) = self.core.announced_needs(scope).await.unwrap_or_default() {
                    record.get_or_insert_with(BTreeSet::new).extend(kept);
                }
            }
            self.notices.lock().expect("notices lock poisoned").restore(record, &waiting);
        }
        let (before, after) = {
            let mut board = self.notices.lock().expect("notices lock poisoned");
            let before = board.seen().clone();
            board.tick(&settings, watching, &waiting, &name_of, &mut |notice| self.notifier.announce(notice));
            (before, board.seen().clone())
        };
        if before != after {
            // A key owned by no Jira scope (a review draft with no ticket goes by the code host) is kept with the primary.
            let home = self.core.primary().await.map_or_else(|_| scopes[0].connection_id.clone(), |p| p.scope.connection_id);
            let home_of = |key: &String| owners.get(key).filter(|owner| scopes.iter().any(|s| &s.connection_id == *owner)).cloned().unwrap_or_else(|| home.clone());
            for scope in &scopes {
                let mine: BTreeSet<String> = after.iter().filter(|key| home_of(key) == scope.connection_id).cloned().collect();
                if let Err(e) = self.core.remember_announced_needs(scope, &mine).await {
                    eprintln!("couldn't keep which items were announced: {e}");
                }
            }
        }
    }

    /// Runs that finished or were stopped lately and still have a worktree: their session may be open at its prompt, or
    /// have been carried on.
    async fn recently_finished(&self, now: DateTime<Utc>) -> Vec<Run> {
        let query = RunQuery { states: Some(vec![RunState::Done, RunState::Stopped]), ..RunQuery::default() };
        let Ok(done) = self.core.runs_list(&query).await else { return Vec::new() };
        done.into_iter().filter(|r| r.short_id.is_some() && r.worktree_removed_at.is_none() && r.ended_at.is_some_and(|at| now - at <= WATCH_FINISHED)).collect()
    }

    /// The runs of `group` as they are now, with what earlier looks counted. A failed run and one whose worktree is gone
    /// are left out.
    async fn watched(&self, group: &[&Run]) -> Vec<Watched> {
        let mut out = Vec::new();
        for listed in group {
            let run = match self.core.run(&listed.id).await {
                Ok(Some(run)) => run,
                Ok(None) => continue,
                Err(e) => {
                    eprintln!("couldn't track run {}: {e}", listed.id);
                    continue;
                }
            };
            if run.state == RunState::Failed || run.worktree_removed_at.is_some() {
                continue;
            }
            let misses = self.misses.lock().expect("misses lock poisoned").get(&run.id).copied().unwrap_or(0);
            let idle = self.idle_polls.lock().expect("idle polls lock poisoned").get(&run.id).copied().unwrap_or(0);
            let ask = self.core.asks().question(&run.id);
            out.push(Watched { run, misses, idle, ask });
        }
        out
    }

    #[cfg(test)]
    pub(super) async fn claude_config_dir(&self, tc: &super::toolchain::Toolchain) -> Option<std::path::PathBuf> {
        self.folders_of(tc).await.config_dir
    }

    /// A run whose agent waits in its `ask` call reads as asking, whatever backend watches it. A run that ended while
    /// it waited has nobody left to answer.
    async fn with_pending_ask(&self, run: &Run, seen: state::Observed) -> state::Observed {
        let question = self.core.asks().question(&run.id);
        if question.is_some() && matches!(seen.state, RunState::Done | RunState::Failed | RunState::Stopped) {
            self.end_ask(run).await;
        }
        state::with_ask(seen, question.as_deref())
    }

    /// Applies one run's observation to `before`, the run as it is now. Returns its connection when anything about it
    /// changed.
    async fn track(&self, before: Run, obs: &Observation, now: DateTime<Utc>) -> crate::error::Result<Option<String>> {
        let run_id = before.id.as_str();
        let finished = matches!(before.state, RunState::Done | RunState::Stopped);
        let seen = self.with_pending_ask(&before, obs.seen.clone()).await;
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
        if let Some(session) = &obs.session {
            run.short_id = run.short_id.take().or_else(|| Some(session.short_id.clone()));
            run.session_id = run.session_id.take().or_else(|| session.session_id.clone());
        }
        run.last_progress_at = obs.progress_at.unwrap_or(run.last_progress_at);
        run.tokens = obs.tokens.or(run.tokens);
        run.last_detail = obs.detail.as_deref().and_then(|d| cleaned(d, DETAIL_KEPT)).or(run.last_detail.take());
        run.branch = obs.branch.clone().or(run.branch.take());
        // An Unknown run restarts its unlisted clock when the reason changes, so a listed odd state doesn't count.
        let reason_changed = seen.state == RunState::Unknown && seen.error != before.error;
        if seen.state != before.state || reason_changed {
            run.state = seen.state;
            run.last_progress_at = now;
        }
        if reopened {
            run.continued_at = Some(now);
            run.ended_at = None;
            run.possible_continuations.clear();
        }
        run.needs = match seen.state {
            RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => seen.text.as_deref().and_then(|t| cleaned(t, NEEDS_KEPT)),
            _ => None,
        };
        run.asking = seen.state == RunState::NeedsAnswer && self.core.asks().question(run_id).is_some();
        run.suggested_reply = match seen.state {
            RunState::NeedsAnswer => obs.suggested_reply.as_deref().and_then(|r| cleaned(r, REPLY_KEPT)),
            _ => None,
        };
        if seen.state == RunState::Done {
            run.summary = seen.result.as_deref().and_then(|r| cleaned(r, SUMMARY_KEPT));
            let answer = obs.answer.as_deref().and_then(cleaned_answer);
            run.result_complete = answer.is_some();
            run.result = answer.or_else(|| run.summary.clone());
        }
        run.error = matches!(seen.state, RunState::Failed | RunState::Unknown).then(|| seen.error.clone()).flatten();
        let ended = matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped);
        if ended {
            run.ended_at.get_or_insert(now);
        }

        let mut touched = false;
        if !obs.timeline.is_empty() {
            let stored = self.core.run_events(run_id).await?;
            let fresh = unseen(events_of(&run, &obs.timeline), stored.last());
            if !fresh.is_empty() {
                touched = self.core.append_run_events(run_id, &fresh).await? > 0;
            }
        }
        if run != before {
            // Where the run is filed is the person's to change while this poll looked (Bring them here, its Undo).
            self.core.save_observed_run(&run).await?;
            touched = true;
        }
        if reopened {
            if let Err(e) = self.core.report_stale(run_id).await {
                eprintln!("couldn't mark the report of run {run_id} as older than the follow-up: {e}");
            }
        }
        // A workstream's build pushed its branch and opened a draft pull request; a review of it waits until a code
        // sync has found that, so one is asked for now rather than at the next interval.
        if run.state == RunState::Done && before.state != RunState::Done && run.spec.workstream.is_some() {
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
        if run.state != before.state {
            match run.state {
                RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => self.notify_run(&run, Attention::Needs),
                RunState::Done if before.continued_at.is_none() => self.notify_run(&run, Attention::Done),
                RunState::Failed => self.notify_run(&run, Attention::Failed),
                _ => {}
            }
        }
        Ok(touched.then(|| run.connection_id.clone()))
    }

    pub async fn events(&self, run_id: &str) -> crate::error::Result<Vec<RunEvent>> {
        self.core.run_events(run_id).await
    }
}

#[cfg(test)]
mod tests;
