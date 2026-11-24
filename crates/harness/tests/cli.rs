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
    let cases = [&["run", "--script", script][..], &["run", "--provider", "mock"], &["run", "--provider", "codex", "--script", script], &["run", "--provider", "mock", "--script", script, "--answer", "always"]];
    for (n, args) in cases.iter().enumerate() {
        let out = Command::new(HARNESS).args(*args).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "case {n}");
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
    assert!(stderr == format!("harness: another harness is using the data folder {}\n", data.display()), "the lock is named");
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

/// A client command that takes its token on stdin.
fn client(serving: &Serving, args: &[&str]) -> Command {
    let mut command = Command::new(HARNESS);
    command.args(args).args(["--token-stdin", "--data"]).arg(&serving.dir).env_remove("HARNESS_DATA").env_remove(harness::cli::TOKEN_VARIABLE);
    command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    command
}

/// Starts `command`, gives it `token` on stdin, and waits for it.
fn with_token(command: &mut Command, token: &str) -> std::process::Output {
    let mut child = command.spawn().unwrap();
    give_token(&mut child, token);
    child.wait_with_output().unwrap()
}

/// As `with_token`, but a child still running after `limit` is killed, and the test fails.
fn with_token_within(command: &mut Command, token: &str, limit: std::time::Duration) -> std::process::Output {
    let mut child = command.spawn().unwrap();
    give_token(&mut child, token);
    output_within(child, limit)
}

/// The child's output once it has ended, read without spinning. Its pipes close when it ends; one still running
/// after `limit` is killed and reaped here, where it is still the child, and the test fails.
fn output_within(mut child: std::process::Child, limit: std::time::Duration) -> std::process::Output {
    use std::io::Read;
    let (drained, outputs) = std::sync::mpsc::channel();
    for (which, mut pipe) in [(0, Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>), (1, Box::new(child.stderr.take().unwrap()))] {
        let drained = drained.clone();
        std::thread::spawn(move || {
            let mut bytes = vec![];
            let _ = pipe.read_to_end(&mut bytes);
            let _ = drained.send((which, bytes));
        });
    }
    let deadline = std::time::Instant::now() + limit;
    let (mut stdout, mut stderr) = (None, None);
    while stdout.is_none() || stderr.is_none() {
        match outputs.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
            Ok((0, bytes)) => stdout = Some(bytes),
            Ok((_, bytes)) => stderr = Some(bytes),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the command was still running after {limit:?}");
            }
        }
    }
    std::process::Output { status: child.wait().unwrap(), stdout: stdout.unwrap(), stderr: stderr.unwrap() }
}

fn give_token(child: &mut std::process::Child, token: &str) {
    use std::io::Write;
    writeln!(child.stdin.take().unwrap(), "{token}").unwrap();
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
    let mut run = client(&serving, &["run", "--provider", "mock", "hi"]).spawn().unwrap();
    give_token(&mut run, &serving.token);
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

    let token = serving.token.clone();
    let sessions = lines(&with_token(&mut client(&serving, &["sessions"]), &token));
    assert_eq!((sessions.len(), sessions[0]["id"].as_str(), &sessions[0]["running"]), (1, Some(session.as_str()), &serde_json::json!(true)));
    let rest = lines(&with_token(&mut client(&serving, &["events", &session, "--after", "2"]), &token));
    assert!(rest == seen[2..], "events after 2 are the ones the killed client saw after 2");
    let request = seen[4]["id"].as_str().unwrap();
    lines(&with_token(&mut client(&serving, &["answer", &session, request, "allow"]), &token));
    lines(&with_token(&mut client(&serving, &["send", &session, "again"]), &token));
    let all = lines(&with_token(&mut client(&serving, &["events", &session, "--follow"]), &token));
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
    let refused = with_token(&mut client(&serving, &["sessions"]), "");
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("client token"), "it says what is missing");
    let wrong = with_token(&mut client(&serving, &["token", "new"]), &harness::auth::Token::random().hex());
    assert_eq!(wrong.status.code(), Some(1), "`token new` with a wrong token");
    assert_eq!(String::from_utf8_lossy(&wrong.stderr).matches("refused").count(), 1, "the refusal is said once");
    assert!(wrong.stdout.is_empty());

    let made = with_token(&mut client(&serving, &["token", "new"]), &serving.token);
    assert!(made.status.success());
    let new = String::from_utf8(made.stdout.clone()).unwrap().trim().to_owned();
    assert!(harness::auth::Token::parse(&new).is_some() && new != serving.token, "a new token");
    let listed = with_token(&mut client(&serving, &["sessions"]), &new);
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

