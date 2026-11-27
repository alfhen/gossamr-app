mod common;

use std::sync::Arc;

use common::*;
use harness::driver::{Capabilities, Command, Driver, Launch, Link, OpenError};
use harness::error::Error;
use harness::event::{Body, Decision, Event};
use harness::session::{Harness, Open};
use harness::store::Store;
use tokio::sync::{broadcast, mpsc};

fn provider_session(started: &Body) -> String {
    match started {
        Body::Started { provider_session, .. } => provider_session.clone(),
        other => panic!("expected started, got {other:?}"),
    }
}

/// Turns that each end, then an ask and a permission request, each in a turn of its own.
const TURNS: &str = r#"{"prompt": null}
{"say": "one"}
{"end": "done"}
{"prompt": null}
{"say": "two"}
{"end": "done"}
{"prompt": null}
{"say": "three"}
{"end": "done"}
{"prompt": null}"#;

async fn closed(harness: &Harness, id: &str, events: &mut broadcast::Receiver<Event>) {
    harness.close(id).unwrap();
    until(events, |body| matches!(*body, Body::Closed { .. })).await;
}

async fn turn(harness: &Harness, id: &str, events: &mut broadcast::Receiver<Event>, text: &str) {
    harness.send(id, text).unwrap();
    until(events, |body| matches!(body, Body::TurnEnded { .. })).await;
}

#[tokio::test]
async fn resume_each_state_that_cannot_be_resumed_gives_its_own_reason_and_starts_no_agent() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let mut refused = vec![];
    for state in ["cleaned", "ends with its client", "cannot resume", "handed over"] {
        let spec = Open { provider: "mock".into(), cwd: "/nowhere".into(), ends_with_client: state == "ends with its client", ..Open::default() };
        let (id, mut events) = harness.open(spec).await.unwrap();
        let ps = provider_session(&next(&mut events).await.body);
        match state {
            "handed over" => {
                harness.hand_over(&id).unwrap();
                until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
            }
            _ => closed(&harness, &id, &mut events).await,
        }
        match state {
            "cleaned" => harness.clean_up(&id).await.unwrap(),
            "cannot resume" => {
                rusqlite::Connection::open(dir.join("harness.sqlite")).unwrap().execute("UPDATE sessions SET cannot_resume = 1 WHERE id = ?1", [&id]).unwrap();
            }
            _ => {}
        }
        let error = match harness.resume_with(&id, None).await {
            Err(e) => e.to_string(),
            Ok(_) => panic!("{state}: resumed"),
        };
        assert_eq!(mock.tokens(&ps).len(), 1, "{state}: no agent started");
        refused.push(error);
    }
    let reasons: std::collections::HashSet<&String> = refused.iter().collect();
    assert_eq!(reasons.len(), refused.len(), "each its own reason: {refused:?}");
}

/// A driver whose agent never goes, so a shutdown gives up on it.
struct Stuck;

impl Driver for Stuck {
    fn capabilities(&self) -> Capabilities {
        Capabilities { stop_takes_up_to_ms: Some(50), ..Capabilities::default() }
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        let (commands, mut received) = mpsc::unbounded_channel();
        let (output, receiver) = mpsc::unbounded_channel();
        output.send(Body::Started { provider_session: "stuck".into(), resumed: false }).unwrap();
        tokio::spawn(async move {
            let _output = output;
            while received.recv().await.is_some() {}
            std::future::pending::<()>().await;
        });
        Ok(Link { commands, output: receiver, process: None })
    }
}

