//! Core's side of the connection instances: creating them from the sign-ins already there, keeping them in step with
//! signing in and out, and naming each connection by its instance.

use super::{db_file, ConnectionInfo, Core};
use crate::config::AppConfig;
use crate::connections::{self, Binding, Instance};
use crate::db::is_for;
use crate::domain::{Actor, ProposalQuery, ProposalState, StateKind};
use crate::error::{Error, Result};
use crate::proposals;
use crate::secrets;
use crate::tracker::{Connection, ConnectionKind};

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

    /// Removes `instance_id`: drafts that target it are closed with a reason, the token Gossamr stored is forgotten, its
    /// cache is deleted and its id is retired. A draft being posted stops it, before anything is deleted. Returns the
    /// connection to tell the page about.
    pub async fn remove_instance(&self, instance_id: &str) -> Result<String> {
        let config = AppConfig::load(&self.data_dir);
        let instance = config.connections.iter().find(|i| i.id == instance_id).filter(|_| connections::is_live(&config)).cloned();
        let instance = instance.ok_or_else(|| Error::Input("This connection is gone. Reopen Settings.".into()))?;
        let key = instance.bound_to.clone().unwrap_or_else(|| instance.id.clone());
        self.close_drafts_for(&instance, &key).await?;
        match instance.kind {
            ConnectionKind::Github => match self.github_disconnect(&key).await {
                Ok(()) | Err(Error::NotSignedIn) => {}
                Err(e) => return Err(e),
            },
            ConnectionKind::Jira => self.forget_jira(&key).await?,
        }
        AppConfig::update_if(&self.data_dir, |config| connections::remove(config, instance_id))?;
        self.probes_forget(instance_id);
        Ok(key)
    }

    async fn close_drafts_for(&self, instance: &Instance, connection_id: &str) -> Result<()> {
        let reason = format!("{} was removed.", instance.display_name);
        let now = chrono::Utc::now();
        self.with_app_db(|db| {
            db.atomically(|db| {
                let open = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
                let mine: Vec<_> = db.proposals(&open)?.into_iter().filter(|p| is_for(p, connection_id)).collect();
                if mine.iter().any(|p| p.state == ProposalState::Applying) {
                    return Err(Error::Input(format!("Gossamr is posting a draft for {} right now. Try again in a moment.", instance.display_name)));
                }
                for p in mine {
                    let closed = proposals::retire(db, &p.id, &reason, now)?;
                    proposals::record(db, &closed, Actor::Person, "draft_retired", now);
                }
                Ok(())
            })
        })
        .await
    }

    /// Forgets the Jira token and deletes the site's cache, if `connection_id` is the signed-in connection.
    async fn forget_jira(&self, connection_id: &str) -> Result<()> {
        let _alone = self.sign_in.lock().await;
        let Some(connection) = self.auth.connection().await.filter(|c| c.id == connection_id) else { return Ok(()) };
        self.auth.sign_out().await?;
        self.registry.remove(&connection.id);
        self.close_db();
        let path = self.data_dir.join(db_file(&connection));
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
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

        assert_eq!(fx.core.remove_instance("jira").await.unwrap(), "jira:site:me");

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
}
