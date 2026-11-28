//! The Codex driver against the fake app-server (`test-support/fake-codex-app-server`), which records every request,
//! and against the wire replay of H0's `codex/app-server` recordings.

mod common;

use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use harness::codex::driver::CodexDriver;
use harness::driver::{Command, Driver, Launch, Link, Secret};
use harness::event::{Body, Decision, FailKind, PermissionKind, TurnEnd};
use harness::process::{self, Listing, Process};
use harness::session::{Harness, Open};
use harness::store::Store;
use serde_json::Value;

const FAKE: &str = env!("CARGO_BIN_EXE_fake-codex-app-server");

/// A launch of the fake in a folder of its own, with `extra` in its environment. The fake learns the session's token
/// from the header it receives, so the test never writes it to a file.
struct Run {
    tmp: tempfile::TempDir,
    out: PathBuf,
    token: Secret,
}

impl Run {
    fn new() -> Run {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        Run { tmp, out, token: Secret::random() }
    }

    fn launch(&self, extra: &[(&str, &str)], resume: Option<&str>, model: Option<&str>, effort: Option<&str>) -> Launch {
        let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = [("PATH", "/usr/bin:/bin".to_owned()), ("FAKE_APP_SERVER_OUT", self.out.display().to_string())]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        env.extend(extra.iter().map(|(k, v)| ((*k).into(), (*v).into())));
        let mut tools = harness::tools::ToolsEndpoint::unattached();
        tools.tools = vec![harness::tools::RESULT.into(), harness::tools::ASK.into()];
        tools.allowed = vec![tools.name.clone()];
        let (model, effort, resume) = (model.map(str::to_owned), effort.map(str::to_owned), resume.map(str::to_owned));
        Launch { cwd: self.tmp.path().into(), locked: false, model, login: None, effort, permissions: Default::default(), resume, tools_token: self.token.clone(), tools, result_schema: None, env }
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.out.join("requests.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn request(&self, method: &str) -> Value {
        self.requests().into_iter().find(|request| request["method"] == method).unwrap_or_else(|| panic!("the driver sent {method}"))
    }

    fn secret(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.out.join("secret.json")).unwrap()).unwrap()
    }

    fn pid_of(&self, file: &str) -> Process {
        process_in(&self.out, file)
    }
}

/// The process whose pid the fake wrote to `file` in `out`, while it runs.
fn process_in(out: &Path, file: &str) -> Process {
    let pid: u32 = std::fs::read_to_string(out.join(file)).unwrap().trim().parse().unwrap();
    Process { pid, started: process::started_of(pid).expect("it runs") }
}

fn driver() -> CodexDriver {
    CodexDriver::new(FAKE.into()).with_graces(Duration::from_millis(300), Duration::from_millis(1_500))
}

/// The link's events until `last` takes one, each within 10 s.
async fn said_until(link: &mut Link, last: impl Fn(&Body) -> bool) -> Vec<Body> {
    let mut said = vec![];
    while let Some(body) = tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the driver says more within 10 s") {
        let done = last(&body);
        said.push(body);
        if done {
            break;
        }
    }
    said
}

/// Stops the agent and waits until its output closes.
async fn stopped(link: &mut Link) {
    link.commands.send(Command::Stop).unwrap();
    while tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the agent goes").is_some() {}
}

/// One prompt to its turn's end, then a stop: every event the driver gave.
async fn one_turn(run: &Run, launch: Launch) -> Vec<Body> {
    let _ = run;
    let mut link = driver().open(launch).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    let said = said_until(&mut link, Body::ends_turn).await;
    stopped(&mut link).await;
    said
}

/// Every key, at any depth, of `value`.
fn keys(value: &Value, into: &mut Vec<String>) {
    match value {
        Value::Object(fields) => fields.iter().for_each(|(key, field)| {
            into.push(key.clone());
            keys(field, into);
        }),
        Value::Array(items) => items.iter().for_each(|item| keys(item, into)),
        _ => {}
    }
}

#[tokio::test]
async fn codex_the_token_is_only_in_http_headers_in_no_argument_and_no_variable() {
    let run = Run::new();
    one_turn(&run, run.launch(&[], None, None, None)).await;
    assert_eq!(run.secret(), serde_json::json!({"env": [], "argv": 0, "headers": 1}), "on stdin, in the endpoint's header, and nowhere else");
    let server = &run.request("thread/start")["params"]["config"]["mcp_servers"];
    let (_, server) = server.as_object().unwrap().iter().next().unwrap();
    assert_eq!(server["http_headers"]["Authorization"], harness::redact::MASK, "kept masked in what the fake records");
    let argv: Vec<String> = serde_json::from_slice(&std::fs::read(run.out.join("argv.json")).unwrap()).unwrap();
    assert_eq!(argv, ["app-server"], "nothing on argv but the subcommand");
}

#[tokio::test]
async fn codex_no_request_carries_a_sandbox_an_approval_policy_projects_or_trust() {
    let run = Run::new();
    one_turn(&run, run.launch(&[], None, Some("gpt-7"), Some("high"))).await;
    let resumed = Run::new();
    one_turn(&resumed, resumed.launch(&[], Some("thr-fake-1"), None, None)).await;
    let forbidden = ["sandbox", "sandbox_mode", "sandboxPolicy", "approvalPolicy", "approval_policy", "approvalsReviewer", "projects", "trust_level"];
    for request in run.requests().into_iter().chain(resumed.requests()) {
        let mut found = vec![];
        keys(&request, &mut found);
        let named: Vec<&String> = found.iter().filter(|key| forbidden.contains(&key.as_str())).collect();
        assert!(named.is_empty(), "{} carries {named:?}", request["method"]);
    }
    let methods: Vec<Value> = run.requests().into_iter().chain(resumed.requests()).map(|request| request["method"].clone()).collect();
    for method in ["thread/start", "thread/resume", "turn/start"] {
        assert!(methods.contains(&Value::from(method)), "{method} was sent and checked");
    }
}

#[tokio::test]
async fn codex_only_the_endpoints_own_server_key_is_approved_without_asking() {
    let run = Run::new();
    let launch = run.launch(&[], None, None, None);
    let name = launch.tools.name.clone();
    one_turn(&run, launch).await;
    let start = run.request("thread/start");
    let servers = start["params"]["config"]["mcp_servers"].as_object().unwrap();
    assert_eq!(servers.keys().collect::<Vec<_>>(), [&name], "one server, the endpoint, under its per-session name");
    let server = &servers[&name];
    assert_eq!((&server["default_tools_approval_mode"], &server["tool_timeout_sec"]), (&Value::from("approve"), &Value::from(600)));
    let mut found = vec![];
    keys(&start, &mut found);
    assert_eq!(found.iter().filter(|key| *key == "default_tools_approval_mode").count(), 1, "approved on that one key, never more widely");
    assert!(name.bytes().all(|b| b.is_ascii_alphanumeric()), "a name no other server's can be a prefix of by `_` or `-`");
}

#[tokio::test]
async fn codex_a_missing_v2_name_fails_the_shape_check_and_says_this_version_is_not_supported() {
    let run = Run::new();
    let refused = driver().open(run.launch(&[("FAKE_APP_SERVER_MISSING", "turn/interrupt,item/fileChange/requestApproval")], None, None, None)).err().expect("refused");
    assert_eq!(refused.kind, FailKind::VersionNotSupported);
    assert_eq!(refused.message, "this Codex version is not supported: it has no turn/interrupt, item/fileChange/requestApproval");
    assert!(!run.out.join("pid").exists(), "no app-server was started");
}

