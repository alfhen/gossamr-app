//! A Claude run opens a harness session in place of `claude --bg`: the session works in a new worktree of the clone,
//! the first prompt is the brief, and the run is what the session's events say from then on (`consumer`).

use std::sync::Arc;

use async_trait::async_trait;
use harness::api::Op;
use harness::client::Client;
use harness::event::{Decision, PermissionKind};

use super::failure::Failure;
use super::link::{Connect, Link};
use super::message::Delivery;
use super::service::RunService;
use crate::domain::{render_prompt_from, Run, RunEvent, RunState, Start};
use crate::error::{Error, Result};

/// The link to the harness, and the provider runs open on: `claude`, or the mock a debug build was started with.
pub struct OnHarness {
    pub link: Arc<Link>,
    pub provider: String,
}

/// Connects through the app's harness manager, which keeps the client token.
pub struct ViaSidecar(pub Arc<Option<crate::sidecar::Sidecar>>);

#[async_trait]
impl Connect for ViaSidecar {
    async fn connect(&self) -> std::result::Result<Client, String> {
        match self.0.as_ref() {
            Some(sidecar) => sidecar.client().await,
            None => Err("Gossamr has no folder for the harness.".into()),
        }
    }
}

/// The provider of a debug build's mock switch.
pub const MOCK: &str = "mock";

/// How long after a run launched the harness can create its session: an open waits for the shell and makes a clone.
const OPEN_TAKES_UP_TO_MS: i64 = 10 * 60 * 1000;

pub const HANDED_OVER_PERMISSION: &str = "It was handed over to Terminal, so answer it there.";
pub const ONLY_DENY_CUT: &str = "This request was too large to show whole, so it can only be denied.";
/// For a kind this build can't read, and a request Gossamr no longer has whole.
pub const ONLY_DENY_KIND: &str = "Gossamr can't show all of this request, so it can only be denied.";
pub const ONLY_DENY_MASKED: &str = "Part of this is hidden; run it yourself in Terminal if you trust it.";
pub const ONLY_DENY_INEXACT: &str = "Gossamr can't show this request exactly, so it can only be denied.";
pub const ONLY_DENY_MARKS: &str = "Part of this is a stack of marks Gossamr shows only as a count, so it can only be denied.";

/// How long clean-up waits for a session it closed to say so.
const CLOSE_TAKES_UP_TO: std::time::Duration = std::time::Duration::from_secs(30);

const INTERRUPTED_ROW: &str = "Stopped when Gossamr moved agents to the harness. Ask Pip to start it again.";
const INTERRUPTED_ASKING: &str = "Stopped when Gossamr moved agents to the harness, before you answered its question. Ask Pip to start it again.";

/// Why Clean up leaves a run whose session did something after git was asked, as a turn a message started.
const WORKING_AGAIN: &str = "It started working again, so it is not cleaned up. Clean it up once it is done.";

/// Why Clean up leaves a session running: it could not first ask what git would keep.
const UNCHECKED: &str = "Gossamr couldn't check this run's work before stopping its agent, so it left it running";

/// Why Attach refuses a run that waits on you in the middle of its turn.
pub const HAND_OVER_WAITING: &str = "It is waiting on you; answer or stop it first.";

/// Why Take over refuses a run with no request Gossamr can only deny: the others are answered here.
pub const TAKE_OVER_ONLY_DENY: &str = "Take over is for a request Gossamr can only deny. Answer this one here.";

/// Why Take over opened no Terminal: the harness's agent had not gone yet, or may still run.
pub const HANDED_OVER_NOT_GONE: &str = "It is handed over, but its agent hasn't stopped yet, so Terminal didn't open. Open in Terminal again once it has.";
pub const HANDED_OVER_MAY_RUN: &str = "It is handed over, but its agent may still run, so Terminal didn't open:";

/// How long Terminal may take to start the `claude` the app opened it on.
pub(super) const TERMINAL_STARTS_WITHIN: std::time::Duration = std::time::Duration::from_secs(10);

/// Why Resume here waits just after the app opened Terminal on the run.
pub const TERMINAL_OPENING: &str = "Terminal is still opening it. Quit it there once it opens, then Resume here.";

/// Why the resume command waits: the harness's agent has not gone yet, or may still run.
pub const AGENT_STOPPING: &str = "Its agent is still stopping.";

/// Why Resume here and the resume command refuse a run.
pub const NOT_HANDED_OVER: &str = "It isn't handed over to Terminal.";

/// Why Attach refuses a run in a turn.
pub const HAND_OVER_IN_TURN: &str = "Its agent is in the middle of a turn, and opening it in Terminal would cut that turn short. Wait for the turn to end, or stop it first.";

/// A clean-up refusal, with how to remove the clone's settings when they are why: the clone note says the same.
fn with_way_out(refusal: &str, run: &Run) -> String {
    super::service::fresh::with_clone_way_out(refusal, &run.spec.clone_path)
}

