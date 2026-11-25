mod common;

use std::time::Duration;

use common::*;
use harness::driver::Command;
use harness::error::Error;
use harness::event::{Body, Decision, Event, QuestionEnd, TurnEnd};
use harness::session::{Open, QUESTION_PENDING};
use harness::tools::Reply;
use serde_json::json;
use tokio::sync::broadcast;

fn provider_session(started: &Body) -> String {
    match started {
        Body::Started { provider_session, .. } => provider_session.clone(),
        other => panic!("expected started, got {other:?}"),
    }
}

async fn question(events: &mut broadcast::Receiver<Event>) -> String {
    match until(events, |body| matches!(body, Body::Question { .. })).await.pop().unwrap().body {
        Body::Question { id, .. } => id,
        _ => unreachable!(),
    }
}

/// What the mock said it got back from its last call, as its own `tool_result`.
async fn received(events: &mut broadcast::Receiver<Event>) -> (serde_json::Value, bool) {
    loop {
        if let Body::ToolResult { id, output, error } = next(events).await.body
            && id.starts_with('t')
        {
            return (output, error);
        }
    }
}

/// Asks, and goes on with the next turn once the answer comes as a prompt. With a limit, the call returns early.
fn asking(limit_ms: Option<u64>) -> String {
    let caps = limit_ms.map(|limit| format!("{{\"capabilities\": {{\"tool_call_limit_ms\": {limit}}}}}\n")).unwrap_or_default();
    caps + r#"{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour?"}}}
{"say": "after the ask"}
{"end": "done"}
{"prompt": null}
{"say": "with the answer"}
{"end": "done"}
{"prompt": null}"#
}

#[tokio::test]
async fn ask_a_question_is_an_event_and_its_answer_returns_the_call() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&asking(None));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "pick one").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Question { .. })).await;
    let Body::Question { id: q, text } = &asked.last().unwrap().body else { unreachable!() };
    assert_eq!(text, "Which colour?");
    assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()), "it is in the store");
    harness.answer_question(&id, q, "blue".into()).await.unwrap();
    let rest = until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    assert_eq!(rest[0].body, Body::QuestionClosed { id: q.clone(), how: QuestionEnd::Answered });
    assert_eq!(mock.replies(&ps), [Ok(Reply { output: json!("blue"), error: false })], "the held call got the answer");
    assert_eq!(mock.tokens(&ps).len(), 1, "a live session is not resumed");
    assert!(!mock.received(&ps).contains(&Command::Prompt("blue".into())), "nor sent the answer as a prompt");
    assert_eq!(harness.open_question(&id).unwrap(), None);
    assert!(matches!(harness.answer_question(&id, q, "again".into()).await, Err(Error::NoQuestion(_))), "answered once");
}

#[tokio::test]
async fn ask_a_question_asked_before_a_restart_is_open_after_it_and_its_answer_comes_after_a_resume() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&asking(None));
    let (id, q, ps) = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        let ps = provider_session(&next(&mut events).await.body);
        harness.send(&id, "pick one").unwrap();
        let q = question(&mut events).await;
        assert!(harness.shutdown().await.is_empty());
        (id, q, ps)
    };
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()), "the shut-down harness closed none");
    match harness.may_carry_on(&id) {
        Err(Error::Refused(why)) => assert!(why.contains(&q), "{why}"),
        other => panic!("carry on allowed: {other:?}"),
    }
    assert!(harness.subscribe(&id).is_err(), "not running before the answer");
    harness.answer_question(&id, &q, "blue".into()).await.unwrap();
    // The resume's events are read from the store: the harness resumed it, so no receiver was there from its start.
    let given = std::time::Instant::now() + Duration::from_secs(10);
    while !harness.events(&id, 0).unwrap().iter().any(|event| event.body == Body::Text { text: "with the answer".into() }) {
        assert!(std::time::Instant::now() < given, "the answer's turn came within 10 s");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let tokens = mock.tokens(&ps);
    assert_eq!(tokens.len(), 2, "resumed once, with a new token");
    assert_ne!(tokens[0], tokens[1]);
    assert!(mock.received(&ps).contains(&Command::Prompt("blue".into())), "the answer is the next prompt");
    let stored = harness.events(&id, 0).unwrap();
    assert!(stored.iter().any(|event| event.body == Body::QuestionClosed { id: q.clone(), how: QuestionEnd::Answered }));
    assert!(harness.may_carry_on(&id).is_ok(), "answered, it no longer blocks carry on");
}

