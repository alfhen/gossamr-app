//! The one switch for Agents. `config.json` holds it, this service enforces it, and the page only asks.

use serde::Serialize;

use super::failure::Failure;
use super::service::RunService;
use crate::config::AppConfig;
use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnabledChange {
    pub enabled: bool,
    /// Agents still running after the change.
    pub keep_running: usize,
    /// What the change did not do, for the person to read.
    pub note: Option<String>,
}

impl RunService {
    pub(super) fn update_config(&self, change: impl FnOnce(&mut AppConfig)) -> Result<()> {
        let _only_writer = self.config_lock.lock().expect("config lock poisoned");
        let dir = self.core.data_dir();
        let mut config = AppConfig::load(&dir);
        change(&mut config);
        config.save(&dir)
    }

    fn change(&self) -> EnabledChange {
        let keep_running = self.keep_running();
        let enabled = self.is_enabled();
        let note = (!enabled && keep_running > 0).then(|| {
            let (count, verb) = if keep_running == 1 { ("1 agent is".to_string(), "keeps") } else { (format!("{keep_running} agents are"), "keep") };
            format!("{count} still running and was not stopped. Gossamr won't start new ones or follow these until you turn Agents back on; they {verb} running in Claude.")
        });
        EnabledChange { enabled, keep_running, note }
    }

    /// Turning on reads the shell environment first, and a failure leaves the switch off. Turning off refuses new
    /// launches and touches nothing that is running. The switch is saved before it takes effect, so a failed save
    /// changes nothing.
    pub async fn set_enabled(&self, on: bool) -> Result<EnabledChange> {
        let _one_switch = self.switching.lock().await;
        if on == self.is_enabled() {
            return Ok(self.change());
        }
        if on {
            self.tools.get().await.map_err(|e| Error::Claude(Failure::from(e).to_string()))?;
        }
        self.update_config(|config| config.agents_enabled = on)?;
        self.set_flag(on);
        if on {
            self.clean_attach_files();
            self.focus.notify_one();
        }
        Ok(self.change())
    }
}

#[cfg(test)]
mod tests;
