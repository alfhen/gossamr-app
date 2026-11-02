//! Core's side of the connection instances: creating them from the sign-ins already there, keeping them in step with
//! signing in and out, and naming each connection by its instance.

use super::{ConnectionInfo, Core};
use crate::config::AppConfig;
use crate::connections::{self, Binding, RowKind};
use crate::db::{connection_of, is_for};
use crate::domain::{Actor, ProposalQuery, ProposalState, Run, RunQuery, RunState, StateKind};
use crate::error::{Error, Result};
use crate::proposals;
use crate::secrets;
use crate::tracker::{Connection, ConnectionKind};
use chrono::Utc;
use std::collections::HashMap;

const NAME_LIMIT: usize = 60;

/// What a removal tells the page to refresh.
#[derive(Debug, PartialEq)]
pub struct Removed {
    pub connection_id: String,
    pub kind: ConnectionKind,
    pub workstreams: bool,
}

/// Which connections are off and what their instances are called, as `Core::off_names` read them.
pub struct OffNames(HashMap<String, String>);

impl OffNames {
    pub fn name(&self, connection_id: &str) -> Option<&str> {
        self.0.get(connection_id).map(String::as_str)
    }
}

struct RemovalTarget {
    kind: ConnectionKind,
    connection_id: String,
    name: String,
    instance_id: Option<String>,
    login: Option<String>,
}

fn refuse_live(runs: &[Run]) -> Result<()> {
    match runs.len() {
        0 => Ok(()),
        _ if runs.iter().all(|r| r.state == RunState::Unknown) => Err(Error::Input("Gossamr can't find its agent's session right now. Try again once it settles.".into())),
        1 => Err(Error::Input("Stop its running agent first.".into())),
        n => Err(Error::Input(format!("Stop its {n} running agents first."))),
    }
}

fn open_drafts_for(db: &crate::db::Db, connection_id: &str) -> Result<Vec<crate::domain::Proposal>> {
    let open = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
    Ok(db.proposals(&open)?.into_iter().filter(|p| is_for(p, connection_id)).collect())
}

