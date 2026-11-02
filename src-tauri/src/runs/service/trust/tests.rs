use super::*;
use crate::connections::{ProviderConfig, ProviderInstance};
use crate::domain::RunSpec;
use crate::inbox::testing::fixture_watching;
use crate::runs::repo::testing::clone_with_origin;
use crate::runs::rig::{legacy_clone, ready_in, Rig};

/// A signed-in default login in the fixture's home folder: `$HOME/.claude.json` holds `settings` (CLONE stands for the
/// run's clone), or there is no file when it is None. Nothing here touches a real Claude folder.
struct Login {
    rig: Rig,
    file: PathBuf,
}

async fn login_with(settings: Option<&str>, extra: &[(&str, String)]) -> Login {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let home = fx.home.canonicalize().unwrap();
    let file = home.join(".claude.json");
    let mut vars = vec![("HOME", home.to_string_lossy().into_owned())];
    vars.extend(extra.iter().cloned());
    let rig = ready_in(fx, &vars, |svc| svc).await;
    rig.cli.with(|s| s.config_dir = home.join(".claude"));
    if let Some(text) = settings {
        std::fs::write(&file, text.replace("CLONE", &rig.clone.to_string_lossy())).unwrap();
    }
    Login { rig, file }
}

async fn login(settings: &str) -> Login {
    login_with(Some(settings), &[]).await
}

const NO_ENTRY: &str = "{\n  \"numStartups\": 3\n}";

impl Login {
    fn text(&self) -> String {
        std::fs::read_to_string(&self.file).unwrap_or_default()
    }

    /// A run the pre-flight refused, or the first launch did.
    async fn untrusted(&self, n: u32) -> Run {
        let queued = self.rig.queued(n).await;
        let run = self.rig.svc.start_now(&queued.id).await.unwrap();
        assert_eq!((run.state, run.short_id.is_none()), (RunState::Failed, true), "{:?}", run.error);
        run
    }

    async fn refused(&self, run: &Run) -> String {
        let before = self.text();
        let why = self.rig.svc.retry_with_trust(&run.id).await.unwrap_err().to_string();
        assert_eq!(self.text(), before, "nothing was written");
        assert_eq!(self.rig.cli.launches(), 0);
        why
    }
}

fn kinds(events: &[RunEvent]) -> Vec<&str> {
    events.iter().map(|e| e.kind.as_str()).collect()
}

#[tokio::test]
async fn a_missing_or_false_entry_fails_the_run_at_once_without_starting_claude() {
    for settings in [NO_ENTRY, "{\"projects\": {\"CLONE\": {\"hasTrustDialogAccepted\": false}}}"] {
        let l = login(settings).await;
        let run = l.untrusted(1).await;
        assert_eq!(run.failure, Some(RunFailure::UntrustedFolder { path: l.rig.clone.clone() }));
        assert_eq!(l.rig.cli.launches(), 0, "{settings}");
    }
}

#[tokio::test]
async fn a_trusted_entry_a_trusted_parent_no_file_or_an_unreadable_one_launches_as_before() {
    let parent = "{\"projects\": {\"HOME\": {\"hasTrustDialogAccepted\": true}}}";
    let cases = [
        Some("{\"projects\": {\"CLONE\": {\"hasTrustDialogAccepted\": true}}}"),
        Some(parent),
        None,
        Some("not json at all"),
        Some("{\"projects\": [1]}"),
    ];
    for settings in cases {
        let l = login_with(None, &[]).await;
        let text = settings.map(|t| t.replace("HOME", &l.rig.clone.parent().unwrap().to_string_lossy()).replace("CLONE", &l.rig.clone.to_string_lossy()));
        if let Some(text) = text {
            std::fs::write(&l.file, text).unwrap();
        }
        let queued = l.rig.queued(1).await;
        let run = l.rig.svc.start_now(&queued.id).await.unwrap();
        assert_eq!((run.state, l.rig.cli.launches()), (RunState::Launching, 1), "{settings:?}");
    }
}

#[tokio::test]
async fn a_login_whose_file_cannot_be_named_launches_as_before() {
    let l = login_with(Some(NO_ENTRY), &[("CLAUDE_CODE_CUSTOM_OAUTH_URL", "https://auth.example".into())]).await;
    let queued = l.rig.queued(1).await;
    assert_eq!(l.rig.svc.start_now(&queued.id).await.unwrap().state, RunState::Launching);
}

