use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

use super::*;
use crate::config::AppConfig;
use crate::connections::{self, ProviderInstance};
use crate::runs::env::RunEnv;
use crate::runs::rig::{ready, Rig};
use crate::runs::testing::FakeCli;
use crate::runs::toolchain::ToolchainSource;

fn pick(instance: &str, model: &str) -> ModelChoice {
    ModelChoice { instance_id: instance.into(), model: model.into(), effort: None }
}

fn add_second_claude(rig: &Rig) {
    AppConfig::update(&rig.fx.core.data_dir(), |config| config.providers.push(ProviderInstance { id: "claude_2".into(), display_name: "Claude personal".into(), ..connections::default_claude() })).unwrap();
}

async fn launch_request(rig: &Rig) -> crate::runs::cli::LaunchRequest {
    rig.cli.0.lock().unwrap().launches.last().cloned().expect("a launch")
}

/// Each instance gets its own scripted `claude`; `get()` is counted because a run on an instance must never use it.
struct Instances {
    default: Toolchain,
    by_id: HashMap<String, std::result::Result<Toolchain, ToolchainError>>,
    gets: AtomicUsize,
}

#[async_trait]
impl ToolchainSource for Instances {
    async fn get(&self) -> std::result::Result<Toolchain, ToolchainError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        Ok(self.default.clone())
    }

    async fn for_instance(&self, id: &str) -> std::result::Result<Toolchain, ToolchainError> {
        self.by_id.get(id).cloned().unwrap_or_else(|| Err(ToolchainError::UnknownInstance(id.into())))
    }
}

/// The environment the shared rig gives `claude`, with the fake `git` on its path.
fn rig_env(rig: &Rig) -> Arc<RunEnv> {
    let bin = crate::runs::repo::testing::install_fake_git(&rig.fx.dir);
    Arc::new(RunEnv::from_pairs([("PATH", format!("{}:/usr/bin:/bin", bin.display())), ("FAKE_GIT_LOG", rig.fx.dir.join("git.log").to_string_lossy().into_owned())]))
}

fn toolchain_named(id: &str, name: &str) -> Toolchain {
    let mut tc = Toolchain::new(Arc::new(FakeCli::new()), Arc::new(RunEnv::from_pairs([("WHO", id)])));
    tc.instance_id = id.into();
    tc.instance_name = name.into();
    tc
}

#[tokio::test]
async fn a_run_queued_with_no_workstream_choice_gets_the_settings_default_for_agents() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    assert_eq!(run.runs_on, Some(pick("claude", "default")));
}

#[tokio::test]
async fn a_run_queued_in_a_workstream_gets_that_workstreams_choice_and_one_queued_before_the_change_keeps_its_own() {
    let rig = ready().await;
    add_second_claude(&rig);
    let ws = rig.fx.core.open_workstream(&rig.fx.scope, Some(rig.fx.item("CA-1")), None).await.unwrap();
    let before = rig.fx.core.queue_test_run(crate::domain::RunSpec { workstream: Some(ws.id.clone()), ..rig.spec(1) }, Some(rig.fx.item("CA-1"))).await.unwrap();
    let set = rig.fx.core.set_workstream_model(&rig.fx.scope, &ws.id, Some(pick("claude_2", "opus"))).await.unwrap();
    assert_eq!(set.agents_model, Some(pick("claude_2", "opus")));
    let after = rig.fx.core.queue_test_run(crate::domain::RunSpec { workstream: Some(ws.id.clone()), ..rig.spec(2) }, Some(rig.fx.item("CA-1"))).await.unwrap();
    assert_eq!((before.runs_on, after.runs_on), (Some(pick("claude", "default")), Some(pick("claude_2", "opus"))));

    rig.fx.core.set_workstream_model(&rig.fx.scope, &ws.id, None).await.unwrap();
    let third = rig.fx.core.queue_test_run(crate::domain::RunSpec { workstream: Some(ws.id), ..rig.spec(3) }, Some(rig.fx.item("CA-1"))).await.unwrap();
    assert_eq!(third.runs_on, Some(pick("claude", "default")));
}

#[tokio::test]
async fn a_workstream_refuses_a_model_its_instance_does_not_list_and_a_closed_workstream_takes_none() {
    let rig = ready().await;
    let ws = rig.fx.core.open_workstream(&rig.fx.scope, Some(rig.fx.item("CA-1")), None).await.unwrap();
    let refused = rig.fx.core.set_workstream_model(&rig.fx.scope, &ws.id, Some(pick("claude", "gpt-9"))).await;
    assert!(matches!(refused, Err(Error::Input(words)) if words == "Pick a model for this run."));
    rig.fx.core.close_workstream(&rig.fx.scope, &ws.id).await.unwrap();
    assert!(rig.fx.core.set_workstream_model(&rig.fx.scope, &ws.id, Some(pick("claude", "opus"))).await.is_err());
}

