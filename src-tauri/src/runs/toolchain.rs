//! The `claude` command and the shell environment it runs in, found once and reused.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::binary::find_binary;
use super::cli::{ClaudeCli, SystemCli};
use super::env::RunEnv;
use super::provider_env::{ProviderEnv, ProviderState};
use crate::connections::{self, Driver};
use crate::inbox::Core;

#[derive(Clone)]
pub struct Toolchain {
    pub cli: Arc<dyn ClaudeCli>,
    /// The captured shell environment, without any instance's login: `git` and `gh` run in it.
    pub env: Arc<RunEnv>,
    pub instance_id: String,
    pub instance_name: String,
    /// Set for an instance with a folder, so the Terminal scripts run as its login too.
    pub login: Option<ProviderEnv>,
}

impl Toolchain {
    /// The default instance, with the login the shell has.
    pub fn new(cli: Arc<dyn ClaudeCli>, env: Arc<RunEnv>) -> Self {
        Self { cli, env, instance_id: connections::DEFAULT_CLAUDE.into(), instance_name: "Claude".into(), login: None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolchainError {
    ClaudeMissing { instance: String },
    /// The shell environment couldn't be read. Launching without it would hand the shared Claude daemon the app's
    /// own environment instead, so nothing is started.
    NoEnvironment(String),
    /// No instance has this id, or it was removed. Never answered with another instance's toolchain.
    UnknownInstance(String),
    /// The instance is off, in error, or can't run agents, in words for the person.
    Unusable(String),
}

#[async_trait]
pub trait ToolchainSource: Send + Sync {
    /// The default instance.
    async fn get(&self) -> Result<Toolchain, ToolchainError>;

    /// The toolchain of one provider instance. Until runs name an instance only tests call it.
    async fn for_instance(&self, id: &str) -> Result<Toolchain, ToolchainError>;
}

type Finder = fn(Driver, &RunEnv) -> Option<PathBuf>;

/// Finds `claude` on the shell environment `Core` captured, on first use. A failure is tried again next time, so
/// fixing the problem doesn't need a restart.
pub struct SystemToolchain {
    core: Arc<Core>,
    find: Finder,
    found: tokio::sync::Mutex<Option<Toolchain>>,
}

impl SystemToolchain {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core, find: find_binary, found: Default::default() }
    }

    #[cfg(test)]
    pub fn with_finder(mut self, find: Finder) -> Self {
        self.find = find;
        self
    }

    async fn build(&self, id: &str, name: &str, login: Option<ProviderEnv>) -> Result<Toolchain, ToolchainError> {
        let shell = self.core.shell();
        let env = shell.get().await.map_err(|e| ToolchainError::NoEnvironment(e.to_string()))?;
        let (find, on) = (self.find, env.clone());
        let Some(binary) = tokio::task::spawn_blocking(move || find(Driver::Claude, &on)).await.ok().flatten() else {
            shell.forget().await;
            return Err(ToolchainError::ClaudeMissing { instance: name.into() });
        };
        let run_env = login.as_ref().map_or_else(|| env.clone(), |login| Arc::new(login.over(&env)));
        Ok(Toolchain { cli: Arc::new(SystemCli::new(binary, run_env)), env, instance_id: id.into(), instance_name: name.into(), login })
    }
}

#[async_trait]
impl ToolchainSource for SystemToolchain {
    async fn get(&self) -> Result<Toolchain, ToolchainError> {
        let mut found = self.found.lock().await;
        if let Some(t) = &*found {
            return Ok(t.clone());
        }
        let name = self.core.provider(connections::DEFAULT_CLAUDE).await.map_or_else(|| "Claude".to_owned(), |(p, _)| p.display_name);
        let t = self.build(connections::DEFAULT_CLAUDE, &name, None).await?;
        *found = Some(t.clone());
        Ok(t)
    }

    async fn for_instance(&self, id: &str) -> Result<Toolchain, ToolchainError> {
        let Some((instance, state)) = self.core.provider(id).await else { return Err(ToolchainError::UnknownInstance(id.into())) };
        let name = &instance.display_name;
        if !instance.driver.runs_agents() {
            return Err(ToolchainError::Unusable(format!("{name} can't run agents.")));
        }
        match state {
            ProviderState::Off => Err(ToolchainError::Unusable(format!("{name} is turned off."))),
            ProviderState::Error(problem) => Err(ToolchainError::Unusable(format!("{name}: {problem}"))),
            ProviderState::Unavailable(why) => Err(ToolchainError::NoEnvironment(why.message().into())),
            ProviderState::Ready(login) => self.build(&instance.id, name, Some(login)).await,
        }
    }
}

#[cfg(test)]
pub struct FixedToolchain(pub Result<Toolchain, ToolchainError>);

#[cfg(test)]
#[async_trait]
impl ToolchainSource for FixedToolchain {
    async fn get(&self) -> Result<Toolchain, ToolchainError> {
        self.0.clone()
    }