#[tokio::test]
async fn trusting_writes_one_entry_records_it_and_starts_the_run() {
    let l = login(NO_ENTRY).await;
    let run = l.untrusted(1).await;
    let started = l.rig.svc.retry_with_trust(&run.id).await.unwrap();
    assert_eq!((started.state, l.rig.cli.launches()), (RunState::Launching, 1));
    let saved: serde_json::Value = serde_json::from_str(&l.text()).unwrap();
    assert_eq!(saved["projects"][l.rig.clone.to_str().unwrap()]["hasTrustDialogAccepted"], true);
    assert_eq!(saved["numStartups"], 3);
    assert!(l.text().starts_with("{\n  \"numStartups\": 3,"));
    assert!(kinds(&l.rig.fx.core.run_events(&run.id).await.unwrap()).contains(&"trust_saved"));
    assert!(!PathBuf::from(format!("{}.lock", l.file.display())).exists());
}

#[tokio::test]
async fn a_clone_trusted_in_terminal_meanwhile_is_retried_without_a_write() {
    let l = login(NO_ENTRY).await;
    let run = l.untrusted(1).await;
    let trusted = "{\"projects\": {\"CLONE\": {\"hasTrustDialogAccepted\": true}}}".replace("CLONE", &l.rig.clone.to_string_lossy());
    std::fs::write(&l.file, &trusted).unwrap();
    let started = l.rig.svc.retry_with_trust(&run.id).await.unwrap();
    assert_eq!((started.state, l.text()), (RunState::Launching, trusted));
    assert!(!kinds(&l.rig.fx.core.run_events(&run.id).await.unwrap()).contains(&"trust_saved"));
}

#[tokio::test]
async fn two_runs_on_one_clone_write_once() {
    let l = login(NO_ENTRY).await;
    let (first, second) = (l.untrusted(1).await, l.untrusted(2).await);
    l.rig.svc.retry_with_trust(&first.id).await.unwrap();
    let after_first = l.text();
    let started = l.rig.svc.retry_with_trust(&second.id).await.unwrap();
    assert_eq!((started.state, l.text()), (RunState::Launching, after_first));
}

#[tokio::test]
async fn a_run_that_did_not_fail_for_trust_is_refused() {
    let l = login(NO_ENTRY).await;
    let queued = l.rig.queued(1).await;
    assert!(l.refused(&queued).await.contains("only for a run that failed because Claude doesn't trust"));
    let signed_out = l.rig.set(&l.untrusted(2).await, |r| r.failure = Some(RunFailure::NotSignedIn)).await;
    assert!(l.refused(&signed_out).await.contains("only for a run that failed"));
    let with_session = l.rig.set(&l.untrusted(3).await, |r| r.short_id = crate::runs::cli::ShortId::parse("b0000001")).await;
    assert!(l.refused(&with_session).await.contains("only for a run that failed"));
}

#[tokio::test]
async fn a_legacy_untrusted_run_in_a_code_folder_is_refused() {
    let l = login(NO_ENTRY).await;
    let legacy = legacy_clone(&l.rig.fx);
    let run = l.untrusted(1).await;
    let run = l.rig.set(&run, |r| r.spec.clone_path = legacy.clone()).await;
    assert_eq!(l.refused(&run).await, Refusal::NotOurClone.words("Claude"));
}

async fn refused_when(l: &Login, n: u32, change: impl FnOnce(&mut Run)) {
    let run = l.untrusted(n).await;
    let run = l.rig.set(&run, change).await;
    assert_eq!(l.refused(&run).await, Refusal::NotOurClone.words("Claude"));
}

#[tokio::test]
async fn only_the_clone_itself_is_trusted_never_a_worktree_the_work_folder_or_a_link() {
    let l = login(NO_ENTRY).await;
    let clone = l.rig.clone.clone();
    let worktree = clone.join(".claude/worktrees/eng-1-fix-cart-0001");
    std::fs::create_dir_all(&worktree).unwrap();
    refused_when(&l, 1, |r| r.spec.clone_path = worktree.clone()).await;
    let root = clone.parent().unwrap().parent().unwrap().to_path_buf();
    refused_when(&l, 2, |r| r.spec.clone_path = root.clone()).await;
    refused_when(&l, 3, |r| r.spec.clone_path = root.join("acme")).await;
}

#[tokio::test]
async fn a_clone_that_is_a_link_is_not_trusted() {
    let l = login(NO_ENTRY).await;
    let run = l.untrusted(1).await;
    let elsewhere = l.rig.fx.dir.join("moved-clone");
    std::fs::rename(&l.rig.clone, &elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &l.rig.clone).unwrap();
    assert_eq!(l.refused(&run).await, Refusal::NotOurClone.words("Claude"));
}

