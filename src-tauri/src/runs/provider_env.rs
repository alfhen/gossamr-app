//! Which login a provider instance's CLI runs as: the variables that pick the account, decided once per instance.

use std::ffi::{OsStr, OsString};
use std::path::Path;

use super::env::RunEnv;
use super::provider_folder::{self, Places};
use crate::connections::ProviderInstance;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// The shell environment couldn't be read, so the login of an instance without a folder can't be known.
    NoShellSetup,
}

impl Unavailable {
    pub fn message(&self) -> &'static str {
        match self {
            Self::NoShellSetup => "Couldn't read your shell setup",
        }
    }
}

/// What an instance can be used for. Only `Ready` may start a process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderState {
    Off,
    Error(String),
    Unavailable(Unavailable),
    Ready(ProviderEnv),
}

/// The login variables of one instance: each one set to a value, or removed.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderEnv {
    vars: Vec<(&'static str, Option<OsString>)>,
}

// Values can hold API keys, so nothing prints them.
impl std::fmt::Debug for ProviderEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProviderEnv({} variables)", self.vars.len())
    }
}

impl ProviderEnv {
    /// An instance with a folder runs as the login in it: the folder variable is set and every other login variable is
    /// removed, so a key the shell exports can't override it. Without a folder the login is the shell's, which has to be
    /// known. Private, so the folder rules in `states` can't be skipped.
    fn resolve(instance: &ProviderInstance, shell: Option<&RunEnv>, home: &Path) -> std::result::Result<Self, Unavailable> {
        let driver = instance.driver;
        let vars = match instance.config.config_dir.as_deref() {
            Some(typed) => {
                let folder = provider_folder::expand(typed, home).into_os_string();
                driver.login_variables().iter().map(|&name| (name, (name == driver.folder_variable()).then(|| folder.clone()))).collect()
            }
            None => {
                let shell = shell.ok_or(Unavailable::NoShellSetup)?;
                driver.login_variables().iter().map(|&name| (name, shell.get(name).map(OsStr::to_os_string))).collect()
            }
        };
        Ok(Self { vars })
    }

    /// `base` with the login variables replaced by this instance's.
    pub fn over(&self, base: &RunEnv) -> RunEnv {
        let mut env = base.clone();
        for (name, value) in &self.vars {
            match value {
                Some(value) => env.set(name, value.clone()),
                None => env.remove(name),
            }
        }
        env
    }
}

