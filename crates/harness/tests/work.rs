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
        rig
    }

    /// The environment git runs in, here and in the harness: none of the machine's git settings.
    fn env(&self) -> Vec<(String, String)> {
        vec![
            ("PATH".into(), "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into()),
            ("HOME".into(), self.home.display().to_string()),
            ("GIT_CONFIG_GLOBAL".into(), self.gitconfig.display().to_string()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
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
        self.home.join("Gossamr/agents/acme/webshop.worktrees").join(branch)
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

fn serve(data: &Path, setup: Setup) -> Served {
    let (token, seer) = (Token::random(), Seer::default());
    let drivers: Vec<(String, Arc<dyn Driver>)> = vec![("mock".into(), Arc::new(seer.clone())), ("refuser".into(), Arc::new(Refuser))];
    let first = token.clone();
    let server = Server::bind_with(data, move || Some(first), drivers, settings(4), setup).unwrap();
    Served { token, data: data.to_owned(), seer, task: tokio::spawn(server.run()) }
}

async fn connect(served: &Served) -> Client {
    Client::connect(&served.data, &served.token).await.unwrap()
}

fn open_op(provider: &str, cwd: Option<&str>, repo: Option<&str>, base: Option<&str>, branch: Option<&str>) -> Op {
    let owned = |value: Option<&str>| value.map(str::to_owned);
    Op::Open { provider: provider.into(), cwd: cwd.map(PathBuf::from), repo: owned(repo), base: owned(base), branch: owned(branch), locked: false, model: None, login: None, effort: None, ends_with_client: false }
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
            Some(Push::Event { event, .. }) if event.body == Body::Closed => return,
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
