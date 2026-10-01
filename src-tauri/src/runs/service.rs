//! Starts approved runs and finds the ones a restart interrupted.
//!
//! Approval already committed a `Queued` run (`Core::runs_approve`); everything here belongs to that run. A launch that
//! fails leaves the run `Failed` with the reason, and nothing is retried on its own. A run is joined to its session by
//! the worktree path chosen before launch, or by the short id once known, never by name or start time.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::Utc;
use serde::Serialize;

use super::cli::{AgentEntry, LaunchRequest, ShortId};
use super::failure::Failure;
use super::index::{Entry, RunIndex};
use super::launcher::RunLauncher;
use super::preflight::{preflight, Preflight};
use super::repo::{default_roots, existing_names, find_clones, new_name, origin_matches, CloneCache, Git, LocalClone};
use super::toolchain::{Toolchain, ToolchainSource};
use super::control::{MacTerminal, Terminal};
use super::tracker::{Attention, NoNotices, RunNotifier};
use crate::config::AppConfig;
use crate::domain::{render_prompt, Run, RunQuery, RunSpec, RunState, GUARD};
use crate::error::{Error, Result};
use crate::inbox::Core;

pub const MAX_CONCURRENT: usize = 3;

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// How long a run that was launching when the app stopped is looked for.
    pub recover_window: Duration,
    /// After a launch whose answer was lost, how long a session may still be on its way: the session is listed at the
    /// clone root for the first seconds, before its worktree exists.
    pub worktree_grace: Duration,
    pub poll: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { recover_window: Duration::from_secs(90), worktree_grace: Duration::from_secs(10), poll: Duration::from_secs(2) }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneChoice {
    pub clones: Vec<LocalClone>,
    /// The clone the person chose when several matched; listed first.
    pub picked: Option<PathBuf>,
}

pub struct RunService {
    pub(super) core: Arc<Core>,
    pub(super) tools: Arc<dyn ToolchainSource>,
    pub(super) index: RunIndex,
    /// Held from the cap check to the end of the launch, so two approvals can't both pass the cap. The tracker takes
    /// it while it writes runs, so a poll never overwrites a launch half-recorded.
    pub(super) launching: tokio::sync::Mutex<()>,
    /// Recovery runs at startup and again after sign-in; two passes must not act on the same run. The tracker skips a
    /// poll while one is running.
    pub(super) recovery: tokio::sync::Mutex<()>,
    in_flight: Mutex<HashSet<String>>,
    clones: CloneCache,
    roots: Vec<PathBuf>,
    pub(super) changed: Arc<dyn Fn(&str) + Send + Sync>,
    pub(super) notifier: Arc<dyn RunNotifier>,
    pub(super) terminal: Arc<dyn Terminal>,
    enabled: AtomicBool,
    /// Held across a read-modify-write of `config.json`, so the enable switch and a picked clone can't undo each other.
    pub(super) config_lock: Mutex<()>,
    /// One switch at a time: turning on reads the environment, which can take a while.
    pub(super) switching: tokio::sync::Mutex<()>,
    cap: usize,
    timing: Timing,
    pub(super) misses: Mutex<std::collections::HashMap<String, u32>>,
    pub(super) config_dir: Mutex<Option<PathBuf>>,
    /// Wakes the tracker when the window gains focus.
    pub focus: tokio::sync::Notify,
}

