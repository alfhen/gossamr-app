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
    let (tmp, setup, _) = bare_repo();
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
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), crate::runs::cleanup::Cleanup::Removed, "Clean up finds the worktree the harness made");
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

/// `on_a_bare_repo`, with the home folder the harness clones into and a git to run in it.
fn bare_repo() -> (tempfile::TempDir, harness::work::Setup, Git) {
    bare_repo_at(None)
}

/// `bare_repo`, with the harness's home `home` when given.
fn bare_repo_at(home: Option<std::path::PathBuf>) -> (tempfile::TempDir, harness::work::Setup, Git) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (data, remote, config) = (root.join("data"), root.join("remote/github.com"), root.join("gitconfig"));
    let home = home.unwrap_or_else(|| root.join("home"));
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
    let setup = harness::work::Setup::new(Some(home.clone()), data).with_shell_env(crate::runs::env::RunEnv::from_pairs(env.clone()));
    (tmp, setup, Git { home, env })
}

struct Git {
    home: std::path::PathBuf,
    env: Vec<(String, String)>,
}

/// The app on `served`, opening runs on its `claude` driver, with the same home and git as the harness of `git`'s
/// temp repo, so what the app asks git is what the harness would find.
async fn on_harness_sharing(fx: crate::inbox::testing::Fixture, served: &Served, git: &Git) -> Rig {
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(fx.core.clone()));
    let link = Arc::new(Link::start(fx.core.clone(), direct, reads, Arc::new(Notices::default()), changed));
    let env: Vec<(&str, String)> = git.env.iter().map(|(key, value)| (key.as_str(), value.clone())).collect();
    let home = git.home.clone();
    crate::runs::rig::ready_in(fx, &env, move |svc| svc.with_harness(OnHarness { link, provider: "claude".into() }).with_cap(6).with_home(home)).await
}

impl Git {
    fn worktree(&self, branch: &str) -> std::path::PathBuf {
        self.home.join("Gossamr/agents/acme/webshop+worktrees").join(branch)
    }

    fn run(&self, dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git").current_dir(dir).args(args).env_clear().envs(self.env.clone()).output().unwrap();
        assert!(out.status.success(), "git {args:?}");
    }
}

#[tokio::test]
async fn clean_up_closes_a_finished_runs_session_and_removes_its_worktree_through_the_harness() {
    let (_repo, setup, git) = bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    assert!(crate::runs::cleanup::cleanable(&done), "a finished harness run has its worktree to remove");
    let worktree = git.worktree(&done.spec.name);
    assert!(worktree.is_dir());
    assert_eq!(rig.svc.cleanup(&run.id).await.unwrap(), crate::runs::cleanup::Cleanup::Removed);
    assert!(!worktree.exists(), "the harness removed it");
    let cleaned = rig.get(&run).await;
    assert!(cleaned.worktree_removed_at.is_some() && !crate::runs::cleanup::cleanable(&cleaned));
}

#[tokio::test]
async fn clean_up_of_a_run_with_unpushed_work_is_refused_with_the_harnesss_reason_and_keeps_the_work() {
    let (_repo, setup, git) = bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let worktree = git.worktree(&done.spec.name);
    std::fs::write(worktree.join("FIX"), "fixed\n").unwrap();
    git.run(&worktree, &["add", "FIX"]);
    git.run(&worktree, &["commit", "--quiet", "-m", "the fix"]);
    let crate::runs::cleanup::Cleanup::Refused { message } = rig.svc.cleanup(&run.id).await.unwrap() else { panic!("refused") };
    assert!(!message.is_empty(), "the harness says why");
    assert!(worktree.join("FIX").is_file(), "the work stays");
    assert!(rig.get(&run).await.worktree_removed_at.is_none());
}

