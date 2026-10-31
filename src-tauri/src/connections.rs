//! The connection instances kept in `config.json`: the rows Settings lists, each bound to the account it signs in as.

use serde::{Deserialize, Serialize};

use crate::config::AppConfig;
use crate::tracker::ConnectionKind;

/// The version of the `connections` block this build writes. A file with a higher one is left alone.
pub const VERSION: u32 = 1;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub kind: ConnectionKind,
    pub display_name: String,
    pub enabled: bool,
    pub config: InstanceConfig,
    /// The connection this instance signs in as. A hint: the vault and the databases say which connections exist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_to: Option<String>,
}

/// An account that an instance should be bound to. `name` is the Jira site's name or the GitHub login.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub kind: ConnectionKind,
    pub connection_id: String,
    pub name: String,
    pub config: InstanceConfig,
}

impl Binding {
    pub fn jira(connection_id: &str, site_name: &str, site_url: &str) -> Self {
        let host = site_url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
        Self { kind: ConnectionKind::Jira, connection_id: connection_id.into(), name: site_name.into(), config: InstanceConfig { site: Some(host.into()), ..Default::default() } }
    }

    pub fn with_email(mut self, email: &str) -> Self {
        self.config.email = Some(email.into());
        self
    }

    pub fn github(login: &str) -> Self {
        let config = InstanceConfig { host: Some("github.com".into()), login: Some(login.into()), ..Default::default() };
        Self { kind: ConnectionKind::Github, connection_id: crate::tracker::Connection::github_id(login), name: login.into(), config }
    }
}

fn kind_name(kind: ConnectionKind) -> &'static str {
    match kind {
        ConnectionKind::Jira => "jira",
        ConnectionKind::Github => "github",
    }
}

/// `jira`, `github`, then `github_2`, `github_3`. A removed instance's id is retired, so an id never names two rows.
fn next_id(config: &AppConfig, kind: ConnectionKind) -> String {
    let name = kind_name(kind);
    let taken = config.connections.iter().map(|i| i.id.as_str()).chain(config.retired_ids.iter().map(String::as_str));
    let highest = taken
        .filter_map(|id| match id.strip_prefix(name)? {
            "" => Some(1),
            rest => rest.strip_prefix('_')?.parse::<u32>().ok(),
        })
        .max();
    match highest {
        None => name.to_string(),
        Some(n) => format!("{name}_{}", n + 1),
    }
}

/// Binds an instance to `binding`. Jira has one instance, which signing in again rebinds; a GitHub account that already
/// has an instance keeps it.
pub fn bind(config: &mut AppConfig, binding: Binding) {
    let existing = config.connections.iter().position(|i| match binding.kind {
        ConnectionKind::Jira => i.kind == ConnectionKind::Jira,
        ConnectionKind::Github => i.bound_to.as_deref() == Some(binding.connection_id.as_str()),
    });
    let display_name = match binding.kind {
        ConnectionKind::Jira => binding.name.clone(),
        ConnectionKind::Github if config.connections.iter().any(|i| i.kind == ConnectionKind::Github) => format!("GitHub ({})", binding.name),
        ConnectionKind::Github => "GitHub".into(),
    };
    match existing {
        Some(at) => {
            let instance = &mut config.connections[at];
            instance.bound_to = Some(binding.connection_id);
            instance.config = binding.config;
            if binding.kind == ConnectionKind::Jira {
                instance.display_name = display_name;
            }
        }
        None => {
            let id = next_id(config, binding.kind);
            config.connections.push(Instance { id, kind: binding.kind, display_name, enabled: true, config: binding.config, bound_to: Some(binding.connection_id) });
        }
    }
}

/// Removes the instance bound to `connection_id` and retires its id.
pub fn unbind(config: &mut AppConfig, connection_id: &str) {
    let Some(at) = config.connections.iter().position(|i| i.bound_to.as_deref() == Some(connection_id)) else { return };
    let gone = config.connections.remove(at);
    config.retired_ids.push(gone.id);
}

/// Whether instances may be changed: they have been created from the sign-ins already there, and the list was readable.
pub fn is_live(config: &AppConfig) -> bool {
    config.version == VERSION && config.connections_error.is_none()
}

