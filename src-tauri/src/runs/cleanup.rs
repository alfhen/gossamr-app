//! Removing the worktree of a finished run with `claude rm`, which refuses work that was never pushed.

use chrono::Utc;
use serde::Serialize;

use super::cli::{CliError, ShortId};
use super::failure::Failure;
use super::service::{belongs_to, RunService};
use crate::domain::{Run, RunState};
use crate::error::{Error, Result};

const LOCK_RETRIES: u32 = 6;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Cleanup {
    Removed,
    /// Claude's own explanation, unchanged.
    Refused { message: String },
}

/// A run that is over and still has something to remove: its worktree, or an earlier session that was kept.
pub fn cleanable(run: &Run) -> bool {
    matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown) && run.short_id.is_some() && (run.worktree_removed_at.is_none() || !run.leftover_sessions().is_empty())
}

/// `claude rm` straight after `claude stop` is refused while Claude's lock names a process that is still exiting, for
/// about four seconds. A refusal about unpushed work is final.
pub(super) fn lock_refusal(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    !text.contains("unpushed") && (text.contains("lock") || text.contains("still running"))
}

/// `claude rm` saying the session is not there. The wording is not documented, so this only recognises the usual phrasings;
/// anything else is kept as a refusal and retried by the next clean up.
fn absent_refusal(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    ["no session", "no such", "not found", "unknown session", "does not exist", "doesn't exist", "already removed"].iter().any(|phrase| text.contains(phrase))
}

enum Removal {
    Gone,
    /// Claude's own words.
    Refused(String),
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// Marks a run as being cleaned up until dropped, on every way out of `cleanup`.
struct Cleaning<'a>(&'a RunService, String);

impl Drop for Cleaning<'_> {
    fn drop(&mut self) {
        self.0.cleaning.lock().expect("cleaning lock poisoned").remove(&self.1);
    }
}

impl RunService {
    /// The ids the listing gives sessions of a finished run that are still open at their prompt. One holds the
    /// worktree's lock, which `claude rm` refuses until it is stopped, and after a resume it can differ from the stored
    /// id. The run's earlier sessions are looked at too.
    async fn live_sessions(&self, tc: &super::toolchain::Toolchain, run: &Run) -> Vec<ShortId> {
        let Ok(entries) = tc.cli.agents(true).await else { return Vec::new() };
        let ours = run.session_ids();
        entries
            .iter()
            .filter(|e| e.pid.is_some() && (belongs_to(e, run) || e.id.as_deref().and_then(ShortId::parse).is_some_and(|id| ours.contains(&id))))
            .filter_map(|e| e.id.as_deref().and_then(ShortId::parse))
            .collect()
    }

    /// `claude rm` on one session, retried while Claude's lock on a just-stopped worktree clears. A session that is
    /// already gone counts as removed.
    async fn remove_session(&self, tc: &super::toolchain::Toolchain, id: &ShortId) -> Result<Removal> {
        let mut tries = 0;
        loop {
            match tc.cli.rm(id).await {
                Ok(()) => return Ok(Removal::Gone),
                Err(CliError::Failed { stderr, .. }) if tries < LOCK_RETRIES && lock_refusal(&stderr) => {
                    tries += 1;
                    tokio::time::sleep(self.timing.rm_wait).await;
                }
                Err(CliError::Failed { stderr, .. }) if absent_refusal(&stderr) => return Ok(Removal::Gone),
                Err(CliError::Failed { stderr, .. }) => return Ok(Removal::Refused(stderr.trim().to_owned())),
                Err(other) => return Err(other.into()),
            }
        }
    }

    /// Removes the run's worktree and branch, and the earlier sessions it left behind. Never forces: unpushed work stays,
    /// and Claude says so. An earlier session that couldn't be removed is remembered, and cleaning up again retries just
    /// that one.
    pub async fn cleanup(&self, run_id: &str) -> Result<Cleanup> {
        self.ensure_enabled()?;
        if !self.cleaning.lock().expect("cleaning lock poisoned").insert(run_id.to_owned()) {
            return Err(refuse("This run is already being cleaned up."));
        }
        let _one_at_a_time = Cleaning(self, run_id.to_owned());
        let run = self.load(run_id).await?;
        let worktree_pending = run.worktree_removed_at.is_none();
        let leftovers = run.leftover_sessions();
        if !worktree_pending && leftovers.is_empty() {
            return Err(refuse("This run's worktree is already removed."));
        }
        let Some(id) = run.short_id.clone().filter(|_| cleanable(&run)) else {
            return Err(refuse(match run.state {
                RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown => "This run has no session, so there is no worktree to remove.".to_owned(),
                other => format!("This run is {}. Stop it first, then clean it up.", other.as_str()),
            }));
        };
        let tc = self.tools.get().await.map_err(|e| Error::Claude(Failure::from(e).to_string()))?;
        let live = self.live_sessions(&tc, &run).await;
        for session in &live {
            tc.cli.stop(session).await?;
        }
        let id = live.into_iter().find(|l| !run.earlier_sessions.iter().any(|e| e.short_id == *l)).unwrap_or(id);
        if worktree_pending {
            if let Removal::Refused(message) = self.remove_session(&tc, &id).await? {
                return Ok(Cleanup::Refused { message });
            }
        }
        let (mut gone, mut kept) = (Vec::new(), None);
        for earlier in leftovers.iter().filter(|e| **e != id) {
            match self.remove_session(&tc, earlier).await? {
                Removal::Gone => gone.push(earlier.clone()),
                Removal::Refused(message) => {
                    kept.get_or_insert(message);
                }
            }
        }
        if !worktree_pending && gone.is_empty() {
            if let Some(message) = kept {
                return Ok(Cleanup::Refused { message });
            }
        }
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if worktree_pending {
            run.worktree_removed_at = Some(Utc::now());
        }
        for earlier in run.earlier_sessions.iter_mut().filter(|e| gone.contains(&e.short_id)) {
            earlier.removed = true;
        }
        run.last_detail = Some(match &kept {
            Some(message) => format!("Worktree removed. An earlier session was kept: {message}"),
            None => "Worktree removed".into(),
        });
        self.store(&run).await?;
        if worktree_pending {
            if let Err(e) = self.index.forget(&run.id) {
                eprintln!("couldn't update the run index: {e}");
            }
        }
        Ok(Cleanup::Removed)
    }
}

#[cfg(test)]
mod tests;
