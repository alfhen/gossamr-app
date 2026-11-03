//! Removing the worktree of a finished run with `claude rm`, which refuses work that was never pushed. A run whose
//! instance was removed has no `claude` to ask, so git removes the worktree and branch, just as unwilling to lose work.

use chrono::Utc;
use serde::Serialize;

use super::archive::contained;
use super::backend::RemoveOutcome;
use super::cli::ShortId;
use super::fresh::{agents_root, is_work_path, real};
use super::repo::Git;
use super::service::RunService;
use crate::domain::{Run, RunState};
use crate::error::{Error, Result};
use crate::inbox::Lookup;

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

    /// The run's worktree and branch through git alone, for a run whose instance is gone. Anything git refuses stays, in
    /// git's own words. The clone and the worktree must lie in `~/Gossamr/agents`.
    async fn remove_with_git(&self, run: &Run) -> Result<Option<String>> {
        let home = self.home.as_ref().ok_or_else(|| refuse("Gossamr doesn't know your home folder."))?;
        let clone = &run.spec.clone_path;
        let in_work_folder = contained(&agents_root(home), clone).is_some() || is_work_path(home, &run.spec.repo, clone);
        if !in_work_folder {
            return Err(refuse("Its clone isn't in ~/Gossamr/agents, so Gossamr leaves it where it is."));
        }
        let worktree = if run.expected_worktree.symlink_metadata().is_ok() {
            contained(&agents_root(home), &run.expected_worktree).ok_or_else(|| refuse("Its worktree isn't in ~/Gossamr/agents, so Gossamr leaves it where it is."))?
        } else {
            let missing = real(&run.expected_worktree);
            if !missing.starts_with(real(&agents_root(home))) {
                return Err(refuse("Its worktree isn't in ~/Gossamr/agents, so Gossamr leaves it where it is."));
            }
            missing
        };
        let git: Git = self.git().await?;
        let branch = run.branch.clone().unwrap_or_else(|| format!("worktree-{}", run.spec.name));
        if let Err(message) = git.check_branch_deletable(clone, &branch).await {
            return Ok(Some(message));
        }
        if let Err(message) = git.remove_worktree(clone, &worktree).await {
            return Ok(Some(message));
        }
        Ok(git.delete_branch(clone, &branch).await.err())
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
        if !cleanable(&run) {
            return Err(refuse(match run.state {
                RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown => "This run has no session, so there is no worktree to remove.".to_owned(),
                other => format!("This run is {}. Stop it first, then clean it up.", other.as_str()),
            }));
        }
        if self.instance_removed(&run).await {
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
