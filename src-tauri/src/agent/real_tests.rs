//! Run by hand against the real `claude`: `cargo test real_ -- --ignored`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::mcp::McpServer;
use super::{AgentEvent, AgentService, AskRequest};
use crate::domain::{Actor, CreatedBy, RunKind, RunQuery};

/// A real Pip turn, asked in a workstream to start an investigation, against a test core whose agent launcher is the
/// scripted CLI. Settles that the model calls `start_agent` from the tool list and description it is given, and that
/// the run it starts is Pip's, in the workstream, and launched. Uses the person's real, signed-in config and does model
/// work with one short prompt; nothing real is started, since the launcher is scripted.
#[tokio::test]
#[ignore = "runs the real claude with the real config and does model work"]
async fn real_pip_turn_calls_start_agent_for_an_investigation_in_its_workstream() {
    let rig = crate::runs::rig::ready().await;
    let core = rig.fx.core.clone();
    let ws = core.open_workstream(&rig.fx.scope, Some(rig.fx.item("CA-1")), None).await.unwrap();
    let server = McpServer::start(core.clone(), rig.svc.clone(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.expect("server");
    let svc = Arc::new(AgentService::new(core.clone(), server));

    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let ask = AskRequest {
        request_id: "real-1".into(),
        prompt: "Start an investigate agent in this workstream with the brief 'the cart rounding'. Then say which agent you started.".into(),
        session_id: None,
        context: Default::default(),
        images: Vec::new(),
        conversation: format!("{}{}", super::WORKSTREAM_PREFIX, ws.id),
        meta: None,
        event: None,
    };
    svc.ask(ask, Arc::new(move |u| seen.lock().unwrap().push(u.event))).await.expect("the turn starts");

    let deadline = Instant::now() + Duration::from_secs(240);
    let ended = loop {
        if let Some(done) = events.lock().unwrap().iter().find_map(|e| match e {
            AgentEvent::Done { ok, message, .. } => Some((*ok, message.clone())),
            _ => None,
        }) {
            break done;
        }
        assert!(Instant::now() < deadline, "the turn never ended");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    assert!(ended.0, "the turn failed: {:?}", ended.1);

    let steps: Vec<String> = events.lock().unwrap().iter().filter_map(|e| if let AgentEvent::Tool { label } = e { Some(label.clone()) } else { None }).collect();
    assert!(steps.iter().any(|s| s == "Started an agent"), "start_agent was never called: {steps:?}");
    let runs = core.runs_in(&rig.fx.scope, &RunQuery { workstream: Some(ws.id.clone()), ..Default::default() }).await.unwrap();
    let [run] = runs.as_slice() else { panic!("expected one run, found {runs:?}") };
    assert_eq!((run.spec.kind, run.created_by), (RunKind::Investigate, CreatedBy::Pip));
    let audit = core.workstream_events(&rig.fx.scope, &ws.id).await.unwrap();
    assert!(audit.iter().any(|e| e.actor == Actor::Pip && e.action == "agent_started" && e.run_id.as_deref() == Some(run.id.as_str())));
    for _ in 0..200 {
        if rig.cli.launches() == 1 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the scripted launcher was never handed the run");
}
