use std::sync::Arc;

use harness::api::Op;
use harness::event::{Body, Event};

use super::*;
use crate::domain::RunState;
use crate::inbox::testing::fixture_watching;
use crate::runs::link::served::{Direct, Served, WAIT};
use crate::runs::rig::{ready_on, Notices, Rig};

const FINISHES: &str = r#"{"prompt": null}
{"say": "Looking at the cart."}
{"end": "done"}
{"prompt": null}"#;

async fn on_harness(served: &Served) -> Rig {
    on_harness_as(served, "mock", 6).await
}

/// The app on `served`, opening runs on `provider`, with `cap` agents at once.
async fn on_harness_as(served: &Served, provider: &str, cap: usize) -> Rig {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(fx.core.clone()));
    let link = Arc::new(Link::start(fx.core.clone(), direct, reads, Arc::new(Notices::default()), changed));
    ready_on(fx, |svc| svc.with_harness(OnHarness { link, provider: provider.into() }).with_cap(cap)).await
}

async fn sessions(served: &Served) -> Vec<serde_json::Value> {
    served.client().await.call(Op::Sessions).await.unwrap().as_array().unwrap().clone()
}

/// The run once the link applied the event that left it in `state`.
async fn until_state(rig: &Rig, run: &Run, state: RunState) -> Run {
    let mut applied = rig.svc.harness.as_ref().unwrap().link.applied();
    tokio::time::timeout(WAIT, async {
        loop {
            let now = rig.get(run).await;
            if now.state == state {
                return now;
            }
            applied.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the run did not get to {state:?}"))
}

#[tokio::test]
async fn an_approved_run_opens_a_harness_session_sends_its_brief_and_reads_done_when_the_session_says_so() {
    let served = Served::new(FINISHES, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let session = done.harness_session.clone().expect("the run is its session");
    assert!(rig.cli.0.lock().unwrap().calls.is_empty(), "no claude --bg");
    assert_eq!(done.last_detail.as_deref(), Some("Looking at the cart."));
    let rows = rig.fx.core.run_events(&run.id).await.unwrap();
    assert_eq!(rows.first().map(|row| row.text.as_str()), Some(ON_THE_MOCK), "the run sheet says it is the mock first");
    let mut client = served.client().await;
    let events: Vec<Event> = serde_json::from_value(client.call(Op::Events { session, after: 0 }).await.unwrap()["events"].clone()).unwrap();
    let brief = events.iter().find_map(|e| match &e.body {
        Body::Prompted { text } => Some(text.clone()),
        _ => None,
    });
    let brief = brief.expect("the brief was sent");
    assert_eq!(brief, crate::domain::render_prompt_from(&done.spec, crate::domain::Start::HarnessWorktree), "the brief alone: the harness adds the guard");
    assert!(brief.contains(&format!("on branch `{}`", done.spec.name)) && !brief.contains("worktree-"), "it stays on the branch the harness made");
}

#[test]
fn the_mock_works_in_the_clone_and_any_other_provider_in_a_worktree_on_the_runs_branch() {
    let run = Run::queued("r1".into(), "p1".into(), "c1".into(), None, crate::domain::fixtures::run_spec(), chrono::Utc::now());
    let work = Some("~/.claude-work".to_owned());
    let Op::Open { cwd, repo, base, branch, model, effort, login, .. } = open_op(&run, "mock", None, work.clone()) else { unreachable!() };
    assert_eq!((cwd, repo, base, branch, model, effort, login), (Some(run.spec.clone_path.clone()), None, None, None, None, None, None));
    let Op::Open { cwd, repo, base, branch, model, effort, login, .. } = open_op(&run, "claude", Some("opus".into()), work.clone()) else { unreachable!() };
    assert_eq!((cwd, repo, base, branch), (None, Some(run.spec.repo.clone()), Some(run.spec.base.clone()), Some(run.spec.name.clone())));
    assert_eq!((model.as_deref(), effort, login), (Some("opus"), None, work), "its login as typed, and no effort: the provider's own");
    let Op::Open { login, model, .. } = open_op(&run, "claude", None, None) else { unreachable!() };
    assert_eq!((login, model), (None, None), "the usual setup and model when none was chosen");
}

#[test]
fn the_mock_script_agents_md_names_is_one_the_mock_plays() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/mock-agent.jsonl");
    harness::mock::Script::load(&path).unwrap();
}

const ASKS: &str = r#"{"capabilities": {"tool_call_limit_ms": 600000}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour should the button be?"}}}
{"say": "Blue it is."}
{"end": "done"}
{"prompt": null}
{"say": "On it."}
{"sleep": 600000}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn the_persons_answer_reaches_the_agent_a_later_message_wakes_it_and_a_stop_reads_stopped_once_closed() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let asking = until_state(&rig, &run, RunState::NeedsAnswer).await;
    assert_eq!(asking.needs.as_deref(), Some("Which colour should the button be?"));
    rig.svc.answer(&run.id, "Blue").await.unwrap();
    let done = until_state(&rig, &run, RunState::Done).await;
    assert_eq!((done.last_detail.as_deref(), done.needs), (Some("Blue it is."), None));
    let (_, how) = rig.svc.message_agent(&run.id, "Make it darker.", crate::domain::Actor::Pip).await.unwrap();
    assert_eq!(how, crate::runs::message::Delivery::Queued, "a message, with no question open");
    until_state(&rig, &run, RunState::Working).await;
    let asked = rig.svc.stop(&run.id).await.unwrap();
    assert_ne!(asked.state, RunState::Stopped, "not before the harness closed it");
    until_state(&rig, &run, RunState::Stopped).await;
    let refused = rig.svc.answer(&run.id, "More?").await.unwrap_err().to_string();
    assert!(refused.contains("stopped"), "a session the app stopped takes no message: {refused}");
}

const ASKS_THEN_WORKS: &str = r#"{"capabilities": {"tool_call_limit_ms": 300}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour should the button be?"}}}
{"say": "Carrying on while you think."}
{"sleep": 600000}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn while_your_answer_waits_for_the_turn_a_message_or_a_second_answer_is_refused_in_the_apps_words() {
    let served = Served::new(ASKS_THEN_WORKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_detail(&rig, &run, "Carrying on while you think.").await;
    let answered = rig.svc.answer(&run.id, "Blue").await.unwrap();
    assert_eq!((answered.state, answered.answer_waits, answered.last_detail.as_deref()), (RunState::Working, true, Some(crate::runs::consumer::ANSWER_WAITS)));
    let pip = rig.svc.message_agent(&run.id, "Use the brand blue.", crate::domain::Actor::Pip).await.unwrap_err().to_string();
    let again = rig.svc.answer(&run.id, "Navy").await.unwrap_err().to_string();
    for refused in [pip, again] {
        assert_eq!(refused, crate::runs::link::ANSWER_ON_ITS_WAY, "no harness id in it");
    }
}

#[tokio::test]
async fn a_failed_run_that_opened_a_session_is_not_retried_into_a_second_one() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::NeedsAnswer).await;
    rig.set(&run, |r| r.state = RunState::Failed).await;
    assert!(rig.svc.retry_launch(&run.id).await.is_err());
    assert_eq!(sessions(&served).await.len(), 1, "no second session");
}

#[tokio::test]
async fn a_session_the_app_could_not_bind_to_its_run_is_closed_and_not_left_running() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::NeedsAnswer).await;
    let link = &rig.svc.harness.as_ref().unwrap().link;
    assert!(link.open(&run.id, open_op(&run, MOCK, None, None)).await.is_err(), "a run follows one session");
    let mut client = served.client().await;
    let second = sessions(&served).await.into_iter().find(|s| s["id"] != run.harness_session.as_deref().unwrap_or_default()).unwrap();
    let closed = client.call(Op::Events { session: second["id"].as_str().unwrap().into(), after: 0 }).await.unwrap();
    assert!(closed["events"].as_array().unwrap().iter().any(|e| e["type"] == "closed"), "the unbound session was closed: {second}");
}