/// The state of every provider instance, in order. A folder that fails the rules in `provider_folder` is an error
/// whatever the shell says, and an instance that is turned off is never ready.
pub fn states(providers: &[ProviderInstance], places: &Places, shell: Option<&RunEnv>) -> Vec<(String, ProviderState)> {
    let problems = provider_folder::problems(providers, places, shell);
    let home = places.home.unwrap_or(Path::new(""));
    providers
        .iter()
        .map(|p| {
            let state = match problems.get(&p.id) {
                _ if !p.enabled => ProviderState::Off,
                Some(problem) if p.config.config_dir.is_some() => ProviderState::Error(format!("This folder can't be used: {problem}")),
                Some(problem) => ProviderState::Error(problem.clone()),
                None => ProviderEnv::resolve(p, shell, home).map_or_else(ProviderState::Unavailable, ProviderState::Ready),
            };
            (p.id.clone(), state)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{Driver, ProviderConfig};

    fn instance(id: &str, driver: Driver, folder: Option<&str>) -> ProviderInstance {
        ProviderInstance { id: id.into(), driver, display_name: id.into(), enabled: true, config: ProviderConfig { config_dir: folder.map(Into::into), ..Default::default() }, extra: Default::default() }
    }

    fn shell() -> RunEnv {
        RunEnv::from_pairs([
            ("PATH", "/usr/bin"),
            ("CLAUDE_CONFIG_DIR", "/Users/x/.claude-shell"),
            ("ANTHROPIC_API_KEY", "sk-shell"),
            ("OPENAI_API_KEY", "sk-openai"),
            ("CODEX_HOME", "/Users/x/.codex-shell"),
        ])
    }

    fn resolved(instance: &ProviderInstance, shell: Option<&RunEnv>) -> Option<RunEnv> {
        let base = RunEnv::from_pairs([("PATH", "/bin"), ("ANTHROPIC_AUTH_TOKEN", "from-the-app")]);
        ProviderEnv::resolve(instance, shell, Path::new("/Users/x")).ok().map(|e| e.over(&base))
    }

    #[test]
    fn with_no_folder_the_login_variables_are_the_shells_and_the_rest_of_the_base_is_kept() {
        let env = resolved(&instance("claude", Driver::Claude, None), Some(&shell())).unwrap();
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").unwrap(), "/Users/x/.claude-shell");
        assert_eq!(env.get("ANTHROPIC_API_KEY").unwrap(), "sk-shell");
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), None, "a login variable the shell lacks is not taken from the base");
        assert_eq!(env.get("PATH").unwrap(), "/bin");
        assert_eq!(env.get("OPENAI_API_KEY"), None, "another driver's variables are not Claude's business");
    }

    #[test]
    fn a_folder_sets_its_variable_and_drops_every_other_login_variable() {
        let env = resolved(&instance("claude_2", Driver::Claude, Some("~/.claude-work")), Some(&shell())).unwrap();
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").unwrap(), "/Users/x/.claude-work");
        assert_eq!(env.get("ANTHROPIC_API_KEY"), None);
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), None);
        assert_eq!(env.get("PATH").unwrap(), "/bin");

        let codex = resolved(&instance("codex", Driver::Codex, Some("/Users/x/.codex-work")), Some(&shell())).unwrap();
        assert_eq!((codex.get("CODEX_HOME").unwrap(), codex.get("OPENAI_API_KEY")), ("/Users/x/.codex-work".as_ref(), None));
    }

    #[test]
    fn a_folder_needs_no_shell_but_no_folder_does() {
        assert!(resolved(&instance("claude_2", Driver::Claude, Some("~/.claude-work")), None).is_some());
        let none = ProviderEnv::resolve(&instance("claude", Driver::Claude, None), None, Path::new("/Users/x"));
        assert_eq!(none, Err(Unavailable::NoShellSetup));
    }

    #[test]
    fn a_folder_that_fails_the_rules_never_becomes_a_ready_environment() {
        let places = Places { home: Some(Path::new("/Users/x")), data_dir: Path::new("/Users/x/data") };
        let shell = shell();
        for folder in ["/tmp/shared", "relative/dir", "~/it's", "~", "/Users/x/.claude"] {
            let states = states(&[instance("a", Driver::Claude, Some(folder))], &places, Some(&shell));
            assert!(matches!(&states[0].1, ProviderState::Error(e) if e.starts_with("This folder can't be used: ")), "{folder}: {states:?}");
        }
    }

    #[test]
    fn an_instance_that_is_off_is_never_ready() {
        let places = Places { home: Some(Path::new("/Users/x")), data_dir: Path::new("/Users/x/data") };
        let mut off = instance("a", Driver::Claude, Some("~/.claude-work"));
        off.enabled = false;
        assert_eq!(states(&[off], &places, Some(&shell()))[0].1, ProviderState::Off);
    }

    #[test]
    fn a_second_instance_without_a_folder_gets_the_problem_without_the_folder_prefix() {
        let places = Places { home: Some(Path::new("/Users/x")), data_dir: Path::new("/Users/x/data") };
        let list = [instance("a", Driver::Claude, None), instance("b", Driver::Claude, None)];
        assert_eq!(states(&list, &places, Some(&shell()))[1].1, ProviderState::Error("Your usual setup is already added as a.".into()));
    }

    #[test]
    fn debug_never_prints_values() {
        let env = ProviderEnv::resolve(&instance("claude", Driver::Claude, None), Some(&shell()), Path::new("/Users/x")).unwrap();
        assert!(!format!("{env:?}").contains("sk-shell"));
    }
}
