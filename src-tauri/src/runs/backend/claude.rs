//! The backend that runs agents as Claude Code background sessions.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use super::{BackendError, LaunchRequest, RunBackend, Session};
use crate::domain::AGENT_GUARD;
use crate::runs::agent_config::AgentChannel;
use crate::runs::cli::{self, ClaudeCli, CliError};
use crate::runs::env::RunEnv;
use crate::runs::failure::Failure;

impl From<CliError> for BackendError {
    fn from(e: CliError) -> Self {
        const PROGRAM: &str = "claude";
        match e {
            CliError::Spawn(source) => BackendError::Spawn { program: PROGRAM, source },
            CliError::TimedOut => BackendError::TimedOut { program: PROGRAM },
            CliError::Failed { code, stderr } => BackendError::Failed { program: PROGRAM, code, stderr },
            CliError::Output(text) => BackendError::Output { program: PROGRAM, text },
            unparseable @ CliError::Unparseable { .. } => BackendError::Other(unparseable.to_string()),
        }
    }
}

pub struct ClaudeBackend {
    cli: Arc<dyn ClaudeCli>,
    /// The captured shell environment, where `claude`'s own configuration file is found.
    env: Arc<RunEnv>,
    /// Where each run's MCP file is written.
    files: PathBuf,
    instance: String,
    own_folder: bool,
}

impl ClaudeBackend {
    pub fn new(cli: Arc<dyn ClaudeCli>, env: Arc<RunEnv>, files: PathBuf, instance: String, own_folder: bool) -> Self {
        Self { cli, env, files, instance, own_folder }
    }

    fn failure(&self, e: CliError, folder: &Path) -> Failure {
        Failure::from_cli(e, folder, &self.instance, self.own_folder)
    }
}

#[async_trait]
impl RunBackend for ClaudeBackend {
    async fn preflight(&self, clone: &Path) -> std::result::Result<(), Failure> {
        let auth = self.cli.auth_status().await.map_err(|e| self.failure(e, clone))?;
        if !auth.logged_in {
            return Err(Failure::NotSignedIn { instance: self.instance.clone(), own_folder: self.own_folder });
        }
        if let Ok(file) = crate::runs::trust::config_file(&self.env, &auth) {
            if crate::runs::trust::trusted(&file, clone) == Some(false) && !crate::runs::trust::trusted_above(&file, clone) {
                return Err(Failure::NeedsTrust { folder: clone.to_path_buf(), instance: self.instance.clone(), own_folder: self.own_folder });
            }
        }
        if !self.cli.supports_bg().await.map_err(|e| self.failure(e, clone))? {
            return Err(Failure::TooOld);
        }
        Ok(())
    }

    async fn launch(&self, req: &LaunchRequest) -> std::result::Result<Session, Failure> {
        let mut guard = req.guard.clone();
        let agent = req.tools.as_ref().and_then(|offer| match AgentChannel::new(0, self.files.clone()).write_offer(offer) {
            Ok(launch) => Some(launch),
            Err(e) => {
                eprintln!("couldn't offer Gossamr's tools to run {}: {e}", offer.run_id);
                if let Some(without) = guard.strip_suffix(&format!(" {AGENT_GUARD}")) {
                    guard = without.to_owned();
                }
                None
            }
        });
        let request = cli::LaunchRequest { cwd: req.cwd.clone(), name: req.name.clone(), worktree: req.worktree.clone(), guard, prompt: req.prompt.clone(), agent, model: req.model.clone() };
        let launched = self.cli.launch(&request).await.map_err(|e| self.failure(e, &req.cwd))?;
        Ok(Session { short_id: launched.short_id, session_id: None, process: None })
    }

    fn binary(&self) -> Option<PathBuf> {
        self.cli.binary()
    }
}
