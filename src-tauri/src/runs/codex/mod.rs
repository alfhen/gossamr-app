//! The backend that runs agents as `codex exec` processes Gossamr starts and keeps track of itself.

mod control;
mod events;
mod launch;
mod observe;
pub mod process;

use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
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

/// How long a stop waits for Codex to end on SIGINT before it kills the whole group.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// Where every Codex run's folder is kept.
pub fn runs_root(data_dir: &Path) -> PathBuf {
    config_dir(data_dir).join("runs")
}

/// The folder of one run, none for an id that isn't a plain run id.
pub fn run_folder(root: &Path, run_id: &str) -> Option<PathBuf> {
    plain_id(run_id).then(|| root.join(run_id))
}

pub(super) const FINAL_FILE: &str = "final.txt";
pub(super) const SHORT_ID_FILE: &str = "short-id";
pub(super) const MODEL_FILE: &str = "model";
pub(super) const TERMINAL_FILE: &str = "terminal";
pub(super) const TERMINAL_SEEN_FILE: &str = "terminal-seen";

pub(super) fn events_file(folder: &Path, turn: u32) -> PathBuf {
    folder.join(format!("events-{turn}.jsonl"))
}

pub(super) fn process_file(folder: &Path, turn: u32) -> PathBuf {
    folder.join(format!("process-{turn}.json"))
}

pub(super) fn exit_file(folder: &Path, turn: u32) -> PathBuf {
    folder.join(format!("exit-{turn}"))
}

pub(super) fn stderr_file(folder: &Path, turn: u32) -> PathBuf {
    folder.join(format!("stderr-{turn}.log"))
}

pub(super) fn asked_file(folder: &Path, turn: u32) -> PathBuf {
    folder.join(format!("asked-{turn}"))
}

/// Creates a file only this user can read, failing when it exists.
pub(super) fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

/// At most `max` bytes of a regular file, from the end when `keep_end`. A symlink is not followed.
pub(super) fn read_file(path: &Path, max: u64, keep_end: bool) -> Option<String> {
    let mut file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    if keep_end && len > max {
        file.seek(SeekFrom::Start(len - max)).ok()?;
    }
    let mut buf = Vec::new();
    file.take(max).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
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
    stop_wait: Duration,
    /// The person's home, which the work folder `~/Gossamr/agents` is under.
    home: Option<PathBuf>,
}

impl CodexBackend {
    pub fn new(binary: PathBuf, login_env: Arc<RunEnv>, git_env: Arc<RunEnv>, runs_root: PathBuf, instance: String, own_folder: bool) -> Self {
        Self { binary, login_env, git_env, runs_root, instance, own_folder, launch_wait: LAUNCH_WAIT, stop_wait: STOP_WAIT, home: None }
    }

    pub fn with_home(mut self, home: Option<PathBuf>) -> Self {
        self.home = home;
        self
    }

    #[cfg(test)]
    pub fn with_stop_wait(mut self, wait: Duration) -> Self {
        self.stop_wait = wait;
        self
    }

    #[cfg(test)]
    pub fn with_launch_wait(mut self, wait: Duration) -> Self {
        self.launch_wait = wait;
        self
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

    async fn observe(&self, watched: &[Watched], _dirs: &Folders, now: DateTime<Utc>) -> BackendResult<Observations> {
        Ok(self.look(watched, now).await)
    }

    async fn find(&self, run: &Run, _dirs: &Folders) -> BackendResult<Option<Session>> {
        Ok(self.find_run(run))
    }

    async fn final_answer(&self, run: &Run, _dirs: &Folders) -> Option<String> {
        self.answer_of(run)
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

    async fn ready_for_answer(&self, _session: &Session, run: &Run) -> BackendResult<bool> {
        Ok(self.turn_is_over(run))
    }

    async fn open_elsewhere(&self, session: &Session, run: &Run) -> BackendResult<bool> {
        Ok(self.thread_open_elsewhere(session, run).await)
    }

    async fn stop(&self, session: &Session) -> BackendResult<()> {
        self.stop_session(session).await
    }

    fn ask_ended(&self, run: &Run) {
        self.forget_ask(run);
    }

    async fn resume(&self, session: &Session, req: &ResumeRequest, waits: &Waits) -> BackendResult<Resumed> {
        self.resume_session(session, req, waits).await
    }

    fn resumes_with_tools(&self) -> bool {
        true
    }

    async fn remove(&self, run: &Run, leftovers: &[super::cli::ShortId], waits: &Waits) -> BackendResult<RemoveOutcome> {
        self.remove_run(run, leftovers, waits).await
    }

    async fn prepare_attach(&self, session: &Session) -> BackendResult<bool> {
        self.hand_to_terminal(session).await?;
        Ok(true)
    }

    fn attach_words(&self, session: &Session) -> Vec<String> {
        session.session_id.iter().flat_map(|thread| ["resume".to_owned(), thread.clone()]).collect()
    }

    fn terminal_words(&self, _purpose: Purpose) -> Option<Vec<String>> {
        None
    }

    fn scratch_dir(&self, session: &Session, _dirs: &Folders) -> BackendResult<PathBuf> {
        self.run_folder_of(session)
    }

    #[cfg(test)]
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}

#[cfg(test)]
mod tests;
