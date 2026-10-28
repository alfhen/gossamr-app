//! App-level settings, kept in `config.json` beside the databases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::runs::notices::{NoticeMode, DIGEST_MINUTES, DIGEST_MINUTES_MAX};

const FILE: &str = "config.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalChoice {
    #[default]
    Terminal,
    #[serde(rename = "iTerm")]
    ITerm,
}

pub const MAX_RUNS: std::ops::RangeInclusive<usize> = 1..=6;

/// What the person controls about agent runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    pub max_runs: usize,
    pub terminal: TerminalChoice,
    /// Which system notifications about runs the person gets (`runs::notices`).
    pub notifications: NoticeMode,
    /// Minutes between digest notifications, when `notifications` is a digest.
    pub digest_minutes: u32,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            max_runs: 3,
            terminal: TerminalChoice::Terminal,
            notifications: NoticeMode::Workstream,
            digest_minutes: DIGEST_MINUTES,
        }
    }
}

impl AgentSettings {
    pub fn clamped(self) -> Self {
        Self {
            max_runs: self.max_runs.clamp(*MAX_RUNS.start(), *MAX_RUNS.end()),
            terminal: self.terminal,
            notifications: self.notifications,
            digest_minutes: self.digest_minutes.clamp(1, DIGEST_MINUTES_MAX),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// The clone the person chose for a repository (`owner/name`) when several match.
    pub picked_clones: HashMap<String, PathBuf>,
    pub agents: AgentSettings,
}

impl AppConfig {
    /// A missing or unreadable file gives the defaults, so a bad edit can't stop the app from starting.
    pub fn load(dir: &Path) -> Self {
        let mut config: Self = std::fs::read_to_string(dir.join(FILE)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        config.agents = config.agents.clamped();
        config
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
    fn defaults_survive_a_round_trip_and_a_bad_file_and_unknown_keys_are_ignored() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let saved = AppConfig { picked_clones: HashMap::from([("acme/webshop".to_string(), PathBuf::from("/Users/me/Code/webshop"))]), ..AppConfig::default() };
        saved.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), saved);
        std::fs::write(dir.join(FILE), r#"{"agentProvider":"codex","agentsEnabled":false,"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        assert_eq!(AppConfig::load(&dir), saved, "a key no longer read is skipped");
        std::fs::write(dir.join(FILE), "{ nope").unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default());
        std::fs::write(dir.join(FILE), "{}").unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_config_with_removed_settings_still_loads_and_drops_them() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":2,"reportResult":true,"draftOnFinish":false,"wallClockMinutes":10,"tokenCap":100,"autostart":{"triagePlan":true},"managerTurnsPerDay":6},"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        let loaded = AppConfig::load(&dir);
        assert_eq!(loaded.agents.max_runs, 2);
        assert_eq!(loaded.picked_clones.len(), 1);
        loaded.save(&dir).unwrap();
        let saved = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(["reportResult", "draftOnFinish", "wallClockMinutes", "tokenCap", "autostart", "managerTurnsPerDay"].iter().all(|key| !saved.contains(key)), "{saved}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_picked_clone_round_trips_beside_older_settings_and_a_mistyped_value_gives_the_defaults() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agentProvider":"codex"}"#).unwrap();
        assert_eq!(AppConfig::load(&dir).picked_clones.len(), 0);
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":true,"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        let on = AppConfig::load(&dir);
        assert_eq!(on.picked_clones.get("acme/webshop"), Some(&PathBuf::from("/Users/me/Code/webshop")));
        on.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), on);
        std::fs::write(dir.join(FILE), r#"{"pickedClones":"yes"}"#).unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default(), "a mistyped value gives the defaults");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agent_settings_are_clamped_on_load_and_round_trip_with_the_terminal_choice() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-limits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir).agents, AgentSettings { max_runs: 3, terminal: TerminalChoice::Terminal, notifications: NoticeMode::Workstream, digest_minutes: 30 });
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":99,"wallClockMinutes":4294967295,"tokenCap":0,"terminal":"iTerm"}}"#).unwrap();
        let loaded = AppConfig::load(&dir).agents;
        assert_eq!((loaded.max_runs, loaded.terminal), (6, TerminalChoice::ITerm), "keys of the removed limits are ignored");
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":0}}"#).unwrap();
        assert_eq!(AppConfig::load(&dir).agents.max_runs, 1);
        let chosen = AppConfig { agents: AgentSettings { max_runs: 2, terminal: TerminalChoice::ITerm, ..AgentSettings::default() }, ..AppConfig::default() };
        chosen.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), chosen);
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":"many"}}"#).unwrap();
        assert_eq!(AppConfig::load(&dir).agents, AgentSettings::default(), "a bad value gives the defaults");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_config_with_the_removed_automation_settings_still_loads_and_drops_them() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":2,"draftOnFinish":false,"autostart":{"triagePlan":false,"reviewVerify":true},"managerTurnsPerDay":9999}}"#).unwrap();
        let loaded = AppConfig::load(&dir).agents;
        assert_eq!(loaded.max_runs, 2);
        AppConfig::load(&dir).save(&dir).unwrap();
        let saved = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(!saved.contains("autostart") && !saved.contains("managerTurnsPerDay"), "{saved}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_notification_choice_defaults_to_each_workstream_clamps_the_digest_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-notices-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":2}}"#).unwrap();
        let older = AppConfig::load(&dir).agents;
        assert_eq!((older.notifications, older.digest_minutes), (NoticeMode::Workstream, 30), "an older config gets the defaults");
        std::fs::write(dir.join(FILE), r#"{"agents":{"notifications":"digest","digestMinutes":0}}"#).unwrap();
        let loaded = AppConfig::load(&dir).agents;
        assert_eq!((loaded.notifications, loaded.digest_minutes), (NoticeMode::Digest, 1));
        std::fs::write(dir.join(FILE), r#"{"agents":{"digestMinutes":99999}}"#).unwrap();
        assert_eq!(AppConfig::load(&dir).agents.digest_minutes, DIGEST_MINUTES_MAX);
        let chosen = AppConfig { agents: AgentSettings { notifications: NoticeMode::Off, digest_minutes: 45, ..AgentSettings::default() }, ..AppConfig::default() };
        chosen.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), chosen);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_no_temporary_file() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json.tmp"), "{ half").unwrap();
        let on = AppConfig { picked_clones: HashMap::from([("acme/webshop".to_string(), PathBuf::from("/Users/me/Code/webshop"))]), ..AppConfig::default() };
        on.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), on);
        assert!(!dir.join("config.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