#[tokio::test]
async fn codex_an_untested_version_that_passes_the_check_is_a_warning_and_runs() {
    let run = Run::new();
    let said = one_turn(&run, run.launch(&[("FAKE_APP_SERVER_VERSION", "0.999.0")], None, None, None)).await;
    let warned = said.iter().any(|body| matches!(body, Body::Notice { text } if text.starts_with("Codex 0.999.0 has not been tested")));
    assert!(warned, "{said:?}");
    assert_eq!(said.last(), Some(&Body::TurnEnded { how: TurnEnd::Done }), "not a block");
    let tested = Run::new();
    let said = one_turn(&tested, tested.launch(&[], None, None, None)).await;
    assert!(!said.iter().any(|body| matches!(body, Body::Notice { .. })), "a tested version says nothing: {said:?}");
}

#[tokio::test]
async fn codex_a_config_warning_and_a_deprecation_notice_each_give_a_warning() {
    let run = Run::new();
    let said = one_turn(&run, run.launch(&[("FAKE_APP_SERVER_WARN", "1")], None, None, None)).await;
    let notices: Vec<&str> = said.iter().filter_map(|body| match body { Body::Notice { text } => Some(text.as_str()), _ => None }).collect();
    assert_eq!(notices, ["Codex: A config key is unknown. See the docs.", "Codex: An old setting is deprecated."]);
}

#[tokio::test]
async fn codex_token_usage_gives_a_usage_event_before_the_turns_end() {
    let run = Run::new();
    let said = one_turn(&run, run.launch(&[], None, None, None)).await;
    let usage = Body::Usage { input_tokens: 60, output_tokens: 10, cache_read_tokens: 40, cache_creation_tokens: 0, cost_usd: None };
    assert_eq!(said[said.len() - 2..], [usage, Body::TurnEnded { how: TurnEnd::Done }], "{said:?}");
}

#[tokio::test]
async fn codex_a_model_and_an_effort_go_only_when_chosen_other_than_the_default() {
    for (model, effort) in [(None, None), (Some("default"), Some("default")), (Some("gpt-7"), Some("high"))] {
        let run = Run::new();
        one_turn(&run, run.launch(&[], None, model, effort)).await;
        let chosen = |value: Option<&str>| value.filter(|value| *value != "default").map(Value::from).unwrap_or(Value::Null);
        assert_eq!(run.request("thread/start")["params"]["model"], chosen(model), "{model:?}");
        assert_eq!(run.request("turn/start")["params"]["effort"], chosen(effort), "{effort:?}");
    }
}

#[tokio::test]
async fn codex_a_resume_goes_by_thread_id_with_its_own_fresh_token() {
    let first = Run::new();
    let said = one_turn(&first, first.launch(&[], None, None, None)).await;
    assert_eq!(said[0], Body::Started { provider_session: "thr-fake-1".into(), resumed: false });
    let second = Run::new();
    assert_ne!(first.token, second.token);
    let said = one_turn(&second, second.launch(&[], Some("thr-fake-1"), None, None)).await;
    assert_eq!(said[0], Body::Started { provider_session: "thr-fake-1".into(), resumed: true });
    let resume = second.request("thread/resume");
    assert_eq!(resume["params"]["threadId"], "thr-fake-1");
    assert_eq!(second.secret()["headers"], 1, "the resume carries the new token in its header");
    assert!(!second.requests().iter().any(|request| request["method"] == "thread/start"), "resumed, not started again");
}

#[tokio::test]
async fn codex_the_guard_goes_as_the_threads_developer_instructions() {
    let run = Run::new();
    let launch = run.launch(&[], None, None, None);
    let guard = harness::driver::guard(&launch.tools.tools);
    one_turn(&run, launch).await;
    assert_eq!(run.request("thread/start")["params"]["developerInstructions"], guard.as_str());
}

