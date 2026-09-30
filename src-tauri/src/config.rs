//! App-level settings, kept in `config.json` beside the databases.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;

const FILE: &str = "config.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// The `AgentProvider::id` Pip runs on.
    pub agent_provider: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { agent_provider: "claude-code".into() }
    }
}

impl AppConfig {
    /// A missing or unreadable file gives the defaults, so a bad edit can't stop the app from starting.
    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(FILE)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    #[allow(dead_code)]
    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        std::fs::write(dir.join(FILE), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_claude_and_survives_a_round_trip_and_a_bad_file() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(AppConfig::load(&dir).agent_provider, "claude-code");
        AppConfig { agent_provider: "codex".into() }.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir).agent_provider, "codex");
        std::fs::write(dir.join(FILE), "{ nope").unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default());
        std::fs::write(dir.join(FILE), "{}").unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