#[tokio::test]
async fn resume_and_clean_up_of_a_session_a_shutdown_gave_up_on_are_refused() {
    let (_tmp, dir) = data_dir();
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("stuck".into(), Arc::new(Stuck))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    let (id, mut events) = harness.open(Open { provider: "stuck".into(), cwd: "/nowhere".into(), ..Open::default() }).await.unwrap();
    next(&mut events).await;
    assert_eq!(harness.shutdown().await, std::slice::from_ref(&id), "the shutdown gave up on it");
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("stuck".into(), Arc::new(Stuck))];
    let harness = Harness::new(Store::open(&dir).unwrap(), drivers, settings(4));
    match harness.resume_with(&id, None).await {
        Err(Error::Refused(why)) => assert!(why.contains("a shutdown stopped waiting for it") && why.contains("may still run"), "{why}"),
        other => panic!("resumed: {:?}", other.is_ok()),
    }
    // Its agent may still work in the worktree.
    match harness.clean_up(&id).await {
        Err(Error::Refused(why)) => assert!(why.contains("a shutdown stopped waiting for it") && why.contains("never cleaned up"), "{why}"),
        other => panic!("cleaned up: {:?}", other.is_ok()),
    }
}

#[tokio::test]
async fn resume_gets_a_fresh_tools_token_and_carry_on_is_the_next_prompt() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let ps = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        let ps = provider_session(&next(&mut events).await.body);
        turn(&harness, &id, &mut events, "first").await;
        assert!(harness.shutdown().await.is_empty());
        (id, ps)
    };
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    let mut events = harness.resume_with(&ps.0, Some("carry on".into())).await.unwrap();
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let tokens = mock.tokens(&ps.1);
    assert_eq!(tokens.len(), 2);
    assert_ne!(tokens[0], tokens[1], "a fresh token");
    assert_eq!(mock.received(&ps.1).last(), Some(&Command::Prompt("carry on".into())));
}

#[tokio::test]
async fn carry_on_is_refused_after_a_stop_a_deny_ended_turn_an_open_request_or_question_and_sends_nothing() {
    let cases = [
        ("it was stopped", TURNS.to_owned()),
        ("a deny ended its last turn", "{\"capabilities\": {\"deny_ends_turn\": true}}\n{\"prompt\": null}\n{\"permission\": {\"kind\": \"command\", \"tool\": \"Bash\"}}\n{\"end\": \"done\"}\n{\"prompt\": null}".to_owned()),
        ("a permission request was open", "{\"prompt\": null}\n{\"permission\": {\"kind\": \"command\", \"tool\": \"Bash\"}}\n{\"end\": \"done\"}\n{\"prompt\": null}".to_owned()),
        ("is open, and its answer is the next prompt", "{\"prompt\": null}\n{\"call\": {\"name\": \"ask\", \"input\": {\"question\": \"Which?\"}}}\n{\"end\": \"done\"}\n{\"prompt\": null}".to_owned()),
        ("its last turn was cancelled", "{\"prompt\": null}\n{\"permission\": {\"kind\": \"command\", \"tool\": \"Bash\"}}\n{\"end\": \"done\"}\n{\"prompt\": null}".to_owned()),
    ];
    for (why, script) in cases {
        let (_tmp, dir) = data_dir();
        let mock = mock(&script);
        let (id, ps) = {
            let harness = harness(&dir, &mock, 4);
            let (id, mut events) = open(&harness, false).await;
            let ps = provider_session(&next(&mut events).await.body);
            harness.send(&id, "go").unwrap();
            match why {
                "it was stopped" => {
                    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
                    closed(&harness, &id, &mut events).await;
                }
                "a deny ended its last turn" => {
                    let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await.pop().unwrap();
                    let Body::Permission { id: request, .. } = asked.body else { unreachable!() };
                    harness.answer(&id, &request, Decision::Deny, None).unwrap();
                    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
                    assert!(harness.shutdown().await.is_empty());
                }
                "a permission request was open" => {
                    until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
                    assert!(harness.shutdown().await.is_empty());
                }
                "its last turn was cancelled" => {
                    until(&mut events, |body| matches!(body, Body::Permission { .. })).await;
                    harness.cancel(&id).unwrap();
                    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
                    assert!(harness.shutdown().await.is_empty());
                }
                _ => {
                    until(&mut events, |body| matches!(body, Body::Question { .. })).await;
                    assert!(harness.shutdown().await.is_empty());
                }
            }
            (id, ps)
        };
        let harness = harness_on(reopen(&dir).await, &mock, 4);
        let starts = mock.tokens(&ps).len();
        match harness.resume_with(&id, Some("carry on".into())).await {
            Err(Error::Refused(said)) => assert!(said.contains(why), "{why}: {said}"),
            other => panic!("{why}: not refused: {:?}", other.is_ok()),
        }
        assert_eq!(mock.tokens(&ps).len(), starts, "{why}: no agent started");
        assert!(!mock.received(&ps).contains(&Command::Prompt("carry on".into())), "{why}: nothing sent");
    }
}

