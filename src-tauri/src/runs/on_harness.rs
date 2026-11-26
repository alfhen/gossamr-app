//! A Claude run opens a harness session in place of `claude --bg`: the session works in a new worktree of the clone,
//! the first prompt is the brief, and the run is what the session's events say from then on (`consumer`).

use std::sync::Arc;

use async_trait::async_trait;
use harness::api::Op;
use harness::client::Client;

use super::failure::Failure;
use super::link::{Connect, Link};
use super::service::RunService;
use crate::domain::{render_prompt, Run, RunEvent, RunState};
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

/// The first prompt: the brief the person approved. The harness adds its own guard as system text.
pub fn first_prompt(run: &Run) -> String {
    render_prompt(&run.spec)
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
    pub(super) async fn send_on_harness(&self, run: &Run, text: &str) -> Option<Result<(Run, bool)>> {
        let (link, session) = self.on_harness_of(run)?;
        if matches!(run.state, RunState::Queued | RunState::Launching | RunState::Failed | RunState::Stopped) {
            return Some(Err(Error::Proposal(format!("This run is {}, so it takes no message.", run.state.as_str()))));
        }
        Some(match link.send(session, text).await {
            Ok(answered) => self.load(&run.id).await.map(|run| (run, answered)),
            Err(why) if why == super::link::ANSWER_ON_ITS_WAY || why == super::link::NOT_RUNNING => Err(Error::Proposal(why)),
            Err(why) => Err(Error::Proposal(format!("The harness didn't take it: {why}"))),
        })
    }

    /// Allows or denies one open permission request of `run_id`, once.
    pub async fn answer_permission(&self, _run_id: &str, _request: &str, _decision: harness::event::Decision) -> Result<Run> {
        Err(Error::Proposal("Gossamr can't answer permission requests yet.".into()))
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
