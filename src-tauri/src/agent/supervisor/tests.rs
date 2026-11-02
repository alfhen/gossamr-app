use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use serde_json::Value;
use tokio::sync::{mpsc, Notify};

use super::*;
use crate::agent::context::{keys_in, ScreenContext};
use crate::agent::mcp::McpServer;
use crate::agent::runs::testing::FakePlanner;
use crate::agent::{AgentRequest, AskRequest, EventStream, REMOVED};
use crate::claude::{ClaudeCodeProvider, StandIn};
use crate::db::PipTurn;
use crate::domain::fixtures::run_spec;
use crate::config::AgentSettings;
use crate::domain::workstream::{PauseReason, WAKES_PER_WORKSTREAM_PER_DAY, WAKE_TURNS_PER_DAY};
use crate::domain::{Doc, Intent, RunSpec, Workstream};
use crate::inbox::testing::{fixture, Fixture};

/// Answers every turn at once, or holds them all open while `hold` is set; ends each with `fail` when that is set.
#[derive(Default)]
struct Script {
    prompts: Mutex<Vec<(String, String)>>,
    fail: Mutex<Option<String>>,
    hold: AtomicBool,
    gates: Mutex<HashMap<String, Arc<Notify>>>,
    stopped: Mutex<HashSet<String>>,
}

#[derive(Clone, Default)]
struct Fake(Arc<Script>);

#[async_trait]
impl StandIn for Fake {
    async fn run(&self, req: AgentRequest) -> crate::error::Result<EventStream> {
        let s = self.0.clone();
        s.prompts.lock().unwrap().push((req.run_id.clone(), req.prompt.clone()));
        let gate = s.hold.load(Ordering::SeqCst).then(|| {
            let g = Arc::new(Notify::new());
            s.gates.lock().unwrap().insert(req.run_id.clone(), g.clone());
            g
        });
        let fail = s.fail.lock().unwrap().clone();
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let _ = tx.send(AgentEvent::Started { session_id: format!("sess-{}", req.run_id) });
            if let Some(g) = gate {
                g.notified().await;
            }
            let stopped = s.stopped.lock().unwrap().contains(&req.run_id);
            let _ = tx.send(AgentEvent::Text { text: "Noted.".into() });
            let (ok, message) = match (stopped, fail) {
                (true, _) => (false, Some("Stopped".to_string())),
                (false, Some(m)) => (false, Some(m)),
                (false, None) => (true, None),
            };
            let _ = tx.send(AgentEvent::Done { session_id: None, ok, message, usage: None });
        });
        Ok(rx)
    }

    fn cancel(&self, run_id: &str) {
        self.0.stopped.lock().unwrap().insert(run_id.into());
        if let Some(g) = self.0.gates.lock().unwrap().get(run_id) {
            g.notify_one();
        }
    }
}

impl Fake {
    fn prompt_of(&self, id: &str) -> Option<String> {
        self.0.prompts.lock().unwrap().iter().find(|(r, _)| r == id).map(|(_, p)| p.clone())
    }

    fn started(&self) -> Vec<String> {
        self.0.prompts.lock().unwrap().iter().map(|(r, _)| r.clone()).collect()
    }

    fn open_all(&self) {
        self.0.hold.store(false, Ordering::SeqCst);
        for g in self.0.gates.lock().unwrap().values() {
            g.notify_one();
        }
    }
}

type Emitted = Arc<Mutex<Vec<(String, Update)>>>;

struct T {
    fx: Fixture,
    svc: Arc<AgentService>,
    sup: Arc<Supervisor>,
    fake: Fake,
    ws: String,
    emitted: Emitted,
}