#[tokio::test]
async fn a_run_launches_with_the_model_it_was_given_and_with_none_for_default() {
    let rig = ready().await;
    let (named, plain) = (rig.queued(1).await, rig.queued(2).await);
    rig.svc.set_model(&named.id, pick("claude", "sonnet")).await.unwrap();
    rig.svc.start_now(&named.id).await.unwrap();
    assert_eq!(launch_request(&rig).await.model.as_deref(), Some("sonnet"));
    rig.svc.start_now(&plain.id).await.unwrap();
    assert_eq!(launch_request(&rig).await.model, None);
}

#[tokio::test]
async fn a_run_stored_with_no_choice_takes_the_settings_default_when_it_launches_and_keeps_it() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    rig.set(&run, |r| r.runs_on = None).await;
    rig.svc.start_now(&run.id).await.unwrap();
    assert_eq!(rig.get(&run).await.runs_on, Some(pick("claude", "default")));
}

#[tokio::test]
async fn a_run_whose_instance_cannot_run_agents_yet_waits_with_its_reason_and_starts_once_it_has_another_choice() {
    let rig = ready().await;
    add_second_claude(&rig);
    let run = rig.queued(1).await;
    rig.svc.set_model(&run.id, pick("claude_2", "opus")).await.unwrap();

    let waiting = rig.svc.start_now(&run.id).await.unwrap();
    assert_eq!(waiting.state, RunState::Queued);
    assert_eq!(waiting.wait_reason.as_deref(), Some("Agents can't run on Claude yet."));
    assert!(waiting.slot_wait_since.is_some());
    assert_eq!(rig.cli.launches(), 0);

    rig.svc.set_model(&run.id, pick("claude", "haiku")).await.unwrap();
    assert_eq!(rig.get(&run).await.wait_reason, None, "a new choice clears what the old one waited for");
    assert_eq!(rig.svc.launch_waiting().await.unwrap(), vec![run.id.clone()]);
    let started = rig.get(&run).await;
    assert_eq!((started.state, started.wait_reason, started.slot_wait_since), (RunState::Launching, None, None));
}

#[tokio::test]
async fn a_run_whose_instance_was_removed_waits_and_says_to_pick_another() {
    let rig = ready().await;
    add_second_claude(&rig);
    let run = rig.queued(1).await;
    rig.svc.set_model(&run.id, pick("claude_2", "opus")).await.unwrap();
    AppConfig::update(&rig.fx.core.data_dir(), |config| {
        connections::remove_provider(config, "claude_2");
    })
    .unwrap();
    let waiting = rig.svc.start_now(&run.id).await.unwrap();
    assert_eq!((waiting.state, waiting.wait_reason.as_deref()), (RunState::Queued, Some("That instance was removed. Pick another.")));
    assert_eq!(rig.cli.launches(), 0);
}

#[tokio::test]
async fn a_run_waits_when_the_default_for_agents_was_cleared_with_its_instance() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    rig.set(&run, |r| r.runs_on = None).await;
    AppConfig::update(&rig.fx.core.data_dir(), |config| config.models.agents = None).unwrap();
    let waiting = rig.svc.start_now(&run.id).await.unwrap();
    assert_eq!((waiting.state, waiting.wait_reason.as_deref()), (RunState::Queued, Some("That instance was removed. Pick another.")));
}

#[tokio::test]
async fn a_run_waits_for_an_instance_that_is_off_and_one_that_cannot_start_fails_as_before() {
    let off = ToolchainError::Unusable { reason: Reason::Off, name: "Claude".into() };
    let missing = ToolchainError::ClaudeMissing { instance: "Claude".into() };
    for (error, state, reason) in [(off, RunState::Queued, Some("Waits for Claude, which is off.")), (missing, RunState::Failed, None)] {
        let rig = ready().await;
        let run = rig.queued(1).await;
        let tools = Instances { default: Toolchain::new(rig.cli.clone(), rig_env(&rig)), by_id: HashMap::from([("claude".to_owned(), Err(error))]), gets: AtomicUsize::new(0) };
        let svc = RunService::new(rig.fx.core.clone(), Arc::new(tools), RunIndex::load(&rig.fx.dir.join("index2")), Arc::new(|_| {})).with_home(rig.fx.home.canonicalize().unwrap());
        let after = svc.start_now(&run.id).await.unwrap();
        assert_eq!((after.state, after.wait_reason.as_deref()), (state, reason));
    }
}

