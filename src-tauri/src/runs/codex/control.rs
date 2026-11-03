//! What can be done to a Codex run once it exists: stop it, carry on in its thread, hand it to Terminal and clean it up.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::launch::resume_args;
use super::observe::{newest_turn, process_listing, processes_on, recorded_process};
use super::process::{alive, kill_group, signal};
use super::{asked_file, create_private, events_file, exit_file, process_file, read_file, run_folder, run_folders, stderr_file, CodexBackend, FINAL_FILE, MODEL_FILE, PROGRAM, SHORT_ID_FILE, TERMINAL_FILE, TERMINAL_SEEN_FILE, TOKEN_VARIABLE};
use crate::domain::{Run, RunProcess};
use crate::runs::backend::{BackendError, BackendResult, RemoveOutcome, ResumeRequest, Resumed, Session, Waits};
use crate::runs::cli::{is_uuid, last_line, ShortId};
use crate::runs::redact::redact;
use crate::runs::repo::{random_hex, remove_with_git, Git};

const DELETE_WAIT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(25);
/// How long a process that was just killed is given to show as gone.
const KILL_SETTLE: Duration = Duration::from_secs(3);
const SHORT_ID_MAX: u64 = 16;
const MODEL_MAX: u64 = 256;

fn stop_failed(why: impl std::fmt::Display) -> BackendError {
    BackendError::Other(format!("Couldn't stop the Codex run: {why}"))
}

fn no_folder() -> BackendError {
    BackendError::Other("Couldn't find the Codex run folder.".into())
}

/// The turn's process has ended: its exit file is there, or the process is not the run's any more.
fn gone(folder: Option<&Path>, turn: u32, process: &RunProcess) -> bool {
    folder.is_some_and(|f| exit_file(f, turn).exists()) || !alive(process)
}

async fn wait_until_gone(folder: Option<&Path>, turn: u32, process: &RunProcess, limit: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while !gone(folder, turn, process) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(poll).await;
    }
    true
}

/// Removes the files turn `turn` made.
fn discard_turn(folder: &Path, turn: u32) {
    for file in [events_file(folder, turn), stderr_file(folder, turn), process_file(folder, turn), exit_file(folder, turn)] {
        let _ = std::fs::remove_file(file);
    }
}

impl CodexBackend {
    /// The run folder whose `short-id` file holds the session's short id.
    fn folder_of(&self, session: &Session) -> Option<PathBuf> {
        run_folders(&self.runs_root).into_iter().filter_map(|id| run_folder(&self.runs_root, &id)).find(|folder| {
            read_file(&folder.join(SHORT_ID_FILE), SHORT_ID_MAX, false).is_some_and(|id| id.trim() == session.short_id.as_str())
        })
    }

    /// The newest turn of a run folder and the process that turn is recorded to have.
    fn newest_process(folder: &Path, fallback: Option<&RunProcess>) -> (u32, Option<RunProcess>) {
        let turn = newest_turn(folder).unwrap_or(1);
        (turn, recorded_process(folder, turn).or_else(|| fallback.cloned()))
    }

    /// SIGINT to the turn's process, then, after `limit` or once the leader has gone, SIGKILL to its whole group, so a
    /// child a launcher started goes too. A process that is gone, or no longer the run's, is sent nothing: its pid may
    /// belong to someone else now.
    async fn stop_turn(&self, folder: Option<&Path>, turn: u32, process: Option<RunProcess>, limit: Duration) -> BackendResult<()> {
        if let Some(folder) = folder {
            let _ = std::fs::remove_file(asked_file(folder, turn));
        }
        let Some(process) = process.filter(alive) else { return Ok(()) };
        match signal(&process, libc::SIGINT) {
            Err(e) if e.raw_os_error() != Some(libc::ESRCH) => return Err(stop_failed(e)),
            _ => {}
        }
        wait_until_gone(folder, turn, &process, limit, POLL).await;
        kill_group(&process).map_err(stop_failed)?;
        wait_until_gone(folder, turn, &process, KILL_SETTLE, POLL).await;
        Ok(())
    }

    pub(super) async fn stop_session(&self, session: &Session) -> BackendResult<()> {
        let folder = self.folder_of(session);
        let (turn, process) = match &folder {
            Some(folder) => Self::newest_process(folder, session.process.as_ref()),
            None => (1, session.process.clone()),
        };
        self.stop_turn(folder.as_deref(), turn, process, self.stop_wait).await
    }

    pub(super) fn forget_ask(&self, run: &Run) {
        if let Some(folder) = run_folder(&self.runs_root, &run.id) {
            if let Some(turn) = newest_turn(&folder) {
                let _ = std::fs::remove_file(asked_file(&folder, turn));
            }
        }
    }

    pub(super) fn turn_is_over(&self, run: &Run) -> bool {
        let Some(folder) = run_folder(&self.runs_root, &run.id) else { return false };
        let (_, process) = Self::newest_process(&folder, run.process.as_ref());
        !process.is_some_and(|p| alive(&p))
    }

    /// Whether a `codex` outside the run's own process group has the session's thread open.
    pub(super) async fn thread_open_elsewhere(&self, session: &Session, run: &Run) -> bool {
        let Some(thread) = session.session_id.as_deref() else { return false };
        let own = run_folder(&self.runs_root, &run.id).and_then(|folder| Self::newest_process(&folder, session.process.as_ref()).1).or_else(|| session.process.clone());
        !processes_on(&process_listing().await, thread, own.map(|p| p.pid)).is_empty()
    }

