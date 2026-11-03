//! Core's side of the provider instances: what each one may run as.

use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::instances::{clean_name, not_a_provider};
use super::Core;
use crate::config::AppConfig;
use crate::connections::{self, Driver, ProviderInstance};
use crate::error::{Error, Result};
use crate::probe::State;
use crate::runs::binary::find_binary_from;
use crate::runs::env::RunEnv;
use crate::runs::provider_env::{observing_states, states,ProviderEnv, ProviderState};
use crate::runs::provider_folder::{self, Places};

const NO_SHELL_SETUP: &str = "Couldn't read your shell setup. Try again in a moment.";

/// What the sign-in Terminal for a provider instance runs: its CLI, as the login its folder picks.
#[derive(Debug)]
pub struct SignIn {
    pub driver: Driver,
    pub binary: PathBuf,
    pub login: ProviderEnv,
}

pub enum Lookup {
    Found { instance: ProviderInstance, state: ProviderState, shell: std::result::Result<Arc<RunEnv>, String> },
    Missing,
    /// `config.json` can't be read, so the list is locked; the text says why.
    Unreadable(String),
}

enum Listing {
    Empty,
    Rows { rows: Vec<(ProviderInstance, ProviderState)>, shell: std::result::Result<Arc<RunEnv>, String> },
    Unreadable(String),
}

/// The provider instances as they are now, what each may run as, and the shell environment that was captured for them.
pub(super) struct Setup {
    pub providers: Vec<ProviderInstance>,
    pub states: Vec<(String, ProviderState)>,
    pub shell: Option<Arc<RunEnv>>,
}

impl Core {
    pub(super) async fn provider_setup(&self) -> Setup {
        match self.listing(false).await {
            Listing::Rows { rows, shell } => {
                let shell = shell.inspect_err(|why| eprintln!("{why}")).ok();
                let states = rows.iter().map(|(p, state)| (p.id.clone(), state.clone())).collect();
                Setup { providers: rows.into_iter().map(|(p, _)| p).collect(), states, shell }
            }
            Listing::Empty | Listing::Unreadable(_) => Setup { providers: Vec::new(), states: Vec::new(), shell: None },
        }
    }

    /// The state of every provider instance, in order. The folder rules run on the list as it is now, and a failed
    /// capture of the shell makes the instance without a folder unavailable, never the app's own environment.
    pub async fn provider_states(&self) -> Vec<(String, ProviderState)> {
        self.providers_with_state().await.into_iter().map(|(p, state)| (p.id, state)).collect()
    }

    /// One provider instance with its state and the shell it was judged against, from a single capture of the shell.
    /// An unreadable list is told apart from an id that isn't in it.
    pub async fn lookup_provider(&self, id: &str) -> Lookup {
        self.lookup(id, false).await
    }

    /// Like `lookup_provider`, but an instance that is off or has a bad folder still gets its login, so the runs on it
    /// can be watched.
    pub async fn lookup_provider_for_observing(&self, id: &str) -> Lookup {
        self.lookup(id, true).await
    }

    async fn lookup(&self, id: &str, observing: bool) -> Lookup {
        match self.listing(observing).await {
            Listing::Unreadable(why) => Lookup::Unreadable(why),
            Listing::Empty => Lookup::Missing,
            Listing::Rows { rows, shell } => match rows.into_iter().find(|(p, _)| p.id == id) {
                Some((instance, state)) => Lookup::Found { instance, state, shell },
                None => Lookup::Missing,
            },
        }
    }

    async fn providers_with_state(&self) -> Vec<(ProviderInstance, ProviderState)> {
        match self.listing(false).await {
            Listing::Rows { rows, shell } => {
                if let Err(why) = shell {
                    eprintln!("{why}");
                }
                rows
            }
            Listing::Empty | Listing::Unreadable(_) => Vec::new(),
        }
    }

