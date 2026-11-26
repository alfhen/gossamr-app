//! Sessions that name a repo, through the API: the clone, the worktree and their clean-up, against a bare repository
//! on disk that git reaches in place of GitHub. And the shell, captured again for each client.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use common::*;
use harness::api::Op;
use harness::auth::Token;
use harness::client::{Client, Push};
use harness::driver::{Capabilities, Driver, Launch, Link, OpenError};
use harness::env::RunEnv;
use harness::error::Error;
use harness::event::{Body, FailKind};
use harness::server::Server;
use harness::work::Setup;

const WAIT: Duration = Duration::from_secs(60);

/// A home folder, a data folder, a git config that sends `https://github.com/` to a bare repository on disk, and that
/// repository, `acme/webshop`, with one commit on `main`. Its folder is named `github.com`, so the URL git reports for
/// the clone's origin still names the repo on GitHub.
struct Rig {
    tmp: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    gitconfig: PathBuf,
}

impl Rig {
    fn new() -> Rig {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let (home, data, remote, gitconfig) = (root.join("home"), root.join("data"), root.join("remote/github.com"), root.join("gitconfig"));
        std::fs::create_dir_all(&home).unwrap();
        let config = format!(
            "[url \"file://{}/\"]\n\tinsteadOf = https://github.com/\n[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
            remote.display()
        );
        std::fs::write(&gitconfig, config).unwrap();
        let rig = Rig { tmp, home, data, gitconfig };
        let bare = remote.join("acme/webshop.git");
        std::fs::create_dir_all(&bare).unwrap();
        rig.git(&bare, &["init", "--quiet", "--bare", "--initial-branch=main"]);
        let seed = root.join("seed");
        rig.git(&root, &["clone", "--quiet", &format!("file://{}", bare.display()), "seed"]);
        std::fs::write(seed.join("README"), "hello\n").unwrap();
        rig.git(&seed, &["add", "README"]);
        rig.git(&seed, &["commit", "--quiet", "-m", "first"]);
        rig.git(&seed, &["push", "--quiet", "origin", "main"]);
        rig.git(&seed, &["checkout", "--quiet", "-b", "dev"]);
        std::fs::write(seed.join("DEV"), "dev\n").unwrap();
        rig.git(&seed, &["add", "DEV"]);
        rig.git(&seed, &["commit", "--quiet", "-m", "on dev"]);
        rig.git(&seed, &["push", "--quiet", "origin", "dev"]);
        rig.git(&seed, &["checkout", "--quiet", "main"]);
        rig
    }

    /// The environment git runs in, here and in the harness: none of the machine's git settings.
    fn env(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".into(), "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into()),
            ("HOME".into(), self.home.display().to_string()),
            ("GIT_CONFIG_GLOBAL".into(), self.gitconfig.display().to_string()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_ALLOW_PROTOCOL".into(), "file".into()),
        ]
    }

    fn git(&self, dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").current_dir(dir).args(args).env_clear().envs(self.env()).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed");
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    fn setup(&self) -> Setup {
        Setup::new(Some(self.home.clone()), self.data.clone()).with_shell_env(RunEnv::from_pairs(self.env()))
    }

    fn clone(&self) -> PathBuf {
        self.home.join("Gossamr/agents/acme/webshop")
    }

    fn worktree(&self, branch: &str) -> PathBuf {
        self.home.join("Gossamr/agents/acme/webshop+worktrees").join(branch)
    }
}

/// Writes a file in its folder, then refuses to open: a start whose worktree the discard must leave alone.
struct Scribbler;

impl Driver for Scribbler {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, launch: Launch) -> Result<Link, OpenError> {
        std::fs::write(launch.cwd.join("scribbled"), "left behind\n").unwrap();
        Err(OpenError { kind: FailKind::Provider, message: "it gave up".into() })
    }
}

/// Refuses every open, as a CLI that is signed out would.
struct Refuser;

impl Driver for Refuser {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn open(&self, _launch: Launch) -> Result<Link, OpenError> {
        Err(OpenError { kind: FailKind::SignedOut, message: "not signed in".into() })
    }
}

