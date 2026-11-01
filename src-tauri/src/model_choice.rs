//! Which instance and model a piece of work runs on: the choice, each instance's model list, the Settings defaults, and
//! the resolver that says whether a choice can run now.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::config::AppConfig;
use crate::connections::{Driver, ProviderInstance};

/// "Default" passes no `--model`, so the login folder's own setting applies.
pub const DEFAULT_MODEL: &str = "default";
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const MODEL_ID_LIMIT: usize = 100;
const CUSTOM_MODEL_LIMIT: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub instance_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Use {
    Pip,
    Agents,
}

impl Use {
    fn allowed_on(self, driver: Driver) -> bool {
        match self {
            Self::Pip => driver.runs_pip(),
            Self::Agents => driver.runs_agents(),
        }
    }
}

fn option(id: &str, label: &str) -> ModelOption {
    ModelOption { id: id.into(), label: label.into() }
}

/// Letters, digits, `.`, `_`, `-`, `[` and `]`; starts with a letter or digit. The start rule keeps an id from reading as a flag.
pub fn valid_model_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= MODEL_ID_LIMIT
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '[' | ']'))
}

fn built_in(driver: Driver) -> Vec<ModelOption> {
    match driver {
        Driver::Claude => vec![option(DEFAULT_MODEL, "Default"), option("claude-fable-5-1", "Fable"), option("opus", "Opus"), option("sonnet", "Sonnet"), option("haiku", "Haiku")],
        Driver::Codex => Vec::new(),
    }
}

/// The instance's list: the driver's own, then the ids added to it. A hand-edited id that breaks the rule is left out.
pub fn model_list(provider: &ProviderInstance) -> Vec<ModelOption> {
    let mut list = built_in(provider.driver);
    for id in provider.config.custom_models.iter().filter(|id| valid_model_id(id)) {
        if !list.iter().any(|m| m.id.eq_ignore_ascii_case(id)) {
            list.push(option(id, id));
        }
    }
    list
}

/// Adds `model` to the instance's list. An id already listed, in any case, changes nothing.
pub fn add_custom_model(provider: &mut ProviderInstance, model: &str) -> Result<(), String> {
    if !valid_model_id(model) {
        return Err(format!("A model id uses letters, digits and . _ - [ ], starts with a letter or digit, and is at most {MODEL_ID_LIMIT} characters."));
    }
    if model_list(provider).iter().any(|m| m.id.eq_ignore_ascii_case(model)) {
        return Ok(());
    }
    if provider.config.custom_models.len() >= CUSTOM_MODEL_LIMIT {
        return Err(format!("Keep it to {CUSTOM_MODEL_LIMIT} added models. Remove one from config.json first."));
    }
    provider.config.custom_models.push(model.into());
    Ok(())
}

/// The Settings defaults. `None` is a default whose instance was removed, which the person has to pick again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelDefaults {
    pub pip: Option<ModelChoice>,
    pub agents: Option<ModelChoice>,
}

impl Default for ModelDefaults {
    fn default() -> Self {
        let choice = |model: &str, effort: Option<&str>| Some(ModelChoice { instance_id: crate::connections::DEFAULT_CLAUDE.into(), model: model.into(), effort: effort.map(Into::into) });
        Self { pip: choice("sonnet", Some("medium")), agents: choice(DEFAULT_MODEL, None) }
    }
}

impl ModelDefaults {
    pub fn clear_instance(&mut self, instance_id: &str) {
        for slot in [&mut self.pip, &mut self.agents] {
            if slot.as_ref().is_some_and(|c| c.instance_id == instance_id) {
                *slot = None;
            }
        }
    }

    pub fn for_use(&self, use_: Use) -> Option<&ModelChoice> {
        match use_ {
            Use::Pip => self.pip.as_ref(),
            Use::Agents => self.agents.as_ref(),
        }
    }
}

