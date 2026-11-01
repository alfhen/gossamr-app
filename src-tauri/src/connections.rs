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
    /// When it was turned back on, until a sync that began after has checked its waiting drafts. Kept in the file so a restart doesn't lift the hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recheck_since: Option<chrono::DateTime<chrono::Utc>>,
}

/// The coding CLI a provider instance runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Claude,
    Codex,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    /// The folder holding this instance's CLI login, as typed (`~` kept). None means the CLI's own default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// Settings a later build wrote that this one doesn't read. They are saved back as they were.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One login of a coding CLI. It sits in `providers` beside `connections` and has no cache or `boundTo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstance {
    pub id: String,
    pub driver: Driver,
    pub display_name: String,
    pub enabled: bool,
    pub config: ProviderConfig,
    /// Keys a later build wrote on the instance that this one doesn't read. They are saved back as they were.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// What a row of Settings is: a connection of either kind, or a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    Jira,
    Github,
    Provider,
}

impl From<ConnectionKind> for RowKind {
    fn from(kind: ConnectionKind) -> Self {
        match kind {
            ConnectionKind::Jira => Self::Jira,
            ConnectionKind::Github => Self::Github,
        }
    }
}

/// The instance every install starts with. It runs what runs today, so it has no folder.
pub fn default_claude() -> ProviderInstance {
    ProviderInstance { id: DEFAULT_CLAUDE.into(), driver: Driver::Claude, display_name: "Claude".into(), enabled: true, config: ProviderConfig::default(), extra: Default::default() }
}

pub const DEFAULT_CLAUDE: &str = "claude";

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
    let taken = config.connections.iter().map(|i| i.id.as_str()).chain(config.providers.iter().map(|p| p.id.as_str())).chain(config.retired_ids.iter().map(String::as_str));
    let highest = taken
        .filter_map(|id| match id.strip_prefix(name)? {
            "" => Some(1),
            rest => rest.strip_prefix('_')?.parse::<u64>().ok().filter(|n| *n < u64::MAX),
        })
        .max();
    match highest {
        None => name.to_string(),
        Some(n) => format!("{name}_{}", n + 1),
    }
}

/// What `bind` says when the account already has an instance.
pub const ALREADY_HAVE_ACCOUNT: &str = "You already have this account. Use Make a new token on its row.";

fn jira_bound_to(config: &AppConfig, connection_id: &str) -> Option<usize> {
    config.connections.iter().position(|i| i.kind == ConnectionKind::Jira && i.bound_to.as_deref() == Some(connection_id))
}