#[tokio::test]
async fn a_clone_of_a_repository_you_do_not_watch_or_with_another_origin_is_not_trusted() {
    let l = login(NO_ENTRY).await;
    let other = l.rig.clone.parent().unwrap().parent().unwrap().join("other/thing");
    clone_with_origin(&other, "https://github.com/other/thing.git");
    let other = other.canonicalize().unwrap();
    refused_when(&l, 1, |r| (r.spec.repo, r.spec.clone_path) = ("other/thing".into(), other.clone())).await;

    let l = login(NO_ENTRY).await;
    let run = l.untrusted(1).await;
    std::fs::write(l.rig.clone.join(".fake-origin"), "https://github.com/other/thing.git\n").unwrap();
    assert_eq!(l.refused(&run).await, Refusal::NotOurClone.words("Claude"));
}

#[tokio::test]
async fn a_linked_gossamr_folder_is_trusted_only_by_its_real_path() {
    let l = login(NO_ENTRY).await;
    let home = l.rig.fx.home.canonicalize().unwrap();
    let moved = l.rig.fx.dir.join("elsewhere");
    std::fs::create_dir_all(&moved).unwrap();
    std::fs::rename(home.join("Gossamr"), moved.join("Gossamr")).unwrap();
    std::os::unix::fs::symlink(moved.join("Gossamr"), home.join("Gossamr")).unwrap();
    let real = moved.canonicalize().unwrap().join("Gossamr/agents/acme/webshop");
    let through_the_link = home.join("Gossamr/agents/acme/webshop");

    let run = l.untrusted_in(1, &real).await;
    let stored = l.rig.set(&run, |r| r.spec.clone_path = through_the_link.clone()).await;
    assert_eq!(l.refused(&stored).await, Refusal::NotOurClone.words("Claude"));

    let there = l.rig.set(&run, |r| r.spec.clone_path = real.clone()).await;
    l.rig.svc.retry_with_trust(&there.id).await.unwrap();
    assert!(l.text().contains(real.to_str().unwrap()));
}

impl Login {
    /// A failed-untrusted run whose clone is `path`.
    async fn untrusted_in(&self, n: u32, path: &Path) -> Run {
        let queued = self.rig.fx.core.queue_test_run(RunSpec { clone_path: path.to_path_buf(), ..self.rig.spec(n) }, Some(self.rig.fx.item("CA-1"))).await.unwrap();
        self.rig
            .set(&queued, |r| {
                r.state = RunState::Failed;
                r.failure = Some(RunFailure::UntrustedFolder { path: path.to_path_buf() });
            })
            .await
    }
}

#[tokio::test]
async fn a_file_that_cannot_be_trusted_is_refused_in_the_cards_words() {
    let l = login_with(None, &[]).await;
    let run = l.untrusted_in(1, &l.rig.clone).await;
    assert_eq!(l.refused(&run).await, Refusal::Missing.words("Claude"));

    let l = login_with(Some(NO_ENTRY), &[("CLAUDE_CODE_IGNORE_PERSISTED_TRUST", "1".into())]).await;
    let run = l.untrusted_in(1, &l.rig.clone).await;
    assert_eq!(l.refused(&run).await, Refusal::CantTell.words("Claude"));

    let l = login("[]").await;
    let run = l.untrusted_in(1, &l.rig.clone).await;
    assert_eq!(l.refused(&run).await, Refusal::UnsafeFile.words("Claude"));
}

#[tokio::test]
async fn a_config_directory_that_disagrees_with_the_environment_is_refused() {
    let l = login(NO_ENTRY).await;
    let run = l.untrusted(1).await;
    l.rig.cli.with(|s| s.config_dir = l.rig.fx.dir.join("another-login"));
    assert_eq!(l.refused(&run).await, Refusal::CantTell.words("Claude"));
}

#[tokio::test]
async fn start_up_removes_the_temp_files_a_crash_left_in_the_folders_it_knows() {
    let l = login(NO_ENTRY).await;
    let home = l.rig.fx.home.canonicalize().unwrap();
    let work = home.join(".claude-work");
    std::fs::create_dir_all(&work).unwrap();
    let instance = ProviderInstance { id: "claude-work".into(), driver: Driver::Claude, display_name: "Work".into(), enabled: true, config: ProviderConfig { config_dir: Some("~/.claude-work".into()), ..Default::default() }, extra: Default::default() };
    AppConfig::update(&l.rig.fx.core.data_dir(), |c| c.providers.push(instance)).unwrap();
    for dir in [&home, &work] {
        std::fs::write(dir.join(".claude.json.gossamr-0a1b"), "{}").unwrap();
    }
    std::fs::write(home.join(".claude.json.bak"), "kept").unwrap();
    l.rig.svc.clean_trust_leftovers();
    assert!(!home.join(".claude.json.gossamr-0a1b").exists() && !work.join(".claude.json.gossamr-0a1b").exists());
    assert!(home.join(".claude.json.bak").exists());
}
