//! App-level settings, kept in `config.json` beside the databases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::connections::{self, Instance, ProviderInstance, VERSION};
use crate::error::Result;
use crate::runs::notices::NoticeMode;

const FILE: &str = "config.json";
const BACKUP: &str = "config.json.bak";
/// The keys that make up the instance list. They are read apart from the preferences, and a copy that can't be read is kept as it is.
const CONNECTION_KEYS: [&str; 3] = ["version", "connections", "retiredIds"];

const PROVIDERS_KEY: &str = "providers";

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
    /// The model providers (Claude, Codex logins). Read apart from `connections`, and not part of its version.
    #[serde(skip_deserializing)]
    pub providers: Vec<ProviderInstance>,
    /// Why the provider list could not be used. While it is set, the list is neither changed nor replaced.
    #[serde(skip)]
    pub providers_error: Option<String>,
    #[serde(skip)]
    unreadable_connections: Option<Map<String, Value>>,
    #[serde(skip)]
    unreadable_providers: Option<Value>,
    /// The file has no `providers` key and the retired ids that decide the default instance couldn't be read, so the key is left out of what is saved.
    #[serde(skip)]
    providers_withheld: bool,
    /// The file couldn't be read as a whole, so anything saved would replace what is really there. Saving is refused.
    #[serde(skip)]
    file_unreadable: bool,
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
    /// says so, and saving writes the list back as it was. A file that can't be read at all, or isn't JSON, is never
    /// replaced: `save` and `update` fail while `connections_error` is set.
    pub fn load(dir: &Path) -> Self {
        let bytes = match std::fs::read(dir.join(FILE)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self { providers: vec![connections::default_claude()], ..Self::default() },
            Err(e) => return Self::locked(format!("{FILE} can't be read ({e}); it was left as it is")),
        };
        let Ok(text) = String::from_utf8(bytes.clone()) else {
            back_up(dir, &bytes);
            return Self::locked(format!("{FILE} isn't valid UTF-8; a copy is in {BACKUP} and the file was left as it is"));
        };
        let Ok(Value::Object(file)) = serde_json::from_str::<Value>(&text) else {
            back_up(dir, &bytes);
            return Self::locked(format!("{FILE} isn't valid JSON; a copy is in {BACKUP} and the file was left as it is"));
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
            back_up(dir, &bytes);
            config.connections_error = Some(problem);
            config.unreadable_connections = Some(block);
        }
        config.load_providers(dir, &bytes, file.get(PROVIDERS_KEY));
        config
    }

    fn load_providers(&mut self, dir: &Path, bytes: &[u8], stored: Option<&Value>) {
        let Some(stored) = stored else {
            if self.connections_error.is_some() {
                self.providers_withheld = true;
            } else if !self.retired_ids.iter().any(|id| id == connections::DEFAULT_CLAUDE) {
                self.providers.push(connections::default_claude());
            }
            return;
        };
        match serde_json::from_value::<Vec<ProviderInstance>>(stored.clone()) {
            Ok(list) if has_duplicate_ids(&list) => self.lock_providers(dir, bytes, stored, "two of them share an id".into()),
            Ok(list) if self.names_a_connection(&list) => self.lock_providers(dir, bytes, stored, "one of them shares an id with a connection".into()),
            Ok(list) => {
                self.providers = list;
                if self.connections_error.is_some() {
                    self.unreadable_providers = Some(stored.clone());
                }
            }
            Err(e) => self.lock_providers(dir, bytes, stored, e.to_string()),
        }
    }

    fn names_a_connection(&self, list: &[ProviderInstance]) -> bool {
        list.iter().any(|p| self.connections.iter().any(|i| i.id == p.id || i.bound_to.as_deref() == Some(p.id.as_str())) || self.retired_ids.contains(&p.id))
    }

    fn lock_providers(&mut self, dir: &Path, bytes: &[u8], stored: &Value, why: String) {
        back_up(dir, bytes);
        self.providers_error = Some(format!("the providers in {FILE} can't be read ({why}); a copy is in {BACKUP}"));
        self.unreadable_providers = Some(stored.clone());
    }

    fn locked(problem: String) -> Self {
        Self { connections_error: Some(problem), file_unreadable: true, ..Self::default() }
    }

    /// Loads, changes and saves under one lock, so two writers don't undo each other.
    pub fn update(dir: &Path, change: impl FnOnce(&mut Self)) -> Result<()> {
        Self::update_if(dir, |config| {
            change(config);
            true
        })
    }

    /// Like `update`, but the file is written only when `change` returns true.
    pub fn update_if(dir: &Path, change: impl FnOnce(&mut Self) -> bool) -> Result<()> {
        let _only_writer = WRITER.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = Self::load(dir);
        config.refuse_if_locked()?;
        if change(&mut config) {
            config.save(dir)?;
        }
        Ok(())
    }

    fn refuse_if_locked(&self) -> Result<()> {
        match (&self.connections_error, self.file_unreadable) {
            (Some(problem), true) => Err(std::io::Error::other(problem.clone()).into()),
            _ => Ok(()),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        self.refuse_if_locked()?;
        std::fs::create_dir_all(dir)?;
        let (temp, file) = (dir.join(format!("{FILE}.tmp")), dir.join(FILE));
        let mut value = serde_json::to_value(self)?;
        if let (Some(kept), Value::Object(map)) = (&self.unreadable_connections, &mut value) {
            for key in CONNECTION_KEYS {
                map.remove(key);
            }
            map.extend(kept.clone());
        }
        if let Value::Object(map) = &mut value {
            match &self.unreadable_providers {
                Some(kept) => {
                    map.insert(PROVIDERS_KEY.into(), kept.clone());
                }
                None if self.providers_withheld => {
                    map.remove(PROVIDERS_KEY);
                }
                None => {}
            }
        }
        std::fs::write(&temp, serde_json::to_string_pretty(&value)?)?;
        std::fs::rename(&temp, &file).inspect_err(|_| {
            let _ = std::fs::remove_file(&temp);
        })?;
        Ok(())
    }
}