    async fn for_instance(&self, id: &str) -> Result<Toolchain, ToolchainError> {
        match &self.0 {
            Ok(t) if t.instance_id == id => Ok(t.clone()),
            Ok(_) => Err(ToolchainError::UnknownInstance(id.into())),
            Err(e) => Err(e.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::connections::{ProviderConfig, ProviderInstance};
    use crate::inbox::testing::{fixture_with_shell, Fixture};
    use crate::runs::env::ShellCapture;
    use std::os::unix::fs::PermissionsExt;

    /// A `claude` that prints the login variables it was started with.
    fn fake_claude(dir: &std::path::Path) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("claude");
        std::fs::write(&path, "#!/bin/sh\necho \"${CLAUDE_CONFIG_DIR:-unset}|${ANTHROPIC_API_KEY:-unset}\"\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn shell_printing(dir: &std::path::Path, claude: &std::path::Path) -> ShellCapture {
        let path = dir.join("fakeshell");
        let vars = format!("PATH=/usr/bin\\0FAKE_CLAUDE={}\\0CLAUDE_CONFIG_DIR=/shell/folder\\0ANTHROPIC_API_KEY=sk-shell\\0", claude.display());
        std::fs::write(&path, format!("#!/bin/sh\nprintf '\\0GOSSAMR_ENV_BEGIN\\0{vars}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        ShellCapture::with_shell(&path.display().to_string())
    }

    fn the_fake(_: Driver, shell: &RunEnv) -> Option<PathBuf> {
        shell.get("FAKE_CLAUDE").map(PathBuf::from)
    }

    fn add(fx: &Fixture, id: &str, driver: Driver, folder: Option<&str>, enabled: bool) {
        AppConfig::update(&fx.core.data_dir(), |config| {
            if config.providers.is_empty() {
                config.providers.push(connections::default_claude());
            }
            config.providers.push(ProviderInstance {
                id: id.into(),
                driver,
                display_name: format!("{id} name"),
                enabled,
                config: ProviderConfig { config_dir: folder.map(Into::into), ..Default::default() },
                extra: Default::default(),
            });
        })
        .unwrap();
    }

    async fn rig(tag: &str) -> (Fixture, SystemToolchain) {
        let dir = std::env::temp_dir().join(format!("gossamr-toolchain-{tag}-{}", std::process::id()));
        let claude = fake_claude(&dir);
        let fx = fixture_with_shell(shell_printing(&dir, &claude)).await;
        let tools = SystemToolchain::new(fx.core.clone()).with_finder(the_fake);
        (fx, tools)
    }

    #[tokio::test]
    async fn the_default_instance_runs_claude_with_the_login_the_shell_has() {
        let (_fx, tools) = rig("default").await;
        for tc in [tools.get().await.unwrap(), tools.for_instance(connections::DEFAULT_CLAUDE).await.unwrap()] {
            assert_eq!(tc.cli.version().await.unwrap(), "/shell/folder|sk-shell");
            assert_eq!((tc.instance_id.as_str(), tc.instance_name.as_str()), ("claude", "Claude"));
        }
    }

    #[tokio::test]
    async fn an_instance_with_a_folder_runs_claude_in_its_folder_without_the_shells_keys() {
        let (fx, tools) = rig("folder").await;
        add(&fx, "claude_2", Driver::Claude, Some("~/.claude-work"), true);
        let tc = tools.for_instance("claude_2").await.unwrap();
        assert_eq!(tc.cli.version().await.unwrap(), format!("{}|unset", fx.home.join(".claude-work").display()));
        assert_eq!((tc.instance_id.as_str(), tc.instance_name.as_str()), ("claude_2", "claude_2 name"));
        assert!(tc.login.is_some());
    }

    #[tokio::test]
    async fn git_keeps_the_captured_environment_whichever_instance_asks() {
        let (fx, tools) = rig("git").await;
        add(&fx, "claude_2", Driver::Claude, Some("~/.claude-work"), true);
        let env = tools.for_instance("claude_2").await.unwrap().env;
        assert_eq!((env.get("CLAUDE_CONFIG_DIR").unwrap(), env.get("ANTHROPIC_API_KEY").unwrap()), ("/shell/folder".as_ref(), "sk-shell".as_ref()));
    }

    #[tokio::test]
    async fn an_unknown_or_removed_instance_is_an_error_and_never_the_default_toolchain() {
        let (fx, tools) = rig("unknown").await;
        add(&fx, "claude_2", Driver::Claude, Some("~/.claude-work"), true);
        assert!(tools.for_instance("claude_2").await.is_ok());
        AppConfig::update(&fx.core.data_dir(), |config| config.providers.retain(|p| p.id != "claude_2")).unwrap();
        for id in ["claude_2", "nothing"] {
            assert_eq!(tools.for_instance(id).await.err(), Some(ToolchainError::UnknownInstance(id.into())));
        }
        assert!(tools.get().await.is_ok(), "the default instance is still there");
    }

    #[tokio::test]
    async fn an_instance_that_is_off_or_has_a_bad_folder_or_cannot_run_agents_is_unusable_and_says_which() {
        let (fx, tools) = rig("unusable").await;
        add(&fx, "off", Driver::Claude, Some("~/.claude-off"), false);
        add(&fx, "bad", Driver::Claude, Some("/tmp/outside-home"), true);
        add(&fx, "codex", Driver::Codex, Some("~/.codex-work"), true);
        let words = |e: Option<ToolchainError>| match e {
            Some(ToolchainError::Unusable(words)) => words,
            other => panic!("{other:?}"),
        };
        assert_eq!(words(tools.for_instance("off").await.err()), "off name is turned off.");
        assert!(words(tools.for_instance("bad").await.err()).starts_with("bad name: This folder can't be used: "));
        assert_eq!(words(tools.for_instance("codex").await.err()), "codex name can't run agents.");
    }

    #[tokio::test]
    async fn a_missing_claude_names_the_instance_that_wanted_it() {
        let (fx, tools) = rig("missing").await;
        add(&fx, "claude_2", Driver::Claude, Some("~/.claude-work"), true);
        let tools = tools.with_finder(|_, _| None);
        assert_eq!(tools.for_instance("claude_2").await.err(), Some(ToolchainError::ClaudeMissing { instance: "claude_2 name".into() }));
        assert_eq!(tools.get().await.err(), Some(ToolchainError::ClaudeMissing { instance: "Claude".into() }));
    }
}
