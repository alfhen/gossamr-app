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

    /// The exact names a driver lets through without asking the person, for the session's tools endpoint `name` and
    /// its `tools`: each full tool name, or Codex's server key, which takes `default_tools_approval_mode` for that one
    /// server. Never a prefix or a wildcard (H0, R1).
    pub fn own_tool_names(self, name: &str, tools: &[String]) -> Vec<String> {
        match self {
            Self::Claude => tools.iter().map(|tool| format!("mcp__{name}__{tool}")).collect(),
            Self::Codex => vec![name.to_owned()],
            Self::Gemini => tools.iter().map(|tool| format!("mcp_{name}_{tool}")).collect(),
        }
    }

    /// How a call to the tools endpoint is made to outwait a question, as H0 found.
    pub fn tool_wait(self) -> ToolWait {
        match self {
            Self::Claude => ToolWait { setting: Some("`timeout` in ms on the server of the `mcp_set_servers` control request"), cut_without_ms: Some(60_000), limit_ms: None },
            Self::Codex => ToolWait { setting: Some("`mcp_servers.<name>.tool_timeout_sec` in the thread's config"), cut_without_ms: Some(300_000), limit_ms: None },
            Self::Gemini => ToolWait { setting: None, cut_without_ms: Some(180_000), limit_ms: Some(180_000) },
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

/// What makes a provider hold a tool call while a question waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolWait {
    /// The setting a driver gives; None where the path has none.
    pub setting: Option<&'static str>,
    /// Where the provider cut a call without the setting, if H0 saw it do so.
    pub cut_without_ms: Option<u64>,
    /// The provider's cut a call cannot outwait, where no setting lifts it: `ask` returns before it (H5b).
    pub limit_ms: Option<u64>,
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
    fn tools_endpoint_own_tool_names_are_exact_full_names_built_from_the_endpoint_name() {
        let tools = ["read_ticket".to_owned(), "result".to_owned()];
        assert_eq!(Provider::Claude.own_tool_names("k3x9", &tools), ["mcp__k3x9__read_ticket", "mcp__k3x9__result"]);
        assert_eq!(Provider::Codex.own_tool_names("k3x9", &tools), ["k3x9"], "Codex allows by server key");
        assert_eq!(Provider::Gemini.own_tool_names("k3x9", &tools), ["mcp_k3x9_read_ticket", "mcp_k3x9_result"]);
        for provider in Provider::ALL {
            let names = provider.own_tool_names("k3x9", &tools);
            assert!(names.iter().all(|name| !name.contains('*') && name.contains("k3x9")), "{names:?}");
            assert!(provider.own_tool_names("k3x9", &[]).len() <= 1, "no tools, nothing to allow but Codex's key");
        }
    }

    #[test]
    fn tools_endpoint_each_provider_names_the_setting_that_makes_a_call_outwait_a_question_or_its_limit() {
        for provider in Provider::ALL {
            let wait = provider.tool_wait();
            assert!(wait.setting.is_some() != wait.limit_ms.is_some(), "{provider:?}: a setting, or a limit where none lifts it");
        }
        assert_eq!(Provider::Gemini.tool_wait().limit_ms, Some(180_000), "agy cuts at 3 min with no setting");
        assert!(Provider::Claude.tool_wait().setting.is_some_and(|s| s.contains("timeout")));
        assert!(Provider::Codex.tool_wait().setting.is_some_and(|s| s.contains("tool_timeout_sec")));
        let cuts: Vec<Option<u64>> = Provider::ALL.iter().map(|p| p.tool_wait().cut_without_ms).collect();
        assert_eq!(cuts, [Some(60_000), Some(300_000), Some(180_000)], "where H0 saw each cut a call without the setting");
    }

    #[test]
    fn gemini_has_no_login_folder() {
        assert_eq!(Provider::Gemini.folder_variable(), None);
        assert!(Provider::Gemini.login_variables().is_empty());
        assert!(!Provider::Gemini.lists_models() && Provider::Codex.lists_models());
    }
}