    pub(super) async fn hand_to_terminal(&self, session: &Session) -> BackendResult<()> {
        let folder = self.folder_of(session).ok_or_else(no_folder)?;
        let (turn, process) = Self::newest_process(&folder, session.process.as_ref());
        self.stop_turn(Some(&folder), turn, process, self.stop_wait).await?;
        let _ = std::fs::remove_file(folder.join(TERMINAL_SEEN_FILE));
        match create_private(&folder.join(TERMINAL_FILE)) {
            Ok(_) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(BackendError::Other(format!("Couldn't mark the Codex run for Terminal: {e}"))),
        }
    }

    pub(super) fn run_folder_of(&self, session: &Session) -> BackendResult<PathBuf> {
        self.folder_of(session).ok_or_else(no_folder)
    }

    pub(super) async fn resume_session(&self, session: &Session, req: &ResumeRequest, waits: &Waits) -> BackendResult<Resumed> {
        let wake_failed = |why: String| BackendError::Other(format!("Couldn't wake the agent: {why}"));
        let folder = self.folder_of(session).ok_or_else(no_folder)?;
        let thread = session.session_id.clone().filter(|t| is_uuid(t)).ok_or_else(|| BackendError::Other("This run has no Codex thread to carry on in.".into()))?;
        let (turn, process) = Self::newest_process(&folder, session.process.as_ref());
        if let Some(process) = &process {
            if !wait_until_gone(Some(&folder), turn, process, waits.stop_wait, waits.poll.max(Duration::from_millis(5))).await {
                return Err(BackendError::Other("The Codex run didn't stop, so it wasn't woken.".into()));
            }
        }

        let next = turn + 1;
        let model = read_file(&folder.join(MODEL_FILE), MODEL_MAX, false).map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
        let args = resume_args(&thread, &folder.join(FINAL_FILE), model.as_deref(), req.tools.as_ref(), &req.message);
        let started = match self.start_turn(&folder, next, args, &req.cwd, req.tools.as_ref()) {
            Ok(started) => started,
            Err(why) => {
                discard_turn(&folder, next);
                return Err(wake_failed(why));
            }
        };
        let named = match self.wait_for_thread(&folder, next).await {
            Ok(named) => named,
            Err(why) => {
                let _ = kill_group(&started);
                wait_until_gone(Some(&folder), next, &started, KILL_SETTLE, POLL).await;
                discard_turn(&folder, next);
                return Err(wake_failed(why));
            }
        };

        if named != thread {
            let copy = ShortId::parse(&random_hex(8)).unwrap_or_else(|| session.short_id.clone());
            let how = match self.stop_turn(Some(&folder), next, Some(started.clone()), waits.stop_wait).await {
                Ok(()) => "it was stopped".to_owned(),
                Err(_) => "stop it from Codex".to_owned(),
            };
            discard_turn(&folder, next);
            let note = format!("Codex started a copy ({copy}) instead of continuing this agent; {how}.");
            return Ok(Resumed::Copy { session: Session { short_id: copy, session_id: Some(named), process: None }, note });
        }

        // The answer ends the wait, and a turn of our own ends whatever Terminal was doing.
        for file in [asked_file(&folder, turn), folder.join(TERMINAL_FILE), folder.join(TERMINAL_SEEN_FILE)] {
            let _ = std::fs::remove_file(file);
        }
        Ok(Resumed::Same(Session { short_id: session.short_id.clone(), session_id: Some(thread), process: Some(started) }))
    }

    pub(super) async fn remove_run(&self, run: &Run, leftovers: &[ShortId], waits: &Waits) -> BackendResult<RemoveOutcome> {
        let folder = run_folder(&self.runs_root, &run.id);
        if let Some(folder) = &folder {
            match std::fs::read_dir(folder) {
                Ok(_) => {
                    let (turn, process) = Self::newest_process(folder, run.process.as_ref());
                    self.stop_turn(Some(folder), turn, process, waits.stop_wait).await?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(BackendError::Other(format!("Couldn't read the Codex run folder: {e}"))),
            }
        }
        if run.worktree_removed_at.is_none() {
            let git = Git::new(self.git_env.clone());
            match remove_with_git(&git, self.home.as_deref(), run).await {
                Err(message) => return Err(BackendError::Other(message)),
                Ok(Some(message)) => return Ok(RemoveOutcome::Refused(message)),
                Ok(None) => {}
            }
        }
        let kept = match run.session_id.as_deref().filter(|t| is_uuid(t)) {
            Some(thread) => self.delete_saved_session(thread).await?,
            None => None,
        };
        if let Some(folder) = folder {
            let _ = std::fs::remove_dir_all(folder);
        }
        Ok(RemoveOutcome::Removed { gone: leftovers.to_vec(), kept })
    }

    /// `codex delete --force`, none when Codex dropped the saved session and why not otherwise.
    async fn delete_saved_session(&self, thread: &str) -> BackendResult<Option<String>> {
        let mut command = tokio::process::Command::new(&self.binary);
        command.args(["delete", "--force", thread]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        self.login_env.apply(command.as_std_mut());
        command.env_remove(TOKEN_VARIABLE);
        let child = command.spawn().map_err(|source| BackendError::Spawn { program: PROGRAM, source })?;
        let out = tokio::time::timeout(DELETE_WAIT, child.wait_with_output())
            .await
            .map_err(|_| BackendError::TimedOut { program: PROGRAM })?
            .map_err(|source| BackendError::Spawn { program: PROGRAM, source })?;
        if out.status.success() {
            return Ok(None);
        }
        let why: String = redact(last_line(&String::from_utf8_lossy(&out.stderr))).chars().take(300).collect();
        Ok(Some(format!("Codex kept its saved session: {why}")))
    }
}
