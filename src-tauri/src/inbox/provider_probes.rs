//! Core's side of the provider probes: when each provider instance is asked how its login stands, and the last answer.
//! They run apart from the Jira and GitHub probes (`probes.last`), so a slow `claude` holds up nothing else.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{Core, Probe};
use crate::connections::ProviderInstance;
use crate::probe::{Snapshot, State};
use crate::provider_probe::{self, Folder, Timeouts};
use crate::runs::binary::find_binary_from;
use crate::runs::env::RunEnv;
use crate::runs::provider_env::ProviderState;
use crate::runs::provider_folder;

/// A window focus asks again only when the last answer was not `ready` or is older than this.
const FOCUS_AFTER: Duration = Duration::from_secs(5 * 60);

struct Answer {
    snapshot: Snapshot,
    at: Instant,
}

#[derive(Default)]
pub(super) struct ProviderProbes {
    answers: Mutex<HashMap<String, Answer>>,
    /// One lock per instance, held while it is probed, so two triggers never run its CLI at once.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Core {
    /// Probes every provider instance at the same time and returns the ids whose answer changed. A refresh reports all
    /// of them, because the page shows when they were checked. A Jira or GitHub refusal says nothing about a CLI login.
    pub async fn probe_providers(self: &Arc<Self>, why: Probe) -> Vec<String> {
        if why == Probe::Unauthorized {
            return Vec::new();
        }
        let setup = self.provider_setup().await;
        let mut probing = tokio::task::JoinSet::new();
        for (at, (instance, (_, state))) in setup.providers.into_iter().zip(setup.states).enumerate() {
            let (core, shell) = (self.clone(), setup.shell.clone());
            probing.spawn(async move { (at, core.probe_provider(instance, state, shell, why).await) });
        }
        let mut found = probing.join_all().await;
        found.sort_by_key(|(at, _)| *at);
        found.into_iter().filter_map(|(_, changed)| changed).collect()
    }

    /// Asks one instance how it stands whatever the last answer was, because the person just turned it on or off.
    pub async fn probe_provider_now(&self, instance_id: &str) {
        let setup = self.provider_setup().await;
        let Some((instance, (_, state))) = setup.providers.into_iter().zip(setup.states).find(|(p, _)| p.id == instance_id) else { return };
        self.probe_provider(instance, state, setup.shell, Probe::Refresh).await;
    }

    /// The last answer for `instance_id`.
    pub(super) fn provider_snapshot(&self, instance_id: &str) -> Option<Snapshot> {
        self.provider_probes.answers.lock().expect("provider probe lock poisoned").get(instance_id).map(|a| a.snapshot.clone())
    }

    /// A row just turned on must not keep reading Off while it is asked.
    pub(super) fn provider_answer_forget(&self, instance_id: &str) {
        self.provider_probes.answers.lock().expect("provider probe lock poisoned").remove(instance_id);
    }

    pub(super) fn provider_probes_forget(&self, instance_id: &str) {
        self.provider_answer_forget(instance_id);
        self.provider_probes.locks.lock().expect("provider probe lock poisoned").remove(instance_id);
    }

    fn provider_lock(&self, instance_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.provider_probes.locks.lock().expect("provider probe lock poisoned").entry(instance_id.to_string()).or_default().clone()
    }

    /// Returns the instance's id when the page should read it again.
    async fn probe_provider(&self, instance: ProviderInstance, state: ProviderState, shell: Option<Arc<RunEnv>>, why: Probe) -> Option<String> {
        // Only a probe that runs a CLI waits its turn. Off and error answers spawn nothing, so turning an instance off
        // never waits behind a CLI that is hung.
        let lock = self.provider_lock(&instance.id);
        let _one_at_a_time = match state {
            ProviderState::Ready(_) => Some(lock.lock().await),
            _ => None,
        };
        let previous = {
            let answers = self.provider_probes.answers.lock().expect("provider probe lock poisoned");
            answers.get(&instance.id).map(|a| (a.snapshot.clone(), a.at.elapsed()))
        };
        if why == Probe::Focus && previous.as_ref().is_some_and(|(s, age)| s.state == State::Ready && *age < FOCUS_AFTER) {
            return None;
        }
        let previous = previous.map(|(snapshot, _)| snapshot);
        let now = self.provider_answer(&instance, &state, shell.as_deref()).await.keeping_account_of(previous.as_ref());
        let changed = why == Probe::Refresh || previous.as_ref().is_none_or(|p| !p.same_as(&now));
        // An answer about an instance that was removed, turned on or off, or given another folder while it was
        // being asked is about the wrong thing.
        if !self.provider_unchanged(&instance) {
            return None;
        }
        self.provider_probes.answers.lock().expect("provider probe lock poisoned").insert(instance.id.clone(), Answer { snapshot: now, at: Instant::now() });
        changed.then_some(instance.id)
    }