#[tokio::test]
async fn the_move_to_the_harness_stops_each_agent_the_old_path_has_going_once_and_marks_it_interrupted() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let old = |n: u32, state: RunState| {
        let rig = &rig;
        async move {
            let run = rig.fx.core.queue_test_run(rig.spec(n), None).await.unwrap();
            rig.set(&run, |r| {
                r.state = state;
                r.short_id = Some(crate::runs::cli::ShortId::parse(&format!("{n:08x}")).unwrap());
            })
            .await
        }
    };
    let going = old(1, RunState::Working).await;
    let finished = old(2, RunState::Done).await;
    let on_harness = rig.launched(3).await;
    until_state(&rig, &on_harness, RunState::Working).await;
    rig.svc.move_to_harness().await;
    assert_eq!(rig.cli.0.lock().unwrap().stops, vec![going.short_id.clone().unwrap().as_str().to_owned()], "only the agent the old path had going");
    let stopped = rig.get(&going).await;
    assert_eq!((stopped.state, stopped.failure.clone(), stopped.error.as_deref()), (RunState::Failed, Some(crate::domain::RunFailure::Interrupted), Some(INTERRUPTED)));
    assert_eq!(rig.get(&finished).await.state, RunState::Done);
    assert_eq!(rig.get(&on_harness).await.state, RunState::Working);
    assert!(rig.fx.core.harness_moved().await.unwrap());
    rig.set(&going, |r| r.state = RunState::Working).await;
    rig.svc.move_to_harness().await;
    assert_eq!(rig.cli.0.lock().unwrap().stops.len(), 1, "once");
}

const TWO_TURNS: &str = r#"{"prompt": null}
{"say": "First."}
{"end": "done"}
{"prompt": null}
{"say": "Back again."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_run_handed_over_to_terminal_takes_your_message_only_once_you_say_you_took_it_back() {
    let served = Served::new(TWO_TURNS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let link = &rig.svc.harness.as_ref().unwrap().link;
    link.call(Op::HandOver { session: done.harness_session.clone().unwrap() }).await.unwrap();
    let handed = until_detail(&rig, &run, crate::runs::consumer::HANDED_OVER).await;
    assert!(handed.handed_over, "the run says so");
    let refused = rig.svc.answer_took_back(&run.id, "Carry on.", false).await.unwrap_err().to_string();
    assert_eq!(refused, crate::runs::message::HANDED_OVER_ASK);
    rig.svc.answer_took_back(&run.id, "Carry on.", true).await.unwrap();
    let back = until_detail(&rig, &run, "Back again.").await;
    assert!(!back.handed_over, "taken back");
    until_state(&rig, &run, RunState::Done).await;
}

#[tokio::test]
async fn attach_refuses_a_run_in_a_turn_since_a_hand_over_would_cut_it_and_drop_its_messages() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Working).await;
    let refused = rig.svc.attach(&run.id).await.unwrap_err().to_string();
    assert_eq!(refused, HAND_OVER_IN_TURN);
    assert!(rig.opened.0.lock().unwrap().is_empty(), "Terminal did not open");
    let still = rig.get(&run).await;
    assert_eq!((still.state, still.handed_over), (RunState::Working, false));
}

