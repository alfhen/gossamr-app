//! The person's limit on how many agents run at once.

use super::service::RunService;
use crate::config::AgentSettings;
use crate::error::Result;
use serde::Serialize;

/// What git does in Gossamr's work folder, for Settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkFolderGit {
    /// The address in the person's global git settings; none when there is none.
    pub global_email: Option<String>,
    /// The address git commits with inside the newest clone of each owner. Empty until Gossamr has made a clone.
    pub owners: Vec<OwnerAddress>,
    /// Their git settings choose an address by folder, and no clone in the work folder gets anything but the global one.
    pub include_if: bool,
}

/// Who git commits as inside one owner's clones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerAddress {
    pub owner: String,
    pub commit_email: Option<String>,
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