/// Binds an instance to `binding`. Two instances never bind one account: a Jira account that has one is refused, and a
/// GitHub account that has one keeps it. A second account on a site is named "site (email)".
pub fn bind(config: &mut AppConfig, binding: Binding) -> Result<(), AlreadyBound> {
    match binding.kind {
        ConnectionKind::Jira => {
            if jira_bound_to(config, &binding.connection_id).is_some() {
                return Err(AlreadyBound);
            }
            let repeat = config.connections.iter().any(|i| i.kind == ConnectionKind::Jira && i.config.site == binding.config.site);
            let display_name = match binding.config.email.as_deref().filter(|_| repeat) {
                Some(email) => format!("{} ({email})", binding.name),
                None => binding.name.clone(),
            };
            push_instance(config, binding, display_name);
        }
        ConnectionKind::Github => {
            if config.connections.iter().any(|i| i.bound_to.as_deref() == Some(binding.connection_id.as_str())) {
                return Ok(());
            }
            let display_name = if config.connections.iter().any(|i| i.kind == ConnectionKind::Github) { format!("GitHub ({})", binding.name) } else { "GitHub".into() };
            push_instance(config, binding, display_name);
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub struct AlreadyBound;

fn push_instance(config: &mut AppConfig, binding: Binding, display_name: String) {
    let id = next_id(config, binding.kind);
    config.connections.push(Instance { id, kind: binding.kind, display_name, enabled: true, config: binding.config, bound_to: Some(binding.connection_id), recheck_since: None });
}

/// Points the Jira instance of an account that signing in has just replaced at the new one. The instance keeps its id,
/// switch and name unless the site changed; instances of any other replaced account are removed. Without an instance to
/// carry over, the account is bound as `bind` would.
pub fn rebind(config: &mut AppConfig, replaced: &[String], binding: Binding) -> Result<(), AlreadyBound> {
    let carried = jira_bound_to(config, &binding.connection_id).or_else(|| replaced.iter().find_map(|id| jira_bound_to(config, id)));
    let Some(at) = carried else { return bind(config, binding) };
    let instance = &mut config.connections[at];
    let same_site = instance.config.site == binding.config.site;
    let kept = instance.id.clone();
    instance.bound_to = Some(binding.connection_id);
    instance.config = binding.config;
    if !same_site {
        instance.display_name = binding.name;
    }
    let mut retired = Vec::new();
    config.connections.retain(|i| {
        let stale = i.kind == ConnectionKind::Jira && i.id != kept && i.bound_to.as_ref().is_some_and(|b| replaced.contains(b));
        if stale {
            retired.push(i.id.clone());
        }
        !stale
    });
    config.retired_ids.extend(retired);
    Ok(())
}

/// Removes the instance bound to `connection_id` and retires its id.
pub fn unbind(config: &mut AppConfig, connection_id: &str) {
    if let Some(id) = config.connections.iter().find(|i| i.bound_to.as_deref() == Some(connection_id)).map(|i| i.id.clone()) {
        remove(config, &id);
    }
}

/// Removes the instance `id` and retires its id. Says whether it was there.
pub fn remove(config: &mut AppConfig, id: &str) -> bool {
    let Some(at) = config.connections.iter().position(|i| i.id == id) else { return false };
    let gone = config.connections.remove(at);
    config.retired_ids.push(gone.id);
    true
}

/// Whether providers may be changed. A removal retires an id, which lives in the connections block, so that has to be readable too.
pub fn providers_live(config: &AppConfig) -> bool {
    config.providers_error.is_none() && config.connections_error.is_none()
}

pub fn provider_mut<'a>(config: &'a mut AppConfig, id: &str) -> Option<&'a mut ProviderInstance> {
    providers_live(config).then(|| config.providers.iter_mut().find(|p| p.id == id)).flatten()
}

/// Removes the provider instance `id` and retires its id. Nothing on disk is touched, including its config folder.
pub fn remove_provider(config: &mut AppConfig, id: &str) -> bool {
    let Some(at) = config.providers.iter().position(|p| p.id == id) else { return false };
    let gone = config.providers.remove(at);
    config.retired_ids.push(gone.id);
    true
}

/// Whether instances may be changed: they have been created from the sign-ins already there, and the list was readable.
pub fn is_live(config: &AppConfig) -> bool {
    config.version == VERSION && config.connections_error.is_none()
}

/// Creates the instances for the sign-ins already there, and says whether it changed `config`. It does nothing unless
/// `sources_readable`: a Keychain item that could not be read looks like no account, and would record a list without it.
pub fn adopt(config: &mut AppConfig, sources_readable: bool, jira: Vec<Binding>, github: Vec<Binding>) -> bool {
    if !sources_readable || config.connections_error.is_some() || config.version >= VERSION {
        return false;
    }
    for binding in jira.into_iter().chain(github) {
        let _ = bind(config, binding);
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
        adopt(&mut config, true, vec![Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")], vec![Binding::github("Alfhen"), Binding::github("bob")]);
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
        assert!(!adopt(&mut config, false, Vec::new(), Vec::new()));
        assert_eq!((config.version, config.connections.len()), (0, 0), "an unreadable Keychain must not record an empty list");
        assert!(adopt(&mut config, true, Vec::new(), vec![Binding::github("ann")]));
        assert_eq!(ids(&config), ["github"]);
    }

    #[test]
    fn adopting_runs_once() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, Vec::new(), vec![Binding::github("ann")]);
        assert!(!adopt(&mut config, true, Vec::new(), vec![Binding::github("ann"), Binding::github("bob")]));
        assert_eq!(ids(&config), ["github"]);
    }

    #[test]
    fn a_removed_instances_id_is_never_given_out_again() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, Vec::new(), vec![Binding::github("ann"), Binding::github("bob")]);
        unbind(&mut config, "github:ann");
        assert_eq!(ids(&config), ["github_2"]);
        bind(&mut config, Binding::github("cy")).unwrap();
        assert_eq!(ids(&config), ["github_2", "github_3"]);
        unbind(&mut config, "github:cy");
        bind(&mut config, Binding::github("cy")).unwrap();
        assert_eq!(ids(&config), ["github_2", "github_4"]);
    }

    #[test]
    fn connecting_an_account_that_has_an_instance_keeps_it() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, Vec::new(), vec![Binding::github("ann")]);
        config.connections[0].display_name = "Work".into();
        bind(&mut config, Binding::github("Ann")).unwrap();
        assert_eq!(config.connections.len(), 1);
        assert_eq!(config.connections[0].display_name, "Work");
    }

    fn acme(connection_id: &str, email: &str) -> Binding {
        Binding::jira(connection_id, "Acme", "https://acme.atlassian.net").with_email(email)
    }

    #[test]
    fn signing_in_to_another_jira_site_rebinds_the_instance_of_the_account_it_replaces() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, vec![Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")], Vec::new());
        config.connections[0].enabled = false;
        rebind(&mut config, &["jira:c1:a1".into()], Binding::jira("jira:c2:a9", "Globex", "https://globex.atlassian.net/")).unwrap();
        assert_eq!(ids(&config), ["jira"]);
        let jira = &config.connections[0];
        assert_eq!((jira.display_name.as_str(), jira.bound_to.as_deref(), jira.config.site.as_deref(), jira.enabled), ("Globex", Some("jira:c2:a9"), Some("globex.atlassian.net"), false));
    }

    #[test]
    fn replacing_an_account_with_another_on_the_same_site_keeps_the_name_you_gave_it() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, vec![acme("jira:c1:a1", "a@acme.com")], Vec::new());
        config.connections[0].display_name = "Work Jira".into();
        rebind(&mut config, &["jira:c1:a1".into()], acme("jira:c1:a2", "b@acme.com")).unwrap();
        assert_eq!(ids(&config), ["jira"]);
        assert_eq!((config.connections[0].display_name.as_str(), config.connections[0].bound_to.as_deref()), ("Work Jira", Some("jira:c1:a2")));
    }

    #[test]
    fn a_second_account_gets_its_own_instance_and_a_repeat_on_one_site_is_named_with_its_email() {
        let mut config = AppConfig::default();
        bind(&mut config, acme("jira:c1:a1", "a@acme.com")).unwrap();
        bind(&mut config, acme("jira:c1:a2", "b@acme.com")).unwrap();
        bind(&mut config, Binding::jira("jira:c2:a1", "Globex", "https://globex.atlassian.net").with_email("a@globex.com")).unwrap();
        assert_eq!(ids(&config), ["jira", "jira_2", "jira_3"]);
        let names: Vec<_> = config.connections.iter().map(|i| i.display_name.as_str()).collect();
        assert_eq!(names, ["Acme", "Acme (b@acme.com)", "Globex"]);
    }

    #[test]
    fn an_account_that_already_has_an_instance_is_refused_a_second() {
        let mut config = AppConfig::default();
        bind(&mut config, acme("jira:c1:a1", "a@acme.com")).unwrap();
        assert_eq!(bind(&mut config, acme("jira:c1:a1", "a@acme.com")), Err(AlreadyBound));
        assert_eq!(ids(&config), ["jira"]);
    }

    #[test]
    fn signing_in_again_as_the_same_account_keeps_its_instance_and_drops_the_instances_of_other_replaced_accounts() {
        let mut config = AppConfig::default();
        bind(&mut config, acme("jira:c1:a1", "a@acme.com")).unwrap();
        bind(&mut config, acme("jira:c1:a2", "b@acme.com")).unwrap();
        rebind(&mut config, &["jira:c1:a1".into(), "jira:c1:a2".into()], acme("jira:c1:a2", "b@acme.com")).unwrap();
        assert_eq!(ids(&config), ["jira_2"]);
        assert_eq!(config.retired_ids, ["jira"]);
    }

    #[test]
    fn instances_serialize_in_the_shape_config_json_documents() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, vec![Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")], Vec::new());
        let json = serde_json::to_value(&config.connections[0]).unwrap();
        assert_eq!(json, serde_json::json!({ "id": "jira", "kind": "jira", "displayName": "Acme", "enabled": true, "config": { "site": "acme.atlassian.net" }, "boundTo": "jira:c1:a1" }));
    }

    fn provider(id: &str, driver: Driver) -> ProviderInstance {
        ProviderInstance { id: id.into(), driver, display_name: id.into(), enabled: true, config: ProviderConfig::default(), extra: Default::default() }
    }

    #[test]
    fn ids_are_counted_across_connections_and_providers_and_retired_ids() {
        let mut config = AppConfig::default();
        config.providers.push(provider("jira_3", Driver::Claude));
        assert_eq!(next_id(&config, ConnectionKind::Jira), "jira_4");
        config.connections.push(Instance { id: "github_5".into(), kind: ConnectionKind::Github, display_name: "G".into(), enabled: true, config: InstanceConfig::default(), bound_to: None, recheck_since: None });
        config.retired_ids.push("github_6".into());
        assert_eq!(next_id(&config, ConnectionKind::Github), "github_7");
    }

    #[test]
    fn an_id_with_the_largest_suffix_does_not_wrap_the_next_id() {
        let mut config = AppConfig::default();
        config.providers.push(provider(&format!("github_{}", u64::MAX), Driver::Claude));
        assert_eq!(next_id(&config, ConnectionKind::Github), "github");
    }

    #[test]
    fn removing_a_provider_retires_its_id_and_leaves_the_others() {
        let mut config = AppConfig::default();
        config.providers = vec![provider("claude", Driver::Claude), provider("claude_2", Driver::Claude)];
        assert!(remove_provider(&mut config, "claude"));
        assert!(!remove_provider(&mut config, "claude"));
        assert_eq!((config.providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), config.retired_ids.clone()), (vec!["claude_2"], vec!["claude".to_string()]));
    }

    #[test]
    fn a_provider_serializes_in_the_shape_config_json_documents() {
        let json = serde_json::to_value(default_claude()).unwrap();
        assert_eq!(json, serde_json::json!({ "id": "claude", "driver": "claude", "displayName": "Claude", "enabled": true, "config": {} }));
        let codex: ProviderInstance = serde_json::from_str(r#"{"id":"codex","driver":"codex","displayName":"Codex","enabled":true,"config":{"configDir":"~/.codex-work"}}"#).unwrap();
        assert_eq!((codex.driver, codex.config.config_dir.as_deref()), (Driver::Codex, Some("~/.codex-work")));
    }

    #[test]
    fn providers_cant_be_changed_while_either_list_is_unreadable() {
        let mut config = AppConfig::default();
        config.providers.push(provider("claude", Driver::Claude));
        assert!(provider_mut(&mut config, "claude").is_some());
        assert!(provider_mut(&mut config, "jira").is_none());
        config.connections_error = Some("broken".into());
        assert!(provider_mut(&mut config, "claude").is_none());
        config.connections_error = None;
        config.providers_error = Some("broken".into());
        assert!(provider_mut(&mut config, "claude").is_none());
    }
}
