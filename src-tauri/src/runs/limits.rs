//! The person's limit on how many agents run at once.

use serde::Serialize;

use super::fresh::{make_work_folder, read_work_folder, WorkFolder};
use super::repo::Git;
use super::service::RunService;
use crate::config::AgentSettings;
use crate::error::{Error, Result};

/// The settings with what git says about the work folder, which the page reads and never saves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsView {
    #[serde(flatten)]
    pub settings: AgentSettings,
    pub work_folder: WorkFolder,
}

impl RunService {
    pub fn settings(&self) -> AgentSettings {
        *self.settings.lock().expect("settings lock poisoned")
    }

    pub(super) fn cap(&self) -> usize {
        self.settings().max_runs
    }

    /// Clamps, saves and applies the settings. The saved file is written first, so a failed save changes nothing.
    pub fn set_settings(&self, settings: AgentSettings) -> Result<AgentSettings> {
        let settings = settings.clamped();
        let mut live = self.settings.lock().expect("settings lock poisoned");
        self.update_config(|config| config.agents = settings)?;
        *live = settings;
        Ok(settings)
    }

    pub async fn settings_view(&self, settings: AgentSettings) -> AgentSettingsView {
        let found = match (self.fresh_home(), self.tools.get().await) {
            (Some(home), Ok(tools)) => read_work_folder(&Git::new(tools.env), &home).await,
            _ => WorkFolder::default(),
        };
        AgentSettingsView { settings, work_folder: found }
    }

    /// Makes the work folder if it is missing and returns it, for the command that shows it in Finder.
    pub fn work_folder_to_reveal(&self) -> Result<std::path::PathBuf> {
        let home = self.fresh_home().ok_or_else(|| Error::Proposal("Gossamr can't find your home folder.".into()))?;
        make_work_folder(&home).map_err(|e| Error::Proposal(format!("Couldn't make ~/Gossamr/agents: {e}")))
    }
}

#[cfg(test)]
mod tests;