async fn service(fx: &Fixture, fake: &Fake) -> Arc<AgentService> {
    let server = McpServer::start(fx.core.clone(), FakePlanner::unused(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
    Arc::new(AgentService::with_provider(fx.core.clone(), server, ClaudeCodeProvider::standing_in(Arc::new(fake.clone()))))
}

fn supervisor(fx: &Fixture, svc: &Arc<AgentService>, emitted: &Emitted) -> Arc<Supervisor> {
    let into = emitted.clone();
    let sup = Supervisor::new(fx.core.clone(), Arc::new(move |conversation, u| into.lock().unwrap().push((conversation.to_string(), u))), Arc::new(|_| {}));
    sup.bind(svc);
    sup
}

/// A workstream on CA-1, a supervisor bound to an agent service, and Pip answering every turn at once.
async fn setup() -> T {
    setup_in(fixture().await).await
}

async fn setup_in(fx: Fixture) -> T {
    let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
    let fake = Fake::default();
    let svc = service(&fx, &fake).await;
    let emitted: Emitted = Arc::default();
    let sup = supervisor(&fx, &svc, &emitted);
    T { fx, svc, sup, fake, ws: ws.id, emitted }
}

impl T {
    fn conversation(&self) -> String {
        format!("ws:{}", self.ws)
    }

    /// Stores a run of `kind` linked to the workstream, at rest in `state`, changed by `edit`.
    async fn run(&self, id: &str, kind: &str, state: RunState, edit: impl FnOnce(&mut Run)) -> Run {
        let spec = RunSpec { role: Role::parse(kind).unwrap(), workstream: Some(self.ws.clone()), name: format!("ca-1-{id}"), ..run_spec() };
        let mut run = Run::queued(id.into(), format!("p-{id}"), self.fx.scope.connection_id.clone(), Some(self.fx.item("CA-1")), spec, Utc::now());
        run.state = state;
        run.ended_at = Some(Utc::now());
        edit(&mut run);
        self.fx.insert_run(&run).await;
        run
    }

    async fn turns(&self) -> Vec<PipTurn> {
        self.fx.core.pip_turns(&self.conversation()).await.unwrap()
    }

    async fn wake_turns(&self) -> Vec<PipTurn> {
        self.turns().await.into_iter().filter(|t| t.kind == "wake").collect()
    }

    /// The audit's `wake` lines: run and state.
    async fn wakes(&self) -> Vec<(String, String)> {
        let events = self.fx.core.workstream_events(&self.fx.scope, &self.ws).await.unwrap();
        events.into_iter().filter(|e| e.action == "wake").map(|e| (e.run_id.unwrap_or_default(), e.detail.unwrap_or_default())).collect()
    }

    async fn actions(&self) -> Vec<(Actor, String, Option<String>)> {
        let events = self.fx.core.workstream_events(&self.fx.scope, &self.ws).await.unwrap();
        events.into_iter().map(|e| (e.actor, e.action, e.detail)).collect()
    }

    async fn workstream(&self) -> Workstream {
        self.fx.core.workstream(&self.fx.scope, &self.ws).await.unwrap().unwrap().workstream
    }

    async fn pause(&self) {
        self.fx.core.pause_workstream(&self.fx.scope, &self.ws, PauseReason::Person, Actor::Person).await.unwrap();
    }

    async fn resume(&self) {
        self.fx.core.resume_workstream(&self.fx.scope, &self.ws).await.unwrap();
    }

    /// Waits until no turn of the workstream's conversation is waiting or running.
    async fn idle(&self) {
        for _ in 0..300 {
            if self.turns().await.iter().all(|t| t.status != "queued" && t.status != "running") {
                // Its place in the queue is given up just after it is recorded.
                tokio::time::sleep(Duration::from_millis(5)).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("turns never settled: {:?}", self.turns().await.iter().map(|t| (&t.request_id, &t.status)).collect::<Vec<_>>());
    }

    async fn until(&self, what: &str, mut ok: impl FnMut(&[PipTurn]) -> bool) {
        for _ in 0..300 {
            if ok(&self.turns().await) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("never {what}: {:?}", self.turns().await.iter().map(|t| (&t.request_id, &t.kind, &t.status)).collect::<Vec<_>>());
    }

    /// The tracker's notice about `run`, worked through as the spawned task would, then every turn settled.
    async fn noticed(&self, run: &Run, why: Attention) {
        self.sup.clone().on_run(run.clone(), why).await;
        self.idle().await;
    }

    async fn sweep(&self) {
        self.sup.sweep_at(Utc::now()).await;
        self.idle().await;
    }
}

fn ask(id: &str, conversation: &str) -> AskRequest {
    AskRequest {
        request_id: id.into(),
        prompt: format!("question {id}"),
        session_id: None,
        context: ScreenContext::default(),
        images: Vec::new(),
        conversation: conversation.into(),
        meta: None,
        event: None,
    }
}

// The shared fixtures.

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../../../src/backend/supervisor.fixtures.json")).unwrap()
}

#[test]
fn merged_facts_give_one_line_each_and_the_request_names_no_ticket() {
    let fact = |run: &str, kind: &str, state| WakeFact { run: run.into(), role: Role::parse(kind).unwrap(), state, mark: String::new(), drafts: 0 };
    let mut facts = WakeFacts { workstream: "w1".into(), facts: vec![fact("r1", "investigate", WakeState::Done)] };
    facts.merge(&WakeFacts { workstream: "w1".into(), facts: vec![fact("r1", "investigate", WakeState::Done), fact("r2", "triage", WakeState::Failed)] });
    assert_eq!(event_line(&facts), "[Event] run r1 (investigate) Done\n[Event] run r2 (triage) Failed");
    assert!(keys_in(WAKE_REQUEST).is_empty());
}

#[test]
fn old_structured_wake_metadata_is_ignored_instead_of_becoming_a_verdict() {
    let fact: WakeFact = serde_json::from_value(serde_json::json!({
        "run": "r1", "role": "reviewer", "state": "done", "verdict": "blocking", "blocking": 3,
        "planRecommended": true, "openQuestions": 2, "waitingForPr": true
    })).unwrap();
    assert_eq!(event_line(&WakeFacts { workstream: "w1".into(), facts: vec![fact] }), "[Event] run r1 (reviewer) Done");
}

#[tokio::test]
async fn a_stale_finish_notice_is_not_woken_after_the_run_continues() {
    let t = setup().await;
    let finished = t.run("r1", "investigator", RunState::Done, |_| {}).await;
    let stale = WakeFact::new(&finished, WakeState::Done);
    let resumed = Run { state: RunState::Working, continued_at: Some(Utc::now()), ended_at: None, ..finished };
    t.fx.core.save_run(&resumed).await.unwrap();
    t.sup.handle(&t.ws, vec![stale.clone()], Utc::now()).await;
    t.idle().await;
    assert!(t.wakes().await.is_empty());
    let finished_again = Run { state: RunState::Done, ended_at: Some(Utc::now()), ..resumed };
    t.fx.core.save_run(&finished_again).await.unwrap();
    t.sup.handle(&t.ws, vec![stale], Utc::now()).await;
    assert!(t.wakes().await.is_empty());
    t.sweep().await;
    assert_eq!(t.wakes().await, [("r1".into(), WakeFact::new(&finished_again, WakeState::Done).key().into())]);
}

#[tokio::test]
async fn a_transient_stop_after_a_successful_resume_is_not_a_wake_but_a_persistent_stop_is() {
    let t = setup().await;
    let now = Utc::now();
    t.run("r1", "builder", RunState::Stopped, |run| run.continued_at = Some(now)).await;
    t.sup.sweep_at(now).await;
    t.idle().await;
    assert!(t.wakes().await.is_empty());
    t.sup.sweep_at(now + chrono::Duration::seconds(61)).await;
    t.idle().await;
    assert_eq!(t.wakes().await.len(), 1);
}

#[tokio::test]
async fn a_failed_resume_is_reported_without_waiting_for_the_settle_window() {
    let t = setup().await;
    t.run("r1", "builder", RunState::Stopped, |run| {
        run.continued_at = Some(Utc::now());
        run.error = Some("Couldn't wake the agent.".into());
    }).await;
    t.sweep().await;
    assert_eq!(t.wakes().await.len(), 1);
}

#[tokio::test]
async fn a_resumed_run_that_moves_past_the_transient_stop_never_wakes_for_that_stop() {
    let t = setup().await;
    let now = Utc::now();
    let run = t.run("r1", "builder", RunState::Stopped, |run| run.continued_at = Some(now)).await;
    t.sup.sweep_at(now).await;
    t.fx.core.save_run(&Run { state: RunState::Working, ended_at: None, ..run }).await.unwrap();
    t.sup.sweep_at(now + chrono::Duration::seconds(61)).await;
    t.idle().await;
    assert!(t.wakes().await.is_empty());
}

#[test]
fn quota_errors_are_told_from_other_failures() {
    for quota in ["Claude AI usage limit reached|1760000000", "API Error: 429 rate_limit_error", "Rate limit exceeded", "Invalid API key · Please run /login", "OAuth token has expired", "authentication_error"] {
        assert!(is_quota_error(quota), "{quota}");
    }
    for other in ["Pip stopped", "Stopped", "The assistant provider “x” isn't available.", REMOVED, "Gossamr closed before Pip finished"] {
        assert!(!is_quota_error(other), "{other}");
    }
    assert_eq!(next_backoff(BACKOFF_FIRST), Duration::from_secs(120));
    assert_eq!(next_backoff(Duration::from_secs(40 * 60)), BACKOFF_MAX);
    assert_eq!(next_backoff(BACKOFF_MAX), BACKOFF_MAX);
}

#[test]
fn a_fact_is_keyed_by_its_state_and_a_finish_after_a_continuation_is_another() {
    let mut run = Run::queued("r1".into(), "p".into(), "c".into(), None, run_spec(), Utc::now());
    run.state = RunState::Done;
    assert_eq!(WakeFact::new(&run, WakeState::Done).key(), "done");
    run.continued_at = Some(Utc::now());
    assert!(WakeFact::new(&run, WakeState::Done).key().starts_with("done@"));
    run.state = RunState::Stopped;
    assert_eq!(WakeState::of_run(&run), Some(WakeState::Stopped));
    run.unsent_answer = Some("Use staging.".into());
    assert_eq!(WakeState::of_run(&run), None, "a stop on the way to a resume wakes nobody");
    run.error = Some("The session didn't show as stopped.".into());
    assert_eq!(WakeState::of_run(&run), Some(WakeState::Stopped), "a resume that failed is news");
    run.state = RunState::Working;
    assert_eq!(WakeState::of_run(&run), None, "a run under way is no fact for the sweep");
    run.state = RunState::SystemBlocked;
    assert_eq!(WakeState::of_attention(&run, Attention::Needs), WakeState::SystemBlocked);
    assert_eq!(WakeState::of_attention(&run, Attention::Done), WakeState::Done);
}

// Waking.

#[tokio::test]
async fn a_run_finishing_wakes_pip_once_whatever_repeats_it() {
    let t = setup().await;
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.sup.notify(&run, Attention::Done);
    t.until("woken", |turns| turns.iter().any(|w| w.kind == "wake" && w.status == "done")).await;
    t.sup.notify(&run, Attention::Done);
    tokio::time::sleep(Duration::from_millis(50)).await;
    t.sweep().await;
    let woken = t.wake_turns().await;
    assert_eq!(woken.len(), 1, "one turn for one run finishing");
    assert_eq!(woken[0].prompt, "[Event] run r1 (investigate) Done");
    assert_eq!(t.wakes().await, [("r1".to_string(), "done".to_string())]);

    // Pip's turn is an ordinary turn of the workstream's conversation with the event before its workstream block.
    let prompt = t.fake.prompt_of(&woken[0].request_id).unwrap();
    let event = prompt.find("\n[Event] run r1 (investigate) Done\n").expect("an event block");
    assert!(event < prompt.find("[Workstream").unwrap() && prompt.ends_with(WAKE_REQUEST), "{prompt}");
    // The page is told about the turn it didn't start, in the workstream's conversation.
    let emitted = t.emitted.lock().unwrap();
    assert!(emitted.iter().all(|(c, u)| *c == t.conversation() && u.request_id == woken[0].request_id));
    assert!(matches!(emitted.last(), Some((_, Update { event: AgentEvent::Done { ok: true, .. }, .. }))));
}

#[tokio::test]
async fn a_stop_from_outside_and_a_silent_finish_after_a_continuation_are_caught_by_the_sweep() {
    let t = setup().await;
    let first = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&first, Attention::Done).await;
    // Neither of these is ever told: a stop nobody here asked for, and a finish again after carrying on that drafted nothing.
    t.run("r2", "triage", RunState::Stopped, |_| {}).await;
    t.fx.core.save_run(&Run { continued_at: Some(Utc::now()), ..t.fx.core.run("r1").await.unwrap().unwrap() }).await.unwrap();
    assert_eq!(t.wake_turns().await.len(), 1);
    t.sweep().await;
    let wakes = t.wakes().await;
    assert_eq!(wakes.len(), 3, "{wakes:?}");
    assert!(wakes.contains(&("r2".into(), "stopped".into())));
    assert!(wakes.iter().any(|(r, s)| r == "r1" && s.starts_with("done@")));
    let lines: Vec<String> = t.wake_turns().await.into_iter().map(|w| w.prompt).collect();
    assert_eq!(lines.len(), 2, "the two facts the sweep found wake Pip once: {lines:?}");
    assert!(lines[1].contains("[Event] run r1 (investigate) Done") && lines[1].contains("[Event] run r2 (triage) Stopped"), "{lines:?}");
    t.sweep().await;
    assert_eq!(t.wake_turns().await.len(), 2, "a second sweep finds nothing new");
}

#[tokio::test]
async fn a_stop_the_person_asked_for_wakes_nobody() {
    let t = setup().await;
    let stopped = t.run("r1", "investigate", RunState::Stopped, |_| {}).await;
    t.fx.core.record_run_action_by(&stopped, Actor::Person, "run_stopped", None).await.unwrap();
    t.sweep().await;
    assert!(t.wake_turns().await.is_empty() && t.wakes().await.is_empty(), "{:?}", t.wakes().await);

    // Carrying on and being stopped again by something else is news.
    let continued_at = Utc::now() + chrono::Duration::seconds(5);
    t.fx.core.save_run(&Run { continued_at: Some(continued_at), ..t.fx.core.run("r1").await.unwrap().unwrap() }).await.unwrap();
    t.sup.sweep_at(continued_at + chrono::Duration::seconds(61)).await;
    t.idle().await;
    assert_eq!(t.wakes().await.len(), 1);
}

#[tokio::test]
async fn a_stop_pip_made_wakes_nobody_and_neither_does_a_stop_that_is_only_the_start_of_a_resume() {
    let t = setup().await;
    let stopped = t.run("r1", "investigate", RunState::Stopped, |_| {}).await;
    t.fx.core.record_run_action_by(&stopped, Actor::Pip, "run_stopped", None).await.unwrap();
    t.run("r2", "triage", RunState::Stopped, |r| r.unsent_answer = Some("Use staging.".into())).await;
    t.sweep().await;
    assert!(t.wake_turns().await.is_empty() && t.wakes().await.is_empty(), "{:?}", t.wakes().await);

    // The message that was to wake r2 failed for good and the person cleared it: a stop nobody asked for is news again.
    t.fx.core.save_run(&Run { unsent_answer: None, ..t.fx.core.run("r2").await.unwrap().unwrap() }).await.unwrap();
    t.sweep().await;
    assert_eq!(t.wakes().await, [("r2".to_string(), "stopped".to_string())]);
}

#[tokio::test]
async fn a_pull_request_that_was_there_when_the_build_finished_is_no_second_wake() {
    let t = setup_in(crate::inbox::testing::fixture_watching(&["acme/webshop"]).await).await;
    let build = t.run("b1", "build", RunState::Done, |_| {}).await;
    let mut change = crate::codehost::links::tests::pr(12, &format!("worktree-{}", build.spec.name), "T", "");
    change.state = crate::domain::CodeChangeState::Open;
    t.fx.core.with_code_db("github:ann", |db| db.upsert_code_changes(&[change], "2026-09-29T00:00:00Z")).unwrap();
    t.sweep().await;
    t.sweep().await;
    let lines: Vec<String> = t.wake_turns().await.into_iter().map(|w| w.prompt).collect();
    assert_eq!(lines, ["[Event] run b1 (build) Done"]);
}

#[tokio::test]
async fn a_wake_that_fails_before_its_sink_hears_of_it_gives_its_facts_back_once() {
    let t = setup().await;
    let signed_out = fixture().await;
    signed_out.core.remove_instance(&signed_out.scope.connection_id).await.unwrap();
    let svc = service(&signed_out, &Fake::default()).await;
    let sup = supervisor(&t.fx, &svc, &t.emitted);
    let r1 = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    sup.clone().on_run(r1, Attention::Done).await;
    assert_eq!(t.actions().await.iter().filter(|(_, a, _)| a == "wake_dropped").count(), 1);
    assert!(t.wake_turns().await.is_empty());
    assert_eq!(sup.quota_state(&t.ws), None, "no backoff for what never reached the queue");
}

#[tokio::test]
async fn a_finished_agent_wakes_pip_in_a_ticketless_workstream() {
    let t = setup().await;
    let ws = t.fx.core.open_workstream(&t.fx.scope, None, Some("Look into checkout".into())).await.unwrap();
    let spec = RunSpec { workstream: Some(ws.id.clone()), ..run_spec() };
    let mut run = Run::queued("r9".into(), "p-r9".into(), t.fx.scope.connection_id.clone(), None, spec, Utc::now());
    run.state = RunState::Done;
    t.fx.insert_run(&run).await;
    t.sup.clone().on_run(run, Attention::Done).await;
    let conversation = format!("ws:{}", ws.id);
    for _ in 0..300 {
        if t.fx.core.pip_turns(&conversation).await.unwrap().iter().any(|w| w.kind == "wake") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let turns = t.fx.core.pip_turns(&conversation).await.unwrap();
    assert_eq!(turns.iter().filter(|w| w.kind == "wake").map(|w| w.prompt.as_str()).collect::<Vec<_>>(), ["[Event] run r9 (investigate) Done"]);
}

#[tokio::test]
async fn paused_and_closed_workstreams_are_not_woken_and_mark_nothing() {
    let t = setup().await;
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.pause().await;
    t.noticed(&run, Attention::Done).await;
    t.sweep().await;
    assert!(t.wake_turns().await.is_empty() && t.wakes().await.is_empty());

    // Nothing was marked, so resuming wakes Pip for it once.
    t.resume().await;
    t.sweep().await;
    assert_eq!(t.wake_turns().await.len(), 1);
    t.fx.core.close_workstream(&t.fx.scope, &t.ws).await.unwrap();
    let late = t.run("r2", "triage", RunState::Done, |_| {}).await;
    t.noticed(&late, Attention::Done).await;
    assert_eq!(t.wake_turns().await.len(), 1, "a closed workstream is never woken");
}

#[tokio::test]
async fn after_a_restart_only_what_pip_was_not_woken_for_wakes_it() {
    let t = setup().await;
    let before = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&before, Attention::Done).await;
    assert_eq!(t.wake_turns().await.len(), 1);
    // The app closes; a run finishes meanwhile; the app opens again with a supervisor that remembers nothing.
    t.run("r2", "triage", RunState::Done, |_| {}).await;
    t.fx.core.restart();
    assert_eq!(t.workstream().await.paused_reason, None, "a restart pauses nothing");
    let fake = Fake::default();
    let svc = service(&t.fx, &fake).await;
    let sup = supervisor(&t.fx, &svc, &t.emitted);
    sup.sweep_at(Utc::now()).await;
    sup.clone().on_run(before.clone(), Attention::Done).await;
    t.idle().await;
    assert_eq!(t.wakes().await, [("r1".to_string(), "done".to_string()), ("r2".into(), "done".into())], "one wake per run, ever");
    assert_eq!(t.wake_turns().await.len(), 2);
    assert_eq!(fake.started().len(), 1);

    // Paused and resumed, with yet another fresh supervisor: nothing is new.
    t.pause().await;
    t.resume().await;
    sup.forget();
    let again = supervisor(&t.fx, &svc, &t.emitted);
    again.sweep_at(Utc::now()).await;
    again.clone().on_run(before, Attention::Done).await;
    t.idle().await;
    assert_eq!(t.wake_turns().await.len(), 2);
    assert_eq!(t.wakes().await.len(), 2);
}

#[tokio::test]
async fn nothing_happens_before_the_supervisor_is_bound() {
    let fx = fixture().await;
    let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
    let sup = Supervisor::new(fx.core.clone(), Arc::new(|_, _| {}), Arc::new(|_| {}));
    let spec = RunSpec { workstream: Some(ws.id.clone()), ..run_spec() };
    let mut run = Run::queued("r1".into(), "p".into(), fx.scope.connection_id.clone(), Some(fx.item("CA-1")), spec, Utc::now());
    run.state = RunState::Done;
    fx.insert_run(&run).await;
    sup.notify(&run, Attention::Done);
    sup.sweep_at(Utc::now()).await;
    sup.clone().handle(&ws.id, vec![WakeFact::new(&run, WakeState::Done)], Utc::now()).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(fx.core.workstream_events(&fx.scope, &ws.id).await.unwrap().iter().all(|e| e.action != "wake"));
}

// What the person's message does to wakes.

#[tokio::test]
async fn a_person_s_message_goes_ahead_of_a_waiting_wake_and_pre_empts_a_running_one() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    let (sink, conversation) = (Arc::new(|_| {}) as crate::agent::UpdateSink, t.conversation());
    // The person's question runs; a wake waits behind it; the person writes again.
    t.svc.ask(ask("q1", &conversation), sink.clone()).await.unwrap();
    let r1 = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r1, Attention::Done).await;
    let waiting = t.wake_turns().await;
    assert_eq!(waiting.iter().map(|w| w.status.as_str()).collect::<Vec<_>>(), ["queued"]);
    // A second fact while one waits is merged into it.
    let r2 = t.run("r2", "triage", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r2, Attention::Done).await;
    let merged = t.wake_turns().await;
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].prompt, "[Event] run r1 (investigate) Done\n[Event] run r2 (triage) Done");

    t.svc.ask(ask("q2", &conversation), sink.clone()).await.unwrap();
    let removed = t.wake_turns().await;
    assert_eq!((removed[0].status.as_str(), removed[0].error.as_deref()), ("failed", Some(REMOVED)));
    let queued_again = &removed[1];
    assert_eq!((queued_again.status.as_str(), queued_again.prompt.as_str()), ("queued", "[Event] run r1 (investigate) Done\n[Event] run r2 (triage) Done"), "its facts wait behind the message");

    // The message ran first; the wake then ran with its facts.
    t.fake.open_all();
    t.idle().await;
    let order = t.fake.started();
    assert_eq!(order.len(), 3, "q1, q2 and the wake: {order:?}");
    assert_eq!(order[1], "q2");
    assert_eq!(t.wakes().await.len(), 2, "each fact was recorded once");

    // Now a wake runs, and the person writes: it is stopped and its facts are queued again behind the message.
    t.fake.0.hold.store(true, Ordering::SeqCst);
    let r3 = t.run("r3", "plan", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r3, Attention::Done).await;
    t.until("a wake running", |turns| turns.iter().any(|w| w.kind == "wake" && w.status == "running")).await;
    let running = t.wake_turns().await.into_iter().find(|w| w.status == "running").unwrap();
    t.svc.ask(ask("q3", &conversation), sink.clone()).await.unwrap();
    t.until("q3 running", |turns| turns.iter().any(|w| w.request_id == "q3" && w.status == "running")).await;
    t.fake.open_all();
    t.idle().await;
    let after = t.turns().await;
    assert_eq!(after.iter().find(|w| w.request_id == running.request_id).map(|w| w.status.as_str()), Some("failed"), "the running wake was stopped");
    let order: Vec<String> = t.fake.started();
    let q3 = order.iter().position(|id| id == "q3").unwrap();
    let again = after.iter().filter(|w| w.kind == "wake" && w.prompt == "[Event] run r3 (plan) Done").collect::<Vec<_>>();
    assert_eq!(again.len(), 2, "queued again with the same facts");
    assert_eq!(again[1].status, "done");
    assert!(order.iter().position(|id| *id == again[1].request_id).unwrap() > q3, "after the person's message: {order:?}");
}

