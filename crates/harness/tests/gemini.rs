//! The Gemini driver against the wire replay (`test-support/wire-replay`): H0's `gemini/acp` recordings, compared with
//! their golden files, and recordings written here for what H0 did not record or what needs agy's own timing.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use harness::driver::{Capabilities, Driver, EndReport, Launch, Link, OpenError, Secret};
use harness::event::{Body, Decision, Event, FailKind, TurnEnd};
use harness::gemini::driver::{GeminiDriver, Timing};
use harness::process::{self, Listing, Process};
use harness::session::{Harness, Open};
use harness::store::Store;
use harness::tools::ToolsEndpoint;
use serde_json::{Value, json};

const REPLAY: &str = env!("CARGO_BIN_EXE_wire-replay");

/// The driver's waits, a tenth of agy's or shorter, so a test of a quiet end takes a second, not fifteen.
fn timing() -> Timing {
    let ms = Duration::from_millis;
    Timing { term_after: ms(300), stop_takes_up_to: ms(1_500), setup_within: ms(10_000), quiet: ms(500), cut: ms(1_500), tree_every: ms(50) }
}

fn acp() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spikes/acp/fixtures/gemini/acp")
}

fn lines_of(fixture: &Path) -> Vec<Value> {
    std::fs::read_to_string(fixture).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

/// Wraps the driver and keeps each launch's token and endpoint, writing the token where the replay reads it, so a test
/// can call the endpoint as the agent would and the replay can say where the token went.
struct Seeing {
    inner: GeminiDriver,
    seen: Arc<Mutex<Vec<(Secret, ToolsEndpoint)>>>,
    secret_file: PathBuf,
}

impl Seeing {
    fn see(&self, mut launch: Launch) -> Launch {
        std::fs::write(&self.secret_file, launch.tools_token.expose()).unwrap();
        launch.env.push(("WIRE_REPLAY_SECRET_FILE".into(), self.secret_file.clone().into()));
        self.seen.lock().unwrap().push((launch.tools_token.clone(), launch.tools.clone()));
        launch
    }
}

impl Driver for Seeing {
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        self.inner.open(self.see(launch))
    }

    fn open_reporting(&self, launch: Launch, end: EndReport) -> Result<Link, OpenError> {
        self.inner.open_reporting(self.see(launch), end)
    }
}

/// A harness whose `agy` is the wire replay of `fixture`, with the replay's progress, so a prompt or a cancel waits for
/// the agent line it follows.
struct Rig {
    tmp: tempfile::TempDir,
    out: PathBuf,
    data: PathBuf,
    harness: Harness,
    written: tokio::sync::watch::Receiver<u64>,
    seen: Arc<Mutex<Vec<(Secret, ToolsEndpoint)>>>,
    /// The folder of a test's own recordings.
    recs: tempfile::TempDir,
}

fn rig(fixture: &Path, pace: Option<&str>) -> Rig {
    rig_with(fixture, pace, &[])
}

fn rig_with(fixture: &Path, pace: Option<&str>, extra: &[(&str, &str)]) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let (out, data, fifo) = (tmp.path().join("out"), tmp.path().join("data"), tmp.path().join("progress"));
    std::fs::create_dir_all(&out).unwrap();
    let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    // SAFETY: a valid path and mode.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    let mut env = vec![
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ("WIRE_REPLAY_FIXTURE".to_owned(), fixture.display().to_string()),
        ("WIRE_REPLAY_OUT".to_owned(), out.display().to_string()),
        ("WIRE_REPLAY_PROGRESS".to_owned(), fifo.display().to_string()),
        ("WIRE_REPLAY_QUIET_MS".to_owned(), "200".to_owned()),
    ];
    env.extend(pace.map(|pace| ("WIRE_REPLAY_PACE".to_owned(), pace.to_owned())));
    env.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    let (progress, written) = tokio::sync::watch::channel(0);
    std::thread::spawn(move || {
        let Ok(file) = std::fs::File::open(fifo) else { return };
        for line in std::io::BufRead::lines(std::io::BufReader::new(file)).map_while(Result::ok) {
            if let Ok(seq) = line.parse() {
                progress.send_replace(seq);
            }
        }
    });
    let seen = Arc::new(Mutex::new(vec![]));
    let driver = Seeing { inner: GeminiDriver::new(REPLAY.into()).with_timing(timing()), seen: seen.clone(), secret_file: tmp.path().join("secret") };
    let harness = harness_on(&data, Store::open(&data).unwrap(), driver, env);
    Rig { tmp, out, data, harness, written, seen, recs: tempfile::tempdir().unwrap() }
}

/// A rig whose `agy` plays a test's own recording.
fn rig_of(rec: &Rec, pace: Option<&str>, extra: &[(&str, &str)]) -> Rig {
    let recs = tempfile::tempdir().unwrap();
    let rig = rig_with(&rec.write(recs.path()), pace, extra);
    Rig { recs, ..rig }
}

fn harness_on(data: &Path, store: Store, driver: impl Driver + 'static, env: Vec<(String, String)>) -> Harness {
    // A session an earlier start began, for a recording that loads its session.
    if store.session("earlier").is_err() {
        store.create_session("earlier", "gemini", false, data.parent().unwrap(), None).unwrap();
        store.set_provider_session("earlier", Some("0f0e0d0c-0b0a-4909-8807-060504030201")).unwrap();
    }
    let setup = harness::work::Setup::new(None, data.to_path_buf()).with_shell_env(harness::env::RunEnv::from_pairs(env));
    Harness::with_setup(store, vec![("gemini".into(), Arc::new(driver))], settings(4), Arc::new(setup))
}

