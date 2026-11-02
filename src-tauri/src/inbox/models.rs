//! Core's side of model lists and the Settings defaults, both kept in `config.json`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::instances::not_a_provider;
use super::Core;
use crate::config::AppConfig;
use crate::connections::{self, Driver, ProviderInstance};
use crate::error::{Error, Result};
use crate::model_choice::{self, Found, ModelChoice, ModelDefaults, ModelOption, Reason, Resolution, Standing, Use};
use crate::probe::State;
use crate::runs::binary::find_binary;
use crate::runs::codex_models;
use crate::runs::provider_env::ProviderState;

const FRESH_FOR: Duration = Duration::from_secs(10 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(60);

struct Asked {
    at: Instant,
    worked: bool,
    last_read: Option<Vec<ModelOption>>,
}

/// When each Codex instance's catalog was last asked for, and the last list that was read.
#[derive(Default)]
pub(super) struct Seen(Mutex<HashMap<String, Asked>>);

impl Seen {
    fn fresh(&self, id: &str) -> bool {
        self.0.lock().unwrap().get(id).is_some_and(|a| a.at.elapsed() < if a.worked { FRESH_FOR } else { RETRY_AFTER })
    }

    /// A failed ask keeps the last list that was read, so a flaky `codex` doesn't swap it for the built-in one.
    fn keep(&self, id: &str, models: Option<Vec<ModelOption>>) {
        let mut seen = self.0.lock().unwrap();
        let last_read = models.clone().or_else(|| seen.remove(id).and_then(|a| a.last_read));
        seen.insert(id.into(), Asked { at: Instant::now(), worked: models.is_some(), last_read });
    }

    pub(super) fn found(&self) -> Found {
        Found::new(self.0.lock().unwrap().iter().filter_map(|(id, a)| Some((id.clone(), a.last_read.clone()?))).collect())
    }
}

/// The instance `choice` names, or why it can't be used, in the words a person reads.
fn checked_words(config: &AppConfig, use_: Use, choice: &ModelChoice, found: &Found) -> std::result::Result<ProviderInstance, String> {
    model_choice::check_choice(config, use_, choice, found).map_err(|reason| {
        let name = config.providers.iter().find(|p| p.id == choice.instance_id).map_or("That instance", |p| p.display_name.as_str());
        reason.words(use_, name)
    })
}

fn checked(config: &AppConfig, use_: Use, choice: &ModelChoice, found: &Found) -> Result<ProviderInstance> {
    checked_words(config, use_, choice, found).map_err(Error::Input)
}

impl Core {
    /// Refuses a choice for agents that names no instance, a model it doesn't list, or an instance whose driver can't run agents.
    pub fn check_agents_choice(&self, choice: &ModelChoice) -> Result<()> {
        checked(&AppConfig::load(&self.data_dir), Use::Agents, choice, &self.codex_models.found()).map(drop)
    }

    /// The choice a run launches on, `stored` else the Settings default, and its instance; or the words a run waits with
    /// when the choice can't be used.
    pub fn agents_target(&self, stored: Option<&ModelChoice>) -> std::result::Result<(ModelChoice, ProviderInstance), String> {
        let config = AppConfig::load(&self.data_dir);
        let Some(choice) = stored.or(config.models.agents.as_ref()) else { return Err(Reason::Removed.words(Use::Agents, "That instance")) };
        match model_choice::resolve(&config, Use::Agents, Some(choice), &self.codex_models.found(), |p| self.agents_standing(p)) {
            Resolution::Unavailable(reason) => {
                let name = config.providers.iter().find(|p| p.id == choice.instance_id).map_or("That instance", |p| p.display_name.as_str());
                Err(reason.words(Use::Agents, name))
            }
            Resolution::Ready { instance_id, .. } => {
                let instance = config.providers.iter().find(|p| p.id == instance_id).expect("resolve found it").clone();
                Ok((choice.clone(), instance))
            }
        }
    }

    /// What the last probe says about the instance's login. An instance not asked yet counts as signed in, so the CLI's
    /// own answer at launch decides. A missing shell setup or `claude` is left to the toolchain, which has the words for it.
    fn agents_standing(&self, instance: &ProviderInstance) -> Standing {
        let signed_in = self.provider_snapshot_for(instance).is_none_or(|answer| answer.state != State::NotSignedIn);
        Standing { shell_readable: true, binary_found: true, signed_in }
    }

    /// The models an instance offers, in the order a picker shows them. A Codex instance that is on and ready is asked
    /// with `codex debug models`, at most once in ten minutes.
    pub async fn provider_models(&self, instance_id: &str) -> Result<Vec<ModelOption>> {
        let config = AppConfig::load(&self.data_dir);
        let provider = config.providers.iter().find(|p| p.id == instance_id).ok_or_else(not_a_provider)?;
        if provider.driver == Driver::Codex && !self.codex_models.fresh(instance_id) {
            let listed = self.ask_codex_models(instance_id).await;
            self.codex_models.keep(instance_id, listed);
        }
        Ok(model_choice::model_list(provider, &self.codex_models.found()))
    }

    /// Runs nothing for an instance that is off, in error or unavailable (6.5), and nothing without a `codex` to run.
    async fn ask_codex_models(&self, instance_id: &str) -> Option<Vec<ModelOption>> {
        let ProviderState::Ready(login) = self.provider_states().await.into_iter().find(|(id, _)| id == instance_id)?.1 else { return None };
        let shell = self.shell.get().await.ok()?;
        let on = shell.clone();
        let binary = tokio::task::spawn_blocking(move || find_binary(Driver::Codex, &on)).await.ok().flatten()?;
        codex_models::discover(&binary, &login.over(&shell)).await
    }

    /// Adds a model id to an instance's list, so a model released under a new name can be used without a new Gossamr.
    pub fn provider_add_model(&self, instance_id: &str, model: &str) -> Result<Vec<ModelOption>> {
        let mut outcome: Option<std::result::Result<Vec<ModelOption>, String>> = None;
        let found = self.codex_models.found();
        AppConfig::update_if(&self.data_dir, |config| {
            let Some(provider) = connections::provider_mut(config, instance_id) else { return false };
            outcome = Some(model_choice::add_custom_model(provider, model).map(|()| model_choice::model_list(provider, &found)));
            matches!(outcome, Some(Ok(_)))
        })?;
        match outcome {
            Some(Ok(list)) => Ok(list),
            Some(Err(problem)) => Err(Error::Input(problem)),
            None => Err(not_a_provider()),
        }
    }

    /// The Settings defaults. With `set`, saves them first, each checked as a run's choice would be; a `None` clears one.
    pub fn model_defaults(&self, set: Option<ModelDefaults>) -> Result<ModelDefaults> {
        let Some(set) = set else { return Ok(AppConfig::load(&self.data_dir).models) };
        let mut refusal = None;
        let found = self.codex_models.found();
        AppConfig::update_if(&self.data_dir, |config| {
            if config.providers_error.is_some() {
                refusal = Some(not_a_provider());
                return false;
            }
            for (use_, choice) in [(Use::Pip, &set.pip), (Use::Agents, &set.agents)] {
                let Some(choice) = choice else { continue };
                if let Err(e) = checked(config, use_, choice, &found) {
                    refusal = Some(e);
                    return false;
                }
            }
            config.set_models(set.clone());
            true
        })?;
        refusal.map_or(Ok(set), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::testing::fixture_with_shell;
    use crate::runs::env::ShellCapture;
    use std::os::unix::fs::PermissionsExt;

    fn pick(instance: &str, model: &str) -> ModelChoice {
        ModelChoice { instance_id: instance.into(), model: model.into(), effort: None }
    }

    fn second_claude(fx: &crate::inbox::testing::Fixture) {
        AppConfig::update(&fx.core.data_dir(), |config| config.providers.push(connections::ProviderInstance { id: "claude_2".into(), display_name: "Claude personal".into(), ..connections::default_claude() })).unwrap();
    }

    const CATALOG: &str = r#"{"models":[{"slug":"gpt-7","display_name":"GPT-7","visibility":"list","priority":1},{"slug":"gpt-6-luna","visibility":"list","priority":2},{"slug":"internal","visibility":"hide","priority":3}]}"#;

    /// A fixture whose captured shell has a `codex` on its PATH that prints `CATALOG` (or fails) and counts its runs.
    async fn with_codex(tag: &str, fails: bool) -> (crate::inbox::testing::Fixture, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("gossamr-core-codex-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let codex = dir.join("bin/codex");
        let body = if fails { "exit 1".to_string() } else { format!("cat <<'JSON'\n{CATALOG}\nJSON") };
        std::fs::write(&codex, format!("#!/bin/sh\necho run >> '{}'\n{body}\n", dir.join("runs").display())).unwrap();
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shell = dir.join("fakeshell");
        std::fs::write(&shell, format!("#!/bin/sh\nprintf '\\0GOSSAMR_ENV_BEGIN\\0PATH={}:/usr/bin:/bin\\0'\n", dir.join("bin").display())).unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let fx = fixture_with_shell(ShellCapture::with_shell(&shell.display().to_string())).await;
        AppConfig::update(&fx.core.data_dir(), |config| {
            config.providers.push(connections::ProviderInstance { id: "codex".into(), driver: connections::Driver::Codex, display_name: "Codex".into(), config: connections::ProviderConfig { config_dir: Some("~/.codex-work".into()), ..Default::default() }, ..connections::default_claude() });
        })
        .unwrap();
        (fx, dir)
    }

    fn runs(dir: &std::path::Path) -> usize {
        std::fs::read_to_string(dir.join("runs")).map_or(0, |s| s.lines().count())
    }

    fn ids(list: &[ModelOption]) -> Vec<&str> {
        list.iter().map(|m| m.id.as_str()).collect()
    }

    #[tokio::test]
    async fn a_ready_codex_instance_lists_what_its_cli_says_and_is_asked_once_in_ten_minutes() {
        let (fx, dir) = with_codex("lists", false).await;
        fx.core.provider_add_model("codex", "my-model").unwrap();
        let first = fx.core.provider_models("codex").await.unwrap();
        assert_eq!(ids(&first), ["default", "gpt-7", "gpt-6-luna", "my-model"]);
        assert_eq!(first[1].label, "GPT-7");
        assert_eq!(fx.core.provider_models("codex").await.unwrap(), first);
        assert_eq!(runs(&dir), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_model_added_while_the_cli_lists_it_is_saved_and_stays_after_the_list_is_lost() {
        let (fx, dir) = with_codex("added", false).await;
        let listed = fx.core.provider_models("codex").await.unwrap();
        assert!(ids(&listed).contains(&"gpt-7"));
        let after = fx.core.provider_add_model("codex", "gpt-7").unwrap();
        assert_eq!(ids(&after), ["default", "gpt-7", "gpt-6-luna"]);
        let saved = AppConfig::load(&fx.core.data_dir());
        assert_eq!(saved.providers.iter().find(|p| p.id == "codex").unwrap().config.custom_models, ["gpt-7"]);
        let provider = saved.providers.iter().find(|p| p.id == "codex").unwrap();
        assert!(ids(&model_choice::model_list(provider, &Found::default())).contains(&"gpt-7"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_codex_that_fails_leaves_the_built_in_list_and_is_not_asked_again_within_the_minute() {
        let (fx, dir) = with_codex("fails", true).await;
        let list = fx.core.provider_models("codex").await.unwrap();
        assert_eq!(ids(&list), ["default", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.5"]);
        fx.core.provider_models("codex").await.unwrap();
        assert_eq!(runs(&dir), 1, "a failure is not asked again within the minute");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_codex_instance_that_is_off_runs_nothing_and_claude_is_never_asked() {
        let (fx, dir) = with_codex("off", false).await;
        AppConfig::update(&fx.core.data_dir(), |config| connections::provider_mut(config, "codex").unwrap().enabled = false).unwrap();
        let list = fx.core.provider_models("codex").await.unwrap();
        assert_eq!(list.len(), 5);
        assert_eq!(fx.core.provider_models("claude").await.unwrap().len(), 5);
        assert_eq!(runs(&dir), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_ask_keeps_the_last_list_that_was_read_and_asks_again_sooner() {
        let seen = Seen::default();
        let list = vec![ModelOption { id: "gpt-7".into(), label: "GPT-7".into() }];
        seen.keep("codex", Some(list.clone()));
        assert!(seen.fresh("codex"));
        seen.keep("codex", None);
        assert_eq!(ids(&model_choice::model_list(&codex_instance(), &seen.found())), ["default", "gpt-7"]);
        assert!(seen.fresh("codex"), "just asked");
        assert!(!seen.fresh("codex_2"));
    }

    fn codex_instance() -> connections::ProviderInstance {
        connections::ProviderInstance { id: "codex".into(), driver: connections::Driver::Codex, ..connections::default_claude() }
    }

    #[tokio::test]
    async fn an_added_model_joins_that_instances_list_only_and_survives_a_restart() {
        let fx = crate::inbox::testing::fixture().await;
        second_claude(&fx);
        let list = fx.core.provider_add_model("claude_2", "claude-opus-5-5[1m]").unwrap();
        assert_eq!(list.last().map(|m| m.id.as_str()), Some("claude-opus-5-5[1m]"));
        assert_eq!(fx.core.provider_models("claude_2").await.unwrap(), list);
        assert_eq!(fx.core.provider_models("claude").await.unwrap().len(), 5);
        let saved = std::fs::read_to_string(fx.core.data_dir().join("config.json")).unwrap();
        assert!(saved.contains(r#""customModels""#), "{saved}");
    }

    #[tokio::test]
    async fn a_model_id_that_breaks_the_rule_is_refused_and_nothing_is_saved() {
        let fx = crate::inbox::testing::fixture().await;
        for hostile in ["--dangerously-skip-permissions", "a b", "", "x;y"] {
            assert!(matches!(fx.core.provider_add_model("claude", hostile), Err(Error::Input(_))), "{hostile:?}");
        }
        assert!(!fx.core.data_dir().join("config.json").exists());
    }

    #[tokio::test]
    async fn the_model_commands_refuse_an_id_that_is_not_a_provider() {
        let fx = crate::inbox::testing::fixture().await;
        for id in ["jira", "github", "nope"] {
            assert!(matches!(fx.core.provider_models(id).await, Err(Error::Input(_))), "{id}");
            assert!(matches!(fx.core.provider_add_model(id, "opus"), Err(Error::Input(_))), "{id}");
        }
    }

    #[tokio::test]
    async fn the_defaults_start_as_documented_and_a_saved_change_is_read_back() {
        let fx = crate::inbox::testing::fixture().await;
        second_claude(&fx);
        assert_eq!(fx.core.model_defaults(None).unwrap(), ModelDefaults::default());
        let chosen = ModelDefaults { pip: Some(ModelChoice { effort: Some("high".into()), ..pick("claude_2", "opus") }), agents: Some(pick("claude", "sonnet")) };
        assert_eq!(fx.core.model_defaults(Some(chosen.clone())).unwrap(), chosen);
        assert_eq!(fx.core.model_defaults(None).unwrap(), chosen);
    }

    #[tokio::test]
    async fn a_default_that_could_not_run_is_refused_and_the_old_one_stays() {
        let fx = crate::inbox::testing::fixture().await;
        let before = fx.core.model_defaults(None).unwrap();
        for (pip, agents) in [(pick("claude", "default"), pick("claude", "default")), (pick("gone", "sonnet"), pick("claude", "default")), (pick("claude", "sonnet"), pick("claude", "--model")), (pick("claude", "sonnet"), ModelChoice { effort: Some("high".into()), ..pick("claude", "opus") })] {
            let refused = fx.core.model_defaults(Some(ModelDefaults { pip: Some(pip), agents: Some(agents) }));
            assert!(matches!(refused, Err(Error::Input(_))), "{refused:?}");
        }
        assert_eq!(fx.core.model_defaults(None).unwrap(), before);
    }

    #[tokio::test]
    async fn removing_an_instance_clears_the_defaults_that_named_it_and_keeps_the_rest() {
        let fx = crate::inbox::testing::fixture().await;
        second_claude(&fx);
        fx.core.model_defaults(Some(ModelDefaults { pip: Some(pick("claude_2", "opus")), agents: Some(pick("claude", "default")) })).unwrap();
        fx.core.provider_remove("claude_2").await.unwrap();
        assert_eq!(fx.core.model_defaults(None).unwrap(), ModelDefaults { pip: None, agents: Some(pick("claude", "default")) });
    }

    #[tokio::test]
    async fn the_defaults_save_while_only_the_connections_list_is_unreadable() {
        let fx = crate::inbox::testing::fixture().await;
        let providers = serde_json::json!([{ "id": "claude", "driver": "claude", "displayName": "Claude", "enabled": true, "environment": {}, "config": {} }]);
        std::fs::write(fx.core.data_dir().join("config.json"), serde_json::json!({ "version": 2, "connections": [], "providers": providers }).to_string()).unwrap();
        let chosen = ModelDefaults { pip: Some(pick("claude", "opus")), agents: None };
        assert_eq!(fx.core.model_defaults(Some(chosen.clone())).unwrap(), chosen);
        assert_eq!(fx.core.model_defaults(None).unwrap(), chosen);
    }
}
