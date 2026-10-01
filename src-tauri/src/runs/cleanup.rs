//! Removing the worktree of a finished run with `claude rm`, which refuses work that was never pushed.

use chrono::Utc;
use serde::Serialize;

use super::cli::CliError;
use super::failure::Failure;
use super::service::RunService;
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

pub fn cleanable(run: &Run) -> bool {
    matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown) && run.short_id.is_some() && run.worktree_removed_at.is_none()
}

/// `claude rm` straight after `claude stop` is refused while Claude's lock names a process that is still exiting, for
/// about four seconds. A refusal about unpushed work is final.
pub(super) fn lock_refusal(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    !text.contains("unpushed") && (text.contains("lock") || text.contains("still running"))
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

impl RunService {
    /// Removes the run's worktree and branch. Never forces: unpushed work stays, and Claude says so.
    pub async fn cleanup(&self, run_id: &str) -> Result<Cleanup> {
        self.ensure_enabled()?;
        let run = self.load(run_id).await?;
        if run.worktree_removed_at.is_some() {
            return Err(refuse("This run's worktree is already removed."));
        }
        let Some(id) = run.short_id.clone().filter(|_| cleanable(&run)) else {
            return Err(refuse(match run.state {
                RunState::Done | RunState::Failed | RunState::Stopped | RunState::Unknown => "This run has no session, so there is no worktree to remove.".to_owned(),
                other => format!("This run is {}. Stop it first, then clean it up.", other.as_str()),
            }));
        };
        let tc = self.tools.get().await.map_err(|e| Error::Claude(Failure::from(e).to_string()))?;
        let mut tries = 0;
        loop {
            match tc.cli.rm(&id).await {
                Ok(()) => break,
                Err(CliError::Failed { stderr, .. }) => {
                    if tries < LOCK_RETRIES && lock_refusal(&stderr) {
                        tries += 1;
                        tokio::time::sleep(self.timing.rm_wait).await;
                    } else {
                        return Ok(Cleanup::Refused { message: stderr.trim().to_owned() });
                    }
                }
                Err(other) => return Err(other.into()),
            }
        }
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        run.worktree_removed_at = Some(Utc::now());
        run.last_detail = Some("Worktree removed".into());
        self.store(&run).await?;
        if let Err(e) = self.index.forget(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        Ok(Cleanup::Removed)
    }
}

#[cfg(test)]
mod tests;