struct Served {
    token: Token,
    data: PathBuf,
    seer: Seer,
    task: tokio::task::JoinHandle<harness::error::Result<()>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn drivers(seer: &Seer) -> Vec<(String, Arc<dyn Driver>)> {
    vec![("mock".into(), Arc::new(seer.clone())), ("claude".into(), Arc::new(seer.clone())), ("refuser".into(), Arc::new(Refuser)), ("scribbler".into(), Arc::new(Scribbler))]
}

fn serve(data: &Path, setup: Setup) -> Served {
    let (token, seer) = (Token::random(), Seer::default());
    let first = token.clone();
    let server = Server::bind_with(data, move || Some(first), drivers(&seer), settings(4), setup).unwrap();
    Served { token, data: data.to_owned(), seer, task: tokio::spawn(server.run()) }
}

/// As `serve`, for a data folder served before: it keeps the token it first had.
async fn serve_again(data: &Path, setup: impl Fn() -> Setup, token: Token) -> Served {
    let seer = Seer::default();
    let server = bind_again(|| {
        let first = token.clone();
        Server::bind_with(data, move || Some(first), drivers(&seer), settings(4), setup())
    })
    .await;
    Served { token, data: data.to_owned(), seer, task: tokio::spawn(server.run()) }
}

async fn connect(served: &Served) -> Client {
    Client::connect(&served.data, &served.token).await.unwrap()
}

fn open_op(provider: &str, cwd: Option<&str>, repo: Option<&str>, base: Option<&str>, branch: Option<&str>) -> Op {
    let owned = |value: Option<&str>| value.map(str::to_owned);
    Op::Open { provider: provider.into(), cwd: cwd.map(PathBuf::from), repo: owned(repo), base: owned(base), branch: owned(branch), locked: false, model: None, login: None, effort: None, ends_with_client: false, tools: vec![], result_schema: None }
}

async fn open(client: &mut Client, op: Op) -> harness::error::Result<String> {
    let opened = client.call(op).await?;
    Ok(opened["session"].as_str().unwrap().to_owned())
}

/// Closes the session and waits for its `closed`.
async fn close(client: &mut Client, session: &str) {
    client.call(Op::Close { session: session.into() }).await.unwrap();
    loop {
        match tokio::time::timeout(WAIT, client.push()).await.expect("a push within the wait").unwrap() {
            Some(Push::Event { event, .. }) if matches!(event.body, Body::Closed { .. }) => return,
            Some(_) => continue,
            None => panic!("the connection ended"),
        }
    }
}

async fn clean_up(client: &mut Client, session: &str) -> harness::error::Result<serde_json::Value> {
    client.call(Op::CleanUp { session: session.into() }).await
}

#[tokio::test]
async fn a_session_that_names_a_repo_works_in_a_new_worktree_of_its_clone() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    let started = served.seer.starts();
    assert_eq!(started[0].cwd, rig.worktree("harness-1"), "the agent works in the worktree");
    assert_eq!(rig.git(&rig.worktree("harness-1"), &["rev-parse", "--abbrev-ref", "HEAD"]), "harness-1");
    assert_eq!(rig.git(&rig.worktree("harness-1"), &["log", "--format=%s", "-1"]), "first", "from origin/main, the remote's default branch");
    assert!(rig.clone().join(".git").is_dir());
    let listed = client.call(Op::Sessions).await.unwrap();
    let row = listed.as_array().unwrap().iter().find(|row| row["id"] == session.as_str()).unwrap().clone();
    assert_eq!((row["branch"].as_str(), row["cwd"].as_str()), (Some("harness-1"), rig.worktree("harness-1").to_str()), "the listing names its branch and its worktree");

    let again = open(&mut client, open_op("mock", None, Some("acme/webshop"), Some("main"), Some("harness-1"))).await;
    assert!(matches!(&again, Err(Error::Said(why)) if why.contains("already there")), "a branch that is there is refused");
    let other = open(&mut client, open_op("mock", None, Some("acme/webshop"), Some("main"), None)).await.unwrap();
    let named = served.seer.starts()[1].cwd.file_name().unwrap().to_string_lossy().into_owned();
    assert!(named.starts_with("harness-") && named.len() == "harness-".len() + 8, "a branch left out is harness- and 8 hex digits");
    close(&mut client, &other).await;
    close(&mut client, &session).await;
}

#[tokio::test]
async fn clean_up_removes_the_worktree_and_branch_and_keeps_work_git_would_lose() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &session).await;
    let worktree = rig.worktree("harness-1");

    std::fs::write(worktree.join("notes"), "not committed\n").unwrap();
    let kept = clean_up(&mut client, &session).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("git keeps the worktree")), "uncommitted work is refused");
    assert!(worktree.join("notes").exists());

    rig.git(&worktree, &["add", "notes"]);
    rig.git(&worktree, &["commit", "--quiet", "-m", "work"]);
    let kept = clean_up(&mut client, &session).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("not fully merged")), "a commit that is nowhere else is refused");
    assert!(worktree.exists() && !rig.git(&rig.clone(), &["branch", "--list", "harness-1"]).is_empty());
    let listed = client.call(Op::Sessions).await.unwrap();
    assert_eq!(listed[0]["cleaned"], false, "a refused clean-up leaves the session as it was");

    rig.git(&worktree, &["reset", "--quiet", "--hard", "origin/main"]);
    clean_up(&mut client, &session).await.unwrap();
    assert!(!worktree.exists());
    assert!(rig.git(&rig.clone(), &["branch", "--list", "harness-1"]).is_empty(), "the branch goes too");
    assert_eq!(client.call(Op::Sessions).await.unwrap()[0]["cleaned"], true);
}

