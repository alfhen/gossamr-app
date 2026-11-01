//! Core's side of the provider instances: what each one may run as.

use super::Core;
use crate::config::AppConfig;
use crate::runs::provider_env::{states, ProviderState};
use crate::runs::provider_folder::Places;

impl Core {
    /// The state of every provider instance, in order. The folder rules run on the list as it is now, and a failed
    /// capture of the shell makes the instance without a folder unavailable, never the app's own environment.
    pub async fn provider_states(&self) -> Vec<(String, ProviderState)> {
        let config = AppConfig::load(&self.data_dir);
        if config.providers.is_empty() || config.providers_error.is_some() || config.connections_error.is_some() {
            return Vec::new();
        }
        let shell = self.shell.get().await.inspect_err(|e| eprintln!("{e}")).ok();
        let places = Places { home: self.home.as_deref(), data_dir: &self.data_dir };
        states(&config.providers, &places, shell.as_deref())
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
}