#[tokio::test]
async fn a_wake_merged_into_one_waiting_tells_the_page_through_the_waiting_wake() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    t.svc.ask(ask("q1", &t.conversation()), Arc::new(|_| {})).await.unwrap();
    let r1 = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r1, Attention::Done).await;
    let waiting = t.wake_turns().await[0].request_id.clone();
    let queued = |emitted: &Emitted| emitted.lock().unwrap().iter().filter(|(c, u)| *c == t.conversation() && matches!(u.event, AgentEvent::Queued { ahead: 1 })).map(|(_, u)| u.request_id.clone()).collect::<Vec<_>>();
    assert_eq!(queued(&t.emitted), std::slice::from_ref(&waiting));
    let r2 = t.run("r2", "triage", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r2, Attention::Done).await;
    assert_eq!(t.wake_turns().await.len(), 1, "merged");
    // The page hears of the waiting wake again, so it reads the merged lines it now has.
    assert_eq!(queued(&t.emitted), [waiting.clone(), waiting]);
    t.fake.open_all();
    t.idle().await;
}

#[tokio::test]
async fn pausing_cancels_the_workstream_s_turns_and_leaves_the_general_conversation_alone() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    let sink: crate::agent::UpdateSink = Arc::new(|_| {});
    t.svc.ask(ask("q1", &t.conversation()), sink.clone()).await.unwrap();
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(run, Attention::Done).await;
    t.svc.ask(ask("g1", crate::agent::GENERAL_CONVERSATION), sink.clone()).await.unwrap();
    t.pause().await;
    t.svc.cancel_workstream_turns(&t.ws).await;
    t.idle().await;
    let statuses: Vec<(String, String)> = t.turns().await.into_iter().map(|w| (w.kind, w.status)).collect();
    assert_eq!(statuses, [("user".to_string(), "failed".to_string()), ("wake".into(), "failed".into())]);
    let general = t.fx.core.pip_turns(crate::agent::GENERAL_CONVERSATION).await.unwrap();
    assert_eq!(general[0].status, "running", "the general conversation is no workstream's");
    t.fake.open_all();
}