#[tokio::test]
async fn refused_names_and_shapes_are_turned_down_before_anything_is_cloned_or_started() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let refused = [
        open_op("mock", None, Some("acme/../webshop"), None, None),
        open_op("mock", None, Some("acme/web/shop"), None, None),
        open_op("mock", None, Some("-acme/webshop"), None, None),
        open_op("mock", None, Some("acme/webshop"), None, Some("feature/x")),
        open_op("mock", None, Some("acme/webshop"), None, Some("-x")),
        open_op("mock", None, Some("acme/webshop"), None, Some("--upload-pack=x")),
        open_op("mock", None, Some("acme/webshop"), Some("../main"), None),
        open_op("mock", None, Some("acme/webshop"), None, Some("a..b")),
        open_op("mock", Some("/nowhere"), Some("acme/webshop"), None, None),
        open_op("mock", None, None, None, None),
        open_op("mock", Some("/nowhere"), None, Some("main"), None),
        open_op("nobody", None, Some("acme/webshop"), None, None),
    ];
    for (at, op) in refused.into_iter().enumerate() {
        assert!(open(&mut client, op).await.is_err(), "{at} was taken");
    }
    assert!(served.seer.starts().is_empty(), "no agent started");
    assert!(!rig.home.join("Gossamr").exists(), "nothing was cloned");
}

#[tokio::test]
async fn a_driver_that_fails_to_open_leaves_no_worktree() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let failed = open(&mut client, open_op("refuser", None, Some("acme/webshop"), None, Some("harness-2"))).await;
    assert!(matches!(failed, Err(Error::Said(why)) if why.contains("not signed in")));
    assert!(!rig.worktree("harness-2").exists());
    assert!(rig.git(&rig.clone(), &["branch", "--list", "harness-2"]).is_empty());
}

#[tokio::test]
async fn the_shell_is_captured_again_for_each_client() {
    let rig = Rig::new();
    let mark = rig.tmp.path().join("mark");
    std::fs::write(&mark, "one").unwrap();
    let shell = harness::testing::fake_cli(&rig.tmp.path().join("fakeshell"), &format!("printf '\\0GOSSAMR_ENV_BEGIN\\0PATH=/usr/bin:/bin\\0MARK=%s\\0' \"$(cat '{}')\"", mark.display()));
    let served = serve(&rig.data, Setup::new(Some(rig.home.clone()), rig.data.clone()).with_shell_program(&shell.to_string_lossy()));
    let mut first = connect(&served).await;
    open(&mut first, open_op("mock", Some("/nowhere"), None, None, None)).await.unwrap();
    std::fs::write(&mark, "two").unwrap();
    let mut second = connect(&served).await;
    open(&mut second, open_op("mock", Some("/nowhere"), None, None, None)).await.unwrap();
    let marks: Vec<Option<String>> = served.seer.starts().iter().map(|seen| seen.var("MARK")).collect();
    assert_eq!(marks, [Some("one".to_owned()), Some("two".to_owned())]);
}

#[tokio::test]
async fn resume_take_back_and_an_answer_that_resumes_wait_for_the_connections_shell() {
    for op in ["resume", "take_back", "answer"] {
        let rig = Rig::new();
        std::fs::create_dir_all(rig.home.join(".claude-work")).unwrap();
        // A Claude session from before this harness started, made with no shell to capture.
        let (id, token) = {
            let served = serve(&rig.data, Setup::new(Some(rig.home.clone()), rig.data.clone()));
            let mut client = connect(&served).await;
            let mut spec = open_op("claude", Some("/nowhere"), None, None, None);
            if let Op::Open { login, .. } = &mut spec {
                *login = Some("~/.claude-work".into());
            }
            let id = open(&mut client, spec).await.unwrap();
            match op {
                "take_back" => {
                    client.call(Op::HandOver { session: id.clone() }).await.unwrap();
                    while !matches!(tokio::time::timeout(WAIT, client.push()).await.unwrap().unwrap(), Some(Push::Event { event, .. }) if matches!(event.body, Body::Closed { .. })) {}
                }
                _ => close(&mut client, &id).await,
            }
            (id, served.token.clone())
        };
        let store = reopen(&rig.data).await;
        if op == "answer" {
            store.ask(&id, "q1", 1).unwrap();
        }
        drop(store);
        // The first client's shell takes a moment to read.
        let shell = harness::testing::fake_cli(&rig.tmp.path().join("slowshell"), "sleep 1; printf '\\0GOSSAMR_ENV_BEGIN\\0PATH=/usr/bin:/bin\\0'");
        let served = serve_again(&rig.data, || Setup::new(Some(rig.home.clone()), rig.data.clone()).with_shell_program(&shell.to_string_lossy()), token).await;
        let mut client = connect(&served).await;
        let session = id.clone();
        let called = match op {
            "resume" => client.call(Op::Resume { session, carry_on: None }).await,
            "take_back" => client.call(Op::TakeBack { session }).await,
            _ => client.call(Op::AnswerQuestion { session, question: "q1".into(), text: "blue".into() }).await,
        };
        assert!(called.is_ok(), "{op}: {:?}", called.err().map(|e| e.to_string()));
        assert_eq!(served.seer.starts().len(), 1, "{op}: started once the shell was read");
    }
}

