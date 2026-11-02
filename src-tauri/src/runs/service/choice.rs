//! The instance and model a run launches on, and what a queued run does while they can't run it.

use super::*;
use crate::model_choice::{ModelChoice, Reason, Use, DEFAULT_MODEL};
use crate::runs::toolchain::ToolchainError;

/// Where a run launches: the toolchain of its instance and the `--model` to pass, if any.
pub(super) struct Target {
    pub tc: Toolchain,
    pub model: Option<String>,
}

pub(super) enum Blocked {
    /// The run stays queued and says why.
    Waits(String),
    Fails(Failure),
}

impl RunService {
    /// The one way a run's launch and checks get a toolchain: its instance's, never the default's unless that is its instance.
    pub(in crate::runs) async fn toolchain_of(&self, run: &Run) -> std::result::Result<Toolchain, ToolchainError> {
        match &run.runs_on {
            Some(choice) => self.tools.for_instance(&choice.instance_id).await,
            None => self.tools.get().await,
        }
    }

    /// Settles what `run` launches on and freezes it on the run. A run with no choice takes the Settings default.
    pub(super) async fn launch_target(&self, run: &mut Run) -> std::result::Result<Target, Blocked> {
        let (choice, instance) = self.core.agents_target(run.runs_on.as_ref()).map_err(Blocked::Waits)?;
        let model = (choice.model != DEFAULT_MODEL).then(|| choice.model.clone());
        run.runs_on = Some(choice);
        let tc = self.toolchain_of(run).await.map_err(|e| match e {
            ToolchainError::Unusable { reason, name } => Blocked::Waits(reason.words(Use::Agents, &name)),
            ToolchainError::BadFolder { name, problem } => Blocked::Waits(format!("{name}: {problem}")),
            ToolchainError::UnknownInstance(_) => Blocked::Waits(Reason::Removed.words(Use::Agents, &instance.display_name)),
            other => Blocked::Fails(other.into()),
        })?;
        Ok(Target { tc, model })
    }

    /// Keeps a run queued, to start by itself once its choice can run it.
    pub(super) async fn wait_for_choice(&self, run: &mut Run, words: String) -> Result<()> {
        let changed = run.state != RunState::Queued || run.slot_wait_since.is_some() || run.wait_reason.as_deref() != Some(words.as_str());
        run.state = RunState::Queued;
        run.error = None;
        run.failure = None;
        run.ended_at = None;
        run.slot_wait_since = None;
        run.wait_reason = Some(words);
        if changed {
            self.store(run).await?;
        }
        Ok(())
    }

    /// Changes what a run launches on, only while it is queued. A run that was waiting for its choice is tried on the
    /// new one at once.
    pub async fn set_model(&self, run_id: &str, choice: ModelChoice) -> Result<Run> {
        self.core.check_agents_choice(&choice)?;
        let turn = self.launching.lock().await;
        let run = self.load(run_id).await?;
        if !self.core.set_queued_run_choice(run_id, &choice).await? {
            return Err(Error::Proposal(format!("This run is {}, so what it runs on can't change.", run.state.as_str())));
        }
        (self.changed)(&run.connection_id);
        drop(turn);
        if run.wait_reason.is_some() {
            if let Err(e) = self.launch_waiting().await {
                eprintln!("couldn't start waiting runs after a new choice for run {run_id}: {e}");
            }
        }
        self.load(run_id).await
    }
}

#[cfg(test)]
mod tests;