// The ceilings.

#[tokio::test]
async fn a_workstream_woken_too_often_in_a_day_is_paused_at_its_ceiling_and_resuming_wakes_it_again() {
    let t = setup().await;
    for n in 1..=WAKES_PER_WORKSTREAM_PER_DAY {
        let run = t.run(&format!("r{n}"), "investigate", RunState::Done, |_| {}).await;
        t.noticed(&run, Attention::Done).await;
    }
    assert_eq!(t.wake_turns().await.len() as u32, WAKES_PER_WORKSTREAM_PER_DAY);
    assert_eq!(t.workstream().await.paused_reason, None);

    let over = t.run("over", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&over, Attention::Done).await;
    assert_eq!(t.workstream().await.paused_reason, Some(PauseReason::Ceiling));
    assert_eq!(t.wake_turns().await.len() as u32, WAKES_PER_WORKSTREAM_PER_DAY, "no turn for the one over");
    assert!(t.actions().await.contains(&(Actor::Supervisor, "paused".to_string(), Some("ceiling".to_string()))));
    assert!(t.wakes().await.iter().all(|(run, _)| run != "over"), "its fact isn't marked, so it waits for the person");
    t.sweep().await;
    assert_eq!(t.wake_turns().await.len() as u32, WAKES_PER_WORKSTREAM_PER_DAY, "paused, nothing wakes");

    t.resume().await;
    t.sweep().await;
    let turns = t.wake_turns().await;
    assert_eq!(turns.len() as u32, WAKES_PER_WORKSTREAM_PER_DAY + 1, "the person's resume starts the count again");
    assert_eq!(turns.last().unwrap().prompt, "[Event] run over (investigate) Done");
}

#[tokio::test]
async fn pip_woken_too_often_in_a_day_across_workstreams_pauses_the_workstream_that_asks_next() {
    let t = setup().await;
    for n in 0..WAKE_TURNS_PER_DAY {
        t.fx.core.pip_wake_begin(&t.fx.scope, "ws:elsewhere", &format!("seed{n}"), "[Event] run x (build) Done", &[], "done").await.unwrap();
    }
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&run, Attention::Done).await;
    assert_eq!(t.workstream().await.paused_reason, Some(PauseReason::Ceiling));
    assert!(t.wake_turns().await.is_empty());
    assert!(t.actions().await.contains(&(Actor::Supervisor, "paused".to_string(), Some("ceiling".to_string()))));

    t.resume().await;
    t.sweep().await;
    assert_eq!(t.workstream().await.paused_reason, None, "the person's resume lets Pip be woken here again");
    assert_eq!(t.wake_turns().await.len(), 1);
}

#[tokio::test]
async fn wake_turns_that_never_reached_pip_count_toward_no_ceiling() {
    let t = setup().await;
    for n in 0..WAKES_PER_WORKSTREAM_PER_DAY {
        let id = format!("never{n}");
        t.fx.core.pip_wake_begin(&t.fx.scope, &t.conversation(), &id, "[Event] run x (build) Done", &[], "queued").await.unwrap();
        t.fx.core.pip_turn_finish(&t.fx.scope, &id, "", false, Some(crate::agent::WAKE_PAUSED), None, None).await.unwrap();
    }
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&run, Attention::Done).await;
    assert_eq!(t.workstream().await.paused_reason, None);
    assert!(t.wake_turns().await.iter().any(|w| w.status == "done"));
}