fn seed(rig: &Rig) -> PathBuf {
    rig.tmp.path().canonicalize().unwrap().join("seed")
}

#[tokio::test]
async fn a_failed_open_gives_up_its_worktree_and_its_clean_up_leaves_a_later_sessions_one_alone() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    assert!(open(&mut client, open_op("refuser", None, Some("acme/webshop"), None, Some("harness-2"))).await.is_err());
    let later = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-2"))).await.unwrap();
    let listed = client.call(Op::Sessions).await.unwrap();
    let failed = listed.as_array().unwrap().iter().find(|s| s["provider"] == "refuser").unwrap()["id"].as_str().unwrap().to_owned();
    clean_up(&mut client, &failed).await.unwrap();
    assert!(rig.worktree("harness-2").exists(), "the running session keeps its worktree");
    assert!(!rig.git(&rig.clone(), &["branch", "--list", "harness-2"]).is_empty(), "and its branch");
    close(&mut client, &later).await;
}

#[tokio::test]
async fn clean_up_takes_a_branch_whose_commits_the_remote_has_and_keeps_one_it_does_not() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let mut opened = vec![];
    for (branch, base) in [("pushed-u", None), ("pushed", None), ("from-dev", Some("dev")), ("merged", None), ("unpushed", None)] {
        opened.push((branch, open(&mut client, open_op("mock", None, Some("acme/webshop"), base, Some(branch))).await.unwrap()));
    }
    for (branch, _) in &opened {
        if *branch != "from-dev" {
            let worktree = rig.worktree(branch);
            std::fs::write(worktree.join(branch), "work\n").unwrap();
            rig.git(&worktree, &["add", branch]);
            rig.git(&worktree, &["commit", "--quiet", "-m", branch]);
        }
    }
    rig.git(&rig.worktree("pushed-u"), &["push", "--quiet", "-u", "origin", "pushed-u"]);
    rig.git(&rig.worktree("pushed"), &["push", "--quiet", "origin", "pushed"]);
    rig.git(&rig.worktree("merged"), &["push", "--quiet", "origin", "merged"]);
    let seed = seed(&rig);
    rig.git(&seed, &["fetch", "--quiet", "origin"]);
    rig.git(&seed, &["merge", "--quiet", "--no-ff", "-m", "merge", "origin/merged"]);
    rig.git(&seed, &["push", "--quiet", "origin", "main"]);
    rig.git(&seed, &["push", "--quiet", "origin", "--delete", "merged"]);
    // Another session fetches, so the clone knows what the remote merged.
    let fetching = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("fetching"))).await.unwrap();
    for (branch, session) in &opened {
        close(&mut client, session).await;
        let done = clean_up(&mut client, session).await;
        match *branch {
            "unpushed" => assert!(matches!(&done, Err(Error::Said(why)) if why.contains("not fully merged")), "{branch}: a commit nowhere else is kept"),
            _ => assert!(done.is_ok(), "{branch} was refused"),
        }
        assert_eq!(rig.worktree(branch).exists(), *branch == "unpushed", "{branch}");
    }
    assert_eq!(rig.git(&rig.clone(), &["branch", "--list", "--format=%(refname:short)"]).lines().filter(|b| *b != "main").collect::<Vec<_>>(), ["fetching", "unpushed"]);
    close(&mut client, &fetching).await;
}