#[tokio::test]
async fn carry_on_is_refused_after_a_restart_when_the_answer_was_still_waiting_at_the_shutdown() {
    let (_tmp, dir) = data_dir();
    let mock = mock(r#"{"capabilities": {"tool_call_limit_ms": 400}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which?"}}}
{"sleep": 5000}
{"end": "done"}
{"prompt": null}"#);
    let (id, ps, question) = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        let ps = provider_session(&next(&mut events).await.body);
        harness.send(&id, "go").unwrap();
        let asked = until(&mut events, |body| matches!(body, Body::Question { .. })).await.pop().unwrap();
        let Body::Question { id: question, .. } = asked.body else { unreachable!() };
        until(&mut events, |body| matches!(body, Body::ToolResult { .. })).await;
        // Queued behind the running turn: not delivered, so the question stays open.
        harness.answer_question(&id, &question, "blue".into()).await.unwrap();
        assert!(harness.shutdown().await.is_empty());
        (id, ps, question)
    };
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    let starts = mock.tokens(&ps).len();
    match harness.resume_with(&id, Some("carry on".into())).await {
        Err(Error::Refused(said)) => assert!(said.contains(&format!("question {question} is open")), "{said}"),
        other => panic!("not refused: {:?}", other.is_ok()),
    }
    assert_eq!(mock.tokens(&ps).len(), starts, "no agent started");
    assert!(!mock.received(&ps).contains(&Command::Prompt("carry on".into())));
}

#[tokio::test]
async fn carry_on_a_turn_after_the_stop_lifts_its_mark() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    turn(&harness, &id, &mut events, "first").await;
    closed(&harness, &id, &mut events).await;
    assert!(harness.resume_with(&id, Some("carry on".into())).await.is_err(), "not after a stop");
    let mut events = harness.resume_with(&id, None).await.unwrap();
    turn(&harness, &id, &mut events, "the person's own").await;
    drop(harness.shutdown().await);
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    assert!(harness.resume_with(&id, Some("carry on".into())).await.is_ok(), "a later turn lifted it");
}

#[tokio::test]
async fn after_a_shutdown_with_a_reason_carry_on_is_refused_for_it_a_resume_works_and_its_turn_lifts_the_mark() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let id = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        next(&mut events).await;
        assert!(harness.shutdown_with(Some("you stopped every agent")).await.is_empty());
        id
    };
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    match harness.resume_with(&id, Some("carry on".into())).await {
        Err(Error::Refused(said)) => assert!(said.ends_with("may not carry on: you stopped every agent"), "{said}"),
        other => panic!("not refused: {:?}", other.is_ok()),
    }
    let mut events = harness.resume_with(&id, None).await.expect("a message still resumes it");
    turn(&harness, &id, &mut events, "the person's own").await;
    assert!(harness.shutdown().await.is_empty());
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    assert!(harness.resume_with(&id, Some("carry on".into())).await.is_ok(), "its turn lifted the mark, and a plain shutdown sets none");
}

#[tokio::test]
async fn a_shutdown_with_a_reason_marks_a_session_already_on_its_way_out_too() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let id = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        next(&mut events).await;
        // Its stop is taken, so it takes no shutdown request; nothing has run it yet on this one thread.
        harness.hand_over(&id).unwrap();
        assert!(harness.shutdown_with(Some("you stopped every agent")).await.is_empty());
        id
    };
    assert_eq!(reopen(&dir).await.session(&id).unwrap().no_carry_on.as_deref(), Some("you stopped every agent"));
}

