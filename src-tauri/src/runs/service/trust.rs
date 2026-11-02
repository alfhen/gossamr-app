//! One-click trust for a run's clone (section 17 of docs/connections-proposal.md).

use super::*;
use crate::config::AppConfig;
use crate::connections::Driver;
use crate::domain::RunFailure;
use crate::runs::control::quotable;
use crate::runs::fresh::work_path;
use crate::runs::provider_folder::expand;
use crate::runs::toolchain::ToolchainError;
use crate::runs::trust::{self, Refusal};

/// The login's name on the card until instances have names of their own.
const LOGIN: &str = "Claude";

fn refused(why: Refusal) -> Error {
    Error::Claude(why.words(LOGIN))
}

impl RunService {
    /// The toolchain `run` launches with, and the one the trust pre-flight and the trust write take their login from, so
    /// a run is never checked against one login and launched on another.
    pub(super) async fn toolchain_of(&self, _run: &Run) -> std::result::Result<Toolchain, ToolchainError> {
        self.tools.get().await
    }

    /// Whether `run`'s stored clone is Gossamr's own clone of its repository, the only folder Gossamr trusts.
    async fn is_own_clone(&self, run: &Run, tc: &Toolchain) -> bool {
        let (spec, Some(home)) = (&run.spec, self.fresh_home()) else { return false };
        let clone = &spec.clone_path;
        let there = clone.symlink_metadata().is_ok_and(|m| m.is_dir()) && clone.join(".git").exists() && clone.canonicalize().is_ok_and(|real| &real == clone);
        let named = work_path(&home, &spec.repo).is_ok_and(|want| &want == clone) && is_work_path(&home, &spec.repo, clone);
        if !(there && named && quotable(clone).is_ok() && self.core.require_watched_repo(&spec.repo).is_ok()) {
            return false;
        }
        Git::new(tc.env.clone()).origin(clone).await.is_some_and(|url| origin_matches(&url, &spec.repo))
    }

    /// Writes the trust entry for `run`'s clone in its login's settings file, then retries the run. Refused unless the
    /// run failed because the clone isn't trusted and the folder is its own clone in the work folder; the page sends a
    /// run id and never a path.
    pub async fn retry_with_trust(&self, run_id: &str) -> Result<Run> {
        let run = self.load(run_id).await?;
        let untrusted = matches!(run.failure, Some(RunFailure::UntrustedFolder { .. }));
        if run.state != RunState::Failed || run.short_id.is_some() || !untrusted {
            return Err(Error::Proposal("Trusting is only for a run that failed because Claude doesn't trust its clone.".into()));
        }
        let tc = self.toolchain_of(&run).await.map_err(|e| claude_error(e.into()))?;
        if !self.is_own_clone(&run, &tc).await {
            return Err(refused(Refusal::NotOurClone));
        }
        let auth = tc.cli.auth_status().await.map_err(|_| refused(Refusal::CantTell))?;
        let file = trust::config_file(&tc.env, &auth).map_err(refused)?;
        if trust::trust(&file, &run.spec.clone_path).await.map_err(refused)? {
            let text = format!("You trusted Gossamr's clone of {} for {LOGIN}", run.spec.repo);
            let event = RunEvent { run_id: run.id.clone(), seq: 0, at: Utc::now(), kind: "trust_saved".into(), text, detail: None };
            if let Err(e) = self.core.append_run_events(&run.id, &[event]).await {
                eprintln!("couldn't record trust_saved on run {}: {e}", run.id);
            }
        }
        self.retry_launch(run_id).await
    }

    /// Removes the temp files a crash left beside the settings files Gossamr may have written to.
    pub fn clean_trust_leftovers(&self) {
        let Some(home) = self.fresh_home() else { return };
        let providers = AppConfig::load(&self.core.data_dir()).providers;
        let folders = providers.iter().filter(|p| p.driver == Driver::Claude).filter_map(|p| p.config.config_dir.as_deref()).map(|typed| expand(typed, &home));
        for dir in std::iter::once(home.clone()).chain(folders) {
            trust::clean_folder(&dir);
        }
    }
}

#[cfg(test)]
mod tests;