#[tokio::test]
async fn a_wake_waiting_behind_the_person_when_gossamr_closes_is_woken_for_again_and_counts_toward_no_ceiling() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    t.svc.ask(ask("q1", &t.conversation()), Arc::new(|_| {})).await.unwrap();
    let run = t.run("r0", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(run, Attention::Done).await;
    t.until("a wake waiting", |turns| turns.iter().any(|w| w.kind == "wake" && w.status == "queued")).await;
    let waiting = t.wake_turns().await[0].request_id.clone();

    // Quitting and opening the app again leaves the wake never run, and its fact free to be woken for.
    t.fx.core.restart();
    let wake = t.wake_turns().await.into_iter().find(|w| w.request_id == waiting).unwrap();
    assert_eq!((wake.status.as_str(), wake.error.as_deref()), ("failed", Some(crate::db::NEVER_RAN)));
    assert!(dropped(&t, "done").await);
    let events = t.fx.core.workstream_events(&t.fx.scope, &t.ws).await.unwrap();
    assert!(crate::agent::supervisor::woken_in(&events).is_empty());
    assert!(!crate::agent::supervisor::reached_pip(&wake.status, wake.error.as_deref()));
    t.fake.open_all();
    t.idle().await;
}

// The quota.

async fn dropped(t: &T, run: &str) -> bool {
    t.actions().await.into_iter().any(|(a, action, d)| a == Actor::Supervisor && action == "wake_dropped" && d.as_deref() == Some(run))
}

async fn backing_off(t: &T, next: Duration) {
    for _ in 0..100 {
        if t.sup.quota_state(&t.ws) == Some((true, next)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no backoff of {next:?}: {:?}", t.sup.quota_state(&t.ws));
}

#[tokio::test]
async fn a_wake_that_hits_the_quota_gives_its_facts_back_and_holds_wakes_off_for_a_doubling_backoff() {
    let t = setup().await;
    *t.fake.0.fail.lock().unwrap() = Some("Claude AI usage limit reached".into());
    tokio::time::pause();
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&run, Attention::Done).await;
    backing_off(&t, Duration::from_secs(120)).await;
    assert_eq!(t.workstream().await.paused_reason, None, "the quota pauses nothing");
    assert!(dropped(&t, "done").await, "its fact is taken back, as after a restart it must be found again");
    // A second miss while the backoff runs starts no second one.
    t.sup.clone().back_off(WakeFacts { workstream: t.ws.clone(), facts: vec![WakeFact::new(&run, WakeState::Done)] }).await;
    assert_eq!(t.sup.quota_state(&t.ws), Some((true, Duration::from_secs(120))));
    assert_eq!(t.wake_turns().await.len(), 1);
    // Meanwhile a fact that comes in waits rather than meeting the quota again.
    let other = t.run("r2", "triage", RunState::Done, |_| {}).await;
    t.noticed(&other, Attention::Done).await;
    t.sweep().await;
    assert_eq!(t.wake_turns().await.len(), 1);

    // Once it is over the sweep wakes Pip for both facts in one turn; the quota still says no, so the wait doubles.
    tokio::time::advance(BACKOFF_FIRST + Duration::from_secs(1)).await;
    for _ in 0..100 {
        if t.sup.quota_state(&t.ws) == Some((false, Duration::from_secs(120))) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    t.sweep().await;
    backing_off(&t, Duration::from_secs(240)).await;
    let turns = t.wake_turns().await;
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1].prompt, "[Event] run r1 (investigate) Done\n[Event] run r2 (triage) Done");

    // The quota is back: the next sweep's turn goes through and the backoff is forgotten.
    *t.fake.0.fail.lock().unwrap() = None;
    tokio::time::advance(Duration::from_secs(241)).await;
    for _ in 0..100 {
        if t.sup.quota_state(&t.ws) == Some((false, Duration::from_secs(240))) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    t.sweep().await;
    assert_eq!(t.wake_turns().await.len(), 3);
    assert_eq!(t.sup.quota_state(&t.ws), None);
    t.sweep().await;
    assert_eq!(t.wake_turns().await.len(), 3, "nothing is left to wake for");
}

#[tokio::test]
async fn a_sweep_tells_pip_about_the_oldest_run_first_whatever_the_ids() {
    let t = setup().await;
    let first = Utc::now() - chrono::Duration::minutes(5);
    t.run("z-old", "investigate", RunState::Done, |run| run.queued_at = first).await;
    t.run("a-new", "triage", RunState::Done, |run| run.queued_at = first + chrono::Duration::minutes(1)).await;
    t.sweep().await;
    let turns = t.wake_turns().await;
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].prompt, "[Event] run z-old (investigate) Done\n[Event] run a-new (triage) Done");
}

/// A wake that hits the quota, with the backoff running.
async fn quota_missed(t: &T) -> Run {
    *t.fake.0.fail.lock().unwrap() = Some("Claude AI usage limit reached".into());
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&run, Attention::Done).await;
    backing_off(t, Duration::from_secs(120)).await;
    *t.fake.0.fail.lock().unwrap() = None;
    run
}

#[tokio::test]
async fn a_wake_that_hit_the_quota_is_found_again_after_a_restart() {
    let t = setup().await;
    let run = quota_missed(&t).await;
    t.fx.core.restart();
    let fake = Fake::default();
    let svc = service(&t.fx, &fake).await;
    let sup = supervisor(&t.fx, &svc, &t.emitted);
    sup.sweep_at(Utc::now()).await;
    t.idle().await;
    let turns = t.wake_turns().await;
    assert_eq!(turns.len(), 2);
    assert_eq!((turns[1].prompt.as_str(), turns[1].status.as_str()), (format!("[Event] run {} (investigate) Done", run.id).as_str(), "done"));
}

#[tokio::test]
async fn a_pause_and_a_resume_during_the_backoff_change_nothing_once_it_is_over() {
    let t = setup().await;
    tokio::time::pause();
    quota_missed(&t).await;
    t.pause().await;
    t.resume().await;
    tokio::time::advance(BACKOFF_FIRST + Duration::from_secs(1)).await;
    for _ in 0..100 {
        if !t.sup.quota_state(&t.ws).is_some_and(|(pending, _)| pending) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    t.sweep().await;
    assert_eq!(t.wake_turns().await.iter().filter(|w| w.status == "done").count(), 1);
    assert_eq!(t.wake_turns().await.len(), 2);
}

#[tokio::test]
async fn a_wake_waiting_when_the_quota_said_no_never_runs_and_gives_its_facts_back_too() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    *t.fake.0.fail.lock().unwrap() = Some("Claude AI usage limit reached".into());
    let r1 = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r1, Attention::Done).await;
    t.until("a wake running", |turns| turns.iter().any(|w| w.kind == "wake" && w.status == "running")).await;
    // A fact arrives while it runs, and waits behind it.
    let r2 = t.run("r2", "triage", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r2, Attention::Done).await;
    t.fake.open_all();
    t.idle().await;
    backing_off(&t, Duration::from_secs(120)).await;
    let dropped_runs: Vec<String> = t.fx.core.workstream_events(&t.fx.scope, &t.ws).await.unwrap().into_iter().filter(|e| e.action == "wake_dropped").filter_map(|e| e.run_id).collect();
    assert_eq!(dropped_runs.len(), 2, "both runs' facts were taken back: {dropped_runs:?}");
}

#[tokio::test]
async fn a_wake_merged_into_a_waiting_one_that_ends_paused_gives_every_fact_back() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    t.svc.ask(ask("q1", &t.conversation()), Arc::new(|_| {})).await.unwrap();
    for id in ["a", "b"] {
        let run = t.run(id, "investigate", RunState::Done, |_| {}).await;
        t.sup.clone().on_run(run, Attention::Done).await;
    }
    assert_eq!(t.wake_turns().await.len(), 1, "b was merged into a");
    t.pause().await;
    t.svc.cancel_workstream_turns(&t.ws).await;
    t.fake.open_all();
    t.idle().await;
    for _ in 0..100 {
        if t.actions().await.iter().filter(|(_, a, _)| a == "wake_dropped").count() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    t.resume().await;
    t.sweep().await;
    let lines: Vec<String> = t.wake_turns().await.into_iter().map(|w| w.prompt).collect();
    assert_eq!(lines.last().unwrap(), "[Event] run a (investigate) Done\n[Event] run b (investigate) Done", "{lines:?}");
}

