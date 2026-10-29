//! App-level settings, kept in `config.json` beside the databases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::connections::{Instance, VERSION};
use crate::error::Result;
use crate::runs::notices::NoticeMode;

const FILE: &str = "config.json";
const BACKUP: &str = "config.json.bak";
/// The keys that make up the instance list. They are read apart from the preferences, and a copy that can't be read is kept as it is.
const CONNECTION_KEYS: [&str; 3] = ["version", "connections", "retiredIds"];

static WRITER: Mutex<()> = Mutex::new(());

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
    pub notifications: NoticeMode,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            max_runs: 3,
            terminal: TerminalChoice::Terminal,
            notifications: NoticeMode::Workstream,
        }
    }
}

impl AgentSettings {
    pub fn clamped(self) -> Self {
        Self {
            max_runs: self.max_runs.clamp(*MAX_RUNS.start(), *MAX_RUNS.end()),
            terminal: self.terminal,
            notifications: self.notifications,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// The clone the person chose for a repository (`owner/name`) when several match.
    pub picked_clones: HashMap<String, PathBuf>,
    pub agents: AgentSettings,
    /// Which version of the instance list was written; 0 until the sign-ins already there have been adopted.
    #[serde(skip_deserializing)]
    pub version: u32,
    #[serde(skip_deserializing)]
    pub connections: Vec<Instance>,
    /// Ids of removed instances, which are never given out again.
    #[serde(skip_deserializing)]
    pub retired_ids: Vec<String>,
    /// Why the instance list could not be used. While it is set, the list is neither changed nor replaced.
    #[serde(skip)]
    pub connections_error: Option<String>,
    #[serde(skip)]
    unreadable_connections: Option<Map<String, Value>>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Roster {
    version: u32,
    connections: Vec<Instance>,
    retired_ids: Vec<String>,
}

impl AppConfig {
    /// A missing file gives the defaults, and so do unreadable preferences, so a bad edit can't stop the app from starting.
    /// The instance list is stricter: when it can't be read the file is copied to `config.json.bak`, `connections_error`
    /// says so, and saving writes the list back as it was.
    pub fn load(dir: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(dir.join(FILE)) else { return Self::default() };
        let Ok(Value::Object(file)) = serde_json::from_str::<Value>(&text) else {
            back_up(dir, &text);
            return Self { connections_error: Some(format!("{FILE} isn't valid JSON; a copy is in {BACKUP}")), ..Self::default() };
        };
        let mut config: Self = serde_json::from_value(Value::Object(file.clone())).unwrap_or_default();
        config.agents = config.agents.clamped();
        let block: Map<String, Value> = CONNECTION_KEYS.iter().filter_map(|k| Some((k.to_string(), file.get(*k)?.clone()))).collect();
        let problem = match serde_json::from_value::<Roster>(Value::Object(block.clone())) {
            Ok(roster) if roster.version <= VERSION => {
                (config.version, config.connections, config.retired_ids) = (roster.version, roster.connections, roster.retired_ids);
                None
            }
            Ok(_) => Some(format!("{FILE} was written by a newer Gossamr; a copy is in {BACKUP}")),
            Err(e) => Some(format!("the connections in {FILE} can't be read ({e}); a copy is in {BACKUP}")),
        };
        if let Some(problem) = problem {
            back_up(dir, &text);
            config.connections_error = Some(problem);
            config.unreadable_connections = Some(block);
        }
        config
    }

    /// Loads, changes and saves under one lock, so two writers don't undo each other.
    pub fn update(dir: &Path, change: impl FnOnce(&mut Self)) -> Result<()> {
        let _only_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = Self::load(dir);
        change(&mut config);
        config.save(dir)
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir)?;
        let (temp, file) = (dir.join(format!("{FILE}.tmp")), dir.join(FILE));
        let mut value = serde_json::to_value(self)?;
        if let (Some(kept), Value::Object(map)) = (&self.unreadable_connections, &mut value) {
            for key in CONNECTION_KEYS {
                map.remove(key);
            }
            map.extend(kept.clone());
        }
        std::fs::write(&temp, serde_json::to_string_pretty(&value)?)?;
        std::fs::rename(&temp, &file).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })?;
        Ok(())
    }
}