#[tokio::test]
async fn take_back_then_resume_works_and_resume_without_it_is_refused() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.hand_over(&id).unwrap();
    until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
    assert!(matches!(harness.resume_with(&id, None).await, Err(Error::HandedOver(_))));
    let mut events = harness.take_back(&id).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    drop(harness.shutdown().await);
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    let mut events = harness.resume_with(&id, None).await.unwrap();
    assert!(matches!(next(&mut events).await.body, Body::Started { resumed: true, .. }));
}

#[tokio::test]
async fn resume_over_the_api_takes_back_resumes_and_refuses_with_the_reason() {
    use harness::api::Op;
    let (_tmp, dir) = data_dir();
    let (token, mock) = (harness::auth::Token::random(), mock(TURNS));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    let first = token.clone();
    let server = harness::server::Server::bind(&dir, move || Some(first), drivers, settings(4)).unwrap();
    let served = server.harness().clone();
    let task = tokio::spawn(server.run());
    let mut client = harness::client::Client::connect(&dir, &token).await.unwrap();
    let (id, mut events) = open(&served, false).await;
    next(&mut events).await;
    served.hand_over(&id).unwrap();
    until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
    let refused = client.call(Op::Resume { session: id.clone(), carry_on: None }).await.unwrap_err().to_string();
    assert!(refused.contains("handed over"), "{refused}");
    let taken = client.call(Op::TakeBack { session: id.clone() }).await.unwrap();
    assert_eq!(taken["session"], id.as_str());
    served.close(&id).unwrap();
    let mut events = served.subscribe(&id).unwrap();
    until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
    let stopped = client.call(Op::Resume { session: id.clone(), carry_on: Some("carry on".into()) }).await.unwrap_err().to_string();
    assert!(stopped.contains("may not carry on: it was stopped"), "{stopped}");
    let resumed = client.call(Op::Resume { session: id.clone(), carry_on: None }).await.unwrap();
    assert_eq!(resumed["session"], id.as_str());
    task.abort();
}

/// The events a watch pushes, up to its end.
async fn watched(client: &mut harness::client::Client) -> Vec<Event> {
    use harness::client::Push;
    let mut got = vec![];
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(10), client.push()).await.expect("a push within 10 s").unwrap() {
            Some(Push::Event { event, .. }) => got.push(event),
            Some(Push::End { .. }) => return got,
            Some(Push::Lost { reason, .. }) => panic!("{reason}"),
            None => panic!("the connection ended"),
        }
    }
}

#[tokio::test]
async fn watch_a_resumed_session_reads_past_its_earlier_closed_and_ends_at_the_resumed_starts() {
    use harness::api::Op;
    let (_tmp, dir) = data_dir();
    let (token, mock) = (harness::auth::Token::random(), mock(TURNS));
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
    let first = token.clone();
    let server = harness::server::Server::bind(&dir, move || Some(first), drivers, settings(4)).unwrap();
    let served = server.harness().clone();
    let task = tokio::spawn(server.run());
    let (id, mut events) = open(&served, false).await;
    next(&mut events).await;
    closed(&served, &id, &mut events).await;
    let earlier = served.events(&id, 0).unwrap().iter().find(|event| matches!(event.body, Body::Closed { .. })).unwrap().seq;
    let mut client = harness::client::Client::connect(&dir, &token).await.unwrap();
    client.call(Op::Resume { session: id.clone(), carry_on: None }).await.unwrap();
    let resumed = |got: &[Event]| got.iter().any(|event| matches!(event.body, Body::Started { resumed: true, .. }) && event.seq > earlier);
    // While it runs, and once it has closed again: from the start, and from just before the earlier `closed`.
    let mut watchers = vec![];
    for after in [0, earlier - 1] {
        let mut watcher = harness::client::Client::connect(&dir, &token).await.unwrap();
        watcher.call(Op::Watch { session: id.clone(), after }).await.unwrap();
        watchers.push(watcher);
    }
    let mut events = served.subscribe(&id).unwrap();
    closed(&served, &id, &mut events).await;
    for after in [0, earlier - 1] {
        let mut watcher = harness::client::Client::connect(&dir, &token).await.unwrap();
        watcher.call(Op::Watch { session: id.clone(), after }).await.unwrap();
        watchers.push(watcher);
    }
    for (at, watcher) in watchers.iter_mut().enumerate() {
        let got = watched(watcher).await;
        assert!(resumed(&got), "{at}: the resumed start's events: {:?}", types(&got));
        let last = got.last().unwrap();
        assert!(matches!(last.body, Body::Closed { .. }) && last.seq > earlier, "{at}: ends at the resumed start's `closed`: {:?}", types(&got));
    }
    task.abort();
}