// The ticket changing.

#[tokio::test]
async fn the_ticket_changing_is_noted_once_and_pauses_nothing() {
    let t = setup().await;
    t.sweep().await;
    assert!(t.actions().await.iter().all(|(_, a, _)| a != "basis_drifted"), "nothing changed yet");
    let before = t.workstream().await.basis;
    t.fx.edit_item("CA-1", |i| i.body = Doc::paragraph("Someone rewrote the ticket")).await;
    t.sweep().await;
    t.sweep().await;
    let ws = t.workstream().await;
    assert_eq!(ws.paused_reason, None);
    assert_ne!(ws.basis, before, "the ticket as it reads now is the basis");
    let noted = |actions: Vec<(Actor, String, Option<String>)>| actions.into_iter().filter(|(a, action, _)| *a == Actor::Supervisor && action == "basis_drifted").map(|(_, _, d)| d).collect::<Vec<_>>();
    assert_eq!(noted(t.actions().await), [Some("description".to_string())], "once, however often it is looked at");

    t.fx.edit_item("CA-1", |i| i.title = "Someone retitled the ticket".into()).await;
    t.sweep().await;
    assert_eq!(noted(t.actions().await), [Some("description".to_string()), Some("summary".to_string())]);
    assert!(t.fx.tracker.intents().is_empty(), "orchestration writes nothing to Jira");
}

#[tokio::test]
async fn a_move_to_done_is_noted_and_a_move_to_in_progress_is_not() {
    let t = setup().await;
    t.sweep().await;
    t.fx.edit_item("CA-1", |i| {
        i.status.id = "in-progress".into();
        i.status.category = crate::domain::Category::Active;
    })
    .await;
    t.sweep().await;
    assert!(t.actions().await.iter().all(|(_, a, _)| a != "basis_drifted"), "another status leaves the plan be");
    t.fx.edit_item("CA-1", |i| {
        i.status.id = "done".into();
        i.status.category = crate::domain::Category::Done;
    })
    .await;
    t.sweep().await;
    assert!(t.actions().await.contains(&(Actor::Supervisor, "basis_drifted".to_string(), Some("status".to_string()))));
    assert_eq!(t.workstream().await.paused_reason, None);
}

#[tokio::test]
async fn pip_is_told_the_ticket_changed_without_any_of_its_text() {
    const SENTINEL: &str = "SENTINEL-TICKET-TEXT";
    let t = setup().await;
    t.sweep().await;
    t.fx.edit_item("CA-1", |i| i.body = Doc::paragraph(&format!("{SENTINEL} CA-77 rewritten"))).await;
    t.sweep().await;
    let run = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    t.noticed(&run, Attention::Done).await;
    let woken = t.wake_turns().await;
    assert_eq!(woken.len(), 1);
    let sent = t.fake.prompt_of(&woken[0].request_id).unwrap();
    let line = sent.lines().find(|l| l.contains("the ticket's description changed in Jira")).unwrap_or_else(|| panic!("{sent}"));
    assert!(line.ends_with("Read it with get_item before drafting."), "{line}");
    assert!(!sent.contains(SENTINEL), "no ticket text in the wake: {sent}");
}

#[tokio::test]
async fn the_shared_basis_drift_fixtures_pass() {
    use crate::domain::{Category, PersonRef};
    use crate::inbox::{basis_of, drifted};
    let fx = fixture().await;
    let all = fixtures();
    let cases = all["basisDrift"].as_array().unwrap();
    assert!(cases.len() >= 10);
    let category = |c: &str| match c {
        "done" => Category::Done,
        "todo" => Category::Todo,
        _ => Category::Active,
    };
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let (b, n) = (&case["basis"], &case["now"]);
        let mut then = fx.tracker_item("CA-1");
        then.status.id = b["statusId"].as_str().unwrap().into();
        then.title = b["summary"].as_str().unwrap_or("").into();
        then.body = Doc::paragraph(b["description"].as_str().unwrap());
        let mut basis = basis_of(&then);
        if b.get("summary").is_none() {
            basis.summary_digest = None;
        }
        basis.changing = serde_json::from_value(b.get("changing").cloned().unwrap_or_else(|| serde_json::json!([]))).unwrap();
        let mut now = fx.tracker_item("CA-1");
        now.status.id = n["statusId"].as_str().unwrap().into();
        now.status.category = category(n["statusCategory"].as_str().unwrap());
        now.title = n["summary"].as_str().unwrap().into();
        now.body = Doc::paragraph(n["description"].as_str().unwrap());
        now.assignee = Some(PersonRef { connection_id: "c".into(), account_id: n["assignee"].as_str().unwrap().into() });
        let expect: Vec<String> = serde_json::from_value(case["expect"].clone()).unwrap();
        assert_eq!(drifted(&basis, &now), expect, "{name}");
    }
}

#[tokio::test]
async fn an_approved_description_draft_in_the_workstream_takes_the_basis_again_and_is_not_a_change() {
    let t = setup().await;
    // Jira's own copy of the ticket, with the payload a refresh reads.
    let mut item = t.fx.tracker_item("CA-1");
    // Its summary as the cache has it, so only the description changes.
    item.title = t.fx.core.cache_item(&t.fx.item("CA-1")).await.unwrap().unwrap().title;
    let to = Doc::paragraph("## Plan\n\n1. Fix the rounding");
    let intent = Intent::Rewrite { item: t.fx.item("CA-1"), title: None, body: Some(crate::domain::BodyChange { from: item.body.clone(), to: to.clone() }), flattened: vec![] };
    assert!(t.fx.tracker.intents().is_empty());
    let draft = crate::proposals::Draft::from_pip("q1", Some(&t.ws), intent, None);
    let p = t.fx.core.propose(&t.fx.scope, draft).await.unwrap();
    // Jira holds the new description once it is written; the refresh after the approval reads it.
    *t.fx.tracker.live.lock().unwrap() = Some(item.clone());
    t.fx.tracker.writes_live.store(true, Ordering::SeqCst);
    t.fx.core.watch_set_mode(&t.fx.scope.connection_id, crate::domain::WatchMode::Everything).await.unwrap();
    let before = t.workstream().await.basis.unwrap();
    let done = t.fx.core.approve_proposal(&p.id).await.unwrap();
    assert_eq!(done.state, crate::domain::ProposalState::Applied, "{:?}", done.error);
    let after = t.workstream().await.basis.unwrap();
    assert_eq!(t.fx.core.cache_item(&t.fx.item("CA-1")).await.unwrap().unwrap().body, to);
    assert_ne!(after.description_digest, before.description_digest, "the basis is the ticket as the person changed it");
    t.sweep().await;
    assert!(t.actions().await.iter().all(|(_, a, _)| a != "basis_drifted"));
}

#[tokio::test]
async fn approving_a_comment_or_a_move_takes_back_only_what_it_wrote_and_someone_else_s_change_is_still_noted() {
    let t = setup().await;
    t.sweep().await;
    let before = t.workstream().await.basis.unwrap();
    // Someone else rewrote the description in Jira; then the person approves a comment draft on the ticket, and the
    // refresh after it reads the ticket as Jira has it.
    let mut theirs = t.fx.tracker_item("CA-1");
    theirs.body = Doc::paragraph("Someone rewrote the ticket");
    *t.fx.tracker.live.lock().unwrap() = Some(theirs);
    t.fx.core.watch_set_mode(&t.fx.scope.connection_id, crate::domain::WatchMode::Everything).await.unwrap();
    let draft = crate::proposals::Draft::from_pip("q1", Some(&t.ws), Intent::Comment { item: t.fx.item("CA-1"), body: Doc::paragraph("Noted.") }, None);
    let p = t.fx.core.propose(&t.fx.scope, draft).await.unwrap();
    let done = t.fx.core.approve_proposal(&p.id).await.unwrap();
    assert_eq!(done.state, crate::domain::ProposalState::Applied, "{:?}", done.error);
    assert_eq!(t.fx.core.cache_item(&t.fx.item("CA-1")).await.unwrap().unwrap().body, Doc::paragraph("Someone rewrote the ticket"));
    assert_eq!(t.workstream().await.basis, Some(before.clone()), "a comment changes none of the basis");
    t.sweep().await;
    let actions = t.actions().await;
    assert!(actions.iter().any(|(a, action, d)| *a == Actor::Supervisor && action == "basis_drifted" && d.as_deref().is_some_and(|d| d.contains("description"))), "{actions:?}");
}