/// The harness's refusal as a sentence for the person: its words without the kind it starts with, and `session`, an id
/// that means nothing to the person, said as "it".
fn plain_refusal(why: &str, session: &str) -> String {
    let said = why.strip_prefix("refused: ").unwrap_or(why);
    let said = said.replace(&format!("session {session}'s "), "its ").replace(&format!("session {session} "), "it ");
    let mut chars = said.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A session a cut nobody chose closed, which a message may resume: not one the person stopped, handed over or cleaned
/// up, and not one whose question waits for its answer.
fn resumable(follow: &crate::domain::SessionFollow) -> bool {
    follow.closed && !follow.ended && follow.cut.is_some() && follow.question.is_none()
}

/// A finished run whose session a restart closed, which a message wakes, as on the old path: not one you stopped,
/// handed over or cleaned up, and not one whose question waits for its answer.
fn wakes(run: &Run, follow: &crate::domain::SessionFollow) -> bool {
    run.state == RunState::Done && follow.closed && !follow.ended && !run.handed_over && run.worktree_removed_at.is_none() && follow.question.is_none()
}

/// What an agent of the old path reads when the move to the harness stopped it.
pub const INTERRUPTED: &str = "Gossamr stopped this agent when it moved agents to the harness, and it can't pick up where it stopped. Its worktree is kept; Clean up removes it. Ask Pip to start it again.";
pub const INTERRUPTED_BEFORE_ANSWER: &str = "Gossamr stopped this agent when it moved agents to the harness, before you answered its question, and it can't pick up where it stopped. Its worktree is kept; Clean up removes it. Ask Pip to start it again.";

pub use super::consumer::CARRY_ONS;

/// How long the carry on after a restart waits for the app to catch up with the harness's sessions.
pub(super) const CATCH_UP_TAKES_UP_TO: std::time::Duration = std::time::Duration::from_secs(30);

/// Why a message did not reach an agent that its resume started again.
pub const RESUMED_NOT_SENT: &str = "It started again, but your message didn't reach it, so send it again:";

/// The way on from a carry on the harness's rules refused: a message, which the rules do not govern.
pub const CARRY_ON_BY_MESSAGE: &str = "Message the agent to go on.";

/// The prompt that takes up a turn a restart cut.
pub const CARRY_ON: &str = "The harness restarted while you were working, so your last turn was cut short. Carry on where you left off.";

const NO_BRIEF: &str = "Gossamr stopped before it sent the agent its brief, so the session was closed. Ask Pip to start it again.";

/// What Claude runs open on: the harness's `claude` driver, or the mock a debug build was started with.
pub fn provider(mock: bool) -> &'static str {
    if mock {
        MOCK
    } else {
        "claude"
    }
}

/// The run sheet says it, so a mock run is never taken for a real one.
pub const ON_THE_MOCK: &str = "This run is on a mock script, not on Claude. Nothing it says is real.";

/// The mock works in the clone as it is; every other provider in a new worktree on the run's branch, on the login
/// folder of the run's instance as the person typed it (`None`: their usual setup). Effort is the provider's own, since
/// no agent chooses one yet.
pub fn open_op(run: &Run, provider: &str, model: Option<String>, login: Option<String>) -> Op {
    let spec = &run.spec;
    let mock = provider == MOCK;
    Op::Open {
        provider: provider.to_owned(),
        cwd: mock.then(|| spec.clone_path.clone()),
        repo: (!mock).then(|| spec.repo.clone()),
        base: (!mock).then(|| spec.base.clone()),
        branch: (!mock).then(|| spec.name.clone()),
        locked: false,
        model,
        login: login.filter(|_| !mock),
        effort: None,
        ends_with_client: false,
        tools: crate::agent::agent_tools::client_tools(),
        result_schema: Some(super::report::result_schema()),
    }
}

/// Why the harness opened no session, in the app's words where the cause is known.
fn no_session(why: &str, provider: &str) -> String {
    if !why.contains(&format!("no provider {provider}")) {
        return why.to_owned();
    }
    if provider == MOCK {
        // No switch is named: this text is in a release build too, and the release build holds none of their names.
        "the harness serves no mock script, since it was started without one. Stop it in Settings > Harness, or give it a data folder of its own, and start Gossamr again.".into()
    } else {
        format!("the harness has no {provider} driver: it found no {provider} CLI when it started. Install it, then restart the harness in Settings > Harness.")
    }
}

/// The folder a run's session works in: the clone for the mock, else the worktree the harness makes beside the clone,
/// `<clone>+worktrees/<branch>`, as `harness::work` names it.
fn session_folder(run: &Run) -> std::path::PathBuf {
    // The worktree the harness reported, kept with the branch it made; a session with no branch works in the clone.
    match run.branch {
        Some(_) => run.expected_worktree.clone(),
        None => run.spec.clone_path.clone(),
    }
}

/// The first prompt: the brief the person approved. The harness adds its own guard as system text.
pub fn first_prompt(run: &Run) -> String {
    render_prompt_from(&run.spec, Start::HarnessWorktree)
}

impl RunService {
    pub fn with_harness(mut self, on: OnHarness) -> Self {
        self.harness = Some(on);
        self
    }

