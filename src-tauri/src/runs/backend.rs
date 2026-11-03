//! What a run needs from the program that runs it, apart from which program that is.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::cli::{AgentEntry, ShortId, TimelineLine};
use super::failure::Failure;
use super::state::Observed;
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

/// The folders a backend keeps a login's session files in. Both are none for a backend that has no such files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Folders {
    pub config_dir: Option<PathBuf>,
    pub projects_dir: Option<PathBuf>,
}

impl Folders {
    pub fn is_empty(&self) -> bool {
        self.config_dir.is_none() && self.projects_dir.is_none()
    }
}

/// A run to look at, with what the last looks counted.
#[derive(Debug, Clone)]
pub struct Watched {
    pub run: Run,
    /// Consecutive looks a working session had no process.
    pub misses: u32,
    /// Consecutive looks a working session was idle after a finished turn.
    pub idle: u32,
    /// The question of an `ask` call the run is held in, if any.
    pub ask: Option<String>,
}

/// What a backend saw of one run. Words are raw: the service redacts and caps them before it stores them.
#[derive(Debug, Clone)]
pub struct Observation {
    pub run_id: String,
    pub seen: Observed,
    /// The run's session when the backend lists one.
    pub session: Option<Session>,
    pub tokens: Option<u64>,
    pub detail: Option<String>,
    pub branch: Option<String>,
    pub progress_at: Option<DateTime<Utc>>,
    pub suggested_reply: Option<String>,
    pub timeline: Vec<TimelineLine>,
    /// The final answer, read only for a run seen done.
    pub answer: Option<String>,
    /// A run at rest whose session is working or asking again.
    pub revived: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Observations {
    /// One for each watched run that has anything to apply; a run at rest that has not been revived has none.
    pub runs: Vec<Observation>,
    /// Every session the backend lists, for finding the continuation of a run at rest. Empty when it lists none.
    pub sessions: Vec<AgentEntry>,
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
    /// Where this login keeps its session files. Asked once per instance.
    async fn folders(&self) -> Folders;
    /// One look at `watched`, all runs of one instance, at the time `now`.
    async fn observe(&self, watched: &[Watched], dirs: &Folders, now: DateTime<Utc>) -> BackendResult<Observations>;
    /// The session a run has, if the backend knows one.
    async fn find(&self, run: &Run, dirs: &Folders) -> BackendResult<Option<Session>>;
    /// The last message of a run's session, read now.
    async fn final_answer(&self, run: &Run, dirs: &Folders) -> Option<String>;
    /// Every session the backend can list. A backend with no listing gives none.
    async fn listed_sessions(&self) -> BackendResult<Vec<AgentEntry>> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
pub(super) mod tests;
