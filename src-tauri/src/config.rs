//! App-level settings, kept in `config.json` beside the databases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

const FILE: &str = "config.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalChoice {
    #[default]
    Terminal,
    #[serde(rename = "iTerm")]
    ITerm,
}

pub const MAX_RUNS: std::ops::RangeInclusive<usize> = 1..=6;
const MAX_MINUTES: u32 = 7 * 24 * 60;
const MAX_TOKENS: u64 = 1_000_000_000;

/// What the person controls about agent runs. Zero turns a limit off.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    pub max_runs: usize,
    pub wall_clock_minutes: u32,
    pub token_cap: u64,
    pub terminal: TerminalChoice,
    /// Draft a Jira comment on the run's ticket when it finishes with a `For Jira:` section.
    pub draft_on_finish: bool,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self { max_runs: 3, wall_clock_minutes: 60, token_cap: 3_000_000, terminal: TerminalChoice::Terminal, draft_on_finish: true }
    }
}

impl AgentSettings {
    pub fn clamped(self) -> Self {
        Self {
            max_runs: self.max_runs.clamp(*MAX_RUNS.start(), *MAX_RUNS.end()),
            wall_clock_minutes: self.wall_clock_minutes.min(MAX_MINUTES),
            token_cap: self.token_cap.min(MAX_TOKENS),
            terminal: self.terminal,
            draft_on_finish: self.draft_on_finish,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// The `AgentProvider::id` Pip runs on.
    pub agent_provider: String,
    /// Background agent runs. On unless the person turned them off; a config without the key is a fresh install.
    pub agents_enabled: bool,
    /// The clone the person chose for a repository (`owner/name`) when several match.
    pub picked_clones: HashMap<String, PathBuf>,
    pub agents: AgentSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { agent_provider: "claude-code".into(), agents_enabled: true, picked_clones: HashMap::new(), agents: AgentSettings::default() }
    }
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
    fn agents_are_on_for_a_fresh_install_and_a_saved_choice_wins_and_a_picked_clone_round_trips_beside_older_settings() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(AppConfig::load(&dir).agents_enabled);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agentProvider":"codex"}"#).unwrap();
        let older = AppConfig::load(&dir);
        assert_eq!((older.agent_provider.as_str(), older.agents_enabled, older.picked_clones.len()), ("codex", true, 0));
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":true,"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":false,"agentProvider":"codex"}"#).unwrap();
        assert!(!AppConfig::load(&dir).agents_enabled, "a saved off stays off");
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":true,"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        let on = AppConfig::load(&dir);
        assert!(on.agents_enabled);
        assert_eq!(on.picked_clones.get("acme/webshop"), Some(&PathBuf::from("/Users/me/Code/webshop")));
        on.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), on);
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":"yes"}"#).unwrap();
        assert_eq!(AppConfig::load(&dir), AppConfig::default(), "a mistyped value gives the defaults");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn agent_settings_are_clamped_on_load_and_round_trip_with_the_terminal_choice() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-limits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir).agents, AgentSettings { max_runs: 3, wall_clock_minutes: 60, token_cap: 3_000_000, terminal: TerminalChoice::Terminal, draft_on_finish: true });
        std::fs::write(dir.join(FILE), r#"{"agents":{"draftOnFinish":false}}"#).unwrap();
        assert!(!AppConfig::load(&dir).agents.draft_on_finish);
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":2}}"#).unwrap();
        assert!(AppConfig::load(&dir).agents.draft_on_finish, "an older config keeps the default");
        std::fs::write(dir.join(FILE), r#"{"agents":{"maxRuns":99,"wallClockMinutes":4294967295,"tokenCap":0,"terminal":"iTerm"}}"#).unwrap();
        let loaded = AppConfig::load(&dir).agents;
        assert_eq!((loaded.max_runs, loaded.wall_clock_minutes, loaded.token_cap, loaded.terminal), (6, MAX_MINUTES, 0, TerminalChoice::ITerm));
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
    fn a_save_replaces_the_file_whole_and_leaves_no_temporary_file() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json.tmp"), "{ half").unwrap();
        let on = AppConfig { agents_enabled: false, ..AppConfig::default() };
        on.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), on);
        assert!(!dir.join("config.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