#[tokio::test]
async fn the_sweep_takes_only_a_temp_clone_it_marked_and_never_one_with_work() {
    let rig = Rig::new();
    let owner = rig.home.join("Gossamr/agents/acme");
    std::fs::create_dir_all(&owner).unwrap();
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    let folder = |name: &str, marked: bool| {
        let path = owner.join(name);
        std::fs::create_dir_all(&path).unwrap();
        if marked {
            std::fs::write(owner.join(format!("{name}.made")), "").unwrap();
        }
        path
    };
    let empty = folder(".webshop+cloning-000000000000", true);
    let unmarked = folder(".webshop+cloning-111111111111", false);
    let with_work = folder(".webshop+cloning-222222222222", true);
    let old_name = folder(".webshop.cloning-333333333333", true);
    let detached = folder(".webshop+cloning-444444444444", true);
    rig.git(&detached, &["init", "--quiet"]);
    rig.git(&detached, &["commit", "--quiet", "--allow-empty", "-m", "first"]);
    rig.git(&detached, &["checkout", "--quiet", "--detach"]);
    rig.git(&detached, &["commit", "--quiet", "--allow-empty", "-m", "on a detached head"]);
    rig.git(&detached, &["update-ref", "-d", "refs/heads/main"]);
    rig.git(&with_work, &["init", "--quiet"]);
    std::fs::write(with_work.join("work"), "not on any remote\n").unwrap();
    rig.git(&with_work, &["add", "work"]);
    rig.git(&with_work, &["commit", "--quiet", "-m", "work"]);
    for path in [&empty, &unmarked, &with_work, &old_name, &detached] {
        std::fs::File::open(path).unwrap().set_modified(old).unwrap();
    }
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    assert!(!empty.exists(), "a temp clone this code marked, with nothing in it, goes");
    assert!(unmarked.exists() && with_work.join("work").exists() && old_name.exists(), "nothing else does");
    assert!(detached.exists(), "nor one whose only commit is on a detached HEAD");
    assert!(!harness::fresh::valid_repo("acme/webshop+worktrees") && !harness::fresh::valid_repo("acme/.webshop+cloning-0"), "no repo can be named like the harness's own folders");
    close(&mut client, &session).await;
}

#[tokio::test]
async fn a_worktrees_folder_that_leads_out_of_the_work_root_is_refused() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let first = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &first).await;
    clean_up(&mut client, &first).await.unwrap();
    let outside = rig.tmp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let folder = rig.home.join("Gossamr/agents/acme/webshop+worktrees");
    std::fs::remove_dir_all(&folder).unwrap();
    std::os::unix::fs::symlink(&outside, &folder).unwrap();
    let refused = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-2"))).await;
    assert!(matches!(&refused, Err(Error::Said(why)) if why.contains("leads out of the work root")));
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0, "nothing was made outside");
}

#[tokio::test]
async fn a_fetch_that_did_not_happen_is_said_to_the_session_and_refusals_name_no_full_path() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let first = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &first).await;
    rig.git(&rig.clone(), &["config", "--local", "credential.helper", "store"]);
    let second = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-2"))).await.unwrap();
    let said = loop {
        match tokio::time::timeout(WAIT, client.push()).await.expect("a push").unwrap() {
            Some(Push::Event { session, event }) if session == second => break event.body,
            Some(_) => continue,
            None => panic!("the connection ended"),
        }
    };
    assert!(matches!(&said, Body::Notice { text } if text.contains("starts from what was fetched before")), "the first event is the notice");

    let elsewhere = rig.tmp.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, rig.home.join("Gossamr/agents/other")).unwrap();
    let refused = open(&mut client, open_op("mock", None, Some("other/repo"), None, None)).await;
    let Err(Error::Said(why)) = refused else { panic!("a link out of the work root was taken") };
    assert!(!why.contains(&*rig.home.to_string_lossy()), "the refusal names no full path of the home folder");
    close(&mut client, &second).await;
}

#[tokio::test]
async fn a_token_revoked_while_an_open_waits_leaves_no_session() {
    let rig = Rig::new();
    let shell = harness::testing::fake_cli(&rig.tmp.path().join("slowshell"), "sleep 2\nprintf '\\0GOSSAMR_ENV_BEGIN\\0PATH=/usr/bin:/bin\\0'");
    let served = serve(&rig.data, Setup::new(Some(rig.home.clone()), rig.data.clone()).with_shell_program(&shell.to_string_lossy()));
    let mut admin = connect(&served).await;
    let second = Token::random();
    admin.call(Op::TokenNew { stored_key: harness::auth::encode(&second.stored_key()) }).await.unwrap();
    let listed = admin.call(Op::TokenList).await.unwrap();
    let first_id = listed["tokens"].as_array().map(|t| t[0]["id"].clone()).unwrap_or_else(|| listed[0]["id"].clone());
    let mut doomed = Client::connect(&served.data, &served.token).await.unwrap();
    let opening = tokio::spawn(async move { open(&mut doomed, open_op("mock", Some("/nowhere"), None, None, None)).await });
    let mut other = Client::connect(&served.data, &second).await.unwrap();
    other.call(Op::TokenRevoke { token: first_id.as_i64().unwrap() }).await.unwrap();
    assert!(opening.await.unwrap().is_err(), "the open after the revoke made no session");
    assert!(other.call(Op::Sessions).await.unwrap().as_array().unwrap().is_empty());
    drop(admin);
}