/// The nearest existing ancestor made real, with the rest appended: a worktree that doesn't exist yet still compares
/// equal to the path `claude agents` reports once it does, even when a parent is a symlink (`/var` and `/private/var`).
pub(super) fn real(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut base = path.to_path_buf();
    loop {
        if let Ok(canon) = base.canonicalize() {
            return rest.iter().rev().fold(canon, |p, part| p.join(part));
        }
        match (base.file_name().map(|n| n.to_owned()), base.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Whether `entry` is the session of `run`. Interactive sessions never are.
pub(super) fn belongs_to(entry: &AgentEntry, run: &Run) -> bool {
    let Some(id) = entry.id.as_deref().and_then(ShortId::parse) else { return false };
    if entry.kind.as_deref() == Some("interactive") {
        return false;
    }
    run.short_id.as_ref() == Some(&id) || entry.cwd.as_deref().is_some_and(|cwd| real(Path::new(cwd)) == real(&run.expected_worktree))
}

fn entry_of(run: &Run) -> Entry {
    Entry {
        db_file: run.db_file.clone(),
        run_id: run.id.clone(),
        expected_worktree: run.expected_worktree.clone(),
        short_id: run.short_id.clone(),
        terminal: false,
    }
}

fn claude_error(why: Failure) -> Error {
    Error::Claude(why.to_string())
}

impl RunService {
    pub fn new(core: Arc<Core>, tools: Arc<dyn ToolchainSource>, index: RunIndex, roots: Vec<PathBuf>, changed: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        Self {
            core,
            tools,
            index,
            launching: tokio::sync::Mutex::new(()),
            recovery: tokio::sync::Mutex::new(()),
            in_flight: Mutex::new(HashSet::new()),
            clones: CloneCache::default(),
            roots,
            changed,
            notifier: Arc::new(NoNotices),
            terminal: Arc::new(MacTerminal),
            enabled: AtomicBool::new(false),
            config_lock: Mutex::new(()),
            switching: tokio::sync::Mutex::new(()),
            cap: MAX_CONCURRENT,
            timing: Timing::default(),
            misses: Mutex::new(std::collections::HashMap::new()),
            config_dir: Mutex::new(None),
            focus: tokio::sync::Notify::new(),
        }
    }

    #[cfg(test)]
    pub fn with_terminal(mut self, terminal: Arc<dyn Terminal>) -> Self {
        self.terminal = terminal;
        self
    }

    pub fn with_notifier(mut self, notifier: Arc<dyn RunNotifier>) -> Self {
        self.notifier = notifier;
        self
    }

    pub fn default_roots() -> Vec<PathBuf> {
        dirs::home_dir().map(|h| default_roots(&h)).unwrap_or_default()
    }

    pub fn enabled(self, on: bool) -> Self {
        self.enabled.store(on, Ordering::SeqCst);
        self
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub(super) fn set_flag(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub fn with_cap(mut self, cap: usize) -> Self {
        self.cap = cap;
        self
    }

    #[cfg(test)]
    pub fn with_timing(mut self, timing: Timing) -> Self {
        self.timing = timing;
        self
    }

    /// Finds `claude` and reads the shell environment now, so the first approval doesn't wait for it.
    pub async fn warm(&self) {
        let _ = self.tools.get().await;
    }

    pub fn ensure_enabled(&self) -> Result<()> {
        if self.is_enabled() {
            Ok(())
        } else {
            Err(Error::Claude("Agents are turned off. Turn them on in Settings.".into()))
        }
    }

    pub(super) async fn load(&self, id: &str) -> Result<Run> {
        self.core.run(id).await?.ok_or_else(|| Error::Proposal("that run no longer exists".into()))
    }

    pub(super) async fn store(&self, run: &Run) -> Result<()> {
        self.core.save_run(run).await?;
        (self.changed)(&run.connection_id);
        Ok(())
    }

    /// The index is a hint, so a failed write is not worth failing a launch over.
    pub(super) fn remember(&self, run: &Run) {
        if let Err(e) = self.index.record(entry_of(run)) {
            eprintln!("couldn't update the run index: {e}");
        }
    }

    async fn fail(&self, run: &mut Run, why: &Failure) -> Result<()> {
        let now = Utc::now();
        run.state = RunState::Failed;
        run.error = Some(why.to_string());
        run.ended_at = Some(now);
        run.last_progress_at = now;
        if let Err(e) = self.index.mark_terminal(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.store(run).await?;
        self.notifier.notify(run, Attention::Failed);
        Ok(())
    }

    /// The run is its session from here on; the tracker (which reads `claude agents`) takes over the state.
    async fn adopt(&self, run: &mut Run, entry: &AgentEntry) -> Result<()> {
        if let Some(id) = entry.id.as_deref().and_then(ShortId::parse) {
            run.short_id = Some(id);
        }
        run.session_id = entry.session_id.clone().or(run.session_id.take());
        run.state = RunState::Launching;
        run.error = None;
        run.ended_at = None;
        run.launched_at.get_or_insert_with(Utc::now);
        self.remember(run);
        self.store(run).await
    }

    fn live_elsewhere(&self, run: &Run) -> usize {
        self.index.live().iter().filter(|e| e.run_id != run.id).count()
    }

    /// Everything that can be known to be wrong before a session is spawned. Cheap checks first.
    async fn check(&self, run: &Run, tc: &Toolchain) -> std::result::Result<(), Failure> {
        let spec = &run.spec;
        spec.validate().map_err(|e| Failure::Invalid(e.to_string()))?;
        let live = self.live_elsewhere(run);
        if live >= self.cap {
            return Err(Failure::CapReached(live));
        }
        let clone = &spec.clone_path;
        if !(clone.is_dir() && clone.join(".git").exists()) {
            return Err(Failure::NoClone(format!("{} isn't a git clone any more", clone.display())));
        }
        if clone.canonicalize().ok().as_ref() != Some(clone) {
            return Err(Failure::NoClone(format!("{} isn't its real path any more; edit the draft and review it again", clone.display())));
        }
        match Git::new(tc.env.clone()).origin(clone).await {
            Some(url) if origin_matches(&url, &spec.repo) => {}
            Some(_) => return Err(Failure::NoClone(format!("{} isn't a clone of {}: its origin is another repository", clone.display(), spec.repo))),
            None => return Err(Failure::NoClone(format!("Git couldn't read the origin of {}", clone.display()))),
        }
        let auth = tc.cli.auth_status().await.map_err(|e| Failure::from_cli(e, clone))?;
        if !auth.logged_in {
            return Err(Failure::NotSignedIn);
        }
        if !tc.cli.supports_bg().await.map_err(|e| Failure::from_cli(e, clone))? {
            return Err(Failure::TooOld);
        }
        Ok(())
    }

    /// The run's session, if `claude agents` lists one. After a launch whose answer was lost the session may still be
    /// listed at the clone root, so this keeps looking until the worktree has had time to appear.
    async fn find_session(&self, run: &Run) -> std::result::Result<Option<AgentEntry>, Failure> {
        let tc = self.tools.get().await?;
        let since = run.launched_at.and_then(|at| (Utc::now() - at).to_std().ok()).unwrap_or(Duration::MAX);
        let deadline = Instant::now() + self.timing.worktree_grace.saturating_sub(since);
        loop {
            let entries = tc.cli.agents(true).await.map_err(|e| Failure::from_cli(e, &run.spec.clone_path))?;
            if let Some(found) = entries.into_iter().find(|e| belongs_to(e, run)) {
                return Ok(Some(found));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            tokio::time::sleep(self.timing.poll).await;
        }
    }

    /// Runs the launch for a run that has been checked eligible. Returns with the run `Launching` or `Failed`.
    async fn spawn(&self, run: &mut Run) -> Result<()> {
        let tc = match self.tools.get().await {
            Ok(tc) => tc,
            Err(e) => return self.fail(run, &e.into()).await,
        };
        if let Err(why) = self.check(run, &tc).await {
            return self.fail(run, &why).await;
        }
        let now = Utc::now();
        run.state = RunState::Launching;
        run.launched_at = Some(now);
        run.last_progress_at = now;
        run.error = None;
        run.ended_at = None;
        self.store(run).await?;
        self.remember(run);

        let spec = &run.spec;
        let label = run.item.as_ref().map_or("Agent", |i| i.key.as_str());
        let request = LaunchRequest {
            cwd: spec.clone_path.clone(),
            name: format!("{label} {}", spec.kind.as_str()),
            worktree: spec.name.clone(),
            guard: GUARD.into(),
            prompt: render_prompt(spec),
        };
        self.in_flight.lock().expect("in-flight lock poisoned").insert(run.id.clone());
        let outcome = tc.cli.launch(&request).await;
        self.in_flight.lock().expect("in-flight lock poisoned").remove(&run.id);
        match outcome {
            Ok(launched) => {
                run.short_id = Some(launched.short_id);
                self.remember(run);
                self.store(run).await
            }
            Err(e) => {
                let why = Failure::from_cli(e, &run.spec.clone_path);
                self.fail(run, &why).await
            }
        }
    }

    /// Starts a queued run, or with `retry` a failed one that never got a session. Returns whether it did anything.
    async fn start(&self, run_id: &str, retry: bool) -> Result<(Run, bool)> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        // Turning Agents off takes this lock too, so a start that waited for it can't launch after the switch went off.
        self.ensure_enabled()?;
        let mut run = self.load(run_id).await?;
        let eligible = if retry { run.state == RunState::Failed && run.short_id.is_none() } else { run.state == RunState::Queued };
        if !eligible {
            return Ok((run, false));
        }
        if retry {
            match self.find_session(&run).await {
                Ok(Some(found)) => {
                    self.adopt(&mut run, &found).await?;
                    return Ok((run, true));
                }
                Ok(None) => {}
                Err(why) => {
                    self.fail(&mut run, &why).await?;
                    return Ok((run, true));
                }
            }
        }
        self.spawn(&mut run).await?;
        Ok((run, true))
    }

    /// For a run that is queued, as after a restart. Does nothing for any other state.
    pub async fn start_now(&self, run_id: &str) -> Result<Run> {
        match self.start(run_id, false).await? {
            (run, true) => Ok(run),
            (run, false) => Err(Error::Proposal(format!("This run is {}, so it can't be started.", run.state.as_str()))),
        }
    }

    /// Looks for the session of a failed launch and adopts it; only when there is none does it launch again.
    pub async fn retry_launch(&self, run_id: &str) -> Result<Run> {
        match self.start(run_id, true).await? {
            (run, true) => Ok(run),
            (run, false) => Err(Error::Proposal(format!("This run is {} and has nothing to retry.", run.state.as_str()))),
        }
    }

    /// After a restart: runs that were launching are matched to their sessions for up to the recovery window, adopted
    /// if found and failed if not. Queued runs stay queued. Live runs missing from the index are put back.
    pub async fn recover(&self) {
        if !self.is_enabled() {
            return;
        }
        let _only_pass = self.recovery.lock().await;
        let live = vec![RunState::Launching, RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked, RunState::Unknown];
        let Ok(runs) = self.core.runs_list(&RunQuery { states: Some(live), ..RunQuery::default() }).await else { return };
        runs.iter().filter(|r| !self.index.contains(&r.id)).for_each(|r| self.remember(r));
        let in_flight = self.in_flight.lock().expect("in-flight lock poisoned").clone();
        let mut waiting: Vec<Run> = runs.into_iter().filter(|r| r.state == RunState::Launching && !in_flight.contains(&r.id)).collect();
        let deadline = Instant::now() + self.timing.recover_window;
        let mut why = Failure::Interrupted;
        while !waiting.is_empty() {
            match self.tools.get().await {
                Err(e) => {
                    why = e.into();
                    break;
                }
                Ok(tc) => {
                    if let Ok(entries) = tc.cli.agents(true).await {
                        let mut unmatched = Vec::new();
                        for mut run in waiting {
                            match entries.iter().find(|e| belongs_to(e, &run)) {
                                Some(found) => {
                                    let _ = self.adopt(&mut run, found).await;
                                }
                                None => unmatched.push(run),
                            }
                        }
                        waiting = unmatched;
                    }
                }
            }
            if waiting.is_empty() || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(self.timing.poll).await;
        }
        for mut run in waiting {
            let _ = self.fail(&mut run, &why).await;
        }
    }

    pub async fn preflight(&self, spec: Option<RunSpec>) -> Result<Preflight> {
        self.ensure_enabled()?;
        Ok(preflight(spec.as_ref(), &*self.tools, &self.index, self.cap).await)
    }

    async fn git(&self) -> Result<Git> {
        Ok(Git::new(self.tools.get().await.map_err(|e| claude_error(e.into()))?.env))
    }

    async fn scan(&self, repo: &str) -> Result<Vec<LocalClone>> {
        self.core.require_watched_repo(repo)?;
        Ok(find_clones(&self.git().await?, repo, &self.roots).await)
    }

    /// Local clones of a watched repository, from a scan cached for ten minutes. The one the person chose, if it is
    /// still a clone, comes first.
    pub async fn clones(&self, repo: &str) -> Result<CloneChoice> {
        self.ensure_enabled()?;
        let mut clones = match self.clones.get(repo) {
            Some(cached) => cached,
            None => {
                let scanned = self.scan(repo).await?;
                self.clones.put(repo, scanned.clone());
                scanned
            }
        };
        let dir = self.core.data_dir();
        let picked = AppConfig::load(&dir).picked_clones.get(&repo.to_ascii_lowercase()).cloned().filter(|p| clones.iter().any(|c| &c.path == p));
        if let Some(path) = &picked {
            clones.sort_by_key(|c| &c.path != path);
        }
        Ok(CloneChoice { clones, picked })
    }

    /// Remembers which clone to use for a repository. Only a clone the scan finds can be picked.
    pub async fn pick_clone(&self, repo: &str, path: &Path) -> Result<()> {
        self.ensure_enabled()?;
        let path = path.canonicalize().map_err(|_| Error::Proposal(format!("{} isn't a folder that exists", path.display())))?;
        let scanned = self.scan(repo).await?;
        self.clones.put(repo, scanned.clone());
        if !scanned.iter().any(|c| c.path == path) {
            return Err(Error::Proposal(format!("{} isn't a clone of {repo} that Gossamr found", path.display())));
        }
        self.update_config(|config| {
            config.picked_clones.insert(repo.to_ascii_lowercase(), path);
        })
    }

    /// A worktree name for a new run in `clone`, not used by any worktree or leftover branch there.
    pub async fn suggest_name(&self, clone: &Path, key: &str, title: &str) -> Result<String> {
        self.ensure_enabled()?;
        if !(clone.is_absolute() && clone.is_dir()) {
            return Err(Error::Proposal(format!("{} isn't a folder that exists", clone.display())));
        }
        let taken = existing_names(&self.git().await?, clone).await;
        Ok(new_name(key, title, &taken))
    }
}

#[async_trait]
impl RunLauncher for RunService {
    /// Starts a freshly approved run. A run that isn't queued is left alone, so calling this twice never starts two.
    async fn launch(&self, run_id: &str) -> Result<()> {
        self.start(run_id, false).await.map(drop)
    }
}

#[cfg(test)]
mod tests;
