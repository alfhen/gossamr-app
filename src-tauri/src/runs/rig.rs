//! A signed-in account with a clone, a scripted `claude` and a recording notifier, for the tracker and control tests.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::Utc;

use crate::config::TerminalChoice;
use super::cli::{AgentEntry, JobInfo, ShortId, TimelineLine};
use super::control::Terminal;
use super::env::RunEnv;
use super::index::RunIndex;
use super::repo::testing::{clone_with_origin, install_fake_git};
use super::service::RunService;
use super::testing::FakeCli;
use super::toolchain::{FixedToolchain, Toolchain};
use super::tracker::{Attention, RunNotifier};
use crate::domain::fixtures::run_spec;
use crate::domain::{Run, RunSpec, RunState};
use crate::inbox::testing::{fixture_watching, Fixture};

#[derive(Default)]
pub struct Notices(pub Mutex<Vec<(String, Attention, RunState)>>);

impl RunNotifier for Notices {
    fn notify(&self, run: &Run, why: Attention) {
        self.0.lock().unwrap().push((run.id.clone(), why, run.state));
    }
}

#[derive(Default)]
pub struct Opened(pub Mutex<Vec<PathBuf>>, pub Mutex<Vec<TerminalChoice>>);

impl Terminal for Opened {
    fn open(&self, file: &Path, app: TerminalChoice) -> std::io::Result<()> {
        self.0.lock().unwrap().push(file.to_path_buf());
        self.1.lock().unwrap().push(app);
        Ok(())
    }
}

pub struct Rig {
    pub fx: Fixture,
    pub svc: Arc<RunService>,
    pub cli: Arc<FakeCli>,
    pub clone: PathBuf,
    pub notices: Arc<Notices>,
    pub opened: Arc<Opened>,
    pub changes: Arc<Mutex<Vec<String>>>,
    pub drafted: Arc<Mutex<Vec<String>>>,
}

pub async fn ready() -> Rig {
    ready_with(|svc| svc).await
}

/// `ready`, with the service tuned before it is shared.
pub async fn ready_with(tune: impl FnOnce(RunService) -> RunService) -> Rig {
    ready_on(fixture_watching(&["acme/webshop"]).await, tune).await
}

/// `ready_with` on a fixture of the caller's, such as one with GitHub routes scripted.
pub async fn ready_on(fx: Fixture, tune: impl FnOnce(RunService) -> RunService) -> Rig {
    let clone = fx.home.join("webshop");
    clone_with_origin(&clone, "https://github.com/acme/webshop.git");
    let clone = clone.canonicalize().unwrap();
    let cli = Arc::new(FakeCli::new());
    cli.with(|s| s.config_dir = fx.dir.join("claude-config"));
    let bin = install_fake_git(&fx.dir);
    let env = Arc::new(RunEnv::from_pairs([("PATH", format!("{}:/usr/bin:/bin", bin.display()))]));
    let tools = FixedToolchain(Ok(Toolchain { cli: cli.clone(), env }));
    let (notices, opened, changes) = (Arc::new(Notices::default()), Arc::new(Opened::default()), Arc::new(Mutex::new(Vec::new())));
    let seen = changes.clone();
    let drafted = Arc::new(Mutex::new(Vec::new()));
    let told = drafted.clone();
    let svc = RunService::new(
        fx.core.clone(),
        Arc::new(tools),
        RunIndex::load(&fx.dir.join("index")),
        vec![fx.home.clone()],
        Arc::new(move |id| seen.lock().unwrap().push(id.to_string())),
    )
    .enabled(true)
    .with_drafted(Arc::new(move |id| told.lock().unwrap().push(id.to_string())))
    .with_notifier(notices.clone())
    .with_terminal(opened.clone())
    .with_home(fx.home.canonicalize().unwrap());
    Rig { fx, svc: Arc::new(tune(svc)), cli, clone, notices, opened, changes, drafted }
}

pub fn line(at: &str, state: &str, text: &str) -> TimelineLine {
    TimelineLine { at: Some(at.into()), state: Some(state.into()), detail: None, text: Some(text.into()) }
}

impl Rig {
    pub fn spec(&self, n: u32) -> RunSpec {
        RunSpec { clone_path: self.clone.clone(), name: format!("eng-1-fix-cart-{n:04x}"), ..run_spec() }
    }

    /// Approved and launched through the scripted CLI: `Launching`, with a short id and a listed session.
    pub async fn launched(&self, n: u32) -> Run {
        let p = self.fx.core.draft_run(self.spec(n), Some(self.fx.item("CA-1"))).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        let queued = self.fx.core.runs_approve(&p.id, &digest).await.unwrap();
        self.svc.start_now(&queued.id).await.unwrap()
    }

