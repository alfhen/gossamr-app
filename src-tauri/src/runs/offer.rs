//! Offering a run's session Gossamr's tools: a token minted for the launch, handed to the backend that writes it where only this user can read it.
//! Nothing here can fail a launch. A run that can't be offered the tools launches without them and its written answer is
//! read as it always was.

use chrono::Utc;

use super::agent_config::AgentChannel;
use super::backend::ToolsOffer;
use super::codex;
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

    /// Mints a token for this launch, when the server is listening. Every launch of
    /// a run gets its own token and all of them stay valid for that run, so a launch whose answer was lost and is later
    /// adopted still reports.
    pub(super) async fn offer_tools(&self, run: &Run) -> Option<ToolsOffer> {
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
        Some(ToolsOffer { run_id: run.id.clone(), url: channel.url_for(&run.id), token })
    }

    /// A run's tokens and config files go when its worktree does.
    pub(super) async fn forget_tools(&self, run_id: &str) {
        if let Some(channel) = &self.agents {
            channel.remove_config(run_id);
            self.legacy_channel().remove_config(run_id);
        }
        self.remove_run_folder(run_id);
        self.core.asks().forget(run_id);
        if let Err(e) = self.core.report_forget(run_id).await {
            eprintln!("couldn't drop the tool tokens of run {run_id}: {e}");
        }
    }

    /// Where the earlier report server kept its config files; a session started then resumes with its saved path.
    fn legacy_channel(&self) -> AgentChannel {
        AgentChannel::new(0, self.core.data_dir().join("report"))
    }

    fn runs_root(&self) -> std::path::PathBuf {
        codex::runs_root(&self.core.data_dir())
    }

    fn remove_run_folder(&self, run_id: &str) {
        if let Some(folder) = codex::run_folder(&self.runs_root(), run_id) {
            let _ = std::fs::remove_dir_all(folder);
        }
    }

    /// Removes config files and run folders that no run can use any more: the run is gone, failed, has no worktree, or
    /// ended long enough ago that its session is no longer watched. Safe to call at any time.
    pub async fn sweep_agent_files(&self) {
        if let Some(channel) = &self.agents {
            for id in channel.configured() {
                if !self.keeps_files(&id).await {
                    channel.remove_config(&id);
                }
            }
            let legacy = self.legacy_channel();
            for id in legacy.configured() {
                if !self.keeps_files(&id).await {
                    legacy.remove_config(&id);
                }
            }
        }
        for id in codex::run_folders(&self.runs_root()) {
            if !self.keeps_files(&id).await {
                self.remove_run_folder(&id);
            }
        }
    }

    async fn keeps_files(&self, run_id: &str) -> bool {
        match self.core.run_in_store(run_id).await {
            Ok(Some(run)) => match run.state {
                RunState::Failed => false,
                RunState::Done | RunState::Stopped => run.worktree_removed_at.is_none() && run.ended_at.is_none_or(|at| Utc::now() - at <= KEEP_FINISHED),
                _ => run.worktree_removed_at.is_none(),
            },
            Ok(None) => false,
            // The store couldn't be read: leave it for a later sweep.
            Err(_) => true,
        }
    }
}

#[cfg(test)]
mod tests;