    /// Opens `run`'s session and sends it the brief. The run is read again after, since the link stores what the
    /// session's first events said as they come.
    pub(super) async fn open_on_harness(&self, run: &mut Run, model: Option<String>) -> Result<std::result::Result<(), Failure>> {
        let Some(on) = &self.harness else { return Ok(Err(Failure::Harness("Gossamr has no harness to run agents on.".into()))) };
        if on.provider == MOCK {
            let row = RunEvent { run_id: run.id.clone(), seq: 0, at: chrono::Utc::now(), kind: "update".into(), text: ON_THE_MOCK.into(), detail: None };
            self.core.append_run_events(&run.id, &[row]).await?;
        }
        let config = crate::config::AppConfig::load(&self.core.data_dir());
        let login = config.providers.iter().find(|p| p.id == run.instance_id()).and_then(|p| p.config.config_dir.clone());
        let opened = on.link.open(&run.id, open_op(run, &on.provider, model, login)).await;
        // The link may have bound the session, and applied its first events, before a later step failed.
        *run = self.load(&run.id).await?;
        let session = match opened {
            Ok(session) => session,
            Err(why) => return Ok(Err(Failure::Harness(no_session(&why, &on.provider)))),
        };
        if let Err(why) = on.link.call(Op::Send { session: session.clone(), text: first_prompt(run) }).await {
            let _ = on.link.stop(&session).await;
            *run = self.load(&run.id).await?;
            return Ok(Err(Failure::Harness(format!("it didn't take the brief: {why}"))));
        }
        // Kept so the start-up pass never takes a run whose brief waits for a slot for one that never got it.
        let kept = self.core.apply_session(&session, |_, follow| {
            follow.briefed = true;
            Vec::new()
        });
        if let Err(e) = kept.await {
            let _ = on.link.stop(&session).await;
            *run = self.load(&run.id).await?;
            return Ok(Err(Failure::Harness(format!("it took the brief, but Gossamr couldn't keep that it did: {e}"))));
        }
        // The branch and worktree are the harness's: the run's pull request and its clean-up are found by them.
        match on.link.listed(&session).await {
            Some(row) => {
                let (branch, worktree) = (row["branch"].as_str().map(str::to_owned), row["cwd"].as_str().map(std::path::PathBuf::from));
                if let (Some(branch), Some(worktree)) = (branch, worktree) {
                    let kept = self.core.apply_session(&session, move |run, _| {
                        run.branch = Some(branch);
                        run.expected_worktree = worktree;
                        Vec::new()
                    });
                    if let Err(e) = kept.await {
                        let _ = on.link.stop(&session).await;
                        *run = self.load(&run.id).await?;
                        return Ok(Err(Failure::Harness(format!("it opened a session, but Gossamr couldn't keep its branch: {e}"))));
                    }
                }
            }
            None => eprintln!("the harness didn't list session {session}, so run {} has no branch yet", run.id),
        }
        *run = self.load(&run.id).await?;
        Ok(Ok(()))
    }

    /// After the harness restarted: resumes each run whose turn an end nobody asked for cut, with "carry on", unless its
    /// session waits on the person (a question), the app stopped it, or it was carried on `CARRY_ONS` times in a row
    /// with no turn ending by itself between. What the harness refuses, and why, goes on the run's timeline.
    pub async fn carry_on_after_restart(&self) {
        let Some(on) = &self.harness else { return };
        // The old harness's end of each turn it cut reaches the app only once the link has reconnected and caught up.
        if !on.link.caught_up(self.catch_up).await {
            eprintln!("the app had not caught up with the harness's sessions within {:?} of the harness answering, so only the runs it had read as cut are carried on", self.catch_up);
        }
        let stopped = crate::domain::RunQuery { states: Some(vec![RunState::Stopped]), ..Default::default() };
        let Ok(runs) = self.core.runs_list(&stopped).await else { return };
        for run in runs {
            let Some(session) = run.harness_session.clone() else { continue };
            // As a message holds it for its resume, and read again under it: a message, or another pass, that resumed
            // the session meanwhile has taken its cut, so only one of them sends.
            let _turn = self.launching.lock().await;
            let Ok(Some((_, follow))) = self.core.session_run(&session).await else { continue };
            // Terminal has it: only Resume here takes it back.
            let handed_over = self.load(&run.id).await.map_or(true, |run| run.handed_over);
            if handed_over || follow.cut.is_none() || !follow.closed || follow.ended || follow.question.is_some() || follow.carry_ons >= CARRY_ONS {
                continue;
            }
            let said = match on.link.carry_on(&session, CARRY_ON).await {
                Ok(()) => "Carried on after the harness restarted".to_owned(),
                // Only the harness's rule for a carry on keeps it, and a message is no carry on: say so. A session the
                // harness keeps takes no message either, so its reason stands alone.
                Err(why) if why.contains("may not carry on") => format!("Not carried on after the harness restarted: {}. {CARRY_ON_BY_MESSAGE}", plain_refusal(&why, &session).trim_end_matches('.')),
                Err(why) => format!("Not carried on after the harness restarted: {}", plain_refusal(&why, &session)),
            };
            let row = RunEvent { run_id: run.id.clone(), seq: 0, at: chrono::Utc::now(), kind: "follow_up".into(), text: said, detail: None };
            if let Err(e) = self.core.append_run_events(&run.id, &[row]).await {
                eprintln!("couldn't record the carry on of run {}: {e}", run.id);
            }
        }
    }

