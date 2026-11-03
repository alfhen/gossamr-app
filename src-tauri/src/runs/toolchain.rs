//! The `claude` command and the shell environment it runs in, found once and reused.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use super::binary::find_binary;
use super::agent_config::config_dir;
use super::backend::claude::ClaudeBackend;
use super::backend::RunBackend;
use super::cli::{ClaudeCli, SystemCli};
use super::env::RunEnv;
use super::provider_env::{ProviderEnv, ProviderState, Unavailable};
use crate::config::AppConfig;
use crate::connections::{self, Driver};
use crate::inbox::{Core, Lookup};
use crate::model_choice::Reason;

#[derive(Clone)]
pub struct Toolchain {
    pub cli: Arc<dyn ClaudeCli>,
    pub backend: Arc<dyn RunBackend>,
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
        let backend = Arc::new(ClaudeBackend::new(cli.clone(), env.clone(), std::env::temp_dir().join("gossamr-agents"), "Claude".into(), false));
        Self { cli, backend, env, instance_id: connections::DEFAULT_CLAUDE.into(), instance_name: "Claude".into(), login: None }
    }

    /// Whether the instance has a folder of its own, which a plain `claude` in the person's Terminal doesn't use.
    pub fn has_own_folder(&self) -> bool {
        self.login.as_ref().is_some_and(ProviderEnv::uses_own_folder)
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
    /// The instance is off, can't run agents, or has no readable shell setup behind it: `Off`, `CantRun` or
    /// `NoShellSetup`. The words are `Reason::words`, the same ones the resolver uses.
    Unusable { reason: Reason, name: String },
    /// The instance's folder fails the rules in 6.2.
    BadFolder { name: String, problem: String },
    /// `config.json` can't be read, so no instance can be found. Not the same as a removed instance.
    ConfigUnreadable(String),
}

#[async_trait]
pub trait ToolchainSource: Send + Sync {
    /// The default instance.
    async fn get(&self) -> Result<Toolchain, ToolchainError>;

    /// The toolchain of one provider instance; refuses one that is off.
    async fn for_instance(&self, id: &str) -> Result<Toolchain, ToolchainError>;

    /// The toolchain for looking at runs already on an instance: it works whether the instance is on or off. Only a
    /// missing instance, a folder that breaks the rules, an unreadable list, no environment or no binary refuse it.
    async fn observe_instance(&self, id: &str) -> Result<Toolchain, ToolchainError> {
        self.for_instance(id).await
    }
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

    async fn build(&self, id: &str, name: &str, login: Option<ProviderEnv>, shell: Result<Arc<RunEnv>, String>) -> Result<Toolchain, ToolchainError> {
        let env = shell.map_err(ToolchainError::NoEnvironment)?;
        let (find, on) = (self.find, env.clone());
        let Some(binary) = tokio::task::spawn_blocking(move || find(Driver::Claude, &on)).await.ok().flatten() else {
            self.core.shell().forget().await;
            return Err(ToolchainError::ClaudeMissing { instance: name.into() });
        };
        let run_env = login.as_ref().map_or_else(|| env.clone(), |login| Arc::new(login.over(&env)));
        let cli = Arc::new(SystemCli::new(binary, run_env));
        let own_folder = login.as_ref().is_some_and(ProviderEnv::uses_own_folder);
        let backend = Arc::new(ClaudeBackend::new(cli.clone(), env.clone(), config_dir(&self.core.data_dir()), name.into(), own_folder));
        Ok(Toolchain { cli, backend, env, instance_id: id.into(), instance_name: name.into(), login })
    }
}

#[async_trait]
impl ToolchainSource for SystemToolchain {
    async fn get(&self) -> Result<Toolchain, ToolchainError> {
        let mut found = self.found.lock().await;
        if let Some(t) = &*found {
            return Ok(t.clone());
        }
        let name = AppConfig::load(&self.core.data_dir()).providers.into_iter().find(|p| p.id == connections::DEFAULT_CLAUDE).map_or_else(|| "Claude".to_owned(), |p| p.display_name);
        let shell = self.core.shell().get().await.map_err(|e| e.to_string());
        let t = self.build(connections::DEFAULT_CLAUDE, &name, None, shell).await?;
        *found = Some(t.clone());
        Ok(t)
    }

    async fn for_instance(&self, id: &str) -> Result<Toolchain, ToolchainError> {
        self.open(id, false).await
    }

    async fn observe_instance(&self, id: &str) -> Result<Toolchain, ToolchainError> {
        self.open(id, true).await
    }
}

