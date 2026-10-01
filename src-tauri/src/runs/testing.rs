//! An in-memory `ClaudeCli` for tests that need to script what `claude` does without running a process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;

use super::cli::{AgentEntry, AuthStatus, ClaudeCli, CliError, CliResult, JobInfo, LaunchRequest, Launched, ShortId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Starts,
    /// Exit 1 with `Workspace not trusted` on stderr.
    Untrusted,
    /// Exit 1 with a message, no session.
    Exits,
    /// A session starts but the output has no `backgrounded` line.
    Garbled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resume {
    /// A stopped session continues under its own id; a running one is copied.
    Wakes,
    /// Always starts a copy, as `claude` does when the session still holds on.
    Copies,
    Exits,
    Garbled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResumeCall {
    pub session_id: String,
    pub message: String,
    pub cwd: Option<PathBuf>,
}

pub struct Scripted {
    pub version: String,
    pub logged_in: bool,
    pub bg: bool,
    pub config_dir: std::path::PathBuf,
    pub outcome: Outcome,
    /// How long a launch takes, so overlapping launches can be told apart.
    pub delay: Duration,
    /// New sessions are listed at the clone root until `settle`, as the real CLI does for the first seconds.
    pub lag: bool,
    pub list_fails: bool,
    pub sessions: Vec<AgentEntry>,
    /// What each session's `state.json` and timeline say, by short id.
    pub jobs: HashMap<String, JobInfo>,
    /// Every id `claude stop` was run with.
    pub stops: Vec<String>,
    pub launches: Vec<LaunchRequest>,
    pub resume: Resume,
    pub resumes: Vec<ResumeCall>,
    pub stop_fails: bool,
    /// `claude stop` succeeds but the session is still listed as it was.
    pub stop_lingers: bool,
    /// `stop:<id>` and `resume:<id>` in the order they happened.
    pub calls: Vec<String>,
    pub in_flight: usize,
    pub most_in_flight: usize,
    pub listings: usize,
    next: u32,
    moving: Vec<(String, std::path::PathBuf)>,
}

pub struct FakeCli(pub Mutex<Scripted>);

impl FakeCli {
    pub fn new() -> Self {
        Self(Mutex::new(Scripted {
            version: "2.1.286 (Claude Code)".into(),
            logged_in: true,
            bg: true,
            config_dir: std::env::temp_dir().join("gossamr-fake-claude-config"),
            outcome: Outcome::Starts,
            delay: Duration::ZERO,
            lag: false,
            list_fails: false,
            sessions: vec![],
            jobs: HashMap::new(),
            stops: vec![],
            launches: vec![],
            resume: Resume::Wakes,
            resumes: vec![],
            stop_fails: false,
            stop_lingers: false,
            calls: vec![],
            in_flight: 0,
            most_in_flight: 0,
            listings: 0,
            next: 0,
            moving: vec![],
        }))
    }

    pub fn with(&self, f: impl FnOnce(&mut Scripted)) {
        f(&mut self.0.lock().unwrap());
    }

    pub fn launches(&self) -> usize {
        self.0.lock().unwrap().launches.len()
    }

    /// A session as `claude agents` lists it, working, in `cwd`.
    pub fn session(id: &str, cwd: &Path) -> AgentEntry {
        AgentEntry {
            id: Some(id.into()),
            session_id: Some(format!("{id}-0000-4000-8000-000000000000")),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            kind: Some("background".into()),
            state: Some("working".into()),
            status: Some("busy".into()),
            pid: Some(4242),
            ..AgentEntry::default()
        }
    }

    /// The worktrees now exist: lagging sessions move to them.
    pub fn settle(&self) {
        let mut s = self.0.lock().unwrap();
        for (id, cwd) in std::mem::take(&mut s.moving) {
            if let Some(entry) = s.sessions.iter_mut().find(|e| e.id.as_deref() == Some(id.as_str())) {
                entry.cwd = Some(cwd.to_string_lossy().into_owned());
            }
        }
    }
}

#[async_trait]
impl ClaudeCli for FakeCli {
    async fn version(&self) -> CliResult<String> {
        Ok(self.0.lock().unwrap().version.clone())
    }

    async fn auth_status(&self) -> CliResult<AuthStatus> {
        let s = self.0.lock().unwrap();
        Ok(AuthStatus { logged_in: s.logged_in, config_directory: Some(s.config_dir.clone()), ..AuthStatus::default() })
    }

    async fn supports_bg(&self) -> CliResult<bool> {
        Ok(self.0.lock().unwrap().bg)
    }

    async fn launch(&self, req: &LaunchRequest) -> CliResult<Launched> {
        let delay = {
            let mut s = self.0.lock().unwrap();
            s.launches.push(req.clone());
            s.in_flight += 1;
            s.most_in_flight = s.most_in_flight.max(s.in_flight);
            s.delay
        };
        tokio::time::sleep(delay).await;
        let mut s = self.0.lock().unwrap();
        s.in_flight -= 1;
        match s.outcome {
            Outcome::Untrusted => return Err(CliError::Failed { code: Some(1), stderr: "Workspace not trusted. Run `claude` in the folder once and accept the trust prompt, then retry.".into() }),
            Outcome::Exits => return Err(CliError::Failed { code: Some(1), stderr: "something broke".into() }),
            Outcome::Starts | Outcome::Garbled => {}
        }
        s.next += 1;
        let id = format!("{:08x}", 0xb000_0000u32 + s.next);
        let worktree = req.cwd.join(".claude/worktrees").join(&req.worktree);
        let cwd = if s.lag { req.cwd.clone() } else { worktree.clone() };
        if s.lag {
            s.moving.push((id.clone(), worktree));
        }
        s.sessions.push(AgentEntry { name: Some(req.name.clone()), ..FakeCli::session(&id, &cwd) });
        if s.outcome == Outcome::Garbled {
            return Err(CliError::Unparseable { stdout: "whatever".into() });
        }
        Ok(Launched { short_id: ShortId::parse(&id).expect("hex"), name: Some(req.name.clone()) })
    }

    async fn agents(&self, _all: bool) -> CliResult<Vec<AgentEntry>> {
        let mut s = self.0.lock().unwrap();
        s.listings += 1;
        if s.list_fails {
            return Err(CliError::Failed { code: Some(1), stderr: "daemon unavailable".into() });
        }
        Ok(s.sessions.clone())
    }

    async fn resume(&self, session_id: &str, message: &str, cwd: Option<&Path>) -> CliResult<Launched> {
        let mut s = self.0.lock().unwrap();
        s.resumes.push(ResumeCall { session_id: session_id.into(), message: message.into(), cwd: cwd.map(Path::to_path_buf) });
        match s.resume {
            Resume::Exits => return Err(CliError::Failed { code: Some(1), stderr: "something broke".into() }),
            Resume::Garbled => return Err(CliError::Unparseable { stdout: "whatever".into() }),
            Resume::Wakes | Resume::Copies => {}
        }
        let Some(at) = s.sessions.iter().position(|e| e.session_id.as_deref() == Some(session_id)) else {
            return Err(CliError::Failed { code: Some(1), stderr: format!("No session {session_id}") });
        };
        let original = s.sessions[at].clone();
        if s.resume == Resume::Wakes && original.state.as_deref() == Some("stopped") {
            let entry = &mut s.sessions[at];
            entry.state = Some("working".into());
            entry.pid = Some(4242);
            let id = entry.id.clone().expect("listed");
            s.calls.push(format!("resume:{id}"));
            return Ok(Launched { short_id: ShortId::parse(&id).expect("hex"), name: original.name });
        }
        s.next += 1;
        let id = format!("{:08x}", 0xc000_0000u32 + s.next);
        s.sessions.push(AgentEntry { name: None, ..FakeCli::session(&id, Path::new(original.cwd.as_deref().unwrap_or("/")) ) });
        s.calls.push(format!("resume:{id}"));
        Ok(Launched { short_id: ShortId::parse(&id).expect("hex"), name: None })
    }

    async fn stop(&self, id: &ShortId) -> CliResult<()> {
        let mut s = self.0.lock().unwrap();
        if s.stop_fails {
            return Err(CliError::Failed { code: Some(1), stderr: "couldn't stop".into() });
        }
        s.stops.push(id.to_string());
        s.calls.push(format!("stop:{id}"));
        let lingers = s.stop_lingers;
        if let Some(e) = s.sessions.iter_mut().filter(|_| !lingers).find(|e| e.id.as_deref() == Some(id.as_str())) {
            e.state = Some("stopped".into());
            e.pid = None;
        }
        Ok(())
    }

    async fn rm(&self, _id: &ShortId) -> CliResult<()> {
        Ok(())
    }

    async fn job(&self, _config_dir: &Path, id: &ShortId) -> CliResult<Option<JobInfo>> {
        Ok(self.0.lock().unwrap().jobs.get(id.as_str()).cloned())
    }

    fn binary(&self) -> Option<PathBuf> {
        Some(PathBuf::from("/opt/fake/bin/claude"))
    }
}
