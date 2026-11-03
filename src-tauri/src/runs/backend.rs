//! What a run needs from the program that runs it, apart from which program that is.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::cli::{AgentEntry, ShortId, TimelineLine};
use super::failure::Failure;
use super::index;
use super::state::Observed;
use super::trust::Refusal;
use crate::domain::{RefusedMode, Run, RunProcess};
use crate::error::Error;

pub mod claude;

/// Why Terminal is opened with plain `claude` in a clone, and so what the file is called.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Trust,
    SignIn,
    /// Opens Claude where it asks for the one-time opt-in the person's permission mode needs for `--bg`.
    Mode(RefusedMode),
}

impl Purpose {
    pub(super) fn prefix(self) -> &'static str {
        match self {
            Purpose::Trust => "trust",
            Purpose::SignIn => "signin",
            Purpose::Mode(RefusedMode::Auto) => "auto",
            Purpose::Mode(RefusedMode::Bypass) => "bypass",
        }
    }
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
        Some(Self { short_id: run.short_id.clone()?, session_id: run.session_id.clone(), process: run.process.clone() })
    }

    /// None while the entry has no short id.
    pub fn of_entry(entry: &index::Entry) -> Option<Self> {
        Some(Self { short_id: entry.short_id.clone()?, session_id: None, process: entry.process.clone() })
    }
}

/// How long a backend may wait on its program while it acts on a session.
#[derive(Debug, Clone, Copy)]
pub struct Waits {
    /// How long a stopped session is waited for before a resume gives up on it.
    pub stop_wait: std::time::Duration,
    pub poll: std::time::Duration,
    /// The pause between a session showing as stopped and its resume.
    pub stop_settle: std::time::Duration,
    /// The pause between tries of a removal that is refused while the program still holds a lock.
    pub rm_wait: std::time::Duration,
}

/// A message to carry on a session with.
#[derive(Debug, Clone)]
pub struct ResumeRequest {
    pub message: String,
    pub cwd: PathBuf,
    /// Gossamr's tools, offered anew to a backend whose resume can take them (`resumes_with_tools`).
    pub tools: Option<ToolsOffer>,
    /// Pause after the session shows as stopped, before the resume.
    pub settle: bool,
    /// The session may have finished as well as stopped.
    pub finished: bool,
}

/// What a resume came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resumed {
    Same(Session),
    /// The program started a second session instead of carrying on in the first.
    /// `note` tells the person what became of the copy; the program stopped it if it could.
    Copy { session: Session, note: String },
}

/// What removing a run's worktree and earlier sessions came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveOutcome {
    /// The worktree is still there, for the reason the program gave.
    Refused(String),
    Removed {
        /// The earlier sessions that no longer exist.
        gone: Vec<ShortId>,
        /// Why an earlier session stays, if one does.
        kept: Option<String>,
    },
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
    /// Whether the program is signed in. A program that isn't installed is a `Spawn` error of kind `NotFound`.
    async fn signed_in(&self) -> BackendResult<bool>;
    /// The settings file that records which folders the program trusts. None for a program with no trust step.
    async fn trust_file(&self) -> std::result::Result<Option<PathBuf>, Refusal>;
    /// Whether the session waits on a question that a stop and a resume can answer.
    async fn ready_for_answer(&self, session: &Session, run: &Run) -> BackendResult<bool>;
    /// Whether someone has the session open, so a resume would end what they are doing.
    async fn open_elsewhere(&self, session: &Session, run: &Run) -> BackendResult<bool>;
    async fn stop(&self, session: &Session) -> BackendResult<()>;
    /// A held `ask` call of the run ended without its turn ending: it was answered, stopped or cancelled.
    fn ask_ended(&self, _run: &Run) {}
    /// Carries on in a stopped or finished session with a message.
    async fn resume(&self, session: &Session, req: &ResumeRequest, waits: &Waits) -> BackendResult<Resumed>;
    /// Whether a resume takes the tools offer in place, rather than starting a copy.
    fn resumes_with_tools(&self) -> bool {
        false
    }
    /// Removes the run's worktree, when it still has one, and its earlier `leftovers`, stopping any session open on them first.
    async fn remove(&self, run: &Run, leftovers: &[ShortId], waits: &Waits) -> BackendResult<RemoveOutcome>;
    /// Gets the session ready for a terminal to open it. True when the run no longer works on its own afterwards.
    async fn prepare_attach(&self, session: &Session) -> BackendResult<bool>;
    /// The arguments that open the session in a terminal. Each is letters, digits and `-`.
    fn attach_words(&self, session: &Session) -> Vec<String>;
    /// The arguments of the program run for `purpose` in a terminal, or none when it has no such use.
    fn terminal_words(&self, purpose: Purpose) -> Option<Vec<String>>;
    /// The folder where the session keeps its scratch files.
    fn scratch_dir(&self, session: &Session, dirs: &Folders) -> BackendResult<PathBuf>;
    /// The backend's own value, for a test that has to reach what it wraps.
    #[cfg(test)]
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        None
    }
}

#[cfg(test)]
pub(super) mod tests;