    /// Approved with the report tool asked for and launched; the service must have been built with `reporting`.
    pub async fn launched_reporting(&self, n: u32, kind: crate::domain::RunKind) -> Run {
        let p = self.fx.core.draft_run(RunSpec { kind, report: true, ..self.spec(n) }, Some(self.fx.item("CA-1"))).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        let queued = self.fx.core.runs_approve(&p.id, &digest).await.unwrap();
        self.svc.start_now(&queued.id).await.unwrap()
    }

    /// Like `launched`, for a run of another kind on the ticket.
    pub async fn launched_as(&self, n: u32, kind: crate::domain::RunKind) -> Run {
        let p = self.fx.core.draft_run(RunSpec { kind, ..self.spec(n) }, Some(self.fx.item("CA-1"))).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        let queued = self.fx.core.runs_approve(&p.id, &digest).await.unwrap();
        self.svc.start_now(&queued.id).await.unwrap()
    }

    /// An investigation with no ticket, started to end as a draft ticket in the fixture's first project.
    pub async fn launched_ticketless(&self, n: u32) -> Run {
        let project = self.fx.core.containers_in(&self.fx.scope).await.unwrap()[0].container_ref.clone();
        let spec = RunSpec { project: Some(project), instruction: String::new(), ..self.spec(n) };
        let p = self.fx.core.draft_run(spec, None).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        let queued = self.fx.core.runs_approve(&p.id, &digest).await.unwrap();
        self.svc.start_now(&queued.id).await.unwrap()
    }

    /// Like `launched`, for a run in a workstream opened on the ticket; with the workstream's id.
    pub async fn launched_in_workstream(&self, n: u32) -> (Run, String) {
        let ws = self.fx.core.open_workstream(&self.fx.scope, Some(self.fx.item("CA-1")), None).await.unwrap();
        let p = self.fx.core.draft_run(RunSpec { workstream: Some(ws.id.clone()), ..self.spec(n) }, Some(self.fx.item("CA-1"))).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        let queued = self.fx.core.runs_approve(&p.id, &digest).await.unwrap();
        (self.svc.start_now(&queued.id).await.unwrap(), ws.id)
    }

    /// What the person did to runs, as workstream `ws`'s audit has it: action, run id and detail.
    pub async fn run_actions(&self, ws: &str) -> Vec<(String, Option<String>, Option<String>)> {
        let events = self.fx.core.workstream_events(&self.fx.scope, ws).await.unwrap();
        events.into_iter().filter(|e| e.action.starts_with("run_") && e.action != "run_approved").map(|e| (e.action, e.run_id, e.detail)).collect()
    }

    pub async fn queued(&self, n: u32) -> Run {
        let p = self.fx.core.draft_run(self.spec(n), Some(self.fx.item("CA-1"))).await.unwrap();
        let digest = self.fx.core.runs_review(&p.id).await.unwrap().digest;
        self.fx.core.runs_approve(&p.id, &digest).await.unwrap()
    }

    pub async fn get(&self, run: &Run) -> Run {
        self.fx.core.run(&run.id).await.unwrap().unwrap()
    }

    pub async fn set(&self, run: &Run, f: impl FnOnce(&mut Run)) -> Run {
        let mut run = self.get(run).await;
        f(&mut run);
        self.fx.core.save_run(&run).await.unwrap();
        run
    }

    /// Changes the listed session of `run`.
    pub fn session(&self, run: &Run, f: impl FnOnce(&mut AgentEntry)) {
        let id = run.short_id.as_ref().expect("launched");
        self.cli.with(|s| f(s.sessions.iter_mut().find(|e| e.id.as_deref() == Some(id.as_str())).expect("listed")));
    }

    /// What the session's `state.json` and timeline say.
    pub fn job(&self, id: &ShortId, f: impl FnOnce(&mut JobInfo)) {
        self.cli.with(|s| f(s.jobs.entry(id.to_string()).or_default()));
    }

    pub fn noticed(&self) -> Vec<(Attention, RunState)> {
        self.notices.0.lock().unwrap().iter().map(|(_, why, state)| (*why, *state)).collect()
    }

    pub async fn poll(&self) {
        self.svc.poll_at(Utc::now()).await;
    }
}

/// A service that offers the report tool on a channel in `dir`, with the setting on.
pub fn reporting(dir: &Path) -> impl FnOnce(RunService) -> RunService {
    let channel = Arc::new(super::report::ReportChannel::new(4242, dir.join("report")));
    move |svc| {
        let settings = crate::config::AgentSettings { report_result: true, ..svc.settings() };
        svc.with_settings(settings).with_report(channel)
    }
}
