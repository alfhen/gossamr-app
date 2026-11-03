//! What a run needs from the program that runs it, apart from which program that is.

use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::cli::ShortId;
use super::failure::Failure;
use crate::domain::Run;
use crate::error::Error;

pub mod claude;

/// A running turn of an agent that Gossamr started itself, and so has to find again by its pid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunProcess {
    pub pid: u32,
    /// The process start time in seconds, to tell a reused pid from the original.
    pub started: u64,
}

/// A run's session as a backend sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub short_id: ShortId,
    pub session_id: Option<String>,
    pub process: Option<RunProcess>,
}

impl Session {
    /// None until the run has a short id.
    pub fn of(run: &Run) -> Option<Self> {
        Some(Self { short_id: run.short_id.clone()?, session_id: run.session_id.clone(), process: None })
    }
}

/// Gossamr's tools, offered to one run: where they are served and the token that opens them for that run alone.
#[derive(Clone)]
pub struct ToolsOffer {
    pub run_id: String,
    pub url: String,
    pub token: String,
}

impl std::fmt::Debug for ToolsOffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolsOffer").field("run_id", &self.run_id).field("url", &self.url).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct LaunchRequest {
    pub cwd: PathBuf,
    pub name: String,
    pub worktree: String,
    pub guard: String,
    pub prompt: String,
    pub tools: Option<ToolsOffer>,
    /// The model to run on; none leaves the choice to the login folder's own setting.
    pub model: Option<String>,
    /// A short id nothing else uses. A backend whose program names its own sessions ignores it.
    pub fresh_id: ShortId,
}

/// An error from a backend's program, worded with that program's name.
#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("Couldn't run {program}: {source}")]
    Spawn { program: &'static str, source: std::io::Error },
    #[error("{program} took too long to answer")]
    TimedOut { program: &'static str },
    #[error("{program} failed: {}", super::cli::last_line(.stderr))]
    Failed { program: &'static str, code: Option<i32>, stderr: String },
    #[error("Unexpected output from {program}: {text}")]
    Output { program: &'static str, text: String },
    /// Already written for the person.
    #[error("{0}")]
    Other(String),
}

pub type BackendResult<T> = std::result::Result<T, BackendError>;

impl From<BackendError> for Error {
    fn from(e: BackendError) -> Self {
        Error::Claude(e.to_string())
    }
}

#[async_trait]
pub trait RunBackend: Send + Sync {
    /// Whether a session can start in `clone`: everything that depends on the program and the login, checked before
    /// anything is launched.
    async fn preflight(&self, clone: &Path) -> std::result::Result<(), Failure>;
    async fn launch(&self, req: &LaunchRequest) -> std::result::Result<Session, Failure>;
    /// The program this runs, for a command that has to start the same one in a terminal.
    fn binary(&self) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
mod tests;
