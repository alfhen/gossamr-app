//! Core's side of the probes: when each connection instance is asked how it stands, and the last answer for each.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::Core;
use crate::config::AppConfig;
use crate::connections::Instance;
use crate::probe::{self, Snapshot};
use crate::tracker::ConnectionKind;

/// Why the instances are being probed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    Launch,
    /// The window gained focus.
    Focus,
    /// The person pressed refresh.
    Refresh,
    /// A request was refused as not authorised.
    Unauthorized,
}

/// A window focus within this long of the last probe asks nothing again.
const FOCUS_EVERY: Duration = Duration::from_secs(30);

/// A snapshot, and the connection its instance was bound to when it was taken.
struct Stored {
    bound_to: Option<String>,
    snapshot: Snapshot,
}

#[derive(Default)]
pub(super) struct Probes {
    snapshots: Mutex<HashMap<String, Stored>>,
    /// Set when an instance is bound to another connection, so the next probe isn't throttled and finds the new account.
    rebound: AtomicBool,
    /// Held while probing, so two triggers never run `gh` at once; it keeps when the last probe finished.
    last: tokio::sync::Mutex<Option<Instant>>,
}

impl Core {
    /// Probes every instance, and returns the connection (or instance, before it has one) of each whose answer changed.
    /// A refresh reports all of them, because the page shows when they were checked.
    pub async fn probe_connections(&self, why: Probe) -> Vec<String> {
        let mut last = self.probes.last.lock().await;
        let rebound = self.probes.rebound.swap(false, Ordering::Relaxed);
        if why == Probe::Focus && !rebound && last.is_some_and(|at| at.elapsed() < FOCUS_EVERY) {
            return Vec::new();
        }
        let config = AppConfig::load(&self.data_dir);
        let mut found = HashMap::new();
        let mut changed = Vec::new();
        for instance in &config.connections {
            let previous = self.probe_snapshot(instance);
            let now = self.probe_instance(instance).await.keeping_account_of(previous.as_ref());
            if why == Probe::Refresh || previous.as_ref().is_none_or(|p| !p.same_as(&now)) {
                changed.push(instance.bound_to.clone().unwrap_or_else(|| instance.id.clone()));
            }
            found.insert(instance.id.clone(), Stored { bound_to: instance.bound_to.clone(), snapshot: now });
        }
        // An answer for a connection the instance has since left is about the wrong account.
        let current = AppConfig::load(&self.data_dir);
        found.retain(|id, stored| current.connections.iter().any(|i| &i.id == id && i.bound_to == stored.bound_to));
        *self.probes.snapshots.lock().expect("probe lock poisoned") = found;
        *last = Some(Instant::now());
        changed
    }

    /// The last answer for `instance`, unless it was taken while the instance was bound to another connection.
    pub(super) fn probe_snapshot(&self, instance: &Instance) -> Option<Snapshot> {
        let snapshots = self.probes.snapshots.lock().expect("probe lock poisoned");
        snapshots.get(&instance.id).filter(|s| s.bound_to == instance.bound_to).map(|s| s.snapshot.clone())
    }

    pub(super) fn probes_rebound(&self) {
        self.probes.rebound.store(true, Ordering::Relaxed);
    }

