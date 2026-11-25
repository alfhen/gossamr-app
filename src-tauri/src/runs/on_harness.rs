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

/// The run sheet says it, so a mock run is never taken for a real one.
pub const ON_THE_MOCK: &str = "This run is on a mock script, not on Claude. Nothing it says is real.";

/// The mock works in the clone as it is; every other provider in a new worktree on the run's branch.
pub fn open_op(run: &Run, provider: &str, model: Option<String>) -> Op {
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
        login: None,
        effort: None,
        ends_with_client: false,
        tools: Vec::new(),
        result_schema: None,
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
        let Some(on) = &self.harness else { return Ok(Err(Failure::CommandFailed("Gossamr has no harness to run agents on.".into()))) };
        if on.provider == MOCK {
            let row = RunEvent { run_id: run.id.clone(), seq: 0, at: chrono::Utc::now(), kind: "update".into(), text: ON_THE_MOCK.into(), detail: None };
            self.core.append_run_events(&run.id, &[row]).await?;
        }
        let session = match on.link.open(&run.id, open_op(run, &on.provider, model)).await {
            Ok(session) => session,
            Err(why) => return Ok(Err(Failure::CommandFailed(format!("The harness didn't open a session: {why}")))),
        };
        *run = self.load(&run.id).await?;
        if let Err(why) = on.link.call(Op::Send { session: session.clone(), text: first_prompt(run) }).await {
            let _ = on.link.stop(&session).await;
            return Ok(Err(Failure::CommandFailed(format!("The harness didn't take the brief: {why}"))));
        }
        Ok(Ok(()))
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
            Err(why) => Err(Error::Proposal(format!("The harness didn't take it: {why}"))),
        })
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