/// Opens `branch`, commits a file in its worktree and closes the session.
async fn committed(rig: &Rig, client: &mut Client, branch: &str, base: Option<&str>) -> String {
    let session = open(client, open_op("mock", None, Some("acme/webshop"), base, Some(branch))).await.unwrap();
    let worktree = rig.worktree(branch);
    std::fs::write(worktree.join(branch), "work\n").unwrap();
    rig.git(&worktree, &["add", branch]);
    rig.git(&worktree, &["commit", "--quiet", "-m", branch]);
    close(client, &session).await;
    session
}

#[tokio::test]
async fn clean_up_asks_the_remote_and_keeps_a_branch_deleted_there_or_a_base_pushed_over_or_one_it_cannot_reach() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let seed = seed(&rig);

    let deleted = committed(&rig, &mut client, "deleted", None).await;
    rig.git(&rig.worktree("deleted"), &["push", "--quiet", "origin", "deleted"]);
    rig.git(&seed, &["push", "--quiet", "origin", "--delete", "deleted"]);
    let kept = clean_up(&mut client, &deleted).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("not fully merged")), "a branch deleted on the remote is no longer kept there");
    assert!(rig.worktree("deleted").join("deleted").exists());

    let from_dev = open(&mut client, open_op("mock", None, Some("acme/webshop"), Some("dev"), Some("from-dev"))).await.unwrap();
    close(&mut client, &from_dev).await;
    rig.git(&seed, &["fetch", "--quiet", "origin"]);
    rig.git(&seed, &["push", "--quiet", "--force", "origin", "main:dev"]);
    let kept = clean_up(&mut client, &from_dev).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("not fully merged")), "a base pushed over no longer holds the branch");
    assert!(rig.worktree("from-dev").exists());

    let away = committed(&rig, &mut client, "away", None).await;
    rig.git(&rig.worktree("away"), &["push", "--quiet", "-u", "origin", "away"]);
    let remote = rig.tmp.path().canonicalize().unwrap().join("remote");
    std::fs::rename(&remote, remote.with_file_name("remote-gone")).unwrap();
    let kept = clean_up(&mut client, &away).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("the remote couldn't be reached") && why.contains("nothing was removed")), "an unreachable remote proves nothing");
    assert!(rig.worktree("away").join("away").exists());
    std::fs::rename(remote.with_file_name("remote-gone"), &remote).unwrap();
    clean_up(&mut client, &away).await.unwrap();
    assert!(!rig.worktree("away").exists(), "once the remote answers, a branch it holds goes");
}

#[tokio::test]
async fn a_failed_open_whose_worktree_was_not_discarded_is_removed_by_its_own_clean_up() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    assert!(open(&mut client, open_op("scribbler", None, Some("acme/webshop"), None, Some("harness-3"))).await.is_err());
    assert!(rig.worktree("harness-3").join("scribbled").exists(), "the discard leaves a worktree that was written in");
    let listed = client.call(Op::Sessions).await.unwrap();
    let failed = listed[0]["id"].as_str().unwrap().to_owned();
    let kept = clean_up(&mut client, &failed).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("git keeps the worktree")), "its clean-up tries, and git keeps the change");
    std::fs::remove_file(rig.worktree("harness-3").join("scribbled")).unwrap();
    clean_up(&mut client, &failed).await.unwrap();
    assert!(!rig.worktree("harness-3").exists() && rig.git(&rig.clone(), &["branch", "--list", "harness-3"]).is_empty(), "then worktree and branch go");
}

