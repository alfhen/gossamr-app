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

impl Driver {
    /// Codex stays off Pip: its built-in tools (a script tool, `collaboration.*`) can't be switched off by any flag, which
    /// rule 3 needs (docs/agents-cli-findings.md, smoke test C1).
    pub fn runs_pip(self) -> bool {
        matches!(self, Self::Claude)
    }

    pub fn runs_agents(self) -> bool {
        matches!(self, Self::Claude)
    }

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

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    /// The folder holding this instance's CLI login, as typed (`~` kept). None means the CLI's own default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// Model ids the person added to this instance's list. Read through `model_choice::model_list`, which drops any that break the id rule.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub custom_models: Vec<String>,
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

/// The Jira instance a page names by its id, or by the connection it is bound to when the row isn't listed yet.
fn jira_instance(config: &AppConfig, id: &str) -> Option<usize> {
    config.connections.iter().position(|i| i.kind == ConnectionKind::Jira && (i.id == id || i.bound_to.as_deref() == Some(id)))
}

/// Whether `connection_id` is bound to an instance other than `replacing`, which signing in would then have to share.
pub fn account_taken(config: &AppConfig, connection_id: &str, replacing: Option<&str>) -> bool {
    let own = replacing.and_then(|id| jira_instance(config, id));
    jira_bound_to(config, connection_id).is_some_and(|at| Some(at) != own)
}

/// Points the Jira instance `instance_id` at `binding`'s account. The instance keeps its id, switch and name unless the
/// site changed. Without such an instance the account is bound as `bind` would.
pub fn replace_account(config: &mut AppConfig, instance_id: &str, binding: Binding) -> Result<(), AlreadyBound> {
    let Some(at) = jira_instance(config, instance_id) else { return bind(config, binding) };
    if account_taken(config, &binding.connection_id, Some(instance_id)) {
        return Err(AlreadyBound);
    }
    let instance = &mut config.connections[at];
    let same_site = instance.config.site == binding.config.site;
    instance.bound_to = Some(binding.connection_id);
    instance.config = binding.config;
    if !same_site {
        instance.display_name = binding.name;
    }
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

/// Removes the provider instance `id` and retires its id, and clears the Settings defaults that named it. Nothing on disk is touched, including its config folder.
pub fn remove_provider(config: &mut AppConfig, id: &str) -> bool {
    let Some(at) = config.providers.iter().position(|p| p.id == id) else { return false };
    let gone = config.providers.remove(at);
    config.retired_ids.push(gone.id);
    config.models.clear_instance(id);
    config.forget_unreadable_models(id);
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
    fn replacing_the_account_with_one_on_another_site_points_the_instance_at_it_and_keeps_its_switch() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, vec![Binding::jira("jira:c1:a1", "Acme", "https://acme.atlassian.net")], Vec::new());
        config.connections[0].enabled = false;
        replace_account(&mut config, "jira", Binding::jira("jira:c2:a9", "Globex", "https://globex.atlassian.net/")).unwrap();
        assert_eq!(ids(&config), ["jira"]);
        let jira = &config.connections[0];
        assert_eq!((jira.display_name.as_str(), jira.bound_to.as_deref(), jira.config.site.as_deref(), jira.enabled), ("Globex", Some("jira:c2:a9"), Some("globex.atlassian.net"), false));
        assert!(config.retired_ids.is_empty());
    }

    #[test]
    fn replacing_an_account_with_another_on_the_same_site_keeps_the_name_you_gave_it() {
        let mut config = AppConfig::default();
        adopt(&mut config, true, vec![acme("jira:c1:a1", "a@acme.com")], Vec::new());
        config.connections[0].display_name = "Work Jira".into();
        replace_account(&mut config, "jira", acme("jira:c1:a2", "b@acme.com")).unwrap();
        assert_eq!(ids(&config), ["jira"]);
        assert_eq!((config.connections[0].display_name.as_str(), config.connections[0].bound_to.as_deref()), ("Work Jira", Some("jira:c1:a2")));
    }

    #[test]
    fn an_instance_is_found_by_the_connection_it_is_bound_to_when_the_id_is_not_listed() {
        let mut config = AppConfig::default();
        bind(&mut config, acme("jira:c1:a1", "a@acme.com")).unwrap();
        bind(&mut config, acme("jira:c1:a2", "b@acme.com")).unwrap();
        replace_account(&mut config, "jira:c1:a2", acme("jira:c1:a3", "c@acme.com")).unwrap();
        let bound: Vec<_> = config.connections.iter().map(|i| i.bound_to.as_deref().unwrap()).collect();
        assert_eq!(bound, ["jira:c1:a1", "jira:c1:a3"]);
    }

    #[test]
    fn replacing_with_an_account_another_instance_has_is_refused_and_changes_nothing() {
        let mut config = AppConfig::default();
        bind(&mut config, acme("jira:c1:a1", "a@acme.com")).unwrap();
        bind(&mut config, acme("jira:c1:a2", "b@acme.com")).unwrap();
        assert!(account_taken(&config, "jira:c1:a2", Some("jira")));
        assert!(!account_taken(&config, "jira:c1:a2", Some("jira_2")), "the instance's own account is not taken from it");
        assert!(!account_taken(&config, "jira:c1:a9", None));
        assert_eq!(replace_account(&mut config, "jira", acme("jira:c1:a2", "b@acme.com")), Err(AlreadyBound));
        let bound: Vec<_> = config.connections.iter().map(|i| i.bound_to.as_deref().unwrap()).collect();
        assert_eq!(bound, ["jira:c1:a1", "jira:c1:a2"]);
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