impl Rig {
    fn report(&self) -> String {
        std::fs::read_to_string(self.out.join("report.txt")).unwrap_or_default()
    }

    fn sent(&self) -> Vec<Value> {
        std::fs::read_to_string(self.out.join("sent.jsonl")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    async fn played(&self, seq: u64) {
        let mut written = self.written.clone();
        let waited = tokio::time::timeout(Duration::from_secs(60), written.wait_for(|at| *at >= seq)).await.expect("the replay plays on");
        assert!(waited.is_ok(), "the replay ended before line {seq}: {}", self.report());
    }

    async fn open(&self) -> (String, tokio::sync::broadcast::Receiver<Event>) {
        self.harness.open(Open { provider: "gemini".into(), cwd: self.tmp.path().to_path_buf(), ..Open::default() }).await.unwrap()
    }

    fn child(&self) -> Process {
        let pid: u32 = std::fs::read_to_string(self.out.join("child.pid")).unwrap().trim().parse().unwrap();
        Process { pid, started: process::started_of(pid).expect("the child runs") }
    }
}

/// Collects a session's events as they come and answers each permission request as `answers` says, in order, until
/// they run out.
#[derive(Clone)]
struct Client(Arc<Mutex<Vec<Event>>>);

impl Client {
    fn follow(harness: &Harness, id: &str, mut events: tokio::sync::broadcast::Receiver<Event>, answers: Vec<Decision>) -> Client {
        let seen = Client(Arc::new(Mutex::new(vec![])));
        let (keeping, harness, id) = (seen.clone(), harness.clone(), id.to_owned());
        tokio::spawn(async move {
            let mut answers = answers.into_iter();
            while let Ok(event) = events.recv().await {
                let closed = matches!(event.body, Body::Closed { .. });
                if let Body::Permission { id: request, .. } = &event.body
                    && let Some(decision) = answers.next()
                {
                    harness.answer(&id, request, decision, None).unwrap();
                }
                keeping.0.lock().unwrap().push(event);
                if closed {
                    break;
                }
            }
        });
        seen
    }

    fn events(&self) -> Vec<Event> {
        self.0.lock().unwrap().clone()
    }

    async fn until(&self, what: &str, done: impl Fn(&[Event]) -> bool) {
        let given = tokio::time::Instant::now() + Duration::from_secs(60);
        while !done(&self.events()) {
            assert!(tokio::time::Instant::now() < given, "no {what} within 60 s: {:?}", types(&self.events()));
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn closed(&self) {
        self.until("closed", |seen| seen.last().is_some_and(|event| matches!(event.body, Body::Closed { .. }))).await;
    }

    fn count(&self, take: impl Fn(&Body) -> bool) -> usize {
        self.events().iter().filter(|event| take(&event.body)).count()
    }
}

/// What the recorded client did: each prompt and cancel with the seq of the agent line it follows, and its answer to
/// each permission request, in order.
enum Act {
    Prompt(String, u64),
    Cancel(u64),
}

fn recorded_client(lines: &[Value]) -> (Vec<Act>, Vec<Decision>) {
    let (mut acts, mut answers, mut after) = (vec![], vec![], 0);
    let mut options: std::collections::HashMap<String, Value> = Default::default();
    for line in lines {
        let data = &line["data"];
        match (line["dir"].as_str(), data["method"].as_str()) {
            (Some("to_agent"), Some("session/prompt")) => {
                let blocks = data["params"]["prompt"].as_array().into_iter().flatten();
                acts.push(Act::Prompt(blocks.filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n"), after));
            }
            (Some("to_agent"), Some("session/cancel")) => acts.push(Act::Cancel(after)),
            (Some("to_agent"), None) if data["result"].get("outcome").is_some() => {
                let chosen = &data["result"]["outcome"]["optionId"];
                let option = options.get(&data["id"].to_string()).and_then(|options| options.as_array()?.iter().find(|option| option["optionId"] == *chosen).cloned());
                answers.push(match option.is_some_and(|option| option["kind"] == "allow_once") {
                    true => Decision::Allow,
                    false => Decision::Deny,
                });
            }
            (Some("from_agent"), method) => {
                after = line["seq"].as_u64().unwrap();
                if method == Some("session/request_permission") {
                    options.insert(data["id"].to_string(), data["params"]["options"].clone());
                }
            }
            _ => {}
        }
    }
    (acts, answers)
}

/// Plays the recorded client through a session, loaded from a session of its own where the recording loads one, then
/// closes it: every event up to `closed`.
async fn play(fixture: &Path, pace: Option<&str>) -> (Rig, String, Vec<Event>) {
    play_to(fixture, pace, false).await
}

/// As `play`, ending with a shutdown of the harness instead of a stop of the session, with `shut`.
async fn play_to(fixture: &Path, pace: Option<&str>, shut: bool) -> (Rig, String, Vec<Event>) {
    let rig = rig(fixture, pace);
    let lines = lines_of(fixture);
    let loads = lines.iter().any(|line| line["dir"] == "to_agent" && line["data"]["method"] == "session/load");
    let (id, events) = match loads {
        true => ("earlier".to_owned(), rig.harness.resume_with("earlier", None).await.unwrap()),
        false => rig.open().await,
    };
    let (acts, answers) = recorded_client(&lines);
    let client = Client::follow(&rig.harness, &id, events, answers);
    client.until("the session's start", |seen| seen.iter().any(|event| matches!(event.body, Body::Started { .. }))).await;
    for act in acts {
        match act {
            Act::Prompt(text, after) => {
                rig.played(after).await;
                rig.harness.send(&id, text).unwrap();
            }
            Act::Cancel(after) => {
                rig.played(after).await;
                client.until("turn", |seen| seen.iter().any(|event| event.body == Body::TurnStarted)).await;
                rig.harness.cancel(&id).unwrap();
            }
        }
    }
    // What the agent said up to where the recorded driver closed stdin or was killed, then the end of every turn.
    let cut = lines.iter().take_while(|line| line["data"]["note"] != "close_stdin").filter(|line| line["dir"] == "from_agent").last();
    rig.played(cut.and_then(|line| line["seq"].as_u64()).unwrap_or(0)).await;
    let killed = !lines.iter().any(|line| line["data"]["note"] == "close_stdin");
    if !killed {
        client.until("end of every turn", |seen| seen.iter().filter(|event| event.body == Body::TurnStarted).count() == seen.iter().filter(|event| event.body.ends_turn()).count()).await;
    }
    match shut {
        true => drop(rig.harness.shutdown().await),
        false => rig.harness.close(&id).unwrap(),
    }
    client.closed().await;
    (rig, id, client.events())
}

/// The recordings with a turn, each by name and the pace it is played at: those whose turns agy starts by itself at
/// a tenth of their recorded pace, so the quiet end is compared.
fn fixtures() -> Vec<(PathBuf, Option<&'static str>)> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(acp()).unwrap().map(|entry| entry.unwrap().path()).collect();
    files.retain(|file| file.extension().is_some_and(|ext| ext == "jsonl") && !file.to_string_lossy().ends_with(".mcp-log.jsonl"));
    files.retain(|file| lines_of(file).iter().any(|line| line["dir"] == "to_agent" && line["data"]["method"] == "session/prompt"));
    files.sort();
    let paced = ["r2-ask.jsonl", "r7-background.jsonl", "r8-prompt-during-unprompted.jsonl"];
    files.into_iter().map(|file| {
        let pace = paced.contains(&file.file_name().unwrap().to_str().unwrap()).then_some("0.1");
        (file, pace)
    }).collect()
}

/// The events as H2's converter writes them: a deny-ended turn ends `done` there, since the converter does not know
/// the deny ends it, and the driver's usage and busy state are its own.
fn as_converted(events: Vec<Event>) -> Vec<Event> {
    let events = events.into_iter().filter(|event| !matches!(event.body, Body::Usage { .. } | Body::Notice { .. } | Body::Background { .. }));
    events.map(|mut event| {
        if event.body == (Body::TurnEnded { how: TurnEnd::Denied }) {
            event.body = Body::TurnEnded { how: TurnEnd::Done };
        }
        event
    }).collect()
}

/// The events with the session's id, the driver's and the recorded one where the replay left it in text split over two
/// chunks, written as the mock writes its own.
fn as_recorded(events: Vec<Event>, fixture: &Path) -> Vec<Event> {
    let mut text = serde_json::to_string(&events).unwrap();
    let lines = lines_of(fixture);
    let recorded = lines.iter().find_map(|line| line["data"]["result"]["sessionId"].as_str().or(line["data"]["params"]["sessionId"].as_str()).map(str::to_owned));
    let ours = events.iter().find_map(|event| match &event.body {
        Body::Started { provider_session, .. } => Some(provider_session.clone()),
        _ => None,
    });
    for id in recorded.into_iter().chain(ours) {
        text = text.replace(&id, "mock-0000000000000000");
    }
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn gemini_every_acp_fixture_projects_as_its_golden_file() {
    let goldens = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/gemini/acp");
    // r1-collision ends as a failed turn on purpose, with a test of its own.
    let fixtures: Vec<_> = fixtures().into_iter().filter(|(file, _)| !file.ends_with("r1-collision.jsonl")).collect();
    assert_eq!(fixtures.len(), 22, "every recording with a prompt but r1-collision is replayed");
    let runs = fixtures.into_iter().map(|(fixture, pace)| async move {
        let name = fixture.file_name().unwrap().to_string_lossy().into_owned();
        let (rig, _, seen) = play(&fixture, pace).await;
        assert_eq!(rig.report(), "", "{name}: the replay refused a line");
        let got = project(&as_recorded(as_converted(seen), &fixture)).join("\n") + "\n";
        (name, got)
    });
    let mut differ = vec![];
    for (name, got) in futures_util::future::join_all(runs).await {
        let want = std::fs::read_to_string(goldens.join(&name).with_extension("txt")).unwrap();
        if got != want {
            eprintln!("== {name}\n-- driver\n{got}-- golden\n{want}");
            differ.push(name);
        }
    }
    assert!(differ.is_empty(), "the driver's projection differs from the golden file for {differ:?}");
}

#[tokio::test]
async fn gemini_r1_collision_is_a_failed_turn_that_says_why() {
    let (rig, _, seen) = play(&acp().join("r1-collision.jsonl"), None).await;
    assert_eq!(rig.report(), "");
    let failed = seen.iter().find_map(|event| match &event.body {
        Body::Failed { kind, reason } => Some((*kind, reason.clone())),
        _ => None,
    });
    let (kind, reason) = failed.expect("the turn failed");
    assert_eq!(kind, FailKind::Provider);
    assert!(reason.contains("tool name conflict"), "{reason}");
    assert!(!seen.iter().any(|event| matches!(event.body, Body::TurnEnded { .. })), "not a finished turn: {:?}", types(&seen));
}

#[tokio::test]
async fn gemini_a_deny_ends_the_turn_denied_and_no_carry_on_may_follow_it() {
    let (rig, id, seen) = play_to(&acp().join("2-permission.jsonl"), None, true).await;
    assert_eq!(rig.report(), "");
    assert!(seen.iter().any(|event| event.body == Body::TurnEnded { how: TurnEnd::Denied }), "{:?}", types(&seen));
    let again = rig_at(&rig.data, reopen(&rig.data).await, &acp().join("2-permission.jsonl"));
    match again.harness.resume_with(&id, Some("carry on".into())).await {
        Err(harness::error::Error::Refused(why)) => assert!(why.contains("a deny ended its last turn"), "{why}"),
        other => panic!("carry on was not refused: {:?}", other.is_ok()),
    }
    assert!(GeminiDriver::new(REPLAY.into()).capabilities().deny_ends_turn, "the capability says so");
}

#[tokio::test]
async fn gemini_a_turns_usage_comes_from_its_prompt_answer_before_its_end() {
    let (_rig, _, seen) = play(&acp().join("1-edit-run.jsonl"), None).await;
    let at = |take: &dyn Fn(&Body) -> bool| seen.iter().position(|event| take(&event.body));
    let used = at(&|body| matches!(body, Body::Usage { .. })).expect("a usage event");
    assert!(used < at(&|body| matches!(body, Body::TurnEnded { .. })).unwrap(), "before the turn's end");
    let recorded = lines_of(&acp().join("1-edit-run.jsonl")).into_iter().find_map(|line| line["data"]["result"].get("usage").cloned()).unwrap();
    let want = Body::Usage {
        input_tokens: recorded["inputTokens"].as_u64().unwrap(),
        output_tokens: recorded["outputTokens"].as_u64().unwrap(),
        cache_read_tokens: recorded["cachedReadTokens"].as_u64().unwrap(),
        cache_creation_tokens: recorded["cachedWriteTokens"].as_u64().unwrap(),
        cost_usd: None,
    };
    assert_eq!(seen[used].body, want);
}

#[tokio::test]
async fn gemini_the_guard_goes_once_as_the_first_block_of_the_first_prompt() {
    let (rig, _, _) = play(&acp().join("r2-ask.jsonl"), None).await;
    let prompts: Vec<Value> = rig.sent().into_iter().filter(|line| line["method"] == "session/prompt").collect();
    assert_eq!(prompts.len(), 2);
    let first = prompts[0]["params"]["prompt"].as_array().unwrap();
    assert_eq!((first.len(), &first[0]["_meta"]["gossamr"]), (2, &json!("guard")));
    assert!(first[0]["text"].as_str().unwrap().contains("Never turn off commit signing"));
    assert_eq!(prompts[1]["params"]["prompt"].as_array().unwrap().len(), 1, "the second prompt has none");
}

#[tokio::test]
async fn gemini_a_load_resumes_by_session_id_with_a_fresh_token_and_a_token_is_refused_once_its_session_ended() {
    let (rig, id, _) = play(&acp().join("4-resume-mcp.jsonl"), None).await;
    assert_eq!(rig.report(), "", "session/load named the stored session");
    let (old, endpoint) = rig.seen.lock().unwrap()[0].clone();
    // The endpoint refuses a token it does not know as it refuses a path it does not serve: 404, with no reply.
    let refused = |answer: Result<harness::tools::Reply, String>| answer.is_err_and(|why| why.contains("404"));
    assert!(refused(endpoint.call(old.expose(), "nothing", json!({})).await), "the token of a session that ended is refused");
    // A second start of the same session, on a recording that keeps it running.
    let held = Rec::loading().stay().write(rig.recs.path());
    rig.harness.shutdown().await;
    let again = rig_at(&rig.data, reopen(&rig.data).await, &held);
    let mut events = again.harness.resume_with(&id, None).await.unwrap();
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    let (new, endpoint) = again.seen.lock().unwrap()[0].clone();
    assert_ne!(new, old, "a fresh token");
    assert!(refused(endpoint.call(old.expose(), "nothing", json!({})).await), "the old token is refused");
    assert!(!refused(endpoint.call(new.expose(), "nothing", json!({})).await), "the new one opens the endpoint");
    again.harness.close(&id).unwrap();
    until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
    assert!(refused(endpoint.call(new.expose(), "nothing", json!({})).await), "and is refused once that start ended");
    let secret: Value = serde_json::from_slice(&std::fs::read(again.out.join("secret.json")).unwrap()).unwrap();
    assert_eq!(secret, json!({"env": [], "argv": 0}), "the token is in no argument and no variable of agy's");
}

/// A rig on the data folder `data`, after the one before is done with it, whose `agy` plays `fixture`.
fn rig_at(data: &Path, store: Store, fixture: &Path) -> Rig {
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let env = vec![
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
        ("WIRE_REPLAY_FIXTURE".to_owned(), fixture.display().to_string()),
        ("WIRE_REPLAY_OUT".to_owned(), out.display().to_string()),
    ];
    let seen = Arc::new(Mutex::new(vec![]));
    let driver = Seeing { inner: GeminiDriver::new(REPLAY.into()).with_timing(timing()), seen: seen.clone(), secret_file: tmp.path().join("secret") };
    let harness = harness_on(data, store, driver, env);
    let (_, written) = tokio::sync::watch::channel(0);
    Rig { tmp, out, data: data.to_path_buf(), harness, written, seen, recs: tempfile::tempdir().unwrap() }
}

#[test]
fn gemini_the_token_goes_only_in_the_session_requests_authorization_header() {
    let mut tools = ToolsEndpoint::unattached();
    tools.tools = vec!["ask".into()];
    let token = Secret::random();
    let launch = Launch {
        cwd: "/nowhere".into(),
        locked: false,
        model: None,
        login: None,
        effort: None,
        permissions: Default::default(),
        resume: None,
        tools_token: token.clone(),
        tools: tools.clone(),
        result_schema: None,
        env: vec![],
    };
    let (method, params) = harness::gemini::driver::session_request(&launch);
    assert_eq!(method, "session/new");
    let header = json!({"name": "Authorization", "value": format!("Bearer {}", token.expose())});
    assert_eq!(params["mcpServers"], json!([{"type": "http", "name": tools.name, "url": tools.url, "headers": [header]}]));
    let (method, params) = harness::gemini::driver::session_request(&Launch { resume: Some("s-1".into()), ..launch });
    assert_eq!((method, &params["sessionId"]), ("session/load", &json!("s-1")));
}

/// A recording written for a test: the setup agy answers, then what the test adds, each line `ms` after the start.
struct Rec {
    lines: Vec<Value>,
}

const SESSION: &str = "5a5a5a5a-1b1b-4c2c-8d3d-9e9e9e9e9e9e";

impl Rec {
    fn new() -> Rec {
        Rec::setup("session/new", json!({}))
    }

    /// The setup of a start that loads the session.
    fn loading() -> Rec {
        Rec::setup("session/load", json!({"sessionId": SESSION}))
    }

    fn setup(method: &str, mut params: Value) -> Rec {
        let mut rec = Rec { lines: vec![] };
        rec.client(0, json!({"id": 1, "method": "initialize", "params": {}}));
        rec.agent(0, json!({"id": 1, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": true}}}));
        params["cwd"] = json!("/x");
        params["mcpServers"] = json!([{"type": "http", "name": "own", "url": "http://127.0.0.1:1/mcp", "headers": [{"name": "Authorization", "value": "Bearer x"}]}]);
        rec.client(0, json!({"id": 2, "method": method, "params": params}));
        let answer = if method == "session/new" { json!({"sessionId": SESSION}) } else { json!({}) };
        rec.agent(0, json!({"id": 2, "result": answer}));
        rec
    }

    fn line(&mut self, ms: u64, dir: &str, data: Value) -> &mut Rec {
        let seq = self.lines.len() as u64 + 1;
        let mut data = data;
        if dir != "driver" {
            data["jsonrpc"] = json!("2.0");
        }
        self.lines.push(json!({"seq": seq, "ms": ms, "dir": dir, "data": data}));
        self
    }

    fn client(&mut self, ms: u64, data: Value) -> &mut Rec {
        self.line(ms, "to_agent", data)
    }

    fn agent(&mut self, ms: u64, data: Value) -> &mut Rec {
        self.line(ms, "from_agent", data)
    }

    /// The seq of the last line.
    fn last(&self) -> u64 {
        self.lines.len() as u64
    }

    fn prompt(&mut self, id: u64, text: &str) -> &mut Rec {
        self.client(0, json!({"id": id, "method": "session/prompt", "params": {"sessionId": SESSION, "prompt": [{"type": "text", "text": text}]}}))
    }

    fn end_turn(&mut self, ms: u64, id: u64) -> &mut Rec {
        self.agent(ms, json!({"id": id, "result": {"stopReason": "end_turn"}}))
    }

    fn update(&mut self, ms: u64, update: Value) -> &mut Rec {
        self.agent(ms, json!({"method": "session/update", "params": {"sessionId": SESSION, "update": update}}))
    }

    fn chunk(&mut self, ms: u64, text: &str) -> &mut Rec {
        self.update(ms, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}))
    }

    fn usage(&mut self, ms: u64) -> &mut Rec {
        self.update(ms, json!({"sessionUpdate": "usage_update", "used": 1, "size": 2}))
    }

    fn call(&mut self, ms: u64, id: &str, name: &str, kind: &str) -> &mut Rec {
        self.update(ms, json!({"sessionUpdate": "tool_call", "toolCallId": id, "name": name, "args": {}, "status": "in_progress", "kind": kind, "title": name}))
    }

    fn done(&mut self, ms: u64, id: &str) -> &mut Rec {
        self.update(ms, json!({"sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed", "rawOutput": {"output": ""}}))
    }

    fn ask(&mut self, ms: u64, id: &str, name: &str) -> &mut Rec {
        let call = json!({"toolCallId": format!("call_{id}"), "name": name, "args": {}, "kind": "other", "status": "pending"});
        let options = json!([{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]);
        self.agent(ms, json!({"id": id, "method": "session/request_permission", "params": {"sessionId": SESSION, "toolCall": call, "options": options}}))
    }

    fn answered(&mut self, id: &str, option: &str) -> &mut Rec {
        self.client(0, json!({"id": id, "result": {"outcome": {"outcome": "selected", "optionId": option}}}))
    }

    fn child(&mut self, ms: u64) -> &mut Rec {
        self.line(0, "driver", json!({"note": "spawn_child", "detail": {"ms": ms}}))
    }

    fn close(&mut self) -> &mut Rec {
        self.line(0, "driver", json!({"note": "close_stdin"}))
    }

    /// The agent outlives its stdin, as agy with a command running does.
    fn stay(&mut self) -> &mut Rec {
        self.line(0, "driver", json!({"note": "still_running_killing"}))
    }

    fn write(&self, dir: &Path) -> PathBuf {
        let file = dir.join(format!("rec-{}.jsonl", harness::driver::random_hex(4)));
        std::fs::write(&file, self.lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
        file
    }
}

/// A session on a test's recording, with its client.
async fn on(rec: &Rec, pace: Option<&str>) -> (Rig, String, Client) {
    let rig = rig_of(rec, pace, &[]);
    let (id, events) = rig.open().await;
    let client = Client::follow(&rig.harness, &id, events, vec![]);
    client.until("the session's start", |seen| seen.iter().any(|event| matches!(event.body, Body::Started { .. }))).await;
    (rig, id, client)
}

fn projected(client: &Client) -> Vec<String> {
    let seen: Vec<Event> = client.events().into_iter().filter(|event| !matches!(event.body, Body::Usage { .. })).collect();
    project(&seen)
}

#[tokio::test]
async fn gemini_allow_once_goes_by_itself_only_for_an_exact_own_tool_name() {
    let mut rec = Rec::new();
    rec.prompt(3, "go");
    // The endpoint's own `ask`, then another server's, then names a prefix rule would take for the endpoint's.
    for (id, name) in [("a1", "mcp_<endpoint>_ask"), ("a2", "mcp_other_ask"), ("a3", "mcp_<endpoint>_ask_more"), ("a4", "mcp_<endpoint>x_ask"), ("a5", "mcp_<endpoint>_")] {
        rec.ask(0, id, name);
        rec.answered(id, if id == "a1" { "allow" } else { "deny" });
    }
    rec.end_turn(0, 3).close();
    let (rig, id, client) = on(&rec, None).await;
    rig.harness.send(&id, "go").unwrap();
    client.until("the first request", |seen| seen.iter().any(|event| matches!(event.body, Body::Permission { .. }))).await;
    for _ in 0..4 {
        let open: Vec<String> = client.events().iter().filter_map(|event| match &event.body {
            Body::Permission { id, .. } => Some(id.clone()),
            _ => None,
        }).collect();
        let answered = client.count(|body| matches!(body, Body::Answered { .. }));
        let Some(request) = open.get(answered) else { break };
        rig.harness.answer(&id, request, Decision::Deny, None).unwrap();
        client.until("the next request or the turn's end", |seen| seen.iter().filter(|event| matches!(event.body, Body::Permission { .. })).count() > answered + 1 || seen.iter().any(|event| event.body.ends_turn())).await;
    }
    client.until("the turn's end", |seen| seen.iter().any(|event| event.body.ends_turn())).await;
    rig.harness.close(&id).unwrap();
    client.closed().await;
    assert_eq!(rig.report(), "", "the own tool was allowed once by the driver, the rest as the client answered");
    let asked: Vec<String> = client.events().iter().filter_map(|event| match &event.body {
        Body::Permission { tool, .. } => Some(tool.clone()),
        _ => None,
    }).collect();
    let name = &rig.seen.lock().unwrap()[0].1.name.clone();
    let named = |tool: &str| tool.replace("<endpoint>", name);
    assert_eq!(asked, [named("mcp_other_ask"), named("mcp_<endpoint>_ask_more"), named("mcp_<endpoint>x_ask"), named("mcp_<endpoint>_")], "every other name came to the client");
}

#[tokio::test]
async fn gemini_a_run_whose_turn_ended_with_a_command_running_is_busy_until_the_command_ends() {
    let mut rec = Rec::new();
    rec.prompt(3, "run it").child(1_500).call(0, "c1", "run_command", "execute").end_turn(0, 3);
    rec.done(2_500, "c1").close();
    let (rig, id, client) = on(&rec, Some("1")).await;
    rig.harness.send(&id, "run it").unwrap();
    client.until("the turn's end", |seen| seen.iter().any(|event| event.body.ends_turn())).await;
    client.until("busy", |seen| seen.iter().any(|event| event.body == Body::Background { running: true })).await;
    let child = rig.child();
    assert!(process::alive(&child), "busy while the command runs");
    assert_eq!(client.count(|body| *body == Body::Background { running: false }), 0, "and not finished");
    client.until("not busy", |seen| seen.iter().any(|event| event.body == Body::Background { running: false })).await;
    assert!(!process::alive(&child), "no longer busy once it ended");
    client.until("its result", |seen| seen.iter().any(|event| matches!(event.body, Body::ToolResult { .. }))).await;
    rig.harness.close(&id).unwrap();
    client.closed().await;
    let order: Vec<String> = projected(&client).into_iter().filter(|line| line != "closed").collect();
    assert_eq!(order, ["started", "prompted 6", "turn_started", "tool_call run_command 0 {} 0", "turn_ended done", "background", "background", "tool_result 0 ok {output} 1"]);
}

#[tokio::test]
async fn gemini_stop_kills_a_command_that_outlived_session_cancel() {
    let mut rec = Rec::new();
    rec.prompt(3, "run it").child(60_000).call(0, "c1", "run_command", "execute");
    rec.client(0, json!({"method": "session/cancel", "params": {"sessionId": SESSION}}));
    rec.agent(0, json!({"id": 3, "result": {"stopReason": "cancelled"}})).stay();
    let (rig, id, client) = on(&rec, None).await;
    rig.harness.send(&id, "run it").unwrap();
    client.until("the call", |seen| seen.iter().any(|event| matches!(event.body, Body::ToolCall { .. }))).await;
    rig.harness.cancel(&id).unwrap();
    client.until("the turn's end", |seen| seen.iter().any(|event| event.body == Body::TurnEnded { how: TurnEnd::Cancelled })).await;
    let child = rig.child();
    assert!(process::alive(&child), "the command outlived the cancel");
    rig.harness.close(&id).unwrap();
    client.closed().await;
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while process::alive(&child) {
        assert!(tokio::time::Instant::now() < given, "Stop left the command running");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Starts a turn of agy's own: a prompted turn that ends at once, then `then` after it, unprompted.
fn after_a_turn(then: impl FnOnce(&mut Rec)) -> Rec {
    let mut rec = Rec::new();
    rec.prompt(3, "go").end_turn(0, 3);
    then(&mut rec);
    rec
}

/// The projection's turn boundaries and texts, in order.
fn turns(client: &Client) -> Vec<String> {
    projected(client).into_iter().filter(|line| line.starts_with("turn_") || line.starts_with("text") || line.starts_with("prompted")).collect()
}

async fn unprompted(rec: Rec, settle: Duration) -> (Rig, String, Client) {
    let (rig, id, client) = on(&rec, Some("1")).await;
    rig.harness.send(&id, "go").unwrap();
    rig.played(rec.last().saturating_sub(1)).await;
    tokio::time::sleep(settle).await;
    (rig, id, client)
}

async fn closed(rig: &Rig, id: &str, client: &Client) {
    rig.harness.close(id).unwrap();
    client.closed().await;
    assert_eq!(rig.report(), "");
}

#[tokio::test]
async fn gemini_r7_background_gives_its_unprompted_turn_one_start_and_one_end_and_a_prompt_after_it_runs() {
    let (_rig, _, seen) = play(&acp().join("r7-background.jsonl"), Some("0.1")).await;
    let starts = seen.iter().filter(|event| event.body == Body::TurnStarted).count();
    let ends = seen.iter().filter(|event| event.body.ends_turn()).count();
    assert_eq!((starts, ends), (2, 2), "the prompted turn and agy's own: {:?}", types(&seen));
    // The same shape with a prompt after agy's own turn: it runs as a turn of its own.
    let mut rec = after_a_turn(|rec| {
        rec.chunk(100, "by myself").usage(150);
    });
    rec.prompt(4, "and now").chunk(0, "ok").end_turn(0, 4).close();
    let (rig, id, client) = on(&rec, Some("1")).await;
    rig.harness.send(&id, "go").unwrap();
    client.until("agy's own turn's end", |seen| seen.iter().filter(|event| event.body.ends_turn()).count() == 2).await;
    rig.harness.send(&id, "and now").unwrap();
    client.until("the prompt's turn's end", |seen| seen.iter().filter(|event| event.body.ends_turn()).count() == 3).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 9", "turn_ended done", "prompted 7", "turn_started", "text 2", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_an_unprompted_turn_with_two_usage_updates_stays_one_turn() {
    let rec = after_a_turn(|rec| {
        rec.chunk(100, "one").usage(150).chunk(300, "two").usage(350).close();
    });
    let (rig, id, client) = unprompted(rec, Duration::from_millis(1_200)).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 3", "text 3", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_an_unprompted_turn_holding_an_open_call_does_not_end_while_it_is_silent() {
    // Silent four times the quiet while `ask` is held on the endpoint, short of agy's cut.
    let rec = after_a_turn(|rec| {
        rec.chunk(100, "asking").call(150, "k1", "mcp_spike_ask", "other").done(1_300, "k1").chunk(1_350, "answered").close();
    });
    let (rig, id, client) = unprompted(rec, Duration::from_millis(1_200)).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 6", "text 8", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_an_open_call_with_no_update_holds_the_turn_only_up_to_agys_cut_and_the_margin() {
    // The call never gets its update; agy's next message comes well past the cut and the margin.
    let rec = after_a_turn(|rec| {
        rec.chunk(100, "asking").call(150, "k1", "mcp_spike_ask", "other").chunk(3_000, "later").close();
    });
    let (rig, id, client) = unprompted(rec, Duration::from_millis(1_200)).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 6", "turn_ended done", "turn_started", "text 5", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_a_commands_open_call_with_no_descendant_running_does_not_hold_the_turn() {
    let rec = after_a_turn(|rec| {
        // The next message comes after the quiet but within the cut, so an open call would have held the turn.
        rec.chunk(100, "running").call(150, "c1", "run_command", "execute").chunk(1_400, "later").close();
    });
    let (rig, id, client) = unprompted(rec, Duration::from_millis(1_200)).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 7", "turn_ended done", "turn_started", "text 5", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_a_delayed_continuation_gives_two_unprompted_turns() {
    // Twice the quiet with nothing open, then agy goes on.
    let rec = after_a_turn(|rec| {
        rec.chunk(100, "first").chunk(1_100, "second").close();
    });
    let (rig, id, client) = unprompted(rec, Duration::from_millis(1_200)).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 5", "turn_ended done", "turn_started", "text 6", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_a_prompt_during_the_pause_of_a_delayed_continuation_gets_the_late_updates_and_one_end() {
    let mut rec = after_a_turn(|rec| {
        rec.chunk(100, "first");
    });
    let pause = rec.last();
    rec.prompt(4, "and now").chunk(1_100, "second").chunk(1_150, "answer").end_turn(1_200, 4).close();
    let (rig, id, client) = on(&rec, Some("1")).await;
    rig.harness.send(&id, "go").unwrap();
    rig.played(pause).await;
    // Within the quiet: agy's message has paused, not ended.
    tokio::time::sleep(Duration::from_millis(200)).await;
    rig.harness.send(&id, "and now").unwrap();
    client.until("the prompt's turn's end", |seen| seen.iter().filter(|event| event.body.ends_turn()).count() == 3).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    closed(&rig, &id, &client).await;
    assert_eq!(turns(&client), ["prompted 2", "turn_started", "turn_ended done", "turn_started", "text 5", "turn_ended done", "prompted 7", "turn_started", "text 12", "turn_ended done"]);
}

#[tokio::test]
async fn gemini_a_model_and_an_effort_go_only_when_chosen_other_than_the_default() {
    let mut rec = Rec::new();
    rec.close();
    let options = |rig: &Rig| -> Vec<(Value, Value)> {
        rig.sent().into_iter().filter(|line| line["method"] == "session/set_config_option").map(|line| (line["params"]["configId"].clone(), line["params"]["value"].clone())).collect()
    };
    for (model, effort, want) in [
        (None, None, vec![]),
        (Some("default"), Some("default"), vec![]),
        (Some("gemini-3.8-flash"), Some("high"), vec![(json!("model"), json!("gemini-3.8-flash")), (json!("thought_level"), json!("high"))]),
    ] {
        let rig = rig_of(&rec, None, &[]);
        let spec = Open { provider: "gemini".into(), cwd: rig.tmp.path().to_path_buf(), model: model.map(str::to_owned), effort: effort.map(str::to_owned), ..Open::default() };
        let (id, mut events) = rig.harness.open(spec).await.unwrap();
        until(&mut events, |body| matches!(body, Body::Started { .. })).await;
        rig.harness.close(&id).unwrap();
        until(&mut events, |body| matches!(body, Body::Closed { .. })).await;
        assert_eq!(rig.report(), "");
        assert_eq!(options(&rig), want, "model {model:?}, effort {effort:?}");
    }
}

#[tokio::test]
async fn gemini_a_locked_session_is_refused() {
    let rig = rig_of(&Rec::new(), None, &[]);
    let refused = rig.harness.open(Open { provider: "gemini".into(), locked: true, cwd: rig.tmp.path().to_path_buf(), ..Open::default() }).await;
    let mut events = match refused {
        Ok((_, events)) => events,
        Err(e) => return assert!(e.to_string().contains("locked"), "{e}"),
    };
    let failed = until(&mut events, |body| matches!(body, Body::Failed { .. } | Body::Closed { .. })).await;
    assert!(failed.iter().any(|event| matches!(&event.body, Body::Failed { reason, .. } if reason.contains("locked"))), "{:?}", types(&failed));
}

#[tokio::test]
async fn gemini_a_leftover_agy_from_a_dead_harness_is_stopped_by_its_stored_pid_and_start_time() {
    let mut rec = Rec::new();
    rec.stay();
    let first = rig_of(&rec, None, &[("WIRE_REPLAY_IGNORE_TERM", "1")]);
    let (id, mut events) = first.open().await;
    until(&mut events, |body| matches!(body, Body::Started { .. })).await;
    let pid: u32 = std::fs::read_to_string(first.out.join("pid")).unwrap().trim().parse().unwrap();
    let agent = Process { pid, started: process::started_of(pid).expect("the replay runs") };
    // An agy the shutdown cannot stop: it ignores SIGTERM, its group kill is refused once, and the listing that would
    // settle the refusal proves nothing, that once.
    process::seam::refuse_group_kills(agent.pid, 1);
    process::seam::list_group_once_as(agent.pid, Listing::Full);
    assert_eq!(first.harness.shutdown().await, std::slice::from_ref(&id), "the shutdown gave up on it");
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while !process::seam::sent_to(agent.pid).contains(&libc::SIGKILL) {
        assert!(tokio::time::Instant::now() < given, "the driver tried to kill it");
        tokio::task::yield_now().await;
    }
    assert!(process::alive(&agent), "and it runs on");
    let store = reopen(&first.data).await;
    assert_eq!(store.agents().unwrap(), [(id.clone(), agent.clone())], "its pid and start time are on record");
    let second = rig_at_with(&first.data, &rec.write(first.recs.path()), store);
    let given = tokio::time::Instant::now() + Duration::from_secs(10);
    while process::alive(&agent) {
        assert!(tokio::time::Instant::now() < given, "the next harness left agy running");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    second.shutdown().await;
    assert_eq!(Store::open(&first.data).unwrap().agents().unwrap(), [], "its agent gone, nothing is on record");
}

fn rig_at_with(data: &Path, fixture: &Path, store: Store) -> Harness {
    let env = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned()), ("WIRE_REPLAY_FIXTURE".to_owned(), fixture.display().to_string())];
    harness_on(data, store, GeminiDriver::new(REPLAY.into()).with_timing(timing()), env)
}
