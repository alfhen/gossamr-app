//! Core's side of the probes: when each connection instance is asked how it stands, and the last answer for each.

use std::collections::HashMap;
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

#[derive(Default)]
pub(super) struct Probes {
    snapshots: Mutex<HashMap<String, Snapshot>>,
    /// Held while probing, so two triggers never run `gh` at once; it keeps when the last probe finished.
    last: tokio::sync::Mutex<Option<Instant>>,
}

impl Core {
    /// Probes every instance, and returns the connection (or instance, before it has one) of each whose answer changed.
    /// A refresh reports all of them, because the page shows when they were checked.
    pub async fn probe_connections(&self, why: Probe) -> Vec<String> {
        let mut last = self.probes.last.lock().await;
        if why == Probe::Focus && last.is_some_and(|at| at.elapsed() < FOCUS_EVERY) {
            return Vec::new();
        }
        let config = AppConfig::load(&self.data_dir);
        let mut found = HashMap::new();
        let mut changed = Vec::new();
        for instance in &config.connections {
            let previous = self.probe_snapshot(&instance.id);
            let now = self.probe_instance(instance).await.keeping_account_of(previous.as_ref());
            if why == Probe::Refresh || previous.as_ref().is_none_or(|p| !p.same_as(&now)) {
                changed.push(instance.bound_to.clone().unwrap_or_else(|| instance.id.clone()));
            }
            found.insert(instance.id.clone(), now);
        }
        *self.probes.snapshots.lock().expect("probe lock poisoned") = found;
        *last = Some(Instant::now());
        changed
    }

    pub(super) fn probe_snapshot(&self, instance_id: &str) -> Option<Snapshot> {
        self.probes.snapshots.lock().expect("probe lock poisoned").get(instance_id).cloned()
    }

    async fn probe_instance(&self, instance: &Instance) -> Snapshot {
        if !instance.enabled {
            return Snapshot::off();
        }
        match instance.kind {
            ConnectionKind::Jira => probe::jira(tokio::time::timeout(probe::TIMEOUT, self.auth.whoami()).await.ok()),
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
    use crate::inbox::testing::fixture_with;
    use crate::inbox::CodeService;
    use crate::probe::State;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn gh_saying(dir: &std::path::Path, login: &str, state: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("gh");
        let status = format!(r#"{{"hosts":{{"github.com":[{{"state":"{state}","host":"github.com","login":"{login}"}}]}}}}"#);
        std::fs::write(&path, format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\necho '{status}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
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
        assert_eq!(fx.core.probe_snapshot("github").map(|s| (s.state, s.account)), Some((State::Ready, Some("alfhen".into()))));
        assert_eq!(fx.core.probe_snapshot("jira").map(|s| s.state), Some(State::Off));
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
        assert_eq!(fx.core.probe_snapshot("github").map(|s| s.state), Some(State::NotSignedIn));
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
        assert_eq!(fx.core.probe_snapshot("github").map(|s| s.state), Some(State::Ready));
        fx.core.probe_connections(Probe::Refresh).await;
        assert_eq!(fx.core.probe_snapshot("github").map(|s| s.state), Some(State::NotSignedIn));
    }

    #[tokio::test]
    async fn a_removed_instance_leaves_no_snapshot_behind() {
        let (fx, _gh) = fixture_with_gh("pruned").await;
        fx.core.probe_connections(Probe::Launch).await;
        fx.core.unbind_instance("github:alfhen");
        fx.core.probe_connections(Probe::Refresh).await;
        assert!(fx.core.probe_snapshot("github").is_none());
    }
}