#[tokio::test]
async fn take_back_of_a_session_never_handed_over_and_a_blank_carry_on_are_refused() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let (id, ps) = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        let ps = provider_session(&next(&mut events).await.body);
        turn(&harness, &id, &mut events, "go").await;
        assert!(harness.shutdown().await.is_empty());
        (id, ps)
    };
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    match harness.take_back(&id).await {
        Err(Error::Refused(why)) => assert!(why.contains("was not handed over"), "{why}"),
        other => panic!("taken back: {:?}", other.is_ok()),
    }
    match harness.resume_with(&id, Some("  ".into())).await {
        Err(Error::Refused(why)) => assert!(why.contains("give the text"), "{why}"),
        other => panic!("resumed: {:?}", other.is_ok()),
    }
    assert_eq!(mock.tokens(&ps).len(), 1, "no agent started");
}

#[tokio::test]
async fn resume_over_the_api_watches_a_locked_sessions_new_start_so_the_carry_on_turns_text_arrives() {
    use harness::api::Op;
    use harness::client::Push;
    let (_tmp, dir) = data_dir();
    let (token, mock) = (harness::auth::Token::random(), mock(TURNS));
    let bind = || {
        let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(mock.clone()))];
        let first = token.clone();
        harness::server::Server::bind(&dir, move || Some(first), drivers, settings(4))
    };
    let id = {
        let server = bind().unwrap();
        let served = server.harness().clone();
        let task = tokio::spawn(server.run());
        let (id, mut events) = open(&served, true).await;
        next(&mut events).await;
        turn(&served, &id, &mut events, "go").await;
        assert!(served.shutdown().await.is_empty());
        task.abort();
        id
    };
    drop(reopen(&dir).await);
    let server = bind_again(bind).await;
    let task = tokio::spawn(server.run());
    let mut client = harness::client::Client::connect(&dir, &token).await.unwrap();
    client.call(Op::Resume { session: id.clone(), carry_on: Some("go on".into()) }).await.unwrap();
    // No `watch`: the resume watches the new start from its first event, whole, as it is a locked session's.
    let mut got = vec![];
    while !got.contains(&Body::Text { text: "two".into() }) {
        match tokio::time::timeout(std::time::Duration::from_secs(10), client.push()).await.expect("the carry-on turn's text within 10 s").unwrap() {
            Some(Push::Event { event, .. }) => got.push(event.body),
            other => panic!("{:?}", other.is_some()),
        }
    }
    assert!(matches!(got[0], Body::Started { resumed: true, .. }), "from the new start's first event");
    assert!(got.contains(&Body::Prompted { text: "go on".into() }));
    task.abort();
}

/// A session handed over to Terminal that works in `cwd`, and its provider's id.
async fn handed_over_in(harness: &Harness, cwd: &std::path::Path) -> (String, String) {
    let (id, mut events) = harness.open(Open { provider: "mock".into(), cwd: cwd.into(), tools: tools(), ..Default::default() }).await.unwrap();
    let ps = provider_session(&next(&mut events).await.body);
    harness.hand_over(&id).unwrap();
    until(&mut events, |body| matches!(*body, Body::Closed { .. })).await;
    (id, ps)
}

/// A process that lives until it is killed, started as `command` does it.
struct Held(std::process::Child);

impl Held {
    fn start(command: &mut std::process::Command) -> Held {
        Held(command.stdin(std::process::Stdio::null()).spawn().unwrap())
    }
    fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A shell that runs on after `sleep`, so it keeps its own arguments, with `args` after its name.
fn shell_with(args: &[&str]) -> std::process::Command {
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "sleep 30; true", "sh"]).args(args);
    command
}

