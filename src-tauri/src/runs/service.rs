//! Starts queued runs and finds the ones a restart interrupted.
//!
//! Pip's start committed a `Queued` run (`Core::commit_pip_run`); everything here belongs to that run. A launch that
//! fails leaves the run `Failed` with the reason, and nothing is retried on its own. A run over the cap is not
//! a failure: it stays `Queued`, waiting for a slot, and `launch_waiting` starts it once one frees. A run is joined to its session by
//! the worktree path chosen before launch, or by the short id once known, never by name or start time.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use super::backend;
use super::cli::{AgentEntry, ShortId};
use super::redact::redact;
use super::failure::Failure;
use super::index::{Entry, RunIndex};
use super::launcher::RunLauncher;
use super::fresh::is_work_path;
use super::repo::{origin_matches, random_hex, CommitIdentity, Git};
use super::toolchain::{Toolchain, ToolchainSource};
use self::choice::{Blocked, Target};
pub(super) use self::choice::waiting_words;
use super::control::{MacTerminal, Terminal};
use super::tracker::{Attention, NoNotices, RunNotifier};
use crate::config::{AgentSettings, AppConfig};
use crate::domain::{render_prompt, Actor, Role, Run, RunEvent, RunQuery, RunState, GUARD, AGENT_GUARD};
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
    /// How long `claude agents` is asked for `stopped` after a stop, before an answer is given up on.
    pub stop_wait: Duration,
    /// Pause after `stopped` is listed, before waking the session: resumed at once, `claude` sometimes starts a copy
    /// instead (2 of 3 tries); after 3 s it never did in 5 tries.
    pub stop_settle: Duration,
    /// How long `cleanup` waits between tries while Claude still holds its lock on a stopped session's worktree.
    pub rm_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { recover_window: Duration::from_secs(90), worktree_grace: Duration::from_secs(10), poll: Duration::from_secs(2), stop_wait: Duration::from_secs(10), stop_settle: Duration::from_secs(5), rm_wait: Duration::from_secs(1) }
    }
}

pub struct RunService {
    pub(super) core: Arc<Core>,
    pub(super) tools: Arc<dyn ToolchainSource>,
    pub(super) index: RunIndex,
    /// Held from the cap check to the end of the launch, so two approvals can't both pass the cap. The tracker takes
    /// it while it writes runs, so a poll never overwrites a launch half-recorded. It is `Core`'s lock, which removing a
    /// provider instance also takes.
    pub(super) launching: Arc<tokio::sync::Mutex<()>>,
    /// Recovery runs at startup and again after sign-in; two passes must not act on the same run. The tracker skips a
    /// poll while one is running.
    pub(super) recovery: tokio::sync::Mutex<()>,
    in_flight: Mutex<HashSet<String>>,
    /// Runs whose worktree is being removed, so two requests can't both call `claude rm` for one.
    pub(super) cleaning: Mutex<HashSet<String>>,
    /// One lock per repository (lower case), held while its clone in `~/Gossamr/agents` is made or fetched into.
    repo_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// When each repository was last fetched into, so launches close together fetch once.
    fetched: Mutex<HashMap<String, Instant>>,
    /// Failed deliveries of a queued message, per run, so a wake that keeps failing is dropped instead of retried forever.
    pub(super) delivery_failures: Mutex<std::collections::HashMap<String, u8>>,
    pub(super) changed: Arc<dyn Fn(&str) + Send + Sync>,
    pub(super) notifier: Arc<dyn RunNotifier>,
    /// Which workstreams already told the person they wait on them, and the finished runs not yet told.
    pub(super) notices: Mutex<super::notices::Board>,
    pub(super) terminal: Arc<dyn Terminal>,
    pub(super) home: Option<PathBuf>,
    pub(super) settings: Mutex<AgentSettings>,
    /// Where Gossamr's tools are served for agents; absent when the server couldn't start.
    pub(super) agents: Option<Arc<super::agent_config::AgentChannel>>,
    pub(super) timing: Timing,
    pub(super) misses: Mutex<std::collections::HashMap<String, u32>>,
    pub(super) idle_polls: Mutex<std::collections::HashMap<String, u32>>,
    /// What `claude auth status` reported, by instance id: each instance has its own folder.
    pub(super) config_dir: Mutex<HashMap<String, PathBuf>>,
    pub(super) projects_dir: Mutex<HashMap<String, PathBuf>>,
    /// Wakes the tracker when the window gains focus.
    pub focus: tokio::sync::Notify,
    /// When this service was made, so recovery can tell a slot wait from before a restart from one of this session's.
    pub(super) started_at: DateTime<Utc>,
}