// What reaches Pip.

#[tokio::test]
async fn the_wake_prompt_carries_no_ticket_key_and_none_of_the_result() {
    const SENTINEL: &str = "SENTINEL-RESULT-TEXT";
    let t = setup().await;
    let triage = t.run("r1", "triage", RunState::Done, |r| {
        r.result = Some(format!("{SENTINEL} touches CA-77 and ENG-9.\n\nFor Jira:\nIt is CA-78.\n\nPlan recommended: yes"));
        r.summary = Some(format!("{SENTINEL} CA-79"));
        r.result_complete = true;
    })
    .await;
    t.noticed(&triage, Attention::Done).await;
    let review = t.run("r2", "review", RunState::Done, |r| {
        r.result = Some(format!("- [blocking] src/a.rs:4: {SENTINEL} CA-80 breaks\n\nVerdict: blocking"));
        r.result_complete = true;
    })
    .await;
    t.noticed(&review, Attention::Done).await;
    let woken = t.wake_turns().await;
    let lines: Vec<&str> = woken.iter().map(|w| w.prompt.as_str()).collect();
    assert_eq!(lines, ["[Event] run r1 (triage) Done", "[Event] run r2 (review) Done"]);
    for w in &woken {
        assert!(keys_in(&w.prompt).is_empty() && !w.prompt.contains(SENTINEL), "{}", w.prompt);
        let sent = t.fake.prompt_of(&w.request_id).unwrap();
        let event = sent.split("[Workstream").next().unwrap().trim_end().rsplit("\n\n").next().unwrap();
        assert!(event.starts_with("[Event]") && keys_in(event).is_empty() && !event.contains(SENTINEL), "{event}");
        assert!(sent.ends_with(WAKE_REQUEST));
    }
}

// Concurrency with the run service.

#[tokio::test]
async fn notify_under_the_launch_lock_returns_at_once_and_the_wake_follows() {
    use crate::runs::rig::ready_with;
    let sup_slot: Arc<std::sync::OnceLock<Arc<Supervisor>>> = Arc::default();
    struct Late(Arc<std::sync::OnceLock<Arc<Supervisor>>>);
    impl RunNotifier for Late {
        fn notify(&self, run: &Run, why: Attention) {
            if let Some(s) = self.0.get() {
                s.notify(run, why);
            }
        }
    }
    let late: Arc<dyn RunNotifier> = Arc::new(Late(sup_slot.clone()));
    let rig = ready_with(move |svc| svc.with_notifier(Arc::new(FanoutNotifier(vec![late])))).await;
    let fake = Fake::default();
    let svc = service(&rig.fx, &fake).await;
    let sup = supervisor(&rig.fx, &svc, &Arc::default());
    let _ = sup_slot.set(sup.clone());
    let (run, ws) = rig.launched_in_workstream(1).await;
    let conversation = format!("ws:{ws}");
    let woken = |fx: &Fixture| {
        let core = fx.core.clone();
        let conversation = conversation.clone();
        async move { core.pip_turns(&conversation).await.unwrap().into_iter().filter(|w| w.kind == "wake").count() }
    };

    // Called by hand while the launch lock is held: it returns at once, and the work it spawned needs no lock.
    let guard = rig.svc.launching_lock().lock().await;
    let mut done = rig.get(&run).await;
    done.state = RunState::Done;
    rig.fx.core.save_run(&done).await.unwrap();
    // `notify` is synchronous: it may only spawn, so it returns at once rather than waiting for the lock.
    let at = std::time::Instant::now();
    sup.notify(&done, Attention::Done);
    assert!(at.elapsed() < Duration::from_millis(200), "notify never waits");
    drop(guard);
    for _ in 0..300 {
        if woken(&rig.fx).await == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(woken(&rig.fx).await, 1);

    // Through a real poll, which tells the notifier while it holds the lock: the poll finishes, then Pip is woken
    // once for the run that finished again after the person carried on.
    rig.poll().await;
    let short = run.short_id.clone().unwrap();
    rig.job(&short, |j| j.result = Some("Found it.".into()));
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = Some("idle".into());
    });
    tokio::time::timeout(Duration::from_secs(10), rig.poll()).await.expect("the poll isn't held up by the supervisor");
    assert_eq!(rig.get(&run).await.state, RunState::Done);
    sup.sweep_at(Utc::now()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(woken(&rig.fx).await, 1, "the same finish wakes Pip once, from the hand-made notice");
}

// Pausing, and a wake that never started.

struct NotInstalled;

#[async_trait]
impl StandIn for NotInstalled {
    async fn run(&self, _req: AgentRequest) -> crate::error::Result<EventStream> {
        Err(crate::error::Error::Claude("Claude Code isn't installed.".into()))
    }

    fn cancel(&self, _run_id: &str) {}
}

