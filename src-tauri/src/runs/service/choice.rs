//! The instance and model a run launches on, and what a queued run does while they can't run it.

use super::*;
use crate::model_choice::{ModelChoice, Reason, Use};
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

/// The words a run waits with when its toolchain can't be had yet, or `None` when the failure ends the run instead.
/// Pip's check that agents can start uses the same rule.
pub(in crate::runs) fn waiting_words(e: &ToolchainError, instance_name: &str) -> Option<String> {
    match e {
        ToolchainError::Unusable { reason, name } => Some(reason.words(Use::Agents, name)),
        ToolchainError::BadFolder { name, problem } => Some(format!("{name}: {problem}")),
        ToolchainError::UnknownInstance(_) => Some(Reason::Removed.words(Use::Agents, instance_name)),
        _ => None,
    }
}

impl RunService {
    /// For acting on a run (launch, message, answer, trust): its instance's toolchain, never the default's unless that is its instance. It refuses an instance that is off; `observing_toolchain_of` accepts one, for looking at, stopping or removing an existing run.
    pub(in crate::runs) async fn toolchain_of(&self, run: &Run) -> std::result::Result<Toolchain, ToolchainError> {
        match &run.runs_on {
            Some(choice) => self.tools.for_instance(&choice.instance_id).await,
            None => self.tools.get().await,
        }
    }

    /// The toolchain for looking at a run that already exists: an instance turned off keeps its runs tracked.
    pub(in crate::runs) async fn observing_toolchain_of(&self, run: &Run) -> std::result::Result<Toolchain, ToolchainError> {
        match &run.runs_on {
            Some(choice) => self.tools.observe_instance(&choice.instance_id).await,
            None => self.tools.get().await,
        }
    }

    /// `toolchain_of` for a caller that reports to the person.
    pub(in crate::runs) async fn acting_toolchain(&self, run: &Run) -> Result<Toolchain> {
        self.toolchain_of(run).await.map_err(|e| Error::Claude(Failure::from(e).to_string()))
    }

    /// Whether acting on `run` waits only because its instance's login is off.
    pub(in crate::runs) async fn login_is_off(&self, run: &Run) -> bool {
        matches!(self.toolchain_of(run).await, Err(ToolchainError::Unusable { reason: Reason::Off, .. }))
    }

    /// `observing_toolchain_of` for a caller that reports to the person.
    pub(in crate::runs) async fn observing_toolchain(&self, run: &Run) -> Result<Toolchain> {
        self.observing_toolchain_of(run).await.map_err(|e| Error::Claude(Failure::from(e).to_string()))
    }

    /// Settles what `run` launches on and freezes it on the run. A run with no choice takes the Settings default.
    pub(super) async fn launch_target(&self, run: &mut Run) -> std::result::Result<Target, Blocked> {
        let (choice, instance) = self.core.agents_target(run.runs_on.as_ref()).map_err(Blocked::Waits)?;
        let model = choice.explicit_model();
        run.runs_on = Some(choice);
        let tc = self.toolchain_of(run).await.map_err(|e| match waiting_words(&e, &instance.display_name) {
            Some(words) => Blocked::Waits(words),
            None => Blocked::Fails(e.into()),
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

    /// A run the launcher cannot start (its workstream is paused or closed, or it is an unapproved auto-start) still
    /// shows the reason of its old choice; it is given the new choice's words, or none when that choice is ready. A run
    /// the launcher may start is left alone: the launcher also checks the toolchain, which this does not.
    async fn resettle_choice_reason(&self, run_id: &str) -> Result<()> {
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if run.state != RunState::Queued || run.wait_reason.is_none() || run.slot_wait_since.is_some() || self.may_start(&run).await {
            return Ok(());
        }
        let words = self.core.agents_target(run.runs_on.as_ref()).err();
        if run.wait_reason != words {
            run.wait_reason = words;
            self.store(&run).await?;
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
            self.resettle_choice_reason(run_id).await?;
        }
        self.load(run_id).await
    }
}

#[cfg(test)]
mod tests;
