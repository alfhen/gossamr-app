//! Core's side of the connection instances: creating them from the sign-ins already there, keeping them in step with
//! signing in and out, and naming each connection by its instance.

use super::{ConnectionInfo, Core};
use crate::config::AppConfig;
use crate::connections::{self, Binding};
use crate::error::{Error, Result};
use crate::secrets;
use crate::tracker::Connection;

const NAME_LIMIT: usize = 60;

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Input("Give the connection a name.".into()));
    }
    if name.chars().count() > NAME_LIMIT {
        return Err(Error::Input(format!("Use {NAME_LIMIT} characters or fewer.")));
    }
    if name.chars().any(char::is_control) {
        return Err(Error::Input("A name can't hold line breaks or other control characters.".into()));
    }
    Ok(name.into())
}

impl Core {
    /// Creates the instances for the Jira and GitHub sign-ins restored from the Keychain, once. It leaves `config.json`
    /// alone unless there is something to adopt, and does nothing while any of the sign-ins it reads failed to load.
    pub async fn adopt_instances(&self) {
        let config = AppConfig::load(&self.data_dir);
        if let Some(problem) = &config.connections_error {
            eprintln!("{problem}");
            return;
        }
        if config.version >= connections::VERSION {
            return;
        }
        let jira = match (self.auth.connection().await, self.auth.identity().await) {
            (Some(Connection { id, .. }), Some((_, site, _))) => Some(Binding::jira(&id, &site.name, &site.url)),
            _ => None,
        };
        let logins = self.code.auth.try_logins();
        if let Err(e) = &logins {
            eprintln!("couldn't read the saved GitHub sign-ins, so the connections aren't adopted yet: {e}");
        }
        let readable = secrets::is_ready() && !self.auth.restore_failed() && logins.is_ok();
        let github = logins.unwrap_or_default().iter().map(|login| Binding::github(login)).collect();
        let adopted = AppConfig::update_if(&self.data_dir, |config| connections::adopt(config, readable, jira, github));
        if let Err(e) = adopted {
            eprintln!("couldn't save the connections to config.json: {e}");
        }
    }

    pub(super) fn bind_instance(&self, binding: Binding) {
        self.change_instances(|config| connections::bind(config, binding));
        self.probes_rebound();
    }

    pub(super) fn unbind_instance(&self, connection_id: &str) {
        self.change_instances(|config| connections::unbind(config, connection_id));
    }

    /// Saves the name Settings shows for `instance_id`, and returns the connection (or instance) to tell the page about.
    pub fn rename_instance(&self, instance_id: &str, name: &str) -> Result<String> {
        let name = clean_name(name)?;
        let mut renamed = None;
        AppConfig::update_if(&self.data_dir, |config| {
            let Some(instance) = connections::is_live(config).then(|| config.connections.iter_mut().find(|i| i.id == instance_id)).flatten() else {
                return false;
            };
            instance.display_name = name.clone();
            renamed = Some(instance.bound_to.clone().unwrap_or_else(|| instance.id.clone()));
            true
        })?;
        renamed.ok_or_else(|| Error::Input("This connection is gone. Reopen Settings.".into()))
    }

    fn change_instances(&self, change: impl FnOnce(&mut AppConfig)) {
        let saved = AppConfig::update_if(&self.data_dir, |config| {
            let live = connections::is_live(config);
            if live {
                change(config);
            }
            live
        });
        if let Err(e) = saved {
            eprintln!("couldn't save the connections to config.json: {e}");
        }
    }

    /// Fills in the instance each connection belongs to; one with no instance yet is its own.
    pub(super) fn name_instances(&self, infos: &mut [ConnectionInfo]) {
        let config = AppConfig::load(&self.data_dir);
        for info in infos {
            if let Some(instance) = config.connections.iter().find(|i| i.bound_to.as_deref() == Some(info.id.as_str())) {
                info.instance_id = instance.id.clone();
                info.display_name = instance.display_name.clone();
                info.enabled = instance.enabled;
                info.status = self.probe_snapshot(instance);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::testing::fixture_with_authenticator;

    async fn adopted() -> crate::inbox::testing::Fixture {
        let fx = fixture_with_authenticator(None, None).await;
        fx.core.adopt_instances().await;
        fx.core.bind_instance(connections::Binding::github("alfhen"));
        fx
    }

    fn names(fx: &crate::inbox::testing::Fixture) -> Vec<String> {
        AppConfig::load(&fx.core.data_dir()).connections.into_iter().map(|i| i.display_name).collect()
    }

    #[tokio::test]
    async fn renaming_an_instance_saves_the_trimmed_name_and_names_the_connection_to_refresh() {
        let fx = adopted().await;
        assert_eq!(fx.core.rename_instance("github", "  Work GitHub ").unwrap(), "github:alfhen");
        assert!(names(&fx).contains(&"Work GitHub".to_string()));
    }

    #[tokio::test]
    async fn a_name_that_is_empty_too_long_or_has_a_line_break_is_refused_and_nothing_is_saved() {
        let fx = adopted().await;
        let before = names(&fx);
        for bad in ["   ", &"x".repeat(NAME_LIMIT + 1), "Work\nGitHub"] {
            assert!(matches!(fx.core.rename_instance("github", bad), Err(Error::Input(_))), "{bad:?}");
        }
        assert_eq!(names(&fx), before);
    }

    #[tokio::test]
    async fn renaming_an_instance_that_is_gone_says_so() {
        let fx = adopted().await;
        assert!(matches!(fx.core.rename_instance("github_9", "Other"), Err(Error::Input(_))));
    }
}
