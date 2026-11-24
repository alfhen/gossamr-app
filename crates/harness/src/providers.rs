//! `harness providers`: how each login of the provider table stands, asked of its CLI's own status command. No
//! credential file is opened.

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};

use crate::binary::CliPlaces;
use crate::codex_models;
use crate::provider::{ModelOption, Provider};
use crate::provider_folder::expand;
use crate::provider_probe::{Folder, Snapshot, State, Timeouts, error, probe};
use crate::work::Setup;

/// A login to check: a provider's usual setup when `folder` is None.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asked {
    pub provider: String,
    #[serde(default)]
    pub folder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Standing {
    pub provider: String,
    /// The login folder as asked; None is the usual setup.
    pub folder: Option<String>,
    pub installed: bool,
    pub version: Option<String>,
    /// `ready`, `not_signed_in`, `not_found` or `error`.
    pub state: String,
    pub account: Option<String>,
    pub message: String,
    /// What to run to sign in, when that is the fix.
    pub fix: Option<String>,
    pub models: Vec<ModelOption>,
}

/// The usual setup of every provider of the table, then each of `extra`, in that order.
pub fn with_usual(extra: Vec<Asked>) -> Vec<Asked> {
    Provider::ALL.iter().map(|p| Asked { provider: p.name().into(), folder: None }).chain(extra).collect()
}

/// Checks every login at once.
pub async fn check(setup: &Setup, places: &CliPlaces, asked: &[Asked]) -> Vec<Standing> {
    join_all(asked.iter().map(|login| one(setup, places, login))).await
}

async fn one(setup: &Setup, places: &CliPlaces, asked: &Asked) -> Standing {
    let Some(provider) = Provider::named(&asked.provider) else {
        return standing(asked, error(format!("{} isn't a provider the harness knows", asked.provider)), Vec::new());
    };
    let env = match setup.agent_env(provider.name(), asked.folder.as_deref()) {
        Ok(env) => env,
        Err(why) => return standing(asked, error(why.to_string()), provider.models(None)),
    };
    let binary = places.find(provider, &env);
    let path = asked.folder.as_deref().zip(setup.home()).map(|(typed, home)| expand(typed, home));
    let folder = asked.folder.as_deref().zip(path.as_deref()).map(|(typed, path)| Folder { typed, path });
    let seen = probe(provider, binary.as_deref(), folder, &env, Timeouts::default()).await;
    let listed = match (&binary, seen.state) {
        (Some(binary), State::Ready) if provider.lists_models() => codex_models::discover(binary, &env).await,
        _ => None,
    };
    standing(asked, seen, provider.models(listed.as_deref()))
}

fn standing(asked: &Asked, seen: Snapshot, models: Vec<ModelOption>) -> Standing {
    let state = match seen.state {
        State::Ready => "ready",
        State::NotSignedIn => "not_signed_in",
        State::NotFound => "not_found",
        State::Error => "error",
        State::Off => "off",
    };
    Standing {
        provider: asked.provider.clone(),
        folder: asked.folder.clone(),
        installed: seen.installed,
        version: seen.version,
        state: state.into(),
        account: seen.account,
        message: seen.message,
        fix: seen.fix,
        models,
    }
}

/// One line for a person: provider, login, version, state and message, and the models.
pub fn line(standing: &Standing) -> String {
    let models: Vec<&str> = standing.models.iter().map(|m| m.id.as_str()).collect();
    format!(
        "{} {} {} {}: {} [models: {}]",
        standing.provider,
        standing.folder.as_deref().unwrap_or("(usual setup)"),
        standing.version.as_deref().unwrap_or("-"),
        standing.state,
        standing.message,
        models.join(", ")
    )
}
