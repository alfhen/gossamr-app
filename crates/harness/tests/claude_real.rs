//! The Claude driver on the real `claude`, on the person's own login. Ignored: `cargo test -p harness -- --ignored
//! claude_real`, from any terminal, a Claude Code session's included: the shell is captured from a cleared
//! environment, so none of the test process's own variables reach the agent. Each test runs in a scratch repo whose
//! remote is a local bare repo, records the login folders' config before and after, and fails if one changed or a
//! process of the session is left.

mod common;

use common::real::*;
use common::*;
use harness::event::{Body, TurnEnd};

#[tokio::test]
#[ignore]
async fn claude_real_one_prompt_gives_text_and_a_result_and_leaves_nothing() {
    let seen = real_session(Real { prompt: "Reply with the single word ready, and use no tool.", ..Real::default() }).await.seen;
    let kinds = types(&seen);
    let started = seen.iter().find_map(|event| match &event.body { Body::Started { provider_session, resumed } => Some((provider_session.clone(), *resumed)), _ => None });
    let (session, resumed) = started.expect("init named the session");
    assert!(session.len() == 36 && session.matches('-').count() == 4 && !resumed, "a new session's id, from init");
    let text: String = seen.iter().filter_map(|event| match &event.body { Body::Text { text } => Some(text.as_str()), _ => None }).collect();
    assert!(text.to_lowercase().contains("ready"), "the agent's text arrived ({} characters)", text.len());
    assert_eq!(seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }), "the turn ends by its result");
    assert!(!kinds.iter().any(|kind| kind == "tool_call" || kind == "permission"), "no tool: {kinds:?}");
}

#[tokio::test]
#[ignore]
async fn claude_real_a_locked_session_runs_its_own_result_tool_unasked_and_is_offered_nothing_else() {
    // Pip's profile: `dontAsk`, no built-in tool, the endpoint by `mcp_set_servers`, its tools allowed by exact name.
    let schema = serde_json::json!({"type": "object", "properties": {"tools": {"type": "array", "items": {"type": "string"}}}, "required": ["tools"]});
    let prompt = "Call your result tool exactly once, with `tools` set to the name of every tool you are able to call, \
        each exactly as it is given to you. Call no other tool, then reply with the word done.";
    let note = harness::tools::ToolSpec { name: "note".into(), description: "Keeps a note. Do not call it.".into(), input_schema: serde_json::json!({"type": "object"}) };
    let seen = real_session(Real { locked: true, result_schema: Some(schema), tools: vec![note], prompt, ..Real::default() }).await.seen;
    assert!(!seen.iter().any(|event| matches!(event.body, Body::Permission { .. })), "nothing asked: {:?}", types(&seen));
    let call = seen.iter().find_map(|event| match &event.body { Body::ToolCall { id, name, .. } if name.ends_with("__result") => Some((id.clone(), name.clone())), _ => None });
    let (call, name) = call.expect("the result tool was called");
    let ran = seen.iter().any(|event| matches!(&event.body, Body::ToolResult { id, error: false, .. } if *id == call));
    assert!(ran, "and it ran, not denied: {:?}", types(&seen));
    let given = seen.iter().find_map(|event| match &event.body { Body::Result { data } => Some(data.clone()), _ => None }).expect("the result was taken");
    let server = name.trim_end_matches("__result");
    let mut tools: Vec<String> = given["tools"].as_array().unwrap().iter().filter_map(|tool| tool.as_str()).map(|tool| tool.trim_start_matches(&format!("{server}__")).to_owned()).collect();
    tools.sort();
    assert_eq!(tools, ["ask", "note", "result"], "it was offered the declared tools and the harness's own, and nothing else: {given}");
}

#[tokio::test]
#[ignore]
async fn claude_real_an_agent_edits_asks_is_answered_commits_and_ends_with_a_result_that_fits() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"file": {"type": "string"}, "commit": {"type": "string", "minLength": 40, "maxLength": 40}},
        "required": ["file", "commit"],
        "additionalProperties": false
    });
    let prompt = "In this repository, create a file named colour.txt. Before you write it, call your ask tool to ask which \
        colour to write, and wait for the answer. Write exactly that colour, in lower case, as the file's only line. Then \
        commit the file with git, with the message `Add colour`. Last, call your result tool with `file` set to the \
        file's name and `commit` set to the commit's full hash, then reply with the word done.";
    let ran = real_session(Real { result_schema: Some(schema), prompt, answer: Some("green"), ..Real::default() }).await;
    let kinds = types(&ran.seen);
    let asked = ran.seen.iter().any(|event| matches!(&event.body, Body::ToolCall { name, .. } if name.ends_with("__ask")));
    assert!(asked && kinds.iter().any(|kind| kind == "question"), "it asked through ask: {kinds:?}");
    assert_eq!(std::fs::read_to_string(ran.scratch.join("colour.txt")).unwrap().trim(), "green", "it wrote what it was told");
    let head = std::process::Command::new("git").args(["-C", ran.scratch.to_str().unwrap(), "log", "-1", "--format=%H %s"]).output().unwrap();
    let head = String::from_utf8_lossy(&head.stdout).trim().to_owned();
    let given = ran.seen.iter().chain(&ran.rest).filter_map(|event| match &event.body { Body::Result { data } => Some(data.clone()), _ => None }).next_back().expect("a result was taken");
    assert_eq!(given["file"], "colour.txt");
    assert_eq!(head, format!("{} Add colour", given["commit"].as_str().unwrap()), "the result names the commit it made");
    assert_eq!(ran.seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }));
}
