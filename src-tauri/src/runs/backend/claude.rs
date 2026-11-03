//! The backend that runs agents as Claude Code background sessions.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use chrono::{DateTime, Utc};

use super::{BackendError, BackendResult, Folders, LaunchRequest, Observation, Observations, RemoveOutcome, ResumeRequest, Resumed, RunBackend, Session, ToolsOffer, Waits, Watched};
use crate::domain::{RefusedMode, Run, RunState, AGENT_CALL_TIMEOUT_MS, AGENT_GUARD, AGENT_SERVER};
use crate::runs::control::Purpose;
use crate::runs::trust::Refusal;
use crate::runs::agent_config::{config_path, AgentLaunch};
use crate::runs::cli::{self, AgentEntry, ClaudeCli, CliError, JobInfo, ShortId};
use crate::runs::env::RunEnv;
use crate::runs::failure::Failure;
use crate::runs::fresh::real;
use crate::runs::final_answer::{answer_folders, timeline_answer};
use crate::runs::state::{map_state, progress_at};

/// A stopped run's session is listed as stopped within seconds, but until then it can still look alive; it is not
/// taken for a session that carried on before this long has passed.
const STOPPED_SETTLE: chrono::Duration = chrono::Duration::seconds(60);

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

/// Whether `entry`, listed by the login `listed_on`, is the session of `run`. Interactive sessions never are, and short
/// ids can repeat across logins, so a run only matches the listing of its own.
pub(in crate::runs) fn belongs_to(entry: &AgentEntry, listed_on: &str, run: &Run) -> bool {
    if run.instance_id() != listed_on {
        return false;
    }
    let Some(id) = entry.id.as_deref().and_then(ShortId::parse) else { return false };
    if entry.kind.as_deref() == Some("interactive") {
        return false;
    }
    if run.earlier_sessions.iter().any(|e| e.short_id == id) {
        return false;
    }
    run.short_id.as_ref() == Some(&id) || entry.cwd.as_deref().is_some_and(|cwd| real(std::path::Path::new(cwd)) == real(&run.expected_worktree))
}

/// A session whose process is alive and that is not at rest, the only kind a finished run can be taken up by again.
fn is_active(entry: &AgentEntry) -> bool {
    entry.pid.is_some() && matches!(entry.state.as_deref(), Some("working" | "blocked")) && entry.status.as_deref() != Some("idle")
}

/// Whether the session listed for a run at rest has started working or asking again. A finished run only counts a
/// session that is not at its prompt; a stopped one also counts a session waiting on a question, which Claude lists as
/// idle. Gossamr's own answer in flight (`unsent_answer`) and a stop that is still settling don't count.
pub(in crate::runs) fn revived(entry: &AgentEntry, run: &Run, now: DateTime<Utc>) -> bool {
    match run.state {
        RunState::Done => is_active(entry),
        RunState::Stopped => {
            let settled = run.ended_at.is_some_and(|at| now - at >= STOPPED_SETTLE);
            let alive = entry.pid.is_some()
                && match entry.state.as_deref() {
                    Some("blocked") => true,
                    Some("working") => entry.status.as_deref() != Some("idle"),
                    _ => false,
                };
            settled && alive && run.unsent_answer.is_none()
        }
        _ => false,
    }
}

const LOCK_RETRIES: u32 = 6;

/// `claude rm` straight after `claude stop` is refused while Claude's lock names a process that is still exiting, for
/// about four seconds. A refusal about unpushed work is final.
pub(in crate::runs) fn lock_refusal(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    !text.contains("unpushed") && (text.contains("lock") || text.contains("still running"))
}

/// `claude rm` saying the session is not there. The wording is not documented, so this only recognises the usual phrasings;
/// anything else is kept as a refusal and retried by the next clean up.
fn absent_refusal(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    ["no session", "no such", "not found", "unknown session", "does not exist", "doesn't exist", "already removed"].iter().any(|phrase| text.contains(phrase))
}

enum Removal {
    Gone,
    /// Claude's own words.
    Refused(String),
}