#[tokio::test]
async fn at_start_a_run_whose_session_never_got_its_brief_fails_and_its_session_closes() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.fx.core.queue_test_run(rig.spec(1), None).await.unwrap();
    let run = rig.set(&run, |r| r.state = RunState::Launching).await;
    let link = &rig.svc.harness.as_ref().unwrap().link;
    let session = link.open(&run.id, open_op(&run, MOCK, None, None)).await.unwrap();
    rig.svc.sweep_harness().await;
    let failed = rig.get(&run).await;
    assert_eq!((failed.state, failed.error.as_deref().is_some_and(|e| e.contains("before it sent the agent its brief"))), (RunState::Failed, true));
    let row = sessions(&served).await.into_iter().find(|s| s["id"] == session.as_str()).unwrap();
    assert_eq!(row["running"], false, "closed: {row}");
}

#[tokio::test]
async fn a_provider_the_harness_does_not_serve_fails_the_run_naming_the_harness_and_the_cause() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    let failed = rig.get(&run).await;
    let error = failed.error.unwrap_or_default();
    assert!(error.starts_with("The harness couldn't start the agent") && error.contains("no claude driver"), "{error}");
}

#[tokio::test]
async fn the_persons_agents_at_once_holds_for_runs_on_the_harness_too() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness_as(&served, MOCK, 1).await;
    let first = rig.launched(1).await;
    until_state(&rig, &first, RunState::NeedsAnswer).await;
    let second = rig.get(&rig.launched(2).await).await;
    assert_eq!((second.state, second.harness_session.is_none(), second.slot_wait_since.is_some()), (RunState::Queued, true, true), "it waits in the app's queue");
    assert_eq!(sessions(&served).await.len(), 1);
}