impl ModelDefaults {
    /// Reads the `models` value of `config.json`. A key that is absent keeps its default and a `null` stays cleared.
    /// A key that is there but unreadable is cleared, so the work asks to be picked again instead of running on another
    /// login, and its raw value is returned so a save can write it back.
    pub fn from_file(stored: Option<&Value>) -> (Self, Map<String, Value>) {
        let fallback = Self::default();
        let mut unreadable = Map::new();
        let mut read = |key: &str, fallback: Option<ModelChoice>| match stored.and_then(|s| s.get(key)) {
            None => fallback,
            Some(Value::Null) => None,
            Some(value) => serde_json::from_value(value.clone()).unwrap_or_else(|_| {
                unreadable.insert(key.into(), value.clone());
                None
            }),
        };
        let (pip, agents) = (read("pip", fallback.pip), read("agents", fallback.agents));
        (Self { pip, agents }, unreadable)
    }
}

/// What the page sends to `model_defaults`. Both keys are required (`null` clears one) and nothing is guessed for a
/// key that is missing or malformed, so the person's earlier choice is never swapped for a default they didn't pick.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelDefaultsSet {
    #[serde(deserialize_with = "required")]
    pub pip: Option<ModelChoice>,
    #[serde(deserialize_with = "required")]
    pub agents: Option<ModelChoice>,
}

fn required<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<ModelChoice>, D::Error> {
    Option::deserialize(deserializer)
}

impl From<ModelDefaultsSet> for ModelDefaults {
    fn from(set: ModelDefaultsSet) -> Self {
        Self { pip: set.pip, agents: set.agents }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Off,
    NotSignedIn,
    NotFound(Driver),
    NoShellSetup,
    Removed,
    CantRun(Driver),
    BadModel,
}

impl Reason {
    /// What Pip or the run says. `name` is the instance's name in Settings.
    pub fn words(self, use_: Use, name: &str) -> String {
        let pip = use_ == Use::Pip;
        match self {
            Self::Off if pip => format!("Pip runs on {name}, which is off. Turn it on in Settings or pick another."),
            Self::Off => format!("Waits for {name}, which is off."),
            Self::NotSignedIn if pip => format!("{name} isn't signed in. Sign in, then ask again."),
            Self::NotSignedIn => format!("Waits until {name} is signed in."),
            Self::NotFound(driver) => format!("`{}` isn't installed.", driver.binary()),
            Self::NoShellSetup => "Gossamr couldn't read your shell setup, so it can't tell which Claude login to use. Check again in Settings.".into(),
            Self::Removed if pip => "Pick which Claude Pip runs on.".into(),
            Self::Removed => format!("{name} was removed. Pick another."),
            Self::CantRun(driver) if pip => format!("Pip can't run on {} yet.", driver.label()),
            Self::CantRun(driver) => format!("Agents can't run on {} yet.", driver.label()),
            Self::BadModel if pip => "Pick a model for Pip.".into(),
            Self::BadModel => "Pick a model for this run.".into(),
        }
    }
}

/// What the probes and the shell capture know about an instance. The resolver asks; it never spawns anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Standing {
    pub shell_readable: bool,
    pub binary_found: bool,
    pub signed_in: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// `model` is `None` for "Default", which passes no `--model`.
    Ready { instance_id: String, model: Option<String>, effort: Option<String> },
    Unavailable(Reason),
}

/// Whether `choice` names a model the instance lists and, for Pip only, an effort from the fixed list, for a use its driver runs.
pub fn check_choice(config: &AppConfig, use_: Use, choice: &ModelChoice) -> Result<ProviderInstance, Reason> {
    let provider = config.providers.iter().find(|p| p.id == choice.instance_id).ok_or(Reason::Removed)?;
    if !use_.allowed_on(provider.driver) {
        return Err(Reason::CantRun(provider.driver));
    }
    let listed = model_list(provider).iter().any(|m| m.id == choice.model);
    let allowed_here = use_ == Use::Agents || choice.model != DEFAULT_MODEL;
    let effort_ok = choice.effort.as_deref().is_none_or(|e| use_ == Use::Pip && EFFORTS.contains(&e));
    if listed && allowed_here && effort_ok {
        Ok(provider.clone())
    } else {
        Err(Reason::BadModel)
    }
}