#[test]
fn client_a_run_whose_harness_closes_before_its_turn_ends_fails() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let tmp = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    let listener = runtime.block_on(async { tokio::net::UnixListener::bind(tmp.path().join(harness::api::SOCKET)) }).unwrap();
    // A harness that takes any proof, opens and sends, tells of one event, then closes the connection cleanly.
    let fake = runtime.spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let hello = harness::api::Hello { protocol: harness::api::PROTOCOL, build: "fake".into(), challenge: "00".repeat(32) };
        ws.send(Message::text(serde_json::to_string(&hello).unwrap())).await.unwrap();
        ws.next().await;
        ws.send(Message::text(r#"{"ok":true}"#)).await.unwrap();
        for answer in [r#"{"id":1,"ok":{"session":"s"}}"#, r#"{"id":2,"ok":null}"#] {
            ws.next().await;
            ws.send(Message::text(answer)).await.unwrap();
        }
        let started = r#"{"session":"s","event":{"seq":1,"ms":0,"type":"started","provider_session":"p","resumed":false}}"#;
        ws.send(Message::text(started)).await.unwrap();
        ws.close(None).await.unwrap();
    });
    let mut out = Command::new(HARNESS);
    out.args(["run", "--provider", "mock", "hi", "--data"])
        .arg(tmp.path())
        .arg("--token-stdin")
        .env_remove("HARNESS_DATA")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = with_token_within(&mut out, &harness::auth::Token::random().hex(), std::time::Duration::from_secs(60));
    runtime.block_on(async { tokio::time::timeout(std::time::Duration::from_secs(60), fake).await }).expect("the fake harness ends").unwrap();
    assert_eq!(out.status.code(), Some(1), "no turn ended, so the run did not succeed");
    assert_eq!(printed(&out).len(), 1, "it printed the one event");
}

#[test]
fn client_no_command_reads_a_token_from_the_environment_or_an_argument() {
    let serving = serve(WAITS);
    let with_variable = |args: &[&str]| {
        let mut command = Command::new(HARNESS);
        command.args(args).arg("--data").arg(&serving.dir).env_remove("HARNESS_DATA").env(harness::cli::TOKEN_VARIABLE, &serving.token);
        command.stdin(std::process::Stdio::null()).output().unwrap()
    };
    for args in [&["sessions"][..], &["token", "new"], &["events", "x"], &["run", "--provider", "mock", "hi"]] {
        let out = with_variable(args);
        assert_eq!(out.status.code(), Some(1), "{args:?} with the variable set and no token on stdin is refused");
        assert!(String::from_utf8_lossy(&out.stderr).contains("--token-stdin"), "{args:?} says how to give the token");
    }
    let out = with_variable(&["sessions", "--token", &serving.token]);
    assert_eq!(out.status.code(), Some(2), "a token is never an argument");
}

#[test]
fn serve_with_a_client_token_in_its_environment_does_not_start() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("d");
    let out = Command::new(HARNESS)
        .args(["serve".as_ref(), "--data".as_ref(), dir.as_os_str()])
        .env(harness::cli::TOKEN_VARIABLE, harness::auth::Token::random().hex())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains(harness::cli::TOKEN_VARIABLE), "it says why");
    assert!(!dir.exists(), "nothing was made");
}

