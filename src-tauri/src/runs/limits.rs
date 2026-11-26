//! The person's limit on how many agents run at once.

use super::service::RunService;
use crate::config::AgentSettings;
use crate::error::Result;
pub use harness::repo::WorkFolderGit;

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
        // Sent to agents already started at once; one the harness cannot reach takes it with its next message.
        if let Some(on) = &self.harness {
            on.link.choose_permissions(settings.permissions);
        }
        Ok(settings)
    }
}

#[cfg(test)]
mod tests;