/// Creates the instances for the sign-ins already there, and says whether it changed `config`. It does nothing unless
/// `sources_readable`: a Keychain item that could not be read looks like no account, and would record a list without it.
pub fn adopt(config: &mut AppConfig, sources_readable: bool, jira: Option<Binding>, github: Vec<Binding>) -> bool {
    if !sources_readable || config.connections_error.is_some() || config.version >= VERSION {
        return false;
    }
    for binding in jira.into_iter().chain(github) {
        bind(config, binding);
    }
    config.version = VERSION;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(config: &AppConfig) -> Vec<&str> {
        config.connections.iter().map(|i| i.id.as_str()).collect()
    }

    #[test]
    fn the_first_sign_ins_become_jira_github_and_github_2_in_the_order_given() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, Some(Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")), vec![Binding::github("Alfhen"), Binding::github("bob")]);
        assert_eq!(ids(&config), ["jira", "github", "github_2"]);
        assert_eq!(config.version, VERSION);
        let names: Vec<_> = config.connections.iter().map(|i| (i.display_name.as_str(), i.bound_to.as_deref())).collect();
        assert_eq!(names, [("Acme", Some("jira:c1:a1")), ("GitHub", Some("github:alfhen")), ("GitHub (bob)", Some("github:bob"))]);
        assert_eq!(config.connections[0].config.site.as_deref(), Some("acme.atlassian.net"));
        assert_eq!(config.connections[1].config.login.as_deref(), Some("Alfhen"));
        assert!(config.connections.iter().all(|i| i.enabled));
    }

    #[test]
    fn nothing_is_adopted_while_the_vault_could_not_be_read() {
        let mut config = AppConfig::default();
        assert!(!adopt(&mut config, false, None, Vec::new()));
        assert_eq!((config.version, config.connections.len()), (0, 0), "an unreadable Keychain must not record an empty list");
        assert!(adopt(&mut config, true, None, vec![Binding::github("ann")]));
        assert_eq!(ids(&config), ["github"]);
    }

    #[test]
    fn adopting_runs_once() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, None, vec![Binding::github("ann")]);
        assert!(!adopt(&mut config, true, None, vec![Binding::github("ann"), Binding::github("bob")]));
        assert_eq!(ids(&config), ["github"]);
    }

    #[test]
    fn a_removed_instances_id_is_never_given_out_again() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, None, vec![Binding::github("ann"), Binding::github("bob")]);
        unbind(&mut config, "github:ann");
        assert_eq!(ids(&config), ["github_2"]);
        bind(&mut config, Binding::github("cy"));
        assert_eq!(ids(&config), ["github_2", "github_3"]);
        unbind(&mut config, "github:cy");
        bind(&mut config, Binding::github("cy"));
        assert_eq!(ids(&config), ["github_2", "github_4"]);
    }

    #[test]
    fn connecting_an_account_that_has_an_instance_keeps_it() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, None, vec![Binding::github("ann")]);
        config.connections[0].display_name = "Work".into();
        bind(&mut config, Binding::github("Ann"));
        assert_eq!(config.connections.len(), 1);
        assert_eq!(config.connections[0].display_name, "Work");
    }

    #[test]
    fn signing_in_to_another_jira_site_rebinds_the_one_jira_instance() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, Some(Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")), Vec::new());
        config.connections[0].enabled = false;
        bind(&mut config, Binding::jira("jira:c2:a9", "Globex", "https://globex.atlassian.net/"));
        assert_eq!(ids(&config), ["jira"]);
        let jira = &config.connections[0];
        assert_eq!((jira.display_name.as_str(), jira.bound_to.as_deref(), jira.config.site.as_deref(), jira.enabled), ("Globex", Some("jira:c2:a9"), Some("globex.atlassian.net"), false));
    }

    #[test]
    fn instances_serialize_in_the_shape_config_json_documents() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, Some(Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")), Vec::new());
        let json = serde_json::to_value(&config.connections[0]).unwrap();
        assert_eq!(json, serde_json::json!({ "id": "jira", "kind": "jira", "displayName": "Acme", "enabled": true, "config": { "site": "acme.atlassian.net" }, "boundTo": "jira:c1:a1" }));
    }
}