/// Until the check sees `pid` hold the session steadily: just after a spawn, for some milliseconds, a process shows
/// neither its spawner's arguments nor its own.
fn settled(pid: u32, id: &str, folder: &std::path::Path, programs: &[&str]) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut since = None;
    while since.is_none_or(|since: std::time::Instant| since.elapsed() < std::time::Duration::from_millis(150)) {
        assert!(std::time::Instant::now() < until, "the check never saw {pid} steadily");
        match harness::process::holding(id, folder, programs, &[], &[]) {
            Some(seen) if seen == pid => since = since.or(Some(std::time::Instant::now())),
            _ => since = None,
        }
    }
}

fn waits_for(refused: Result<broadcast::Receiver<Event>, Error>, pid: u32) {
    match refused {
        Err(Error::Refused(said)) => assert_eq!(said, format!("Its agent {} (pid {pid}). Quit it there, then Resume here.", harness::session::STILL_IN_TERMINAL)),
        other => panic!("not refused: {:?}", other.is_ok()),
    }
}

#[tokio::test]
async fn take_back_waits_while_a_process_resumes_the_session_and_goes_ahead_once_it_ends() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let folder = tempfile::tempdir().unwrap();
    let (id, ps) = handed_over_in(&harness, folder.path()).await;
    // As `claude --resume <id>` in Terminal, wherever it works.
    let open = Held::start(&mut shell_with(&["--resume", &ps]));
    settled(open.pid(), &ps, std::path::Path::new("/nowhere"), &[]);
    waits_for(harness.take_back(&id).await, open.pid());
    let starts = mock.tokens(&ps).len();
    drop(open);
    let mut events = harness.take_back(&id).await.expect("once it ended");
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    assert_eq!(mock.tokens(&ps).len(), starts + 1, "started once, after Terminal let go");
}

#[tokio::test]
async fn take_back_waits_for_the_providers_program_in_the_sessions_folder_but_not_for_a_shell_there() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let folder = tempfile::tempdir().unwrap();
    let (id, _) = handed_over_in(&harness, folder.path()).await;
    // Started as `claude`, as the installed link names it, in the session's folder, with no id in sight.
    let mut claude = std::process::Command::new("/bin/sleep");
    std::os::unix::process::CommandExt::arg0(&mut claude, "claude").arg("30").current_dir(folder.path());
    let claude = Held::start(&mut claude);
    settled(claude.pid(), "no-such-id", folder.path(), &["claude"]);
    waits_for(harness.take_back(&id).await, claude.pid());
    drop(claude);
    let mut shell = shell_with(&[]);
    let _shell = Held::start(shell.current_dir(folder.path()));
    harness.take_back(&id).await.expect("your own shell in the folder is no Terminal claude");
}

#[test]
fn the_check_for_terminal_counts_no_agent_of_the_harnesss_own() {
    let id = "1b2c3d4e-0000-4000-8000-00000000000f";
    let agent = Held::start(&mut shell_with(&["--resume", id]));
    settled(agent.pid(), id, std::path::Path::new("/nowhere"), &[]);
    let started = harness::process::started_of(agent.pid()).unwrap();
    let ours = [harness::process::Process { pid: agent.pid(), started }];
    assert_eq!(harness::process::holding(id, std::path::Path::new("/nowhere"), &["claude"], &ours, &[]), None, "the harness's own");
    assert_eq!(harness::process::holding(id, std::path::Path::new("/nowhere"), &["claude"], &[], &[]), Some(agent.pid()), "anyone else's");
    let reused = [harness::process::Process { pid: agent.pid(), started: started + 1 }];
    assert_eq!(harness::process::holding(id, std::path::Path::new("/nowhere"), &["claude"], &reused, &[]), Some(agent.pid()), "a pid the harness's agent had, now another process's");
}

