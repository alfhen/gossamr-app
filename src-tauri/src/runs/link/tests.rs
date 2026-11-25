//! The link against a harness served in this process from a temp data folder, on the mock provider. No harness
//! process is started, so none can be left behind; each test's server is stopped through its own `shutdown`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use harness::api::Op;
use harness::auth::Token;
use harness::client::Client;
use harness::event::{Decision, Event};
use serde_json::{json, Value};

use super::*;
use super::served::{Direct, Served, WAIT};
use crate::domain::{RunState, SessionFollow};
use crate::runs::consumer;
use crate::runs::rig::{ready, Rig};
use crate::runs::tracker::Attention;

/// Answers `read_ticket` and records what it was asked.
#[derive(Default)]
struct Tickets(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl ClientTools for Tickets {
    async fn call(&self, run: &Run, name: &str, input: &Value) -> (Value, bool) {
        self.0.lock().unwrap().push((run.id.clone(), input.clone()));
        match name {
            "read_ticket" => (json!({ "key": input["key"], "text": "Fix the login page" }), false),
            _ => (json!("no such tool"), true),
        }
    }
}

fn link(rig: &Rig, direct: &Arc<Direct>, tickets: &Arc<Tickets>) -> Link {
    link_with(rig, direct, tickets.clone())
}

fn link_with(rig: &Rig, direct: &Arc<Direct>, tools: Arc<dyn ClientTools>) -> Link {
    let changed: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});
    Link::start(rig.fx.core.clone(), direct.clone(), tools, rig.notices.clone(), changed)
}

/// Never answers, as an app that quits while it reads.
struct Hangs;

#[async_trait]
impl ClientTools for Hangs {
    async fn call(&self, _run: &Run, _name: &str, _input: &Value) -> (Value, bool) {
        std::future::pending().await
    }
}

struct Bed {
    rig: Rig,
    served: Served,
    direct: Arc<Direct>,
    link: Link,
    tickets: Arc<Tickets>,
}

impl Bed {
    async fn new(script: &str) -> Bed {
        let served = Served::new(script, 4);
        let rig = ready().await;
        let direct = Arc::new(Direct { dir: served.dir.clone(), token: served.token.clone() });
        let tickets = Arc::new(Tickets::default());
        let link = link(&rig, &direct, &tickets);
        Bed { rig, served, direct, link, tickets }
    }

    /// The app again, as after it quit and started: a new link, which follows what the old one had applied.
    fn relink(&mut self) {
        self.link = link(&self.rig, &self.direct, &self.tickets);
    }

    /// A queued run of the account, opened as a mock session with the `read_ticket` tool, and sent its brief.
    async fn started(&self) -> (Run, String) {
        let run = self.rig.queued(1).await;
        let run = self.rig.set(&run, |r| r.state = RunState::Launching).await;
        let cwd = self.served._tmp.path().to_path_buf();
        let tools = vec![harness::tools::ToolSpec { name: "read_ticket".into(), description: String::new(), input_schema: json!({ "type": "object" }) }];
        let open = Op::Open { provider: "mock".into(), cwd: Some(cwd), repo: None, base: None, branch: None, locked: false, model: None, login: None, effort: None, ends_with_client: false, tools, result_schema: None };
        let session = self.link.open(&run.id, open).await.unwrap();
        self.link.call(Op::Send { session: session.clone(), text: "the brief".into() }).await.unwrap();
        (run, session)
    }

    /// Waits until the run satisfies `done`, as the link applies events: a handshake on what it applied, never a sleep.
    async fn until(&self, run: &Run, done: impl Fn(&Run, &SessionFollow) -> bool) -> (Run, SessionFollow) {
        let mut applied = self.link.applied();
        let looked = tokio::time::timeout(WAIT, async {
            loop {
                let now = self.rig.get(run).await;
                let session = now.harness_session.clone().unwrap();
                let (_, follow) = self.rig.fx.core.session_run(&session).await.unwrap().unwrap();
                if done(&now, &follow) {
                    return (now, follow);
                }
                applied.changed().await.unwrap();
            }
        });
        match looked.await {
            Ok(seen) => seen,
            Err(_) => panic!("the run did not get there; it is {:?}", self.rig.get(run).await.state),
        }
    }

