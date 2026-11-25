use std::sync::Arc;

use harness::api::Op;
use harness::event::{Body, Event};

use super::*;
use crate::domain::RunState;
use crate::inbox::testing::fixture_watching;
use crate::runs::link::served::{Direct, Served, WAIT};
use crate::runs::link::NoTools;
use crate::runs::rig::{ready_on, Notices, Rig};

const FINISHES: &str = r#"{"prompt": null}
{"say": "Looking at the cart."}
{"end": "done"}
{"prompt": null}"#;

async fn on_harness(served: &Served) -> Rig {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let reads = Arc::new(crate::agent::agent_tools::HarnessReads(fx.core.clone()));
    let link = Arc::new(Link::start(fx.core.clone(), direct, reads, Arc::new(Notices::default()), changed));
    ready_on(fx, |svc| svc.with_harness(OnHarness { link, provider: "mock".into() })).await
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
    assert!(rig.svc.answer(&run.id, "More?").await.is_err(), "a closed session takes no message");
}

#[tokio::test]
async fn runs_on_the_harness_hold_no_slot_of_the_apps_so_more_than_its_cap_open_sessions() {
    let served = Served::new(ASKS, 4);
    let fx = fixture_watching(&["acme/webshop"]).await;
    let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    let link = Arc::new(Link::start(fx.core.clone(), direct, Arc::new(NoTools), Arc::new(Notices::default()), changed));
    let rig = ready_on(fx, |svc| svc.with_harness(OnHarness { link, provider: "mock".into() }).with_cap(1)).await;
    let (first, second) = (rig.launched(1).await, rig.launched(2).await);
    for run in [&first, &second] {
        assert!(rig.get(run).await.harness_session.is_some(), "each opened a session");
    }
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
    let second = rig.launched(2).await;
    let waiting = until_detail(&rig, &second, crate::runs::consumer::SLOT_WAIT).await;
    assert_eq!(waiting.state, RunState::Launching, "it waits at the harness, not failed and not working");
    rig.svc.stop(&first.id).await.unwrap();
    until_state(&rig, &first, RunState::Stopped).await;
    let started = until_state(&rig, &second, RunState::Working).await;
    assert_ne!(started.last_detail.as_deref(), Some(crate::runs::consumer::SLOT_WAIT));
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