#[tokio::test]
async fn attach_hands_a_finished_run_to_terminal_in_the_worktree_the_harness_made_and_a_take_back_from_there_works() {
    let (_repo, setup, git) = bare_repo();
    let mut served = Served::idle();
    served.serve_as(TWO_TURNS, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    rig.svc.attach(&run.id).await.unwrap();
    let handed = until_detail(&rig, &run, crate::runs::consumer::HANDED_OVER).await;
    assert!(handed.handed_over && !crate::runs::cleanup::cleanable(&handed), "Clean up leaves what Terminal works in");
    let opened = rig.opened.0.lock().unwrap().clone();
    assert_eq!(opened.len(), 1, "Terminal opened once");
    let script = std::fs::read_to_string(&opened[0]).unwrap();
    let (_, follow) = rig.fx.core.session_run(&done.harness_session.clone().unwrap()).await.unwrap().unwrap();
    assert!(script.contains(&format!("--resume {}", follow.provider_session.unwrap())), "{script}");
    assert!(script.contains(&format!("cd '{}'", done.expected_worktree.display())), "in the harness's worktree: {script}");
    assert!(git.worktree(&done.spec.name).is_dir());
    rig.svc.answer_took_back(&run.id, "Carry on.", true).await.unwrap();
    let back = until_detail(&rig, &run, "Back again.").await;
    assert!(!back.handed_over, "taken back after Attach's own hand-over");
}

#[tokio::test]
async fn attach_on_a_run_whose_session_is_closed_marks_it_handed_over_and_clean_up_then_leaves_it() {
    let (_repo, setup, git) = bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Done).await;
    let stopped = rig.get(&run).await;
    let session = stopped.harness_session.clone().unwrap();
    // Closed by another client, as a run stopped elsewhere is.
    served.client().await.call(Op::Close { session: session.clone() }).await.unwrap();
    let mut applied = rig.svc.harness.as_ref().unwrap().link.applied();
    tokio::time::timeout(WAIT, async {
        while !rig.fx.core.session_run(&session).await.unwrap().unwrap().1.closed {
            applied.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    rig.svc.attach(&run.id).await.unwrap();
    let handed = rig.get(&run).await;
    assert!(handed.handed_over, "marked, though its session was already closed");
    assert!(sessions(&served).await.iter().any(|row| row["id"] == session.as_str()), "listed");
    let refused = rig.svc.cleanup(&run.id).await.unwrap_err().to_string();
    assert_eq!(refused, crate::runs::cleanup::HANDED_OVER_CLEANUP);
    assert!(git.worktree(&stopped.spec.name).is_dir(), "the worktree Terminal resumes in stays");
}

#[tokio::test]
async fn the_move_is_safe_to_run_again_after_a_crash_between_the_stop_and_its_marker() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let run = rig.fx.core.queue_test_run(rig.spec(1), None).await.unwrap();
    let going = rig
        .set(&run, |r| {
            r.state = RunState::Working;
            r.short_id = Some(crate::runs::cli::ShortId::parse("00000001").unwrap());
        })
        .await;
    rig.svc.move_to_harness().await;
    // As if the app had quit after the stop and before it stored the run and the marker.
    rig.set(&going, |r| {
        r.state = RunState::Working;
        r.failure = None;
    }).await;
    rusqlite::Connection::open(rig.fx.dir.join("app.sqlite")).unwrap().execute("DELETE FROM harness_move", []).unwrap();
    rig.svc.move_to_harness().await;
    let after = rig.get(&going).await;
    assert_eq!((after.state, after.failure), (RunState::Failed, Some(crate::domain::RunFailure::Interrupted)));
    assert!(rig.fx.core.harness_moved().await.unwrap(), "done the second time");
    assert_eq!(rig.cli.0.lock().unwrap().stops.len(), 2, "a second stop of a stopped agent harms nothing");
}

#[tokio::test]
async fn the_move_ends_the_question_an_old_run_waited_on_and_says_so() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let run = rig.fx.core.queue_test_run(rig.spec(1), None).await.unwrap();
    let waiting = rig
        .set(&run, |r| {
            r.state = RunState::NeedsAnswer;
            r.short_id = Some(crate::runs::cli::ShortId::parse("00000001").unwrap());
            r.needs = Some("Which database?".into());
            r.asking = true;
        })
        .await;
    let _held = rig.fx.core.asks().open(&waiting.id, "Which database?").unwrap();
    rig.svc.move_to_harness().await;
    let after = rig.get(&waiting).await;
    assert_eq!((after.state, after.needs, after.asking), (RunState::Failed, None, false));
    assert!(rig.fx.core.asks().question(&waiting.id).is_none(), "the held ask is cancelled");
    let rows = rig.fx.core.run_events(&waiting.id).await.unwrap();
    assert_eq!(rows.last().map(|row| row.text.as_str()), Some(INTERRUPTED_ASKING));
    assert_eq!(after.error.as_deref(), Some(INTERRUPTED_BEFORE_ANSWER), "the run sheet says the answer is gone, and what to do");
}

const SIGNING_REFUSED: &str = r#"{"prompt": null}
{"tool": {"id": "t1", "name": "Bash", "input": {"command": "git commit -m 'Fix the cart'"}}}
{"tool_result": {"id": "t1", "output": "error: 1Password: Could not connect to socket. Is the agent running?\n\nfatal: failed to write commit object", "error": true}}
{"end": "done"}
{"prompt": null}
{"say": "Committed."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_run_whose_commit_the_signing_agent_refused_takes_the_message_its_text_asks_for_and_works_again() {
    let served = Served::new(SIGNING_REFUSED, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let failed = until_state(&rig, &run, RunState::Failed).await;
    assert_eq!(failed.error.as_deref(), Some(crate::runs::consumer::SIGNING_NEEDS_YOU));
    assert!(crate::runs::consumer::SIGNING_NEEDS_YOU.contains("message the agent to commit again"));
    // What the text says, once the signing agent is unlocked.
    let (_, delivery) = rig.svc.message_agent(&run.id, "Commit again.", crate::domain::Actor::Person).await.unwrap();
    assert_eq!(delivery, crate::runs::message::Delivery::Queued);
    let done = until_state(&rig, &run, RunState::Done).await;
    assert_eq!((done.error, done.failure, done.last_detail.as_deref()), (None, None, Some("Committed.")));
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
async fn a_run_whose_open_kept_no_branch_has_the_harnesss_at_the_next_connect_whether_its_session_is_idle_closed_or_lost() {
    let (_repo, setup) = on_a_bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let mut runs = Vec::new();
    for n in 1..=3 {
        let run = rig.launched(n).await;
        runs.push(until_state(&rig, &run, RunState::Done).await);
    }
    let kept: Vec<(String, std::path::PathBuf)> = runs.iter().map(|run| (run.branch.clone().unwrap(), run.expected_worktree.clone())).collect();
    let session = |n: usize| runs[n].harness_session.clone().unwrap();
    // The second closed, so it is followed no more; the third closed too, though the app reads it mid-turn, as when
    // the harness that ran it was killed.
    for n in [1, 2] {
        served.client().await.call(Op::Close { session: session(n) }).await.unwrap();
        let mut applied = rig.svc.harness.as_ref().unwrap().link.applied();
        tokio::time::timeout(WAIT, async {
            while !rig.fx.core.session_run(&session(n)).await.unwrap().unwrap().1.closed {
                applied.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }
    for n in 0..3 {
        // As if the listing after the brief had failed, or the app had quit before it.
        rig.fx.core.apply_session(&session(n), move |run, follow| {
            run.branch = None;
            run.expected_worktree = std::path::PathBuf::from("/elsewhere");
            if n == 2 {
                (follow.closed, follow.in_turn) = (false, true);
            }
            Vec::new()
        }).await.unwrap();
    }
    // The app again: a new link, whose connect reads the listing.
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(rig.fx.core.clone()));
    let again = Link::start(rig.fx.core.clone(), direct, reads, Arc::new(Notices::default()), changed);
    let mut applied = again.applied();
    let filled = tokio::time::timeout(WAIT, async {
        loop {
            let mut now = Vec::new();
            for run in &runs {
                now.push(rig.get(run).await);
            }
            if now.iter().all(|run| run.branch.is_some()) && now[2].state == RunState::Stopped {
                return now;
            }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(50), applied.changed()).await;
        }
    })
    .await
    .expect("the connect filled every branch in, and cut the lost turn");
    for (run, (branch, worktree)) in filled.iter().zip(&kept) {
        assert_eq!((run.branch.as_ref(), &run.expected_worktree), (Some(branch), worktree), "{}", run.id);
    }
}

#[tokio::test]
async fn delete_keeps_a_harness_runs_session_on_record_while_its_worktree_stays_and_drops_it_once_removed() {
    let (_repo, setup, _git) = bare_repo();
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_as(&served, "claude", 6).await;
    let kept = rig.launched(1).await;
    let removed = rig.launched(2).await;
    for run in [&kept, &removed] {
        until_state(&rig, run, RunState::Done).await;
    }
    assert_eq!(rig.svc.cleanup(&removed.id).await.unwrap(), crate::runs::cleanup::Cleanup::Removed);
    rig.svc.archive(&[kept.id.clone(), removed.id.clone()]).await.unwrap();
    rig.svc.delete(&kept.id, false).await.unwrap();
    rig.svc.delete(&removed.id, false).await.unwrap();
    let rows = |id: &str| -> i64 { rusqlite::Connection::open(rig.fx.dir.join("app.sqlite")).unwrap().query_row("SELECT count(*) FROM run_sessions WHERE run_id = ?1", [id], |r| r.get(0)).unwrap() };
    assert_eq!((rows(&kept.id), rows(&removed.id)), (1, 0), "the only record of a worktree that stays is kept");
}

#[tokio::test]
async fn a_clean_up_git_would_refuse_is_refused_before_the_session_is_closed_so_the_agent_still_takes_a_message() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (_repo, setup, git) = bare_repo_at(Some(fx.home.canonicalize().unwrap()));
    let mut served = Served::idle();
    served.serve_as(TWO_TURNS, 4, setup, "claude");
    let rig = on_harness_sharing(fx, &served, &git).await;
    // A real clone where the rig made its stand-in, for the app's git and the harness's to share.
    std::fs::remove_dir_all(&rig.clone).unwrap();
    git.run(rig.clone.parent().unwrap(), &["clone", "--quiet", "https://github.com/acme/webshop.git", "webshop"]);
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let worktree = git.worktree(&done.spec.name);
    std::fs::write(worktree.join("FIX"), "fixed\n").unwrap();
    git.run(&worktree, &["add", "FIX"]);
    git.run(&worktree, &["commit", "--quiet", "-m", "the fix"]);
    let crate::runs::cleanup::Cleanup::Refused { message } = rig.svc.cleanup(&run.id).await.unwrap() else { panic!("refused") };
    assert!(message.starts_with("Nothing was removed: the branch"), "git's reason, as a sentence: {message}");
    let session = done.harness_session.clone().unwrap();
    assert!(!rig.fx.core.session_run(&session).await.unwrap().unwrap().1.closed, "the session was not closed");
    let (_, delivery) = rig.svc.message_agent(&run.id, "Push your branch.", crate::domain::Actor::Person).await.unwrap();
    assert_eq!(delivery, crate::runs::message::Delivery::Queued);
    until_detail(&rig, &run, "Back again.").await;
    assert!(worktree.join("FIX").is_file(), "the work stays");
}

/// A run of the old path in `state`, with its `claude --bg` short id.
async fn old_path(rig: &Rig, n: u32, state: RunState) -> Run {
    let run = rig.fx.core.queue_test_run(rig.spec(n), None).await.unwrap();
    rig.set(&run, |r| {
        r.state = state;
        r.short_id = Some(crate::runs::cli::ShortId::parse(&format!("{n:08x}")).unwrap());
    })
    .await
}

#[tokio::test]
async fn a_run_that_ends_while_the_move_waits_for_a_launch_is_left_as_it_ended() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = Arc::new(on_harness(&served).await);
    let going = old_path(&rig, 1, RunState::Working).await;
    let held = rig.svc.launching.clone().lock_owned().await;
    let moving = tokio::spawn({
        let rig = rig.clone();
        async move { rig.svc.move_to_harness().await }
    });
    tokio::task::yield_now().await;
    rig.set(&going, |r| r.state = RunState::Done).await;
    drop(held);
    moving.await.unwrap();
    assert_eq!((rig.get(&going).await.state, rig.cli.0.lock().unwrap().stops.len()), (RunState::Done, 0), "not stopped, not marked interrupted");
    assert!(rig.fx.core.harness_moved().await.unwrap());
}

#[tokio::test]
async fn the_move_is_done_only_once_every_agent_is_stopped_and_a_job_claude_no_longer_has_counts_as_stopped() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let going = old_path(&rig, 1, RunState::Working).await;
    rig.cli.with(|s| s.stop_fails = true);
    rig.svc.move_to_harness().await;
    assert_eq!(rig.get(&going).await.state, RunState::Working, "a stop that failed leaves the run");
    assert!(!rig.fx.core.harness_moved().await.unwrap(), "and the move for the next start");
    rig.cli.with(|s| s.stop_says = Some("No job matching 00000001".into()));
    rig.svc.move_to_harness().await;
    assert_eq!(rig.get(&going).await.failure, Some(crate::domain::RunFailure::Interrupted), "its job is gone: stopped");
    assert!(rig.fx.core.harness_moved().await.unwrap());
}

#[tokio::test]
async fn a_launch_with_no_session_yet_keeps_the_move_for_the_next_start() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let run = rig.fx.core.queue_test_run(rig.spec(1), None).await.unwrap();
    rig.set(&run, |r| r.state = RunState::Launching).await;
    rig.svc.move_to_harness().await;
    assert!(!rig.fx.core.harness_moved().await.unwrap(), "passed over, so not done");
}

#[tokio::test]
async fn a_run_the_move_stopped_while_it_waited_on_your_answer_wakes_pip_once() {
    let served = Served::new(WORKS_LONG, 4);
    let rig = on_harness(&served).await;
    let asking = old_path(&rig, 1, RunState::NeedsAnswer).await;
    let asking = rig.set(&asking, |r| r.needs = Some("Which database?".into())).await;
    let working = old_path(&rig, 2, RunState::Working).await;
    rig.svc.move_to_harness().await;
    let told: Vec<(String, crate::runs::tracker::Attention)> = rig.notices.0.lock().unwrap().iter().map(|(id, why, _)| (id.clone(), *why)).collect();
    assert_eq!(told, vec![(asking.id.clone(), crate::runs::tracker::Attention::Failed)], "only the one that waited on you: {told:?} ({})", working.id);
}

#[tokio::test]
async fn a_run_taken_back_takes_your_message_while_it_still_reads_stopped_from_its_hand_over() {
    let served = Served::new(TWO_TURNS, 4);
    let rig = on_harness(&served).await;
    let run = rig.launched(1).await;
    let done = until_state(&rig, &run, RunState::Done).await;
    let link = &rig.svc.harness.as_ref().unwrap().link;
    link.call(Op::HandOver { session: done.harness_session.clone().unwrap() }).await.unwrap();
    until_detail(&rig, &run, crate::runs::consumer::HANDED_OVER).await;
    // As a run reads that Terminal had stopped: a send to a stopped run is refused but for a take back.
    rig.set(&run, |r| r.state = RunState::Stopped).await;
    rig.svc.answer_took_back(&run.id, "Carry on.", true).await.unwrap();
    until_detail(&rig, &run, "Back again.").await;
}

#[tokio::test]
async fn a_clean_up_refused_for_the_clones_own_settings_says_how_to_remove_them_as_the_clone_note_does() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (_repo, setup, git) = bare_repo_at(Some(fx.home.canonicalize().unwrap()));
    let mut served = Served::idle();
    served.serve_as(FINISHES, 4, setup, "claude");
    let rig = on_harness_sharing(fx, &served, &git).await;
    std::fs::remove_dir_all(&rig.clone).unwrap();
    git.run(rig.clone.parent().unwrap(), &["clone", "--quiet", "https://github.com/acme/webshop.git", "webshop"]);
    let run = rig.launched(1).await;
    until_state(&rig, &run, RunState::Done).await;
    // As an agent's `git config` in its worktree writes the clone's shared config.
    git.run(&rig.clone, &["config", "commit.gpgsign", "false"]);
    let crate::runs::cleanup::Cleanup::Refused { message } = rig.svc.cleanup(&run.id).await.unwrap() else { panic!("refused") };
    let way_out = crate::runs::service::fresh::clone_settings_way_out(&message, &rig.clone).expect("the reason is the clone's settings");
    assert!(message.ends_with(&way_out), "{message}");
    assert!(way_out.contains("config --unset commit.gpgsign"), "{way_out}");
}