#[tokio::test]
async fn ask_on_a_mock_with_a_limit_returns_before_it() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&asking(Some(1200)));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.send(&id, "pick one").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Question { .. })).await.pop().unwrap();
    let (output, error) = received(&mut events).await;
    let back = harness.events(&id, 0).unwrap().into_iter().rev().find(|event| matches!(&event.body, Body::ToolResult { id, .. } if id.starts_with('t'))).unwrap();
    assert_eq!((output, error), (json!(QUESTION_PENDING), false), "question pending, end your turn");
    assert!(back.ms - asked.ms < 1200, "before the 1200 ms limit: {} ms", back.ms - asked.ms);
    let Body::Question { id: q, .. } = asked.body else { unreachable!() };
    assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()), "still open: its answer is the next prompt");
}

#[tokio::test]
async fn ask_an_answer_that_arrives_while_a_turn_runs_waits_for_the_turn_to_end() {
    let (_tmp, dir) = data_dir();
    let script = r#"{"capabilities": {"tool_call_limit_ms": 400}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour?"}}}
{"sleep": 300}
{"say": "the turn goes on"}
{"end": "done"}
{"prompt": null}
{"say": "with the answer"}
{"end": "done"}
{"prompt": null}"#;
    let mock = mock(script);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "pick one").unwrap();
    let q = question(&mut events).await;
    received(&mut events).await;
    harness.answer_question(&id, &q, "blue".into()).await.unwrap();
    let seen = until(&mut events, |body| *body == Body::Text { text: "with the answer".into() }).await;
    let at = |kind: &str| seen.iter().position(|event| event.body.type_name() == kind).unwrap();
    assert!(at("turn_ended") < at("prompted"), "the answer waited for the turn: {:?}", types(&seen));
    assert_eq!(seen[at("prompted")].body, Body::Prompted { text: "blue".into() });
    assert_eq!(mock.tokens(&ps).len(), 1, "no resume for a live session");
}

#[tokio::test]
async fn ask_a_second_ask_while_one_is_open_is_refused_naming_it() {
    let (_tmp, dir) = data_dir();
    let script = r#"{"capabilities": {"tool_call_limit_ms": 400}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour?"}}}
{"call": {"name": "ask", "input": {"question": "And which size?"}}}
{"end": "done"}
{"prompt": null}"#;
    let mock = mock(script);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.send(&id, "pick").unwrap();
    let q = question(&mut events).await;
    received(&mut events).await;
    let (output, error) = received(&mut events).await;
    assert!(error && output.as_str().unwrap().contains(&format!("question {q} is open")), "{output}");
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    let questions = harness.events(&id, 0).unwrap().iter().filter(|event| event.body.type_name() == "question").count();
    assert_eq!(questions, 1, "the refused one made no event");
}

#[tokio::test]
async fn ask_result_is_refused_while_a_question_is_open() {
    let (_tmp, dir) = data_dir();
    let script = r#"{"capabilities": {"tool_call_limit_ms": 400}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour?"}}}
{"call": {"name": "result", "input": {"colour": "guess"}}}
{"end": "done"}
{"prompt": null}"#;
    let mock = mock(script);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    next(&mut events).await;
    harness.send(&id, "pick").unwrap();
    let q = question(&mut events).await;
    received(&mut events).await;
    let (output, error) = received(&mut events).await;
    assert!(error && output.as_str().unwrap().contains(&format!("a question is open ({q})")), "{output}");
    assert!(!harness.events(&id, 0).unwrap().iter().any(|event| event.body.type_name() == "result"));
}