    /// From the app's start: carries on once the harness answers, then again after each harness `starts` counts, from
    /// Settings too. A start is counted before its harness can answer, so the pass that waited for the answer covers
    /// it, and no start is carried on twice.
    pub async fn carry_on_at_each_start(&self, mut starts: tokio::sync::watch::Receiver<u64>) {
        let Some(on) = &self.harness else { return };
        loop {
            on.link.answers().await;
            starts.mark_unchanged();
            self.carry_on_after_restart().await;
            if starts.changed().await.is_err() {
                return;
            }
        }
    }

    /// Once, when Claude's runs first go to the harness: stops each agent the old `claude --bg` path still has going,
    /// found as the old tracker found it, from the session the app's own database names for its run, and marks the run
    /// interrupted. Its worktree stays; Clean up removes it with git. A run that is over, or queued, is left alone: a
    /// queued one starts on the harness. A stop that fails leaves the move to be tried again at the next start.
    pub async fn move_to_harness(&self) {
        if self.harness.is_none() || !matches!(self.core.harness_moved().await, Ok(false)) {
            return;
        }
        let going = vec![RunState::Launching, RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked, RunState::Unknown];
        // Listed and read under the lock, so a run that ended while a launch held it is not marked interrupted.
        let _turn = self.launching.lock().await;
        let Ok(runs) = self.core.runs_list(&crate::domain::RunQuery { states: Some(going.clone()), ..Default::default() }).await else { return };
        // Every run passed over is left for the next start, so the move is marked done only once none is.
        let mut all_stopped = true;
        let left = |run: &Run, why: &str| eprintln!("the move to the harness left run {} for the next start: {why}", run.id);
        for run in runs.iter().filter(|run| run.harness_session.is_none()) {
            let Some(session) = super::backend::Session::of(run) else {
                left(run, "it has no session on the old path yet");
                all_stopped = false;
                continue;
            };
            // A login that can't be read, as when its instance was removed, can't stop the agent either: the run is
            // marked interrupted all the same, so the move can finish, and its clean-up goes by git alone.
            let tc = match self.observing_toolchain(run).await {
                Ok(tc) => Some(tc),
                Err(e) => {
                    eprintln!("the move to the harness marks run {} interrupted without stopping its agent: its login can't be read: {e}", run.id);
                    None
                }
            };
            if let Some(tc) = &tc {
                if tc.driver != crate::connections::Driver::Claude {
                    continue;
                }
                match tc.backend.stop(&session).await {
                    Ok(()) => {}
                    // `claude stop` of a job it no longer has: the agent is gone already.
                    Err(e) if e.to_string().contains("No job matching") => {}
                    Err(e) => {
                        left(run, &format!("its agent couldn't be stopped: {e}"));
                        all_stopped = false;
                        continue;
                    }
                }
            }
            let mut run = match self.load(&run.id).await {
                Ok(run) => run,
                Err(e) => {
                    left(&run.clone(), &format!("it couldn't be read again: {e}"));
                    all_stopped = false;
                    continue;
                }
            };
            if !going.contains(&run.state) {
                continue;
            }
            // A question it waited on goes with it, as at a Stop: nothing can answer it now.
            let asked = run.needs.is_some() && run.state == RunState::NeedsAnswer;
            match &tc {
                Some(tc) => self.end_ask_on(tc.backend.as_ref(), &run),
                None => self.core.asks().cancel(&run.id),
            }
            run.needs = None;
            run.asking = false;
            let said = if asked { INTERRUPTED_ASKING } else { INTERRUPTED_ROW };
            let row = RunEvent { run_id: run.id.clone(), seq: 0, at: chrono::Utc::now(), kind: "stop".into(), text: said.into(), detail: None };
            if let Err(e) = self.core.append_run_events(&run.id, &[row]).await {
                eprintln!("couldn't record that run {} was interrupted: {e}", run.id);
            }
            run.state = RunState::Failed;
            run.error = Some(if asked { INTERRUPTED_BEFORE_ANSWER } else { INTERRUPTED }.into());
            run.failure = Some(crate::domain::RunFailure::Interrupted);
            run.ended_at = Some(chrono::Utc::now());
            if let Err(e) = self.store(&run).await {
                eprintln!("couldn't mark run {} interrupted: {e}", run.id);
                all_stopped = false;
            }
            if let Err(e) = self.index.mark_terminal(&run.id) {
                eprintln!("couldn't update the run index: {e}");
            }
            // It waited on you: Pip hears that it can't be answered now.
            if asked {
                self.notifier.notify(&run, super::tracker::Attention::Failed);
            }
        }
        if all_stopped {
            if let Err(e) = self.core.mark_harness_moved().await {
                eprintln!("couldn't note that the old path's agents were stopped; it runs again at the next start: {e}");
            }
        }
    }