#[tokio::test]
async fn an_origin_with_two_urls_or_a_push_url_is_no_clone_of_the_repo() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let first = committed(&rig, &mut client, "harness-1", None).await;
    let github = rig.git(&rig.clone(), &["config", "--get", "remote.origin.url"]);
    // Elsewhere holds the branch and GitHub doesn't. Named first, it is the URL `git fetch` uses, while
    // `git config --get` gives the last one, GitHub's.
    let elsewhere = rig.tmp.path().canonicalize().unwrap().join("elsewhere/acme/webshop.git");
    std::fs::create_dir_all(&elsewhere).unwrap();
    rig.git(&elsewhere, &["init", "--quiet", "--bare"]);
    let elsewhere = format!("file://{}", elsewhere.display());
    rig.git(&rig.worktree("harness-1"), &["push", "--quiet", &elsewhere, "harness-1", "main"]);
    for (key, rule) in [("remote.origin.url", "more than one URL"), ("remote.origin.pushurl", "a push URL of its own")] {
        rig.git(&rig.clone(), &["config", "--unset-all", "remote.origin.url"]);
        let urls: &[&str] = if key == "remote.origin.url" { &[&elsewhere, &github] } else { &[&github] };
        for url in urls {
            rig.git(&rig.clone(), &["config", "--add", "remote.origin.url", url]);
        }
        if key == "remote.origin.pushurl" {
            rig.git(&rig.clone(), &["config", "--add", key, &elsewhere]);
        }
        let refused = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-2"))).await;
        assert!(matches!(&refused, Err(Error::Said(why)) if why.contains(rule)), "{key}: an open says which rule");
        let kept = clean_up(&mut client, &first).await;
        assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("nothing was removed") && why.contains(rule) && !why.contains("git keeps")), "{key}: clean-up trusts no such origin, and says the harness refused");
        assert!(rig.worktree("harness-1").join("harness-1").exists(), "{key}: the branch's work stays");
    }
    rig.git(&rig.clone(), &["config", "--unset-all", "remote.origin.pushurl"]);
    rig.git(&rig.worktree("harness-1"), &["push", "--quiet", "origin", "harness-1"]);
    clean_up(&mut client, &first).await.unwrap();
}

#[test]
fn the_rig_sends_git_to_its_own_folders_and_nowhere_else() {
    let rig = Rig::new();
    let out = Command::new("git").args(["ls-remote", "https://example.invalid/acme/webshop.git"]).current_dir(rig.tmp.path()).env_clear().envs(rig.env()).output().unwrap();
    assert!(!out.status.success() && String::from_utf8_lossy(&out.stderr).contains("not allowed"), "no test reaches the network");
    rig.git(rig.tmp.path(), &["ls-remote", "https://github.com/acme/webshop.git"]);
}

/// Writes `ran` beside the hooks whenever git runs one of them.
fn hooks_that_tell(rig: &Rig) -> PathBuf {
    let hooks = rig.tmp.path().canonicalize().unwrap().join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for hook in ["post-checkout", "reference-transaction", "pre-push", "post-merge"] {
        let path = hooks.join(hook);
        std::fs::write(&path, format!("#!/bin/sh\necho {hook} >> '{}'\n", hooks.join("ran").display())).unwrap();
        std::fs::set_permissions(&path, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755)).unwrap();
    }
    hooks
}

#[tokio::test]
async fn a_hooks_path_in_the_clone_runs_nothing_and_blocks_no_clean_up() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let first = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &first).await;
    let hooks = hooks_that_tell(&rig);
    rig.git(&rig.clone(), &["config", "--local", "core.hooksPath", &hooks.display().to_string()]);
    rig.git(&rig.clone(), &["config", "--local", "branch.main.gh-merge-base", "main"]);
    clean_up(&mut client, &first).await.unwrap();
    let second = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-2"))).await.unwrap();
    close(&mut client, &second).await;
    clean_up(&mut client, &second).await.unwrap();
    assert!(!rig.worktree("harness-2").exists());
    assert!(!hooks.join("ran").exists(), "every git call the harness makes pins the hooks off");
}

#[tokio::test]
async fn clean_up_waits_for_the_repo_lock() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &session).await;
    let held = harness::fresh::lock_repo(&rig.home, "acme/webshop").await.unwrap();
    let mut other = connect(&served).await;
    let id = session.clone();
    let cleaning = tokio::spawn(async move { clean_up(&mut other, &id).await.is_ok() });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!cleaning.is_finished() && rig.worktree("harness-1").exists(), "nothing is done while another holds the lock");
    drop(held);
    assert!(cleaning.await.unwrap(), "then it goes ahead");
    assert!(!rig.worktree("harness-1").exists());
}

#[tokio::test]
async fn a_failed_starts_discard_waits_for_the_repo_lock() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &session).await;
    let work = harness::work::Work { repo: "acme/webshop".into(), base: "main".into(), branch: "harness-1".into(), clone: rig.clone() };
    let held = harness::fresh::lock_repo(&rig.home, "acme/webshop").await.unwrap();
    let (setup, worktree) = (rig.setup(), rig.worktree("harness-1"));
    let discarding = tokio::spawn(async move { setup.discard(&work, &worktree).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!discarding.is_finished() && rig.worktree("harness-1").exists(), "nothing is done while another holds the lock");
    drop(held);
    discarding.await.unwrap();
    assert!(!rig.worktree("harness-1").exists(), "then the untouched worktree goes");
}

