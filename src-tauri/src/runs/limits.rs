//! The person's limit on how many agents run at once.

use super::service::RunService;
use crate::config::AgentSettings;
use crate::error::Result;
use serde::Serialize;

/// What git does in Gossamr's work folder, for Settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkFolderGit {
    /// The address git commits with there; none when git has no `user.email`.
    pub commit_email: Option<String>,
    /// The person's git settings choose settings by folder, which don't reach the work folder until they add a rule.
    pub include_if: bool,
}

/// The saved agent settings and the work folder's git settings beside them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsView {
    #[serde(flatten)]
    pub settings: AgentSettings,
    pub work_folder: WorkFolderGit,
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
}

#[cfg(test)]
mod tests;
