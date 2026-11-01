//! Core's side of model lists and the Settings defaults, both kept in `config.json`.

use super::instances::not_a_provider;
use super::Core;
use crate::config::AppConfig;
use crate::connections;
use crate::error::{Error, Result};
use crate::model_choice::{self, ModelDefaults, ModelOption, Use};

impl Core {
    /// The models an instance offers, in the order a picker shows them.
    pub fn provider_models(&self, instance_id: &str) -> Result<Vec<ModelOption>> {
        let config = AppConfig::load(&self.data_dir);
        let provider = config.providers.iter().find(|p| p.id == instance_id).ok_or_else(not_a_provider)?;
        Ok(model_choice::model_list(provider))
    }

    /// Adds a model id to an instance's list, so a model released under a new name can be used without a new Gossamr.
    pub fn provider_add_model(&self, instance_id: &str, model: &str) -> Result<Vec<ModelOption>> {
        let mut outcome: Option<std::result::Result<Vec<ModelOption>, String>> = None;
        AppConfig::update_if(&self.data_dir, |config| {
            let Some(provider) = connections::provider_mut(config, instance_id) else { return false };
            outcome = Some(model_choice::add_custom_model(provider, model).map(|()| model_choice::model_list(provider)));
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
        AppConfig::update_if(&self.data_dir, |config| {
            if !connections::providers_live(config) {
                refusal = Some(not_a_provider());
                return false;
            }
            for (use_, choice) in [(Use::Pip, &set.pip), (Use::Agents, &set.agents)] {
                let Some(choice) = choice else { continue };
                if let Err(reason) = model_choice::check_choice(config, use_, choice) {
                    let name = config.providers.iter().find(|p| p.id == choice.instance_id).map_or(choice.instance_id.as_str(), |p| p.display_name.as_str());
                    refusal = Some(Error::Input(reason.words(use_, name)));
                    return false;
                }
            }
            config.models = set.clone();
            true
        })?;
        refusal.map_or(Ok(set), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_choice::ModelChoice;

    fn pick(instance: &str, model: &str) -> ModelChoice {
        ModelChoice { instance_id: instance.into(), model: model.into(), effort: None }
    }

    fn second_claude(fx: &crate::inbox::testing::Fixture) {
        AppConfig::update(&fx.core.data_dir(), |config| config.providers.push(connections::ProviderInstance { id: "claude_2".into(), display_name: "Claude personal".into(), ..connections::default_claude() })).unwrap();
    }

    #[tokio::test]
    async fn an_added_model_joins_that_instances_list_only_and_survives_a_restart() {
        let fx = crate::inbox::testing::fixture().await;
        second_claude(&fx);
        let list = fx.core.provider_add_model("claude_2", "claude-opus-5-5[1m]").unwrap();
        assert_eq!(list.last().map(|m| m.id.as_str()), Some("claude-opus-5-5[1m]"));
        assert_eq!(fx.core.provider_models("claude_2").unwrap(), list);
        assert_eq!(fx.core.provider_models("claude").unwrap().len(), 5);
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
            assert!(matches!(fx.core.provider_models(id), Err(Error::Input(_))), "{id}");
            assert!(matches!(fx.core.provider_add_model(id, "opus"), Err(Error::Input(_))), "{id}");
        }
    }

    #[tokio::test]
    async fn the_defaults_start_as_documented_and_a_saved_change_is_read_back() {
        let fx = crate::inbox::testing::fixture().await;
        second_claude(&fx);
        assert_eq!(fx.core.model_defaults(None).unwrap(), ModelDefaults::default());
        let chosen = ModelDefaults { pip: Some(ModelChoice { effort: Some("high".into()), ..pick("claude_2", "opus") }), agents: Some(pick("claude_2", "default")) };
        assert_eq!(fx.core.model_defaults(Some(chosen.clone())).unwrap(), chosen);
        assert_eq!(fx.core.model_defaults(None).unwrap(), chosen);
    }

    #[tokio::test]
    async fn a_default_that_could_not_run_is_refused_and_the_old_one_stays() {
        let fx = crate::inbox::testing::fixture().await;
        let before = fx.core.model_defaults(None).unwrap();
        for (pip, agents) in [(pick("claude", "default"), pick("claude", "default")), (pick("gone", "sonnet"), pick("claude", "default")), (pick("claude", "sonnet"), pick("claude", "--model"))] {
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
        fx.core.provider_remove("claude_2").unwrap();
        assert_eq!(fx.core.model_defaults(None).unwrap(), ModelDefaults { pip: None, agents: Some(pick("claude", "default")) });
    }
}
