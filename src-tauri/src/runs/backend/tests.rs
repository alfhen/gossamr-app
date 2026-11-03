use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::claude::ClaudeBackend;
use super::*;
use crate::domain::RunState;
use crate::runs::cli::CliError;
use crate::runs::state::Observed;
use crate::runs::env::RunEnv;
use crate::runs::report::{new_token, well_formed};
use crate::runs::rig::{backed_by, ready_with};
use crate::runs::testing::FakeCli;

fn offer(run_id: &str) -> ToolsOffer {
    ToolsOffer { run_id: run_id.into(), url: format!("http://127.0.0.1:4321/agent/{run_id}"), token: new_token().unwrap() }
}

fn request(tools: Option<ToolsOffer>) -> LaunchRequest {
    LaunchRequest {
        cwd: PathBuf::from("/work/clone"),
        name: "Fix the cart".into(),
        worktree: "eng-1-fix-cart-0001".into(),
        guard: "Guard.".into(),
        prompt: "Do it.".into(),
        tools,
        model: None,
        fresh_id: ShortId::parse("0a1b2c3d").unwrap(),
    }
}

fn dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gossamr-backend-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn the_tools_offer_never_prints_its_token() {
    let offer = offer("run-1");
    assert!(offer.token.len() == 52 && offer.token.starts_with("gsr_") && well_formed(&offer.token));
    let secret = &offer.token[4..];
    assert!(!format!("{offer:?}").contains(secret));
    let request = request(Some(offer.clone()));
    let printed = format!("{request:?}");
    assert!(printed.contains("run-1") && !printed.contains(secret), "{printed}");
}

#[tokio::test]
async fn the_claude_backend_writes_a_private_mcp_file_from_the_offer_and_passes_only_its_path() {
    let files = dir("file").join("agents");
    let cli = Arc::new(FakeCli::new());
    let backend = ClaudeBackend::new(cli.clone(), Arc::new(RunEnv::from_pairs([("PATH", "/bin")])), files.clone(), "claude".into(), "Claude".into(), false);
    let offer = offer("run-1");
    let session = backend.launch(&request(Some(offer.clone()))).await.unwrap();
    assert_eq!((session.session_id, session.process), (None, None));

    let sent = cli.0.lock().unwrap().launches[0].clone();
    let config = sent.agent.clone().expect("the path is passed").config;
    assert_eq!(config, files.join("run-1.json"));
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!((mode(&config), mode(&files)), (0o600, 0o700));
    let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    let server = &written["mcpServers"]["gossamr"];
    assert_eq!(server["url"], offer.url);
    assert_eq!(server["headers"]["Authorization"], format!("Bearer {}", offer.token));
    let secret = &offer.token[4..];
    assert!(!format!("{sent:?}").contains(secret) && !sent.guard.contains(secret) && !sent.prompt.contains(secret) && !sent.name.contains(secret));
    let _ = std::fs::remove_dir_all(files.parent().unwrap());
}

