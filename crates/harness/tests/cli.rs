use std::process::Command;

const HARNESS: &str = env!("CARGO_BIN_EXE_harness");

#[test]
fn version_prints_one_line_with_the_version_and_build_id_and_exits_zero() {
    let out = Command::new(HARNESS).arg("--version").output().unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(out.stderr.is_empty(), "{out:?}");
    assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("{}\n", harness::version_line()));
}

#[test]
fn an_argument_that_is_not_utf8_prints_the_usage_and_exits_two() {
    use std::os::unix::ffi::OsStrExt;
    let out = Command::new(HARNESS).arg(std::ffi::OsStr::from_bytes(&[0xff])).output().unwrap();
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert_eq!(String::from_utf8(out.stderr).unwrap(), format!("{}\n", harness::USAGE));
}

#[test]
fn anything_else_prints_the_usage_and_exits_two() {
    for args in [&[][..], &["serve", "extra"]] {
        let out = Command::new(HARNESS).args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty(), "{args:?}");
        assert_eq!(String::from_utf8(out.stderr).unwrap(), format!("{}\n", harness::USAGE));
    }
}

fn fixture(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spikes/acp/fixtures").join(path)
}

fn run(data: &std::path::Path, args: &[&std::ffi::OsStr]) -> std::process::Output {
    Command::new(HARNESS).args(["run", "--provider", "mock", "--data"]).arg(data).args(args).env_remove("HARNESS_DATA").output().unwrap()
}