#[test]
fn client_with_a_terminal_on_stdin_is_refused_without_waiting_with_or_without_token_stdin() {
    for flag in [&[][..], &["--token-stdin"]] {
        terminal_on_stdin_is_refused(flag);
    }
}

fn terminal_on_stdin_is_refused(flag: &[&str]) {
    use std::os::fd::{FromRawFd, OwnedFd};
    let (mut main, mut side) = (0, 0);
    // SAFETY: openpty fills in two descriptors it opened, which are then owned here.
    assert_eq!(unsafe { libc::openpty(&mut main, &mut side, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) }, 0);
    let (_main, side) = unsafe { (OwnedFd::from_raw_fd(main), OwnedFd::from_raw_fd(side)) };
    let tmp = tempfile::tempdir().unwrap();
    let child = Command::new(HARNESS)
        .args(["sessions", "--data"])
        .arg(tmp.path())
        .args(flag)
        .stdin(side)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // A loaded machine can take seconds to start a newly built binary; one that waits for input never ends.
    let out = output_within(child, std::time::Duration::from_secs(60));
    assert_eq!(out.status.code(), Some(1));
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(said.contains("--token-stdin") && said.contains(harness::cli::KEYCHAIN_READ), "it says how to give the token: {said}");
}

#[test]
fn run_a_script_that_does_not_parse_names_its_line_and_never_its_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("script.jsonl");
    std::fs::write(&script, "{\"prompt\": null}\n{\"sleep\": \"a-private-value-1234\"}\n").unwrap();
    let out = run(&tmp.path().join("data"), &["--script".as_ref(), script.as_os_str()]);
    assert_eq!(out.status.code(), Some(1), "a script that does not parse exits 1");
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(stderr == format!("harness: {}:2: not a step this harness knows\n", script.display()), "the file and the line, and why");
}

#[test]
fn run_without_a_data_folder_uses_a_temporary_one_and_removes_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (temp, default) = (tmp.path().join("tmp"), tmp.path().join("default"));
    std::fs::create_dir(&temp).unwrap();
    let script = fixture("claude/native/2-permission.jsonl");
    let out = Command::new(HARNESS).args(["run", "--provider", "mock", "--script"]).arg(&script).env("TMPDIR", &temp).env("HARNESS_DATA", &default).output().unwrap();
    assert!(out.status.success(), "exit {}", out.status);
    assert!(std::fs::read_dir(&temp).unwrap().next().is_none(), "the temporary folder is removed");
    assert!(!default.exists(), "the default data folder is not touched");
}

#[test]
fn run_a_request_with_no_recorded_answer_and_none_given_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("script.jsonl");
    std::fs::write(&script, "{\"prompt\": \"go\"}\n{\"permission\": {\"kind\": \"command\", \"tool\": \"Bash\", \"answer\": null}}\n{\"end\": \"done\"}\n").unwrap();
    let out = run(&tmp.path().join("data"), &["--script".as_ref(), script.as_os_str()]);
    assert_eq!(out.status.code(), Some(1), "a request nobody can answer fails");
    let stderr = String::from_utf8(out.stderr.clone()).unwrap();
    assert!(stderr.contains("the recording has no answer to this request; give one with --answer"), "and says why");
    assert!(!printed(&out).iter().any(|event| event["type"] == "answered"), "nothing answered it");
}

#[test]
fn run_a_script_that_waits_for_a_first_prompt_with_none_given_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let script = tmp.path().join("script.jsonl");
    std::fs::write(&script, "{\"prompt\": null}\n{\"say\": \"hello\"}\n{\"end\": \"done\"}\n").unwrap();
    let out = run(&tmp.path().join("data"), &["--script".as_ref(), script.as_os_str()]);
    assert_eq!(out.status.code(), Some(1), "nothing was played");
    assert!(String::from_utf8(out.stderr).unwrap().contains("the script waits for a prompt; give one on the command line"));
}