    async fn listing(&self, observing: bool) -> Listing {
        let config = AppConfig::load(&self.data_dir);
        if let Some(why) = config.providers_error.or(config.connections_error) {
            return Listing::Unreadable(why);
        }
        if config.providers.is_empty() {
            return Listing::Empty;
        }
        let shell = self.shell.get().await.map_err(|e| e.to_string());
        let places = Places { home: self.home.as_deref(), data_dir: &self.data_dir };
        let shell_env = shell.as_ref().ok().map(|s| s.as_ref());
        let states = if observing { observing_states(&config.providers, &places, shell_env) } else { states(&config.providers, &places, shell_env) };
        Listing::Rows { rows: config.providers.into_iter().zip(states).map(|(p, (_, state))| (p, state)).collect(), shell }
    }

    /// Adds a provider instance after the folder rules of 6.2 pass, makes its folder (mode 0700) when it is missing and
    /// returns the new id. The check and the save happen under one lock on `config.json`, so two adds can't take one folder.
    /// Without the captured shell the usual folders are unknown, so a folder waits for it.
    pub async fn provider_add(&self, driver: Driver, display_name: &str, config_dir: Option<&str>) -> Result<String> {
        let name = clean_name(display_name)?;
        let typed = config_dir.map(|t| t.trim().to_string());
        let shell = self.shell.get().await.inspect_err(|why| eprintln!("{why}")).ok();
        if typed.is_some() && shell.is_none() {
            return Err(Error::Input(NO_SHELL_SETUP.into()));
        }
        let places = Places { home: self.home.as_deref(), data_dir: &self.data_dir };
        let mut added = Err(not_a_provider());
        AppConfig::update_if(&self.data_dir, |config| {
            added = add_checked(config, driver, name, typed, &places, shell.as_deref());
            added.is_ok()
        })?;
        added
    }

    /// The folder of provider `instance_id`, for Finder. The page names no path. An instance on its usual setup has no folder of its own.
    pub fn provider_folder_to_show(&self, instance_id: &str) -> Result<PathBuf> {
        let config = AppConfig::load(&self.data_dir);
        let instance = config.providers.iter().find(|p| p.id == instance_id).ok_or_else(not_a_provider)?;
        let typed = instance.config.config_dir.as_deref().ok_or_else(|| Error::Input("This one uses your usual setup, which has no folder of its own to show.".into()))?;
        let path = provider_folder::expand(typed, self.home.as_deref().unwrap_or(Path::new("")));
        if !path.is_dir() {
            return Err(Error::Input(format!("The folder {typed} is gone.")));
        }
        Ok(path)
    }

    /// The row Settings shows for one provider instance.
    pub fn provider_row(&self, instance_id: &str) -> Result<super::ConnectionInfo> {
        self.provider_rows().into_iter().find(|row| row.instance_id == instance_id).ok_or_else(not_a_provider)
    }

    /// What to run to sign `instance_id` in, built from the instance as it is in `config.json` now. Only an instance that
    /// can run and whose last check found it signed out has one, and never without the captured shell: the folder rules
    /// and the login both depend on it.
    pub async fn provider_signin(&self, instance_id: &str) -> Result<SignIn> {
        let (instance, state, shell) = match self.lookup_provider(instance_id).await {
            Lookup::Found { instance, state, shell } => (instance, state, shell),
            Lookup::Missing => return Err(not_a_provider()),
            Lookup::Unreadable(why) => return Err(Error::Input(why)),
        };
        let Ok(shell) = shell else { return Err(Error::Input(NO_SHELL_SETUP.into())) };
        let login = match state {
            ProviderState::Ready(login) => login,
            ProviderState::Off => return Err(Error::Input(format!("{} is turned off. Turn it on first.", instance.display_name))),
            ProviderState::Error(problem) => return Err(Error::Input(problem)),
            ProviderState::Unavailable(why) => return Err(Error::Input(why.message().into())),
        };
        if self.provider_snapshot_for(&instance).is_none_or(|s| s.state != State::NotSignedIn) {
            return Err(Error::Input("Gossamr opens Terminal to sign in only when the last check found you signed out. Check it again.".into()));
        }
        let binary = find_binary_from(self.home.as_deref(), instance.driver, &login.over(&shell)).ok_or_else(|| Error::Input(format!("`{}` isn't installed.", instance.driver.binary())))?;
        Ok(SignIn { driver: instance.driver, binary, login })
    }