    /// At start, under the launch lock, so no open runs meanwhile. It closes a session the harness runs for an open
    /// the app quit in the middle of: on the repo and branch of a run still Launching with no session, created just
    /// after that run launched, and bound to no run. And it closes the session of a run whose brief the harness never
    /// took, failing the run if it still launches. Either would be an agent no run can stop or clean up.
    pub async fn sweep_harness(&self) {
        let Some(on) = &self.harness else { return };
        let _turn = self.launching.lock().await;
        let Ok(runs) = self.core.runs_list(&crate::domain::RunQuery::default()).await else { return };
        let Ok(listed) = on.link.call(Op::Sessions).await else { return };
        for row in listed.as_array().into_iter().flatten().filter(|row| row["running"] == true) {
            let (Some(id), Some(repo), Some(branch), Some(created)) = (row["id"].as_str(), row["repo"].as_str(), row["branch"].as_str(), row["created_ms"].as_i64()) else { continue };
            let opened_for = |run: &&Run| {
                run.state == RunState::Launching
                    && run.harness_session.is_none()
                    && run.spec.repo == repo
                    && run.spec.name == branch
                    && run.launched_at.is_some_and(|at| (0..=OPEN_TAKES_UP_TO_MS).contains(&(created - at.timestamp_millis())))
            };
            if runs.iter().any(|run| opened_for(&run)) && matches!(self.core.session_run(id).await, Ok(None)) {
                let _ = on.link.call(Op::Close { session: id.to_owned() }).await;
            }
        }
        for run in runs.iter().filter(|run| matches!(run.state, RunState::Launching | RunState::Failed)) {
            let Some(session) = &run.harness_session else { continue };
            let Ok(Some((_, follow))) = self.core.session_run(session).await else { continue };
            if follow.briefed || follow.closed {
                continue;
            }
            let _ = on.link.stop(session).await;
            if run.state == RunState::Launching {
                if let Ok(mut run) = self.load(&run.id).await {
                    // A failed write is tried again at the next start, which finds the run as it was.
                    if let Err(e) = self.fail(&mut run, &Failure::Harness(NO_BRIEF.into())).await {
                        eprintln!("couldn't fail run {} that never got its brief: {e}", run.id);
                    }
                }
            }
        }
    }