impl SystemToolchain {
    async fn open(&self, id: &str, observing: bool) -> Result<Toolchain, ToolchainError> {
        let found = if observing { self.core.lookup_provider_for_observing(id).await } else { self.core.lookup_provider(id).await };
        let (instance, state, shell) = match found {
            Lookup::Found { instance, state, shell } => (instance, state, shell),
            Lookup::Missing => return Err(ToolchainError::UnknownInstance(id.into())),
            Lookup::Unreadable(why) => return Err(ToolchainError::ConfigUnreadable(why)),
        };
        let name = instance.display_name.clone();
        if !instance.driver.runs_agents() {
            return Err(ToolchainError::Unusable { reason: Reason::CantRun(instance.driver), name });
        }
        match state {
            ProviderState::Off => Err(ToolchainError::Unusable { reason: Reason::Off, name }),
            ProviderState::Error(problem) => Err(ToolchainError::BadFolder { name, problem }),
            ProviderState::Unavailable(Unavailable::NoShellSetup) => Err(ToolchainError::Unusable { reason: Reason::NoShellSetup, name }),
            ProviderState::Ready(login) => self.build(&instance.id, &name, Some(login), shell).await,
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
        assert_eq!(tools.for_instance("off").await.err(), Some(ToolchainError::Unusable { reason: Reason::Off, name: "off name".into() }));
        assert!(matches!(tools.for_instance("bad").await.err(), Some(ToolchainError::BadFolder { name, problem }) if name == "bad name" && problem.starts_with("This folder can't be used: ")));
        assert_eq!(tools.for_instance("codex").await.err(), Some(ToolchainError::Unusable { reason: Reason::CantRun(Driver::Codex), name: "codex name".into() }));
    }

    #[tokio::test]
    async fn an_instance_that_is_off_is_still_observed_in_its_own_folder_and_one_with_a_bad_folder_is_not() {
        let (fx, tools) = rig("observe").await;
        add(&fx, "off", Driver::Claude, Some("~/.claude-off"), false);
        add(&fx, "bad", Driver::Claude, Some("/tmp/outside-home"), true);
        add(&fx, "bad_off", Driver::Claude, Some("/tmp/outside-home-2"), false);
        assert!(matches!(tools.for_instance("off").await.err(), Some(ToolchainError::Unusable { reason: Reason::Off, .. })));
        let tc = tools.observe_instance("off").await.unwrap();
        assert_eq!(tc.cli.version().await.unwrap(), format!("{}|unset", fx.home.join(".claude-off").display()));
        for id in ["bad", "bad_off"] {
            assert!(matches!(tools.observe_instance(id).await.err(), Some(ToolchainError::BadFolder { .. })), "{id}");
        }
    }

    #[tokio::test]
    async fn a_shell_that_cannot_be_read_stops_the_instance_that_uses_the_shells_login_and_gives_the_one_with_a_folder_no_environment() {
        let fx = fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await;
        let tools = SystemToolchain::new(fx.core.clone()).with_finder(the_fake);
        add(&fx, "claude_2", Driver::Claude, Some("~/.claude-work"), true);
        assert_eq!(tools.for_instance("claude").await.err(), Some(ToolchainError::Unusable { reason: Reason::NoShellSetup, name: "Claude".into() }));
        assert!(matches!(tools.for_instance("claude_2").await.err(), Some(ToolchainError::NoEnvironment(_))), "no environment to start it in");
        assert!(matches!(tools.get().await.err(), Some(ToolchainError::NoEnvironment(_))));
    }

    #[tokio::test]
    async fn a_config_that_cannot_be_read_is_not_a_removed_instance() {
        let (fx, tools) = rig("unreadable").await;
        std::fs::write(fx.core.data_dir().join("config.json"), "{ not json").unwrap();
        for id in ["claude", "claude_2"] {
            assert!(matches!(tools.for_instance(id).await.err(), Some(ToolchainError::ConfigUnreadable(_))), "{id}");
        }
    }

    #[tokio::test]
    async fn an_uncached_toolchain_reads_the_shell_once() {
        let dir = std::env::temp_dir().join(format!("gossamr-toolchain-count-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let counter = dir.join("runs");
        let _ = std::fs::remove_file(&counter);
        let shell = dir.join("failing-shell");
        std::fs::write(&shell, format!("#!/bin/sh\necho x >> '{}'\nexit 1\n", counter.display())).unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let fx = fixture_with_shell(ShellCapture::with_shell(&shell.display().to_string())).await;
        let tools = SystemToolchain::new(fx.core.clone()).with_finder(the_fake);
        add(&fx, "claude_2", Driver::Claude, Some("~/.claude-work"), true);
        let runs = || std::fs::read_to_string(&counter).map_or(0, |t| t.lines().count());
        assert!(tools.get().await.is_err());
        assert_eq!(runs(), 1, "get");
        assert!(tools.for_instance("claude_2").await.is_err());
        assert_eq!(runs(), 2, "for_instance");
        let _ = std::fs::remove_dir_all(dir);
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
