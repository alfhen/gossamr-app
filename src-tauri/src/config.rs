//! App-level settings, kept in `config.json` beside the databases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

const FILE: &str = "config.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// The `AgentProvider::id` Pip runs on.
    pub agent_provider: String,
    /// Background agent runs. Off until the feature is accepted.
    pub agents_enabled: bool,
    /// The clone the person chose for a repository (`owner/name`) when several match.
    pub picked_clones: HashMap<String, PathBuf>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { agent_provider: "claude-code".into(), agents_enabled: false, picked_clones: HashMap::new() }
    }
}

impl AppConfig {
    /// A missing or unreadable file gives the defaults, so a bad edit can't stop the app from starting.
    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(FILE)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let (temp, file) = (dir.join(format!("{FILE}.tmp")), dir.join(FILE));
        std::fs::write(&temp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&temp, &file).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })?;
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
        AppConfig { agent_provider: "codex".into(), ..AppConfig::default() }.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir).agent_provider, "codex");
        std::fs::write(dir.join(FILE), "{ nope").unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default());
        std::fs::write(dir.join(FILE), "{}").unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agents_are_off_by_default_and_a_picked_clone_round_trips_beside_older_settings() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!AppConfig::load(&dir).agents_enabled);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agentProvider":"codex"}"#).unwrap();
        let older = AppConfig::load(&dir);
        assert_eq!((older.agent_provider.as_str(), older.agents_enabled, older.picked_clones.len()), ("codex", false, 0));
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":true,"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        let on = AppConfig::load(&dir);
        assert!(on.agents_enabled);
        assert_eq!(on.picked_clones.get("acme/webshop"), Some(&PathBuf::from("/Users/me/Code/webshop")));
        on.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), on);
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":"yes"}"#).unwrap();
        assert!(!AppConfig::load(&dir).agents_enabled, "a mistyped value gives the defaults");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_no_temporary_file() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json.tmp"), "{ half").unwrap();
        let on = AppConfig { agents_enabled: true, ..AppConfig::default() };
        on.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), on);
        assert!(!dir.join("config.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