#[tokio::test]
async fn codex_stop_kills_a_command_that_outlived_turn_interrupt() {
    let run = Run::new();
    let mut link = driver().open(run.launch(&[("FAKE_APP_SERVER_TURN", "command")], None, None, None)).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    said_until(&mut link, |body| matches!(body, Body::ToolCall { .. })).await;
    let command = run.pid_of("command.pid");
    link.commands.send(Command::Cancel).unwrap();
    let said = said_until(&mut link, Body::ends_turn).await;
    assert_eq!(said.last(), Some(&Body::TurnEnded { how: TurnEnd::Cancelled }));
    assert!(process::alive(&command), "the interrupt left the command running, in a group of its own");
    stopped(&mut link).await;
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while process::alive(&command) {
        assert!(tokio::time::Instant::now() < given, "the stop left the command running");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The approval methods, with the kind and tool each becomes and its answers in Codex's own shape, allow then deny.
fn approvals() -> [(&'static str, PermissionKind, &'static str, Value, Value); 4] {
    use serde_json::json;
    let profile = json!({"network": null, "fileSystem": {"read": null, "write": ["/scratch/wt"], "entries": [{"path": {"type": "path", "path": "/scratch/wt"}, "access": "write"}]}});
    [
        ("item/commandExecution/requestApproval", PermissionKind::Command, "command", json!({"decision": "accept"}), json!({"decision": "decline"})),
        ("item/fileChange/requestApproval", PermissionKind::FileChange, "file_change", json!({"decision": "accept"}), json!({"decision": "decline"})),
        ("item/permissions/requestApproval", PermissionKind::Permissions, "permissions", json!({"permissions": profile, "scope": "turn"}), json!({"permissions": {}, "scope": "turn"})),
        ("mcpServer/elicitation/request", PermissionKind::Tool, "other", json!({"action": "accept", "content": {}}), json!({"action": "decline", "content": null})),
    ]
}

/// The driver's answer to the fake's request 900, if it sent one.
fn answer_to_900(run: &Run) -> Option<Value> {
    run.requests().into_iter().find(|line| line["id"] == 900 && line.get("method").is_none())
}

/// One turn of the fake asking `method` (with `extra`), answered `decision` once it asks: every event of the turn.
async fn asked_and_answered(run: &Run, method: &str, extra: &[(&str, &str)], decision: Decision) -> Vec<Body> {
    let mut env = vec![("FAKE_APP_SERVER_TURN", "approval"), ("FAKE_APP_SERVER_APPROVAL", method)];
    env.extend_from_slice(extra);
    let mut link = driver().open(run.launch(&env, None, None, None)).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    let mut said = said_until(&mut link, |body| matches!(body, Body::Permission { .. })).await;
    let Some(Body::Permission { id, .. }) = said.last().cloned() else { unreachable!() };
    link.commands.send(Command::Answer { id, decision, message: Some("not now".into()) }).unwrap();
    said.extend(said_until(&mut link, Body::ends_turn).await);
    stopped(&mut link).await;
    said
}

#[tokio::test]
async fn codex_each_approval_kind_is_a_permission_request_answered_allow_and_deny_in_its_own_shape() {
    for (method, kind, tool, allowed, denied) in approvals() {
        for (decision, want) in [(Decision::Allow, allowed.clone()), (Decision::Deny, denied)] {
            let run = Run::new();
            let said = asked_and_answered(&run, method, &[], decision).await;
            let asked = said.iter().find_map(|body| match body {
                Body::Permission { kind, tool, input, .. } => Some((*kind, tool.clone(), input.clone())),
                _ => None,
            });
            let (got_kind, got_tool, input) = asked.unwrap_or_else(|| panic!("{method} became a permission request: {said:?}"));
            assert_eq!((got_kind, got_tool.as_str()), (kind, tool), "{method}");
            for id in ["threadId", "turnId", "itemId", "startedAtMs", "environmentId"] {
                assert!(input.get(id).is_none(), "{method}: the request holds no {id}");
            }
            assert_eq!(answer_to_900(&run).map(|answer| answer["result"].clone()), Some(want), "{method} answered {decision:?}");
            assert!(!said.iter().any(|body| matches!(body, Body::PermissionClosed { .. })), "{method}: an answered request is not closed");
            assert_eq!(said.last(), Some(&Body::TurnEnded { how: TurnEnd::Done }), "{method}: the turn went on to its end");
        }
    }
}

#[tokio::test]
async fn codex_no_answer_is_wider_than_once() {
    let mut answers = vec![];
    for (method, ..) in approvals() {
        for decision in [Decision::Allow, Decision::Deny] {
            let run = Run::new();
            asked_and_answered(&run, method, &[], decision).await;
            answers.push(answer_to_900(&run).expect("answered"));
        }
    }
    for answer in &answers {
        let text = answer.to_string();
        for wide in ["acceptForSession", "acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment", "\"session\"", "\"always\"", "persist", "strictAutoReview"] {
            assert!(!text.contains(wide), "{answer} holds {wide}");
        }
        assert!(answer["result"].get("scope").is_none_or(|scope| scope == "turn"), "{answer}");
    }
}

#[tokio::test]
async fn codex_an_escalation_comes_to_needs_you_with_the_whole_command() {
    let run = Run::new();
    let said = asked_and_answered(&run, "item/commandExecution/requestApproval", &[], Decision::Allow).await;
    let input = said.iter().find_map(|body| match body {
        Body::Permission { input, .. } => Some(input.clone()),
        _ => None,
    });
    let input = input.expect("a permission request");
    let whole = "/bin/zsh -lc \"printf 'pushed' > pushed.txt && git add pushed.txt && git commit -m 'spike push' && git push -u origin HEAD\"";
    assert_eq!(input["command"], whole, "the whole command, not its first word or the amendment Codex proposes");
    assert_eq!(input["reason"], "May I create pushed.txt, commit it, and push the current branch to origin?");
    assert_eq!(input["cwd"], "/scratch/wt");
}

#[tokio::test]
async fn codex_grant_root_permissions_commands_and_elicitations_are_never_auto_allowed() {
    let asked = |said: &[Body]| said.iter().find(|body| matches!(body, Body::Permission { .. })).cloned().expect("a permission request");
    let run = Run::new();
    let plain = asked(&asked_and_answered(&run, "item/fileChange/requestApproval", &[], Decision::Deny).await);
    assert!(plain.may_be_auto_allowed(), "a file change with no grantRoot may be, once its path is checked");
    let run = Run::new();
    let rooted = asked(&asked_and_answered(&run, "item/fileChange/requestApproval", &[("FAKE_APP_SERVER_GRANT_ROOT", "/scratch")], Decision::Deny).await);
    assert!(matches!(&rooted, Body::Permission { input, .. } if input["grantRoot"] == "/scratch"), "the request shows its grantRoot: {rooted:?}");
    assert!(!rooted.may_be_auto_allowed(), "a grantRoot request never is");
    for method in ["item/permissions/requestApproval", "item/commandExecution/requestApproval", "mcpServer/elicitation/request"] {
        let run = Run::new();
        let request = asked(&asked_and_answered(&run, method, &[], Decision::Deny).await);
        assert!(!request.may_be_auto_allowed(), "{method} never is");
    }
}

#[tokio::test]
async fn codex_an_elicitation_that_asks_for_a_field_is_declined_and_said_so() {
    let run = Run::new();
    let said = one_turn(&run, run.launch(&[("FAKE_APP_SERVER_TURN", "approval"), ("FAKE_APP_SERVER_APPROVAL", "mcpServer/elicitation/request"), ("FAKE_APP_SERVER_ELICIT_FIELD", "1")], None, None, None)).await;
    assert_eq!(answer_to_900(&run).map(|answer| answer["result"].clone()), Some(serde_json::json!({"action": "decline", "content": null})));
    assert!(!said.iter().any(|body| matches!(body, Body::Permission { .. })), "no Allow could fill it in: {said:?}");
    assert!(said.iter().any(|body| matches!(body, Body::Notice { text } if text == "other asked for input Gossamr can't give, so it was declined.")), "{said:?}");
}

#[tokio::test]
async fn codex_a_resolved_request_is_closed_and_a_later_answer_to_it_is_refused_and_never_sent() {
    let (tmp, data) = data_dir();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let extra = [("FAKE_APP_SERVER_TURN", "approval"), ("FAKE_APP_SERVER_APPROVAL", "item/commandExecution/requestApproval"), ("FAKE_APP_SERVER_RESOLVE", "first")];
    let harness = harness_on(&data, Store::open(&data).unwrap(), &extra, &out);
    let (id, mut events) = harness.open(Open { provider: "codex".into(), cwd: tmp.path().to_path_buf(), ..Open::default() }).await.unwrap();
    harness.send(&id, "go").unwrap();
    let seen = until(&mut events, |body| matches!(body, Body::PermissionClosed { .. } | Body::TurnEnded { .. })).await;
    let asked = seen.iter().find_map(|event| match &event.body {
        Body::Permission { id, .. } => Some(id.clone()),
        _ => None,
    });
    let asked = asked.expect("the request came");
    assert_eq!(seen.last().map(|event| &event.body), Some(&Body::PermissionClosed { id: asked.clone() }), "closed while its turn runs");
    let refused = harness.answer(&id, &asked, Decision::Allow, None);
    assert!(matches!(refused, Err(harness::error::Error::NotOpen(_))), "{refused:?}");
    harness.cancel(&id).unwrap();
    until(&mut events, Body::ends_turn).await;
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    let requests: Vec<Value> = std::fs::read_to_string(out.join("requests.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert!(!requests.iter().any(|line| line["id"] == 900), "nothing was sent for it: {requests:?}");
}

#[tokio::test]
async fn codex_an_answer_that_comes_after_codex_resolved_its_request_is_not_sent() {
    let run = Run::new();
    let env = [("FAKE_APP_SERVER_TURN", "approval"), ("FAKE_APP_SERVER_APPROVAL", "item/fileChange/requestApproval"), ("FAKE_APP_SERVER_RESOLVE", "first")];
    let mut link = driver().open(run.launch(&env, None, None, None)).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    let said = said_until(&mut link, |body| matches!(body, Body::PermissionClosed { .. })).await;
    let Some(Body::PermissionClosed { id }) = said.last().cloned() else { unreachable!() };
    link.commands.send(Command::Answer { id, decision: Decision::Allow, message: None }).unwrap();
    link.commands.send(Command::Cancel).unwrap();
    said_until(&mut link, Body::ends_turn).await;
    stopped(&mut link).await;
    assert_eq!(answer_to_900(&run), None, "the late answer never reached Codex");
}

#[tokio::test]
async fn codex_a_turn_that_ends_with_a_request_open_closes_it_and_says_so() {
    let run = Run::new();
    let env = [("FAKE_APP_SERVER_TURN", "approval"), ("FAKE_APP_SERVER_APPROVAL", "item/commandExecution/requestApproval"), ("FAKE_APP_SERVER_RESOLVE", "unresolved")];
    let said = one_turn(&run, run.launch(&env, None, None, None)).await;
    let asked = said.iter().find_map(|body| match body {
        Body::Permission { id, .. } => Some(id.clone()),
        _ => None,
    });
    let at = said.iter().position(|body| *body == Body::PermissionClosed { id: asked.clone().expect("asked") });
    assert!(at.is_some_and(|at| at + 1 < said.len()), "closed before the turn's end: {said:?}");
    assert!(said.iter().any(|body| matches!(body, Body::Notice { text } if text == "Codex's turn ended while it waited for your answer to a request.")), "{said:?}");
}

/// Until `process` has gone, within 10 s.
async fn gone(process: &Process, what: &str) {
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while process::alive(process) {
        assert!(tokio::time::Instant::now() < given, "{what} was left running");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn codex_a_command_left_by_an_app_server_that_exits_unasked_goes_with_it() {
    let run = Run::new();
    let extra = [("FAKE_APP_SERVER_TURN", "command"), ("FAKE_APP_SERVER_EXIT_ON_INTERRUPT", "1")];
    let mut link = driver().open(run.launch(&extra, None, None, None)).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    said_until(&mut link, |body| matches!(body, Body::ToolCall { .. })).await;
    let command = run.pid_of("command.pid");
    // The interrupt makes the fake exit at once, with no stop or kill from the driver, its sleep in a group of its own.
    link.commands.send(Command::Cancel).unwrap();
    while tokio::time::timeout(Duration::from_secs(10), link.output.recv()).await.expect("the agent's end").is_some() {}
    gone(&command, "the command app-server started").await;
}

#[tokio::test]
async fn codex_a_live_leftovers_command_in_a_group_of_its_own_is_stopped_with_it() {
    use std::io::Write;
    let (tmp, data) = data_dir();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    // An app-server a dead harness left, in the middle of a command it started in a group of its own.
    let mut left = std::process::Command::new(FAKE)
        .arg("app-server")
        .env("FAKE_APP_SERVER_OUT", &out)
        .env("FAKE_APP_SERVER_TURN", "command")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut stdin = left.stdin.take().unwrap();
    for line in [r#"{"id":1,"method":"initialize","params":{}}"#, r#"{"id":2,"method":"thread/start","params":{}}"#, r#"{"id":3,"method":"turn/start","params":{"threadId":"thr-fake-1"}}"#] {
        writeln!(stdin, "{line}").unwrap();
    }
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while !out.join("command.pid").exists() {
        assert!(tokio::time::Instant::now() < given, "the fake started its command");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (agent, command) = (Process { pid: left.id(), started: process::started_of(left.id()).unwrap() }, process_in(&out, "command.pid"));
    let store = Store::open(&data).unwrap();
    store.create_session("s", "codex", false, tmp.path(), None).unwrap();
    store.set_agent("s", Some(&agent)).unwrap();
    let harness = harness_on(&data, store, &[], &out);
    gone(&command, "the leftover's command").await;
    assert!(left.wait().unwrap().signal().is_some(), "and the app-server itself was killed");
    harness.shutdown().await;
    drop(stdin);
}

/// The tree the store holds for session `id`, read beside the harness that holds the store.
fn tree_on_record(data: &Path, id: &str) -> Option<Vec<Process>> {
    let raw = rusqlite::Connection::open(data.join("harness.sqlite")).unwrap();
    let tree: Option<String> = raw.query_row("SELECT agent_tree FROM sessions WHERE id = ?1", [id], |row| row.get(0)).unwrap();
    tree.map(|tree| serde_json::from_str(&tree).unwrap())
}

#[tokio::test]
async fn codex_a_running_sessions_noted_tree_is_on_record_until_it_closes() {
    let (tmp, data) = data_dir();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let harness = harness_on(&data, Store::open(&data).unwrap(), &[("FAKE_APP_SERVER_TURN", "command")], &out);
    let (id, mut events) = harness.open(Open { provider: "codex".into(), cwd: tmp.path().to_path_buf(), ..Open::default() }).await.unwrap();
    harness.send(&id, "go").unwrap();
    until(&mut events, |body| matches!(body, Body::ToolCall { .. })).await;
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while !out.join("command.pid").exists() {
        assert!(tokio::time::Instant::now() < given, "the fake started its command");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let command = process_in(&out, "command.pid");
    while !tree_on_record(&data, &id).is_some_and(|tree| tree.contains(&command)) {
        assert!(tokio::time::Instant::now() < given, "the command in a group of its own is on record beside its app-server");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    gone(&command, "the command").await;
    assert_eq!(tree_on_record(&data, &id), None, "and off it once the session closed");
    harness.shutdown().await;
}

#[tokio::test]
async fn codex_an_exited_app_servers_command_is_stopped_from_its_record_and_a_reused_pid_in_it_never_signalled() {
    use std::io::Write;
    let (tmp, data) = data_dir();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    // An app-server a dead harness left, in the middle of a command it started in a group of its own.
    let mut left = std::process::Command::new(FAKE)
        .arg("app-server")
        .env("FAKE_APP_SERVER_OUT", &out)
        .env("FAKE_APP_SERVER_TURN", "command")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut stdin = left.stdin.take().unwrap();
    for line in [r#"{"id":1,"method":"initialize","params":{}}"#, r#"{"id":2,"method":"thread/start","params":{}}"#, r#"{"id":3,"method":"turn/start","params":{"threadId":"thr-fake-1"}}"#] {
        writeln!(stdin, "{line}").unwrap();
    }
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while !out.join("command.pid").exists() {
        assert!(tokio::time::Instant::now() < given, "the fake started its command");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (agent, command) = (Process { pid: left.id(), started: process::started_of(left.id()).unwrap() }, process_in(&out, "command.pid"));
    // Then the app-server crashed on its own, and its command runs on: no process leads to it now.
    left.kill().unwrap();
    left.wait().unwrap();
    assert!(process::alive(&command), "the command outlived its app-server");
    let mut other = std::process::Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let reused = Process { pid: other.id(), started: process::started_of(other.id()).expect("it runs").saturating_sub(3_600) };
    let store = Store::open(&data).unwrap();
    store.create_session("s", "codex", false, tmp.path(), None).unwrap();
    store.set_agent("s", Some(&agent)).unwrap();
    // The record's second process started an hour before the one that has its pid now.
    store.set_agent_tree("s", &[command.clone(), reused]).unwrap();
    let harness = harness_on(&data, store, &[], &out);
    gone(&command, "the exited app-server's command").await;
    assert_eq!(process::seam::sent_to(other.id()), Vec::<i32>::new(), "the reused pid was never signalled");
    assert!(other.try_wait().unwrap().is_none(), "and its process runs on");
    harness.shutdown().await;
    assert_eq!(reopen(&data).await.agents().unwrap(), [], "nothing is left on record");
    other.kill().unwrap();
    other.wait().unwrap();
    drop(stdin);
}

/// A `sleep 60` that a shell in `folder` sent to the background before it exited, in the shell's group: the system's
/// now, as the person's own job or an agent's command left it.
fn left_by_a_shell(folder: &Path, session: Option<&str>) -> (u32, Process) {
    let (group, left, _) = shell_leaves(folder, session, false);
    (group, left)
}

/// The same, with a child of its own that it started first: what pid 1 took in is then a parent.
fn left_with_a_child_by_a_shell(folder: &Path, session: Option<&str>) -> (Process, Process) {
    let (_, left, child) = shell_leaves(folder, session, true);
    (left, child.expect("the child runs"))
}

fn shell_leaves(folder: &Path, session: Option<&str>, with_child: bool) -> (u32, Process, Option<Process>) {
    use std::io::BufRead;
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let file = |what: &str| folder.join(format!(".{what}-{}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let (pid_file, child_file) = (file("left"), file("child"));
    // Not `/bin/sleep`: macOS hides the environment of its own programs, so the harness could not tell whose it is.
    // One command sent to the background, not a list: a list would run in a subshell, which is the system's then.
    let script = r#"cd "$1" || exit; shift; "$@" & echo $!"#;
    let mut shell = std::process::Command::new("/bin/sh");
    shell.args(["-c", script, "sh"]).arg(folder).arg(FAKE).args(["sleep", "60"]).arg(&pid_file).args(with_child.then_some(&child_file)).env_remove(process::SESSION_VARIABLE);
    if let Some(session) = session {
        shell.env(process::SESSION_VARIABLE, session);
    }
    let mut shell = shell.stdout(std::process::Stdio::piped()).process_group(0).spawn().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(shell.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let group = shell.id();
    shell.wait().unwrap();
    let pid: u32 = line.trim().parse().unwrap();
    let given = std::time::Instant::now() + Duration::from_secs(10);
    while !pid_file.exists() {
        assert!(std::time::Instant::now() < given, "the sleep runs as itself");
        std::thread::sleep(Duration::from_millis(10));
    }
    let running = |pid: u32| Process { pid, started: process::started_of(pid).expect("the sleep runs") };
    let child = with_child.then(|| running(std::fs::read_to_string(&child_file).unwrap().trim().parse().unwrap()));
    (group, running(pid), child)
}

/// A process that has exited, by the pid and start time it had.
fn exited() -> Process {
    let mut child = std::process::Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let gone = Process { pid: child.id(), started: process::started_of(child.id()).unwrap() };
    child.kill().unwrap();
    child.wait().unwrap();
    gone
}

fn end(left: &Process) {
    let _ = process::signal(left, libc::SIGKILL);
}

#[tokio::test]
async fn codex_a_stored_command_whose_pid_now_leads_an_older_group_gets_nothing_signalled() {
    let (tmp, data) = data_dir();
    // The person's own group whose leader exited, its member running on, as a pipeline whose first command exited.
    let (group, member) = left_by_a_shell(tmp.path(), None);
    let store = Store::open(&data).unwrap();
    store.create_session("s", "codex", false, tmp.path(), None).unwrap();
    store.set_agent("s", Some(&exited())).unwrap();
    // The record's command had that pid, and started an hour after the group's member did.
    store.set_agent_tree("s", &[Process { pid: group, started: member.started + 3_600 }]).unwrap();
    let harness = harness_on(&data, store, &[], &tmp.path().join("out"));
    assert_eq!(process::seam::sent_to(group), Vec::<i32>::new(), "the group its pid leads now was never signalled");
    assert!(process::alive(&member), "and its member runs on");
    harness.shutdown().await;
    assert!(reopen(&data).await.session("s").unwrap().given_up.is_some(), "and the session stays given up on");
    end(&member);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn codex_at_a_restart_what_the_system_took_in_in_the_worktree_after_the_agent_started_is_stopped_and_nothing_else() {
    let (tmp, data) = data_dir();
    let (worktree, elsewhere) = (tmp.path().join("clone+worktrees").join("b"), tmp.path().join("elsewhere"));
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::create_dir_all(&elsewhere).unwrap();
    let (_, before) = left_by_a_shell(&worktree, Some("s"));
    // Start times are in seconds on macOS.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    let agent = exited();
    let ((_, ours), (_, outside)) = (left_by_a_shell(&worktree, Some("s")), left_by_a_shell(&elsewhere, Some("s")));
    // Yours, as a job you sent to the background in a Terminal opened there and then closed, and another session's.
    let ((_, yours), (_, another)) = (left_by_a_shell(&worktree, None), left_by_a_shell(&worktree, Some("s2")));
    let store = Store::open(&data).unwrap();
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "b".into(), clone: tmp.path().join("clone") };
    let new = harness::store::NewSession { provider: "codex", locked: false, cwd: &worktree, model: None, login: None, effort: None, permissions: Default::default(), work: Some(&work), endpoint: None, tools: &[], result_schema: None };
    store.insert_session("s", &new).unwrap();
    store.set_agent("s", Some(&agent)).unwrap();
    let harness = harness_on(&data, store, &[], &tmp.path().join("out"));
    gone(&ours, "the job left in the worktree").await;
    for (left, what) in [(&before, "one that started before the agent"), (&outside, "one outside the worktree"), (&yours, "one without the session's mark"), (&another, "another session's")] {
        assert_eq!(process::seam::sent_to(left.pid), Vec::<i32>::new(), "{what} was never signalled");
        assert!(process::alive(left), "and runs on");
        end(left);
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn codex_a_job_a_command_sent_to_the_background_in_a_session_of_its_own_goes_when_its_session_closes() {
    let (tmp, data) = data_dir();
    let out = tmp.path().join("out");
    let worktree = tmp.path().join("clone+worktrees").join("b");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let harness = harness_on(&data, Store::open(&data).unwrap(), &[("FAKE_APP_SERVER_TURN", "escape")], &out);
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "b".into(), clone: tmp.path().join("clone") };
    let (id, mut events) = harness.open(Open { provider: "codex".into(), cwd: worktree, work: Some(work), ..Open::default() }).await.unwrap();
    harness.send(&id, "go").unwrap();
    until(&mut events, |body| matches!(body, Body::ToolCall { .. })).await;
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while std::fs::read_to_string(out.join("escaped.pid")).map_or(true, |pid| pid.trim().is_empty()) {
        assert!(tokio::time::Instant::now() < given, "the fake's shell left its job");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let escaped = process_in(&out, "escaped.pid");
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    gone(&escaped, "the job the command left").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn codex_at_a_sessions_end_what_the_system_took_in_from_you_in_its_worktree_runs_on() {
    let (tmp, data) = data_dir();
    let (out, worktree) = (tmp.path().join("out"), tmp.path().join("clone+worktrees").join("b"));
    std::fs::create_dir_all(&out).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let harness = harness_on(&data, Store::open(&data).unwrap(), &[], &out);
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "b".into(), clone: tmp.path().join("clone") };
    let (id, mut events) = harness.open(Open { provider: "codex".into(), cwd: worktree.clone(), work: Some(work), ..Open::default() }).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    // As `npm run dev &` in a Terminal opened in the worktree and then closed, or an editor started from there.
    let ((_, yours), (_, another)) = (left_by_a_shell(&worktree, None), left_by_a_shell(&worktree, Some("another-session")));
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    for (left, what) in [(&yours, "yours"), (&another, "another session's")] {
        assert_eq!(process::seam::sent_to(left.pid), Vec::<i32>::new(), "{what} was never signalled");
        assert!(process::alive(left), "and runs on");
        end(left);
    }
    harness.shutdown().await;
}

#[tokio::test]
async fn codex_at_a_sessions_end_what_its_agent_left_in_its_worktree_goes_with_what_that_started_and_yours_runs_on() {
    let (tmp, data) = data_dir();
    let (out, worktree) = (tmp.path().join("out"), tmp.path().join("clone+worktrees").join("b"));
    std::fs::create_dir_all(&out).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let harness = harness_on(&data, Store::open(&data).unwrap(), &[], &out);
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "b".into(), clone: tmp.path().join("clone") };
    let (id, mut events) = harness.open(Open { provider: "codex".into(), cwd: worktree.clone(), work: Some(work), ..Open::default() }).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    // As `npm run dev &`: the system takes in npm, and the server npm started is npm's child, not the system's.
    let (orphan, child) = left_with_a_child_by_a_shell(&worktree, Some(&id));
    let (_, yours) = left_by_a_shell(&worktree, None);
    // The app-server is among them too while it runs; the session's end looks once it has gone.
    let found = process::marked_in(&worktree, 0, &id);
    let at = |left: &Process| found.iter().position(|found| found == left);
    assert!(at(&child).is_some_and(|child| at(&orphan).is_some_and(|orphan| orphan < child)), "the parent before its child: {found:?}");
    assert_eq!(at(&yours), None, "and not yours");
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    gone(&orphan, "what the agent's command left").await;
    gone(&child, "what that started").await;
    assert_eq!(process::seam::sent_to(yours.pid), Vec::<i32>::new(), "yours was never signalled");
    assert!(process::alive(&yours), "and runs on");
    end(&yours);
    harness.shutdown().await;
}

#[tokio::test]
async fn codex_at_a_sessions_end_what_forks_after_the_first_listing_of_what_its_agent_left_goes_too() {
    let (tmp, data) = data_dir();
    let (out, worktree) = (tmp.path().join("out"), tmp.path().join("clone+worktrees").join("b"));
    std::fs::create_dir_all(&out).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    let harness = harness_on(&data, Store::open(&data).unwrap(), &[], &out);
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "b".into(), clone: tmp.path().join("clone") };
    let (id, mut events) = harness.open(Open { provider: "codex".into(), cwd: worktree.clone(), work: Some(work), ..Open::default() }).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    let (_, listed) = left_by_a_shell(&worktree, Some(&id));
    let forked: Arc<std::sync::Mutex<Option<Process>>> = Arc::default();
    let (hook_forked, folder, session) = (forked.clone(), worktree.clone(), id.clone());
    process::seam::after_marked_listing(&id, move || *hook_forked.lock().unwrap() = Some(left_by_a_shell(&folder, Some(&session)).1));
    harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    let forked = forked.lock().unwrap().clone().expect("the first listing was taken");
    gone(&listed, "what the first listing found").await;
    gone(&forked, "what started after it").await;
    harness.shutdown().await;
}

#[tokio::test]
async fn codex_stop_kills_what_a_command_left_in_its_group_after_it_exited() {
    // As `npm run dev &`: the command's shell exits, and the server it started lives on in the shell's group, no child of
    // app-server's any more.
    let run = Run::new();
    let mut link = driver().open(run.launch(&[("FAKE_APP_SERVER_TURN", "background")], None, None, None)).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    said_until(&mut link, |body| matches!(body, Body::ToolCall { .. })).await;
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while !run.out.join("inner.pid").exists() || std::fs::read_to_string(run.out.join("inner.pid")).unwrap().trim().is_empty() {
        assert!(tokio::time::Instant::now() < given, "the shell started its sleep");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let inner = run.pid_of("inner.pid");
    let shell: u32 = std::fs::read_to_string(run.out.join("shell.pid")).unwrap().trim().parse().unwrap();
    while process::started_of(shell).is_some() {
        assert!(tokio::time::Instant::now() < given, "the shell exited");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    stopped(&mut link).await;
    gone(&inner, "what the command left in its group").await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn codex_on_linux_what_a_command_orphans_stays_in_app_servers_tree() {
    let run = Run::new();
    let mut link = driver().open(run.launch(&[("FAKE_APP_SERVER_TURN", "background")], None, None, None)).unwrap();
    link.commands.send(Command::Prompt("go".into())).unwrap();
    said_until(&mut link, |body| matches!(body, Body::ToolCall { .. })).await;
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while !run.out.join("inner.pid").exists() || std::fs::read_to_string(run.out.join("inner.pid")).unwrap().trim().is_empty() {
        assert!(tokio::time::Instant::now() < given, "the shell started its sleep");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (server, inner) = (run.pid_of("pid"), run.pid_of("inner.pid"));
    let shell: u32 = std::fs::read_to_string(run.out.join("shell.pid")).unwrap().trim().parse().unwrap();
    while process::started_of(shell).is_some() {
        assert!(tokio::time::Instant::now() < given, "the shell exited");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Its shell gone, the sleep is app-server's own: a subreaper takes in what its descendants orphan.
    assert!(process::descendants(&server).contains(&inner), "the orphaned sleep is in app-server's tree");
    stopped(&mut link).await;
    gone(&inner, "the orphaned sleep").await;
}

#[tokio::test]
async fn codex_a_binary_installed_again_with_the_same_modification_time_is_checked_again() {
    // As npm unpacks every file of every version with one fixed modification time.
    let dir = tempfile::tempdir().unwrap();
    let codex = dir.path().join("codex");
    std::fs::copy(FAKE, &codex).unwrap();
    let written = std::fs::metadata(&codex).unwrap().modified().unwrap();
    let driver = CodexDriver::new(codex.clone()).with_graces(Duration::from_millis(300), Duration::from_millis(1_500));
    let first = Run::new();
    let mut link = driver.open(first.launch(&[], None, None, None)).unwrap();
    stopped(&mut link).await;
    std::fs::remove_file(&codex).unwrap();
    std::fs::copy(FAKE, &codex).unwrap();
    std::fs::File::options().write(true).open(&codex).unwrap().set_modified(written).unwrap();
    assert_eq!(std::fs::metadata(&codex).unwrap().modified().unwrap(), written, "the same modification time");
    let second = Run::new();
    let refused = driver.open(second.launch(&[("FAKE_APP_SERVER_MISSING", "turn/interrupt")], None, None, None)).err().expect("checked again, and refused");
    assert_eq!(refused.kind, FailKind::VersionNotSupported);
}

#[tokio::test]
async fn codex_a_locked_session_is_refused() {
    let run = Run::new();
    let mut launch = run.launch(&[], None, None, None);
    launch.locked = true;
    let refused = driver().open(launch).err().expect("refused");
    assert!(refused.message.starts_with("Codex cannot run a locked session"), "{}", refused.message);
}

/// A harness whose `codex` is the fake, on the data folder `data`, with `extra` in the agent's environment.
fn harness_on(data: &Path, store: Store, extra: &[(&str, &str)], out: &Path) -> Harness {
    let mut env: Vec<(String, String)> = vec![("PATH".into(), "/usr/bin:/bin".into()), ("FAKE_APP_SERVER_OUT".into(), out.display().to_string())];
    env.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    let setup = harness::work::Setup::new(None, data.to_path_buf()).with_shell_env(harness::env::RunEnv::from_pairs(env));
    Harness::with_setup(store, vec![("codex".into(), Arc::new(driver()))], settings(4), Arc::new(setup))
}

#[tokio::test]
async fn codex_a_leftover_app_server_from_a_dead_harness_is_stopped_by_its_stored_pid_and_start_time() {
    let (tmp, data) = data_dir();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let first = harness_on(&data, Store::open(&data).unwrap(), &[("FAKE_APP_SERVER_STAY", "1")], &out);
    let (id, mut events) = first.open(Open { provider: "codex".into(), cwd: tmp.path().to_path_buf(), ..Open::default() }).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    let pid: u32 = std::fs::read_to_string(out.join("pid")).unwrap().trim().parse().unwrap();
    let agent = Process { pid, started: process::started_of(pid).expect("the fake runs") };
    // An app-server the shutdown cannot stop: it ignores SIGTERM, its group kill is refused once, and the listing that
    // would settle the refusal proves nothing, that once.
    process::seam::refuse_group_kills(agent.pid, 1);
    process::seam::list_group_once_as(agent.pid, Listing::Full);
    assert_eq!(first.shutdown().await, std::slice::from_ref(&id), "the shutdown gave up on it");
    let refused = async {
        while !process::seam::sent_to(agent.pid).contains(&libc::SIGKILL) {
            tokio::task::yield_now().await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), refused).await.expect("the driver tried to kill it");
    assert!(process::alive(&agent), "and it runs on");
    let store = reopen(&data).await;
    assert_eq!(store.agents().unwrap(), [(id.clone(), agent.clone())], "its pid and start time are on record");
    let second = harness_on(&data, store, &[], &out);
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while process::alive(&agent) {
        assert!(tokio::time::Instant::now() < given, "the next harness left the app-server running");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    second.shutdown().await;
    assert_eq!(Store::open(&data).unwrap().agents().unwrap(), [], "its agent gone, nothing is on record");
}

#[tokio::test]
async fn codex_a_reused_pid_on_record_is_never_signalled() {
    let (tmp, data) = data_dir();
    let mut other = std::process::Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let pid = other.id();
    let started = process::started_of(pid).expect("it runs");
    let store = Store::open(&data).unwrap();
    store.create_session("s", "codex", false, tmp.path(), None).unwrap();
    // The record's start is an hour before this process's: its pid was given out again since.
    store.set_agent("s", Some(&Process { pid, started: started.saturating_sub(3_600) })).unwrap();
    let harness = harness_on(&data, store, &[], &tmp.path().join("out"));
    assert_eq!(process::seam::sent_to(pid), Vec::<i32>::new(), "never signalled");
    assert!(other.try_wait().unwrap().is_none(), "and it runs on");
    harness.shutdown().await;
    other.kill().unwrap();
    other.wait().unwrap();
}

const REPLAY: &str = env!("CARGO_BIN_EXE_wire-replay");

fn app_server() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spikes/acp/fixtures/codex/app-server")
}

fn lines_of(fixture: &Path) -> Vec<Value> {
    std::fs::read_to_string(fixture).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

/// The recordings with a turn.
fn fixtures() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(app_server()).unwrap().map(|entry| entry.unwrap().path()).collect();
    files.retain(|file| file.extension().is_some_and(|ext| ext == "jsonl") && !file.to_string_lossy().ends_with(".mcp-log.jsonl"));
    files.retain(|file| lines_of(file).iter().any(|line| line["dir"] == "to_agent" && line["data"]["method"] == "turn/start"));
    files.sort();
    files
}

/// What the recorded client did: its prompts and interrupts, each with the seq of the agent line it follows, and its
/// answer to each request of the agent's, by the request's place among them.
enum Act {
    Prompt(String, u64),
    Cancel(u64),
    Answer(Decision, usize),
}

/// The recorded client's acts, and how many turns the agent completed.
fn recorded_client(lines: &[Value]) -> (Vec<Act>, usize) {
    let (mut acts, mut completed, mut after, mut asked) = (vec![], 0, 0, vec![]);
    for line in lines {
        let data = &line["data"];
        if line["dir"] == "from_agent" && data.get("method").is_some() && data.get("id").is_some() {
            asked.push(data["id"].clone());
        }
        if line["dir"] == "to_agent" && data.get("method").is_none() && let Some(nth) = asked.iter().position(|id| *id == data["id"]) {
            let result = &data["result"];
            let granted = result["permissions"].as_object().is_some_and(|granted| !granted.is_empty());
            let allowed = result["decision"] == "accept" || result["action"] == "accept" || granted;
            acts.push(Act::Answer(if allowed { Decision::Allow } else { Decision::Deny }, nth));
            continue;
        }
        match (line["dir"].as_str(), data["method"].as_str()) {
            (Some("to_agent"), Some("turn/start")) => {
                let text = data["params"]["input"].as_array().into_iter().flatten().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
                acts.push(Act::Prompt(text, after));
            }
            (Some("to_agent"), Some("turn/interrupt")) => acts.push(Act::Cancel(after)),
            (Some("from_agent"), method) => {
                after = line["seq"].as_u64().unwrap();
                completed += usize::from(method == Some("turn/completed"));
            }
            _ => {}
        }
    }
    (acts, completed)
}

/// A harness whose `codex` is the wire replay of `fixture`, with the replay's progress, so a prompt or an interrupt
/// waits for the agent line it follows.
struct Rig {
    tmp: tempfile::TempDir,
    out: PathBuf,
    harness: Harness,
    written: tokio::sync::watch::Receiver<u64>,
}

fn rig(fixture: &Path) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let (out, data, fifo) = (tmp.path().join("out"), tmp.path().join("data"), tmp.path().join("progress"));
    std::fs::create_dir_all(&out).unwrap();
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: a valid path and mode.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let env = vec![
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ("WIRE_REPLAY_FIXTURE".to_owned(), fixture.display().to_string()),
        ("WIRE_REPLAY_OUT".to_owned(), out.display().to_string()),
        ("WIRE_REPLAY_PROGRESS".to_owned(), fifo.display().to_string()),
        ("WIRE_REPLAY_QUIET_MS".to_owned(), "500".to_owned()),
    ];
    let (seen, written) = tokio::sync::watch::channel(0);
    std::thread::spawn(move || {
        let Ok(file) = std::fs::File::open(fifo) else { return };
        for line in std::io::BufRead::lines(std::io::BufReader::new(file)).map_while(Result::ok) {
            if let Ok(seq) = line.parse() {
                seen.send_replace(seq);
            }
        }
    });
    let setup = harness::work::Setup::new(None, data.clone()).with_shell_env(harness::env::RunEnv::from_pairs(env));
    let driver = CodexDriver::new(REPLAY.into()).with_graces(Duration::from_millis(300), Duration::from_millis(1_500));
    let store = Store::open(&data).unwrap();
    // A session an earlier start began, for a recording that resumes its thread.
    store.create_session("earlier", "codex", false, tmp.path(), None).unwrap();
    store.set_provider_session("earlier", Some("thr-earlier")).unwrap();
    let harness = Harness::with_setup(store, vec![("codex".into(), Arc::new(driver))], settings(4), Arc::new(setup));
    Rig { tmp, out, harness, written }
}

impl Rig {
    fn report(&self) -> String {
        std::fs::read_to_string(self.out.join("report.txt")).unwrap_or_default()
    }

    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.out.join("sent.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    async fn played(&self, seq: u64) {
        let mut written = self.written.clone();
        let waited = tokio::time::timeout(Duration::from_secs(30), written.wait_for(|at| *at >= seq)).await.expect("the replay plays on");
        assert!(waited.is_ok(), "the replay ended before line {seq}: {}", self.report());
    }
}

/// The next event, within 30 s.
async fn next_of(events: &mut tokio::sync::broadcast::Receiver<harness::event::Event>, seen: &mut Vec<harness::event::Event>) {
    seen.push(tokio::time::timeout(Duration::from_secs(30), events.recv()).await.expect("an event within 30 s").unwrap());
}

/// Plays the recorded client through a session, resumed by a thread id of its own where the recording resumes, then
/// closes it: every event up to `closed`.
async fn play(fixture: &Path) -> (Rig, Vec<harness::event::Event>) {
    let rig = rig(fixture);
    let lines = lines_of(fixture);
    let resumes = lines.iter().any(|line| line["dir"] == "to_agent" && line["data"]["method"] == "thread/resume");
    let spec = Open { provider: "codex".into(), cwd: rig.tmp.path().to_path_buf(), ..Open::default() };
    let (id, mut events) = match resumes {
        true => ("earlier".to_owned(), rig.harness.resume_with("earlier", None).await.unwrap()),
        false => rig.harness.open(spec).await.unwrap(),
    };
    let (acts, completed) = recorded_client(&lines);
    let mut seen = vec![];
    let ends = |seen: &[harness::event::Event]| seen.iter().filter(|event| event.body.ends_turn()).count();
    for act in acts {
        match act {
            Act::Prompt(text, after) => {
                rig.played(after).await;
                rig.harness.send(&id, text).unwrap();
            }
            Act::Answer(decision, nth) => {
                let asked = |seen: &[harness::event::Event]| seen.iter().filter_map(|event| match &event.body { Body::Permission { id, .. } => Some(id.clone()), _ => None }).nth(nth);
                while asked(&seen).is_none() {
                    next_of(&mut events, &mut seen).await;
                }
                rig.harness.answer(&id, &asked(&seen).unwrap(), decision, None).unwrap();
            }
            Act::Cancel(after) => {
                rig.played(after).await;
                while !seen.iter().rev().find(|event: &&harness::event::Event| matches!(event.body, Body::TurnStarted) || event.body.ends_turn()).is_some_and(|event| event.body == Body::TurnStarted) {
                    next_of(&mut events, &mut seen).await;
                }
                rig.harness.cancel(&id).unwrap();
            }
        }
    }
    while ends(&seen) < completed {
        next_of(&mut events, &mut seen).await;
    }
    // A recording cut in the middle of a turn ends where its driver was killed: what the agent said up to there.
    let cut = lines.iter().take_while(|line| line["data"]["note"] != "close_stdin").filter(|line| line["dir"] == "from_agent").last();
    // What the driver reads of it after the close is still the session's, up to `closed`.
    rig.played(cut.and_then(|line| line["seq"].as_u64()).unwrap_or(0)).await;
    rig.harness.close(&id).unwrap();
    while !seen.last().is_some_and(|event| matches!(event.body, Body::Closed { .. })) {
        next_of(&mut events, &mut seen).await;
    }
    (rig, seen)
}

/// The projection with the first `started` moved to the front, where the mock sends it: a new thread is named only
/// once `thread/start` is answered, while the session has already said its prompt.
fn as_the_mock_orders_it(mut lines: Vec<String>) -> Vec<String> {
    if let Some(started) = lines.iter().position(|line| line == "started") {
        let line = lines.remove(started);
        lines.insert(0, line);
    }
    lines
}

/// The events with the session's thread id written as the mock writes its own, and the endpoint's tools under the
/// recorded server's name.
fn as_recorded(events: &[harness::event::Event], ours: Option<&str>, recorded: Option<&str>) -> Vec<harness::event::Event> {
    let mut text = serde_json::to_string(events).unwrap();
    if let Some(thread) = events.iter().find_map(|event| match &event.body { Body::Started { provider_session, .. } => Some(provider_session.clone()), _ => None }) {
        text = text.replace(&thread, "mock-0000000000000000");
    }
    if let (Some(ours), Some(recorded)) = (ours, recorded) {
        text = text.replace(&format!("\"{ours}/"), &format!("\"{recorded}/"));
    }
    serde_json::from_str(&text).unwrap()
}

/// The endpoint's name the driver gave in its thread request, and the recorded one: the server approved there.
fn endpoints(rig: &Rig, fixture: &Path) -> (Option<String>, Option<String>) {
    let name = |data: &Value| {
        let servers = data["params"]["config"]["mcp_servers"].as_object()?;
        servers.iter().find(|(_, server)| server["default_tools_approval_mode"] == "approve").map(|(name, _)| name.clone())
    };
    let thread = |data: &Value| matches!(data["method"].as_str(), Some("thread/start" | "thread/resume"));
    let ours = rig.sent().into_iter().find(|line| thread(line)).and_then(|line| name(&line));
    let recorded = lines_of(fixture).into_iter().find(|line| line["dir"] == "to_agent" && thread(&line["data"])).and_then(|line| name(&line["data"]));
    (ours, recorded)
}

#[tokio::test]
async fn codex_every_app_server_fixture_projects_as_its_golden_file() {
    let goldens = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/codex/app-server");
    let mut differ = vec![];
    // Of the 43, five list models or setup with no turn; nine of the rest hold approvals.
    assert_eq!(fixtures().len(), 38, "every recording with a turn is replayed");
    for fixture in fixtures() {
        let name = fixture.file_name().unwrap().to_string_lossy().into_owned();
        let (rig, seen) = play(&fixture).await;
        assert_eq!(rig.report(), "", "{name}: the replay refused a line");
        let (ours, recorded) = endpoints(&rig, &fixture);
        // The driver adds usage and warnings on purpose; H2's converter gives neither, and each has a test of its own.
        let seen: Vec<_> = seen.into_iter().filter(|event| !matches!(event.body, Body::Usage { .. } | Body::Notice { .. })).collect();
        let got = as_the_mock_orders_it(project(&as_recorded(&seen, ours.as_deref(), recorded.as_deref()))).join("\n") + "\n";
        let want = std::fs::read_to_string(goldens.join(&name).with_extension("txt")).unwrap();
        if got != want {
            differ.push((name, got, want));
        }
    }
    for (name, got, want) in &differ {
        eprintln!("== {name}\n-- driver\n{got}-- golden\n{want}");
    }
    let names: Vec<&String> = differ.iter().map(|(name, ..)| name).collect();
    assert!(differ.is_empty(), "the driver's projection differs from the golden file for {names:?}");
}
