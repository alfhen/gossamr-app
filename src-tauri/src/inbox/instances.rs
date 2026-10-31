//! Core's side of the connection instances: creating them from the sign-ins already there, keeping them in step with
//! signing in and out, and naming each connection by its instance.

use super::{db_file, ConnectionInfo, Core};
use crate::config::AppConfig;
use crate::connections::{self, Binding};
use crate::db::is_for;
use crate::domain::{Actor, ProposalQuery, ProposalState, StateKind};
use crate::error::{Error, Result};
use crate::proposals;
use crate::secrets;
use crate::tracker::{Connection, ConnectionKind};

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

    /// Removes `instance_id`: the token Gossamr stored is forgotten, its cache is deleted, drafts that target it are
    /// closed with a reason and its id is retired. A draft being posted stops it before anything is deleted. Drafts are
    /// closed last, so a removal that fails leaves them open. `instance_id` may also be a connection no instance
    /// names (the list can't be read, or the connection was never adopted); that one has no id to retire.
    pub async fn remove_instance(&self, instance_id: &str) -> Result<Removed> {
        let _alone = self.sign_in.lock().await;
        let target = self.removal_target(instance_id).await?;
        self.refuse_while_posting(&target).await?;
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

    async fn refuse_while_posting(&self, target: &RemovalTarget) -> Result<()> {
        let posting = self.with_app_db(|db| open_drafts_for(db, &target.connection_id).map(|mine| mine.iter().any(|p| p.state == ProposalState::Applying))).await?;
        if posting {
            return Err(Error::Input(format!("Gossamr is posting a draft for {} right now. Try again in a moment.", target.name)));
        }
        Ok(())
    }

    /// Closes the pending drafts for the removed connection, and for Jira forgets Pip's conversations, which sign-out
    /// used to clear. Says whether a closed draft was in a workstream.
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
                if target.kind == ConnectionKind::Jira {
                    db.clear_app_pip_turns()?;
                }
                Ok(workstreams)
            })
        })
        .await
    }

    /// Forgets the GitHub token and deletes the account's cache, whether or not its session loaded at launch.
    async fn forget_github(&self, target: &RemovalTarget) -> Result<()> {
        match self.github_disconnect(&target.connection_id).await {
            Err(Error::NotSignedIn) => {}
            done => return done,
        }
        let Some(login) = target.login.as_deref() else { return Ok(()) };
        self.code.auth.disconnect(login)?;
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
        self.auth.sign_out().await?;
        self.registry.remove(&connection.id);
        self.close_db();
        remove_db_files(&self.data_dir.join(db_file(&connection)));
        Ok(())
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

    use crate::auth::{GithubAuth, GithubSession, TokenStore};
    use crate::inbox::code::{github_db_file, CodeService};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// A GitHub token store whose delete can be refused, as the Keychain does when you deny its prompt.
    #[derive(Default)]
    struct Keychain {
        held: crate::auth::MemoryStore,
        refuse_deletes: AtomicBool,
    }

    impl TokenStore for Keychain {
        fn logins(&self) -> Result<Vec<String>> {
            self.held.logins()
        }
        fn load(&self, login: &str) -> Result<Option<GithubSession>> {
            self.held.load(login)
        }
        fn save(&self, session: &GithubSession) -> Result<()> {
            self.held.save(session)
        }
        fn delete(&self, login: &str) -> Result<()> {
            if self.refuse_deletes.load(Ordering::SeqCst) {
                return Err(Error::Keychain(keyring::Error::NoStorageAccess("denied".into())));
            }
            self.held.delete(login)
        }
    }

    /// Jira and GitHub's `ann` both connected and adopted. With `restored` false, the GitHub token is in the Keychain but
    /// its session didn't load at launch.
    async fn with_github(restored: bool) -> (crate::inbox::testing::Fixture, Arc<Keychain>) {
        let keychain = Arc::new(Keychain::default());
        keychain
            .save(&GithubSession { login: "ann".into(), name: None, avatar_url: None, token: "t".into(), source: crate::auth::SessionSource::Token, scopes: None, refresh_token: None, expires_at: None })
            .unwrap();
        let auth = GithubAuth::for_test(reqwest::Client::new(), keychain.clone(), "http://unused.invalid", None, vec![]);
        let code = CodeService::with_factory(auth, Box::new(|_, _| unreachable!("nothing here talks to GitHub")));
        let fx = fixture_with_authenticator(Some(code), None).await;
        if restored {
            fx.core.restore().await;
        }
        fx.core.adopt_instances().await;
        (fx, keychain)
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
        let (fx, keychain) = with_github(true).await;
        leave_cache(&fx);
        let review = draft_for(&fx, review_on_ann(&fx)).await;

        let removed = fx.core.remove_instance("github").await.unwrap();

        assert_eq!(removed, Removed { connection_id: "github:ann".into(), kind: ConnectionKind::Github, workstreams: false });
        assert!(keychain.logins().unwrap().is_empty());
        assert!(fx.core.code.connection_ids().is_empty());
        assert!(cache_files(&fx).iter().all(|f| !f.exists()));
        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Retired("GitHub was removed.".into()));
        assert_eq!(ids(&fx), ["jira"]);
    }

    #[tokio::test]
    async fn removing_a_github_account_whose_session_didnt_load_still_forgets_its_token_and_cache() {
        let (fx, keychain) = with_github(false).await;
        leave_cache(&fx);
        assert_eq!(ids(&fx), ["jira", "github"]);

        fx.core.remove_instance("github").await.unwrap();

        assert!(keychain.logins().unwrap().is_empty());
        assert!(cache_files(&fx).iter().all(|f| !f.exists()));
        assert_eq!(ids(&fx), ["jira"]);
    }

    #[tokio::test]
    async fn a_github_token_that_wont_delete_leaves_the_connection_and_its_drafts_as_they_were() {
        let (fx, keychain) = with_github(true).await;
        leave_cache(&fx);
        let review = draft_for(&fx, review_on_ann(&fx)).await;
        keychain.refuse_deletes.store(true, Ordering::SeqCst);

        assert!(fx.core.remove_instance("github").await.is_err());

        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Pending);
        assert_eq!(keychain.logins().unwrap(), ["ann"]);
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
    async fn removing_jira_forgets_pips_conversations_and_removing_github_keeps_them() {
        let fx = adopted().await;
        fx.core.pip_turn_begin(&fx.scope, "general", "q1", "Hi", &crate::agent::TurnMeta::default(), "done").await.unwrap();
        let turns = || fx.core.with_app_db(|db| Ok(db.pip_turns("general")?.len()));

        fx.core.remove_instance("github").await.unwrap();
        assert!(turns().await.unwrap() > 0);

        fx.core.remove_instance("jira").await.unwrap();
        assert_eq!(turns().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn connections_can_be_removed_by_connection_id_while_the_list_cant_be_read() {
        let (fx, keychain) = with_github(true).await;
        let review = draft_for(&fx, review_on_ann(&fx)).await;
        std::fs::write(fx.dir.join("config.json"), "{ nope").unwrap();

        fx.core.remove_instance("github:ann").await.unwrap();
        fx.core.remove_instance("jira:site:me").await.unwrap();

        assert!(keychain.logins().unwrap().is_empty());
        assert!(fx.core.auth.connection().await.is_none());
        assert_eq!(state_of(&fx, &review.id).await, ProposalState::Retired("GitHub was removed.".into()));
        assert_eq!(std::fs::read_to_string(fx.dir.join("config.json")).unwrap(), "{ nope");
    }
}
