//! Keeps the signed-in account's runs current from `claude agents`, records what they do, and tells the person when
//! one needs them.
//!
//! The public listing decides each run's state; a job's `state.json` and timeline only supply words, and everything
//! taken from them is redacted and capped before it is stored. Sessions that match no run are ignored.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use super::cli::{AgentEntry, JobInfo, ShortId};
use super::redact::redact;
use super::service::{belongs_to, RunService};
use super::state::{self, map_state, parse_at, progress_at};
use super::toolchain::Toolchain;
use crate::domain::{Run, RunEvent, RunQuery, RunState};
use crate::notify::Notice;

pub const POLL_BUSY: Duration = Duration::from_secs(4);
pub const POLL_IDLE: Duration = Duration::from_secs(30);
/// Focusing the window this soon after a notification opens the run it was about.
pub const OPEN_WINDOW: Duration = Duration::from_secs(30);

const NEEDS_KEPT: usize = 500;
const DETAIL_KEPT: usize = 500;
const EVENT_TEXT_KEPT: usize = 500;
const EVENT_DETAIL_KEPT: usize = 2_048;
const RESULT_KEPT: usize = 20_000;

/// Why a run is worth interrupting for. Being quiet is not one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attention {
    Needs,
    Done,
    Failed,
}

pub trait RunNotifier: Send + Sync {
    fn notify(&self, run: &Run, why: Attention);
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

fn cleaned(s: &str, max: usize) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| cut(&redact(s), max))
}

/// The timeline as events, in order. Redacted and cut here, so a line compares equal to the event stored from it.
fn events_of(run: &Run, job: &JobInfo) -> Vec<RunEvent> {
    let mut at = run.launched_at.unwrap_or(run.queued_at);
    job.timeline
        .iter()
        .filter_map(|line| {
            // A line without a time keeps the last line's, so the same timeline always gives the same events.
            at = line.at.as_deref().and_then(parse_at).unwrap_or(at);
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
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub async fn poll(&self) -> Polled {
        self.poll_at(Utc::now()).await
    }

    /// One look at `claude agents` for every unfinished run of the signed-in account.
    pub async fn poll_at(&self, now: DateTime<Utc>) -> Polled {
        let idle = Polled { busy: false };
        if !self.enabled {
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
        if runs.is_empty() {
            return idle;
        }
        let busy = runs.iter().any(|r| r.state != RunState::Queued);
        let Ok(tc) = self.tools.get().await else { return Polled { busy } };
        let Ok(entries) = tc.cli.agents(true).await else { return Polled { busy } };
        let config_dir = self.claude_config_dir(&tc).await;

        let _turn = self.launching.lock().await;
        let mut changed = HashSet::new();
        for listed in &runs {
            match self.track(&tc, config_dir.as_deref(), &entries, &listed.id, now).await {
                Ok(Some(connection_id)) => {
                    changed.insert(connection_id);
                }
                Ok(None) => {}
                Err(e) => eprintln!("couldn't track run {}: {e}", listed.id),
            }
        }
        changed.iter().for_each(|c| (self.changed)(c));
        Polled { busy }
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
    async fn track(&self, tc: &Toolchain, config_dir: Option<&Path>, entries: &[AgentEntry], run_id: &str, now: DateTime<Utc>) -> crate::error::Result<Option<String>> {
        let Some(before) = self.core.run(run_id).await? else { return Ok(None) };
        if matches!(before.state, RunState::Done | RunState::Failed | RunState::Stopped) {
            return Ok(None);
        }
        let entry = entries.iter().find(|e| belongs_to(e, &before));
        let short = before.short_id.clone().or_else(|| entry.and_then(|e| e.id.as_deref().and_then(ShortId::parse)));
        let job = match (entry, config_dir, &short) {
            (Some(_), Some(dir), Some(id)) => tc.cli.job(dir, id).await.ok().flatten(),
            _ => None,
        };
        let misses = self.misses.lock().expect("misses lock poisoned").get(run_id).copied().unwrap_or(0);
        let seen = map_state(entry, job.as_ref(), &before, now, misses);
        {
            let mut all = self.misses.lock().expect("misses lock poisoned");
            if seen.pid_misses > 0 {
                all.insert(run_id.to_owned(), seen.pid_misses);
            } else {
                all.remove(run_id);
            }
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
        run.needs = match seen.state {
            RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => seen.text.as_deref().and_then(|t| cleaned(t, NEEDS_KEPT)),
            _ => None,
        };
        if seen.state == RunState::Done {
            run.result = seen.result.as_deref().and_then(|r| cleaned(r, RESULT_KEPT));
        }
        run.error = matches!(seen.state, RunState::Failed | RunState::Unknown).then(|| seen.error.clone()).flatten();
        let ended = matches!(seen.state, RunState::Done | RunState::Failed | RunState::Stopped);
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
        if run != before {
            self.core.save_run(&run).await?;
            touched = true;
        }
        if run.short_id != before.short_id {
            self.remember(&run);
        }
        if ended {
            if let Err(e) = self.index.mark_terminal(run_id) {
                eprintln!("couldn't update the run index: {e}");
            }
        }
        if run.state != before.state {
            match run.state {
                RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked => self.notifier.notify(&run, Attention::Needs),
                RunState::Done => self.notifier.notify(&run, Attention::Done),
                RunState::Failed => self.notifier.notify(&run, Attention::Failed),
                _ => {}
            }
        }
        Ok(touched.then(|| run.connection_id.clone()))
    }

    pub async fn events(&self, run_id: &str) -> crate::error::Result<Vec<RunEvent>> {
        self.ensure_enabled()?;
        self.core.run_events(run_id).await
    }
}

#[cfg(test)]
mod tests;