pub(super) use super::fresh::real;

/// Whether `entry`, listed by the login `listed_on`, is the session of `run`. Interactive sessions never are, and short
/// ids can repeat across logins, so a run only matches the listing of its own.
pub(super) fn belongs_to(entry: &AgentEntry, listed_on: &str, run: &Run) -> bool {
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
    run.short_id.as_ref() == Some(&id) || entry.cwd.as_deref().is_some_and(|cwd| real(Path::new(cwd)) == real(&run.expected_worktree))
}

/// How a session is titled in Claude's own lists. Only the title carries the prefix: the worktree folder and branch
/// take `spec.name`, and the spec (and so its digest) is left as approved.
fn session_name(label: &str, role: &Role) -> String {
    format!("{SESSION_PREFIX}{label} {}", role.as_str())
}

/// The title Gossamr gave the run's session when it launched it.
pub(super) fn title_of(run: &Run) -> String {
    session_name(run.item.as_ref().map_or("Agent", |i| i.key.as_str()), &run.spec.role)
}

const SESSION_PREFIX: &str = "Gossamr: ";

fn entry_of(run: &Run) -> Entry {
    Entry {
        run_id: run.id.clone(),
        expected_worktree: run.expected_worktree.clone(),
        short_id: run.short_id.clone(),
        terminal: false,
        instance_id: run.instance_id().to_owned(),
    }
}

fn claude_error(why: Failure) -> Error {
    Error::Claude(why.to_string())
}

impl RunService {
    pub fn new(core: Arc<Core>, tools: Arc<dyn ToolchainSource>, index: RunIndex, changed: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        Self {
            launching: core.launching.clone(),
            core,
            tools,
            index,
            recovery: tokio::sync::Mutex::new(()),
            in_flight: Mutex::new(HashSet::new()),
            cleaning: Mutex::new(HashSet::new()),
            repo_locks: Mutex::new(HashMap::new()),
            fetched: Mutex::new(HashMap::new()),
            delivery_failures: Mutex::new(Default::default()),
            changed,
            notifier: Arc::new(NoNotices),
            notices: Mutex::new(Default::default()),
            terminal: Arc::new(MacTerminal),
            home: dirs::home_dir(),
            settings: Mutex::new(AgentSettings { max_runs: MAX_CONCURRENT, ..AgentSettings::default() }),
            agents: None,
            timing: Timing::default(),
            misses: Mutex::new(std::collections::HashMap::new()),
            idle_polls: Mutex::new(std::collections::HashMap::new()),
            config_dir: Mutex::new(HashMap::new()),
            projects_dir: Mutex::new(HashMap::new()),
            focus: tokio::sync::Notify::new(),
            started_at: Utc::now(),
        }
    }

    #[cfg(test)]
    pub fn with_terminal(mut self, terminal: Arc<dyn Terminal>) -> Self {
        self.terminal = terminal;
        self
    }

    #[cfg(test)]
    pub fn with_home(mut self, home: PathBuf) -> Self {
        self.home = Some(home);
        self
    }