#[test]
fn a_second_mcp_file_for_a_run_replaces_the_first_and_a_bad_run_id_writes_nothing() {
    let files = dir("replace").join("agents");
    let (first, second) = (offer("run-1"), offer("run-1"));
    let launch = claude::write_mcp_file(&files, &first).unwrap();
    claude::write_mcp_file(&files, &second).unwrap();
    let text = std::fs::read_to_string(&launch.config).unwrap();
    assert!(text.contains(&second.token) && !text.contains(&first.token));
    assert!(!format!("{launch:?}").contains(&second.token[4..]), "the launch prints a path, never the token");
    for bad in ["", "../x", "a/b", "a b", "..", &"a".repeat(65)] {
        assert!(claude::write_mcp_file(&files, &offer(bad)).is_err(), "{bad:?}");
    }
    assert_eq!(std::fs::read_dir(&files).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(files.parent().unwrap());
}

#[tokio::test]
async fn the_claude_backend_adds_the_tools_guard_only_once_its_file_is_written() {
    let files = dir("guard").join("agents");
    let cli = Arc::new(FakeCli::new());
    let backend = ClaudeBackend::new(cli.clone(), Arc::new(RunEnv::from_pairs([("PATH", "/bin")])), files.clone(), "claude".into(), "Claude".into(), false);
    backend.launch(&request(Some(offer("run-1")))).await.unwrap();
    backend.launch(&request(Some(offer("../bad")))).await.unwrap();
    let launches = cli.0.lock().unwrap().launches.clone();
    assert_eq!(launches[0].guard, format!("Guard. {}", crate::domain::AGENT_GUARD));
    assert!(launches[1].agent.is_none() && launches[1].guard == "Guard.");
    let _ = std::fs::remove_dir_all(files.parent().unwrap());
}

#[tokio::test]
async fn the_claude_backend_launches_without_tools_when_none_are_offered() {
    let files = dir("none").join("agents");
    let cli = Arc::new(FakeCli::new());
    let backend = ClaudeBackend::new(cli.clone(), Arc::new(RunEnv::from_pairs([("PATH", "/bin")])), files.clone(), "claude".into(), "Claude".into(), false);
    backend.launch(&request(None)).await.unwrap();
    let sent = cli.0.lock().unwrap().launches[0].clone();
    assert!(sent.agent.is_none() && sent.guard == "Guard." && !files.exists());
}

/// What a scripted backend reports of every run it is asked to observe.
#[derive(Clone)]
pub(in crate::runs) struct Seen {
    pub state: RunState,
    pub text: Option<String>,
    pub answer: Option<String>,
}

#[derive(Default)]
pub(in crate::runs) struct Recorder {
    pub preflights: Mutex<Vec<PathBuf>>,
    pub launches: Mutex<Vec<LaunchRequest>>,
    pub refuse: Mutex<Option<Failure>>,
    /// What every run is observed as; a test replaces it between looks.
    pub script: Mutex<Option<Seen>>,
    /// What each look at the runs was handed.
    pub looked_at: Mutex<Vec<Vec<Watched>>>,
    pub found: Mutex<Option<Session>>,
    pub searched: Mutex<Vec<String>>,
    /// Every action asked of the backend, as `name` or `name:argument`.
    pub actions: Mutex<Vec<String>>,
    pub signed_out: std::sync::atomic::AtomicBool,
    pub not_asking: std::sync::atomic::AtomicBool,
    pub open_in_terminal: std::sync::atomic::AtomicBool,
    pub attach_stops_the_run: std::sync::atomic::AtomicBool,
    pub trust_at: Mutex<Option<PathBuf>>,
}

impl Recorder {
    fn did(&self, action: impl Into<String>) {
        self.actions.lock().unwrap().push(action.into());
    }

    pub fn done(&self) -> Vec<String> {
        self.actions.lock().unwrap().clone()
    }
}

#[async_trait]
impl RunBackend for Recorder {
    async fn preflight(&self, clone: &Path) -> std::result::Result<(), Failure> {
        self.preflights.lock().unwrap().push(clone.to_path_buf());
        self.refuse.lock().unwrap().clone().map_or(Ok(()), Err)
    }

    async fn launch(&self, req: &LaunchRequest) -> std::result::Result<Session, Failure> {
        self.launches.lock().unwrap().push(req.clone());
        Ok(Session { short_id: req.fresh_id.clone(), session_id: Some("thread-1".into()), process: None })
    }

    async fn folders(&self) -> Folders {
        Folders::default()
    }

    async fn observe(&self, watched: &[Watched], _dirs: &Folders, _now: DateTime<Utc>) -> BackendResult<Observations> {
        self.looked_at.lock().unwrap().push(watched.to_vec());
        let step = self.script.lock().unwrap().clone();
        let Some(step) = step else { return Ok(Observations::default()) };
        let runs = watched
            .iter()
            .map(|w| Observation {
                run_id: w.run.id.clone(),
                seen: Observed { state: step.state, text: step.text.clone(), error: None, result: None, pid_misses: 0, idle_polls: 0 },
                session: w.run.short_id.clone().map(|short_id| Session { short_id, session_id: Some("thread-1".into()), process: None }),
                tokens: None,
                detail: None,
                branch: None,
                progress_at: None,
                suggested_reply: None,
                timeline: Vec::new(),
                answer: step.answer.clone(),
                revived: false,
            })
            .collect();
        Ok(Observations { runs, sessions: Vec::new() })
    }

    async fn find(&self, run: &Run, _dirs: &Folders) -> BackendResult<Option<Session>> {
        self.searched.lock().unwrap().push(run.id.clone());
        Ok(self.found.lock().unwrap().clone())
    }

    async fn final_answer(&self, _run: &Run, _dirs: &Folders) -> Option<String> {
        None
    }

    fn binary(&self) -> Option<PathBuf> {
        Some(PathBuf::from("/opt/fake/bin/recorder"))
    }

    async fn signed_in(&self) -> BackendResult<bool> {
        self.did("signed_in");
        Ok(!self.signed_out.load(std::sync::atomic::Ordering::SeqCst))
    }

    async fn trust_file(&self) -> std::result::Result<Option<PathBuf>, crate::runs::trust::Refusal> {
        self.did("trust_file");
        Ok(self.trust_at.lock().unwrap().clone())
    }

    async fn ready_for_answer(&self, session: &Session, _run: &Run) -> BackendResult<bool> {
        self.did(format!("ready_for_answer:{}", session.short_id));
        Ok(!self.not_asking.load(std::sync::atomic::Ordering::SeqCst))
    }

    async fn open_elsewhere(&self, session: &Session, _run: &Run) -> BackendResult<bool> {
        self.did(format!("open_elsewhere:{}", session.short_id));
        Ok(self.open_in_terminal.load(std::sync::atomic::Ordering::SeqCst))
    }

    async fn stop(&self, session: &Session) -> BackendResult<()> {
        self.did(format!("stop:{}", session.short_id));
        Ok(())
    }

    fn ask_ended(&self, run: &Run) {
        self.did(format!("ask_ended:{}", run.id));
    }

    async fn resume(&self, session: &Session, req: &ResumeRequest, _waits: &Waits) -> BackendResult<Resumed> {
        self.did(format!("resume:{}:{}:{}", session.short_id, req.settle, req.finished));
        Ok(Resumed::Same(session.clone()))
    }

    async fn remove(&self, run: &Run, leftovers: &[ShortId], _waits: &Waits) -> BackendResult<RemoveOutcome> {
        self.did(format!("remove:{}:{}", run.id, leftovers.len()));
        Ok(RemoveOutcome::Removed { gone: leftovers.to_vec(), kept: None })
    }

    async fn prepare_attach(&self, session: &Session) -> BackendResult<bool> {
        self.did(format!("prepare_attach:{}", session.short_id));
        Ok(self.attach_stops_the_run.load(std::sync::atomic::Ordering::SeqCst))
    }

    fn attach_words(&self, session: &Session) -> Vec<String> {
        self.did(format!("attach_words:{}", session.short_id));
        vec!["resume".into(), session.short_id.to_string()]
    }

    fn terminal_words(&self, _purpose: Purpose) -> Option<Vec<String>> {
        Some(Vec::new())
    }

    fn scratch_dir(&self, session: &Session, _dirs: &Folders) -> BackendResult<PathBuf> {
        self.did(format!("scratch_dir:{}", session.short_id));
        Ok(std::env::temp_dir().join(format!("gossamr-recorder-scratch-{}", session.short_id)))
    }
}

#[tokio::test]
async fn a_run_is_checked_and_launched_through_its_toolchains_backend_alone() {
    let backend = Arc::new(Recorder::default());
    let rig = ready_with(backed_by(backend.clone())).await;
    let run = rig.launched(1).await;

    assert_eq!(rig.cli.launches(), 0, "nothing reached claude");
    assert_eq!(*backend.preflights.lock().unwrap(), std::slice::from_ref(&rig.clone));
    let launches = backend.launches.lock().unwrap().clone();
    let [sent] = launches.as_slice() else { panic!("{launches:?}") };
    assert_eq!((sent.cwd.clone(), sent.worktree.as_str()), (rig.clone.clone(), run.spec.name.as_str()));
    assert_eq!((run.short_id.as_ref(), run.session_id.as_deref()), (Some(&sent.fresh_id), Some("thread-1")));
    assert!(rig.fx.core.short_id_in_use(&sent.fresh_id).await.unwrap(), "the id is stored, so no later launch is given it");
    assert!(!rig.fx.core.short_id_in_use(&ShortId::parse("00000000").unwrap()).await.unwrap());
}

#[tokio::test]
async fn a_backend_that_refuses_in_preflight_fails_the_run_before_any_launch() {
    let backend = Arc::new(Recorder::default());
    *backend.refuse.lock().unwrap() = Some(Failure::NotSignedIn { instance: "Codex".into(), own_folder: false });
    let rig = ready_with(backed_by(backend.clone())).await;
    let queued = rig.fx.core.queue_test_run(rig.spec(1), Some(rig.fx.item("CA-1"))).await.unwrap();
    let run = rig.svc.start_now(&queued.id).await.unwrap();
    assert_eq!(run.state, crate::domain::RunState::Failed);
    assert!(run.error.as_deref().unwrap().starts_with("Codex isn't signed in"));
    assert!(backend.launches.lock().unwrap().is_empty());
}

#[test]
fn a_backend_error_shows_the_program_that_built_it() {
    let every = || {
        vec![
            CliError::Spawn(std::io::Error::other("no such file")),
            CliError::TimedOut,
            CliError::Failed { code: Some(1), stderr: "boom\nsomething broke\n".into() },
            CliError::Unparseable { stdout: "hm".into() },
            CliError::Output("expected a list".into()),
        ]
    };
    for (before, after) in every().into_iter().zip(every()) {
        let words = before.to_string();
        assert_eq!(BackendError::from(after).to_string(), words, "Claude's words are unchanged");
    }
    let codex = [
        BackendError::Spawn { program: "codex", source: std::io::Error::other("no such file") },
        BackendError::TimedOut { program: "codex" },
        BackendError::Failed { program: "codex", code: Some(1), stderr: "boom\nnot logged in".into() },
        BackendError::Output { program: "codex", text: "not json".into() },
    ];
    for e in codex {
        let words = e.to_string();
        assert!(words.contains("codex") && !words.to_lowercase().contains("claude"), "{words}");
        assert_eq!(Error::from(e).to_string(), Error::Claude(words.clone()).to_string());
    }
    assert!(BackendError::Failed { program: "codex", code: None, stderr: "a\nnot logged in\n".into() }.to_string().ends_with("not logged in"));
}

#[tokio::test]
async fn the_claude_backend_reports_its_folders_and_finds_a_session_by_its_listing() {
    use crate::runs::rig::ready;
    let rig = ready().await;
    let run = rig.launched(1).await;
    let config = rig.fx.dir.join("claude-config");
    let tc = rig.svc.tools.get().await.unwrap();
    let dirs = tc.backend.folders().await;
    assert_eq!((dirs.config_dir, dirs.projects_dir), (Some(config.clone()), Some(config.join("projects"))));

    let found = tc.backend.find(&run, &Folders::default()).await.unwrap().expect("listed under the worktree");
    assert_eq!(Some(&found.short_id), run.short_id.as_ref());
    let stranger = Run { short_id: None, expected_worktree: PathBuf::from("/elsewhere"), ..run.clone() };
    assert_eq!(tc.backend.find(&stranger, &Folders::default()).await.unwrap(), None);
    rig.cli.with(|s| s.list_fails = true);
    let error = tc.backend.find(&run, &Folders::default()).await.unwrap_err().to_string();
    assert!(error.starts_with("claude failed") && error.contains("daemon unavailable"), "{error}");
}

const SESSION: &str = "11111111-2222-4333-8444-555555555555";

fn count(done: &[String], action: &str) -> usize {
    done.iter().filter(|a| a.as_str() == action).count()
}

#[tokio::test]
async fn every_action_on_a_run_reaches_its_own_backend() {
    use crate::domain::Actor;
    use crate::runs::message::Delivery;
    let backend = Arc::new(Recorder::default());
    let rig = ready_with(backed_by(backend.clone())).await;
    let launched = rig.launched(1).await;
    let id = launched.short_id.clone().unwrap();
    let run = rig
        .set(&launched, |r| {
            r.session_id = Some(SESSION.into());
            r.state = RunState::Working;
        })
        .await;

    rig.svc.stop(&run.id).await.unwrap();
    assert_eq!(backend.done().last().map(String::as_str), Some(format!("stop:{id}").as_str()));

    let (_, delivery) = rig.svc.message_agent(&run.id, "Carry on.", Actor::Person).await.unwrap();
    assert_eq!(delivery, Delivery::Resumed);
    let done = backend.done();
    assert!(done.contains(&format!("open_elsewhere:{id}")) && done.contains(&format!("resume:{id}:true:true")), "{done:?}");

    rig.set(&run, |r| r.state = RunState::NeedsAnswer).await;
    rig.svc.answer(&run.id, "Staging.").await.unwrap();
    let done = backend.done();
    assert!(done.contains(&format!("ready_for_answer:{id}")) && done.contains(&format!("resume:{id}:true:false")), "{done:?}");
    assert_eq!(count(&done, &format!("stop:{id}")), 2, "the answer stopped the session before waking it");

    rig.svc.attach(&run.id).await.unwrap();
    let script = std::fs::read_to_string(rig.opened.0.lock().unwrap().last().unwrap()).unwrap();
    assert!(script.contains(&format!("exec '/opt/fake/bin/recorder' resume {id}")), "{script}");
    assert!(backend.done().contains(&format!("prepare_attach:{id}")));

    rig.svc.disk(&run.id).await.unwrap();
    assert!(backend.done().contains(&format!("scratch_dir:{id}")));

    backend.signed_out.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(crate::agent::AgentDriver::unready(rig.svc.as_ref(), None).await.is_some());
    assert_eq!(count(&backend.done(), "signed_in"), 1);

    rig.set(&run, |r| r.state = RunState::Done).await;
    rig.svc.cleanup(&run.id).await.unwrap();
    assert!(backend.done().contains(&format!("remove:{}:0", run.id)));
    assert_eq!(rig.cli.launches(), 0, "nothing reached claude");
}

#[tokio::test]
async fn a_live_answer_and_a_cancel_of_a_held_ask_both_tell_the_backend() {
    use crate::runs::ask::Outcome;
    let backend = Arc::new(Recorder::default());
    let rig = ready_with(backed_by(backend.clone())).await;
    let launched = rig.launched(1).await;
    let run = rig
        .set(&launched, |r| {
            r.session_id = Some(SESSION.into());
            r.state = RunState::Working;
        })
        .await;
    let ended = || count(&backend.done(), &format!("ask_ended:{}", run.id));
    let asks = rig.svc.core.asks();

    let held = asks.open(&run.id, "Which database?").unwrap();
    rig.svc.answer(&run.id, "Staging.").await.unwrap();
    assert_eq!((ended(), held.until(std::time::Duration::from_secs(1)).await), (1, Outcome::Answered("Staging.".into())));

    let _held = asks.open(&run.id, "Which branch?").unwrap();
    rig.svc.stop(&run.id).await.unwrap();
    assert_eq!(ended(), 2, "a stop ends the wait");

    rig.set(&run, |r| r.state = RunState::Working).await;
    let _held = asks.open(&run.id, "Which table?").unwrap();
    *backend.script.lock().unwrap() = Some(Seen { state: RunState::Done, text: None, answer: Some("Finished.".into()) });
    rig.poll().await;
    assert_eq!(ended(), 3, "the tracker cancels the wait of a run that ended");

    rig.set(&run, |r| r.state = RunState::Working).await;
    let timed_out = asks.open(&run.id, "Which schema?").unwrap().until(std::time::Duration::from_millis(10)).await;
    assert_eq!(timed_out, Outcome::TimedOut);
    *backend.script.lock().unwrap() = Some(Seen { state: RunState::Done, text: None, answer: Some("Finished.".into()) });
    rig.poll().await;
    assert_eq!(ended(), 3, "a call that timed out is not one the service ended");
}

#[tokio::test]
async fn retrying_with_trust_on_a_run_whose_backend_has_no_trust_file_is_refused_in_plain_words() {
    use crate::runs::rig::ready_in;
    let backend = Arc::new(Recorder::default());
    *backend.refuse.lock().unwrap() = Some(Failure::NeedsTrust { folder: PathBuf::from("/clone"), instance: "Codex".into(), own_folder: false });
    let fx = crate::inbox::testing::fixture_watching(&["acme/webshop"]).await;
    let home = fx.home.canonicalize().unwrap();
    let rig = ready_in(fx, &[("HOME", home.to_string_lossy().into_owned())], backed_by(backend.clone())).await;
    let queued = rig.queued(1).await;
    let run = rig.svc.start_now(&queued.id).await.unwrap();
    assert_eq!((run.state, run.short_id.is_none()), (RunState::Failed, true), "{:?}", run.error);

    let why = rig.svc.retry_with_trust(&run.id).await.unwrap_err().to_string();
    assert_eq!(why, "Codex has no trust step, so there is nothing to trust.");
    assert_eq!(backend.done(), vec!["trust_file".to_owned()]);
    assert!(!home.join(".claude.json").exists(), "nothing was written");
    assert!(backend.launches.lock().unwrap().is_empty());
}

#[tokio::test]
async fn opening_a_session_that_stops_the_run_cancels_its_held_ask_and_stores_it_stopped_first() {
    let backend = Arc::new(Recorder::default());
    backend.attach_stops_the_run.store(true, std::sync::atomic::Ordering::SeqCst);
    let rig = ready_with(backed_by(backend.clone())).await;
    let launched = rig.launched(1).await;
    let run = rig.set(&launched, |r| r.state = RunState::Working).await;
    let _held = rig.svc.core.asks().open(&run.id, "Which database?").unwrap();

    rig.svc.attach(&run.id).await.unwrap();

    let stored = rig.get(&run).await;
    assert_eq!((stored.state, stored.last_detail.as_deref()), (RunState::Stopped, Some("Opened in Terminal")));
    assert_eq!(rig.svc.core.asks().question(&run.id), None);
    assert!(backend.done().contains(&format!("ask_ended:{}", run.id)));
    assert_eq!(rig.opened.0.lock().unwrap().len(), 1, "Terminal was opened after the run was stored");
}
