//! App-level settings, kept in `config.json` beside the databases.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::workstream::{Rule, Workstream};
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
const MAX_MANAGER_TURNS: u32 = 500;

/// The global switches for the auto-start rules (`agent/autostart.rs`). A workstream can override each one. They are on
/// by default (open question 3): the read-only steps they start (Triage, Plan, Review, Verify) are launched with a
/// restriction Claude Code itself enforces since Phase 6 (`domain::READ_ONLY_MODE`), and they apply only in a workstream
/// the person has put in Manage mode; a new workstream opens in Advise.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoStartSwitches {
    pub investigate_triage: bool,
    pub triage_plan: bool,
    pub plan_build: bool,
    pub build_review: bool,
    pub fix_round: bool,
    /// A Verify after a passing review. Off until the person turns it on.
    pub review_verify: bool,
}

impl Default for AutoStartSwitches {
    fn default() -> Self {
        Self { investigate_triage: true, triage_plan: true, plan_build: true, build_review: true, fix_round: true, review_verify: false }
    }
}

impl AutoStartSwitches {
    pub fn get(&self, rule: Rule) -> bool {
        match rule {
            Rule::InvestigateTriage => self.investigate_triage,
            Rule::TriagePlan => self.triage_plan,
            Rule::PlanBuild => self.plan_build,
            Rule::BuildReview => self.build_review,
            Rule::FixRound => self.fix_round,
            Rule::ReviewVerify => self.review_verify,
        }
    }
}

/// Whether auto-start `rule` applies in `ws`: its own switch when it has one, else the global one.
pub fn rule_on(settings: &AgentSettings, ws: &Workstream, rule: Rule) -> bool {
    ws.rules.get(rule).unwrap_or_else(|| settings.autostart.get(rule))
}

/// Whether auto-start `rule` may start a step in `ws` now: the workstream starts steps on its own
/// (`workstream::starts_steps`) and the rule is on. Checked when a rule decides, and again where the step is started,
/// sent or launched, since the person may hold, advise or switch the rule off in between.
pub fn rule_runs(settings: &AgentSettings, ws: &Workstream, rule: Rule) -> bool {
    crate::domain::workstream::starts_steps(ws) && rule_on(settings, ws, rule)
}

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
    /// Offer new runs the run-report tool, through which an agent hands Gossamr its result as data. Off until tried.
    pub report_result: bool,
    /// Which routine handoffs start on their own in a workstream Pip manages.
    pub autostart: AutoStartSwitches,
    /// Pip turns the supervisor may start in a day across every workstream, counted from UTC midnight. Zero is no daily
    /// limit; each workstream's own budget still holds.
    pub manager_turns_per_day: u32,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            max_runs: 3,
            wall_clock_minutes: 60,
            token_cap: 3_000_000,
            terminal: TerminalChoice::Terminal,
            draft_on_finish: true,
            report_result: false,
            autostart: AutoStartSwitches::default(),
            manager_turns_per_day: 40,
        }
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
            report_result: self.report_result,
            autostart: self.autostart,
            manager_turns_per_day: self.manager_turns_per_day.min(MAX_MANAGER_TURNS),
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
        assert_eq!(AppConfig::load(&dir).agents, AgentSettings { max_runs: 3, wall_clock_minutes: 60, token_cap: 3_000_000, terminal: TerminalChoice::Terminal, draft_on_finish: true, report_result: false, autostart: AutoStartSwitches::default(), manager_turns_per_day: 40 });
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
    fn an_older_config_gets_the_auto_start_defaults_and_the_daily_cap_is_clamped() {
        let dir = std::env::temp_dir().join(format!("gossamr-config-autostart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"agentsEnabled":true,"agents":{"maxRuns":2,"draftOnFinish":false,"reportResult":true}}"#).unwrap();
        let older = AppConfig::load(&dir).agents;
        assert_eq!((older.max_runs, older.draft_on_finish, older.report_result), (2, false, true));
        assert_eq!((older.autostart, older.manager_turns_per_day), (AutoStartSwitches::default(), 40));
        assert!(Rule::ALL.iter().all(|r| older.autostart.get(*r) == (*r != Rule::ReviewVerify)), "every rule but Verify is on");

        std::fs::write(dir.join(FILE), r#"{"agents":{"autostart":{"triagePlan":false},"managerTurnsPerDay":9999}}"#).unwrap();
        let loaded = AppConfig::load(&dir).agents;
        assert_eq!(loaded.autostart, AutoStartSwitches { triage_plan: false, ..AutoStartSwitches::default() }, "an unnamed switch keeps its default");
        assert_eq!(loaded.manager_turns_per_day, MAX_MANAGER_TURNS);
        std::fs::write(dir.join(FILE), r#"{"agents":{"managerTurnsPerDay":0}}"#).unwrap();
        assert_eq!(AppConfig::load(&dir).agents.manager_turns_per_day, 0, "zero turns the cap off");

        let chosen = AppConfig { agents: AgentSettings { autostart: AutoStartSwitches { review_verify: true, fix_round: false, ..Default::default() }, manager_turns_per_day: 7, ..AgentSettings::default() }, ..AppConfig::default() };
        chosen.save(&dir).unwrap();
        assert_eq!(AppConfig::load(&dir), chosen);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_workstream_s_own_switch_wins_over_the_global_one() {
        let mut ws: Workstream = serde_json::from_value(serde_json::json!({ "id": "w1", "connectionId": "c", "title": "t", "createdAt": "2026-09-29T10:00:00Z" })).unwrap();
        let settings = AgentSettings::default();
        assert!(rule_on(&settings, &ws, Rule::TriagePlan));
        assert!(!rule_on(&settings, &ws, Rule::ReviewVerify), "Verify is off by default");
        ws.rules.set(Rule::TriagePlan, Some(false));
        ws.rules.set(Rule::ReviewVerify, Some(true));
        assert!(!rule_on(&settings, &ws, Rule::TriagePlan));
        assert!(rule_on(&settings, &ws, Rule::ReviewVerify));
        let off = AgentSettings { autostart: AutoStartSwitches { investigate_triage: false, triage_plan: false, ..Default::default() }, ..settings };
        assert!(!rule_on(&off, &ws, Rule::InvestigateTriage), "the global switch decides a rule the workstream doesn't name");
        ws.rules.set(Rule::InvestigateTriage, Some(true));
        assert!(rule_on(&off, &ws, Rule::InvestigateTriage));
        ws.rules.set(Rule::InvestigateTriage, None);
        assert!(!rule_on(&off, &ws, Rule::InvestigateTriage), "inheriting again");
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
