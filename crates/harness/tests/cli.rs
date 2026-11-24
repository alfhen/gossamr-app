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
    for args in [&[][..], &["serve"]] {
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
