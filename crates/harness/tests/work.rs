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
    assert!(listed.as_array().unwrap().iter().find(|s| s["id"] == failed.as_str()).unwrap()["branch"].is_null(), "the failed open's row names no worktree");
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
    rig.git(&with_work, &["init", "--quiet"]);
    std::fs::write(with_work.join("work"), "not on any remote\n").unwrap();
    rig.git(&with_work, &["add", "work"]);
    rig.git(&with_work, &["commit", "--quiet", "-m", "work"]);
    for path in [&empty, &unmarked, &with_work, &old_name] {
        std::fs::File::open(path).unwrap().set_modified(old).unwrap();
    }
    let served = serve(&rig.data, rig.setup());
    let mut client = connect(&served).await;
    let session = open(&mut client, open_op("mock", None, Some("acme/webshop"), None, Some("harness-1"))).await.unwrap();
    assert!(!empty.exists(), "a temp clone this code marked, with nothing in it, goes");
    assert!(unmarked.exists() && with_work.join("work").exists() && old_name.exists(), "nothing else does");
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
