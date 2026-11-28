//! The Gemini driver on the real `agy acp`, on the person's own login. Ignored: `cargo test -p harness -- --ignored
//! gemini_real`. Gemini has one login, `~/.gemini`, and no status command. The test reads only that folder's file list,
//! sizes and modification times, never what a file holds, before and after: agy writes its own per-session files
//! there (H0), and no settings, config or credential file may change. The session runs in a worktree of a scratch repo
//! whose remote is a local bare repo, and no process of it may be left.

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use common::real::{config_files, credential_files, working_in};
use common::*;
use harness::event::{Body, Decision, Event, TurnEnd};
use harness::gemini::driver::GeminiDriver;
use harness::session::{Harness, Open};
use harness::store::Store;

/// Every file under `folder`, by its path inside it, with its size and modification time.
fn listing(folder: &Path) -> BTreeMap<String, (u64, Option<SystemTime>)> {
    let mut files = BTreeMap::new();
    let mut left = vec![folder.to_path_buf()];
    while let Some(dir) = left.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
            if meta.is_dir() {
                left.push(entry.path());
            } else {
                let inside = entry.path().strip_prefix(folder).unwrap().display().to_string();
                files.insert(inside, (meta.len(), meta.modified().ok()));
            }
        }
    }
    files
}

/// A worktree of a scratch clone whose remote is a local bare repo, as a session works in.
fn scratch_worktree(tmp: &Path) -> std::path::PathBuf {
    let (clone, remote) = (tmp.join("clone"), tmp.join("remote.git"));
    let git = |args: &[&str]| assert!(std::process::Command::new("git").args(args).output().unwrap().status.success(), "git {}", args[0]);
    git(&["init", "-q", "--bare", remote.to_str().unwrap()]);
    git(&["init", "-q", clone.to_str().unwrap()]);
    for (key, value) in [("user.name", "Harness Test"), ("user.email", "test@example.invalid"), ("commit.gpgsign", "false")] {
        git(&["-C", clone.to_str().unwrap(), "config", key, value]);
    }
    git(&["-C", clone.to_str().unwrap(), "commit", "-q", "--allow-empty", "-m", "start"]);
    git(&["-C", clone.to_str().unwrap(), "remote", "add", "origin", remote.to_str().unwrap()]);
    let work = tmp.join("clone+worktrees").join("h8");
    git(&["-C", clone.to_str().unwrap(), "worktree", "add", "-q", work.to_str().unwrap(), "-b", "h8"]);
    work.canonicalize().unwrap()
}

const PROMPT: &str = "Do these steps in order. 1. Create the file notes.txt in the current folder containing exactly the line hello. \
    2. Call your ask tool to ask which colour to choose, and wait for its answer; if it says the question is pending, end your turn \
    and wait for the answer to come as the next message. 3. Once you have the colour, write it in lower case into colour.txt, \
    then call your result tool with `colour` set to exactly that colour, in lower case. Use no tool beyond these.";

