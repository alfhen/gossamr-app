//! A conversation that went on under a new session id.
//!
//! Claude keeps a resumed session's id, but a session can still end up listed under another one (a copy, or work the
//! person restarted themselves). A run that has stopped or finished takes such a session over only when the link is
//! certain: the same title Gossamr gave it, started after the run last made progress, in the run's own worktree, no
//! other run's, and the only one that fits. Anything less is offered to the person instead.

use std::collections::HashSet;
use std::path::Path;

use chrono::{DateTime, Utc};

use super::cli::{AgentEntry, ShortId};
use super::service::{real, title_of, RunService};
use super::tracker::revived;
use crate::domain::{Continuation, EarlierSession, Run, RunQuery, RunState};
use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Candidate {
    pub short_id: ShortId,
    pub session_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    /// Listed in the run's own worktree, not only in its clone.
    pub in_worktree: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Link {
    Adopt(Candidate),
    Offer(Vec<Candidate>),
    Nothing,
}

pub(super) fn at_rest(run: &Run) -> bool {
    matches!(run.state, RunState::Done | RunState::Stopped)
}

/// The listed sessions that could be `run` carried on. `taken` holds every session id any run has or had.
pub(super) fn candidates(run: &Run, entries: &[AgentEntry], taken: &HashSet<ShortId>) -> Vec<Candidate> {
    let title = title_of(run);
    let (worktree, clone) = (real(&run.expected_worktree), real(&run.spec.clone_path));
    entries
        .iter()
        .filter_map(|e| {
            let short_id = e.id.as_deref().and_then(ShortId::parse).filter(|id| !taken.contains(id))?;
            if e.kind.as_deref() != Some("background") || e.name.as_deref() != Some(title.as_str()) {
                return None;
            }
            let started_at = DateTime::from_timestamp_millis(e.started_at?).filter(|at| *at > run.last_progress_at)?;
            let cwd = real(Path::new(e.cwd.as_deref()?));
            let in_worktree = cwd == worktree;
            (in_worktree || cwd == clone).then(|| Candidate { short_id, session_id: e.session_id.clone(), started_at: Some(started_at), in_worktree })
        })
        .collect()
}

/// What to do with the candidates. Never an adoption when one is not alone, when it is only in the clone, or while a
/// launch is still unresolved, since a session that is just starting is listed in the clone first.
pub(super) fn link(mut found: Vec<Candidate>, launch_pending: bool) -> Link {
    match (found.len(), found.first()) {
        (0, _) => Link::Nothing,
        (1, Some(only)) if only.in_worktree && !launch_pending => Link::Adopt(found.remove(0)),
        _ => Link::Offer(found),
    }
}

/// The run carries on in `to`: the old session stays as an alias, and the state is the live session's from the next look.
pub(super) fn take_over(run: &mut Run, to: &Candidate, now: DateTime<Utc>) {
    if let Some(old) = run.short_id.take().filter(|old| *old != to.short_id) {
        run.earlier_sessions.push(EarlierSession { short_id: old, session_id: run.session_id.take(), removed: false });
    }
    run.short_id = Some(to.short_id.clone());
    run.session_id.clone_from(&to.session_id);
    run.state = RunState::Working;
    run.needs = None;
    run.suggested_reply = None;
    run.error = None;
    run.failure = None;
    run.ended_at = None;
    run.stopped_by_limit = false;
    run.continued_at = Some(now);
    run.last_progress_at = now;
    run.possible_continuations.clear();
}

/// The run's own session is live again, so there is nothing to hand over to another.
fn carried_on(entries: &[AgentEntry], run: &Run, now: DateTime<Utc>) -> bool {
    entries.iter().any(|e| e.id.as_deref() == run.short_id.as_ref().map(ShortId::as_str) && revived(e, run, now))
}

fn offered(found: &[Candidate]) -> Vec<Continuation> {
    found.iter().map(|c| Continuation { short_id: c.short_id.clone(), session_id: c.session_id.clone(), started_at: c.started_at }).collect()
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

impl RunService {
    /// Every session id any run of this account has or had, and any the run index knows.
    async fn taken_ids(&self) -> Option<(HashSet<ShortId>, bool)> {
        let all = self.core.runs_list(&RunQuery::default()).await.ok()?;
        let mut taken = self.index.short_ids();
        taken.extend(all.iter().flat_map(Run::session_ids));
        let launch_pending = all.iter().any(|r| r.short_id.is_none() && matches!(r.state, RunState::Queued | RunState::Launching));
        Some((taken, launch_pending))
    }

    /// For runs at rest: takes over the one session that is certainly their continuation, and records the ones that
    /// might be on the run for the person to decide. Called with the launch lock held. Returns the connections that changed.
    pub(super) async fn adopt_continuations(&self, entries: &[AgentEntry], resting: &[Run], now: DateTime<Utc>) -> Vec<String> {
        let mut changed = Vec::new();
        if resting.is_empty() {
            return changed;
        }
        let Some((mut taken, launch_pending)) = self.taken_ids().await else { return changed };
        for listed in resting {
            let Ok(Some(mut run)) = self.core.run(&listed.id).await else { continue };
            if !at_rest(&run) || run.worktree_removed_at.is_some() || carried_on(entries, &run, now) {
                continue;
            }
            let found = candidates(&run, entries, &taken);
            match link(found.clone(), launch_pending) {
                Link::Adopt(to) => {
                    take_over(&mut run, &to, now);
                    taken.insert(to.short_id);
                    self.reset_counts(&run.id);
                    self.remember(&run);
                }
                Link::Offer(_) | Link::Nothing if run.possible_continuations == offered(&found) => continue,
                Link::Offer(_) | Link::Nothing => run.possible_continuations = offered(&found),
            }
            match self.core.save_run(&run).await {
                Ok(()) => changed.push(run.connection_id.clone()),
                Err(e) => eprintln!("couldn't record the continuation of run {}: {e}", run.id),
            }
        }
        changed
    }

    /// The person's choice of one listed session as this run's continuation. It must still pass every check but being
    /// the only one.
    pub async fn adopt_session(&self, run_id: &str, session: &str) -> Result<Run> {
        self.ensure_enabled()?;
        let id = ShortId::parse(session).ok_or_else(|| refuse("That isn't a session id."))?;
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if !at_rest(&run) {
            return Err(refuse(format!("This run is {}, so it has no other session to carry on in.", run.state.as_str())));
        }
        let tc = self.toolchain().await?;
        let entries = tc.cli.agents(true).await?;
        let now = Utc::now();
        if carried_on(&entries, &run, now) {
            return Err(refuse("This run's own session is working again, so it stays with that one."));
        }
        let (taken, _) = self.taken_ids().await.ok_or_else(|| refuse("Couldn't read the runs to compare."))?;
        let chosen = candidates(&run, &entries, &taken).into_iter().find(|c| c.short_id == id);
        let chosen = chosen.ok_or_else(|| refuse("That session doesn't look like this run's any more. Look again in a moment."))?;
        take_over(&mut run, &chosen, now);
        self.reset_counts(&run.id);
        self.remember(&run);
        self.store(&run).await?;
        Ok(run)
    }
}

#[cfg(test)]
mod tests;