    /// Runs the folder rules on `config.json` as it is now and logs each instance that fails them.
    pub async fn check_providers(&self) {
        for (id, state) in self.provider_states().await {
            if let ProviderState::Error(problem) = state {
                eprintln!("provider {id}: {problem}");
            }
        }
    }
}

fn add_checked(config: &mut AppConfig, driver: Driver, name: String, typed: Option<String>, places: &Places, shell: Option<&RunEnv>) -> Result<String> {
    if !connections::providers_live(config) {
        return Err(Error::Input("Gossamr can't read the providers in config.json, so it can't add one. Fix the file first.".into()));
    }
    let has_folder = typed.is_some();
    let id = connections::add_provider(config, driver, name, typed.clone());
    let checked = match provider_folder::problems(&config.providers, places, shell).remove(&id) {
        Some(problem) => Err(Error::Input(provider_folder::describe(&problem, has_folder))),
        None => typed.map_or(Ok(()), |t| make_folder(&provider_folder::expand(&t, places.home.unwrap_or(Path::new(""))))),
    };
    if checked.is_err() {
        config.providers.pop();
    }
    checked.map(|()| id)
}

/// `codex` refuses a `CODEX_HOME` that doesn't exist. A folder that is already there is left as it is.
fn make_folder(path: &Path) -> Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(path).map_err(|e| Error::Input(format!("Couldn't create the folder: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{self, Driver, ProviderConfig, ProviderInstance};
    use crate::inbox::testing::fixture_with_shell;
    use crate::runs::env::{RunEnv, ShellCapture};
    use crate::runs::provider_env::Unavailable;
    use std::os::unix::fs::PermissionsExt;

    fn fake_shell(fx_dir: &std::path::Path, vars: &str) -> String {
        std::fs::create_dir_all(fx_dir).unwrap();
        let path = fx_dir.join("fakeshell");
        std::fs::write(&path, format!("#!/bin/sh\nprintf '\\0GOSSAMR_ENV_BEGIN\\0{vars}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    fn add(core: &Core, id: &str, folder: Option<&str>) {
        AppConfig::update(&core.data_dir, |config| {
            config.providers.push(ProviderInstance {
                id: id.into(),
                driver: Driver::Claude,
                display_name: id.into(),
                enabled: true,
                config: ProviderConfig { config_dir: folder.map(Into::into), ..Default::default() },
                extra: Default::default(),
            });
        })
        .unwrap();
    }

    fn only_default(core: &Core) {
        AppConfig::update(&core.data_dir, |config| config.providers = vec![connections::default_claude()]).unwrap();
    }

    fn ready(state: &ProviderState, base: &RunEnv) -> RunEnv {
        match state {
            ProviderState::Ready(env) => env.over(base),
            other => panic!("not ready: {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_default_instance_takes_the_login_the_captured_shell_has() {
        let dir = std::env::temp_dir().join(format!("gossamr-provider-shell-{}", std::process::id()));
        let shell = fake_shell(&dir, "PATH=/p\\0CLAUDE_CONFIG_DIR=/Users/x/.claude-shell\\0ANTHROPIC_API_KEY=sk-shell\\0");
        let fx = fixture_with_shell(ShellCapture::with_shell(&shell)).await;
        only_default(&fx.core);
        let states = fx.core.provider_states().await;
        assert_eq!(states.len(), 1);
        let env = ready(&states[0].1, &RunEnv::from_pairs([("ANTHROPIC_AUTH_TOKEN", "app")]));
        assert_eq!((env.get("CLAUDE_CONFIG_DIR").unwrap(), env.get("ANTHROPIC_API_KEY").unwrap()), ("/Users/x/.claude-shell".as_ref(), "sk-shell".as_ref()));
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn showing_a_providers_folder_needs_a_folder_of_its_own_that_exists() {
        let fx = fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await;
        only_default(&fx.core);
        add(&fx.core, "claude_2", Some("~/.claude-work"));
        assert_eq!(fx.core.provider_folder_to_show("claude").unwrap_err().to_string(), "This one uses your usual setup, which has no folder of its own to show.");
        assert_eq!(fx.core.provider_folder_to_show("claude_2").unwrap_err().to_string(), "The folder ~/.claude-work is gone.");
        std::fs::create_dir_all(fx.home.join(".claude-work")).unwrap();
        assert_eq!(fx.core.provider_folder_to_show("claude_2").unwrap(), fx.home.join(".claude-work"));
        assert!(fx.core.provider_folder_to_show("github").is_err(), "an id that is not a provider is refused");
    }

    #[tokio::test]
    async fn a_failed_capture_makes_the_default_unavailable_and_leaves_a_folder_instance_ready() {
        let fx = fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await;
        only_default(&fx.core);
        add(&fx.core, "claude_2", Some("~/.claude-work"));
        let states = fx.core.provider_states().await;
        assert_eq!(states[0], ("claude".into(), ProviderState::Unavailable(Unavailable::NoShellSetup)));
        let env = ready(&states[1].1, &RunEnv::from_pairs([("ANTHROPIC_API_KEY", "app")]));
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").unwrap(), fx.home.join(".claude-work").as_os_str());
        assert_eq!(env.get("ANTHROPIC_API_KEY"), None);
    }

    #[tokio::test]
    async fn a_folder_that_fails_the_rules_is_an_error_when_the_config_is_loaded() {
        let fx = fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await;
        only_default(&fx.core);
        add(&fx.core, "claude_2", Some("/tmp/outside-home"));
        add(&fx.core, "claude_3", Some("~/.claude-ok"));
        let states = fx.core.provider_states().await;
        assert!(matches!(&states[1].1, ProviderState::Error(e) if e.starts_with("This folder can't be used: ")), "{:?}", states[1]);
        assert!(matches!(states[2].1, ProviderState::Ready(_)));
    }

    /// A fixture whose captured shell holds `vars` (NUL-separated `NAME=value` pairs, written once the home folder is known).
    async fn adding_fixture(vars: impl FnOnce(&std::path::Path) -> String) -> (crate::inbox::testing::Fixture, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("gossamr-provider-add-{}-{:?}", std::process::id(), std::thread::current().id()));
        let fx = fixture_with_shell(ShellCapture::with_shell(&dir.join("fakeshell").display().to_string())).await;
        fake_shell(&dir, &vars(&fx.home));
        only_default(&fx.core);
        (fx, dir)
    }

    fn providers(core: &Core) -> Vec<(String, Option<String>)> {
        AppConfig::load(&core.data_dir).providers.into_iter().map(|p| (p.id, p.config.config_dir)).collect()
    }

    #[tokio::test]
    async fn an_added_instance_gets_the_next_id_and_its_missing_folder_is_made_private() {
        let (fx, dir) = adding_fixture(|_| "PATH=/p\\0".into()).await;
        let id = fx.core.provider_add(Driver::Claude, "  Claude personal ", Some(" ~/.claude-personal/deeper ")).await.unwrap();
        assert_eq!(id, "claude_2");
        let added = AppConfig::load(&fx.core.data_dir).providers.pop().unwrap();
        assert_eq!((added.display_name.as_str(), added.enabled, added.config.config_dir.as_deref()), ("Claude personal", true, Some("~/.claude-personal/deeper")), "the folder is stored as typed");
        assert_eq!(std::fs::metadata(fx.home.join(".claude-personal/deeper")).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fx.core.provider_row(&id).unwrap().config_dir.as_deref(), Some("~/.claude-personal/deeper"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_folder_that_already_exists_keeps_its_mode_and_contents() {
        let (fx, dir) = adding_fixture(|_| "PATH=/p\\0".into()).await;
        let folder = fx.home.join(".claude-old");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(folder.join("settings.json"), "{}").unwrap();
        fx.core.provider_add(Driver::Claude, "Old", Some("~/.claude-old")).await.unwrap();
        assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o755);
        assert_eq!(std::fs::read_to_string(folder.join("settings.json")).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_second_instance_without_a_folder_is_refused_for_its_driver_only() {
        let (fx, dir) = adding_fixture(|_| "PATH=/p\\0".into()).await;
        let refused = fx.core.provider_add(Driver::Claude, "Again", None).await.unwrap_err();
        assert_eq!(refused.to_string(), "Your usual setup is already added as Claude.");
        assert_eq!(fx.core.provider_add(Driver::Codex, "Codex", None).await.unwrap(), "codex");
        assert_eq!(providers(&fx.core), [("claude".into(), None), ("codex".into(), None)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn every_folder_rule_refuses_an_add_and_leaves_config_json_and_the_disk_alone() {
        let (fx, dir) = adding_fixture(|home| format!("PATH=/p\\0CLAUDE_CONFIG_DIR={}\\0", home.join(".claude-shell").display())).await;
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, fx.home.join("hop")).unwrap();
        std::fs::create_dir_all(fx.home.join("real")).unwrap();
        std::os::unix::fs::symlink(fx.home.join("real"), fx.home.join("alias")).unwrap();
        fx.core.provider_add(Driver::Claude, "Work", Some("~/.claude-work")).await.unwrap();
        let before = providers(&fx.core);

        let data_dir = fx.core.data_dir.display().to_string();
        let cases = [
            ("~/.claude", "usual setup"),
            ("~/.CLAUDE", "usual setup"),
            ("~/.claude/", "usual setup"),
            ("~/.claude-shell", "usual setup"),
            ("~/hop/inner", "inside your home folder"),
            ("~/alias", "link"),
            ("~/it's", "quote"),
            ("~/two\nlines", "unusual character"),
            ("~/.CLAUDE-WORK", "Another Claude already uses this folder."),
            ("~/real/../.claude-work", "Another Claude already uses this folder."),
            ("~/.codex", "usual folder of Codex"),
            ("/tmp/outside-home", "inside your home folder"),
            ("~", "inside your home folder"),
            (data_dir.as_str(), "data folder"),
            ("  ", "empty"),
        ];
        for (typed, wanted) in cases {
            let refused = fx.core.provider_add(Driver::Claude, "Nope", Some(typed)).await.unwrap_err().to_string();
            assert!(refused.starts_with("This folder can't be used: ") && refused.contains(wanted), "{typed:?}: {refused}");
        }
        assert_eq!(providers(&fx.core), before);
        assert!(!outside.join("inner").exists() && !fx.home.join("it's").exists(), "nothing was made for a refused folder");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn codex_may_not_take_claudes_usual_folder_and_its_own_folder_is_made() {
        let (fx, dir) = adding_fixture(|_| "PATH=/p\\0".into()).await;
        let refused = fx.core.provider_add(Driver::Codex, "Codex", Some("~/.claude")).await.unwrap_err().to_string();
        assert!(refused.contains("usual folder of Claude"), "{refused}");
        assert_eq!(fx.core.provider_add(Driver::Codex, "Codex work", Some("~/.codex-work")).await.unwrap(), "codex");
        assert!(fx.home.join(".codex-work").is_dir());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_folder_waits_for_the_shell_capture_and_nothing_is_made_without_it() {
        let fx = fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await;
        only_default(&fx.core);
        let refused = fx.core.provider_add(Driver::Claude, "Work", Some("~/.claude-work")).await.unwrap_err();
        assert_eq!(refused.to_string(), "Couldn't read your shell setup. Try again in a moment.");
        assert!(!fx.home.join(".claude-work").exists());
        assert_eq!(providers(&fx.core).len(), 1);
    }

    #[tokio::test]
    async fn nothing_is_added_while_the_providers_list_cannot_be_read() {
        let (fx, dir) = adding_fixture(|_| "PATH=/p\\0".into()).await;
        std::fs::write(fx.core.data_dir.join("config.json"), r#"{"version":1,"connections":[],"providers":"broken"}"#).unwrap();
        assert!(fx.core.provider_add(Driver::Claude, "Work", Some("~/.claude-work")).await.is_err());
        assert!(!fx.home.join(".claude-work").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn two_adds_at_once_cannot_take_the_same_folder() {
        let (fx, dir) = adding_fixture(|_| "PATH=/p\\0".into()).await;
        let (a, b) = tokio::join!(fx.core.provider_add(Driver::Claude, "A", Some("~/.claude-x")), fx.core.provider_add(Driver::Claude, "B", Some("~/.CLAUDE-X")));
        assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(), 1);
        assert_eq!(providers(&fx.core).len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