    /// The launch lock, for a test that holds it while something else runs.
    #[cfg(test)]
    pub(crate) fn launching_lock(&self) -> &tokio::sync::Mutex<()> {
        &self.launching
    }

    pub fn with_notifier(mut self, notifier: Arc<dyn RunNotifier>) -> Self {
        self.notifier = notifier;
        self
    }

    pub fn with_settings(self, settings: AgentSettings) -> Self {
        let settings = settings.clamped();
        *self.settings.lock().expect("settings lock poisoned") = settings;
        self
    }

    #[cfg(test)]
    pub fn with_cap(self, cap: usize) -> Self {
        self.settings.lock().expect("settings lock poisoned").max_runs = cap;
        self
    }

    #[cfg(test)]
    pub fn with_timing(mut self, timing: Timing) -> Self {
        self.timing = timing;
        self
    }

    /// Resolves when an agent has put up a question, so the tracker can look at its run at once.
    pub async fn question_asked(&self) {
        self.core.asks().opened().await;
    }

    /// Finds `claude` and reads the shell environment now, so the first approval doesn't wait for it.
    pub async fn warm(&self) {
        let _ = self.tools.get().await;
    }

    pub(super) fn update_config(&self, change: impl FnOnce(&mut AppConfig)) -> Result<()> {
        AppConfig::update(&self.core.data_dir(), change)
    }

    pub(super) async fn load(&self, id: &str) -> Result<Run> {
        self.core.run(id).await?.ok_or_else(|| Error::Proposal("that run no longer exists".into()))
    }

    pub(super) async fn store(&self, run: &Run) -> Result<()> {
        self.core.save_run(run).await?;
        (self.changed)(&run.connection_id);
        Ok(())
    }