    /// The run as the harness's whole stored record of the session makes it, read from the first event.
    async fn replayed(&self, run: &Run, session: &str) -> (Run, SessionFollow, usize) {
        let mut client = self.served.client().await;
        let mut events: Vec<Event> = Vec::new();
        client.events(session, 0, |event| events.push(event)).await.unwrap();
        let (mut fresh, mut follow) = (self.rig.get(run).await, SessionFollow::default());
        fresh.state = RunState::Launching;
        let mut rows = 0;
        for event in &events {
            rows += consumer::fold(&mut fresh, &mut follow, event, chrono::Utc::now()).len();
        }
        (fresh, follow, rows)
    }

    async fn rows(&self, run: &Run) -> Vec<(String, String)> {
        self.rig.fx.core.run_events(&run.id).await.unwrap().into_iter().map(|e| (e.kind, e.text)).collect()
    }

    async fn end(mut self) {
        self.served.shut_down().await;
    }
}

const STREAM: &str = r#"{"prompt": null}
{"say": "Looking at the cart."}
{"tool": {"name": "Bash", "input": {"command": "cargo test"}}}
{"tool_result": {"output": "ok"}}
{"say": "All green."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_run_follows_its_session_from_its_first_event_to_done() {
    let bed = Bed::new(STREAM).await;
    let (run, _) = bed.started().await;
    let (done, follow) = bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert_eq!((follow.turns, follow.prompts, follow.in_turn), (1, 1, false));
    assert_eq!(done.last_detail.as_deref(), Some("All green."));
    let rows = bed.rows(&run).await;
    assert!(rows.contains(&("run".into(), "Bash: cargo test".into())), "{rows:?}");
    assert!(rows.contains(&("done".into(), "Finished its turn".into())), "{rows:?}");
    assert!(bed.rig.noticed().contains(&(Attention::Done, RunState::Done)), "the notifier, and so Pip, hears it finished");
    bed.end().await;
}

const ASKS: &str = r#"{"capabilities": {"tool_call_limit_ms": 600000}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour should the button be?"}}}
{"say": "Blue it is."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_question_waits_on_the_person_and_its_answer_reaches_the_agent() {
    let bed = Bed::new(ASKS).await;
    let (run, session) = bed.started().await;
    let (asking, follow) = bed.until(&run, |r, _| r.state == RunState::NeedsAnswer).await;
    assert_eq!(asking.needs.as_deref(), Some("Which colour should the button be?"));
    assert!(bed.rig.noticed().contains(&(Attention::Needs, RunState::NeedsAnswer)));
    let question = follow.question.unwrap();
    bed.link.call(Op::AnswerQuestion { session, question, text: "Blue".into() }).await.unwrap();
    let (done, follow) = bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert_eq!((done.needs, follow.question), (None, None));
    bed.end().await;
}

const PERMISSION: &str = r#"{"prompt": null}
{"permission": {"kind": "command", "tool": "Bash", "input": {"command": "rm -rf build"}}}
{"say": "Removed it."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_permission_request_waits_and_its_answer_reaches_the_agent() {
    let bed = Bed::new(PERMISSION).await;
    let (run, session) = bed.started().await;
    let (_, follow) = bed.until(&run, |r, _| r.state == RunState::NeedsPermission).await;
    let (request, cut, _) = follow.permissions[0].clone();
    assert!(!cut);
    bed.link.call(Op::Answer { session, request, decision: Decision::Allow, message: None }).await.unwrap();
    bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert!(bed.rows(&run).await.contains(&("update".into(), "You allowed it".into())));
    bed.end().await;
}

// The ask returns "question pending" before the permission request, so the deny that ends the turn holds no call.
const ASKS_THEN_DENIED: &str = r#"{"capabilities": {"tool_call_limit_ms": 400, "deny_ends_turn": true}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour should the button be?"}}}
{"permission": {"kind": "command", "tool": "Bash", "input": {"command": "rm -rf build"}}}
{"say": "Removed it."}
{"end": "done"}
{"prompt": null}
{"say": "Blue it is."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_deny_leaves_a_question_whose_call_returned_open_and_its_answer_comes_as_the_next_prompt() {
    let bed = Bed::new(ASKS_THEN_DENIED).await;
    let (run, session) = bed.started().await;
    let (_, follow) = bed.until(&run, |_, f| f.question.is_some() && !f.permissions.is_empty()).await;
    let (request, question) = (follow.permissions[0].0.clone(), follow.question.unwrap());
    bed.link.call(Op::Answer { session: session.clone(), request, decision: Decision::Deny, message: None }).await.unwrap();
    let (denied, follow) = bed.until(&run, |_, f| f.turns == 1).await;
    assert_eq!((denied.state, denied.needs.as_deref()), (RunState::NeedsAnswer, Some("Which colour should the button be?")));
    assert_eq!(follow.question.as_deref(), Some(question.as_str()), "the deny closed no question");
    bed.link.call(Op::AnswerQuestion { session, question, text: "Blue".into() }).await.unwrap();
    let (done, follow) = bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert_eq!((done.needs, follow.question, done.last_detail.as_deref()), (None, None, Some("Blue it is.")));
    bed.end().await;
}

const LONG: &str = r#"{"prompt": null}
{"say": "Starting a long build."}
{"sleep": 600000}
{"say": "Built."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_stopped_run_reads_stopped_only_once_the_harness_closed_it() {
    let bed = Bed::new(LONG).await;
    let (run, session) = bed.started().await;
    bed.until(&run, |r, _| r.last_detail.as_deref() == Some("Starting a long build.")).await;
    bed.link.stop(&session).await.unwrap();
    let asked = bed.rig.get(&run).await;
    let (_, follow) = bed.rig.fx.core.session_run(&session).await.unwrap().unwrap();
    assert!(asked.state != RunState::Stopped || follow.closed, "stopped only once the harness said it closed");
    let (stopped, _) = bed.until(&run, |_, f| f.closed).await;
    assert_eq!(stopped.state, RunState::Stopped);
    assert!(bed.rig.fx.core.followed_sessions().await.unwrap().is_empty(), "a session the app stopped is followed no more");
    assert!(bed.link.stop(&session).await.is_err(), "a closed session takes no second stop");
    let (_, follow) = bed.rig.fx.core.session_run(&session).await.unwrap().unwrap();
    assert!(!follow.stop_asked, "and a stop the harness refused is not one it will read later");
    bed.end().await;
}

#[tokio::test]
async fn a_harness_shutdown_while_the_agent_asks_keeps_the_question_and_the_session_followed_and_wakes_no_one() {
    let mut bed = Bed::new(ASKS).await;
    let (run, session) = bed.started().await;
    bed.until(&run, |r, _| r.state == RunState::NeedsAnswer).await;
    bed.served.shut_down().await;
    bed.served.serve(ASKS, 4);
    let (after, follow) = bed.until(&run, |_, f| f.closed).await;
    assert_eq!((after.state, after.needs.as_deref()), (RunState::NeedsAnswer, Some("Which colour should the button be?")));
    assert!(follow.question.is_some() && !follow.ended);
    assert!(!bed.rig.noticed().iter().any(|(why, _)| *why == Attention::Failed), "Pip hears of no failure");
    assert!(bed.rig.fx.core.followed_sessions().await.unwrap().iter().any(|(s, _)| *s == session), "a resume takes it up again");
    bed.end().await;
}

#[tokio::test]
async fn a_harness_restart_in_the_middle_of_a_turn_loses_nothing_and_repeats_nothing() {
    let mut bed = Bed::new(LONG).await;
    let (run, session) = bed.started().await;
    bed.until(&run, |r, _| r.last_detail.as_deref() == Some("Starting a long build.")).await;
    // The app is gone while the harness stops and starts again, so what the stop records is read only after both.
    let dropped = std::mem::replace(&mut bed.link, link(&bed.rig, &Arc::new(Direct { dir: PathBuf::from("/nowhere"), token: Token::random() }), &bed.tickets));
    drop(dropped);
    bed.served.shut_down().await;
    bed.served.serve(LONG, 4);
    let mut client = bed.served.client().await;
    let listed = client.call(Op::Sessions).await.unwrap();
    let last = listed.as_array().unwrap().iter().find(|s| s["id"] == session.as_str()).unwrap()["last_seq"].as_u64().unwrap();
    let before = bed.rig.fx.core.session_run(&session).await.unwrap().unwrap().1.seq;
    assert!(before < last, "the stop's events are still to be read ({before} of {last})");
    bed.relink();
    let (after, follow) = bed.until(&run, |_, f| f.seq == last).await;
    let (replayed, from_start, rows) = bed.replayed(&run, &session).await;
    assert_eq!((after.state, follow.clone()), (replayed.state, from_start), "caught up as if it had read every event once");
    assert_eq!(bed.rows(&run).await.len(), rows, "no row twice, none missing");
    assert_eq!((after.state, after.last_detail.as_deref(), after.error.as_deref()), (RunState::Stopped, Some(consumer::CUT), None), "a shutdown's cut fails nothing");
    assert!(!bed.rig.noticed().iter().any(|(why, _)| *why == Attention::Failed));
    bed.end().await;
}

const READS: &str = r#"{"prompt": null}
{"call": {"name": "read_ticket", "input": {"key": "CA-1"}}}
{"say": "Read it."}
{"end": "done"}
{"prompt": null}"#;

#[tokio::test]
async fn a_client_tool_call_is_answered_for_its_run() {
    let bed = Bed::new(READS).await;
    let (run, _) = bed.started().await;
    bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert_eq!(bed.tickets.0.lock().unwrap().clone(), vec![(run.id.clone(), json!({ "key": "CA-1" }))]);
    assert!(!bed.rows(&run).await.iter().any(|(kind, _)| kind == "error"), "the call got its answer, not a failure");
    bed.end().await;
}

fn drop_events_after(dir: &Path, session: &str, seq: u64) {
    let conn = rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap();
    conn.busy_timeout(Duration::from_secs(5)).unwrap();
    conn.execute("DELETE FROM events WHERE session = ?1 AND seq > ?2", rusqlite::params![session, seq as i64]).unwrap();
}

const THREE_TURNS: &str = r#"{"prompt": null}
{"say": "One."}
{"end": "done"}
{"prompt": null}
{"say": "Two."}
{"end": "done"}
{"prompt": null}
{"say": "Three."}
{"end": "done"}
{"prompt": null}"#;

/// Sends a prompt on a client of the test's and waits on it for the turn's end.
async fn turn_away(client: &mut Client, session: &str, text: &str) {
    client.call(Op::Send { session: session.to_owned(), text: text.into() }).await.unwrap();
    loop {
        if let Some(harness::client::Push::Event { event, .. }) = tokio::time::timeout(WAIT, client.push()).await.unwrap().unwrap() {
            if event.body.ends_turn() {
                return;
            }
        }
    }
}

fn lost_rows(rows: &[(String, String)]) -> Vec<String> {
    rows.iter().filter(|(_, text)| text.starts_with(consumer::LOST)).map(|(_, text)| text.clone()).collect()
}

#[tokio::test]
async fn events_the_harness_lost_are_named_once_each_time_and_the_run_reads_on_without_asking_again() {
    let mut bed = Bed::new(THREE_TURNS).await;
    // The first turn plays out before the app follows the session, and its record is then cut short.
    let mut client = bed.served.client().await;
    let cwd = bed.served._tmp.path().to_path_buf();
    let open = Op::Open { provider: "mock".into(), cwd: Some(cwd), repo: None, base: None, branch: None, locked: false, model: None, login: None, effort: None, ends_with_client: false, tools: vec![], result_schema: None };
    let session = client.call(open).await.unwrap()["session"].as_str().unwrap().to_owned();
    turn_away(&mut client, &session, "the brief").await;
    let first_end = bed.served.client().await.call(Op::Sessions).await.unwrap().as_array().unwrap().iter().find(|s| s["id"] == session.as_str()).unwrap()["last_seq"].as_u64().unwrap();
    drop_events_after(&bed.served.dir, &session, 1);
    let run = bed.rig.queued(1).await;
    bed.rig.fx.core.bind_run_session(&run.id, &session).await.unwrap();
    bed.link.follow(&session, 0).await.unwrap();
    let (_, follow) = bed.until(&run, |_, f| f.lost == 1).await;
    assert_eq!(follow.seq, first_end, "it reads on past what was lost");
    assert_eq!(lost_rows(&bed.rows(&run).await), [format!("{}: events 2 to {first_end} were skipped", consumer::LOST)]);

    // The second turn plays while the app is away, and the harness loses its record past the turn's first event.
    let dropped = std::mem::replace(&mut bed.link, link(&bed.rig, &Arc::new(Direct { dir: PathBuf::from("/nowhere"), token: Token::random() }), &bed.tickets));
    drop(dropped);
    turn_away(&mut client, &session, "again").await;
    let second_end = bed.served.client().await.call(Op::Sessions).await.unwrap().as_array().unwrap().iter().find(|s| s["id"] == session.as_str()).unwrap()["last_seq"].as_u64().unwrap();
    drop_events_after(&bed.served.dir, &session, first_end + 1);
    bed.relink();
    let (_, follow) = bed.until(&run, |_, f| f.lost == 2).await;
    assert_eq!(follow.seq, second_end);
    assert_eq!(
        lost_rows(&bed.rows(&run).await),
        [format!("{}: events 2 to {first_end} were skipped", consumer::LOST), format!("{}: events {} to {second_end} were skipped", consumer::LOST, first_end + 2)],
        "each loss once, with what it skipped"
    );

    // It still follows the session: the next turn's events arrive.
    bed.link.call(Op::Send { session: session.clone(), text: "and again".into() }).await.unwrap();
    let (done, follow) = bed.until(&run, |r, _| r.state == RunState::Done && r.last_detail.as_deref() == Some("Three.")).await;
    assert_eq!((follow.lost, done.state), (2, RunState::Done));
    bed.end().await;
}

#[tokio::test]
async fn an_event_the_app_could_not_store_is_read_again_and_nothing_after_it_is_applied_first() {
    let bed = Bed::new(STREAM).await;
    let app = rusqlite::Connection::open(bed.rig.fx.dir.join("app.sqlite")).unwrap();
    app.busy_timeout(Duration::from_secs(5)).unwrap();
    // Every timeline row fails while the trigger is there, so no event with a row can be stored.
    app.execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
    let (run, session) = bed.started().await;
    let mut client = bed.served.client().await;
    let mut seen = 0;
    client.events(&session, 0, |_| seen += 1).await.unwrap();
    assert!(seen > 0);
    let stuck = bed.rig.fx.core.session_run(&session).await.unwrap().unwrap().1.seq;
    app.execute_batch("DROP TRIGGER refuse;").unwrap();
    bed.until(&run, |r, _| r.state == RunState::Done).await;
    let (replayed, from_start, rows) = bed.replayed(&run, &session).await;
    let (now, follow) = (bed.rig.get(&run).await, bed.rig.fx.core.session_run(&session).await.unwrap().unwrap().1);
    assert!(stuck < follow.seq);
    assert_eq!((now.state, follow), (replayed.state, from_start));
    assert_eq!(bed.rows(&run).await.len(), rows, "the refused event's rows are there, once");
    bed.end().await;
}

#[tokio::test]
async fn a_call_of_the_apps_tools_a_quit_left_unanswered_is_answered_on_the_next_start() {
    let mut bed = Bed::new(READS).await;
    bed.link = link_with(&bed.rig, &bed.direct, Arc::new(Hangs));
    let (run, _) = bed.started().await;
    bed.until(&run, |_, f| !f.calls.is_empty()).await;
    bed.relink();
    let (done, follow) = bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert!(follow.calls.is_empty(), "{:?}", done.last_detail);
    assert_eq!(bed.tickets.0.lock().unwrap().len(), 1, "answered once, by the app that started again");
    bed.end().await;
}

#[tokio::test]
async fn a_tool_call_read_again_is_not_answered_twice() {
    let bed = Bed::new(READS).await;
    let (run, session) = bed.started().await;
    bed.until(&run, |r, _| r.state == RunState::Done).await;
    assert_eq!(bed.tickets.0.lock().unwrap().len(), 1);
    let mut client = bed.served.client().await;
    let events: Vec<Event> = serde_json::from_value(client.call(Op::Events { session: session.clone(), after: 0 }).await.unwrap()["events"].clone()).unwrap();
    let call = events.into_iter().find(|e| matches!(e.body, harness::event::Body::ClientToolCall { .. })).unwrap();
    bed.link.inner.take(&session, call).await.unwrap();
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert_eq!(bed.tickets.0.lock().unwrap().len(), 1, "applied once, answered once");
    bed.end().await;
}

#[tokio::test]
async fn the_same_loss_at_one_place_is_asked_about_once() {
    let bed = Bed::new(STREAM).await;
    let (run, session) = bed.started().await;
    bed.until(&run, |r, _| r.state == RunState::Done).await;
    let mut client = bed.served.client().await;
    let mut lost_at = LostAt::new();
    for _ in 0..4 {
        bed.link.inner.lost(&mut client, &session, "events were lost: test", &mut lost_at).await.unwrap();
    }
    let losses = bed.rows(&run).await.iter().filter(|(_, text)| text.starts_with(consumer::LOST)).count();
    assert_eq!(losses, 1, "a loss at the same place again is not asked about again");
    bed.end().await;
}

/// Answers once it is let go, counting the calls it took.
#[derive(Default)]
struct Slow {
    calls: Mutex<u32>,
    go: tokio::sync::Notify,
}

#[async_trait]
impl ClientTools for Slow {
    async fn call(&self, _run: &Run, _name: &str, input: &Value) -> (Value, bool) {
        *self.calls.lock().unwrap() += 1;
        self.go.notified().await;
        (json!({ "key": input["key"], "text": "Fix the login page" }), false)
    }
}

#[tokio::test]
async fn a_call_whose_answer_is_on_its_way_is_not_answered_again_on_a_reconnect() {
    let mut bed = Bed::new(READS).await;
    let slow = Arc::new(Slow::default());
    bed.link = link_with(&bed.rig, &bed.direct, slow.clone());
    let (run, _) = bed.started().await;
    bed.until(&run, |_, f| !f.calls.is_empty()).await;
    let mut client = bed.served.client().await;
    follow_all(&bed.link.inner, &mut client).await.unwrap();
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert_eq!(*slow.calls.lock().unwrap(), 1, "the call in flight was not taken again");
    slow.go.notify_one();
    bed.until(&run, |r, _| r.state == RunState::Done).await;
    bed.end().await;
}