#[tokio::test]
async fn an_agents_commit_identity_in_the_clone_blocks_no_clean_up() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &session).await;
    rig.git(&rig.clone(), &["config", "--local", "user.email", "agent@example.invalid"]);
    rig.git(&rig.clone(), &["config", "--local", "user.name", "Agent"]);
    clean_up(&mut client, &session).await.unwrap();
    assert!(!rig.worktree("harness-1").exists());
    rig.git(&rig.clone(), &["config", "--local", "user.signingkey", "ABC"]);
    let second = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-2"))).await.unwrap();
    close(&mut client, &second).await;
    let kept = clean_up(&mut client, &second).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("nothing was removed") && why.contains("user.signingkey")), "any other key still stops it");
}

#[tokio::test]
async fn an_upstream_on_another_remote_is_not_trusted() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = committed(&rig, &mut client, "elsewhere", None).await;
    let bare = rig.tmp.path().canonicalize().unwrap().join("remote/github.com/acme/webshop.git");
    rig.git(&rig.clone(), &["remote", "add", "upstream", &format!("file://{}", bare.display())]);
    rig.git(&rig.worktree("elsewhere"), &["push", "--quiet", "-u", "upstream", "elsewhere"]);
    rig.git(&seed(&rig), &["push", "--quiet", "origin", "--delete", "elsewhere"]);
    let kept = clean_up(&mut client, &session).await;
    assert!(matches!(&kept, Err(Error::Said(why)) if why.contains("not fully merged")), "only origin's refs count");
    assert!(rig.worktree("elsewhere").join("elsewhere").exists());
}

#[tokio::test]
async fn work_a_work_home_moves_the_clones_and_worktrees_and_leaves_the_home_folder_as_it_is() {
    let rig = Rig::new();
    let elsewhere = rig.tmp.path().canonicalize().unwrap().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let setup = rig.setup().with_work_home(Some(elsewhere.clone()));
    assert_eq!(setup.home(), Some(rig.home.as_path()), "the home a login folder's ~ and the CLIs are found by");
    let (work, worktree, _) = setup.prepare("acme/webshop", None, "moved-1").await.unwrap();
    assert_eq!(work.clone, elsewhere.join("Gossamr/agents/acme/webshop"));
    assert_eq!(worktree, elsewhere.join("Gossamr/agents/acme/webshop+worktrees/moved-1"));
    assert!(!rig.clone().exists(), "nothing in the home folder's work root");
    let (_, unmoved, _) = rig.setup().with_work_home(None).prepare("acme/webshop", None, "here-1").await.unwrap();
    assert_eq!(unmoved, rig.worktree("here-1"), "with none, the work root is the home folder's");
}

#[tokio::test]
async fn a_handed_over_session_whose_worktree_you_removed_can_be_cleaned_up_since_nothing_can_take_it_back() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    close(&mut client, &session).await;
    client.call(Op::HandOver { session: session.clone() }).await.unwrap();
    // As the person does in Terminal when Clean up says Terminal has it.
    std::fs::remove_dir_all(rig.worktree("harness-1")).unwrap();
    let taken = client.call(Op::TakeBack { session: session.clone() }).await;
    assert!(matches!(&taken, Err(Error::Said(why)) if why.contains("worktree is gone")), "{taken:?}");
    clean_up(&mut client, &session).await.expect("nothing could resume it, so its clean-up is not refused for the hand-over");
    assert!(rig.git(&rig.clone(), &["branch", "--list", "harness-1"]).is_empty(), "the branch goes too");
    assert_eq!(client.call(Op::Sessions).await.unwrap()[0]["cleaned"], true);
}

#[tokio::test]
async fn a_closed_session_a_take_back_would_refuse_is_not_handed_over_and_its_clean_up_goes_ahead() {
    let rig = Rig::new();
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let mut op = open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"));
    if let Op::Open { ends_with_client, .. } = &mut op {
        *ends_with_client = true;
    }
    let session = open(&mut client, op).await.unwrap();
    close(&mut client, &session).await;
    let handed = client.call(Op::HandOver { session: session.clone() }).await;
    assert!(matches!(&handed, Err(Error::Said(why)) if why.contains("is not handed over")), "{handed:?}");
    let taken = client.call(Op::TakeBack { session: session.clone() }).await;
    assert!(taken.is_err(), "and there is nothing to take back");
    clean_up(&mut client, &session).await.expect("not blocked by a hand-over");
    assert!(!rig.worktree("harness-1").exists());
}
