//! Offering a run's session Gossamr's tools: a token minted for the launch and a config file only this user can read.
//! Nothing here can fail a launch. A run that can't be offered the tools launches without them and its written answer is
//! read as it always was.

use chrono::Utc;

use super::agent_config::{AgentChannel, AgentLaunch};
use super::report::{new_token, token_hash};
use super::service::RunService;
use crate::domain::{Run, RunState, REPORT_TOOL_VERSION};

/// A finished run's config file is kept this long after it ended, in case its session is carried on.
const KEEP_FINISHED: chrono::Duration = chrono::Duration::hours(6);

impl RunService {
    /// The channel the tools are reached through, once its server is listening.
    pub fn with_agent_channel(mut self, channel: std::sync::Arc<AgentChannel>) -> Self {
        self.agents = Some(channel);
        self
    }

    /// Mints a token for this launch and writes the config that carries it, when the server is listening. Every launch of
    /// a run gets its own token and all of them stay valid for that run, so a launch whose answer was lost and is later
    /// adopted still reports.
    pub(super) async fn offer_tools(&self, run: &Run) -> Option<AgentLaunch> {
        let channel = self.agents.as_ref()?;
        let token = match new_token() {
            Ok(token) => token,
            Err(e) => {
                eprintln!("couldn't offer Gossamr's tools to run {}: no randomness: {e}", run.id);
                return None;
            }
        };
        if let Err(e) = self.core.report_reserve(&run.id, &token_hash(&token), REPORT_TOOL_VERSION).await {
            eprintln!("couldn't offer Gossamr's tools to run {}: {e}", run.id);
            return None;
        }
        match channel.write_config(&run.id, &token) {
            Ok(launch) => Some(launch),
            Err(e) => {
                eprintln!("couldn't offer Gossamr's tools to run {}: {e}", run.id);
                None
            }
        }
    }

    /// A run's tokens and config files go when its worktree does.
    pub(super) async fn forget_tools(&self, run_id: &str) {
        if let Some(channel) = &self.agents {
            channel.remove_config(run_id);
            self.legacy_channel().remove_config(run_id);
        }
        self.core.asks().forget(run_id);
        if let Err(e) = self.core.report_forget(run_id).await {
            eprintln!("couldn't drop the tool tokens of run {run_id}: {e}");
        }
    }

    /// Where the earlier report server kept its config files; a session started then resumes with its saved path.
    fn legacy_channel(&self) -> AgentChannel {
        AgentChannel::new(0, self.core.data_dir().join("report"))
    }

    /// Removes config files that no run can use any more: the run is gone, failed, has no worktree, or ended long enough
    /// ago that its session is no longer watched. Safe to call at any time.
    pub async fn sweep_agent_files(&self) {
        let Some(channel) = &self.agents else { return };
        self.sweep_configs(channel).await;
        self.sweep_configs(&self.legacy_channel()).await;
    }

    async fn sweep_configs(&self, channel: &AgentChannel) {
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