#[tokio::test]
async fn ask_stop_and_hand_over_each_close_the_open_question_and_say_so() {
    for how in [QuestionEnd::Stopped, QuestionEnd::HandedOver] {
        let (_tmp, dir) = data_dir();
        let mock = mock(&asking(None));
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        next(&mut events).await;
        harness.send(&id, "pick").unwrap();
        let q = question(&mut events).await;
        match how {
            QuestionEnd::Stopped => harness.close(&id).unwrap(),
            _ => harness.hand_over(&id).unwrap(),
        }
        let seen = until(&mut events, |body| matches!(body, Body::QuestionClosed { .. })).await;
        assert_eq!(seen.last().unwrap().body, Body::QuestionClosed { id: q.clone(), how }, "{how:?}");
        until(&mut events, |body| *body == Body::Closed).await;
        assert_eq!(harness.open_question(&id).unwrap(), None, "{how:?}: closed in the store");
        assert!(harness.answer_question(&id, &q, "late".into()).await.is_err(), "{how:?}: its answer is refused");
    }
}

#[tokio::test]
async fn ask_a_locked_sessions_question_reaches_its_client_whole_and_is_withheld_in_the_store() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&asking(None));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = harness.open(Open { provider: "mock".into(), locked: true, cwd: "/nowhere".into(), tools: tools(), ..Open::default() }).await.unwrap();
    next(&mut events).await;
    harness.send(&id, "pick").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Question { .. })).await.pop().unwrap();
    assert!(matches!(&asked.body, Body::Question { text, .. } if text == "Which colour?"));
    let stored = harness.events(&id, 0).unwrap().into_iter().find(|event| event.seq == asked.seq).unwrap();
    assert!(matches!(&stored.body, Body::Withheld { of, .. } if of == "question"), "{:?}", stored.body);
}

/// The answer's turn has come once the mock said "with the answer", read from the store since a resume may have come.
async fn answer_comes(harness: &harness::session::Harness, id: &str) {
    let given = std::time::Instant::now() + Duration::from_secs(10);
    while !harness.events(id, 0).unwrap().iter().any(|event| event.body == Body::Text { text: "with the answer".into() }) {
        assert!(std::time::Instant::now() < given, "the answer's turn came within 10 s");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn ask_an_answer_waiting_behind_a_turn_when_the_harness_shuts_down_leaves_the_question_open_to_answer_after_the_restart() {
    let (_tmp, dir) = data_dir();
    let script = r#"{"capabilities": {"tool_call_limit_ms": 400}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour?"}}}
{"sleep": 5000}
{"end": "done"}
{"prompt": null}
{"say": "with the answer"}
{"end": "done"}
{"prompt": null}"#;
    let mock = mock(script);
    let (id, q, ps) = {
        let harness = harness(&dir, &mock, 4);
        let (id, mut events) = open(&harness, false).await;
        let ps = provider_session(&next(&mut events).await.body);
        harness.send(&id, "pick one").unwrap();
        let q = question(&mut events).await;
        received(&mut events).await;
        harness.answer_question(&id, &q, "blue".into()).await.unwrap();
        assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()), "open until the answer is sent");
        assert!(harness.shutdown().await.is_empty());
        (id, q, ps)
    };
    let harness = harness_on(reopen(&dir).await, &mock, 4);
    assert!(!harness.events(&id, 0).unwrap().iter().any(|event| event.body.type_name() == "question_closed"));
    assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()), "still open after the restart");
    harness.answer_question(&id, &q, "blue".into()).await.unwrap();
    answer_comes(&harness, &id).await;
    assert!(mock.received(&ps).contains(&Command::Prompt("blue".into())));
    assert_eq!(harness.open_question(&id).unwrap(), None);
}

#[tokio::test]
async fn ask_after_a_cancel_the_answer_comes_as_the_next_prompt() {
    let (_tmp, dir) = data_dir();
    let mock = mock(&asking(None));
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "pick one").unwrap();
    let q = question(&mut events).await;
    harness.cancel(&id).unwrap();
    until(&mut events, |body| *body == Body::TurnEnded { how: TurnEnd::Cancelled }).await;
    assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()), "the cancel left it open");
    harness.answer_question(&id, &q, "blue".into()).await.unwrap();
    let seen = until(&mut events, |body| *body == Body::Text { text: "with the answer".into() }).await;
    let at = |body: &Body| seen.iter().position(|event| event.body == *body).unwrap();
    // Closed once the prompt has reached the driver.
    assert!(at(&Body::Prompted { text: "blue".into() }) < at(&Body::QuestionClosed { id: q.clone(), how: QuestionEnd::Answered }));
    assert!(mock.received(&ps).contains(&Command::Prompt("blue".into())), "the agent got the answer");
}