#[cfg_attr(not(test), expect(dead_code, reason = "Pip and the run launcher call the resolver once they run on a chosen instance"))]
/// `choice`, else the Settings default for `use_`. There is no fallback to another instance.
pub fn resolve(config: &AppConfig, use_: Use, choice: Option<&ModelChoice>, standing: impl Fn(&ProviderInstance) -> Standing) -> Resolution {
    let Some(choice) = choice.or_else(|| config.models.for_use(use_)) else { return Resolution::Unavailable(Reason::Removed) };
    let provider = match check_choice(config, use_, choice) {
        Ok(provider) => provider,
        Err(reason) => return Resolution::Unavailable(reason),
    };
    let blocked = if !provider.enabled {
        Some(Reason::Off)
    } else {
        let standing = standing(&provider);
        if !standing.shell_readable {
            Some(Reason::NoShellSetup)
        } else if !standing.binary_found {
            Some(Reason::NotFound(provider.driver))
        } else if !standing.signed_in {
            Some(Reason::NotSignedIn)
        } else {
            None
        }
    };
    match blocked {
        Some(reason) => Resolution::Unavailable(reason),
        None => Resolution::Ready { instance_id: provider.id, model: (choice.model != DEFAULT_MODEL).then(|| choice.model.clone()), effort: choice.effort.clone() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{default_claude, ProviderConfig};

    const READY: Standing = Standing { shell_readable: true, binary_found: true, signed_in: true };

    fn config() -> AppConfig {
        let personal = ProviderInstance { id: "claude_2".into(), display_name: "Claude personal".into(), config: ProviderConfig { custom_models: vec!["claude-opus-5-5[1m]".into()], ..Default::default() }, ..default_claude() };
        let mut config = AppConfig::default();
        config.providers.extend([default_claude(), personal]);
        config
    }

    fn pick(instance: &str, model: &str) -> ModelChoice {
        ModelChoice { instance_id: instance.into(), model: model.into(), effort: None }
    }

    fn resolve_with(config: &AppConfig, use_: Use, choice: &ModelChoice, standing: Standing) -> Resolution {
        resolve(config, use_, Some(choice), |_| standing)
    }

    fn reason(config: &AppConfig, use_: Use, choice: &ModelChoice, standing: Standing) -> Reason {
        match resolve_with(config, use_, choice, standing) {
            Resolution::Unavailable(reason) => reason,
            ready => panic!("expected a reason, got {ready:?}"),
        }
    }

    #[test]
    fn the_claude_list_is_default_fable_opus_sonnet_haiku_then_the_instances_own_models() {
        let config = config();
        let ids = |at: usize| model_list(&config.providers[at]).into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids(0), ["default", "claude-fable-5-1", "opus", "sonnet", "haiku"]);
        assert_eq!(ids(1), ["default", "claude-fable-5-1", "opus", "sonnet", "haiku", "claude-opus-5-5[1m]"]);
        assert_eq!(model_list(&config.providers[0])[1].label, "Fable");
    }

    #[test]
    fn a_model_id_starts_with_a_letter_or_digit_uses_a_short_alphabet_and_stops_at_100_characters() {
        for good in ["opus", "claude-opus-5-5[1m]", "gpt-5.1_mini", "4o", &"a".repeat(100)] {
            assert!(valid_model_id(good), "{good}");
        }
        for bad in ["", "-x", "--dangerously-skip-permissions", ".hidden", "[1m]", "two words", "a;b", "a$(id)", "a\nb", "é", &"a".repeat(101)] {
            assert!(!valid_model_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn adding_a_model_keeps_it_on_the_instance_and_adding_it_twice_changes_nothing() {
        let mut config = config();
        add_custom_model(&mut config.providers[0], "claude-sonnet-5-0").unwrap();
        add_custom_model(&mut config.providers[0], "claude-sonnet-5-0").unwrap();
        add_custom_model(&mut config.providers[0], "OPUS").unwrap();
        assert_eq!(config.providers[0].config.custom_models, ["claude-sonnet-5-0"]);
        assert_eq!(config.providers[1].config.custom_models, ["claude-opus-5-5[1m]"]);
        assert!(add_custom_model(&mut config.providers[0], "--model").is_err());
        assert!(add_custom_model(&mut config.providers[0], "x y").is_err());
    }

    #[test]
    fn the_list_of_added_models_has_a_limit() {
        let mut provider = default_claude();
        for n in 0..CUSTOM_MODEL_LIMIT {
            add_custom_model(&mut provider, &format!("m{n}")).unwrap();
        }
        assert!(add_custom_model(&mut provider, "one-more").is_err());
    }

    #[test]
    fn a_hand_edited_model_that_breaks_the_id_rule_is_not_in_the_list() {
        let mut provider = default_claude();
        provider.config.custom_models = vec!["--dangerously-skip-permissions".into(), "fine-1".into(), "a b".into()];
        let ids: Vec<_> = model_list(&provider).into_iter().map(|m| m.id).collect();
        assert_eq!(&ids[5..], ["fine-1"]);
    }

    #[test]
    fn a_choice_on_a_working_instance_is_ready_and_default_passes_no_model() {
        let config = config();
        let with_effort = ModelChoice { effort: Some("high".into()), ..pick("claude_2", "claude-opus-5-5[1m]") };
        assert_eq!(resolve_with(&config, Use::Pip, &with_effort, READY), Resolution::Ready { instance_id: "claude_2".into(), model: Some("claude-opus-5-5[1m]".into()), effort: Some("high".into()) });
        assert_eq!(resolve_with(&config, Use::Agents, &pick("claude", "default"), READY), Resolution::Ready { instance_id: "claude".into(), model: None, effort: None });
    }

    #[test]
    fn a_choice_that_names_no_instance_is_removed_and_says_which_to_pick() {
        let config = config();
        assert_eq!(reason(&config, Use::Pip, &pick("claude_9", "sonnet"), READY), Reason::Removed);
        assert_eq!(Reason::Removed.words(Use::Pip, "Claude personal"), "Pick which Claude Pip runs on.");
        assert_eq!(Reason::Removed.words(Use::Agents, "Claude personal"), "Claude personal was removed. Pick another.");
    }

    #[test]
    fn a_driver_that_cannot_run_the_use_is_cant_run() {
        let mut config = config();
        config.providers.push(ProviderInstance { id: "codex".into(), driver: Driver::Codex, ..default_claude() });
        for use_ in [Use::Pip, Use::Agents] {
            assert_eq!(reason(&config, use_, &pick("codex", "gpt-5"), READY), Reason::CantRun(Driver::Codex));
        }
        assert_eq!(Reason::CantRun(Driver::Codex).words(Use::Pip, "Codex"), "Pip can't run on Codex yet.");
        assert_eq!(Reason::CantRun(Driver::Codex).words(Use::Agents, "Codex"), "Agents can't run on Codex yet.");
    }

    #[test]
    fn an_instance_that_is_off_is_off_before_anything_else_about_it_is_asked() {
        let mut config = config();
        config.providers[1].enabled = false;
        let asked = std::cell::Cell::new(0);
        let choice = pick("claude_2", "sonnet");
        let resolution = resolve(&config, Use::Pip, Some(&choice), |_| {
            asked.set(asked.get() + 1);
            Standing { shell_readable: false, binary_found: false, signed_in: false }
        });
        assert_eq!((resolution, asked.get()), (Resolution::Unavailable(Reason::Off), 0));
        assert_eq!(Reason::Off.words(Use::Pip, "Claude personal"), "Pip runs on Claude personal, which is off. Turn it on in Settings or pick another.");
        assert_eq!(Reason::Off.words(Use::Agents, "Claude personal"), "Waits for Claude personal, which is off.");
    }

    #[test]
    fn an_unreadable_shell_setup_is_named_before_a_missing_binary_or_a_sign_in() {
        let config = config();
        let standing = Standing { shell_readable: false, binary_found: false, signed_in: false };
        assert_eq!(reason(&config, Use::Pip, &pick("claude", "sonnet"), standing), Reason::NoShellSetup);
        assert!(Reason::NoShellSetup.words(Use::Agents, "Claude").starts_with("Gossamr couldn't read your shell setup"));
    }

    #[test]
    fn a_missing_binary_is_not_found_and_names_the_binary() {
        let standing = Standing { binary_found: false, signed_in: false, ..READY };
        let reason = reason(&config(), Use::Agents, &pick("claude", "default"), standing);
        assert_eq!(reason, Reason::NotFound(Driver::Claude));
        assert_eq!(reason.words(Use::Agents, "Claude"), "`claude` isn't installed.");
    }

    #[test]
    fn a_signed_out_instance_is_not_signed_in_and_never_falls_back_to_another() {
        let config = config();
        let standing = |p: &ProviderInstance| Standing { signed_in: p.id == "claude", ..READY };
        let choice = pick("claude_2", "sonnet");
        assert_eq!(resolve(&config, Use::Pip, Some(&choice), standing), Resolution::Unavailable(Reason::NotSignedIn));
        assert_eq!(Reason::NotSignedIn.words(Use::Pip, "Claude personal"), "Claude personal isn't signed in. Sign in, then ask again.");
        assert_eq!(Reason::NotSignedIn.words(Use::Agents, "Claude personal"), "Waits until Claude personal is signed in.");
    }

    #[test]
    fn a_model_the_instance_does_not_list_is_a_bad_model() {
        let config = config();
        assert_eq!(reason(&config, Use::Pip, &pick("claude", "claude-opus-5-5[1m]"), READY), Reason::BadModel);
        assert_eq!(reason(&config, Use::Agents, &pick("claude", "gpt-5"), READY), Reason::BadModel);
        assert_eq!(Reason::BadModel.words(Use::Pip, "Claude"), "Pick a model for Pip.");
        assert_eq!(Reason::BadModel.words(Use::Agents, "Claude"), "Pick a model for this run.");
    }

    #[test]
    fn default_is_a_bad_model_for_pip_and_fine_for_agents() {
        let config = config();
        assert_eq!(reason(&config, Use::Pip, &pick("claude", "default"), READY), Reason::BadModel);
        assert!(matches!(resolve_with(&config, Use::Agents, &pick("claude", "default"), READY), Resolution::Ready { .. }));
    }

    #[test]
    fn an_effort_outside_the_fixed_list_is_a_bad_model() {
        let config = config();
        for effort in ["", "MEDIUM", "medium --dangerously-skip-permissions", "extreme"] {
            let choice = ModelChoice { effort: Some(effort.into()), ..pick("claude", "sonnet") };
            assert_eq!(reason(&config, Use::Pip, &choice, READY), Reason::BadModel, "{effort:?}");
        }
        for effort in EFFORTS {
            let choice = ModelChoice { effort: Some(effort.into()), ..pick("claude", "sonnet") };
            assert!(matches!(resolve_with(&config, Use::Pip, &choice, READY), Resolution::Ready { .. }), "{effort}");
        }
    }

    #[test]
    fn agents_take_no_effort() {
        let choice = ModelChoice { effort: Some("high".into()), ..pick("claude", "opus") };
        assert_eq!(reason(&config(), Use::Agents, &choice, READY), Reason::BadModel);
    }

    #[test]
    fn a_hostile_model_string_never_resolves() {
        let config = config();
        for hostile in ["--dangerously-skip-permissions", "sonnet --allowedTools Bash", "sonnet\n--model x", "sonnet; rm -rf ~", "$(id)", "Sonnet", " sonnet", "sonnet\0", "../../etc/passwd", &"a".repeat(5000)] {
            for use_ in [Use::Pip, Use::Agents] {
                assert_eq!(reason(&config, use_, &pick("claude", hostile), READY), Reason::BadModel, "{hostile:?}");
            }
        }
    }

    #[test]
    fn a_hostile_model_hand_edited_into_the_instances_list_is_still_not_accepted() {
        let mut config = config();
        config.providers[0].config.custom_models.push("--dangerously-skip-permissions".into());
        assert_eq!(reason(&config, Use::Agents, &pick("claude", "--dangerously-skip-permissions"), READY), Reason::BadModel);
    }

    #[test]
    fn no_choice_resolves_to_the_settings_default_and_a_cleared_default_is_removed() {
        let mut config = config();
        assert_eq!(resolve(&config, Use::Pip, None, |_| READY), Resolution::Ready { instance_id: "claude".into(), model: Some("sonnet".into()), effort: Some("medium".into()) });
        assert_eq!(resolve(&config, Use::Agents, None, |_| READY), Resolution::Ready { instance_id: "claude".into(), model: None, effort: None });
        config.models.clear_instance("claude");
        assert_eq!(resolve(&config, Use::Pip, None, |_| READY), Resolution::Unavailable(Reason::Removed));
    }

    #[test]
    fn the_defaults_are_sonnet_at_medium_for_pip_and_default_for_agents_both_on_claude() {
        let defaults = ModelDefaults::default();
        assert_eq!(serde_json::to_value(&defaults).unwrap(), serde_json::json!({ "pip": { "instanceId": "claude", "model": "sonnet", "effort": "medium" }, "agents": { "instanceId": "claude", "model": "default" } }));
    }

    #[test]
    fn defaults_read_back_as_written_and_an_unreadable_half_is_cleared_and_kept_aside() {
        let read = |json: &str| ModelDefaults::from_file(Some(&serde_json::from_str(json).unwrap()));
        let mine = ModelDefaults { pip: Some(pick("claude_2", "opus")), agents: None };
        assert_eq!(read(&serde_json::to_string(&mine).unwrap()), (mine, Map::new()));
        let (half, kept) = read(r#"{"pip":{"instanceId":"claude_2","model":{"id":"opus","ctx":"1m"}},"agents":{"instanceId":"claude_2","model":"haiku"}}"#);
        assert_eq!((half.pip, half.agents), (None, Some(pick("claude_2", "haiku"))));
        assert_eq!(kept.keys().collect::<Vec<_>>(), ["pip"]);
        assert_eq!(read("{}").0, ModelDefaults::default());
        assert_eq!(ModelDefaults::from_file(None).0, ModelDefaults::default());
        assert_eq!(read("5").0, ModelDefaults::default());
    }

    #[test]
    fn a_default_that_is_unreadable_is_never_resolved_onto_another_login() {
        let mut config = config();
        config.models = ModelDefaults::from_file(Some(&serde_json::json!({ "pip": { "instanceId": "claude_2", "model": 5 } }))).0;
        assert_eq!(resolve(&config, Use::Pip, None, |_| READY), Resolution::Unavailable(Reason::Removed));
    }

    #[test]
    fn what_the_page_sets_needs_both_keys_and_readable_choices() {
        let parse = |json: &str| serde_json::from_str::<ModelDefaultsSet>(json);
        let ok = parse(r#"{"pip":{"instanceId":"claude_2","model":"opus","effort":"high"},"agents":null}"#).unwrap();
        assert_eq!(ModelDefaults::from(ok), ModelDefaults { pip: Some(ModelChoice { effort: Some("high".into()), ..pick("claude_2", "opus") }), agents: None });
        for bad in [
            r#"{"agents":{"instanceId":"claude","model":"default"}}"#,
            r#"{"pip":{"instanceId":"claude_2","model":"opus"}}"#,
            r#"{"pip":{"instanceId":"claude_2","model":"opus","effort":3},"agents":null}"#,
            r#"{"pip":{"instanceId":"claude_2"},"agents":null}"#,
            r#"{"pip":null,"agents":null,"extra":1}"#,
            "{}",
            "5",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn removing_an_instance_clears_only_the_defaults_that_named_it() {
        let mut config = config();
        config.models = ModelDefaults { pip: Some(pick("claude_2", "opus")), agents: Some(pick("claude", "default")) };
        assert!(crate::connections::remove_provider(&mut config, "claude_2"));
        assert_eq!((config.models.pip, config.models.agents), (None, Some(pick("claude", "default"))));
    }
}