    fn provider_unchanged(&self, instance: &ProviderInstance) -> bool {
        let config = crate::config::AppConfig::load(&self.data_dir);
        config.providers.iter().any(|p| p.id == instance.id && p.enabled == instance.enabled && p.config.config_dir == instance.config.config_dir)
    }

    /// Off and error instances spawn nothing.
    async fn provider_answer(&self, instance: &ProviderInstance, state: &ProviderState, shell: Option<&RunEnv>) -> Snapshot {
        let login = match state {
            ProviderState::Off => return provider_probe::off(),
            ProviderState::Error(problem) => return provider_probe::error(problem),
            ProviderState::Unavailable(why) => return provider_probe::error(why.message()),
            ProviderState::Ready(login) => login,
        };
        // Ready without a capture means the instance has a folder, which replaces every login variable the app's own
        // environment could have supplied.
        let base = shell.cloned().unwrap_or_else(|| RunEnv::from_pairs(std::env::vars_os()));
        let env = login.over(&base);
        let binary = find_binary_from(self.home.as_deref(), instance.driver, &env);
        let typed = instance.config.config_dir.as_deref();
        let path = typed.map(|t| provider_folder::expand(t, self.home.as_deref().unwrap_or(Path::new(""))));
        let folder = typed.zip(path.as_deref()).map(|(typed, path)| Folder { typed, path });
        provider_probe::probe(instance.driver, binary.as_deref(), folder, &env, Timeouts::default()).await
    }

    #[cfg(test)]
    pub(super) fn age_provider_answers(&self, by: Duration) {
        for answer in self.provider_probes.answers.lock().unwrap().values_mut() {
            answer.at -= by;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::connections::{self, Driver, ProviderConfig};
    use crate::inbox::testing::{fixture_with_shell, Fixture};
    use crate::runs::env::ShellCapture;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn script(path: &Path, body: &str) -> String {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    /// A shell whose capture holds a PATH only, so the `claude` the tests install in the home folder is the one found.
    async fn fixture() -> Fixture {
        let dir = std::env::temp_dir().join(format!("gossamr-provider-probes-{}-{:?}", std::process::id(), std::thread::current().id()));
        let shell = script(&dir.join("fakeshell"), "printf '\\0GOSSAMR_ENV_BEGIN\\0PATH=/usr/bin:/bin\\0ANTHROPIC_API_KEY=sk-shell\\0'");
        let fx = fixture_with_shell(ShellCapture::with_shell(&shell)).await;
        AppConfig::update(&fx.core.data_dir(), |config| config.providers = vec![connections::default_claude()]).unwrap();
        fx
    }

    /// Installs a `claude` that logs each run to `calls`, one line of the folder it ran with, and answers like `signed_in`.
    fn install_claude(fx: &Fixture, status: &str) -> PathBuf {
        let calls = fx.home.join("calls");
        script(
            &fx.home.join(".local/bin/claude"),
            &format!("[ \"$1\" = \"--version\" ] && {{ echo '2.1.316 (Claude Code)'; exit 0; }}\necho \"${{CLAUDE_CONFIG_DIR:-default}} ${{ANTHROPIC_API_KEY:-nokey}}\" >> '{}'\ncat <<'JSON'\n{status}\nJSON", calls.display()),
        );
        calls
    }

    fn runs(calls: &Path) -> Vec<String> {
        std::fs::read_to_string(calls).map(|t| t.lines().map(String::from).collect()).unwrap_or_default()
    }

    const IN: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"alf@acme.com"}"#;
    const OUT: &str = r#"{"loggedIn":false}"#;

    fn add(fx: &Fixture, id: &str, folder: Option<&str>, enabled: bool) {
        AppConfig::update(&fx.core.data_dir(), |config| {
            config.providers.push(connections::ProviderInstance { id: id.into(), driver: Driver::Claude, display_name: id.into(), enabled, config: ProviderConfig { config_dir: folder.map(Into::into), ..Default::default() }, extra: Default::default() });
        })
        .unwrap();
    }

    fn state_of(fx: &Fixture, id: &str) -> Option<State> {
        fx.core.provider_snapshot(id).map(|s| s.state)
    }

    #[tokio::test]
    async fn the_default_instance_is_probed_with_the_shells_login_and_its_answer_is_on_its_row() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        assert_eq!(fx.core.probe_providers(Probe::Launch).await, ["claude"]);
        let seen = fx.core.provider_snapshot("claude").unwrap();
        assert_eq!((seen.state, seen.account.as_deref(), seen.message.as_str()), (State::Ready, Some("alf@acme.com"), "Authenticated · alf@acme.com"));
        assert_eq!(runs(&calls), ["default sk-shell"]);
        let rows = fx.core.settings_rows().await.unwrap();
        assert_eq!(rows.last().and_then(|r| r.status.as_ref()).map(|s| s.state), Some(State::Ready));
    }

    #[tokio::test]
    async fn an_instance_with_a_folder_is_probed_in_that_folder_without_the_shells_key() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        add(&fx, "claude_2", Some("~/.claude-work"), true);
        fx.core.probe_providers(Probe::Launch).await;
        let mut seen = runs(&calls);
        seen.sort();
        assert_eq!(seen, [format!("{} nokey", fx.home.join(".claude-work").display()), "default sk-shell".to_string()]);
    }