fn has_duplicate_ids(list: &[ProviderInstance]) -> bool {
    list.iter().enumerate().any(|(at, p)| list[..at].iter().any(|q| q.id == p.id))
}

fn back_up(dir: &Path, bytes: &[u8]) {
    let backup = dir.join(BACKUP);
    if std::fs::read(&backup).is_ok_and(|kept| kept == bytes) {
        return;
    }
    if let Err(e) = std::fs::write(&backup, bytes) {
        eprintln!("couldn't copy {FILE} to {BACKUP}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> AppConfig {
        AppConfig { providers: vec![connections::default_claude()], ..AppConfig::default() }
    }

    #[test]
    fn defaults_survive_a_round_trip_and_a_bad_file_and_unknown_keys_are_ignored() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let saved = AppConfig { picked_clones: HashMap::from([("acme/webshop".to_string(), PathBuf::from("/Users/me/Code/webshop"))]), ..fresh() };
        saved.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), saved);
        std::fs::write(dir.join(FILE), r#"{"agentProvider":"codex","agentsEnabled":false,"pickedClones":{"acme/webshop":"/Users/me/Code/webshop"}}"#).unwrap();
        assert_eq!(AppConfig::load(&dir), saved, "a key no longer read is skipped");
        std::fs::write(dir.join(FILE), "{ nope").unwrap();
        let broken = AppConfig::load(&dir);
        assert_eq!(AppConfig { connections_error: None, file_unreadable: false, ..broken.clone() }, AppConfig::default());
        assert!(broken.connections_error.is_some());
        std::fs::write(dir.join(FILE), "{}").unwrap();
        assert_eq!(AppConfig::load(&dir), fresh());
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
        assert_eq!(AppConfig::load(&dir), fresh(), "a mistyped value gives the defaults");
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
    fn a_file_that_isnt_json_is_copied_and_never_replaced() {
        let dir = scratch("garbage");
        std::fs::write(dir.join(FILE), "{ nope").unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some());
        assert_eq!(std::fs::read_to_string(dir.join(BACKUP)).unwrap(), "{ nope");
        assert!(loaded.save(&dir).is_err());
        assert!(AppConfig::update(&dir, |c| c.agents.max_runs = 5).is_err());
        assert!(AppConfig::update_if(&dir, |_| true).is_err());
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), "{ nope");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_that_isnt_utf8_is_copied_byte_for_byte_and_never_replaced() {
        let dir = scratch("latin1");
        let bytes = b"{\"version\":1,\"connections\":[{\"displayName\":\"Caf\xe9\"}]}".to_vec();
        std::fs::write(dir.join(FILE), &bytes).unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some());
        assert_eq!(std::fs::read(dir.join(BACKUP)).unwrap(), bytes);
        assert!(AppConfig::update(&dir, |c| c.agents.max_runs = 5).is_err());
        assert_eq!(std::fs::read(dir.join(FILE)).unwrap(), bytes);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_that_cant_be_read_is_not_taken_for_a_missing_one() {
        let dir = scratch("unreadable");
        std::fs::create_dir(dir.join(FILE)).unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some());
        assert!(AppConfig::update(&dir, |c| c.agents.max_runs = 5).is_err());
        assert!(dir.join(FILE).is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_if_writes_only_when_the_change_says_so() {
        let dir = scratch("update-if");
        AppConfig::update_if(&dir, |_| false).unwrap();
        assert!(!dir.join(FILE).exists());
        AppConfig::update_if(&dir, |c| {
            c.agents.max_runs = 2;
            true
        })
        .unwrap();
        assert_eq!(AppConfig::load(&dir).agents.max_runs, 2);
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

    fn providers_in(dir: &Path) -> Vec<String> {
        AppConfig::load(dir).providers.into_iter().map(|p| p.id).collect()
    }

    fn saved_value(dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap()
    }

    #[test]
    fn a_missing_file_and_a_file_without_the_providers_key_start_with_the_default_claude() {
        let dir = scratch("providers-absent");
        std::fs::remove_file(dir.join(FILE)).ok();
        let loaded = AppConfig::load(&dir);
        assert_eq!((loaded.providers, loaded.providers_error), (vec![connections::default_claude()], None));
        std::fs::write(dir.join(FILE), format!("{{{INSTANCES}}}")).unwrap();
        assert_eq!(providers_in(&dir), ["claude"]);
        assert_eq!(AppConfig::load(&dir).connections.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_empty_providers_list_means_they_were_all_removed_and_stays_empty() {
        let dir = scratch("providers-empty");
        std::fs::write(dir.join(FILE), r#"{"providers":[]}"#).unwrap();
        assert!(providers_in(&dir).is_empty());
        AppConfig::update(&dir, |c| c.agents.max_runs = 2).unwrap();
        assert_eq!(saved_value(&dir)["providers"], serde_json::json!([]));
        assert!(providers_in(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_saved_by_a_build_that_predates_providers_gets_the_default_claude_back_and_keeps_its_connections() {
        let dir = scratch("providers-older-build");
        let providers = r#""providers":[{"id":"claude_2","driver":"claude","displayName":"Personal","enabled":true,"config":{"configDir":"~/.claude-personal"}}]"#;
        std::fs::write(dir.join(FILE), format!("{{{INSTANCES},{providers}}}")).unwrap();
        assert_eq!(providers_in(&dir), ["claude_2"]);
        let without = format!("{{{INSTANCES}}}");
        std::fs::write(dir.join(FILE), &without).unwrap();
        let loaded = AppConfig::load(&dir);
        assert_eq!((loaded.version, loaded.connections.len(), loaded.providers.len()), (1, 1, 1));
        assert_eq!(loaded.providers[0].id, "claude");
        assert_eq!(loaded.providers[0].config.config_dir, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_retired_claude_is_not_added_again() {
        let dir = scratch("providers-retired");
        std::fs::write(dir.join(FILE), r#"{"version":1,"connections":[],"retiredIds":["claude"]}"#).unwrap();
        assert!(providers_in(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn providers_round_trip_with_their_folder_and_beside_the_connections() {
        let dir = scratch("providers-round-trip");
        std::fs::write(dir.join(FILE), format!("{{{INSTANCES}}}")).unwrap();
        AppConfig::update(&dir, |c| {
            c.providers.push(connections::ProviderInstance {
                id: "codex".into(),
                driver: connections::Driver::Codex,
                display_name: "Codex work".into(),
                enabled: false,
                config: connections::ProviderConfig { config_dir: Some("~/.codex-work".into()), ..Default::default() },
                extra: Default::default(),
            });
        })
        .unwrap();
        let again = AppConfig::load(&dir);
        assert_eq!(again.providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["claude", "codex"]);
        let saved = saved_value(&dir);
        assert_eq!(saved["providers"][1], serde_json::json!({ "id": "codex", "driver": "codex", "displayName": "Codex work", "enabled": false, "config": { "configDir": "~/.codex-work" } }));
        assert_eq!(saved["providers"][0]["config"], serde_json::json!({}));
        assert_eq!((saved["version"].clone(), again.connections.len()), (1.into(), 1));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_providers_list_that_cant_be_read_is_kept_copied_and_reported_while_the_connections_still_load() {
        for (name, providers) in [
            ("driver", r#"[{"id":"x","driver":"gemini","displayName":"X","enabled":true,"config":{}}]"#),
            ("shape", r#"{"claude":true}"#),
            ("field", r#"[{"id":"claude","driver":"claude","enabled":true,"config":{}}]"#),
            ("connection", r#"[{"id":"github","driver":"claude","displayName":"A","enabled":true,"config":{}}]"#),
            ("retired", r#"[{"id":"github_2","driver":"claude","displayName":"A","enabled":true,"config":{}}]"#),
            ("twice", r#"[{"id":"claude","driver":"claude","displayName":"A","enabled":true,"config":{}},{"id":"claude","driver":"codex","displayName":"B","enabled":true,"config":{}}]"#),
        ] {
            let dir = scratch(&format!("providers-broken-{name}"));
            let text = format!(r#"{{{INSTANCES},"agents":{{"maxRuns":2}},"providers":{providers}}}"#);
            std::fs::write(dir.join(FILE), &text).unwrap();
            let loaded = AppConfig::load(&dir);
            assert!(loaded.providers_error.as_deref().is_some_and(|e| e.contains("config.json.bak")), "{name}: {:?}", loaded.providers_error);
            assert_eq!((loaded.providers.len(), loaded.connections.len(), loaded.connections_error.clone(), loaded.agents.max_runs), (0, 1, None, 2), "{name}");
            assert_eq!(std::fs::read_to_string(dir.join(BACKUP)).unwrap(), text);
            AppConfig::update(&dir, |c| c.agents.max_runs = 5).unwrap();
            let saved = saved_value(&dir);
            assert_eq!(saved["providers"], serde_json::from_str::<Value>(providers).unwrap(), "{name}");
            assert_eq!((saved["agents"]["maxRuns"].clone(), saved["connections"].as_array().map(Vec::len)), (5.into(), Some(1)), "{name}");
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[test]
    fn keys_a_later_build_added_to_a_provider_survive_a_change_made_here() {
        let dir = scratch("providers-unknown-keys");
        let providers = serde_json::json!([{ "id": "claude", "driver": "claude", "displayName": "Claude", "enabled": true, "accentColor": "teal", "config": { "configDir": "~/.claude-work", "customModels": ["fable-x"] } }]);
        std::fs::write(dir.join(FILE), format!(r#"{{{INSTANCES},"providers":{providers}}}"#)).unwrap();
        AppConfig::update(&dir, |c| {
            c.providers[0].display_name = "Work".into();
            c.agents.max_runs = 3;
        })
        .unwrap();
        let saved = saved_value(&dir)["providers"][0].clone();
        assert_eq!((saved["displayName"].clone(), saved["accentColor"].clone(), saved["config"]["customModels"].clone()), ("Work".into(), "teal".into(), serde_json::json!(["fable-x"])));
        assert_eq!(saved["config"]["configDir"], "~/.claude-work");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn providers_are_written_back_word_for_word_while_the_connections_come_from_a_newer_build() {
        let dir = scratch("providers-newer-file");
        let providers = serde_json::json!([{ "id": "claude", "driver": "claude", "displayName": "Claude", "enabled": true, "environment": {"A": "b"}, "config": { "customModels": ["fable-x"] } }]);
        std::fs::write(dir.join(FILE), serde_json::json!({ "version": 2, "connections": [], "providers": providers }).to_string()).unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some() && loaded.providers_error.is_none());
        AppConfig::update(&dir, |c| c.agents.max_runs = 4).unwrap();
        assert_eq!(saved_value(&dir)["providers"], providers);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_connections_list_that_cant_be_read_gets_no_default_claude_and_no_providers_key_is_written() {
        let dir = scratch("providers-withheld");
        std::fs::write(dir.join(FILE), r#"{"version":1,"connections":[{"id":"github","kind":"gitlab"}],"retiredIds":["claude"]}"#).unwrap();
        let loaded = AppConfig::load(&dir);
        assert!(loaded.connections_error.is_some() && loaded.providers.is_empty());
        AppConfig::update(&dir, |c| c.agents.max_runs = 4).unwrap();
        assert!(saved_value(&dir).get("providers").is_none());
        std::fs::write(dir.join(FILE), r#"{"version":1,"connections":[],"retiredIds":[]}"#).unwrap();
        assert_eq!(providers_in(&dir), ["claude"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
