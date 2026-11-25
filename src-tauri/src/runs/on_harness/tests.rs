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
    assert_eq!(brief, Some(crate::domain::render_prompt(&done.spec)), "the brief alone: the harness adds the guard");
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