    #[tokio::test]
    async fn an_instance_that_is_off_or_has_an_unusable_folder_spawns_nothing_and_says_why() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        add(&fx, "claude_2", Some("~/.claude-work"), false);
        add(&fx, "claude_3", Some("/tmp/outside-home"), true);
        AppConfig::update(&fx.core.data_dir(), |config| config.providers.retain(|p| p.id != "claude")).unwrap();
        fx.core.probe_providers(Probe::Launch).await;
        assert_eq!(runs(&calls), Vec::<String>::new());
        assert_eq!(state_of(&fx, "claude_2"), Some(State::Off));
        let broken = fx.core.provider_snapshot("claude_3").unwrap();
        assert_eq!(broken.state, State::Error);
        assert!(broken.message.starts_with("This folder can't be used: "), "{}", broken.message);
    }

    #[tokio::test]
    async fn a_failed_shell_capture_is_an_error_on_the_default_and_a_folder_instance_is_still_probed() {
        let fx = fixture_with_shell(ShellCapture::with_shell("/nonexistent/shell")).await;
        AppConfig::update(&fx.core.data_dir(), |config| config.providers = vec![connections::default_claude()]).unwrap();
        let calls = install_claude(&fx, IN);
        add(&fx, "claude_2", Some("~/.claude-work"), true);
        fx.core.probe_providers(Probe::Launch).await;
        let default = fx.core.provider_snapshot("claude").unwrap();
        assert_eq!((default.state, default.message.as_str()), (State::Error, "Couldn't read your shell setup"));
        assert_eq!(state_of(&fx, "claude_2"), Some(State::Ready), "a folder needs no capture to choose its login");
        assert_eq!(runs(&calls).len(), 1);
    }

    #[tokio::test]
    async fn turning_an_instance_on_or_off_asks_it_at_once_and_a_removed_one_leaves_no_answer() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        fx.core.probe_providers(Probe::Launch).await;
        fx.core.set_instance_enabled("claude", false).await.unwrap();
        fx.core.probe_provider_now("claude").await;
        assert_eq!(state_of(&fx, "claude"), Some(State::Off));
        fx.core.set_instance_enabled("claude", true).await.unwrap();
        fx.core.probe_provider_now("claude").await;
        assert_eq!(state_of(&fx, "claude"), Some(State::Ready));
        assert_eq!(runs(&calls).len(), 2, "off spawned nothing");
        fx.core.provider_remove("claude").unwrap();
        assert_eq!(state_of(&fx, "claude"), None);
    }

    #[tokio::test]
    async fn a_focus_asks_a_ready_instance_again_only_after_five_minutes_and_a_signed_out_one_every_time() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        fx.core.probe_providers(Probe::Launch).await;
        assert!(fx.core.probe_providers(Probe::Focus).await.is_empty());
        assert_eq!(runs(&calls).len(), 1);

        fx.core.age_provider_answers(Duration::from_secs(5 * 60 + 1));
        assert!(fx.core.probe_providers(Probe::Focus).await.is_empty(), "asked again, but the answer is the same");
        assert_eq!(runs(&calls).len(), 2);

        install_claude(&fx, OUT);
        fx.core.probe_providers(Probe::Refresh).await;
        assert_eq!(state_of(&fx, "claude"), Some(State::NotSignedIn));
        fx.core.probe_providers(Probe::Focus).await;
        fx.core.probe_providers(Probe::Focus).await;
        assert_eq!(runs(&calls).len(), 5);
    }

    #[tokio::test]
    async fn a_refresh_always_asks_and_reports_every_instance_even_when_nothing_changed() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        add(&fx, "claude_2", Some("~/.claude-work"), false);
        fx.core.probe_providers(Probe::Launch).await;
        assert_eq!(fx.core.probe_providers(Probe::Refresh).await, ["claude", "claude_2"]);
        assert_eq!(runs(&calls).len(), 2);
    }

    #[tokio::test]
    async fn a_refusal_from_jira_or_github_asks_no_provider_anything() {
        let fx = fixture().await;
        let calls = install_claude(&fx, IN);
        assert!(fx.core.probe_providers(Probe::Unauthorized).await.is_empty());
        assert_eq!((runs(&calls).len(), state_of(&fx, "claude")), (0, None));
    }

    #[tokio::test]
    async fn the_instances_are_probed_at_the_same_time() {
        let fx = fixture().await;
        let calls = fx.home.join("calls");
        script(&fx.home.join(".local/bin/claude"), &format!("[ \"$1\" = \"--version\" ] && exit 0\nsleep 1\necho x >> '{}'\necho '{IN}'", calls.display()));
        add(&fx, "claude_2", Some("~/.claude-a"), true);
        add(&fx, "claude_3", Some("~/.claude-b"), true);
        let started = Instant::now();
        fx.core.probe_providers(Probe::Launch).await;
        assert_eq!(runs(&calls).len(), 3);
        assert!(started.elapsed() < Duration::from_millis(2500), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_slow_provider_holds_up_neither_the_connection_probes_nor_a_look_at_another_instance() {
        let fx = fixture().await;
        script(&fx.home.join(".local/bin/claude"), "[ \"$1\" = \"--version\" ] && exit 0\nsleep 2\necho '{\"loggedIn\":false}'");
        let core = fx.core.clone();
        let slow = tokio::spawn(async move { core.probe_providers(Probe::Launch).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        fx.core.probe_connections(Probe::Launch).await;
        fx.core.probe_instance_now("jira").await;
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        slow.await.unwrap();
    }

    #[tokio::test]
    async fn turning_an_instance_off_does_not_wait_for_a_probe_of_it_that_is_still_running() {
        let fx = fixture().await;
        script(&fx.home.join(".local/bin/claude"), "[ \"$1\" = \"--version\" ] && exit 0\nsleep 2\necho '{\"loggedIn\":false}'");
        let core = fx.core.clone();
        let slow = tokio::spawn(async move { core.probe_providers(Probe::Launch).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        fx.core.set_instance_enabled("claude", false).await.unwrap();
        fx.core.probe_provider_now("claude").await;
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        assert_eq!(state_of(&fx, "claude"), Some(State::Off));
        slow.await.unwrap();
        assert_eq!(state_of(&fx, "claude"), Some(State::Off), "the late answer is about an instance that is now off");
    }

    #[tokio::test]
    async fn turning_an_instance_on_drops_its_off_answer_until_it_is_asked() {
        let fx = fixture().await;
        install_claude(&fx, IN);
        fx.core.set_instance_enabled("claude", false).await.unwrap();
        fx.core.probe_provider_now("claude").await;
        fx.core.set_instance_enabled("claude", true).await.unwrap();
        assert_eq!(state_of(&fx, "claude"), None);
    }

    #[tokio::test]
    async fn two_triggers_for_one_instance_never_run_its_cli_at_once() {
        let fx = fixture().await;
        let calls = fx.home.join("calls");
        script(&fx.home.join(".local/bin/claude"), &format!("[ \"$1\" = \"--version\" ] && exit 0\necho start >> '{0}'\nsleep 0.5\necho end >> '{0}'\necho '{IN}'", calls.display()));
        let (a, b) = (fx.core.clone(), fx.core.clone());
        let _ = tokio::join!(a.probe_providers(Probe::Refresh), b.probe_providers(Probe::Refresh));
        assert_eq!(runs(&calls), ["start", "end", "start", "end"]);
    }

    #[tokio::test]
    async fn an_answer_that_arrives_after_the_instance_was_removed_is_dropped() {
        let fx = fixture().await;
        script(&fx.home.join(".local/bin/claude"), &format!("[ \"$1\" = \"--version\" ] && exit 0\nsleep 1\necho '{IN}'"));
        let core = fx.core.clone();
        let probing = tokio::spawn(async move { core.probe_providers(Probe::Launch).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        fx.core.provider_remove("claude").unwrap();
        assert!(probing.await.unwrap().is_empty());
        assert_eq!(state_of(&fx, "claude"), None);
    }

    #[tokio::test]
    async fn a_probe_that_could_not_tell_keeps_the_account_found_before() {
        let fx = fixture().await;
        install_claude(&fx, IN);
        fx.core.probe_providers(Probe::Launch).await;
        install_claude(&fx, "garbage");
        fx.core.probe_providers(Probe::Refresh).await;
        let seen = fx.core.provider_snapshot("claude").unwrap();
        assert_eq!((seen.state, seen.account.as_deref()), (State::Error, Some("alf@acme.com")));
    }
}