const READS_THEN_REPORTS: &str = r#"{"capabilities": {"tool_call_limit_ms": 600000}}
{"prompt": null}
{"call": {"name": "read_workstream", "input": {}}}
{"call": {"name": "result", "input": {"status": "done", "note": "The cart total is fixed."}}}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_run_reads_through_gossamrs_tools_and_its_result_is_kept_as_its_report() {
    let served = Served::new(READS_THEN_REPORTS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    assert_eq!(done.result.as_deref(), Some("The cart total is fixed."), "open took the result schema, and the result fit it");
    let kept = rig.fx.core.report_stored(&run.id).await.unwrap().and_then(|row| row.report);
    assert_eq!(kept, Some(crate::runs::report::Report { status: crate::runs::report::ReportStatus::Done, note: Some("The cart total is fixed.".into()) }));
    let mut client = served.client().await;
    let events: Vec<Event> = serde_json::from_value(client.call(Op::Events { session: done.harness_session.unwrap(), after: 0 }).await.unwrap()["events"].clone()).unwrap();
    let read = events.iter().find_map(|e| match &e.body {
        Body::ToolResult { output, error: false, .. } if output.as_str().is_some_and(|text| text.contains("not instructions")) => Some(()),
        _ => None,
    });
    assert!(read.is_some(), "read_workstream answered with the run's data: {events:?}");
}

#[test]
fn the_result_schema_is_one_the_harness_checks() {
    harness::schema::check(&crate::runs::report::result_schema()).unwrap();
    assert!(harness::schema::misfits(&crate::runs::report::result_schema(), &serde_json::json!({ "status": "done", "note": "" })).len() == 1, "an empty note does not fit");
}

const WORKS_LONG: &str = r#"{"prompt": null}
{"say": "Working."}
{"sleep": 600000}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn at_the_harnesss_limit_a_run_waits_for_a_slot_and_starts_in_order_once_one_frees() {
    let served = Served::new(WORKS_LONG, 1);
    let rig = on_harness(&served).await;
    let first = rig.launched(1).await;
    until_state(&rig, &first, RunState::Working).await;
    let (second, third) = (rig.launched(2).await, rig.launched(3).await);
    for run in [&second, &third] {
        let waiting = until_detail(&rig, run, crate::runs::consumer::SLOT_WAIT).await;
        assert_eq!(waiting.state, RunState::Launching, "it waits at the harness, not failed and not working");
    }
    rig.svc.stop(&first.id).await.unwrap();
    until_state(&rig, &first, RunState::Stopped).await;
    let started = until_state(&rig, &second, RunState::Working).await;
    assert_ne!(started.last_detail.as_deref(), Some(crate::runs::consumer::SLOT_WAIT));
    assert_eq!(rig.get(&third).await.last_detail.as_deref(), Some(crate::runs::consumer::SLOT_WAIT), "the later one still waits");
    rig.svc.stop(&second.id).await.unwrap();
    until_state(&rig, &third, RunState::Working).await;
}

/// The run once the link applied the event that gave it `detail`.
async fn until_detail(rig: &Rig, run: &Run, detail: &str) -> Run {
    let mut applied = rig.svc.harness.as_ref().unwrap().link.applied();
    tokio::time::timeout(WAIT, async {
        loop {
            let now = rig.get(run).await;
            if now.last_detail.as_deref() == Some(detail) {
                return now;
            }
            applied.changed().await.unwrap();
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the run never said {detail:?}"))
}

const REPORTS_WHAT_DOES_NOT_FIT: &str = r#"{"capabilities": {"tool_call_limit_ms": 600000}}
{"prompt": null}
{"call": {"name": "result", "input": {"status": "maybe", "note": "Not sure."}}}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn open_carries_the_result_schema_so_a_result_that_does_not_fit_it_is_refused() {
    let served = Served::new(REPORTS_WHAT_DOES_NOT_FIT, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    assert_eq!(done.result, None, "the harness checked it against the schema and took none");
    assert!(rig.fx.core.report_stored(&run.id).await.unwrap().and_then(|row| row.report).is_none());
}

#[tokio::test]
async fn pips_message_to_a_run_on_the_harness_that_was_handed_over_is_refused() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Working).await;
    rig.set(&run, |r| r.handed_over = true).await;
    let refused = rig.svc.message_agent(&run.id, "Carry on.", crate::domain::Actor::Pip).await.unwrap_err().to_string();
    assert_eq!(refused, crate::runs::message::HANDED_OVER_ASK);
    let mut client = served.client().await;
    let events = client.call(Op::Events { session: rig.get(&run).await.harness_session.unwrap(), after: 0 }).await.unwrap();
    assert!(!events["events"].as_array().unwrap().iter().any(|e| e["type"] == "prompted" && e["text"] == "Carry on."), "nothing reached the agent");
}

#[test]
fn what_a_run_says_of_a_harness_without_the_mock_names_no_debug_switch() {
    let said = no_session("no provider mock", MOCK);
    assert!(said.contains("serves no mock script"), "{said}");
    for name in ["GOSSAMR_MOCK_SCRIPT", "GOSSAMR_APP_DATA", "GOSSAMR_TEST_VAULT", "HARNESS_DATA"] {
        assert!(!said.contains(name), "{name} would be in the release build: {said}");
    }
}

#[tokio::test]
async fn at_start_a_run_whose_brief_waits_for_a_slot_is_left_to_run() {
    let served = Served::new(WORKS_LONG, 1);
    let rig = on_harness(&served).await;
    let first = rig.launched(1).await;
    until_state(&rig, &first, RunState::Working).await;
    let second = rig.launched(2).await;
    until_detail(&rig, &second, crate::runs::consumer::SLOT_WAIT).await;
    rig.svc.sweep_harness().await;
    let after = rig.get(&second).await;
    assert_eq!((after.state, after.error), (RunState::Launching, None), "its brief is the harness's, waiting for the slot");
    rig.svc.stop(&first.id).await.unwrap();
    until_state(&rig, &second, RunState::Working).await;
}

#[tokio::test]
async fn at_start_the_session_of_a_failed_run_that_never_got_its_brief_closes_and_the_run_keeps_its_reason() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.fx.core.queue_test_run(rig.spec(1), None).await.unwrap();
    let run = rig.set(&run, |r| r.state = RunState::Launching).await;
    let session = rig.svc.harness.as_ref().unwrap().link.open(&run.id, open_op(&run, MOCK, None, None)).await.unwrap();
    let failed = rig.set(&run, |r| {
        r.state = RunState::Failed;
        r.error = Some("its own reason".into());
    }).await;
    rig.svc.sweep_harness().await;
    let row = sessions(&served).await.into_iter().find(|s| s["id"] == session.as_str()).unwrap();
    assert_eq!(row["running"], false, "closed: {row}");
    assert_eq!(rig.get(&failed).await.error.as_deref(), Some("its own reason"));
}

#[tokio::test]
async fn a_failed_bind_says_so_in_the_apps_words_and_shows_no_database_text() {
    let served = Served::new(ASKS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::NeedsAnswer).await;
    let refused = rig.svc.harness.as_ref().unwrap().link.open(&run.id, open_op(&run, MOCK, None, None)).await.unwrap_err();
    assert_eq!(refused, "it opened a session but Gossamr couldn't keep it with its run");
}

/// A home folder whose git sends `https://github.com/` to a bare `acme/webshop` on disk with one commit on `main`, and
/// the harness's setup for it.
fn on_a_bare_repo() -> (tempfile::TempDir, harness::work::Setup) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (home, data, remote, config) = (root.join("home"), root.join("data"), root.join("remote/github.com"), root.join("gitconfig"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(&config, format!("[url \"file://{}/\"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n", remote.display())).unwrap();
    let env = vec![
        ("PATH".to_owned(), "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".to_owned()),
        ("HOME".to_owned(), home.display().to_string()),
        ("GIT_CONFIG_GLOBAL".to_owned(), config.display().to_string()),
        ("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned()),
        ("GIT_ALLOW_PROTOCOL".to_owned(), "file".to_owned()),
    ];
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git").current_dir(dir).args(args).env_clear().envs(env.clone()).output().unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    let bare = remote.join("acme/webshop.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
    git(&root, &["clone", "--quiet", &format!("file://{}", bare.display()), "seed"]);
    std::fs::write(root.join("seed/README"), "hello\n").unwrap();
    git(&root.join("seed"), &["add", "README"]);
    git(&root.join("seed"), &["commit", "--quiet", "-m", "first"]);
    git(&root.join("seed"), &["push", "--quiet", "origin", "main"]);
    let setup = harness::work::Setup::new(Some(home), data).with_shell_env(crate::runs::env::RunEnv::from_pairs(env));
    (tmp, setup)
}

#[tokio::test]
async fn at_start_a_session_an_interrupted_open_left_on_its_runs_branch_closes_and_no_other_does() {
    let (_repo, setup) = on_a_bare_repo();
    let mut served = Served::idle();
    served.serve_on(WORKS_LONG, 4, setup);
    let rig = on_harness(&served).await;
    let mut client = served.client().await;
    let open = |branch: &str| Op::Open { provider: MOCK.into(), cwd: None, repo: Some("acme/webshop".into()), base: Some("main".into()), branch: Some(branch.into()), locked: false, model: None, login: None, effort: None, ends_with_client: false, tools: vec![], result_schema: None };
    let interrupted = rig.fx.core.queue_test_run(rig.spec(1), None).await.unwrap();
    let interrupted = rig.set(&interrupted, |r| {
        r.state = RunState::Launching;
        r.launched_at = Some(chrono::Utc::now() - chrono::Duration::seconds(1));
    }).await;
    let old = rig.fx.core.queue_test_run(rig.spec(2), None).await.unwrap();
    let old = rig.set(&old, |r| {
        r.state = RunState::Launching;
        r.launched_at = Some(chrono::Utc::now() - chrono::Duration::hours(2));
    }).await;
    let done = rig.fx.core.queue_test_run(rig.spec(3), None).await.unwrap();
    let done = rig.set(&done, |r| {
        r.state = RunState::Done;
        r.launched_at = Some(chrono::Utc::now() - chrono::Duration::seconds(1));
    }).await;
    let mut ids = vec![];
    for run in [&interrupted, &old, &done] {
        let opened = client.call(open(&run.spec.name)).await.unwrap();
        ids.push(opened["session"].as_str().unwrap().to_owned());
    }
    rig.svc.sweep_harness().await;
    let running = |id: &str, listed: &[serde_json::Value]| listed.iter().find(|s| s["id"] == id).unwrap()["running"] == true;
    let listed = sessions(&served).await;
    assert!(!running(&ids[0], &listed), "the interrupted open's session closed");
    assert!(running(&ids[1], &listed), "not one on an old run's branch");
    assert!(running(&ids[2], &listed), "nor one opened by hand on a finished run's branch");
}

#[test]
fn claude_runs_open_on_the_harnesss_claude_driver_unless_a_debug_build_serves_the_mock() {
    assert_eq!((provider(false), provider(true)), ("claude", MOCK));
}

#[tokio::test]
async fn a_run_on_the_harness_records_the_branch_and_worktree_the_harness_made_so_its_pull_request_is_found() {
    let (_repo, setup) = on_a_bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let row = sessions(&served).await.into_iter().find(|s| s["id"] == done.harness_session.as_deref().unwrap()).unwrap();
    assert_eq!(done.branch.as_deref(), Some(run.spec.name.as_str()), "the branch the harness made, with no prefix");
    assert_eq!(Some(done.expected_worktree.to_string_lossy().as_ref()), row["cwd"].as_str(), "the worktree the harness reports");
    assert!(done.expected_worktree.is_dir() && done.expected_worktree.ends_with(format!("acme/webshop+worktrees/{}", run.spec.name)));
    let pushed = crate::codehost::links::tests::pr(12, &run.spec.name, "Fix the cart total", "");
    assert_eq!(crate::runs::pr::change_for(&done, &[pushed]).and_then(|c| c.number), Some(12), "the run finds the pull request pushed from its branch");
    let refused = rig.svc.cleanup(&run.id).await.unwrap_err().to_string();
    assert!(refused.contains("comes in a coming update"), "not that there is no worktree: {refused}");
}

#[tokio::test]
async fn a_harness_run_needs_its_login_signed_in_and_not_a_claude_that_has_bg() {
    let served = Served::new(FINISHES, 4);
    let rig = on_harness(&served).await;
    rig.cli.with(|s| s.bg = false);
    let run = rig.launched(1).await;
    let opened = rig.get(&run).await;
    assert!(opened.harness_session.is_some(), "opened: {:?}", opened.error);
    rig.cli.with(|s| s.logged_in = false);
    let refused = rig.get(&rig.launched(2).await).await;
    assert_eq!((refused.state, refused.harness_session.is_none()), (RunState::Failed, true), "{:?}", refused.error);
}

#[tokio::test]
async fn a_run_whose_agent_the_harness_lost_says_to_ask_pip_and_a_new_run_on_its_ticket_starts() {
    let served = Served::new(FINISHES, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Done).await;
    let session = rig.get(&run).await.harness_session.unwrap();
    served.client().await.call(Op::Close { session: session.clone() }).await.unwrap();
    // As if the harness had died mid-turn with no shutdown: the app still reads a turn the harness no longer runs.
    let mut applied = rig.svc.harness.as_ref().unwrap().link.applied();
    tokio::time::timeout(WAIT, async {
        while !rig.fx.core.session_run(&session).await.unwrap().unwrap().1.closed {
            applied.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    rig.fx.core.apply_session(&session, |run, follow| {
        (follow.closed, follow.ended, follow.in_turn) = (false, false, true);
        run.state = RunState::Working;
        run.ended_at = None;
        Vec::new()
    }).await.unwrap();
    let refused = rig.svc.message_agent(&run.id, "Go on.", crate::domain::Actor::Person).await.unwrap_err();
    assert!(refused.to_string().contains(crate::runs::consumer::AGENT_LOST), "{refused}");
    let lost = rig.get(&run).await;
    assert_eq!((lost.state, lost.last_detail.as_deref()), (RunState::Stopped, Some(crate::runs::consumer::AGENT_LOST)));
    assert!(!crate::runs::consumer::AGENT_LOST.contains("Message the agent"), "a message is refused, so the text does not offer it");
    // What the text says: Pip starts it again, as a new run on the same ticket.
    let again = rig.fx.core.queue_test_run(crate::domain::RunSpec { name: "eng-1-fix-cart-again".into(), ..rig.spec(1) }, Some(rig.fx.item("CA-1"))).await.unwrap();
    let started = rig.svc.start_now(&again.id).await.unwrap();
    assert!(started.harness_session.is_some(), "the new run opened on the harness");
    until_state(&rig, &started, RunState::Done).await;
}

#[tokio::test]
async fn a_message_to_a_finished_run_whose_agent_the_harness_lost_is_refused_in_plain_words_and_the_run_stays_done() {
    let served = Served::new(FINISHES, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Done).await;
    let session = rig.get(&run).await.harness_session.unwrap();
    served.client().await.call(Op::Close { session: session.clone() }).await.unwrap();
    let mut applied = rig.svc.harness.as_ref().unwrap().link.applied();
    tokio::time::timeout(WAIT, async {
        while !rig.fx.core.session_run(&session).await.unwrap().unwrap().1.closed {
            applied.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    // As if the harness had been killed after the turn ended: the app never read the close.
    rig.fx.core.apply_session(&session, |_, follow| {
        follow.closed = false;
        Vec::new()
    }).await.unwrap();
    let refused = rig.svc.message_agent(&run.id, "One more thing.", crate::domain::Actor::Person).await.unwrap_err().to_string();
    assert_eq!(refused, crate::runs::link::NOT_RUNNING);
    let after = rig.get(&run).await;
    assert_eq!((after.state, after.last_detail.as_deref() == Some(crate::runs::consumer::AGENT_LOST)), (RunState::Done, false));
}

#[tokio::test]
async fn a_harness_run_is_not_held_back_by_claudes_trust_question_which_its_print_mode_never_asks() {
    let served = Served::new(FINISHES, 4);
    let fx = fixture_watching(&["acme/webshop"]).await;
    let home = fx.home.canonicalize().unwrap();
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(fx.core.clone()));
    let link = Arc::new(Link::start(fx.core.clone(), direct, reads, Arc::new(Notices::default()), changed));
    let rig = crate::runs::rig::ready_in(fx, &[("HOME", home.to_string_lossy().into_owned())], |svc| svc.with_harness(OnHarness { link, provider: "mock".into() })).await;
    // The temp home's Claude settings say the clone was never trusted, which the old path refuses.
    let projects = serde_json::json!({ "projects": { rig.clone.to_string_lossy(): { "hasTrustDialogAccepted": false } } });
    std::fs::write(home.join(".claude.json"), projects.to_string()).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    rig.cli.with(|s| s.config_dir = home.join(".claude"));
    assert_eq!(crate::runs::trust::trusted(&home.join(".claude.json"), &rig.clone), Some(false), "the settings read as untrusted");
    let run = rig.launched(1).await;
    let opened = rig.get(&run).await;
    assert!(opened.harness_session.is_some() && opened.failure.is_none(), "{:?}", opened.error);
}

#[tokio::test]
async fn a_run_whose_open_kept_no_branch_has_the_harnesss_at_the_next_connect() {
    let (_repo, setup) = on_a_bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let (branch, worktree) = (done.branch.clone().unwrap(), done.expected_worktree.clone());
    // As if the listing after the brief had failed, or the app had quit before it.
    let session = done.harness_session.clone().unwrap();
    rig.fx.core.apply_session(&session, |run, _| {
        run.branch = None;
        run.expected_worktree = std::path::PathBuf::from("/elsewhere");
        Vec::new()
    }).await.unwrap();
    // The app again: a new link, whose connect reads the listing.
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(rig.fx.core.clone()));
    let again = Link::start(rig.fx.core.clone(), direct, reads, Arc::new(Notices::default()), changed);
    let mut applied = again.applied();
    let filled = tokio::time::timeout(WAIT, async {
        loop {
            let now = rig.get(&run).await;
            if now.branch.is_some() {
                return now;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(50), applied.changed()).await;
        }
    })
    .await
    .expect("the connect filled the branch in");
    assert_eq!((filled.branch.as_deref(), &filled.expected_worktree), (Some(branch.as_str()), &worktree));
}

#[tokio::test]
async fn delete_says_a_harness_runs_worktree_is_cleaned_up_later_and_keeps_its_session_on_record() {
    let served = Served::new(FINISHES, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Done).await;
    rig.svc.archive(std::slice::from_ref(&run.id)).await.unwrap();
    let info = rig.svc.worktree_info(&run.id).await.unwrap();
    assert_eq!((info.removable, info.reason.as_deref()), (false, Some(crate::runs::cleanup::ON_HARNESS_LATER)));
    let refused = rig.svc.delete(&run.id, true).await.unwrap_err().to_string();
    assert_eq!(refused, crate::runs::cleanup::ON_HARNESS_LATER);
    rig.svc.delete(&run.id, false).await.unwrap();
    let rows: i64 = rusqlite::Connection::open(rig.fx.dir.join("app.sqlite")).unwrap().query_row("SELECT count(*) FROM run_sessions WHERE run_id = ?1", [&run.id], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1, "the only record of its worktree stays");
}