    /// The link of a run that is a harness session, and its session.
    fn on_harness_of<'a>(&'a self, run: &'a Run) -> Option<(&'a Link, &'a str)> {
        Some((&self.harness.as_ref()?.link, run.harness_session.as_deref()?))
    }

    /// Sends the person's or Pip's text to a run on the harness: the answer to its open question, else a message.
    /// `None` for a run that is not on the harness.
    pub(super) async fn send_on_harness(&self, run: &Run, text: &str) -> Option<Result<(Run, Delivery)>> {
        let (link, session) = self.on_harness_of(run)?;
        let follow = self.core.session_run(session).await.ok().flatten().map(|(_, follow)| follow).unwrap_or_default();
        // A session just taken back or resumed is starting again: its run reads stopped until its `started` comes.
        let starting = follow.taken_back || follow.resuming;
        // A turn failed and its session still runs (a refused signature, a provider error): the message is its next
        // prompt, and the turn it starts takes the run out of Failed.
        let runs_on = run.state == RunState::Failed && follow.briefed && !follow.closed;
        // Only a run Resume here took back: a Stopped run whose turn a cancel or a deny ended takes no message, as before.
        let runs_on = runs_on || run.state == RunState::Stopped && follow.resumed_here && !follow.closed;
        if !starting && !runs_on && (matches!(run.state, RunState::Stopped | RunState::Failed) && resumable(&follow) || wakes(run, &follow)) {
            return Some(self.resume_on_harness(link, session, run, text).await);
        }
        if !starting && !runs_on && matches!(run.state, RunState::Queued | RunState::Launching | RunState::Failed | RunState::Stopped) {
            return Some(Err(Error::Proposal(format!("This run is {}, so it takes no message.", run.state.as_str()))));
        }
        Some(match link.send(session, text).await {
            Ok(answered) => self.load(&run.id).await.map(|run| (run, if answered { Delivery::Answered } else { Delivery::Queued })),
            Err(why) if why == super::link::ANSWER_ON_ITS_WAY || why == super::link::NOT_RUNNING => Err(Error::Proposal(why)),
            // The message found the agent lost: it starts it again, as the run now says to.
            Err(why) if why == super::consumer::AGENT_LOST => self.resume_on_harness(link, session, run, text).await,
            Err(why) => Err(Error::Proposal(format!("The harness didn't take it: {why}"))),
        })
    }

    async fn resume_on_harness(&self, link: &Link, session: &str, run: &Run, text: &str) -> Result<(Run, Delivery)> {
        match link.resume_with(session, text).await {
            Ok(()) => self.load(&run.id).await.map(|run| (run, Delivery::Resumed)),
            Err(super::link::NotResumed::Refused(why)) => Err(Error::Proposal(format!("The harness didn't resume it: {}", plain_refusal(&why, session)))),
            Err(super::link::NotResumed::NotSent(why)) => Err(Error::Proposal(format!("{RESUMED_NOT_SENT} {}", plain_refusal(&why, session)))),
        }
    }

    /// Allows or denies one open permission request of `run_id`, once, for that request alone. Only the person's page
    /// calls this: an allow is theirs to give, never Pip's or an agent's.
    pub async fn answer_permission(&self, run_id: &str, request: &str, decision: Decision) -> Result<Run> {
        let refuse = |why: &str| Err(Error::Proposal(why.to_owned()));
        if decision == Decision::Other {
            return refuse("An answer is allow or deny.");
        }
        // Judged on what the page shows: the harness's own copy where the app holds it, else the app-masked one.
        let run = self.core.shown(self.load(run_id).await?);
        let Some((link, session)) = self.on_harness_of(&run) else { return refuse("This run isn't on the harness: answer it in Terminal.") };
        if run.handed_over {
            return refuse(HANDED_OVER_PERMISSION);
        }
        if matches!(run.state, RunState::Queued | RunState::Launching | RunState::Done | RunState::Failed | RunState::Stopped) {
            return refuse(&format!("This run is {}, so it has no request to answer.", run.state.as_str()));
        }
        let Some(open) = run.permissions.iter().find(|open| open.id == request) else { return refuse(super::link::NOT_OPEN) };
        // The command is the gate: the flag is what the page reads, and a masked request or one with no whole input
        // is refused whatever it says.
        let exact = super::consumer::shows_exactly(&open.input);
        let stacked = super::consumer::stacks_marks(&open.input);
        let unread = open.kind == PermissionKind::Other;
        if (open.deny_only || open.masked || !open.input.is_object() || !exact || stacked || unread) && decision == Decision::Allow {
            // The input of a request the harness cut is text.
            let why = if open.masked {
                ONLY_DENY_MASKED
            } else if open.input.is_string() {
                ONLY_DENY_CUT
            } else if !exact {
                ONLY_DENY_INEXACT
            } else if stacked {
                ONLY_DENY_MARKS
            } else {
                ONLY_DENY_KIND
            };
            return refuse(why);
        }
        match link.permit(session, request, decision).await {
            Ok(()) => self.load(run_id).await.map(|run| self.core.shown(run)),
            Err(why) if why == super::link::NOT_OPEN || why == super::link::NOT_RUNNING_TO_ANSWER => refuse(&why),
            Err(why) => refuse(&format!("The harness didn't take your answer: {why}")),
        }
    }

    /// Cleans up a run's session through the harness: its worktree and branch, never forced, so unpushed work stays and
    /// the harness says why. A session at rest is closed first, since a session that runs is not cleaned up. `None` for
    /// a run not on the harness; `Some(Ok(Some(why)))` for a refusal.
    pub(super) async fn cleanup_on_harness(&self, run: &Run) -> Option<Result<Option<String>>> {
        let (link, session) = self.on_harness_of(run)?;
        let closed = |follow: &crate::domain::SessionFollow| follow.closed;
        let follow = self.core.session_run(session).await.ok().flatten().map(|(_, follow)| follow);
        let open = follow.as_ref().is_some_and(|follow| !closed(follow));
        // Asked before the close: a refusal after it would have stopped the agent for nothing. A run whose branch the app
        // doesn't know yet asks the harness's listing for it; one whose session names no repo has no worktree to keep.
        // Not under the launch lock, since git may fetch for up to 30 s and every launch, message and answer waits on it.
        if open {
            let work = match run.branch.clone() {
                Some(branch) => Some((branch, run.expected_worktree.clone())),
                None => match link.listed(session).await {
                    Some(row) => row["branch"].as_str().map(|branch| (branch.to_owned(), std::path::PathBuf::from(row["cwd"].as_str().unwrap_or_default()))),
                    None => return Some(Ok(Some(format!("{UNCHECKED}: the harness didn't say which branch it is on. Try again in a moment.")))),
                },
            };
            if let Some((branch, worktree)) = work {
                match self.kept_on_harness(run, &branch, &worktree).await {
                    Ok(None) => {}
                    Ok(Some(kept)) => return Some(Ok(Some(with_way_out(&plain_refusal(&kept, session), run)))),
                    Err(why) => return Some(Ok(Some(format!("{UNCHECKED}: {}. Try again in a moment.", why.trim_end_matches('.'))))),
                }
            }
        }
        if open {
            // As a message holds it for its send: no turn a message starts can be cut by the stop below.
            let _turn = self.launching.lock().await;
            let now = self.core.session_run(session).await.ok().flatten().map(|(_, follow)| follow);
            if let Some(now) = now.filter(|now| !closed(now)) {
                // Anything the session did since git was asked, as a turn a message started while Clean up waited for
                // the lock, shows in the follow, or only in the harness's events the app has not read yet.
                let seen = follow.as_ref().map_or(0, |follow| follow.seq);
                let unread = link.listed(session).await.is_some_and(|row| row["last_seq"].as_u64().unwrap_or(0) > now.seq);
                if now.in_turn || now.seq > seen || unread {
                    return Some(Ok(Some(WORKING_AGAIN.into())));
                }
                let mut applied = link.applied();
                if let Err(why) = link.stop(session).await {
                    return Some(Ok(Some(format!("The harness didn't close the session first: {why}"))));
                }
                let waited = tokio::time::timeout(CLOSE_TAKES_UP_TO, async {
                    while !matches!(self.core.session_run(session).await, Ok(Some((_, follow))) if closed(&follow)) {
                        if applied.changed().await.is_err() {
                            return;
                        }
                    }
                });
                if waited.await.is_err() {
                    return Some(Ok(Some("The session hasn't closed yet, so it can't be cleaned up. Try again in a moment.".into())));
                }
            }
        }
        Some(Ok(link.call(Op::CleanUp { session: session.to_owned() }).await.err().map(|why| with_way_out(&plain_refusal(&why, session), run))))
    }

    /// Why git would keep a harness run's worktree and branch, asked with the app's own git as the harness would remove
    /// them: None when it would remove them, an error when git can't be asked, so the session is left running.
    async fn kept_on_harness(&self, run: &Run, branch: &str, worktree: &std::path::Path) -> std::result::Result<Option<String>, String> {
        let git = self.git().await.map_err(|e| e.to_string())?;
        let home = self.home.as_deref();
        let _lock = match home {
            Some(home) => Some(super::fresh::lock_repo(home, &run.spec.repo).await.map_err(|e| e.to_string())?),
            None => None,
        };
        let at = super::repo::Worktree { repo: &run.spec.repo, clone: &run.spec.clone_path, path: worktree, branch, base: &run.spec.base };
        super::repo::kept_by_git(&git, home, at).await
    }

    /// Takes a session handed over to Terminal back, on the person's word that they took it back there, so it can be
    /// resumed. The run no longer reads handed over, and the app follows the session again. `None` for a run not on the
    /// harness.
    pub(super) async fn take_back_on_harness(&self, run: &Run) -> Option<Result<Run>> {
        let (link, session) = self.on_harness_of(run)?;
        let opened = self.opened_terminal.lock().unwrap_or_else(|e| e.into_inner()).get(&run.id).copied();
        if opened.is_some_and(|at| at.elapsed() < self.terminal_grace) {
            return Some(Err(Error::Proposal(TERMINAL_OPENING.into())));
        }
        if let Err(why) = self.left_terminal(run, session).await {
            return Some(Err(why));
        }
        Some(match link.take_back(session).await {
            Ok(()) => self.load(&run.id).await,
            // Already in plain words, and the way on is yours.
            Err(why) if why.contains(harness::session::STILL_IN_TERMINAL) => Err(Error::Proposal(plain_refusal(&why, session))),
            Err(why) => Err(Error::Proposal(format!("The harness didn't take the session back: {}", plain_refusal(&why, session)))),
        })
    }

    /// Refuses a take back while Claude's own listing on the run's login shows it still runs the session in Terminal.
    /// The harness refuses one while any process holds it.
    async fn left_terminal(&self, run: &Run, session: &str) -> Result<()> {
        use super::terminal_open::{alive, listed_open, still_open};
        let follow = self.core.session_run(session).await?.map(|(_, follow)| follow).unwrap_or_default();
        let Some(resumed_by) = follow.provider_session else { return Ok(()) };
        let listed = match self.observing_toolchain(run).await {
            Ok(tc) => tc.backend.listed_sessions().await.map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        match listed {
            Ok(rows) => match listed_open(&rows, &resumed_by, alive) {
                Some(pid) => Err(Error::Proposal(still_open(pid))),
                None => Ok(()),
            },
            // The harness still looks at every process.
            Err(why) => {
                eprintln!("couldn't ask Claude whether Terminal still runs session {session}; the harness's own check stands: {why}");
                Ok(())
            }
        }
    }

    /// Hands a run's session to Terminal: the harness closes it as handed over, so nothing resumes it until you take it
    /// back, and Terminal opens the provider's resume of it in its worktree, on the run's login. With `take_over`, as
    /// a request it can only deny offers, a turn waiting on a permission is cut so you can run it yourself there.
    /// `None` for a run not on the harness.
    pub(super) async fn hand_over_on_harness(&self, run: &Run, take_over: bool) -> Option<Result<()>> {
        let (link, session) = self.on_harness_of(run)?;
        Some(async {
            let follow = self.core.session_run(session).await?.map(|(_, follow)| follow).unwrap_or_default();
            let resumed_by = follow.provider_session.clone().ok_or_else(|| Error::Proposal("Its session hasn't started yet, so there is nothing to open.".into()))?;
            if take_over && !self.core.shown(run.clone()).permissions.iter().any(|request| request.deny_only) {
                return Err(Error::Proposal(TAKE_OVER_ONLY_DENY.into()));
            }
            // A hand-over cuts a running turn and drops the messages queued for it: Terminal takes a session at rest,
            // but for a permission you chose to answer there yourself.
            if follow.in_turn && !follow.closed && !(take_over && run.state == RunState::NeedsPermission) {
                let waits = matches!(run.state, RunState::NeedsAnswer | RunState::NeedsPermission);
                return Err(Error::Proposal(if waits { HAND_OVER_WAITING } else { HAND_OVER_IN_TURN }.into()));
            }
            if follow.closed {
                // The harness marks a closed session handed over as it is; the app no longer follows it, so it reads
                // the mark here.
                link.call(Op::HandOver { session: session.to_owned() }).await.map_err(|why| Error::Proposal(format!("The harness didn't hand the session over: {}", plain_refusal(&why, session))))?;
                self.core.apply_session(session, |run, _| {
                    run.handed_over = true;
                    run.last_detail = Some(super::consumer::HANDED_OVER.into());
                    Vec::new()
                }).await?;
            } else {
                // The app's own end of the turn, so it is not a cut that "carry on" would take up.
                let asked = |asked: bool| {
                    self.core.apply_session(session, move |_, follow| {
                        follow.stop_asked = asked;
                        Vec::new()
                    })
                };
                asked(true).await?;
                let mut applied = link.applied();
                if let Err(why) = link.call(Op::HandOver { session: session.to_owned() }).await {
                    asked(false).await?;
                    return Err(Error::Proposal(format!("The harness didn't hand the session over: {}", plain_refusal(&why, session))));
                }
                // The harness takes the hand-over before its agent has gone: Terminal opens once it has, so two never
                // run on the session at once.
                let gone = tokio::time::timeout(CLOSE_TAKES_UP_TO, async {
                    while !matches!(self.core.session_run(session).await, Ok(Some((_, follow))) if follow.closed) {
                        // A link going away has not seen it close.
                        if applied.changed().await.is_err() {
                            return false;
                        }
                    }
                    true
                });
                if !matches!(gone.await, Ok(true)) {
                    return Err(Error::Proposal(HANDED_OVER_NOT_GONE.into()));
                }
                if let Some(why) = link.kept(session).await {
                    return Err(Error::Proposal(format!("{HANDED_OVER_MAY_RUN} {}", plain_refusal(&why, session))));
                }
            }
            let tc = self.observing_toolchain(run).await?;
            let program = tc.backend.binary().ok_or_else(|| Error::Claude("Gossamr can't tell which program to open.".into()))?;
            let dir = self.core.data_dir().join(super::control::ATTACH_DIR);
            let words = vec!["--resume".to_owned(), resumed_by];
            let file = super::control::write_attach_file(&dir, tc.login.as_ref(), &program, &session_folder(run), &words)?;
            self.terminal.open(&file, self.settings().terminal).map_err(|e| Error::Claude(format!("Couldn't open Terminal: {e}")))?;
            self.opened_terminal.lock().unwrap_or_else(|e| e.into_inner()).insert(run.id.clone(), std::time::Instant::now());
            Ok(())
        }.await)
    }

    /// The provider's own resume of a run handed over to Terminal, as you would type it there: in its worktree, on its
    /// login, with no guard and none of Gossamr's tools.
    pub async fn resume_command(&self, run_id: &str) -> Result<String> {
        let run = self.load(run_id).await?;
        let (_, session) = self.on_harness_of(&run).filter(|_| run.handed_over).ok_or_else(|| Error::Proposal(NOT_HANDED_OVER.into()))?;
        let follow = self.core.session_run(session).await?.map(|(_, follow)| follow).unwrap_or_default();
        let resumed_by = follow.provider_session.clone().ok_or_else(|| Error::Proposal("Its session hasn't started yet, so there is nothing to resume.".into()))?;
        // Not while the harness's own agent may still run: two would write the session.
        let (link, _) = self.on_harness_of(&run).expect("checked above");
        if !follow.closed || link.kept(session).await.is_some() {
            return Err(Error::Proposal(AGENT_STOPPING.into()));
        }
        let tc = self.observing_toolchain(&run).await?;
        let program = tc.backend.binary().ok_or_else(|| Error::Claude("Gossamr can't tell which program to open.".into()))?;
        super::control::resume_line(tc.login.as_ref(), &program, &session_folder(&run), &["--resume".to_owned(), resumed_by])
    }

    /// Resume here: on your word that you took a run handed over to Terminal back, the harness takes its session back
    /// and starts it again by id, and it takes messages from then on.
    pub async fn take_back(&self, run_id: &str) -> Result<Run> {
        let _turn = self.launching.lock().await;
        let run = self.load(run_id).await?;
        if !run.handed_over {
            return Err(Error::Proposal(NOT_HANDED_OVER.into()));
        }
        self.take_back_on_harness(&run).await.unwrap_or_else(|| Err(Error::Proposal(NOT_HANDED_OVER.into())))
    }

    /// Asks the harness to stop a run's session; the run reads stopped once it closed. `None` for a run not on it.
    pub(super) async fn stop_on_harness(&self, run: &Run) -> Option<Result<Run>> {
        let (link, session) = self.on_harness_of(run)?;
        Some(match link.stop(session).await {
            Ok(()) => self.load(&run.id).await,
            Err(why) => Err(Error::Proposal(format!("The harness didn't stop it: {why}"))),
        })
    }
}

#[cfg(test)]
mod tests;