pub struct ClaudeBackend {
    cli: Arc<dyn ClaudeCli>,
    /// The captured shell environment, where `claude`'s own configuration file is found.
    env: Arc<RunEnv>,
    /// Where each run's MCP file is written.
    files: PathBuf,
    instance_id: String,
    instance: String,
    own_folder: bool,
}

impl ClaudeBackend {
    pub fn new(cli: Arc<dyn ClaudeCli>, env: Arc<RunEnv>, files: PathBuf, instance_id: String, instance: String, own_folder: bool) -> Self {
        Self { cli, env, files, instance_id, instance, own_folder }
    }

    /// The text of the session's last message: the transcript's, else the timeline's `done` text. One look: the message
    /// can land after the session is listed as done, which the polling of recently finished runs covers.
    async fn read_answer(&self, run: &Run, entry: Option<&AgentEntry>, job: Option<&JobInfo>, dirs: &Folders) -> Option<String> {
        let session = run.session_id.clone().or_else(|| entry.and_then(|e| e.session_id.clone()));
        if let (Some(session), Some(projects)) = (session, dirs.projects_dir.as_deref()) {
            if let Some(answer) = self.cli.final_answer(projects, &session, &answer_folders(run, entry, job)).await {
                return Some(answer);
            }
        }
        job.and_then(timeline_answer)
    }

    fn failure(&self, e: CliError, folder: &Path) -> Failure {
        Failure::from_cli(e, folder, &self.instance, self.own_folder)
    }

    #[cfg(test)]
    pub fn cli(&self) -> Arc<dyn ClaudeCli> {
        self.cli.clone()
    }

    /// The ids the listing gives sessions of a finished run that are still open at their prompt. One holds the
    /// worktree's lock, which `claude rm` refuses until it is stopped, and after a resume it can differ from the stored
    /// id. The run's earlier sessions are looked at too.
    async fn live_sessions(&self, run: &Run) -> Vec<ShortId> {
        let Ok(entries) = self.cli.agents(true).await else { return Vec::new() };
        let ours = run.session_ids();
        entries
            .iter()
            .filter(|e| e.pid.is_some() && (belongs_to(e, &self.instance_id, run) || e.id.as_deref().and_then(ShortId::parse).is_some_and(|id| ours.contains(&id))))
            .filter_map(|e| e.id.as_deref().and_then(ShortId::parse))
            .collect()
    }

    /// `claude rm` on one session, retried while Claude's lock on a just-stopped worktree clears. A session that is
    /// already gone counts as removed.
    async fn remove_session(&self, id: &ShortId, waits: &Waits) -> BackendResult<Removal> {
        let mut tries = 0;
        loop {
            match self.cli.rm(id).await {
                Ok(()) => return Ok(Removal::Gone),
                Err(CliError::Failed { stderr, .. }) if tries < LOCK_RETRIES && lock_refusal(&stderr) => {
                    tries += 1;
                    tokio::time::sleep(waits.rm_wait).await;
                }
                Err(CliError::Failed { stderr, .. }) if absent_refusal(&stderr) => return Ok(Removal::Gone),
                Err(CliError::Failed { stderr, .. }) => return Ok(Removal::Refused(stderr.trim().to_owned())),
                Err(other) => return Err(other.into()),
            }
        }
    }
}