#[tokio::test]
async fn a_runs_toolchain_comes_from_its_instance_and_never_from_get() {
    let rig = ready().await;
    let by_id = HashMap::from([("claude".to_owned(), Ok(toolchain_named("claude", "Claude"))), ("claude_2".to_owned(), Ok(toolchain_named("claude_2", "Claude personal")))]);
    let tools = Arc::new(Instances { default: toolchain_named("claude", "Claude"), by_id, gets: AtomicUsize::new(0) });
    struct Shared(Arc<Instances>);
    #[async_trait]
    impl ToolchainSource for Shared {
        async fn get(&self) -> std::result::Result<Toolchain, ToolchainError> {
            self.0.get().await
        }
        async fn for_instance(&self, id: &str) -> std::result::Result<Toolchain, ToolchainError> {
            self.0.for_instance(id).await
        }
    }
    let svc = RunService::new(rig.fx.core.clone(), Arc::new(Shared(tools.clone())), RunIndex::load(&rig.fx.dir.join("index2")), Arc::new(|_| {}));
    let run = rig.queued(1).await;

    for instance in ["claude", "claude_2"] {
        let on = rig.set(&run, |r| r.runs_on = Some(pick(instance, "default"))).await;
        let tc = svc.toolchain_of(&on).await.unwrap();
        assert_eq!((tc.instance_id.as_str(), tc.env.get("WHO").and_then(|v| v.to_str())), (instance, Some(instance)));
    }
    assert_eq!(tools.gets.load(Ordering::SeqCst), 0);
    let unset = rig.set(&run, |r| r.runs_on = None).await;
    assert_eq!(svc.toolchain_of(&unset).await.unwrap().instance_id, "claude");
    assert_eq!(tools.gets.load(Ordering::SeqCst), 1, "only a run with no choice asks for the default");
}

#[tokio::test]
async fn a_launch_goes_to_the_claude_of_the_runs_instance_and_not_to_the_one_get_finds() {
    let rig = ready().await;
    let decoy = Arc::new(FakeCli::new());
    let own = Toolchain::new(rig.cli.clone(), rig_env(&rig));
    let tools = Instances { default: Toolchain::new(decoy.clone(), rig_env(&rig)), by_id: HashMap::from([("claude".to_owned(), Ok(own))]), gets: AtomicUsize::new(0) };
    let svc = RunService::new(rig.fx.core.clone(), Arc::new(tools), RunIndex::load(&rig.fx.dir.join("index2")), Arc::new(|_| {})).with_home(rig.fx.home.canonicalize().unwrap());
    let run = rig.queued(1).await;
    assert_eq!(svc.start_now(&run.id).await.unwrap().state, RunState::Launching);
    assert_eq!((rig.cli.launches(), decoy.launches()), (1, 0));
}

#[tokio::test]
async fn changing_the_choice_is_refused_once_the_run_has_started_and_for_a_model_the_instance_lacks() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    assert!(matches!(rig.svc.set_model(&run.id, pick("claude", "gpt-9")).await, Err(Error::Input(_))));
    let started = rig.svc.start_now(&run.id).await.unwrap();
    let refused = rig.svc.set_model(&run.id, pick("claude", "opus")).await;
    assert!(matches!(refused, Err(Error::Proposal(words)) if words == format!("This run is {}, so what it runs on can't change.", started.state.as_str())));
    assert_eq!(rig.get(&run).await.runs_on, Some(pick("claude", "default")));
}

#[tokio::test]
async fn a_change_while_the_launcher_holds_the_lock_waits_and_then_loses_to_the_launch() {
    let rig = ready().await;
    let run = rig.queued(1).await;
    let turn = rig.svc.launching_lock().lock().await;
    let svc = rig.svc.clone();
    let id = run.id.clone();
    let change = tokio::spawn(async move { svc.set_model(&id, pick("claude", "opus")).await });
    tokio::task::yield_now().await;
    assert!(!change.is_finished(), "the change waits for the launch lock");
    drop(turn);
    rig.svc.start_now(&run.id).await.unwrap();
    let outcome = change.await.unwrap();
    let stored = rig.get(&run).await;
    match outcome {
        Ok(_) => assert_eq!(stored.runs_on, Some(pick("claude", "opus"))),
        Err(_) => assert_eq!(stored.runs_on, Some(pick("claude", "default"))),
    }
}
