//! The backend that runs agents as `codex exec` processes Gossamr starts and keeps track of itself.

mod launch;
pub mod process;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::agent_config::{config_dir, plain_id};
use super::backend::{BackendError, BackendResult, Folders, LaunchRequest, Observations, Purpose, RemoveOutcome, ResumeRequest, Resumed, RunBackend, Session, Waits, Watched};
use super::env::RunEnv;
use super::failure::Failure;
use super::trust::Refusal;
use crate::domain::Run;
use crate::probe::State;
use crate::provider_probe::{codex_account, ACCOUNT_TIMEOUT};

/// Added to the guard of every Codex agent: its sandbox is the person's own and may stop git.
pub const CODEX_GUARD: &str = "If your sandbox stops git from committing or pushing, stop and say so in your report.";

/// The variable the agent's token travels in. Never argv, a script or a file.
pub const TOKEN_VARIABLE: &str = "GOSSAMR_MCP_TOKEN";

/// How long a launch waits for Codex to name its thread, the same limit as Claude's launch.
const LAUNCH_WAIT: Duration = Duration::from_secs(60);

const PROGRAM: &str = "codex";

/// Where every Codex run's folder is kept.
pub fn runs_root(data_dir: &Path) -> PathBuf {
    config_dir(data_dir).join("runs")
}

/// The folder of one run, none for an id that isn't a plain run id.
pub fn run_folder(root: &Path, run_id: &str) -> Option<PathBuf> {
    plain_id(run_id).then(|| root.join(run_id))
}

/// The runs that have a folder under `root`.
pub fn run_folders(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries.filter_map(|e| e.ok()?.file_name().to_str().filter(|id| plain_id(id)).map(str::to_owned)).collect()
}

pub struct CodexBackend {
    binary: PathBuf,
    /// The instance's whole environment: the shell's with the login variables this instance's folder decides.
    login_env: Arc<RunEnv>,
    /// The shell's environment alone, for `git`.
    git_env: Arc<RunEnv>,
    runs_root: PathBuf,
    instance: String,
    own_folder: bool,
    launch_wait: Duration,
}

impl CodexBackend {
    pub fn new(binary: PathBuf, login_env: Arc<RunEnv>, git_env: Arc<RunEnv>, runs_root: PathBuf, instance: String, own_folder: bool) -> Self {
        Self { binary, login_env, git_env, runs_root, instance, own_folder, launch_wait: LAUNCH_WAIT }
    }

    #[cfg(test)]
    pub fn with_launch_wait(mut self, wait: Duration) -> Self {
        self.launch_wait = wait;
        self
    }

    fn not_built(what: &str) -> BackendError {
        BackendError::Other(format!("Codex agents can't {what} yet."))
    }
}

#[async_trait]
impl RunBackend for CodexBackend {
    async fn preflight(&self, _clone: &Path) -> std::result::Result<(), Failure> {
        match self.signed_in().await {
            Ok(true) => Ok(()),
            Ok(false) => Err(Failure::NotSignedIn { instance: self.instance.clone(), own_folder: self.own_folder }),
            Err(BackendError::Spawn { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                Err(Failure::ClaudeMissing { instance: self.instance.clone(), driver: crate::connections::Driver::Codex })
            }
            Err(e) => Err(Failure::Invalid(e.to_string())),
        }
    }

    async fn launch(&self, req: &LaunchRequest) -> std::result::Result<Session, Failure> {
        self.start(req).await
    }

    fn binary(&self) -> Option<PathBuf> {
        Some(self.binary.clone())
    }

    async fn folders(&self) -> Folders {
        Folders::default()
    }

    async fn observe(&self, _watched: &[Watched], _dirs: &Folders, _now: DateTime<Utc>) -> BackendResult<Observations> {
        Err(Self::not_built("be watched"))
    }

    async fn find(&self, _run: &Run, _dirs: &Folders) -> BackendResult<Option<Session>> {
        Ok(None)
    }

    async fn final_answer(&self, _run: &Run, _dirs: &Folders) -> Option<String> {
        None
    }

    async fn signed_in(&self) -> BackendResult<bool> {
        if !self.binary.is_file() {
            return Err(BackendError::Spawn { program: PROGRAM, source: std::io::Error::from(std::io::ErrorKind::NotFound) });
        }
        let seen = codex_account(&self.binary, None, &self.login_env, ACCOUNT_TIMEOUT).await;
        match seen.state {
            State::Ready | State::ExpiresSoon => Ok(true),
            State::NotSignedIn => Ok(false),
            _ => Err(BackendError::Other(seen.message)),
        }
    }

    async fn trust_file(&self) -> std::result::Result<Option<PathBuf>, Refusal> {
        Ok(None)
    }

    async fn ready_for_answer(&self, _session: &Session, _run: &Run) -> BackendResult<bool> {
        Ok(false)
    }

    async fn open_elsewhere(&self, _session: &Session, _run: &Run) -> BackendResult<bool> {
        Ok(false)
    }

    async fn stop(&self, _session: &Session) -> BackendResult<()> {
        Err(Self::not_built("be stopped"))
    }

    async fn resume(&self, _session: &Session, _req: &ResumeRequest, _waits: &Waits) -> BackendResult<Resumed> {
        Err(Self::not_built("be resumed"))
    }

    async fn remove(&self, _run: &Run, _leftovers: &[super::cli::ShortId], _waits: &Waits) -> BackendResult<RemoveOutcome> {
        Err(Self::not_built("be cleaned up"))
    }

    async fn prepare_attach(&self, _session: &Session) -> BackendResult<bool> {
        Err(Self::not_built("be opened in Terminal"))
    }

    fn attach_words(&self, session: &Session) -> Vec<String> {
        session.session_id.iter().flat_map(|thread| ["resume".to_owned(), thread.clone()]).collect()
    }

    fn terminal_words(&self, _purpose: Purpose) -> Option<Vec<String>> {
        None
    }

    fn scratch_dir(&self, _session: &Session, _dirs: &Folders) -> BackendResult<PathBuf> {
        Err(Self::not_built("keep scratch files"))
    }

    #[cfg(test)]
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}

#[cfg(test)]
mod tests;