/// Writes the run's MCP config in `files` where only this user can read it. A second call for the same run replaces
/// the file, and every token minted for the run stays valid on the server.
pub fn write_mcp_file(files: &Path, offer: &ToolsOffer) -> std::io::Result<AgentLaunch> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let path = config_path(files, &offer.run_id).ok_or_else(|| std::io::Error::other("not a run id"))?;
    std::fs::create_dir_all(files)?;
    std::fs::set_permissions(files, std::fs::Permissions::from_mode(0o700))?;
    let config = serde_json::json!({ "mcpServers": { AGENT_SERVER: { "type": "http", "url": offer.url, "headers": { "Authorization": format!("Bearer {}", offer.token) }, "timeout": AGENT_CALL_TIMEOUT_MS } } });
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
    file.write_all(config.to_string().as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temp, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(AgentLaunch { config: path })
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
        let agent = req.tools.as_ref().and_then(|offer| match write_mcp_file(&self.files, offer) {
            Ok(launch) => {
                guard = format!("{guard} {AGENT_GUARD}");
                Some(launch)
            }
            Err(e) => {
                eprintln!("couldn't offer Gossamr's tools to run {}: {e}", offer.run_id);
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

    async fn folders(&self) -> Folders {
        let Ok(status) = self.cli.auth_status().await else { return Folders::default() };
        let projects_dir = status.projects_directory.or_else(|| status.config_directory.as_ref().map(|c| c.join("projects")));
        Folders { config_dir: status.config_directory, projects_dir }
    }

    async fn observe(&self, watched: &[Watched], dirs: &Folders, now: DateTime<Utc>) -> BackendResult<Observations> {
        let sessions = self.listed_sessions().await?;
        let mut runs = Vec::new();
        for w in watched {
            let run = &w.run;
            let entry = sessions.iter().find(|e| belongs_to(e, &self.instance_id, run));
            let finished = matches!(run.state, RunState::Done | RunState::Stopped);
            let revived = entry.is_some_and(|e| revived(e, run, now));
            if finished && !revived {
                continue;
            }
            let short = run.short_id.clone().or_else(|| entry.and_then(|e| e.id.as_deref().and_then(ShortId::parse)));
            let job = match (entry, dirs.config_dir.as_deref(), &short) {
                (Some(_), Some(dir), Some(id)) => self.cli.job(dir, id).await.ok().flatten(),
                _ => None,
            };
            let seen = map_state(entry, job.as_ref(), run, now, w.misses, w.idle);
            let answer = match seen.state {
                RunState::Done if !finished => self.read_answer(run, entry, job.as_ref(), dirs).await,
                _ => None,
            };
            runs.push(Observation {
                run_id: run.id.clone(),
                session: entry.zip(short).map(|(e, short_id)| Session { short_id, session_id: e.session_id.clone(), process: None }),
                tokens: job.as_ref().and_then(|j| j.tokens),
                detail: job.as_ref().and_then(|j| j.detail.clone()),
                branch: job.as_ref().and_then(|j| j.worktree_branch.clone()),
                progress_at: job.as_ref().map(|j| progress_at(run, j, now)),
                suggested_reply: job.as_ref().and_then(|j| j.suggested_reply.clone()),
                timeline: job.map(|j| j.timeline).unwrap_or_default(),
                seen,
                answer,
                revived,
            });
        }
        Ok(Observations { runs, sessions })
    }

    async fn find(&self, run: &Run, _dirs: &Folders) -> BackendResult<Option<Session>> {
        let sessions = self.listed_sessions().await?;
        Ok(sessions.iter().find(|e| belongs_to(e, &self.instance_id, run)).and_then(|e| {
            let short_id = e.id.as_deref().and_then(ShortId::parse)?;
            Some(Session { short_id, session_id: e.session_id.clone(), process: None })
        }))
    }

    async fn final_answer(&self, run: &Run, dirs: &Folders) -> Option<String> {
        let job = match (run.short_id.as_ref(), dirs.config_dir.as_deref()) {
            (Some(id), Some(dir)) => self.cli.job(dir, id).await.ok().flatten(),
            _ => None,
        };
        self.read_answer(run, None, job.as_ref(), dirs).await
    }

    async fn listed_sessions(&self) -> BackendResult<Vec<AgentEntry>> {
        Ok(self.cli.agents(true).await?)
    }

    async fn signed_in(&self) -> BackendResult<bool> {
        Ok(self.cli.auth_status().await?.logged_in)
    }

    async fn trust_file(&self) -> std::result::Result<Option<PathBuf>, Refusal> {
        let auth = self.cli.auth_status().await.map_err(|_| Refusal::CantTell)?;
        crate::runs::trust::config_file(&self.env, &auth).map(Some)
    }

    async fn ready_for_answer(&self, _session: &Session, run: &Run) -> BackendResult<bool> {
        let listed = self.listed_sessions().await?;
        Ok(listed.iter().find(|e| belongs_to(e, &self.instance_id, run)).is_some_and(|e| e.state.as_deref() == Some("blocked") && e.waiting_for.is_none()))
    }

    async fn open_elsewhere(&self, _session: &Session, run: &Run) -> BackendResult<bool> {
        let listed = self.listed_sessions().await?;
        let attached = |e: &AgentEntry| match e.state.as_deref() {
            Some("stopped") => false,
            Some("done") => e.pid.is_some(),
            _ => true,
        };
        Ok(listed.iter().find(|e| belongs_to(e, &self.instance_id, run)).is_some_and(attached))
    }

    async fn stop(&self, session: &Session) -> BackendResult<()> {
        Ok(self.cli.stop(&session.short_id).await?)
    }

    async fn resume(&self, session: &Session, req: &ResumeRequest, waits: &Waits) -> BackendResult<Resumed> {
        let at_rest: &[&str] = if req.finished { &["stopped", "done"] } else { &["stopped"] };
        let deadline = std::time::Instant::now() + waits.stop_wait;
        loop {
            let listed = self.cli.agents(true).await.map_err(|e| BackendError::Other(format!("Couldn't check that the session stopped: {}.", BackendError::from(e))))?;
            if listed.iter().find(|e| e.id.as_deref() == Some(session.short_id.as_str())).is_some_and(|e| e.state.as_deref().is_some_and(|s| at_rest.contains(&s))) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err(BackendError::Other("The session didn't show as stopped or finished, so it wasn't woken.".into()));
            }
            tokio::time::sleep(waits.poll).await;
        }
        if req.settle {
            tokio::time::sleep(waits.stop_settle).await;
        }
        let session_id = session.session_id.as_deref().unwrap_or_default();
        match self.cli.resume(session_id, &req.message, Some(&req.cwd)).await {
            Ok(woken) if woken.short_id == session.short_id => Ok(Resumed::Same(session.clone())),
            Ok(copy) => Ok(Resumed::Copy(copy.short_id)),
            Err(e) => Err(BackendError::Other(format!("Couldn't wake the agent: {}.", BackendError::from(e)))),
        }
    }

    async fn remove(&self, run: &Run, leftovers: &[ShortId], waits: &Waits) -> BackendResult<RemoveOutcome> {
        let live = self.live_sessions(run).await;
        for session in &live {
            self.cli.stop(session).await?;
        }
        let id = live.into_iter().find(|l| !run.earlier_sessions.iter().any(|e| e.short_id == *l)).or_else(|| run.short_id.clone());
        let Some(id) = id else { return Err(BackendError::Other("This run has no session, so there is no worktree to remove.".into())) };
        if run.worktree_removed_at.is_none() {
            if let Removal::Refused(message) = self.remove_session(&id, waits).await? {
                return Ok(RemoveOutcome::Refused(message));
            }
        }
        let (mut gone, mut kept) = (Vec::new(), None);
        for earlier in leftovers.iter().filter(|e| **e != id) {
            match self.remove_session(earlier, waits).await? {
                Removal::Gone => gone.push(earlier.clone()),
                Removal::Refused(message) => {
                    kept.get_or_insert(message);
                }
            }
        }
        Ok(RemoveOutcome::Removed { gone, kept })
    }

    async fn prepare_attach(&self, _session: &Session) -> BackendResult<bool> {
        Ok(false)
    }

    fn attach_words(&self, session: &Session) -> Vec<String> {
        vec!["attach".into(), session.short_id.to_string()]
    }

    fn terminal_words(&self, purpose: Purpose) -> Option<Vec<String>> {
        let words: &[&str] = match purpose {
            Purpose::Trust | Purpose::SignIn => &[],
            Purpose::Mode(RefusedMode::Auto) => &["--permission-mode", "auto"],
            Purpose::Mode(RefusedMode::Bypass) => &["--dangerously-skip-permissions"],
        };
        Some(words.iter().map(|w| (*w).to_owned()).collect())
    }

    fn scratch_dir(&self, session: &Session, dirs: &Folders) -> Option<PathBuf> {
        dirs.config_dir.as_ref().map(|config| config.join("jobs").join(session.short_id.as_str()))
    }

    #[cfg(test)]
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}