pub(super) fn remove_db_files(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

pub(super) fn not_a_provider() -> Error {
    Error::Input("This isn't a provider. Reopen Settings.".into())
}

/// Stands in for providers that can't be read. No provider has this id, so every provider command refuses it.
const UNREADABLE_PROVIDERS_ID: &str = "providers";

fn unreadable_providers_row(problem: String) -> ConnectionInfo {
    ConnectionInfo {
        id: UNREADABLE_PROVIDERS_ID.into(),
        instance_id: UNREADABLE_PROVIDERS_ID.into(),
        display_name: "Models".into(),
        enabled: false,
        kind: RowKind::Provider,
        driver: None,
        config_dir: None,
        workspace: String::new(),
        url: String::new(),
        account: String::new(),
        last_sync_at: None,
        syncing: false,
        error: Some(problem),
        transient: false,
        reauth: false,
        status: None,
        rechecking: false,
    }
}

pub(super) fn clean_name(name: &str) -> Result<String> {
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
    /// Creates the instances for the Jira sign-in and the GitHub accounts already there, once: the logins recorded in the
    /// Keychain, whether an earlier build saved a token for them or they were connected through `gh`. It leaves
    /// `config.json` alone unless there is something to adopt, and does nothing while any of the sign-ins it reads
    /// failed to load.
    pub async fn adopt_instances(&self) {
        let config = AppConfig::load(&self.data_dir);
        if let Some(problem) = &config.providers_error {
            eprintln!("{problem}");
        }
        if let Some(problem) = &config.connections_error {
            eprintln!("{problem}");
            return;
        }
        if config.version >= connections::VERSION {
            return;
        }
        let jira: Vec<Binding> = self.auth.accounts().await.iter().map(|s| Binding::jira(&s.connection.id, &s.site.name, &s.site.url).with_email(&s.email)).collect();
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

    #[cfg(test)]
    pub(super) fn bind_instance(&self, binding: Binding) {
        if let Err(e) = self.try_bind_instance(binding) {
            eprintln!("couldn't save the connections to config.json: {e}");
        }
        self.probes_rebound();
    }

    /// Binds the instance for `binding` when the connections are live, and reports a failed write or an account that
    /// already has an instance.
    pub(super) fn try_bind_instance(&self, binding: Binding) -> Result<()> {
        self.try_change_instances_checked(|config| connections::bind(config, binding))
    }

    /// Points the Jira instance `instance_id` at `binding`'s account, which the next probe asks about.
    pub(super) fn rebind_instance(&self, instance_id: &str, binding: Binding) -> Result<()> {
        self.try_change_instances_checked(|config| connections::replace_account(config, instance_id, binding))?;
        self.probes_rebound();
        Ok(())
    }

    /// Refuses an account that an instance other than `replacing` already has.
    pub(super) fn refuse_taken_account(&self, connection_id: &str, replacing: Option<&str>) -> Result<()> {
        let config = AppConfig::load(&self.data_dir);
        if connections::is_live(&config) && connections::account_taken(&config, connection_id, replacing) {
            return Err(Error::Input(connections::ALREADY_HAVE_ACCOUNT.into()));
        }
        Ok(())
    }

    /// The connection the Jira instance `instance_id` is bound to, or `instance_id` itself when no instance is listed
    /// under it, as `require_jira` accepts.
    pub(super) fn bound_account(&self, instance_id: &str) -> String {
        let config = AppConfig::load(&self.data_dir);
        let listed = config.connections.iter().find(|i| i.kind == ConnectionKind::Jira && (i.id == instance_id || i.bound_to.as_deref() == Some(instance_id)));
        listed.and_then(|i| i.bound_to.clone()).unwrap_or_else(|| instance_id.into())
    }

    /// The name Settings shows for `instance_id`, or the id when it isn't listed.
    pub(super) fn instance_name(&self, instance_id: &str) -> String {
        let config = AppConfig::load(&self.data_dir);
        config.connections.iter().find(|i| i.id == instance_id).map_or_else(|| instance_id.into(), |i| i.display_name.clone())
    }

    /// The Jira instance that signing in as `connection_id` should take back instead of adding another: the one bound to
    /// that account, or the only Jira instance, when the account it is bound to has no sign-in (a Keychain that was reset,
    /// a config.json restored from an older copy, or a write that failed). Such an instance has no row to renew.
    pub(super) async fn orphaned_instance(&self, connection_id: &str) -> Option<String> {
        let config = AppConfig::load(&self.data_dir);
        if !connections::is_live(&config) {
            return None;
        }
        let signed_in = self.auth.accounts().await;
        let has_sign_in = |account: &str| signed_in.iter().any(|s| s.connection.id == account);
        let listed: Vec<_> = config.connections.iter().filter(|i| i.kind == ConnectionKind::Jira).collect();
        if let Some(own) = listed.iter().find(|i| i.bound_to.as_deref() == Some(connection_id)) {
            return (!has_sign_in(connection_id)).then(|| own.id.clone());
        }
        match listed.as_slice() {
            [only] if !has_sign_in(only.bound_to.as_deref().unwrap_or(&only.id)) => Some(only.id.clone()),
            _ => None,
        }
    }

    pub(super) fn unbind_instance(&self, connection_id: &str) {
        self.change_instances(|config| connections::unbind(config, connection_id));
    }

    /// Saves the name Settings shows for `instance_id`, and returns the connection (or instance) to tell the page about.
    pub fn rename_instance(&self, instance_id: &str, name: &str) -> Result<String> {
        let name = clean_name(name)?;
        if self.is_provider(instance_id) {
            return self.provider_rename(instance_id, &name);
        }
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

    /// Turns `instance_id` on or off, and returns the connection (or instance) to tell the page about. Turning off refuses
    /// while one of its drafts is being posted. The cache and the token stay either way.
    pub async fn set_instance_enabled(&self, instance_id: &str, enabled: bool) -> Result<String> {
        if self.is_provider(instance_id) {
            return self.provider_set_enabled(instance_id, enabled);
        }
        let _alone = self.sign_in.lock().await;
        let _gate = self.draft_gate.lock().await;
        let config = AppConfig::load(&self.data_dir);
        let instance = connections::is_live(&config).then(|| config.connections.iter().find(|i| i.id == instance_id)).flatten();
        let Some(instance) = instance else { return Err(Error::Input("This connection is gone. Reopen Settings.".into())) };
        let connection_id = instance.bound_to.clone().unwrap_or_else(|| instance.id.clone());
        if !enabled {
            self.refuse_while_posting(&connection_id, &instance.display_name).await?;
        }
        AppConfig::update_if(&self.data_dir, |config| match config.connections.iter_mut().find(|i| i.id == instance_id) {
            Some(instance) if instance.enabled != enabled => {
                instance.enabled = enabled;
                instance.recheck_since = enabled.then(Utc::now);
                true
            }
            _ => false,
        })?;
        Ok(connection_id)
    }

    /// Removes `instance_id`: the token Gossamr stored is forgotten, its cache is deleted, drafts that target it are
    /// closed with a reason and its id is retired. A draft being posted stops it before anything is deleted, and no draft is claimed
    /// for posting until the removal is done. Drafts are
    /// closed last, so a removal that fails leaves them open. `instance_id` may also be a connection no instance
    /// names (the list can't be read, or the connection was never adopted); that one has no id to retire.
    pub async fn remove_instance(&self, instance_id: &str) -> Result<Removed> {
        let _alone = self.sign_in.lock().await;
        let _gate = self.draft_gate.lock().await;
        let target = self.removal_target(instance_id).await?;
        self.refuse_while_posting(&target.connection_id, &target.name).await?;
        if target.kind == ConnectionKind::Jira {
            self.refuse_while_review_listed_under_is_posting(&target.connection_id, &target.name).await?;
            self.refuse_while_running(&target.connection_id).await?;
        }
        match target.kind {
            ConnectionKind::Github => self.forget_github(&target).await?,
            ConnectionKind::Jira => self.forget_jira(&target.connection_id).await?,
        }
        let workstreams = match self.close_drafts_for(&target).await {
            Ok(workstreams) => workstreams,
            Err(e) => {
                eprintln!("couldn't close the drafts for {}: {e}", target.name);
                false
            }
        };
        if let Some(id) = &target.instance_id {
            if let Err(e) = AppConfig::update_if(&self.data_dir, |config| connections::remove(config, id)) {
                eprintln!("couldn't save the connections to config.json: {e}");
            }
            self.probes_forget(id);
        }
        Ok(Removed { connection_id: target.connection_id, kind: target.kind, workstreams })
    }

    async fn removal_target(&self, id: &str) -> Result<RemovalTarget> {
        let config = AppConfig::load(&self.data_dir);
        let listed = connections::is_live(&config).then(|| config.connections.iter().find(|i| i.id == id)).flatten();
        if let Some(instance) = listed {
            let connection_id = instance.bound_to.clone().unwrap_or_else(|| instance.id.clone());
            let login = instance.config.login.clone();
            return Ok(RemovalTarget { kind: instance.kind, connection_id, name: instance.display_name.clone(), instance_id: Some(instance.id.clone()), login });
        }
        if let Some(session) = self.auth.accounts().await.into_iter().find(|s| s.connection.id == id) {
            let connection = session.connection;
            return Ok(RemovalTarget { kind: ConnectionKind::Jira, connection_id: connection.id, name: connection.display_name, instance_id: None, login: None });
        }
        if let Ok(session) = self.code.session(id) {
            return Ok(RemovalTarget { kind: ConnectionKind::Github, connection_id: id.into(), name: "GitHub".into(), instance_id: None, login: Some(session.login) });
        }
        Err(Error::Input("This connection is gone. Reopen Settings.".into()))
    }

    /// The instances that are turned off, read from `config.json` once. A request that looks at several connections takes
    /// one of these instead of calling `off_name` for each.
    pub fn off_names(&self) -> OffNames {
        let config = AppConfig::load(&self.data_dir);
        let mut names = HashMap::new();
        if connections::is_live(&config) {
            for i in config.connections.iter().filter(|i| !i.enabled) {
                names.entry(i.bound_to.clone().unwrap_or_else(|| i.id.clone())).or_insert_with(|| i.display_name.clone());
            }
        }
        OffNames(names)
    }

    /// The name of the instance `connection_id` belongs to, when it is turned off. Nothing is off while the list can't be read.
    pub fn off_name(&self, connection_id: &str) -> Option<String> {
        self.off_names().name(connection_id).map(String::from)
    }

    /// Turns away a read of a connection that is off: its items are hidden from the views, from Pip and from agents.
    pub(super) fn refuse_hidden(&self, connection_id: &str) -> Result<()> {
        match self.off_name(connection_id) {
            Some(name) => Err(Error::Input(format!("{name} is off, so its items are hidden. Turn it on in Settings to read them."))),
            None => Ok(()),
        }
    }

    /// Why a draft for `connection_id` can't be approved yet: its connection is off, or was turned back on and hasn't
    /// synced since. The page words the same notes in `heldNote` (src/lib/proposals.ts).
    pub(super) fn refuse_while_held(&self, connection_id: &str) -> Result<()> {
        if let Some(name) = self.off_name(connection_id) {
            return Err(Error::Proposal(format!("{name} is off. This draft waits until you turn it on.")));
        }
        if self.is_rechecking(connection_id) {
            let name = AppConfig::load(&self.data_dir).connections.iter().find(|i| i.bound_to.as_deref().unwrap_or(&i.id) == connection_id).map(|i| i.display_name.clone());
            return Err(Error::Proposal(format!("Checking this draft against {}.", name.as_deref().unwrap_or("the connection"))));
        }
        Ok(())
    }

    pub(super) fn is_rechecking(&self, connection_id: &str) -> bool {
        let config = AppConfig::load(&self.data_dir);
        connections::is_live(&config) && config.connections.iter().any(|i| i.bound_to.as_deref().unwrap_or(&i.id) == connection_id && i.recheck_since.is_some())
    }

    /// A sync that began at `started` finished well. It ends the recheck only if the connection was turned on before the
    /// sync began; one that was already running when the connection was turned off and on again saw nothing of the new state.
    pub(super) fn finish_recheck(&self, connection_id: &str, started: chrono::DateTime<Utc>) -> bool {
        let mut finished = false;
        let saved = AppConfig::update_if(&self.data_dir, |config| {
            let waiting = config.connections.iter_mut().find(|i| i.bound_to.as_deref().unwrap_or(&i.id) == connection_id && i.recheck_since.is_some_and(|on| on <= started));
            finished = waiting.map(|i| i.recheck_since = None).is_some();
            finished
        });
        if let Err(e) = saved {
            eprintln!("couldn't save that the drafts were checked: {e}");
            return false;
        }
        finished
    }

    /// A review is stored under its ticket's Jira connection, so it vanishes from the registry-limited views once that
    /// connection is removed; posting must finish first.
    async fn refuse_while_review_listed_under_is_posting(&self, connection_id: &str, name: &str) -> Result<()> {
        let posting = self
            .with_app_db(|db| {
                let applying = ProposalQuery { states: Some(vec![StateKind::Applying]), ..Default::default() };
                Ok(db.proposals(&applying)?.iter().any(|p| connection_of(p) == connection_id))
            })
            .await?;
        if posting {
            return Err(Error::Input(format!("Gossamr is posting a draft for {name} right now. Try again in a moment.")));
        }
        Ok(())
    }

    pub(super) async fn refuse_while_posting(&self, connection_id: &str, name: &str) -> Result<()> {
        let posting = self.with_app_db(|db| open_drafts_for(db, connection_id).map(|mine| mine.iter().any(|p| p.state == ProposalState::Applying))).await?;
        if posting {
            return Err(Error::Input(format!("Gossamr is posting a draft for {name} right now. Try again in a moment.")));
        }
        Ok(())
    }

    /// Agents that are running or waiting to start keep their tickets' site, so it stays until they are stopped. Runs
    /// of a connection that has left the registry are invisible to the run service, so nothing could stop them.
    pub(super) async fn refuse_while_running(&self, connection_id: &str) -> Result<()> {
        refuse_live(&self.live_runs(connection_id).await?)
    }

    /// An instance with agents running on it stays, because Gossamr could no longer reach their sessions. Queued runs
    /// don't count: they wait for a new choice.
    async fn refuse_while_instance_runs(&self, instance_id: &str) -> Result<()> {
        let states = RunState::UNFINISHED.into_iter().filter(|s| *s != RunState::Queued).collect();
        let query = RunQuery { states: Some(states), runs_on: Some(instance_id.into()), ..Default::default() };
        refuse_live(&self.with_app_db(|db| db.runs(&query)).await?)
    }

    pub(super) async fn live_runs(&self, connection_id: &str) -> Result<Vec<Run>> {
        let query = RunQuery { states: Some(RunState::UNFINISHED.to_vec()), connection_id: Some(connection_id.into()), ..Default::default() };
        self.with_app_db(|db| db.runs(&query)).await
    }

    /// Closes the pending drafts for the removed connection. Says whether a closed draft was in a workstream.
    async fn close_drafts_for(&self, target: &RemovalTarget) -> Result<bool> {
        self.close_drafts(&target.connection_id, &format!("{} was removed.", target.name)).await
    }

    /// Retires the pending drafts for `connection_id` with `reason`. Says whether a closed draft was in a workstream.
    pub(super) async fn close_drafts(&self, connection_id: &str, reason: &str) -> Result<bool> {
        let now = chrono::Utc::now();
        self.with_app_db(|db| {
            db.atomically(|db| {
                let mut workstreams = false;
                for p in open_drafts_for(db, connection_id)?.into_iter().filter(|p| p.state == ProposalState::Pending) {
                    let closed = proposals::retire(db, &p.id, reason, now)?;
                    proposals::record(db, &closed, Actor::Person, "draft_retired", now);
                    workstreams |= closed.workstream().is_some();
                }
                Ok(workstreams)
            })
        })
        .await
    }

    /// Forgets any GitHub token an earlier build saved and deletes the account's cache, whether or not its session loaded at launch.
    async fn forget_github(&self, target: &RemovalTarget) -> Result<()> {
        match self.github_disconnect(&target.connection_id).await {
            Err(Error::NotSignedIn) => {}
            done => return done,
        }
        let Some(login) = target.login.as_deref() else { return Ok(()) };
        self.code.auth.forget_login(login)?;
        self.registry.remove(&target.connection_id);
        remove_db_files(&self.data_dir.join(super::code::github_db_file(login)));
        Ok(())
    }

    /// Forgets the Jira token of `connection_id` and deletes its cache. The cache goes even when no token was loaded
    /// (the Keychain item couldn't be read, or an earlier removal got as far as the token), so adding the account again
    /// starts empty.
    async fn forget_jira(&self, connection_id: &str) -> Result<()> {
        let held = self.auth.accounts().await.into_iter().map(|s| s.connection).find(|c| c.id == connection_id);
        if held.is_some() {
            self.auth.disconnect(connection_id).await?;
        }
        let Some(connection) = held.or_else(|| Connection::from_jira_id(connection_id)) else { return Ok(()) };
        self.unregister_jira(&connection.id).await;
        self.delete_cache(&connection);
        Ok(())
    }

    pub fn is_provider(&self, instance_id: &str) -> bool {
        AppConfig::load(&self.data_dir).providers.iter().any(|p| p.id == instance_id)
    }

    /// Refuses an id that isn't a Jira instance, so a provider's or GitHub's row can't be signed in as Jira.
    /// A Jira row not yet in the list is named by its connection id, so that is accepted too.
    pub async fn require_jira(&self, instance_id: &str) -> Result<()> {
        let config = AppConfig::load(&self.data_dir);
        let listed = config.connections.iter().any(|i| i.kind == ConnectionKind::Jira && (i.id == instance_id || i.bound_to.as_deref() == Some(instance_id)));
        if listed || self.auth.connections().await.iter().any(|c| c.id == instance_id) {
            return Ok(());
        }
        Err(Error::Input("That isn't a Jira connection.".into()))
    }

    pub fn provider_rename(&self, instance_id: &str, name: &str) -> Result<String> {
        let name = clean_name(name)?;
        self.change_provider(instance_id, |provider| provider.display_name = name)
    }

    pub fn provider_set_enabled(&self, instance_id: &str, enabled: bool) -> Result<String> {
        let id = self.change_provider(instance_id, |provider| provider.enabled = enabled)?;
        if enabled {
            self.provider_answer_forget(instance_id);
        }
        Ok(id)
    }

    /// Removes a provider instance and retires its id. Its config folder and the login in it stay on disk.
    pub async fn provider_remove(&self, instance_id: &str) -> Result<()> {
        let _no_launch = self.launching.lock().await;
        self.refuse_while_instance_runs(instance_id).await?;
        let mut removed = false;
        AppConfig::update_if(&self.data_dir, |config| {
            removed = connections::providers_live(config) && connections::remove_provider(config, instance_id);
            removed
        })?;
        removed.then_some(()).ok_or_else(not_a_provider)?;
        self.provider_probes_forget(instance_id);
        Ok(())
    }

    fn change_provider(&self, instance_id: &str, change: impl FnOnce(&mut connections::ProviderInstance)) -> Result<String> {
        let mut changed = false;
        AppConfig::update_if(&self.data_dir, |config| {
            let Some(provider) = connections::provider_mut(config, instance_id) else { return false };
            change(provider);
            changed = true;
            true
        })?;
        changed.then(|| instance_id.to_string()).ok_or_else(not_a_provider)
    }

    /// The provider instances as Settings rows, after the connections. A providers list that can't be read gives one row
    /// that says so.
    pub(super) fn provider_rows(&self) -> Vec<ConnectionInfo> {
        let config = AppConfig::load(&self.data_dir);
        if let Some(problem) = &config.providers_error {
            eprintln!("{problem}");
            return vec![unreadable_providers_row(problem.clone())];
        }
        if let Some(problem) = &config.connections_error {
            eprintln!("{problem}");
            return Vec::new();
        }
        config
            .providers
            .into_iter()
            .map(|p| {
                let status = self.provider_snapshot(&p.id);
                ConnectionInfo {
                    instance_id: p.id.clone(),
                    id: p.id,
                    display_name: p.display_name,
                    enabled: p.enabled,
                    kind: RowKind::Provider,
                    driver: Some(p.driver),
                    config_dir: p.config.config_dir,
                    workspace: String::new(),
                    url: String::new(),
                    account: String::new(),
                    last_sync_at: None,
                    syncing: false,
                    error: None,
                    transient: false,
                    reauth: false,
                    status,
                    rechecking: false,
                }
            })
            .collect()
    }

    fn try_change_instances_checked(&self, change: impl FnOnce(&mut AppConfig) -> std::result::Result<(), connections::AlreadyBound>) -> Result<()> {
        let mut refused = false;
        self.try_change_instances(|config| refused = change(config).is_err())?;
        if refused {
            return Err(Error::Input(connections::ALREADY_HAVE_ACCOUNT.into()));
        }
        Ok(())
    }

    fn try_change_instances(&self, change: impl FnOnce(&mut AppConfig)) -> Result<()> {
        AppConfig::update_if(&self.data_dir, |config| {
            let live = connections::is_live(config);
            if live {
                change(config);
            }
            live
        })
    }

    fn change_instances(&self, change: impl FnOnce(&mut AppConfig)) {
        if let Err(e) = self.try_change_instances(change) {
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
                info.rechecking = self.is_rechecking(&info.id);
                info.status = self.probe_snapshot(instance);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::db_file;
    use crate::domain::{CreatedBy, Intent, Origin, Proposal};
    use crate::inbox::testing::fixture_with_authenticator;
    use crate::proposals::Draft;

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
    async fn adopting_several_signed_in_accounts_makes_an_instance_for_each_bound_to_its_own() {
        let (fx, _) = crate::inbox::testing::fixture_with_two_jira().await;
        fx.core.adopt_instances().await;
        let config = AppConfig::load(&fx.core.data_dir());
        let rows: Vec<_> = config.connections.iter().map(|i| (i.id.as_str(), i.display_name.as_str(), i.bound_to.as_deref(), i.config.email.as_deref())).collect();
        assert_eq!(rows, [("jira", "Acme", Some("jira:site:me"), Some("me@example.com")), ("jira_2", "Beta", Some("jira:beta:bo"), Some("bo@example.com"))]);
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

    async fn draft_for(fx: &crate::inbox::testing::Fixture, intent: Intent) -> Proposal {
        let draft = Draft { origin: Origin::Board, created_by: CreatedBy::User, intent, label: None, basis: None };
        fx.core.with_app_db(|db| proposals::create(db, draft, chrono::Utc::now())).await.unwrap()
    }

    fn review_on_github(fx: &crate::inbox::testing::Fixture) -> Intent {
        Intent::GithubReview {
            connection_id: "github:alfhen".into(),
            item: Some(fx.item("CA-1")),
            run_id: "run-1".into(),
            repo: "acme/api".into(),
            number: 7,
            commit_sha: "abcdef1234".into(),
            summary: "Looks fine.".into(),
            comments: Vec::new(),
        }
    }

    async fn state_of(fx: &crate::inbox::testing::Fixture, id: &str) -> ProposalState {
        fx.core.with_app_db(|db| Ok(db.proposal(id)?.unwrap().state)).await.unwrap()
    }

    fn ids(fx: &crate::inbox::testing::Fixture) -> Vec<String> {
        AppConfig::load(&fx.core.data_dir()).connections.into_iter().map(|i| i.id).collect()
    }

    #[tokio::test]
    async fn removing_jira_closes_its_drafts_deletes_its_cache_and_leaves_the_review_bound_for_github() {
        let fx = adopted().await;
        let jira = draft_for(&fx, Intent::Transition { item: fx.item("CA-1"), to: "10001".into() }).await;
        let review = draft_for(&fx, review_on_github(&fx)).await;
        let cache = fx.dir.join(db_file(&fx.core.auth.connection().await.unwrap()));
        assert!(cache.exists());

        let removed = fx.core.remove_instance("jira").await.unwrap();
        assert_eq!(removed, Removed { connection_id: "jira:site:me".into(), kind: ConnectionKind::Jira, workstreams: false });

        assert_eq!(state_of(&fx, &jira.id).await, ProposalState::Retired("Acme was removed.".into()));
        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Pending);
        assert!(!cache.exists());
        assert!(fx.core.auth.connection().await.is_none());
        assert_eq!(ids(&fx), ["github"]);
    }

    #[tokio::test]
    async fn removing_github_closes_the_reviews_it_would_post_and_never_gives_its_id_to_the_next_account() {
        let fx = adopted().await;
        let jira = draft_for(&fx, Intent::Transition { item: fx.item("CA-1"), to: "10001".into() }).await;
        let review = draft_for(&fx, review_on_github(&fx)).await;

        fx.core.remove_instance("github").await.unwrap();

        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Retired("GitHub was removed.".into()));
        assert_eq!(state_of(&fx, &jira.id).await, ProposalState::Pending);
        assert_eq!(ids(&fx), ["jira"]);
        fx.core.bind_instance(connections::Binding::github("alfhen"));
        assert_eq!(ids(&fx), ["jira", "github_2"]);
    }

    #[tokio::test]
    async fn a_removal_waits_for_a_draft_that_is_being_claimed_and_goes_ahead_once_it_is_done() {
        let fx = adopted().await;
        let review = draft_for(&fx, review_on_github(&fx)).await;
        let claiming = fx.core.draft_gate.lock().await;

        let waited = tokio::time::timeout(std::time::Duration::from_millis(100), fx.core.remove_instance("github")).await;

        assert!(waited.is_err(), "the removal went ahead while a draft was being claimed");
        assert_eq!(ids(&fx), ["jira", "github"]);
        drop(claiming);
        fx.core.remove_instance("github").await.unwrap();
        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Retired("GitHub was removed.".into()));
    }

    #[tokio::test]
    async fn a_draft_being_posted_stops_the_removal_before_anything_is_deleted() {
        let fx = adopted().await;
        let posting = draft_for(&fx, review_on_github(&fx)).await;
        let waiting = draft_for(&fx, review_on_github(&fx)).await;
        fx.core.with_app_db(|db| db.begin_posting_review(&posting.id, chrono::Utc::now(), None)).await.unwrap();

        let refused = fx.core.remove_instance("github").await.unwrap_err();

        assert!(matches!(&refused, Error::Input(m) if m.contains("posting a draft")), "{refused}");
        assert_eq!(state_of(&fx, &waiting.id).await, ProposalState::Pending);
        assert_eq!(state_of(&fx, &posting.id).await, ProposalState::Applying);
        assert_eq!(ids(&fx), ["jira", "github"]);
    }

    #[tokio::test]
    async fn a_review_being_posted_stops_the_removal_of_the_jira_site_it_is_listed_under() {
        let fx = adopted().await;
        let posting = draft_for(&fx, review_on_github(&fx)).await;
        fx.core.with_app_db(|db| db.begin_posting_review(&posting.id, chrono::Utc::now(), None)).await.unwrap();

        let refused = fx.core.remove_instance("jira").await.unwrap_err();

        assert!(matches!(&refused, Error::Input(m) if m.contains("posting a draft")), "{refused}");
        assert_eq!(ids(&fx), ["jira", "github"]);
    }

    #[tokio::test]
    async fn removing_an_instance_that_is_already_gone_says_so_and_changes_nothing() {
        let fx = adopted().await;
        assert!(matches!(fx.core.remove_instance("github_9").await, Err(Error::Input(_))));
        assert_eq!(ids(&fx), ["jira", "github"]);
    }

    fn enabled(fx: &crate::inbox::testing::Fixture) -> Vec<(String, bool)> {
        AppConfig::load(&fx.core.data_dir()).connections.into_iter().map(|i| (i.id, i.enabled)).collect()
    }

    async fn jira_row(fx: &crate::inbox::testing::Fixture) -> ConnectionInfo {
        fx.core.connections().await.unwrap().into_iter().find(|c| c.instance_id == "jira").unwrap()
    }

    #[tokio::test]
    async fn turning_an_instance_off_and_on_saves_it_and_names_the_connection_to_refresh() {
        let fx = adopted().await;
        assert_eq!(fx.core.set_instance_enabled("github", false).await.unwrap(), "github:alfhen");
        assert_eq!(enabled(&fx), [("jira".into(), true), ("github".into(), false)]);
        assert_eq!(fx.core.set_instance_enabled("github", true).await.unwrap(), "github:alfhen");
        assert_eq!(enabled(&fx), [("jira".into(), true), ("github".into(), true)]);
    }

    #[tokio::test]
    async fn turning_an_instance_back_on_holds_its_drafts_until_a_sync_that_began_after_it_has_finished() {
        let fx = adopted().await;
        fx.core.set_instance_enabled("github", false).await.unwrap();
        let before_on = Utc::now();
        let connection_id = fx.core.set_instance_enabled("github", true).await.unwrap();

        let held = fx.core.refuse_while_held(&connection_id).unwrap_err();
        assert!(held.to_string().contains("Checking this draft against GitHub."), "{held}");
        assert!(!fx.core.finish_recheck(&connection_id, before_on), "a sync that began before the connection was turned on saw none of it");
        assert!(fx.core.refuse_while_held(&connection_id).is_err());

        assert!(fx.core.finish_recheck(&connection_id, Utc::now()));
        fx.core.refuse_while_held(&connection_id).unwrap();
    }

    #[tokio::test]
    async fn an_instance_that_was_never_off_is_not_rechecked_when_it_is_turned_on_again() {
        let fx = adopted().await;

        let connection_id = fx.core.set_instance_enabled("github", true).await.unwrap();

        assert!(!fx.core.is_rechecking(&connection_id));
    }

    #[tokio::test]
    async fn turning_an_instance_off_again_ends_its_recheck_and_the_draft_says_it_is_off() {
        let fx = adopted().await;
        fx.core.set_instance_enabled("github", false).await.unwrap();
        let connection_id = fx.core.set_instance_enabled("github", true).await.unwrap();
        fx.core.set_instance_enabled("github", false).await.unwrap();

        assert!(!fx.core.is_rechecking(&connection_id));
        assert!(fx.core.refuse_while_held(&connection_id).unwrap_err().to_string().contains("is off"));
    }

    #[tokio::test]
    async fn turning_an_instance_off_keeps_its_drafts_its_token_and_its_cache() {
        let fx = adopted().await;
        let review = draft_for(&fx, review_on_github(&fx)).await;
        let cache = fx.dir.join(db_file(&fx.core.auth.connection().await.unwrap()));

        fx.core.set_instance_enabled("github", false).await.unwrap();

        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Pending);
        assert!(cache.exists());
        assert!(fx.core.auth.connection().await.is_some());
    }

    #[tokio::test]
    async fn the_row_says_off_as_soon_as_the_instance_is_turned_off_and_asks_again_when_it_is_turned_on() {
        let fx = adopted().await;
        fx.core.probe_connections(super::super::Probe::Launch).await;

        fx.core.set_instance_enabled("jira", false).await.unwrap();
        fx.core.probe_instance_now("jira").await;
        let off = jira_row(&fx).await;
        assert!(!off.enabled);
        assert_eq!(off.status.map(|s| s.state), Some(crate::probe::State::Off));

        fx.core.set_instance_enabled("jira", true).await.unwrap();
        fx.core.probe_instance_now("jira").await;
        let on = jira_row(&fx).await;
        assert!(on.enabled);
        assert_ne!(on.status.map(|s| s.state), Some(crate::probe::State::Off));
    }

    #[tokio::test]
    async fn a_draft_being_posted_keeps_the_instance_on_but_turning_it_on_never_waits() {
        let fx = adopted().await;
        let posting = draft_for(&fx, review_on_github(&fx)).await;
        fx.core.with_app_db(|db| db.begin_posting_review(&posting.id, chrono::Utc::now(), None)).await.unwrap();

        let refused = fx.core.set_instance_enabled("github", false).await.unwrap_err();

        assert!(matches!(&refused, Error::Input(m) if m.contains("posting a draft for GitHub right now")), "{refused}");
        assert_eq!(enabled(&fx), [("jira".into(), true), ("github".into(), true)]);

        fx.core.set_instance_enabled("jira", false).await.unwrap();
        fx.core.set_instance_enabled("jira", true).await.unwrap();
    }

    #[tokio::test]
    async fn one_read_of_the_off_instances_names_each_connection_that_is_off_and_none_while_the_list_cant_be_read() {
        let fx = adopted().await;
        fx.core.set_instance_enabled("github", false).await.unwrap();

        let off = fx.core.off_names();

        assert_eq!(off.name("github:alfhen"), Some("GitHub"));
        assert_eq!(off.name("jira"), None);
        assert_eq!(fx.core.off_name("github:alfhen").as_deref(), Some("GitHub"));

        std::fs::write(fx.dir.join("config.json"), "{ nope").unwrap();
        assert_eq!(fx.core.off_names().name("github:alfhen"), None);
    }

    #[tokio::test]
    async fn turning_an_instance_back_on_is_never_refused_for_a_draft_being_posted() {
        let fx = adopted().await;
        let posting = draft_for(&fx, review_on_github(&fx)).await;
        fx.core.set_instance_enabled("github", false).await.unwrap();
        fx.core.with_app_db(|db| db.begin_posting_review(&posting.id, chrono::Utc::now(), None)).await.unwrap();

        fx.core.set_instance_enabled("github", true).await.unwrap();

        assert_eq!(enabled(&fx), [("jira".into(), true), ("github".into(), true)]);
    }

    #[tokio::test]
    async fn turning_off_an_instance_that_is_gone_or_while_the_list_cant_be_read_says_so_and_changes_nothing() {
        let fx = adopted().await;
        assert!(matches!(fx.core.set_instance_enabled("github_9", false).await, Err(Error::Input(_))));
        std::fs::write(fx.dir.join("config.json"), "{ nope").unwrap();
        assert!(matches!(fx.core.set_instance_enabled("github", false).await, Err(Error::Input(_))));
        assert_eq!(std::fs::read_to_string(fx.dir.join("config.json")).unwrap(), "{ nope");
    }

    use crate::auth::GithubAuth;
    use crate::inbox::code::{github_db_file, CodeService};

    /// Jira and GitHub's `ann` both connected and adopted. `ann` has a token an earlier build saved. With `restored`
    /// false, the account didn't load at launch.
    async fn with_github(restored: bool) -> (crate::inbox::testing::Fixture, crate::secrets::fake::Fake, crate::secrets::fake::Installed) {
        let vault = crate::secrets::fake::Fake::default();
        vault.put("github-logins", r#"["ann"]"#);
        vault.put("github:ann", "{}");
        let installed = crate::secrets::fake::install(&vault);
        let auth = GithubAuth::for_test(reqwest::Client::new(), "http://unused.invalid", Vec::new());
        let code = CodeService::with_factory(auth, Box::new(|_, _, _| unreachable!("nothing here talks to GitHub")));
        let fx = fixture_with_authenticator(Some(code), None).await;
        if restored {
            fx.core.restore().await;
        }
        fx.core.adopt_instances().await;
        (fx, vault, installed)
    }

    fn review_on_ann(fx: &crate::inbox::testing::Fixture) -> Intent {
        match review_on_github(fx) {
            Intent::GithubReview { item, run_id, repo, number, commit_sha, summary, comments, .. } => {
                Intent::GithubReview { connection_id: "github:ann".into(), item, run_id, repo, number, commit_sha, summary, comments }
            }
            other => other,
        }
    }

    fn cache_files(fx: &crate::inbox::testing::Fixture) -> Vec<std::path::PathBuf> {
        let base = fx.dir.join(github_db_file("ann"));
        ["", "-wal", "-shm"].iter().map(|suffix| std::path::PathBuf::from(format!("{}{suffix}", base.display()))).collect()
    }

    fn leave_cache(fx: &crate::inbox::testing::Fixture) {
        for file in cache_files(fx) {
            std::fs::write(file, "x").unwrap();
        }
    }

    #[tokio::test]
    async fn removing_github_forgets_its_session_and_token_and_deletes_every_cache_file() {
        let (fx, vault, _installed) = with_github(true).await;
        leave_cache(&fx);
        let review = draft_for(&fx, review_on_ann(&fx)).await;

        let removed = fx.core.remove_instance("github").await.unwrap();

        assert_eq!(removed, Removed { connection_id: "github:ann".into(), kind: ConnectionKind::Github, workstreams: false });
        assert_eq!((vault.get("github:ann"), fx.core.code.auth.logins().is_empty()), (None, true));
        assert!(fx.core.code.connection_ids().is_empty());
        assert!(cache_files(&fx).iter().all(|f| !f.exists()));
        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Retired("GitHub was removed.".into()));
        assert_eq!(ids(&fx), ["jira"]);
    }

    #[tokio::test]
    async fn removing_a_github_account_whose_session_didnt_load_still_forgets_its_token_and_cache() {
        let (fx, vault, _installed) = with_github(false).await;
        leave_cache(&fx);
        assert_eq!(ids(&fx), ["jira", "github"]);

        fx.core.remove_instance("github").await.unwrap();

        assert_eq!((vault.get("github:ann"), fx.core.code.auth.logins().is_empty()), (None, true));
        assert!(cache_files(&fx).iter().all(|f| !f.exists()));
        assert_eq!(ids(&fx), ["jira"]);
    }

    #[tokio::test]
    async fn a_github_token_that_wont_delete_leaves_the_connection_and_its_drafts_as_they_were() {
        let (fx, vault, _installed) = with_github(true).await;
        leave_cache(&fx);
        let review = draft_for(&fx, review_on_ann(&fx)).await;
        vault.deny_writes(true);

        assert!(fx.core.remove_instance("github").await.is_err());

        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Pending);
        assert_eq!(fx.core.code.auth.logins(), ["ann"]);
        assert_eq!(fx.core.code.connection_ids(), ["github:ann"]);
        assert!(cache_files(&fx).iter().all(|f| f.exists()));
        assert_eq!(ids(&fx), ["jira", "github"]);
    }

    #[tokio::test]
    async fn a_jira_token_that_wont_delete_leaves_the_connection_its_cache_and_its_drafts_as_they_were() {
        let fx = adopted().await;
        let jira = draft_for(&fx, Intent::Transition { item: fx.item("CA-1"), to: "10001".into() }).await;
        let cache = fx.dir.join(db_file(&fx.core.auth.connection().await.unwrap()));
        let fake = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&fake);
        fake.deny_writes(true);

        assert!(fx.core.remove_instance("jira").await.is_err());

        assert_eq!(state_of(&fx, &jira.id).await, ProposalState::Pending);
        assert!(fx.core.auth.connection().await.is_some());
        assert!(cache.exists());
        assert_eq!(ids(&fx), ["jira", "github"]);
    }

    #[tokio::test]
    async fn removing_either_connection_keeps_pips_conversations() {
        let fx = adopted().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Hi", &crate::agent::TurnMeta::default(), "done").await.unwrap();
        let turns = || fx.core.with_app_db(|db| Ok(db.pip_turns("general")?.len()));

        fx.core.remove_instance("github").await.unwrap();
        assert_eq!(turns().await.unwrap(), 1);

        fx.core.remove_instance("jira").await.unwrap();
        assert_eq!(turns().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn removing_jira_fails_the_turn_it_cut_off_and_keeps_the_conversation() {
        let fx = adopted().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Hi", &crate::agent::TurnMeta::default(), "running").await.unwrap();

        fx.core.remove_instance("jira").await.unwrap();

        let turns = fx.core.with_app_db(|db| db.pip_turns("general")).await.unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!((turns[0].status.as_str(), turns[0].error.as_deref()), ("failed", Some(crate::db::DISCONNECTED)));
    }

    #[tokio::test]
    async fn connections_can_be_removed_by_connection_id_while_the_list_cant_be_read() {
        let (fx, vault, _installed) = with_github(true).await;
        let review = draft_for(&fx, review_on_ann(&fx)).await;
        std::fs::write(fx.dir.join("config.json"), "{ nope").unwrap();

        fx.core.remove_instance("github:ann").await.unwrap();
        fx.core.remove_instance("jira:site:me").await.unwrap();

        assert_eq!((vault.get("github:ann"), fx.core.code.auth.logins().is_empty()), (None, true));
        assert!(fx.core.auth.connection().await.is_none());
        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Retired("GitHub was removed.".into()));
        assert_eq!(std::fs::read_to_string(fx.dir.join("config.json")).unwrap(), "{ nope");
    }

    fn provider_ids(fx: &crate::inbox::testing::Fixture) -> Vec<String> {
        AppConfig::load(&fx.core.data_dir()).providers.into_iter().map(|p| p.id).collect()
    }

    fn add_provider(fx: &crate::inbox::testing::Fixture, id: &str, folder: Option<&std::path::Path>) {
        AppConfig::update(&fx.core.data_dir(), |config| {
            config.providers.push(connections::ProviderInstance {
                id: id.into(),
                driver: connections::Driver::Claude,
                display_name: "Claude personal".into(),
                enabled: true,
                config: connections::ProviderConfig { config_dir: folder.map(|f| f.display().to_string()), ..Default::default() },
                extra: Default::default(),
            });
        })
        .unwrap();
    }

    #[tokio::test]
    async fn the_list_ends_with_the_provider_rows_which_carry_the_driver_and_the_folder() {
        let fx = adopted().await;
        add_provider(&fx, "claude_2", Some(std::path::Path::new("/tmp/claude-two")));
        let rows = fx.core.settings_rows().await.unwrap();
        let shown: Vec<_> = rows.iter().map(|c| (c.instance_id.as_str(), c.kind)).collect();
        assert_eq!(shown, [("jira", RowKind::Jira), ("claude", RowKind::Provider), ("claude_2", RowKind::Provider)]);
        let second = rows.last().unwrap();
        assert_eq!((second.driver, second.config_dir.as_deref(), second.status.is_none(), second.display_name.as_str()), (Some(connections::Driver::Claude), Some("/tmp/claude-two"), true, "Claude personal"));
        let json = serde_json::to_value(&rows[0]).unwrap();
        assert!(json.get("driver").is_none() && json.get("configDir").is_none());
        assert_eq!(serde_json::to_value(second).unwrap()["driver"], "claude");
    }

    #[tokio::test]
    async fn a_provider_can_be_renamed_and_turned_off_and_on_through_the_instance_commands() {
        let fx = adopted().await;
        assert_eq!(fx.core.rename_instance("claude", "  Work Claude ").unwrap(), "claude");
        assert_eq!(fx.core.set_instance_enabled("claude", false).await.unwrap(), "claude");
        let row = |fx: &crate::inbox::testing::Fixture| AppConfig::load(&fx.core.data_dir()).providers.into_iter().find(|p| p.id == "claude").map(|p| (p.display_name, p.enabled));
        assert_eq!(row(&fx), Some(("Work Claude".into(), false)));
        fx.core.set_instance_enabled("claude", true).await.unwrap();
        assert_eq!(row(&fx).map(|r| r.1), Some(true));
        assert!(matches!(fx.core.rename_instance("claude", "  "), Err(Error::Input(_))));
    }

    #[tokio::test]
    async fn removing_a_provider_retires_its_id_and_deletes_nothing_on_disk() {
        let fx = adopted().await;
        let folder = fx.core.data_dir().join("claude-two-login");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(".credentials.json"), "{}").unwrap();
        add_provider(&fx, "claude_2", Some(&folder));
        fx.core.provider_remove("claude_2").await.unwrap();
        assert_eq!(provider_ids(&fx), ["claude"]);
        assert!(AppConfig::load(&fx.core.data_dir()).retired_ids.contains(&"claude_2".to_string()));
        assert!(folder.join(".credentials.json").exists());
        assert_eq!(ids(&fx), ["jira", "github"], "the connections are untouched");
    }

    #[tokio::test]
    async fn a_provider_with_agents_running_on_it_is_not_removed_but_queued_and_finished_runs_do_not_hold_it() {
        let fx = adopted().await;
        add_provider(&fx, "claude_2", None);
        let on_second = |id: &str, state: RunState| {
            let mut run = Run::queued(id.into(), format!("p-{id}"), fx.scope.connection_id.clone(), None, crate::domain::fixtures::run_spec(), chrono::Utc::now());
            run.runs_on = Some(crate::model_choice::ModelChoice { instance_id: "claude_2".into(), model: "opus".into(), effort: None });
            run.expected_worktree = format!("/tmp/{id}").into();
            run.state = state;
            run
        };
        for (id, state) in [("queued", RunState::Queued), ("done", RunState::Done)] {
            fx.insert_run(&on_second(id, state)).await;
        }
        fx.insert_run(&on_second("one", RunState::Working)).await;
        let one = fx.core.provider_remove("claude_2").await;
        assert!(matches!(one, Err(Error::Input(words)) if words == "Stop its running agent first."));
        fx.insert_run(&on_second("two", RunState::NeedsAnswer)).await;
        let two = fx.core.provider_remove("claude_2").await;
        assert!(matches!(two, Err(Error::Input(words)) if words == "Stop its 2 running agents first."));
        assert_eq!(provider_ids(&fx), ["claude", "claude_2"]);

        for id in ["one", "two"] {
            fx.core.save_run(&on_second(id, RunState::Stopped)).await.unwrap();
        }
        fx.core.provider_remove("claude_2").await.unwrap();
        assert_eq!(provider_ids(&fx), ["claude"]);
    }

    #[tokio::test]
    async fn removing_a_provider_waits_for_a_launch_under_way_and_is_then_refused() {
        let fx = adopted().await;
        add_provider(&fx, "claude_2", None);
        let mut run = Run::queued("racing".into(), "p-racing".into(), fx.scope.connection_id.clone(), None, crate::domain::fixtures::run_spec(), chrono::Utc::now());
        run.runs_on = Some(crate::model_choice::ModelChoice { instance_id: "claude_2".into(), model: "opus".into(), effort: None });
        run.expected_worktree = "/tmp/racing".into();
        fx.insert_run(&run).await;

        let launch = fx.core.launching.lock().await;
        let core = fx.core.clone();
        let removal = tokio::spawn(async move { core.provider_remove("claude_2").await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!removal.is_finished(), "removal waits for the launch lock");

        run.state = RunState::Launching;
        fx.core.save_run(&run).await.unwrap();
        drop(launch);
        let outcome = removal.await.unwrap();
        assert!(matches!(outcome, Err(Error::Input(words)) if words == "Stop its running agent first."));
        assert_eq!(provider_ids(&fx), ["claude", "claude_2"]);
    }

    #[tokio::test]
    async fn removing_every_provider_leaves_the_list_empty_after_a_relaunch() {
        let fx = adopted().await;
        fx.core.provider_remove("claude").await.unwrap();
        fx.core.adopt_instances().await;
        assert!(provider_ids(&fx).is_empty());
        assert!(fx.core.settings_rows().await.unwrap().iter().all(|c| c.kind != RowKind::Provider));
    }

    #[tokio::test]
    async fn the_provider_commands_refuse_an_id_that_is_not_a_provider() {
        let fx = adopted().await;
        let before = (names(&fx), enabled(&fx));
        for id in ["jira", "github", "github_9"] {
            assert!(matches!(fx.core.provider_rename(id, "Other"), Err(Error::Input(_))), "{id}");
            assert!(matches!(fx.core.provider_set_enabled(id, false), Err(Error::Input(_))), "{id}");
            assert!(matches!(fx.core.provider_remove(id).await, Err(Error::Input(_))), "{id}");
        }
        assert_eq!((names(&fx), enabled(&fx)), before);
        assert_eq!(provider_ids(&fx), ["claude"]);
    }

    #[tokio::test]
    async fn a_provider_row_cannot_be_removed_as_a_connection_and_a_connection_cannot_be_removed_as_a_provider() {
        let fx = adopted().await;
        assert!(matches!(fx.core.remove_instance("claude").await, Err(Error::Input(_))));
        assert_eq!(provider_ids(&fx), ["claude"]);
    }

    #[tokio::test]
    async fn jira_connect_refuses_an_id_that_is_not_a_jira_instance() {
        let fx = adopted().await;
        assert!(fx.core.require_jira("jira").await.is_ok());
        for id in ["claude", "github", "github_9", ""] {
            assert!(matches!(fx.core.require_jira(id).await, Err(Error::Input(_))), "{id:?}");
        }
    }

    #[tokio::test]
    async fn jira_connect_accepts_a_signed_in_jira_connection_that_has_no_instance_yet() {
        let fx = fixture_with_authenticator(None, None).await;
        let connection_id = fx.core.auth.connection().await.unwrap().id;
        assert!(AppConfig::load(&fx.core.data_dir()).connections.is_empty());
        assert!(fx.core.require_jira(&connection_id).await.is_ok());
        assert!(matches!(fx.core.require_jira("github").await, Err(Error::Input(_))));
    }

    #[tokio::test]
    async fn jira_connect_accepts_the_connection_id_an_instance_is_bound_to() {
        let fx = adopted().await;
        let connection_id = fx.core.auth.connection().await.unwrap().id;
        assert!(fx.core.require_jira(&connection_id).await.is_ok());
    }

    #[tokio::test]
    async fn an_unreadable_connections_block_shows_no_provider_rows() {
        let fx = adopted().await;
        let dir = fx.core.data_dir();
        let mut file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        file["connections"] = serde_json::json!("broken");
        std::fs::write(dir.join("config.json"), file.to_string()).unwrap();
        assert!(fx.core.provider_rows().is_empty());
    }

    #[tokio::test]
    async fn a_providers_list_that_cant_be_read_shows_one_row_with_the_problem_and_changes_nothing() {
        let fx = adopted().await;
        let dir = fx.core.data_dir();
        let mut file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        file["providers"] = serde_json::json!([{ "id": "claude", "driver": "gemini" }]);
        std::fs::write(dir.join("config.json"), file.to_string()).unwrap();
        let rows: Vec<_> = fx.core.settings_rows().await.unwrap().into_iter().filter(|c| c.kind == RowKind::Provider).collect();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].error.as_deref().is_some_and(|e| e.contains("config.json.bak")), "{:?}", rows[0].error);
        let id = rows[0].id.clone();
        assert!(matches!(fx.core.provider_set_enabled(&id, false), Err(Error::Input(_))));
        assert!(matches!(fx.core.provider_remove(&id).await, Err(Error::Input(_))));
        assert!(matches!(fx.core.rename_instance(&id, "Other"), Err(Error::Input(_))));
        assert!(matches!(fx.core.provider_set_enabled("claude", false), Err(Error::Input(_))));
        assert!(matches!(fx.core.rename_instance("claude", "Other"), Err(Error::Input(_))));
    }

    #[tokio::test]
    async fn jira_connect_accepts_a_signed_in_jira_connection_while_the_connections_block_is_unreadable() {
        let fx = fixture_with_authenticator(None, None).await;
        let connection_id = fx.core.auth.connection().await.unwrap().id;
        let dir = fx.core.data_dir();
        std::fs::write(dir.join("config.json"), serde_json::json!({ "connections": "broken" }).to_string()).unwrap();
        assert!(AppConfig::load(&dir).connections_error.is_some());
        assert!(fx.core.require_jira(&connection_id).await.is_ok());
        assert!(matches!(fx.core.require_jira("claude").await, Err(Error::Input(_))));
    }

    #[tokio::test]
    async fn a_jira_connection_with_a_live_run_is_not_removed_until_the_run_is_stopped() {
        let (rig, run, second) = crate::runs::rig::working_on_the_second_account().await;
        let core = &rig.fx.core;
        core.adopt_instances().await;
        let refused = core.remove_instance("jira_2").await.unwrap_err();
        assert_eq!(refused.to_string(), "Stop its running agent first.");
        assert!(core.auth.accounts().await.iter().any(|s| s.connection.id == second.connection_id), "the account is still signed in");

        rig.svc.stop(&run.id).await.unwrap();
        let removed = core.remove_instance("jira_2").await.unwrap();
        assert_eq!(removed.connection_id, second.connection_id);
    }

    #[tokio::test]
    async fn a_jira_connection_whose_run_has_lost_its_session_is_not_removed() {
        let (rig, run, second) = crate::runs::rig::working_on_the_second_account().await;
        let core = &rig.fx.core;
        core.adopt_instances().await;
        rig.set(&run, |r| r.state = RunState::Unknown).await;

        let refused = core.remove_instance("jira_2").await.unwrap_err();

        assert_eq!(refused.to_string(), "Gossamr can't find its agent's session right now. Try again once it settles.");
        assert!(core.runs_list(&RunQuery::default()).await.unwrap().iter().any(|r| r.id == run.id), "the run is still in reach");
        assert!(core.auth.accounts().await.iter().any(|s| s.connection.id == second.connection_id));
    }

    fn sign_in_as(site: &str, email: &str) -> crate::auth::TokenSignIn {
        crate::auth::TokenSignIn { site: site.into(), cloud_id: None, email: email.into(), token: "t".into(), expires_on: "2999-01-01".into() }
    }

    #[tokio::test]
    async fn taking_over_an_instance_with_another_account_is_refused_while_an_agent_works_on_the_account_it_had() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let (rig, run, second) = crate::runs::rig::working_on_the_second_account().await;
        let core = &rig.fx.core;
        core.adopt_instances().await;

        let refused = core.connect_jira(&sign_in_as("gamma", "gus"), Some("jira_2")).await.err().expect("refused");

        assert!(refused.to_string().contains("running agent"), "{refused}");
        let signed_in: Vec<String> = core.auth.accounts().await.into_iter().map(|s| s.connection.id).collect();
        assert!(signed_in.contains(&second.connection_id) && signed_in.len() == 2, "{signed_in:?}");
        assert!(core.run(&run.id).await.unwrap().is_some(), "the run is still in reach");
        rig.svc.stop(&run.id).await.unwrap();
    }

    #[tokio::test]
    async fn taking_over_an_instance_again_as_the_account_with_the_agent_is_allowed() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let (rig, run, _second) = crate::runs::rig::working_on_the_second_account().await;
        let core = &rig.fx.core;
        core.adopt_instances().await;

        core.connect_jira(&sign_in_as("beta", "bo"), Some("jira_2")).await.unwrap();

        assert!(core.run(&run.id).await.unwrap().is_some(), "the run is still in reach");
        rig.svc.stop(&run.id).await.unwrap();
    }

    #[tokio::test]
    async fn a_run_cannot_be_queued_while_its_connection_is_being_removed() {
        let (rig, run, _second) = crate::runs::rig::working_on_the_second_account().await;
        rig.svc.stop(&run.id).await.unwrap();
        let removing = rig.fx.core.draft_gate.lock().await;
        let (core, spec, item) = (rig.fx.core.clone(), rig.spec(2), rig.fx.item("CA-1"));
        let queuing = tokio::spawn(async move { core.queue_test_run(spec, Some(item)).await });

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        assert!(!queuing.is_finished(), "the run was queued while a removal held the gate");
        drop(removing);
        queuing.await.unwrap().unwrap();
    }
}
