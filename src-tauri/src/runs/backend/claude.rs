//! The backend that runs agents as Claude Code background sessions.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use chrono::{DateTime, Utc};

use super::{BackendError, BackendResult, Folders, LaunchRequest, Observation, Observations, RunBackend, Session, ToolsOffer, Watched};
use crate::domain::{Run, RunState, AGENT_CALL_TIMEOUT_MS, AGENT_GUARD, AGENT_SERVER};
use crate::runs::agent_config::{config_path, AgentLaunch};
use crate::runs::cli::{self, AgentEntry, ClaudeCli, CliError, JobInfo, ShortId};
use crate::runs::env::RunEnv;
use crate::runs::failure::Failure;
use crate::runs::fresh::real;
use crate::runs::final_answer::{answer_folders, timeline_answer};
use crate::runs::state::{progress_at, map_state, with_ask};

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
            let seen = with_ask(map_state(entry, job.as_ref(), run, now, w.misses, w.idle), w.ask.as_deref());
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
}