#[tokio::test]
async fn ask_a_deny_in_a_later_turn_leaves_an_earlier_turns_question_open() {
    let (_tmp, dir) = data_dir();
    let script = r#"{"capabilities": {"tool_call_limit_ms": 400, "deny_ends_turn": true}}
{"prompt": null}
{"call": {"name": "ask", "input": {"question": "Which colour?"}}}
{"end": "done"}
{"prompt": null}
{"permission": {"kind": "command", "tool": "Bash"}}
{"end": "done"}
{"prompt": null}
{"say": "with the answer"}
{"end": "done"}
{"prompt": null}"#;
    let mock = mock(script);
    let harness = harness(&dir, &mock, 4);
    let (id, mut events) = open(&harness, false).await;
    let ps = provider_session(&next(&mut events).await.body);
    harness.send(&id, "pick one").unwrap();
    let q = question(&mut events).await;
    until(&mut events, |body| matches!(body, Body::TurnEnded { .. })).await;
    harness.send(&id, "and run it").unwrap();
    let asked = until(&mut events, |body| matches!(body, Body::Permission { .. })).await.pop().unwrap();
    let Body::Permission { id: request, .. } = asked.body else { unreachable!() };
    harness.answer(&id, &request, Decision::Deny, None).unwrap();
    let seen = until(&mut events, |body| *body == Body::TurnEnded { how: TurnEnd::Denied }).await;
    assert!(!seen.iter().any(|event| event.body.type_name() == "question_closed"), "{:?}", types(&seen));
    assert_eq!(harness.open_question(&id).unwrap().as_deref(), Some(q.as_str()));
    harness.answer_question(&id, &q, "blue".into()).await.unwrap();
    until(&mut events, |body| *body == Body::Text { text: "with the answer".into() }).await;
    assert!(mock.received(&ps).contains(&Command::Prompt("blue".into())));
}

#[tokio::test]
async fn ask_clean_up_and_a_resume_refused_for_good_close_the_open_question_and_sessions_names_it_until_then() {
    for ends_with_client in [false, true] {
        let (_tmp, dir) = data_dir();
        let mock = mock(&asking(None));
        let (id, q) = {
            let harness = harness(&dir, &mock, 4);
            let open = Open { provider: "mock".into(), cwd: "/nowhere".into(), tools: tools(), ends_with_client, ..Open::default() };
            let (id, mut events) = harness.open(open).await.unwrap();
            next(&mut events).await;
            harness.send(&id, "pick one").unwrap();
            let q = question(&mut events).await;
            let listed = harness.sessions().unwrap().into_iter().find(|row| row.id == id).unwrap();
            assert_eq!(listed.open_question.as_deref(), Some(q.as_str()), "`sessions` names it");
            assert!(harness.shutdown().await.is_empty());
            (id, q)
        };
        let harness = harness_on(reopen(&dir).await, &mock, 4);
        match ends_with_client {
            false => harness.clean_up(&id).await.unwrap(),
            true => assert!(matches!(harness.answer_question(&id, &q, "blue".into()).await, Err(Error::EndedWithClient(_)))),
        }
        assert_eq!(harness.open_question(&id).unwrap(), None, "ends with its client: {ends_with_client}");
        // Said in the events too, as a `question_closed` stored with the clean-up or the refusal.
        let how = if ends_with_client { QuestionEnd::NotResumable } else { QuestionEnd::CleanedUp };
        let said = harness.events(&id, 0).unwrap().into_iter().map(|event| event.body.withheld()).find(|body| body.type_name() == "question_closed" || matches!(body, Body::Withheld { of, .. } if of == "question_closed"));
        assert_eq!(said, Some(Body::QuestionClosed { id: q.clone(), how }.withheld()), "{how:?}");
        assert_eq!(harness.sessions().unwrap().into_iter().find(|row| row.id == id).unwrap().open_question, None);
        assert!(harness.may_carry_on(&id).is_ok());
    }
}