#[test]
fn client_events_follow_fails_and_says_why_when_its_watch_lost_events() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let tmp = tempfile::tempdir().unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
    let listener = runtime.block_on(async { tokio::net::UnixListener::bind(tmp.path().join(harness::api::SOCKET)) }).unwrap();
    // A harness that takes any proof, answers the watch, pushes one event, then ends the watch as lost.
    let fake = runtime.spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let hello = harness::api::Hello { protocol: harness::api::PROTOCOL, build: "fake".into(), challenge: "00".repeat(32) };
        ws.send(Message::text(serde_json::to_string(&hello).unwrap())).await.unwrap();
        ws.next().await;
        ws.send(Message::text(r#"{"ok":true}"#)).await.unwrap();
        ws.next().await;
        ws.send(Message::text(r#"{"id":1,"ok":null}"#)).await.unwrap();
        let started = r#"{"session":"s","event":{"seq":1,"ms":0,"type":"started","provider_session":"p","resumed":false}}"#;
        ws.send(Message::text(started)).await.unwrap();
        ws.send(Message::text(r#"{"session":"s","end":true,"error":"events were lost: behind"}"#)).await.unwrap();
        let _ = ws.next().await;
    });
    let mut out = Command::new(HARNESS);
    out.args(["events", "s", "--follow", "--token-stdin", "--data"])
        .arg(tmp.path())
        .env_remove("HARNESS_DATA")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = with_token_within(&mut out, &harness::auth::Token::random().hex(), std::time::Duration::from_secs(60));
    runtime.block_on(async { tokio::time::timeout(std::time::Duration::from_secs(60), fake).await }).expect("the fake harness ends").unwrap();
    assert_eq!(out.status.code(), Some(1), "an incomplete stream is not a success");
    assert!(String::from_utf8_lossy(&out.stderr).contains("events were lost"), "it says why");
    assert_eq!(printed(&out).len(), 1, "it printed what came");
}

#[test]
fn run_a_script_that_waits_for_a_prompt_with_steps_left_fails_and_one_that_waits_at_its_end_closes() {
    let tmp = tempfile::tempdir().unwrap();
    let (waiting, trailing) = (tmp.path().join("waiting.jsonl"), tmp.path().join("trailing.jsonl"));
    let turn = "{\"prompt\": \"go\"}\n{\"say\": \"first\"}\n{\"end\": \"done\"}\n{\"prompt\": null}\n";
    std::fs::write(&waiting, format!("{turn}{{\"say\": \"second\"}}\n{{\"end\": \"done\"}}\n")).unwrap();
    std::fs::write(&trailing, turn).unwrap();
    let out = run(&tmp.path().join("one"), &["--script".as_ref(), waiting.as_os_str()]);
    assert_eq!(out.status.code(), Some(1), "the second turn was never played");
    assert!(String::from_utf8(out.stderr).unwrap().contains("the script waits for a prompt; give one on the command line"));
    let out = run(&tmp.path().join("two"), &["--script".as_ref(), trailing.as_os_str()]);
    assert!(out.status.success(), "a script that waits for one more prompt at its end has played to its end");
}

#[test]
fn client_run_told_to_allow_a_request_that_was_cut_closes_the_session_and_fails() {
    let big = "q".repeat(2 << 20);
    let script = format!("{{\"prompt\": null}}\n{{\"permission\": {{\"kind\": \"command\", \"tool\": \"Bash\", \"input\": {{\"command\": \"{big}\"}}}}}}\n{{\"end\": \"done\"}}\n{{\"prompt\": null}}");
    let serving = serve(&script);
    let out = with_token_within(&mut client(&serving, &["run", "--provider", "mock", "--answer", "allow", "go"]), &serving.token, std::time::Duration::from_secs(60));
    assert_eq!(out.status.code(), Some(1), "the request was not allowed");
    assert!(String::from_utf8_lossy(&out.stderr).contains("can only be denied; closing the session"));
    let printed = printed(&out);
    assert_eq!(printed.last().map(|event| &event["type"]), Some(&serde_json::json!("closed")), "it read on until the session closed");
}
