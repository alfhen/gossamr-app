//! The provider table: the coding CLIs the harness can run, each a row of code reviewed like code, and a login of one.

use serde::{Deserialize, Serialize};

/// A coding CLI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
}

/// What a model choice offers: the id passed to the CLI and the name shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

/// The model id that passes no model flag, so the login's own settings pick the model.
pub const DEFAULT_MODEL: &str = "default";
pub const MODEL_ID_LIMIT: usize = 100;

/// Used when `codex debug models` can't be read. Ids from the catalog of codex-cli 0.165.
const CODEX_FALLBACK: [(&str, &str); 4] = [("gpt-6.1-sol", "GPT-6.1-Sol"), ("gpt-6-sol", "GPT-6-Sol"), ("gpt-6-luna", "GPT-6-Luna"), ("gpt-5.5", "GPT-5.5")];

/// Letters, digits, `.`, `_`, `-`, `[` and `]`; starts with a letter or digit. The start rule keeps an id from reading as a flag.
pub fn valid_model_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= MODEL_ID_LIMIT
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '[' | ']'))
}

fn option(id: &str, label: &str) -> ModelOption {
    ModelOption { id: id.into(), label: label.into() }
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Gemini];

    /// The provider a session or a command line names, by `name`.
    pub fn named(name: &str) -> Option<Provider> {
        Self::ALL.into_iter().find(|p| p.name() == name)
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Gemini => "Gemini",
        }
    }

    pub fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "agy",
        }
    }

    /// The variable that points the CLI at its login folder. Gemini has none: `HOME` would separate its logins, but it
    /// also moves git, SSH and `gh` for the agent, so Gemini has one login until `--gemini-dir` is shown signed in.
    pub fn folder_variable(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("CLAUDE_CONFIG_DIR"),
            Self::Codex => Some("CODEX_HOME"),
            Self::Gemini => None,
        }
    }

    /// The variables that pick which account the CLI runs as, the folder variable first.
    pub fn login_variables(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[
                "CLAUDE_CONFIG_DIR",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_FEDERATION_RULE_ID",
                "ANTHROPIC_ORGANIZATION_ID",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
                "ANTHROPIC_FOUNDRY_API_KEY",
                "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
                "ANTHROPIC_FOUNDRY_RESOURCE",
                "ANTHROPIC_FOUNDRY_BASE_URL",
            ],
            Self::Codex => &["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
            Self::Gemini => &[],
        }
    }

    /// What a person runs to sign in to the usual login. `agy` signs in when it is first run.
    pub fn sign_in(self) -> &'static str {
        match self {
            Self::Claude => "claude auth login",
            Self::Codex => "codex login",
            Self::Gemini => "agy",
        }
    }

    /// How the harness drives it, as H0 decided.
    pub fn driver(self) -> &'static str {
        match self {
            Self::Claude => "claude -p, stream-json both ways",
            Self::Codex => "codex app-server",
            Self::Gemini => "agy acp",
        }
    }

    /// Whether its CLI lists the models a login offers (`codex debug models`).
    pub fn lists_models(self) -> bool {
        self == Self::Codex
    }

    /// The models to offer: Default, then what the login's CLI listed, or the built-in ones when it listed none.
    pub fn models(self, listed: Option<&[ModelOption]>) -> Vec<ModelOption> {
        let mut list = vec![option(DEFAULT_MODEL, "Default")];
        match (self, listed) {
            (Self::Claude, _) => list.extend([option("claude-fable-5-1", "Fable"), option("opus", "Opus"), option("sonnet", "Sonnet"), option("haiku", "Haiku")]),
            (Self::Codex, Some(listed)) => list.extend(listed.iter().cloned()),
            (Self::Codex, None) => list.extend(CODEX_FALLBACK.map(|(id, label)| option(id, label))),
            (Self::Gemini, _) => {}
        }
        list
    }
}

/// One login of a provider: its own folder, or the CLI's usual setup when `folder` is `None`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Login {
    pub id: String,
    pub provider: Provider,
    /// The name the person gave it, for messages.
    pub name: String,
    pub enabled: bool,
    /// The login folder as typed, `~` kept.
    pub folder: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_is_named_by_its_own_name_and_runs_its_own_program() {
        for provider in Provider::ALL {
            assert_eq!(Provider::named(provider.name()), Some(provider));
            assert!(provider.login_variables().first().copied() == provider.folder_variable() || provider.folder_variable().is_none());
        }
        assert_eq!(Provider::ALL.map(Provider::binary), ["claude", "codex", "agy"]);
        assert_eq!(Provider::named("mock"), None);
        assert_eq!(Provider::named("Claude"), None, "names are matched exactly");
    }

    #[test]
    fn models_start_with_default_and_codex_offers_what_its_cli_listed() {
        let listed = [option("gpt-7", "GPT-7")];
        assert_eq!(Provider::Codex.models(Some(&listed)).iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "gpt-7"]);
        assert_eq!(Provider::Codex.models(None).len(), 1 + CODEX_FALLBACK.len());
        assert_eq!(Provider::Claude.models(Some(&listed)).iter().filter(|m| m.id == "gpt-7").count(), 0, "Claude has no listing to take");
        assert_eq!(Provider::Gemini.models(None), [option(DEFAULT_MODEL, "Default")]);
        assert!(Provider::ALL.iter().all(|p| p.models(None).iter().all(|m| valid_model_id(&m.id))));
    }

    #[test]
    fn gemini_has_no_login_folder() {
        assert_eq!(Provider::Gemini.folder_variable(), None);
        assert!(Provider::Gemini.login_variables().is_empty());
        assert!(!Provider::Gemini.lists_models() && Provider::Codex.lists_models());
    }
}
