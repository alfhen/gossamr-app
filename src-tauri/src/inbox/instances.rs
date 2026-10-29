//! Core's side of the connection instances: creating them from the sign-ins already there, keeping them in step with
//! signing in and out, and naming each connection by its instance.

use super::{ConnectionInfo, Core};
use crate::config::AppConfig;
use crate::connections::{self, Binding};
use crate::secrets;
use crate::tracker::Connection;

impl Core {
    /// Creates the instances for the Jira and GitHub sign-ins restored from the Keychain, once.
    pub async fn adopt_instances(&self) {
        let jira = match (self.auth.connection().await, self.auth.identity().await) {
            (Some(Connection { id, .. }), Some((_, site, _))) => Some(Binding::jira(&id, &site.name, &site.url)),
            _ => None,
        };
        let github = self.code.auth.logins().iter().map(|login| Binding::github(login)).collect();
        let vault_ready = secrets::is_ready();
        let adopted = AppConfig::update(&self.data_dir, |config| connections::adopt(config, vault_ready, jira, github));
        if let Err(e) = adopted {
            eprintln!("couldn't save the connections to config.json: {e}");
        }
        if let Some(problem) = AppConfig::load(&self.data_dir).connections_error {
            eprintln!("{problem}");
        }
    }

    pub(super) fn bind_instance(&self, binding: Binding) {
        self.change_instances(|config| connections::bind(config, binding));
    }

    pub(super) fn unbind_instance(&self, connection_id: &str) {
        self.change_instances(|config| connections::unbind(config, connection_id));
    }

    fn change_instances(&self, change: impl FnOnce(&mut AppConfig)) {
        let saved = AppConfig::update(&self.data_dir, |config| {
            if connections::is_live(config) {
                change(config);
            }
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
            }
        }
    }
}
