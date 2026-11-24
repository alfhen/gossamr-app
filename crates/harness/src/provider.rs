//! The coding CLIs the harness can run, and a login of one: which program, and the variables that choose its account.

/// A coding CLI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
        }
    }

    pub fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// The variable that points the CLI at its login folder.
    pub fn folder_variable(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CONFIG_DIR",
            Self::Codex => "CODEX_HOME",
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
        }
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
