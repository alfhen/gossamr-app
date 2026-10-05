//! Offering a run's session the report tool: a token minted for the launch and a config file only this user can read.
//! Nothing here can fail a launch. A run that can't be offered the tool launches without it and its written answer is
//! read as it always was.

use chrono::Utc;

use super::report::{new_token, token_hash, ReportLaunch};
use super::service::RunService;
use crate::domain::{Run, RunState, REPORT_TOOL_VERSION};

/// A finished run's config file is kept this long after it ended, in case its session is carried on.
const KEEP_FINISHED: chrono::Duration = chrono::Duration::hours(6);

impl RunService {
    /// The channel the tool is reached through, once its server is listening.
    pub fn with_report(mut self, channel: std::sync::Arc<super::report::ReportChannel>) -> Self {
        self.report = Some(channel);
        self
    }

    /// Mints a token for this launch and writes the config that carries it, when the run asked for the tool, the setting
    /// is on and the server is listening. Every launch of a run gets its own token and all of them stay valid for that
    /// run, so a launch whose answer was lost and is later adopted still reports.
    pub(super) async fn offer_report(&self, run: &Run) -> Option<ReportLaunch> {
        let channel = self.report.as_ref()?;
        if !run.spec.report || !self.settings().report_result {
            return None;
        }
        let token = match new_token() {
            Ok(token) => token,
            Err(e) => {
                eprintln!("couldn't offer the report tool to run {}: no randomness: {e}", run.id);
                return None;
            }
        };
        if let Err(e) = self.core.report_reserve(&run.id, &token_hash(&token), REPORT_TOOL_VERSION).await {
            eprintln!("couldn't offer the report tool to run {}: {e}", run.id);
            return None;
        }
        match channel.write_config(&run.id, &token) {
            Ok(launch) => Some(launch),
            Err(e) => {
                eprintln!("couldn't offer the report tool to run {}: {e}", run.id);
                None
            }
        }
    }

    /// A run's tokens and config file go when its worktree does.
    pub(super) async fn forget_report(&self, run_id: &str) {
        if let Some(channel) = &self.report {
            channel.remove_config(run_id);
        }
        if let Err(e) = self.core.report_forget(run_id).await {
            eprintln!("couldn't drop the report tokens of run {run_id}: {e}");
        }
    }

    /// Removes config files that no run can use any more: the run is gone, failed, has no worktree, or ended long enough
    /// ago that its session is no longer watched. Safe to call at any time.
    pub async fn sweep_report_files(&self) {
        let Some(channel) = &self.report else { return };
        let now = Utc::now();
        for id in channel.configured() {
            let keep = match self.core.run(&id).await {
                Ok(Some(run)) => match run.state {
                    RunState::Failed => false,
                    RunState::Done | RunState::Stopped => run.worktree_removed_at.is_none() && run.ended_at.is_none_or(|at| now - at <= KEEP_FINISHED),
                    _ => run.worktree_removed_at.is_none(),
                },
                Ok(None) => false,
                // Not this account's run, or no one is signed in: leave it for a later sweep.
                Err(_) => true,
            };
            if !keep {
                channel.remove_config(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests;