fn printed(out: &std::process::Output) -> Vec<serde_json::Value> {
    String::from_utf8(out.stdout.clone()).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

#[test]
fn run_prints_a_fixtures_events_in_order_and_exits_zero() {
    let tmp = tempfile::tempdir().unwrap();
    for path in ["claude/native/2-permission.jsonl", "codex/app-server/2-permission.jsonl", "gemini/acp/2-permission.jsonl"] {
        let data = tmp.path().join(path.replace('/', "-"));
        let out = run(&data, &["--script".as_ref(), fixture(path).as_os_str()]);
        // A failure names the fixture and the exit, never what the run printed.
        assert!(out.status.success(), "{path}: exit {}", out.status);
        let events = printed(&out);
        let seqs: Vec<u64> = events.iter().map(|event| event["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, (1..=events.len() as u64).collect::<Vec<_>>(), "{path}: in order, none missing");
        let types: Vec<&str> = events.iter().map(|event| event["type"].as_str().unwrap()).collect();
        assert_eq!((types[0], types[1], *types.last().unwrap()), ("started", "prompted", "closed"), "{path}");
        let answers: Vec<&str> = events.iter().filter(|event| event["type"] == "answered").map(|event| event["decision"].as_str().unwrap()).collect();
        assert_eq!(answers[..2], ["allow", "deny"], "{path}: answered as recorded");
        assert_eq!(events[events.len() - 2]["type"], "turn_ended", "{path}");
    }
}

#[test]
fn run_plays_a_harness_script_with_the_command_lines_prompt_and_answers() {
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("script.jsonl");
    std::fs::write(&script, concat!(
        "{\"prompt\": \"recorded\"}\n",
        "{\"permission\": {\"kind\": \"file_change\", \"tool\": \"Write\", \"answer\": \"allow\"}}\n",
        "{\"say\": \"done\"}\n",
        "{\"end\": \"done\"}\n",
    )).unwrap();
    let out = run(&tmp.path().join("data"), &["--script".as_ref(), script.as_os_str(), "--answer".as_ref(), "allow".as_ref(), "write it".as_ref()]);
    assert!(out.status.success(), "exit {}", out.status);
    let events = printed(&out);
    assert!(events[1]["text"] == "write it", "the command line's prompt comes before the recorded one");
    assert_eq!(events.iter().map(|event| event["type"].as_str().unwrap()).collect::<Vec<_>>(), ["started", "prompted", "turn_started", "permission", "answered", "text", "turn_ended", "closed"]);

    let out = run(&tmp.path().join("data"), &["--script".as_ref(), script.as_os_str(), "--answer".as_ref(), "deny".as_ref()]);
    assert_eq!(out.status.code(), Some(1), "a failure exits 1");
    assert!(printed(&out).iter().any(|event| event["type"] == "failed"));
}

#[test]
fn run_without_a_provider_a_script_or_with_an_unknown_provider_prints_the_usage_and_exits_two() {
    let script = fixture("claude/native/2-permission.jsonl");
    let script = script.to_str().unwrap();
    for args in [&["run", "--script", script][..], &["run", "--provider", "mock"], &["run", "--provider", "codex", "--script", script], &["run", "--provider", "mock", "--script", script, "--answer", "always"]] {
        let out = Command::new(HARNESS).args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_eq!(String::from_utf8(out.stderr).unwrap(), format!("{}\n", harness::USAGE));
    }
}

#[test]
fn lock_a_second_harness_process_on_a_locked_data_folder_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let held = harness::store::Store::open(&data).unwrap();
    let out = run(&data, &["--script".as_ref(), fixture("claude/native/2-permission.jsonl").as_os_str()]);
    assert_eq!(out.status.code(), Some(1), "a locked folder exits 1");
    assert!(out.stdout.is_empty());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert_eq!(stderr, format!("harness: another harness is using the data folder {}\n", data.display()));
    drop(held);
    assert!(run(&data, &["--script".as_ref(), fixture("claude/native/2-permission.jsonl").as_os_str()]).status.success());
}

/// `harness serve` on a temp data folder with a mock script, its first token handed over on stdin. It is ready once it
/// says where it serves.
struct Serving {
    _tmp: tempfile::TempDir,
    dir: std::path::PathBuf,
    token: String,
    child: std::process::Child,
}

impl Drop for Serving {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serve(script: &str) -> Serving {
    use std::io::{BufRead, Write};
    let tmp = tempfile::tempdir().unwrap();
    let (dir, path) = (tmp.path().join("d"), tmp.path().join("script.jsonl"));
    std::fs::write(&path, script).unwrap();
    let token = harness::auth::Token::random().hex();
    let mut child = Command::new(HARNESS)
        .args(["serve".as_ref(), "--data".as_ref(), dir.as_os_str(), "--mock-script".as_ref(), path.as_os_str()])
        .env_remove("HARNESS_DATA")
        .env_remove(harness::cli::TOKEN_VARIABLE)
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(child.stdin.take().unwrap(), "{token}").unwrap();
    let mut said = String::new();
    std::io::BufReader::new(child.stderr.take().unwrap()).read_line(&mut said).unwrap();
    assert!(said.starts_with("harness: serving "), "serve says where it serves");
    Serving { _tmp: tmp, dir, token, child }
}

fn client(serving: &Serving, args: &[&str]) -> Command {
    let mut command = Command::new(HARNESS);
    command.args(args).arg("--data").arg(&serving.dir).env_remove("HARNESS_DATA").env(harness::cli::TOKEN_VARIABLE, &serving.token);
    command
}

fn lines(out: &std::process::Output) -> Vec<serde_json::Value> {
    assert!(out.status.success(), "{:?}", String::from_utf8_lossy(&out.stderr));
    printed(out)
}

const WAITS: &str = r#"{"prompt": null}
{"say": "hello"}
{"permission": {"kind": "command", "tool": "Bash", "input": {"command": "ls"}}}
{"say": "done"}
{"end": "done"}
{"prompt": null}
{"say": "again"}
{"end": "done"}"#;

#[test]
fn client_a_session_run_through_serve_goes_on_after_its_client_is_killed_and_the_cli_answers_it() {
    use std::io::BufRead;
    let serving = serve(WAITS);
    let mut run = client(&serving, &["run", "--provider", "mock", "hi"]).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    let mut said = String::new();
    std::io::BufReader::new(run.stderr.take().unwrap()).read_line(&mut said).unwrap();
    let session = said.trim().strip_prefix("harness: session ").expect("run names its session").to_owned();
    let mut seen = vec![];
    for line in std::io::BufReader::new(run.stdout.take().unwrap()).lines() {
        let event: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let asks = event["type"] == "permission";
        seen.push(event);
        if asks {
            break;
        }
    }
    let types: Vec<&str> = seen.iter().map(|event| event["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["started", "prompted", "turn_started", "text", "permission"]);
    run.kill().unwrap();
    run.wait().unwrap();

    let sessions = lines(&client(&serving, &["sessions"]).output().unwrap());
    assert_eq!((sessions.len(), sessions[0]["id"].as_str(), &sessions[0]["running"]), (1, Some(session.as_str()), &serde_json::json!(true)));
    let rest = lines(&client(&serving, &["events", &session, "--after", "2"]).output().unwrap());
    assert!(rest == seen[2..], "events after 2 are the ones the killed client saw after 2");
    let request = seen[4]["id"].as_str().unwrap();
    lines(&client(&serving, &["answer", &session, request, "allow"]).output().unwrap());
    lines(&client(&serving, &["send", &session, "again"]).output().unwrap());
    let all = lines(&client(&serving, &["events", &session, "--follow"]).output().unwrap());
    let types: Vec<&str> = all.iter().map(|event| event["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        ["started", "prompted", "turn_started", "text", "permission", "answered", "text", "turn_ended", "prompted", "turn_started", "text", "turn_ended", "closed"]
    );
    assert_eq!(all[5]["decision"], "allow");
    assert_eq!(all[8]["text"], "again");
}

#[test]
fn client_token_new_needs_a_token_and_makes_one_that_works() {
    let serving = serve(WAITS);
    let refused = client(&serving, &["sessions"]).env_remove(harness::cli::TOKEN_VARIABLE).output().unwrap();
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).contains(harness::cli::TOKEN_VARIABLE), "it says what is missing");
    let wrong = client(&serving, &["token", "new"]).env(harness::cli::TOKEN_VARIABLE, harness::auth::Token::random().hex()).output().unwrap();
    assert_eq!(wrong.status.code(), Some(1), "`token new` with a wrong token");
    assert!(wrong.stdout.is_empty());

    let made = client(&serving, &["token", "new"]).output().unwrap();
    assert!(made.status.success());
    let new = String::from_utf8(made.stdout).unwrap().trim().to_owned();
    assert!(harness::auth::Token::parse(&new).is_some() && new != serving.token, "a new token");
    let listed = client(&serving, &["sessions"]).env(harness::cli::TOKEN_VARIABLE, &new).output().unwrap();
    assert!(listed.status.success() && listed.stdout.is_empty(), "the new token opens the API");
    for out in [&refused, &wrong, &listed] {
        let all = [&out.stdout[..], &out.stderr[..]].concat();
        assert!(!String::from_utf8_lossy(&all).contains(&serving.token), "no token in what a client prints");
    }
}

#[test]
fn client_serve_stops_on_sigterm_and_takes_its_socket_and_descriptor_with_it() {
    let mut serving = serve(WAITS);
    // SAFETY: kill has no memory preconditions; the pid is our child's, which has not been waited on.
    assert_eq!(unsafe { libc::kill(serving.child.id() as i32, libc::SIGTERM) }, 0);
    assert!(serving.child.wait().unwrap().success());
    assert!(!serving.dir.join(harness::api::SOCKET).exists() && !serving.dir.join(harness::api::DESCRIPTOR).exists());
}