fn back_up(dir: &Path, text: &str) {
    let backup = dir.join(BACKUP);
    if std::fs::read_to_string(&backup).is_ok_and(|kept| kept == text) {
        return;
    }
    if let Err(e) = std::fs::write(&backup, text) {
        eprintln!("couldn't copy {FILE} to {BACKUP}: {e}");
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
        let broken = AppConfig::load(&dir);
        assert_eq!(AppConfig { connections_error: None, ..broken.clone() }, AppConfig::default());
        assert!(broken.connections_error.is_some());
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
        assert_eq!(AppConfig::load(&dir).agents, AgentSettings { max_runs: 3, terminal: TerminalChoice::Terminal, notifications: NoticeMode::Workstream });
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
    fn old_notification_settings_load_without_the_digest_field() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-notices-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agents":{"notifications":"digest","digestMinutes":45}}"#).unwrap();
        let loaded = AppConfig::load(&dir);
        assert_eq!(loaded.agents.notifications, NoticeMode::Workstream);
        loaded.save(&dir).unwrap();
        assert!(!std::fs::read_to_string(dir.join(FILE)).unwrap().contains("digest"));
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

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gossamr-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const INSTANCES: &str = r#""version":1,"connections":[{"id":"github","kind":"github","displayName":"GitHub","enabled":true,"config":{"host":"github.com","login":"ann"},"boundTo":"github:ann"}],"retiredIds":["github_2"]"#;

    #[test]
    fn instances_survive_a_load_and_a_save_beside_the_preferences() {
        let dir = scratch("instances");
        std::fs::write(dir.join(FILE), format!("{{{INSTANCES},\"agents\":{{\"maxRuns\":2}}}}")).unwrap();
        let loaded = AppConfig::load(&dir);
        assert_eq!((loaded.version, loaded.connections.len(), loaded.retired_ids.clone()), (1, 1, vec!["github_2".to_string()]));
        assert_eq!(loaded.connections_error, None);
        AppConfig::update(&dir, |c| c.agents.max_runs = 4).unwrap();
        let again = AppConfig::load(&dir);
        assert_eq!((again.agents.max_runs, again.connections, again.retired_ids), (4, loaded.connections, loaded.retired_ids));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_connections_list_that_cant_be_read_is_kept_copied_and_reported_while_the_preferences_still_load() {
        let dir = scratch("damaged");
        let text = r#"{"agents":{"maxRuns":2},"version":1,"connections":[{"id":"github","kind":"gitlab"}],"retiredIds":["github_2"]}"#;
        std::fs::write(dir.join(FILE), text).unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.as_deref().is_some_and(|e| e.contains("config.json.bak")), "{:?}", loaded.connections_error);
        assert_eq!((loaded.agents.max_runs, loaded.connections.len()), (2, 0));
        assert_eq!(std::fs::read_to_string(dir.join(BACKUP)).unwrap(), text);
        AppConfig::update(&dir, |c| c.agents.max_runs = 5).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(saved["connections"], serde_json::json!([{ "id": "github", "kind": "gitlab" }]));
        assert_eq!((saved["version"].clone(), saved["retiredIds"].clone(), saved["agents"]["maxRuns"].clone()), (1.into(), serde_json::json!(["github_2"]), 5.into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_list_written_by_a_newer_version_is_left_as_it_is() {
        let dir = scratch("newer");
        let text = r#"{"version":2,"connections":[{"id":"jira","somethingNew":true}]}"#;
        std::fs::write(dir.join(FILE), text).unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some());
        loaded.save(&dir).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!((saved["version"].clone(), saved["connections"].clone()), (2.into(), serde_json::json!([{ "id": "jira", "somethingNew": true }])));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_that_isnt_json_is_copied_before_the_defaults_replace_it() {
        let dir = scratch("garbage");
        std::fs::write(dir.join(FILE), "{ nope").unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some());
        assert_eq!(std::fs::read_to_string(dir.join(BACKUP)).unwrap(), "{ nope");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_file_has_no_instances_and_no_error() {
        let dir = scratch("missing");
        let loaded = AppConfig::load(&dir);
        assert_eq!((loaded.version, loaded.connections.is_empty(), loaded.connections_error), (0, true, None));
        assert!(!dir.join(BACKUP).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
