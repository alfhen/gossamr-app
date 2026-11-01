//! Core's side of the connection instances: creating them from the sign-ins already there, keeping them in step with
//! signing in and out, and naming each connection by its instance.

use super::{db_file, ConnectionInfo, Core};
use crate::config::AppConfig;
use crate::connections::{self, Binding, RowKind};
use crate::db::is_for;
use crate::domain::{Actor, ProposalQuery, ProposalState, StateKind};
use crate::error::{Error, Result};
use crate::proposals;
use crate::secrets;
use crate::tracker::{Connection, ConnectionKind};
use chrono::Utc;

const NAME_LIMIT: usize = 60;

/// What a removal tells the page to refresh.
#[derive(Debug, PartialEq)]
pub struct Removed {
    pub connection_id: String,
    pub kind: ConnectionKind,
    pub workstreams: bool,
}

struct RemovalTarget {
    kind: ConnectionKind,
    connection_id: String,
    name: String,
    instance_id: Option<String>,
    login: Option<String>,
}

fn open_drafts_for(db: &crate::db::Db, connection_id: &str) -> Result<Vec<crate::domain::Proposal>> {
    let open = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
    Ok(db.proposals(&open)?.into_iter().filter(|p| is_for(p, connection_id)).collect())
}

fn remove_db_files(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

pub(super) fn not_a_provider() -> Error {
    Error::Input("This isn't a provider. Reopen Settings.".into())
}

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
        if let Err(e) = self.try_bind_instance(binding) {
            eprintln!("couldn't save the connections to config.json: {e}");
        }
        self.probes_rebound();
    }

    /// Binds the instance for `binding` when the connections are live, and reports a failed write.
    pub(super) fn try_bind_instance(&self, binding: Binding) -> Result<()> {
        self.try_change_instances(|config| connections::bind(config, binding))
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
        if let Some(connection) = self.auth.connection().await.filter(|c| c.id == id) {
            return Ok(RemovalTarget { kind: ConnectionKind::Jira, connection_id: connection.id, name: connection.display_name, instance_id: None, login: None });
        }
        if let Ok(session) = self.code.session(id) {
            return Ok(RemovalTarget { kind: ConnectionKind::Github, connection_id: id.into(), name: "GitHub".into(), instance_id: None, login: Some(session.login) });
        }
        Err(Error::Input("This connection is gone. Reopen Settings.".into()))
    }

    /// The name of the instance `connection_id` belongs to, when it is turned off. Nothing is off while the list can't be read.
    pub fn off_name(&self, connection_id: &str) -> Option<String> {
        let config = AppConfig::load(&self.data_dir);
        let off = |i: &&connections::Instance| !i.enabled && i.bound_to.as_deref().unwrap_or(&i.id) == connection_id;
        connections::is_live(&config).then(|| config.connections.iter().find(off).map(|i| i.display_name.clone())).flatten()
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

    async fn refuse_while_posting(&self, connection_id: &str, name: &str) -> Result<()> {
        let posting = self.with_app_db(|db| open_drafts_for(db, connection_id).map(|mine| mine.iter().any(|p| p.state == ProposalState::Applying))).await?;
        if posting {
            return Err(Error::Input(format!("Gossamr is posting a draft for {name} right now. Try again in a moment.")));
        }
        Ok(())
    }

    /// Closes the pending drafts for the removed connection. Says whether a closed draft was in a workstream.
    async fn close_drafts_for(&self, target: &RemovalTarget) -> Result<bool> {
        let reason = format!("{} was removed.", target.name);
        let now = chrono::Utc::now();
        self.with_app_db(|db| {
            db.atomically(|db| {
                let mut workstreams = false;
                for p in open_drafts_for(db, &target.connection_id)?.into_iter().filter(|p| p.state == ProposalState::Pending) {
                    let closed = proposals::retire(db, &p.id, &reason, now)?;
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

    /// Forgets the Jira token and deletes the site's cache, if `connection_id` is the signed-in connection.
    async fn forget_jira(&self, connection_id: &str) -> Result<()> {
        let Some(connection) = self.auth.connection().await else { return Ok(()) };
        if connection.id != connection_id {
            return Err(Error::Input("Jira is signed in to another account now. Reopen Settings.".into()));
        }
        self.auth.disconnect(&connection.id).await?;
        self.registry.remove(&connection.id);
        self.close_db();
        self.settle_pip_turns(crate::db::DISCONNECTED).await;
        remove_db_files(&self.data_dir.join(db_file(&connection)));
        Ok(())
    }

    pub fn is_provider(&self, instance_id: &str) -> bool {
        AppConfig::load(&self.data_dir).providers.iter().any(|p| p.id == instance_id)
    }

    /// Refuses an id that isn't a Jira instance, so a provider's or GitHub's row can't be signed in as Jira.
    pub fn require_jira(&self, instance_id: &str) -> Result<()> {
        let config = AppConfig::load(&self.data_dir);
        match config.connections.iter().find(|i| i.id == instance_id) {
            Some(instance) if instance.kind == ConnectionKind::Jira => Ok(()),
            _ => Err(Error::Input("That isn't a Jira connection.".into())),
        }
    }

    pub fn provider_rename(&self, instance_id: &str, name: &str) -> Result<String> {
        let name = clean_name(name)?;
        self.change_provider(instance_id, |provider| provider.display_name = name)
    }

    pub fn provider_set_enabled(&self, instance_id: &str, enabled: bool) -> Result<String> {
        self.change_provider(instance_id, |provider| provider.enabled = enabled)
    }

    /// Removes a provider instance and retires its id. Its config folder and the login in it stay on disk.
    pub fn provider_remove(&self, instance_id: &str) -> Result<()> {
        let mut removed = false;
        AppConfig::update_if(&self.data_dir, |config| {
            removed = connections::providers_live(config) && connections::remove_provider(config, instance_id);
            removed
        })?;
        removed.then_some(()).ok_or_else(not_a_provider)?;
        self.probes_forget(instance_id);
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

    /// The provider instances as Settings rows, after the connections. A list that can't be read gives none.
    pub(super) fn provider_rows(&self) -> Vec<ConnectionInfo> {
        let config = AppConfig::load(&self.data_dir);
        if let Some(problem) = config.providers_error.as_ref().or(config.connections_error.as_ref()) {
            eprintln!("{problem}");
            return Vec::new();
        }
        config
            .providers
            .into_iter()
            .map(|p| ConnectionInfo {
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
                status: None,
                rechecking: false,
            })
            .collect()
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
        fx.core.provider_remove("claude_2").unwrap();
        assert_eq!(provider_ids(&fx), ["claude"]);
        assert!(AppConfig::load(&fx.core.data_dir()).retired_ids.contains(&"claude_2".to_string()));
        assert!(folder.join(".credentials.json").exists());
        assert_eq!(ids(&fx), ["jira", "github"], "the connections are untouched");
    }

    #[tokio::test]
    async fn removing_every_provider_leaves_the_list_empty_after_a_relaunch() {
        let fx = adopted().await;
        fx.core.provider_remove("claude").unwrap();
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
            assert!(matches!(fx.core.provider_remove(id), Err(Error::Input(_))), "{id}");
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
        assert!(fx.core.require_jira("jira").is_ok());
        for id in ["claude", "github", "github_9", ""] {
            assert!(matches!(fx.core.require_jira(id), Err(Error::Input(_))), "{id:?}");
        }
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
    async fn a_providers_list_that_cant_be_read_shows_no_provider_rows_and_changes_nothing() {
        let fx = adopted().await;
        let dir = fx.core.data_dir();
        let mut file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
        file["providers"] = serde_json::json!([{ "id": "claude", "driver": "gemini" }]);
        std::fs::write(dir.join("config.json"), file.to_string()).unwrap();
        assert!(fx.core.settings_rows().await.unwrap().iter().all(|c| c.kind != RowKind::Provider));
        assert!(matches!(fx.core.provider_set_enabled("claude", false), Err(Error::Input(_))));
        assert!(matches!(fx.core.rename_instance("claude", "Other"), Err(Error::Input(_))));
    }
}