    /// Forgets a run's counts of missing processes and idle polls.
    pub(super) fn reset_counts(&self, run_id: &str) {
        self.misses.lock().expect("misses lock poisoned").remove(run_id);
        self.idle_polls.lock().expect("idle polls lock poisoned").remove(run_id);
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
        run.error = Some(redact(&why.to_string()));
        run.failure = Some(why.into());
        run.ended_at = Some(now);
        run.last_progress_at = now;
        if let Err(e) = self.index.mark_terminal(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.store(run).await?;
        self.notify_run(run, Attention::Failed);
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
        run.failure = None;
        run.ended_at = None;
        run.launched_at.get_or_insert_with(Utc::now);
        self.remember(run);
        self.store(run).await
    }

    pub(super) fn live_elsewhere(&self, run: &Run) -> usize {
        self.index.live().iter().filter(|e| e.run_id != run.id).count()
    }

    /// Everything that can be known to be wrong before a session is spawned. Cheap checks first.
    async fn check(&self, run: &Run, tc: &Toolchain) -> std::result::Result<(), Failure> {
        let spec = &run.spec;
        spec.validate().map_err(|e| Failure::Invalid(e.to_string()))?;
        let home = self.fresh_home().ok_or_else(|| Failure::NoClone("Gossamr can't find your home folder.".into()))?;
        if !is_work_path(&home, &spec.repo, &spec.clone_path) {
            return Err(Failure::OutsideWorkFolder { path: spec.clone_path.clone() });
        }
        self.core.require_watched_repo(&spec.repo).map_err(|e| Failure::Invalid(e.to_string()))?;
        if spec.pr.is_some() {
            self.core.review_current(spec).await.map_err(|e| Failure::Invalid(e.to_string()))?;
        }
        let live = self.live_elsewhere(run);
        if live >= self.cap() {
            return Err(Failure::CapReached(live));
        }
        let clone = &spec.clone_path;
        if !(clone.is_dir() && clone.join(".git").exists()) {
            return Err(Failure::NoClone(format!("{} isn't a git clone any more", clone.display())));
        }
        if clone.canonicalize().ok().as_ref() != Some(clone) {
            return Err(Failure::NoClone(format!("{} isn't its real path any more", clone.display())));
        }
        match Git::new(tc.env.clone()).origin_or_why(clone).await {
            Ok(url) if origin_matches(&url, &spec.repo) => {}
            Ok(_) => return Err(Failure::NoClone(format!("{} isn't a clone of {}: its origin is another repository", clone.display(), spec.repo))),
            Err(why) => return Err(Failure::NoClone(format!("Git couldn't read the origin of {} ({why})", clone.display()))),
        }
        tc.backend.preflight(clone).await
    }

    /// The run's session, if `claude agents` lists one. After a launch whose answer was lost the session may still be
    /// listed at the clone root, so this keeps looking until the worktree has had time to appear.
    async fn find_session(&self, run: &Run) -> std::result::Result<Option<AgentEntry>, Failure> {
        // A login that can't run now has no session to find; the launch that follows waits or fails for it.
        let Ok(tc) = self.observing_toolchain_of(run).await else { return Ok(None) };
        let since = run.launched_at.and_then(|at| (Utc::now() - at).to_std().ok()).unwrap_or(Duration::MAX);
        let deadline = Instant::now() + self.timing.worktree_grace.saturating_sub(since);
        loop {
            let entries = tc.cli.agents(true).await.map_err(|e| Failure::from_cli(e, &run.spec.clone_path, &tc.instance_name, tc.has_own_folder()))?;
            if let Some(found) = entries.into_iter().find(|e| belongs_to(e, &tc.instance_id, run)) {
                return Ok(Some(found));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            tokio::time::sleep(self.timing.poll).await;
        }
    }

    /// Runs the launch for a run that has been checked eligible. Returns with the run `Launching` or `Failed`, and no
    /// longer waiting for a slot either way.
    async fn spawn(&self, run: &mut Run) -> Result<bool> {
        let Target { tc, model } = match self.launch_target(run).await {
            Ok(target) => target,
            Err(Blocked::Waits(words)) => {
                self.wait_for_choice(run, words).await?;
                return Ok(false);
            }
            Err(Blocked::Fails(why)) => {
                self.fail(run, &why).await?;
                return Ok(true);
            }
        };
        run.slot_wait_since = None;
        run.wait_reason = None;
        if let Err(why) = self.check(run, &tc).await {
            self.fail(run, &why).await?;
            return Ok(true);
        }
        let now = Utc::now();
        run.state = RunState::Launching;
        run.launched_at = Some(now);
        run.last_progress_at = now;
        run.error = None;
        run.failure = None;
        run.ended_at = None;
        self.store(run).await?;
        self.remember(run);

        let tools = self.offer_tools(run).await;
        let spec = &run.spec;
        let mut guard = GUARD.to_string();
        if tools.is_some() {
            guard = format!("{guard} {AGENT_GUARD}");
        }
        let fresh_id = match self.fresh_short_id().await {
            Ok(id) => id,
            Err(why) => {
                self.fail(run, &why).await?;
                return Ok(true);
            }
        };
        let request = backend::LaunchRequest {
            cwd: spec.clone_path.clone(),
            name: title_of(run),
            worktree: spec.name.clone(),
            guard,
            prompt: render_prompt(spec),
            tools,
            model,
            fresh_id,
        };
        self.in_flight.lock().expect("in-flight lock poisoned").insert(run.id.clone());
        let outcome = tc.backend.launch(&request).await;
        self.in_flight.lock().expect("in-flight lock poisoned").remove(&run.id);
        match outcome {
            Ok(session) => {
                run.short_id = Some(session.short_id);
                if session.session_id.is_some() {
                    run.session_id = session.session_id;
                }
                self.remember(run);
                self.store(run).await?;
            }
            Err(why) => self.fail(run, &why).await?,
        }
        Ok(true)
    }

    /// A short id that no run, of any account or login, has or had.
    async fn fresh_short_id(&self) -> std::result::Result<ShortId, Failure> {
        loop {
            let id = ShortId::parse(&random_hex(8)).expect("eight hex digits");
            if self.index.has_short_id(&id) {
                continue;
            }
            match self.core.short_id_in_use(&id).await {
                Ok(false) => return Ok(id),
                Ok(true) => {}
                Err(e) => return Err(Failure::Invalid(format!("Gossamr couldn't check the run ids: {e}"))),
            }
        }
    }

    /// Starts a queued run, or with `retry` a failed one that never got a session. Returns whether it launched: a queued
    /// run over the cap is left queued, waiting for a slot, and a retry over the cap fails for it as before.
    async fn start(&self, run_id: &str, retry: bool) -> Result<(Run, bool)> {
        let prepared = match self.load(run_id).await {
            Ok(listed) if Self::startable(&listed, retry) => self.prepare(&listed).await,
            _ => Ok(None),
        };
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if !Self::startable(&run, retry) {
            return Ok((run, false));
        }
        let who = match prepared {
            Ok(who) => who,
            Err(why) => {
                self.fail(&mut run, &why).await?;
                return Ok((run, true));
            }
        };
        self.settle_clone_path(&mut run).await?;
        // Starting a run an earlier release queued on its own is the person's approval of it; without this, one sent to
        // wait for a slot would never pass `workstream_runs`.
        if run.unapproved_auto_start.take().is_some() {
            self.store(&run).await?;
        }
        // A free slot goes to the runs already waiting for one first, in approval order; `launch_waiting` starts them.
        if !retry && (self.live_elsewhere(&run) >= self.cap() || self.waits_behind(&run).await) {
            self.wait_for_slot(&mut run).await?;
            return Ok((run, false));
        }
        self.record_identity(&mut run, who).await?;
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
        if !retry && self.held_for_clone(&mut run).await? {
            return Ok((run, false));
        }
        let launched = self.spawn(&mut run).await?;
        Ok((run, launched))
    }

    /// A queued run, or with `retry` a failed one that never got a session.
    fn startable(run: &Run, retry: bool) -> bool {
        if retry {
            run.state == RunState::Failed && run.short_id.is_none()
        } else {
            run.state == RunState::Queued
        }
    }

    /// Whether the run's clone doesn't exist yet and is being made right now, in which case the run stays queued and
    /// the next `launch_waiting` finds it, after the clone has ended.
    async fn held_for_clone(&self, run: &mut Run) -> Result<bool> {
        if run.spec.clone_path.symlink_metadata().is_ok() || !self.clone_busy(&run.spec.repo) {
            return Ok(false);
        }
        self.wait_for_slot(run).await?;
        Ok(true)
    }

    /// Whether a run approved before `run` is waiting for a slot and may start, so it has the next one. Called under
    /// the launch lock.
    async fn waits_behind(&self, run: &Run) -> bool {
        let Ok(queued) = self.core.runs_list(&RunQuery { states: Some(vec![RunState::Queued]), ..RunQuery::default() }).await else { return false };
        for other in queued.iter().filter(|r| r.id != run.id && r.slot_wait_since.is_some() && (r.queued_at, &r.id) < (run.queued_at, &run.id)) {
            if other.spec.workstream.is_none() || self.workstream_runs(other).await {
                return true;
            }
        }
        false
    }

    /// `start` for a freshly approved or queued run; one left waiting behind earlier runs gets its turn through
    /// `launch_waiting`, which starts them in approval order once the start has let go of the launch lock.
    async fn start_in_line(&self, run_id: &str) -> Result<(Run, bool)> {
        let (run, launched) = self.start(run_id, false).await?;
        if launched || run.state != RunState::Queued || run.slot_wait_since.is_none() {
            return Ok((run, launched));
        }
        let started = self.launch_waiting().await?;
        let launched = started.contains(&run.id);
        Ok((self.load(run_id).await?, launched))
    }

    /// Marks a freshly queued run as waiting for a slot when it will have to wait for one, before the launcher gets to
    /// it, so the approval can say so. The launch checks again under the lock.
    pub async fn note_slot_wait(&self, run_id: &str) -> Result<Run> {
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if run.state == RunState::Queued && (self.live_elsewhere(&run) >= self.cap() || self.waits_behind(&run).await) {
            self.wait_for_slot(&mut run).await?;
        }
        Ok(run)
    }

    /// Keeps a queued run queued because the cap is full, marked as waiting for a slot from the first time it was.
    async fn wait_for_slot(&self, run: &mut Run) -> Result<()> {
        if run.slot_wait_since.is_none() || run.wait_reason.is_some() {
            run.slot_wait_since.get_or_insert_with(Utc::now);
            run.wait_reason = None;
            self.store(run).await?;
        }
        Ok(())
    }

    /// For a run that is queued, as after a restart. Over the cap it is left waiting for a slot and returned as it is;
    /// any state but queued is refused.
    pub async fn start_now(&self, run_id: &str) -> Result<Run> {
        match self.start_in_line(run_id).await? {
            (run, true) => Ok(run),
            (run, false) if run.state == RunState::Queued => Ok(run),
            (run, false) => Err(Error::Proposal(format!("This run is {}, so it can't be started.", run.state.as_str()))),
        }
    }

    /// Starts the runs that wait, in approval order (`queued_at`, then id), while fewer than the cap are live: queued
    /// runs in a workstream that is open and not paused, and runs in no workstream a person approved over the cap or whose choice can't run yet. The
    /// rest stay queued, never failed for the cap: one the cap keeps out is marked as waiting for a slot, and a paused
    /// workstream's is skipped.
    ///
    /// Each start takes the launch lock itself, and tokio's mutex isn't re-entrant, so this is only ever called with no
    /// lock held: from the supervisor's own task, after the tracker's poll returns, and after a stop has freed a slot.
    /// The cap is checked again under that lock, which also orders it against an answer: `answer` holds the lock from
    /// the stop through its settle to the wake, with the answered run marked terminal in the index in between, so a
    /// waiting run can't take that run's slot while it settles. Returns the ids it started.
    pub async fn launch_waiting(&self) -> Result<Vec<String>> {
        let mut queued = self.core.runs_list(&RunQuery { states: Some(vec![RunState::Queued]), ..RunQuery::default() }).await?;
        queued.retain(|r| r.spec.workstream.is_some() || r.slot_wait_since.is_some() || r.wait_reason.is_some());
        queued.sort_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id)));
        let mut started = Vec::new();
        for run in queued {
            match self.start_waiting(&run.id).await {
                Ok(true) => started.push(run.id),
                Ok(false) => {}
                Err(e) => eprintln!("couldn't start waiting run {}: {e}", run.id),
            }
        }
        Ok(started)
    }

    /// Whether the workstream `run` belongs to is open and not paused, as the run's own connection has it, and the run
    /// isn't one no one approved.
    async fn workstream_runs(&self, run: &Run) -> bool {
        let Some(ws) = run.spec.workstream.as_deref().filter(|_| run.unapproved_auto_start.is_none()) else { return false };
        let Ok(scope) = self.core.scope_of(&run.connection_id).await else { return false };
        let Ok(Some(v)) = self.core.workstream(&scope, ws).await else { return false };
        v.workstream.closed_at.is_none() && v.workstream.paused_reason.is_none()
    }

    /// `start` for a waiting run: under the launch lock it is checked again that it is still queued, that its workstream
    /// isn't paused (or, in no workstream, that it is still waiting for a slot) and that there is room under the cap;
    /// otherwise it is left as it is, marked as waiting for a slot when the cap is all that keeps it. Returns whether it
    /// launched.
    async fn start_waiting(&self, run_id: &str) -> Result<bool> {
        let prepared = match self.load(run_id).await {
            Ok(listed) if listed.state == RunState::Queued && self.may_start(&listed).await => self.prepare_if_free(&listed).await,
            _ => Ok((true, None)),
        };
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if run.state != RunState::Queued || !self.may_start(&run).await {
            return Ok(false);
        }
        let (skipped, who) = match prepared {
            Ok((done, who)) => (!done, who),
            Err(why) => {
                self.fail(&mut run, &why).await?;
                return Ok(true);
            }
        };
        self.settle_clone_path(&mut run).await?;
        if self.live_elsewhere(&run) >= self.cap() || skipped || self.held_for_clone(&mut run).await? {
            self.wait_for_slot(&mut run).await?;
            return Ok(false);
        }
        self.record_identity(&mut run, who).await?;
        self.spawn(&mut run).await
    }

    /// `prepare` for a run that waits, unless it can't start anyway for want of a slot, or its repository's clone is
    /// being made or fetched into by someone else: that run stays queued, and the next pass finds the clone ready.
    /// This keeps a slow clone from holding up the runs on other repositories.
    async fn prepare_if_free(&self, run: &Run) -> std::result::Result<(bool, Option<CommitIdentity>), Failure> {
        if self.live_elsewhere(run) >= self.cap() || self.clone_busy(&run.spec.repo) {
            return Ok((false, None));
        }
        self.prepare(run).await.map(|who| (true, who))
    }

    /// Whether a queued run is one `launch_waiting` may start: in an open workstream, or waiting for a slot or for its choice.
    async fn may_start(&self, run: &Run) -> bool {
        match run.spec.workstream {
            Some(_) => self.workstream_runs(run).await,
            None => run.slot_wait_since.is_some() || run.wait_reason.is_some(),
        }
    }

    /// Looks for the session of a failed launch and adopts it; only when there is none does it launch again.
    pub async fn retry_launch(&self, run_id: &str) -> Result<Run> {
        match self.start(run_id, true).await? {
            (run, launched) if launched || (run.state == RunState::Queued && run.wait_reason.is_some()) => {
                self.note_person(&run, "run_retried", None).await;
                Ok(run)
            }
            (run, _) => Err(Error::Proposal(format!("This run is {} and has nothing to retry.", run.state.as_str()))),
        }
    }

    /// Records what the person did to a run (`run_stopped`, `run_answered`, `run_retried`) in its workstream's audit.
    /// The action itself already happened, so a failure to record it is logged rather than reported as the action
    /// failing.
    pub(super) async fn note_person(&self, run: &Run, action: &str, detail: Option<String>) {
        self.note_by(run, Actor::Person, action, detail).await;
    }

    /// `note_person` for something `by` did, which is Pip when it drove the run.
    pub(super) async fn note_by(&self, run: &Run, by: Actor, action: &str, detail: Option<String>) {
        if let Err(e) = self.core.record_run_action_by(run, by, action, detail.clone()).await {
            eprintln!("couldn't record {action} for run {} in its workstream: {e}", run.id);
        }
        if by == Actor::Pip && run.spec.workstream.is_none() && matches!(action, "run_stopped" | "agent_message_queued") {
            let event = RunEvent { run_id: run.id.clone(), seq: 0, at: Utc::now(), kind: action.into(), text: format!("Pip: {}", action.replace('_', " ")), detail };
            if let Err(e) = self.core.append_run_events(&run.id, &[event]).await {
                eprintln!("couldn't record {action} on run {}: {e}", run.id);
            }
        }
    }

    /// After a restart: runs that were launching are matched to their sessions for up to the recovery window, adopted
    /// if found and failed if not. Queued runs stay queued; one in no workstream that was waiting for a slot before the
    /// restart stops waiting, so it is the person's to start again (a workstream's keeps waiting, and so does a run waiting for its choice). The
    /// same pass runs again on sign-in; a wait from this session is kept then, so an
    /// queued run still starts when a slot frees. Live runs missing from the index are put back.
    pub async fn recover(&self) {
        let _only_pass = self.recovery.lock().await;
        self.forget_slot_waits().await;
        let live = vec![RunState::Launching, RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked, RunState::Unknown];
        let Ok(runs) = self.core.runs_list(&RunQuery { states: Some(live), ..RunQuery::default() }).await else { return };
        runs.iter().filter(|r| !self.index.contains(&r.id)).for_each(|r| self.remember(r));
        let in_flight = self.in_flight.lock().expect("in-flight lock poisoned").clone();
        let mut waiting: Vec<Run> = runs.into_iter().filter(|r| r.state == RunState::Launching && !in_flight.contains(&r.id)).collect();
        let deadline = Instant::now() + self.timing.recover_window;
        while !waiting.is_empty() {
            let mut unmatched = Vec::new();
            let mut by_instance: std::collections::BTreeMap<String, Vec<Run>> = Default::default();
            for run in waiting {
                by_instance.entry(run.instance_id().to_owned()).or_default().push(run);
            }
            for (_, group) in by_instance {
                let tc = match self.observing_toolchain_of(&group[0]).await {
                    Ok(tc) => tc,
                    Err(e) => {
                        let why: Failure = e.into();
                        for mut run in group {
                            let _ = self.fail(&mut run, &why).await;
                        }
                        continue;
                    }
                };
                let Ok(entries) = tc.cli.agents(true).await else {
                    unmatched.extend(group);
                    continue;
                };
                for mut run in group {
                    match entries.iter().find(|e| belongs_to(e, &tc.instance_id, &run)) {
                        Some(found) => {
                            let _ = self.adopt(&mut run, found).await;
                        }
                        None => unmatched.push(run),
                    }
                }
            }
            waiting = unmatched;
            if waiting.is_empty() || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(self.timing.poll).await;
        }
        for mut run in waiting {
            let _ = self.fail(&mut run, &Failure::Interrupted).await;
        }
        self.sweep_agent_files().await;
    }

    /// Queued runs in no workstream that were waiting for a slot when the app stopped wait no longer. A wait that began
    /// after this service started is this session's, and is kept.
    async fn forget_slot_waits(&self) {
        let before_restart = |r: &Run| r.spec.workstream.is_none() && r.slot_wait_since.is_some_and(|t| t < self.started_at);
        let Ok(queued) = self.core.runs_list(&RunQuery { states: Some(vec![RunState::Queued]), ..RunQuery::default() }).await else { return };
        for listed in queued.iter().filter(|r| before_restart(r)) {
            let _turn = self.launching.lock().await;
            let Ok(mut run) = self.load(&listed.id).await else { continue };
            if run.state != RunState::Queued || !before_restart(&run) {
                continue;
            }
            run.slot_wait_since = None;
            if let Err(e) = self.store(&run).await {
                eprintln!("couldn't clear the slot wait of run {}: {e}", run.id);
            }
        }
    }

    pub(super) async fn git(&self) -> Result<Git> {
        Ok(Git::new(self.tools.get().await.map_err(|e| claude_error(e.into()))?.env))
    }
}

#[async_trait]
impl RunLauncher for RunService {
    /// Starts a freshly queued run. A run that isn't queued is left alone, so calling this twice never starts two; one in a
    /// workstream that has been paused or closed stays queued until `launch_waiting` finds it open.
    async fn launch(&self, run_id: &str) -> Result<()> {
        let held = self.load(run_id).await.ok().filter(|r| r.state == RunState::Queued && r.spec.workstream.is_some());
        if let Some(run) = held {
            if !self.workstream_runs(&run).await {
                return Ok(());
            }
        }
        self.start_in_line(run_id).await.map(drop)
    }
}

mod choice;
mod fresh;
mod trust;

#[cfg(test)]
mod tests;