#[tokio::test]
async fn a_wake_that_couldn_t_start_gives_its_facts_back_for_the_next_sweep() {
    let t = setup().await;
    // An agent service whose claude is missing: the wake is queued, then fails to start.
    let server = McpServer::start(t.fx.core.clone(), FakePlanner::unused(), Arc::new(|_| {}), Arc::new(|_, _, _| {})).await.unwrap();
    let svc = Arc::new(AgentService::with_provider(t.fx.core.clone(), server, ClaudeCodeProvider::standing_in(Arc::new(NotInstalled))));
    let sup = supervisor(&t.fx, &svc, &t.emitted);
    let r1 = t.run("r1", "investigate", RunState::Done, |_| {}).await;
    sup.clone().on_run(r1, Attention::Done).await;
    for _ in 0..100 {
        if t.actions().await.iter().any(|(_, a, _)| a == "wake_dropped") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let wake = t.wake_turns().await;
    assert_eq!(wake.len(), 1);
    assert!(wake[0].error.as_deref().is_some_and(|e| e.starts_with(WAKE_NOT_STARTED)), "{:?}", wake[0].error);
    assert_eq!(t.actions().await.iter().filter(|(_, a, _)| a == "wake_dropped").count(), 1, "the fact is taken back");
    assert_eq!(sup.quota_state(&t.ws), Some((true, Duration::from_secs(120))), "and the sweep leaves it be for a while, instead of trying every 30 seconds");
    sup.sweep_at(Utc::now()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(t.wake_turns().await.len(), 1);
}

#[tokio::test]
async fn a_wake_waiting_when_the_workstream_is_paused_never_runs_and_is_woken_for_again_once_resumed() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    t.svc.ask(ask("q1", &t.conversation()), Arc::new(|_| {})).await.unwrap();
    let r0 = t.run("r0", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r0, Attention::Done).await;
    t.until("a wake waiting", |turns| turns.iter().any(|w| w.kind == "wake" && w.status == "queued")).await;
    t.pause().await;
    t.fake.open_all();
    t.idle().await;
    let wake = t.wake_turns().await.into_iter().next().unwrap();
    assert_eq!((wake.status.as_str(), wake.error.as_deref()), ("failed", Some(crate::agent::WAKE_PAUSED)));
    assert!(!t.fake.started().contains(&wake.request_id), "it never started");

    // Resumed, Pip is woken for what it never saw.
    t.resume().await;
    t.sweep().await;
    let woken = t.wake_turns().await;
    assert_eq!(woken.len(), 2);
    assert!(woken[1].prompt.contains("run r0 (investigate) Done") && woken[1].status == "done", "{:?}", woken[1]);
}

#[tokio::test]
async fn a_wake_queued_before_a_pause_lands_never_starts() {
    let t = setup().await;
    t.fake.0.hold.store(true, Ordering::SeqCst);
    t.svc.ask(ask("q1", &t.conversation()), Arc::new(|_| {})).await.unwrap();
    let r0 = t.run("r0", "investigate", RunState::Done, |_| {}).await;
    t.sup.clone().on_run(r0, Attention::Done).await;
    // The pause is written but, as in the gap before `cancel_workstream_turns` runs, nothing has been stopped yet.
    t.pause().await;
    t.fake.open_all();
    t.idle().await;
    let wake = t.wake_turns().await.into_iter().next().unwrap();
    assert_eq!(wake.error.as_deref(), Some(crate::agent::WAKE_PAUSED));
    assert!(!t.fake.started().contains(&wake.request_id));
}

#[tokio::test]
async fn a_question_asked_while_paused_wakes_pip_once_the_workstream_is_resumed() {
    let t = setup().await;
    t.pause().await;
    let asking = t.run("r1", "investigate", RunState::NeedsAnswer, |r| r.ended_at = None).await;
    t.noticed(&asking, Attention::Needs).await;
    assert!(t.wake_turns().await.is_empty());
    t.resume().await;
    t.sweep().await;
    t.sweep().await;
    let woken = t.wake_turns().await;
    assert_eq!(woken.len(), 1);
    assert_eq!(woken[0].prompt, "[Event] run r1 (investigate) Needs an answer");
}

// Launching what waits, beside the run service's own lock.

mod launching {
    use super::*;
    use crate::agent::world::World;
    use crate::runs::service::Timing;

    const FOUND: &str = "I read the cart.\n\nFor Jira:\nThe cart rounds twice.";

    async fn until_ok<F, Fut>(what: &str, mut ok: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        for _ in 0..500 {
            if ok().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("never {what}");
    }

    #[tokio::test]
    async fn launching_what_waits_while_a_poll_runs_starts_each_run_once() {
        let w = World::start().await;
        w.pip.quiet.store(true, Ordering::SeqCst);
        let core = &w.rig.fx.core;
        let mut queued = Vec::new();
        for n in 1..=3 {
            let spec = RunSpec { workstream: Some(w.ws.clone()), ..w.rig.spec(n) };
            queued.push(core.queue_test_run(spec, Some(w.rig.fx.item("CA-1"))).await.unwrap());
        }
        let (svc, other) = (w.rig.svc.clone(), w.rig.svc.clone());
        let raced = async { tokio::join!(svc.launch_waiting(), other.poll(), svc.launch_waiting()) };
        let (a, _, b) = tokio::time::timeout(Duration::from_secs(10), raced).await.expect("no deadlock");
        let mut started = a.unwrap();
        started.extend(b.unwrap());
        started.sort();
        let mut ids: Vec<String> = queued.iter().map(|r| r.id.clone()).collect();
        ids.sort();
        assert_eq!(started, ids, "each started once");
        assert_eq!(w.rig.cli.launches(), 3);
    }

    /// Six approvals at once with room for three, then, all at once: two launches of what waits, a poll, two runs
    /// finishing and an answer settling under the lock. On a real, short clock, as the answer's settle and `git` need.
    #[tokio::test]
    async fn approvals_over_the_cap_wait_and_launch_in_approval_order_never_over_it_and_never_deadlocked() {
        use crate::runs::launcher::RunLauncher;
        let settle = Timing { recover_window: Duration::from_millis(300), worktree_grace: Duration::from_millis(300), poll: Duration::from_millis(10), stop_wait: Duration::from_millis(200), stop_settle: Duration::from_millis(300), rm_wait: Duration::from_millis(5) };
        let w = World::start_with(settle).await;
        w.pip.quiet.store(true, Ordering::SeqCst);
        let svc = w.rig.svc.clone();
        svc.set_settings(AgentSettings { max_runs: 3, ..svc.settings() }).unwrap();
        let core = &w.rig.fx.core;
        // Approved one after another, half in the workstream and half in none.
        let mut approved = Vec::new();
        for n in 1..=6 {
            let spec = RunSpec { workstream: (n % 2 == 0).then(|| w.ws.clone()), ..w.rig.spec(n) };
            approved.push(core.queue_test_run(spec, Some(w.rig.fx.item("CA-1"))).await.unwrap());
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let stop_sampling = Arc::new(AtomicBool::new(false));
        let sampler = {
            let (svc, stop) = (svc.clone(), stop_sampling.clone());
            tokio::spawn(async move {
                let mut most = 0;
                while !stop.load(Ordering::SeqCst) {
                    most = most.max(svc.keep_running());
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                most
            })
        };

        let mut launches = tokio::task::JoinSet::new();
        for run in &approved {
            let (svc, id) = (svc.clone(), run.id.clone());
            launches.spawn(async move { svc.launch(&id).await });
        }
        let results = tokio::time::timeout(Duration::from_secs(20), launches.join_all()).await.expect("no deadlock launching");
        assert!(results.iter().all(Result::is_ok), "a launch over the cap is not an error: {results:?}");
        let mut first = Vec::new();
        let mut waiting = Vec::new();
        for run in &approved {
            let run = w.rig.get(run).await;
            match run.state {
                RunState::Launching => first.push(run),
                RunState::Queued => {
                    assert!(run.slot_wait_since.is_some() && run.error.is_none(), "waiting, not failed");
                    waiting.push(run);
                }
                other => panic!("{} is {}", run.id, other.as_str()),
            }
        }
        assert_eq!((first.len(), waiting.len()), (3, 3));
        assert_eq!(w.rig.cli.launches(), 3);

        // The first three work; one asks a question.
        w.rig.poll().await;
        let asking = first[0].clone();
        w.rig.session(&asking, |e| {
            e.state = Some("blocked".into());
            e.pid = None;
        });
        w.rig.poll().await;
        assert_eq!(w.rig.get(&asking).await.state, RunState::NeedsAnswer);

        // The session of `run` ends with an answer, for the next poll to see.
        let ends = |run: &Run| {
            let run = run.clone();
            let short = run.short_id.clone().expect("launched");
            w.rig.job(&short, |j| j.result = Some("Finished.".into()));
            w.rig.cli.with(|s| {
                s.answers.insert(format!("{short}-0000-4000-8000-000000000000"), FOUND.into());
            });
            w.rig.session(&run, |e| {
                e.state = Some("done".into());
                e.status = Some("idle".into());
                e.pid = None;
            });
        };
        async fn done(w: &World, run: &Run) -> bool {
            w.rig.poll().await;
            w.rig.get(run).await.state == RunState::Done
        }
        ends(&first[1]);
        ends(&first[2]);
        let all_at_once = async {
            tokio::join!(svc.answer(&asking.id, "Yes, go ahead"), w.rig.poll(), svc.launch_waiting(), svc.poll(), svc.launch_waiting(), w.rig.poll())
        };
        let (answered, _, a, _, b, _) = tokio::time::timeout(Duration::from_secs(30), all_at_once).await.expect("no lock deadlock");
        assert_eq!(answered.unwrap().state, RunState::Working);
        a.unwrap();
        b.unwrap();
        until_ok("two finished", || async { done(&w, &first[1]).await && done(&w, &first[2]).await }).await;
        // Two finished, so two of the waiting have their slots once whatever is left over looks again.
        until_ok("two of the waiting launched", || async { svc.launch_waiting().await.unwrap(); w.rig.cli.launches() == 5 }).await;
        assert_eq!(w.rig.get(&waiting[2]).await.state, RunState::Queued, "the answered run kept its slot");
        ends(&w.rig.get(&asking).await);
        until_ok("the answered one finished", || done(&w, &asking)).await;
        until_ok("the last one launched", || async { svc.launch_waiting().await.unwrap(); w.rig.cli.launches() == 6 }).await;
        for _ in 0..3 {
            svc.launch_waiting().await.unwrap();
            w.rig.poll().await;
        }
        stop_sampling.store(true, Ordering::SeqCst);
        assert!(sampler.await.unwrap() <= 3, "never more than the cap live");

        let names: Vec<String> = w.rig.cli.0.lock().unwrap().launches.iter().map(|l| l.worktree.clone()).collect();
        assert_eq!(names.len(), 6, "{names:?}");
        let mut distinct = names.clone();
        distinct.sort();
        distinct.dedup();
        assert_eq!(distinct.len(), 6, "each approved run launched exactly once: {names:?}");
        let position = |run: &Run| names.iter().position(|n| *n == run.spec.name).unwrap();
        let order: Vec<usize> = waiting.iter().map(position).collect();
        assert!(waiting.windows(2).all(|p| (p[0].queued_at, &p[0].id) < (p[1].queued_at, &p[1].id)), "listed in approval order");
        assert!(order.windows(2).all(|p| p[0] < p[1]), "the waiting launched in approval order: {order:?}");
        assert!(order[0] > 2, "after the first three");
        for run in &waiting {
            assert_eq!(w.rig.get(run).await.slot_wait_since, None);
        }
    }
}
