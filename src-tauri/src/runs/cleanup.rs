//! Removing the worktree of a finished run with `claude rm`, which refuses work that was never pushed. A run whose
//! instance was removed has no `claude` to ask, so git removes the worktree and branch, just as unwilling to lose work.

use chrono::Utc;
use serde::Serialize;

use super::backend::RemoveOutcome;
use super::cli::ShortId;
use std::path::Path;

use super::repo::{remove_with_git, Git, Worktree};
use super::service::RunService;
use crate::domain::{Run, RunState};
use crate::error::{Error, Result};
use crate::inbox::Lookup;

/// The run's worktree and branch, removed through git alone: see `repo::remove_with_git`.
pub(crate) async fn remove_run_with_git(git: &Git, home: Option<&Path>, run: &Run) -> std::result::Result<Option<String>, String> {
    let branch = run.branch_name();
    // In turns with a launch's fetch and worktree add in the same clone.
    let _lock = match home {
        Some(home) => Some(super::fresh::lock_repo(home, &run.spec.repo).await.map_err(|e| e.to_string())?),
        None => None,
    };
    remove_with_git(git, home, Worktree { repo: &run.spec.repo, clone: &run.spec.clone_path, path: &run.expected_worktree, branch: &branch, base: &run.spec.base }).await
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Cleanup {
    Removed,
    /// Claude's own explanation, unchanged.
    Refused { message: String },
}

/// Why Clean up leaves a run handed over to Terminal: Terminal resumes it in its worktree.
pub const HANDED_OVER_CLEANUP: &str = "Handed over to Terminal, which works in its worktree. Quit it there and press Resume here, or remove the worktree yourself once you are done there, then Clean up.";

/// A run handed over to Terminal whose worktree is still there: once you removed it, nothing resumes the session,
/// and the harness cleans it up.
fn terminal_works_in(run: &Run) -> bool {
    run.handed_over && run.expected_worktree.symlink_metadata().is_ok()
}

/// A run that is over and still has something to remove: its worktree, or an earlier session that was kept.
pub fn cleanable(run: &Run) -> bool {
    let over = matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown);
    let on_harness = run.harness_session.is_some() && run.worktree_removed_at.is_none() && !terminal_works_in(run);
    over && (on_harness || run.short_id.is_some() && (run.worktree_removed_at.is_none() || !run.leftover_sessions().is_empty()))
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
    /// Whether the login the run launched on is gone from the providers. A login that is off or broken, or a list that
    /// can't be read, is not gone: cleaning up must work while a login is off.
    async fn instance_removed(&self, run: &Run) -> bool {
        match &run.runs_on {
            Some(choice) => matches!(self.core.lookup_provider(&choice.instance_id).await, Lookup::Missing),
            None => false,
        }
    }

    /// The run's worktree and branch through git alone, for a run whose instance is gone.
    async fn remove_with_git(&self, run: &Run) -> Result<Option<String>> {
        let git: Git = self.git().await?;
        remove_run_with_git(&git, self.home.as_deref(), run).await.map_err(refuse)
    }

    /// Removes the run's worktree and branch, and the earlier sessions it left behind. Never forces: unpushed work stays,
    /// and Claude says so. An earlier session that couldn't be removed is remembered, and cleaning up again retries just
    /// that one. A run whose instance was removed is cleaned up with git alone and its sessions stay in that login's folder.
    pub async fn cleanup(&self, run_id: &str) -> Result<Cleanup> {
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
        if run.harness_session.is_some() && terminal_works_in(&run) {
            return Err(refuse(HANDED_OVER_CLEANUP));
        }
        if !cleanable(&run) {
            return Err(refuse(match run.state {
                RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown => "This run has no session, so there is no worktree to remove.".to_owned(),
                other => format!("This run is {}. Stop it first, then clean it up.", other.as_str()),
            }));
        }
        if let Some(cleaned) = self.cleanup_on_harness(&run).await {
            return match cleaned? {
                Some(message) => Ok(Cleanup::Refused { message }),
                None => self.settle_cleanup(&run, true, Vec::new(), None, false).await,
            };
        }
        // An agent the move to the harness stopped is cleaned up with git alone, as the old path's tools are no longer used.
        let interrupted = run.failure == Some(crate::domain::RunFailure::Interrupted);
        if interrupted || self.instance_removed(&run).await {
            if worktree_pending {
                if let Some(message) = self.remove_with_git(&run).await? {
                    return Ok(Cleanup::Refused { message });
                }
            }
            return self.settle_cleanup(&run, worktree_pending, leftovers, None, true).await;
        }
        let tc = self.observing_toolchain(&run).await?;
        let (gone, kept) = match tc.backend.remove(&run, &leftovers, &self.timing.waits()).await? {
            RemoveOutcome::Refused(message) => return Ok(Cleanup::Refused { message }),
            RemoveOutcome::Removed { gone, kept } => (gone, kept),
        };
        if !worktree_pending && gone.is_empty() {
            if let Some(message) = kept {
                return Ok(Cleanup::Refused { message });
            }
        }
        self.settle_cleanup(&run, worktree_pending, gone, kept, false).await
    }

    /// Records what was removed. `gone` are the earlier sessions that no longer exist or, with `left`, will never be
    /// reached because their login's folder is out of Gossamr's hands.
    async fn settle_cleanup(&self, run: &Run, worktree_pending: bool, gone: Vec<ShortId>, kept: Option<String>, left: bool) -> Result<Cleanup> {
        let _turn = self.launching.lock().await;
        let mut run = self.load(&run.id).await?;
        if worktree_pending {
            run.worktree_removed_at = Some(Utc::now());
            // Nothing opens its session in Terminal any more.
            let _ = std::fs::remove_file(self.terminal_marker(&run));
        }
        run.sessions_left |= left;
        for earlier in run.earlier_sessions.iter_mut().filter(|e| left || gone.contains(&e.short_id)) {
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
            self.forget_tools(&run.id).await;
        }
        Ok(Cleanup::Removed)
    }
}

#[cfg(test)]
mod tests;