#[tokio::test]
async fn take_back_waits_for_a_claude_an_interpreter_runs_in_the_sessions_folder_but_not_for_its_other_scripts() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let folder = tempfile::tempdir().unwrap();
    let (id, _) = handed_over_in(&harness, folder.path()).await;
    // As npm installs Claude: a script named `claude` its interpreter runs, here started with no id, as `--continue` is.
    let scripts = tempfile::tempdir().unwrap();
    let write = |dir: &str, name: &str, body: &str| {
        let path = scripts.path().join(dir).join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    };
    let by_sh = write("sh", "claude", "sleep 30; true\n");
    let by_python = write("python", "claude", "import time\ntime.sleep(30)\n");
    for (interpreter, script) in [("/bin/sh", &by_sh), ("python3", &by_python)] {
        let mut command = std::process::Command::new(interpreter);
        command.arg(script).arg("--continue").current_dir(folder.path());
        let claude = Held::start(&mut command);
        settled(claude.pid(), "no-such-id", folder.path(), &["claude"]);
        waits_for(harness.take_back(&id).await, claude.pid());
    }
    // An interpreter in the folder on anything else is no holder.
    let mut other = std::process::Command::new("/bin/sh");
    let _other_sh = Held::start(other.arg(write("other", "other.sh", "sleep 30; true\n")).current_dir(folder.path()));
    let mut node = std::process::Command::new("node");
    node.arg(write("other", "other.js", "setTimeout(() => {}, 30000);\n")).current_dir(folder.path()).stdin(std::process::Stdio::null());
    let _other_node = node.spawn().ok().map(Held);
    std::thread::sleep(std::time::Duration::from_millis(300));
    harness.take_back(&id).await.expect("once the claude scripts ended, the other scripts hold nothing");
}

#[tokio::test]
async fn a_holder_that_starts_after_the_take_back_has_the_first_prompt_refused_and_unsent_until_it_ends() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let folder = tempfile::tempdir().unwrap();
    let (id, ps) = handed_over_in(&harness, folder.path()).await;
    let mut events = harness.take_back(&id).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    // As Terminal's `claude --resume <id>`, which Open in Terminal had not started yet when the take back checked.
    let late = Held::start(&mut shell_with(&["--resume", &ps]));
    settled(late.pid(), &ps, std::path::Path::new("/nowhere"), &[]);
    harness.send(&id, "first").unwrap();
    let seen = until(&mut events, |body| matches!(body, Body::PromptsDropped)).await;
    let said = format!("Its agent {} (pid {}). Quit it there, then Resume here.", harness::session::STILL_IN_TERMINAL, late.pid());
    assert!(seen.iter().any(|event| event.body == Body::Notice { text: said.clone() }), "{seen:?}");
    assert!(!seen.iter().any(|event| matches!(event.body, Body::Prompted { .. })), "nothing was sent");
    assert!(!mock.received(&ps).contains(&Command::Prompt("first".into())));
    drop(late);
    harness.send(&id, "second").unwrap();
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert!(mock.received(&ps).contains(&Command::Prompt("second".into())), "once it ended, the next prompt goes");
}

#[tokio::test]
async fn take_back_waits_for_no_claude_in_another_sessions_folder_inside_its_own_nor_in_a_clones_old_worktrees() {
    let (_tmp, dir) = data_dir();
    let mock = mock(TURNS);
    let harness = harness(&dir, &mock, 4);
    let folder = tempfile::tempdir().unwrap();
    let nested = folder.path().join("nested");
    let worktrees = folder.path().join(".claude").join("worktrees").join("old");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::create_dir_all(&worktrees).unwrap();
    let (id, _) = handed_over_in(&harness, folder.path()).await;
    // Another session works in the nested folder, as a worktree of a clone run does.
    let (other, _) = handed_over_in(&harness, &nested).await;
    let started_as_claude = |cwd: &std::path::Path| {
        let mut claude = std::process::Command::new("/bin/sleep");
        std::os::unix::process::CommandExt::arg0(&mut claude, "claude").arg("30").current_dir(cwd);
        Held::start(&mut claude)
    };
    let in_other = started_as_claude(&nested);
    let in_old = started_as_claude(&worktrees);
    settled(in_other.pid(), "no-such-id", &nested, &["claude"]);
    settled(in_old.pid(), "no-such-id", &worktrees, &["claude"]);
    harness.take_back(&id).await.expect("neither works in this session's own folder");
    waits_for(harness.take_back(&other).await, in_other.pid());
}