    async fn probe_instance(&self, instance: &Instance) -> Snapshot {
        if !instance.enabled {
            return Snapshot::off();
        }
        match instance.kind {
            ConnectionKind::Jira => probe::jira(self.auth.whoami(probe::TIMEOUT).await, self.auth.expires_on().await, chrono::Local::now().date_naive()),
            ConnectionKind::Github => {
                let host = instance.config.host.as_deref().unwrap_or("github.com");
                probe::github(self.code.auth.gh_dirs(), host, instance.config.login.as_deref().unwrap_or_default(), probe::TIMEOUT).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::GithubAuth;
    use crate::connections::{self, Binding};
    use crate::auth::{AccessToken, Account, Authenticator, Credentials, TokenSignIn};
    use crate::error::{Error, Result};
    use crate::inbox::testing::{fixture_with, fixture_with_authenticator};
    use crate::inbox::CodeService;
    use crate::probe::State;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn gh_saying(dir: &std::path::Path, login: &str, state: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("gh");
        let error = if state == "error" { r#","error":"HTTP 401: Bad credentials""# } else { "" };
        let status = format!(r#"{{"hosts":{{"github.com":[{{"state":"{state}","host":"github.com","login":"{login}"{error}}}]}}}}"#);
        std::fs::write(&path, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\necho '{status}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn snapshot_of(core: &Core, instance_id: &str) -> Option<Snapshot> {
        let config = AppConfig::load(&core.data_dir());
        core.probe_snapshot(config.connections.iter().find(|i| i.id == instance_id)?)
    }

    /// A Jira that answers `/myself` as Ann, or with 401 when `refused`, after waiting for `gate` when there is one.
    struct Jira {
        refused: bool,
        gate: Option<Arc<tokio::sync::Notify>>,
        asked: Arc<tokio::sync::Notify>,
    }

    impl Jira {
        fn answering() -> Arc<Self> {
            Arc::new(Self { refused: false, gate: None, asked: Default::default() })
        }
    }

    #[async_trait::async_trait]
    impl Authenticator for Jira {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, _: &TokenSignIn) -> Result<Credentials> {
            unimplemented!()
        }
        async fn whoami(&self, _: &AccessToken) -> Result<Account> {
            self.asked.notify_one();
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
            if self.refused {
                return Err(Error::Api { status: 401, message: "no".into() });
            }
            Ok(Account { account_id: "me".into(), name: "Ann".into(), avatar_url: None })
        }
    }

    async fn jira_fixture(jira: Arc<Jira>) -> crate::inbox::testing::Fixture {
        let fx = fixture_with_authenticator(None, Some(jira)).await;
        fx.core.adopt_instances().await;
        fx
    }

    #[tokio::test]
    async fn an_enabled_jira_instance_is_probed_through_the_session_and_a_refusal_means_not_signed_in() {
        let fx = jira_fixture(Jira::answering()).await;
        fx.core.probe_connections(Probe::Launch).await;
        assert_eq!(snapshot_of(&fx.core, "jira").map(|s| (s.state, s.account)), Some((State::Ready, Some("Ann".into()))));

        let fx = jira_fixture(Arc::new(Jira { refused: true, gate: None, asked: Default::default() })).await;
        fx.core.probe_connections(Probe::Launch).await;
        assert_eq!(snapshot_of(&fx.core, "jira").map(|s| s.state), Some(State::NotSignedIn));
    }

    /// Accepts any token and keeps the expiry day exactly as `connect` was given it.
    struct Accepting;

    #[async_trait::async_trait]
    impl Authenticator for Accepting {
        async fn find_cloud_id(&self, _: &str) -> Result<Option<String>> {
            Ok(None)
        }
        async fn connect(&self, input: &TokenSignIn) -> Result<Credentials> {
            let site = crate::auth::Site { cloud_id: "site".into(), name: "Acme".into(), url: "https://acme.example".into() };
            let me = Account { account_id: "me".into(), name: "Ann".into(), avatar_url: None };
            Ok(Credentials { email: input.email.clone(), token: input.token.clone(), expires_on: input.expires_on.clone(), site, me })
        }
        async fn whoami(&self, _: &AccessToken) -> Result<Account> {
            Ok(Account { account_id: "me".into(), name: "Ann".into(), avatar_url: None })
        }
    }

    #[tokio::test]
    async fn a_token_connected_with_an_expiry_inside_two_weeks_is_probed_as_expiring_soon() {
        let vault = crate::secrets::fake::Fake::default();
        let _vault = crate::secrets::fake::install(&vault);
        let fx = fixture_with_authenticator(None, Some(Arc::new(Accepting))).await;
        fx.core.adopt_instances().await;
        let on = chrono::Local::now().date_naive() + chrono::Days::new(5);
        let input = TokenSignIn { site: "acme".into(), cloud_id: None, email: "ann@acme.com".into(), token: "tok".into(), expires_on: on.to_string() };
        fx.core.connect_jira(&input).await.unwrap();

        fx.core.probe_connections(Probe::Launch).await;
        let seen = snapshot_of(&fx.core, "jira").unwrap();
        assert_eq!((seen.state, seen.message.as_str()), (State::ExpiresSoon, "Token expires in 5 days"));

        let later = TokenSignIn { expires_on: (on + chrono::Days::new(300)).to_string(), ..input };
        fx.core.connect_jira(&later).await.unwrap();
        fx.core.probe_connections(Probe::Refresh).await;
        assert_eq!(snapshot_of(&fx.core, "jira").map(|s| s.state), Some(State::Ready));
    }

    #[tokio::test]
    async fn signing_in_to_another_jira_account_leaves_the_old_answer_behind_and_the_next_focus_probes_at_once() {
        let fx = jira_fixture(Jira::answering()).await;
        fx.core.probe_connections(Probe::Launch).await;
        fx.core.bind_instance(Binding::jira("jira:other:u2", "Globex", "https://globex.example"));
        assert!(snapshot_of(&fx.core, "jira").is_none());
        assert_eq!(fx.core.probe_connections(Probe::Focus).await, ["jira:other:u2"]);
        assert!(snapshot_of(&fx.core, "jira").is_some());
    }

    #[tokio::test]
    async fn an_answer_that_comes_back_after_the_instance_was_rebound_is_dropped() {
        let (gate, jira) = {
            let gate = Arc::new(tokio::sync::Notify::new());
            (gate.clone(), Arc::new(Jira { refused: false, gate: Some(gate), asked: Default::default() }))
        };
        let asked = jira.asked.clone();
        let fx = jira_fixture(jira).await;
        let core = fx.core.clone();
        let probing = tokio::spawn(async move { core.probe_connections(Probe::Launch).await });
        asked.notified().await;
        fx.core.bind_instance(Binding::jira("jira:other:u2", "Globex", "https://globex.example"));
        gate.notify_one();
        probing.await.unwrap();
        assert!(snapshot_of(&fx.core, "jira").is_none());
    }

    /// A fixture whose `gh` is a script in the returned folder, with a Jira instance that is off and a GitHub one for `alfhen`.
    async fn fixture_with_gh(name: &str) -> (crate::inbox::testing::Fixture, PathBuf) {
        let gh_dir = std::env::temp_dir().join(format!("gossamr-probes-{name}-{}", std::process::id()));
        gh_saying(&gh_dir, "alfhen", "success");
        let auth = GithubAuth::for_test(reqwest::Client::new(), Arc::new(crate::auth::MemoryStore::default()), "http://unused.invalid", None, vec![gh_dir.clone()]);
        let fx = fixture_with(Some(CodeService::with_factory(auth, Box::new(|_, _| unreachable!("no GitHub session")))))
            .await;
        fx.core.adopt_instances().await;
        fx.core.bind_instance(Binding::github("alfhen"));
        crate::config::AppConfig::update_if(&fx.core.data_dir(), |config| {
            config.connections.iter_mut().find(|i| i.id == "jira").unwrap().enabled = false;
            true
        })
        .unwrap();
        assert!(connections::is_live(&crate::config::AppConfig::load(&fx.core.data_dir())));
        (fx, gh_dir)
    }

    #[tokio::test]
    async fn each_instance_is_probed_by_its_kind_and_a_disabled_one_is_off_without_asking() {
        let (fx, _gh) = fixture_with_gh("kinds").await;
        let changed = fx.core.probe_connections(Probe::Launch).await;
        assert_eq!(changed, ["jira:site:me", "github:alfhen"]);
        assert_eq!(snapshot_of(&fx.core, "github").map(|s| (s.state, s.account)), Some((State::Ready, Some("alfhen".into()))));
        assert_eq!(snapshot_of(&fx.core, "jira").map(|s| s.state), Some(State::Off));
        let rows = fx.core.connections().await.unwrap();
        assert_eq!(rows[0].status.as_ref().map(|s| s.state), Some(State::Off));
    }

    #[tokio::test]
    async fn an_answer_is_reported_once_and_again_only_when_it_changes() {
        let (fx, gh) = fixture_with_gh("changes").await;
        fx.core.probe_connections(Probe::Launch).await;
        assert!(fx.core.probe_connections(Probe::Unauthorized).await.is_empty());
        gh_saying(&gh, "alfhen", "error");
        assert_eq!(fx.core.probe_connections(Probe::Unauthorized).await, ["github:alfhen"]);
        assert_eq!(snapshot_of(&fx.core, "github").map(|s| s.state), Some(State::NotSignedIn));
    }

    #[tokio::test]
    async fn pressing_refresh_reports_every_instance_so_the_checked_time_updates() {
        let (fx, _gh) = fixture_with_gh("refresh").await;
        fx.core.probe_connections(Probe::Launch).await;
        assert_eq!(fx.core.probe_connections(Probe::Refresh).await.len(), 2);
    }

    #[tokio::test]
    async fn a_window_focus_right_after_a_probe_asks_nothing_but_a_refresh_still_does() {
        let (fx, gh) = fixture_with_gh("focus").await;
        fx.core.probe_connections(Probe::Launch).await;
        gh_saying(&gh, "alfhen", "error");
        assert!(fx.core.probe_connections(Probe::Focus).await.is_empty());
        assert_eq!(snapshot_of(&fx.core, "github").map(|s| s.state), Some(State::Ready));
        fx.core.probe_connections(Probe::Refresh).await;
        assert_eq!(snapshot_of(&fx.core, "github").map(|s| s.state), Some(State::NotSignedIn));
    }

    #[tokio::test]
    async fn a_removed_instance_leaves_no_snapshot_behind() {
        let (fx, _gh) = fixture_with_gh("pruned").await;
        fx.core.probe_connections(Probe::Launch).await;
        fx.core.unbind_instance("github:alfhen");
        fx.core.probe_connections(Probe::Refresh).await;
        assert!(snapshot_of(&fx.core, "github").is_none());
    }
}