#[tokio::test]
#[ignore]
async fn gemini_real_a_session_edits_asks_gets_the_answer_as_the_next_prompt_and_ends_with_a_result() {
    let home = dirs::home_dir().expect("a home folder");
    let gemini = home.join(".gemini");
    let watched: Vec<String> = config_files(&home).into_iter().chain(credential_files(&home)).filter_map(|file| file.strip_prefix(&gemini).ok().map(|f| f.display().to_string())).collect();
    let tmp = tempfile::tempdir().unwrap();
    let work = scratch_worktree(tmp.path());
    let setup = harness::work::Setup::of_this_machine(tmp.path().join("data"));
    setup.capture().await.expect("the shell's environment is read");
    let shell = setup.shell().expect("a capture");
    let binary = setup.places().find(harness::provider::Provider::Gemini, &shell).expect("agy is installed");
    let version = std::process::Command::new(&binary).arg("--version").output().unwrap();
    eprintln!("agy --version: {}", String::from_utf8_lossy(&version.stdout).trim());
    let before = listing(&gemini);
    let harness = Harness::with_setup(Store::open(&tmp.path().join("data")).unwrap(), vec![("gemini".into(), Arc::new(GeminiDriver::new(binary)))], settings(4), Arc::new(setup));
    let schema = serde_json::json!({"type": "object", "properties": {"colour": {"type": "string"}}, "required": ["colour"], "additionalProperties": false});
    let spec = Open { provider: "gemini".into(), cwd: work.clone(), model: Some("gemini-3.8-flash".into()), effort: Some("low".into()), result_schema: Some(schema), ..Open::default() };
    let (id, mut events) = harness.open(spec).await.unwrap();
    harness.send(&id, PROMPT).unwrap();
    // The question is answered only once its turn ended, so the answer goes as the next prompt.
    let run = async {
        let (mut seen, mut asked, mut answered): (Vec<Event>, Option<String>, bool) = (vec![], None, false);
        loop {
            let event = events.recv().await.unwrap();
            match &event.body {
                Body::Permission { id: request, .. } => harness.answer(&id, request, Decision::Allow, None).unwrap(),
                Body::Question { id: question, .. } => asked = Some(question.clone()),
                Body::Failed { reason, .. } if reason.contains("Authentication required") => panic!("agy is not signed in: stop, and ask the owner to sign in"),
                Body::Failed { reason, .. } => panic!("the session failed: {reason}"),
                _ => {}
            }
            let ended = event.body.ends_turn();
            seen.push(event);
            if ended && let Some(question) = asked.take().filter(|_| !answered) {
                answered = true;
                harness.answer_question(&id, &question, "green".into()).await.unwrap();
            } else if ended && (answered || seen.iter().any(|event| matches!(event.body, Body::Result { .. }))) {
                return seen;
            }
        }
    };
    let seen = tokio::time::timeout(Duration::from_secs(900), run).await.expect("the run ends within 15 minutes");
    eprintln!("events: {:?}", types(&seen));
    assert!(!working_in(&work).is_empty(), "agy runs in the worktree while the session is open");
    harness.close(&id).unwrap();
    let rest = tokio::time::timeout(Duration::from_secs(60), until(&mut events, |body| matches!(body, Body::Closed { .. }))).await.expect("the session closes");
    eprintln!("then: {:?}", types(&rest));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(working_in(&work).is_empty(), "no process of the session is left");

    assert_eq!(std::fs::read_to_string(work.join("notes.txt")).unwrap_or_default().trim(), "hello", "it edited a file");
    // agy's update for an MCP call carries no output, so the early return shows in the order and the time: the call
    // was held until shortly before agy's cut, the turn ended with the question open, and it closed as the answer went.
    let at = |take: &dyn Fn(&Body) -> bool| seen.iter().find(|event| take(&event.body)).map(|event| event.ms);
    let (asked, first_end) = (at(&|body| matches!(body, Body::Question { .. })).expect("a question"), at(&|body| body.ends_turn()).unwrap());
    let closed = at(&|body| matches!(body, Body::QuestionClosed { .. })).expect("the question closed");
    let held = first_end - asked;
    eprintln!("ask held {held} ms before the turn ended");
    assert!((150_000..180_000).contains(&held), "ask returned before agy's 180 s cut, near it: {held} ms");
    assert!(closed > first_end, "the turn ended with the question open");
    let prompts: Vec<&String> = seen.iter().filter_map(|event| match &event.body { Body::Prompted { text } => Some(text), _ => None }).collect();
    assert!(prompts.len() == 2 && prompts[1].contains("green"), "the answer came as the next prompt: {} prompts", prompts.len());
    let given = seen.iter().filter_map(|event| match &event.body { Body::Result { data } => Some(data.clone()), _ => None }).next_back();
    assert_eq!(given.expect("a result was taken")["colour"], "green", "the result holds the answer");
    assert_eq!(seen.last().map(|event| &event.body), Some(&Body::TurnEnded { how: TurnEnd::Done }));

    let after = listing(&gemini);
    let changed: Vec<&String> = before.keys().chain(after.keys()).filter(|file| before.get(*file) != after.get(*file)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    eprintln!("~/.gemini: {} files before, {} after, {} changed or new", before.len(), after.len(), changed.len());
    let touched: Vec<&&String> = changed.iter().filter(|file| watched.contains(file)).collect();
    assert!(touched.is_empty(), "a settings, config or credential file changed: {touched:?}");
    let shape = |file: &str| file.split('/').map(|part| if part.len() > 20 { "<id>" } else { part }).collect::<Vec<_>>().join("/");
    let mut kinds: Vec<String> = changed.iter().map(|file| shape(file)).collect();
    kinds.dedup();
    eprintln!("changed: {kinds:?}");
}
