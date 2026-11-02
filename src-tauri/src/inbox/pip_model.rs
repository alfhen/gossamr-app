//! Core's side of which instance and model Pip's turns run on: the choice a turn takes, the check that it can run now,
//! and the launch it gives the provider.

use std::path::PathBuf;

use super::Core;
use crate::auth::Scope;
use crate::claude::Launch;
use crate::config::AppConfig;
use crate::error::{Error, Result};
use crate::model_choice::{self, ModelChoice, Resolution, Standing, Use};
use crate::runs::env::RunEnv;
use crate::runs::provider_env::{states, ProviderState, Unavailable};
use crate::runs::provider_folder::Places;

/// What a Pip turn runs at when its choice names no effort, so the CLI's own, costlier default is never used.
const DEFAULT_EFFORT: &str = "medium";

impl Core {
    /// The choice a turn of `conversation` takes: the one the page sent, else the one the conversation's last turn ran
    /// with, else the Settings default.
    pub async fn pip_choice(&self, conversation: &str, asked: Option<ModelChoice>) -> Result<Option<ModelChoice>> {
        if asked.is_some() {
            return Ok(asked);
        }
        let conversation = crate::agent::conversation_id(conversation);
        let last = self.with_app_db(|db| db.last_pip_model(&conversation)).await?;
        Ok(last.or_else(|| AppConfig::load(&self.data_dir).models.pip))
    }

    /// Keeps `choice` with turn `request_id` when it names a listed model on a Claude instance. A choice that fails that
    /// is never kept, so a conversation can't hand a page's made-up string back to it as the last choice.
    pub async fn pip_turn_model(&self, scope: &Scope, request_id: &str, choice: &ModelChoice) -> Result<()> {
        if model_choice::check_choice(&AppConfig::load(&self.data_dir), Use::Pip, choice).is_err() {
            return Ok(());
        }
        self.with_app_db_for(scope, |db| db.set_pip_turn_model(request_id, choice)).await
    }

    /// The instance and launch for a Pip turn on `choice`, or the words that say why it can't. It never falls back to another instance.
    /// `find` looks for the instance's binary on the shell's PATH.
    pub async fn pip_launch(&self, choice: Option<&ModelChoice>, find: impl Fn(&RunEnv) -> Option<PathBuf>) -> Result<(String, Launch)> {
        let config = AppConfig::load(&self.data_dir);
        if let Some(problem) = config.providers_error.as_ref().or(config.connections_error.as_ref()) {
            return Err(Error::Claude(format!("Pip can't tell which Claude to run on: {problem}")));
        }
        let shell = self.shell.get().await.inspect_err(|e| eprintln!("{e}")).ok();
        let places = Places { home: self.home.as_deref(), data_dir: &self.data_dir };
        let states = states(&config.providers, &places, shell.as_deref());
        let state_of = |id: &str| states.iter().find(|(i, _)| i == id).map(|(_, s)| s);
        let none = RunEnv::from_pairs::<&str, &str>([]);
        let binary = find(shell.as_deref().unwrap_or(&none));
        let standing = |p: &crate::connections::ProviderInstance| Standing {
            shell_readable: !matches!(state_of(&p.id), Some(ProviderState::Unavailable(Unavailable::NoShellSetup))),
            binary_found: binary.is_some(),
            // Until provider probes (step p3) answer, a login that has lapsed shows as the CLI's own error.
            signed_in: true,
        };
        match model_choice::resolve(&config, Use::Pip, choice, standing) {
            Resolution::Unavailable(reason) => {
                let name = choice
                    .or(config.models.pip.as_ref())
                    .and_then(|c| config.providers.iter().find(|p| p.id == c.instance_id))
                    .map_or("that instance", |p| p.display_name.as_str());
                Err(Error::Claude(reason.words(Use::Pip, name)))
            }
            Resolution::Ready { instance_id, model, effort } => match state_of(&instance_id) {
                Some(ProviderState::Ready(env)) => {
                    let effort = effort.or_else(|| Some(DEFAULT_EFFORT.to_string()));
                    let launch = Launch { binary: binary.expect("standing found it"), env: env.clone(), model, effort };
                    Ok((instance_id, launch))
                }
                Some(ProviderState::Error(problem)) => Err(Error::Claude(problem.clone())),
                _ => Err(Error::Claude(crate::model_choice::Reason::Removed.words(Use::Pip, &instance_id))),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::testing::fixture_with_shell;
    use crate::runs::env::ShellCapture;

    fn pick(model: &str) -> ModelChoice {
        ModelChoice { instance_id: "claude".into(), model: model.into(), effort: None }
    }

    #[tokio::test]
    async fn a_missing_binary_is_refused_as_not_installed_before_anything_starts() {
        let fx = fixture_with_shell(ShellCapture::with_env(RunEnv::from_pairs([("PATH", "/nowhere")]))).await;
        let refused = fx.core.pip_launch(Some(&pick("sonnet")), |_| None).await.unwrap_err();
        assert_eq!(refused.to_string(), "`claude` isn't installed.");
    }

    #[tokio::test]
    async fn the_binary_is_looked_for_on_the_shells_path() {
        let fx = fixture_with_shell(ShellCapture::with_env(RunEnv::from_pairs([("PATH", "/shell/bin")]))).await;
        let seen = std::sync::Mutex::new(None);
        let (instance, launch) = fx
            .core
            .pip_launch(Some(&pick("sonnet")), |env| {
                *seen.lock().unwrap() = env.get("PATH").map(|p| p.to_os_string());
                Some(PathBuf::from("/shell/bin/claude"))
            })
            .await
            .unwrap();
        assert_eq!((instance.as_str(), launch.binary, launch.model.as_deref()), ("claude", PathBuf::from("/shell/bin/claude"), Some("sonnet")));
        assert_eq!(seen.into_inner().unwrap().unwrap(), "/shell/bin");
    }

    #[tokio::test]
    async fn an_unreadable_providers_list_is_named_and_no_instance_is_guessed() {
        let fx = fixture_with_shell(ShellCapture::with_env(RunEnv::from_pairs([("PATH", "/p")]))).await;
        std::fs::write(fx.core.data_dir().join("config.json"), r#"{"version":3,"providers":"nonsense"}"#).unwrap();
        let refused = fx.core.pip_launch(Some(&pick("sonnet")), |_| Some(PathBuf::from("claude"))).await.unwrap_err().to_string();
        assert!(refused.starts_with("Pip can't tell which Claude to run on: "), "{refused}");
    }
}
