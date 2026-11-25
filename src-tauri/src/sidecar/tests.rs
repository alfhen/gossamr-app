//! The manager against a fake harness: this test binary, run again through a link to the harness crate's checked
//! `run-body.sh` (a new executable's first run is checked by macOS, which made tests that write one flaky). The fake
//! speaks the hello and the proof with the protocol and build its body names, keeps only stored keys, holds the data
//! folder's lock as the harness does, and logs each life to a file of the test's. A fake holds a lock on its own
//! `life-<pid>` file while it runs, and ends when its test writes `stop` (or `stop-<pid>` for that one alone), so a
//! test never signals a pid: one that has ended may belong to another test's fake by now. Every test proves
//! afterwards that no fake still runs.

use std::io::BufRead;
use std::os::fd::{AsRawFd, FromRawFd};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use harness::api::{Hello, Proof, DESCRIPTOR, SOCKET};
use harness::auth::{decode, encode, verify};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::secrets::{FileVault, Vault};

const FAKE: &str = "GOSSAMR_FAKE_HARNESS";
const FAKE_ARGV: &str = "GOSSAMR_FAKE_ARGV";
/// The descriptors above 2 the fake found open when it started.
static INHERITED: std::sync::OnceLock<Vec<libc::c_int>> = std::sync::OnceLock::new();
/// Only a failure waits this long.
const WAIT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize)]
struct Fake {
    protocol: u32,
    build: String,
    /// Where each life writes `serving <pid>`, `in-use <pid>` and `died <pid>`, and `seen-<pid>` its argv and what it
    /// found in its environment: never the environment itself, which may hold a credential of the person's.
    log: PathBuf,
    /// Dies after its first hello, once: the file says it already has.
    die_once: Option<PathBuf>,
    /// Takes `shutdown` and never answers it.
    #[serde(default)]
    mute: bool,
}

/// Is the fake harness when its variable is set, and a test that passes otherwise.
#[test]
fn fake_harness() {
    let Some(config) = std::env::var_os(FAKE) else { return };
    // Before the fake opens anything of its own.
    let inherited: Vec<libc::c_int> = (3..256).filter(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } != -1).collect();
    INHERITED.set(inherited).unwrap();
    let fake: Fake = serde_json::from_str(config.to_str().unwrap()).unwrap();
    std::process::exit(fake_main(fake, std::env::var(FAKE_ARGV).unwrap_or_default()));
}

fn fake_main(fake: Fake, argv: String) -> i32 {
    let log = fake.log.clone();
    let note = |what: &str| note_to(&log, what);
    let args: Vec<&str> = argv.split(' ').collect();
    if args == ["--version"] {
        println!("harness 0.1.0 (build {})", fake.build);
        return 0;
    }
    let seen = fake.log.with_file_name(format!("seen-{}", std::process::id()));
    let ["serve", "--data", dir, "--turn-limit", _] = args[..] else { return 2 };
    let dir = PathBuf::from(dir);
    let root = fake.log.parent().unwrap().to_owned();
    let pid = std::process::id();
    let life = File::create(root.join(format!("life-{pid}"))).unwrap();
    life.lock().unwrap();
    // Held until the process ends, when the system lets it go.
    std::mem::forget(life);
    std::thread::spawn(move || loop {
        if !root.exists() || root.join("stop").exists() || root.join(format!("stop-{pid}")).exists() {
            std::process::exit(0);
        }
        std::thread::sleep(Duration::from_millis(10));
    });
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("lock")).unwrap();
    if lock.try_lock().is_err() {
        note("in-use");
        return 1;
    }
    // The stored keys, in the file the real harness keeps its store in.
    let store = dir.join(STORE);
    let mut keys: Vec<[u8; 32]> = std::fs::read_to_string(&store).unwrap_or_default().lines().filter_map(decode).collect();
    if keys.is_empty() {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).unwrap();
        let Some(token) = Token::parse(&line) else { return 1 };
        let in_env = std::env::vars().any(|(_, value)| value.contains(&token.hex()));
        let named = std::env::var_os(harness::cli::TOKEN_VARIABLE).is_some();
        let (cwd, inherited) = (std::env::current_dir().unwrap(), INHERITED.get().cloned().unwrap_or_default());
        let cwd = if cwd.canonicalize().ok() == dir.canonicalize().ok() { "the data folder" } else { "elsewhere" };
        std::fs::write(&seen, format!("{argv}\ntoken in environment: {in_env}\n{}: {named}\nworking folder: {cwd}\ninherited: {inherited:?}", harness::cli::TOKEN_VARIABLE)).unwrap();
        keys.push(token.stored_key());
        std::fs::write(&store, encode(&token.stored_key())).unwrap();
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let _ = std::fs::remove_file(dir.join(SOCKET));
        let listener = tokio::net::UnixListener::bind(dir.join(SOCKET)).unwrap();
        std::fs::write(dir.join(DESCRIPTOR), json!({ "protocol": fake.protocol, "build": fake.build, "pid": std::process::id() }).to_string()).unwrap();
        note("serving");
        let fake = Arc::new(fake);
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (fake, keys, dir) = (fake.clone(), keys.clone(), dir.clone());
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                let hello = serde_json::to_string(&Hello { protocol: fake.protocol, build: fake.build.clone(), challenge: encode(&Token::random().stored_key()) }).unwrap();
                if ws.send(Message::text(hello.clone())).await.is_err() {
                    return;
                }
                if let Some(marker) = fake.die_once.as_ref().filter(|marker| !marker.exists()) {
                    std::fs::write(marker, "").unwrap();
                    note_to(&fake.log, "died");
                    std::process::exit(1);
                }
                let Some(Ok(Message::Text(text))) = ws.next().await else { return };
                let proof: Proof = serde_json::from_str(text.as_str()).unwrap();
                if decode(&proof.proof).and_then(|answer| verify(&keys, hello.as_bytes(), &answer)).is_none() {
                    let _ = ws.send(Message::text(json!({ "error": "refused: the client did not prove a token" }).to_string())).await;
                    return;
                }
                let _ = ws.send(Message::text(json!({ "ok": true }).to_string())).await;
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let call: Value = serde_json::from_str(text.as_str()).unwrap();
                    let shutdown = call["op"] == "shutdown";
                    if shutdown && fake.mute {
                        continue;
                    }
                    let ok = if shutdown { json!({ "left": [] }) } else { json!([]) };
                    if shutdown {
                        let _ = std::fs::remove_file(dir.join(SOCKET));
                        let _ = std::fs::remove_file(dir.join(DESCRIPTOR));
                    }
                    let _ = ws.send(Message::text(json!({ "id": call["id"], "ok": ok }).to_string())).await;
                    if shutdown {
                        let _ = ws.close(None).await;
                        note_to(&fake.log, "exit");
                        std::process::exit(0);
                    }
                }
            });
        }
    })
}

fn note_to(log: &Path, what: &str) {
    let mut log = OpenOptions::new().create(true).append(true).open(log).unwrap();
    writeln!(log, "{what} {}", std::process::id()).unwrap();
}

struct Bed {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    dir: PathBuf,
    log: PathBuf,
}

impl Bed {
    fn new() -> Bed {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_owned();
        Bed { dir: root.join("data"), log: root.join("fakes.log"), root, _tmp: tmp }
    }

    /// A fake harness at `bin/<name>`, a link to the checked script, with its behaviour in its body.
    fn fake(&self, name: &str, protocol: u32, build: &str) -> PathBuf {
        self.fake_with(name, Fake { protocol, build: build.into(), log: self.log.clone(), die_once: None, mute: false })
    }

    fn fake_with(&self, name: &str, fake: Fake) -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let config = serde_json::to_string(&fake).unwrap();
        let body = format!("{FAKE}='{config}' {FAKE_ARGV}=\"$*\" exec '{}' --exact sidecar::tests::fake_harness --nocapture --test-threads=1 -q", exe.display());
        harness::testing::fake_cli(&self.root.join("bin").join(name), &body)
    }

    fn vault(&self) -> Vault {
        Vault::new(Box::new(FileVault::new(self.root.join("vault.json"))))
    }

    fn sidecar(&self, program: &Path) -> Sidecar {
        Sidecar::new(self.dir.clone(), program.to_owned(), Box::new(self.vault()), Limits::default())
    }

    /// The token the app keeps, made and saved as a first start would.
    fn token(&self) -> Token {
        let vault = self.vault();
        match Keep::load(&vault).unwrap() {
            Some(hex) => Token::parse(&hex).unwrap(),
            None => {
                let token = Token::random();
                Keep::save(&vault, &token.hex()).unwrap();
                token
            }
        }
    }

    /// Starts `program` as an earlier run of the app would have, and waits until it serves. macOS now and then kills
    /// a fake run within milliseconds of its link and body being written (SIGKILL, nothing logged; 3 in 40 runs here,
    /// none with 200 ms between), so one killed before it began is started again, as the manager does.
    async fn serve_by_hand(&self, program: &Path, token: &Token) -> u32 {
        DirBuilder::new().recursive(true).mode(0o700).create(&self.dir).unwrap();
        let before = self.pids("serving").len();
        let mut child = spawn(program, &self.dir, token).unwrap();
        let mut tries = 1;
        let until = Instant::now() + WAIT;
        while self.pids("serving").len() == before {
            if let Ok(Some(status)) = child.try_wait() {
                use std::os::unix::process::ExitStatusExt;
                assert!(status.signal() == Some(libc::SIGKILL) && tries < 3, "the fake ended before it served: {status:?}");
                child = spawn(program, &self.dir, token).unwrap();
                tries += 1;
            }
            assert!(Instant::now() < until, "the fake did not serve");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid = child.id();
        reap(child);
        pid
    }

    fn pids(&self, what: &str) -> Vec<u32> {
        let log = std::fs::read_to_string(&self.log).unwrap_or_default();
        log.lines().filter_map(|line| line.strip_prefix(what)?.trim().parse().ok()).collect()
    }

    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines().map(|line| line.split(' ').next().unwrap().to_owned()).collect()
    }

    /// Whether the fake that logged `pid` still runs: it holds its life file.
    fn running(&self, pid: u32) -> bool {
        File::open(self.root.join(format!("life-{pid}"))).is_ok_and(|life| matches!(life.try_lock(), Err(std::fs::TryLockError::WouldBlock)))
    }

    /// Ends the one fake that logged `pid`, abruptly, leaving its socket, and waits until it has.
    async fn end(&self, pid: u32) {
        std::fs::write(self.root.join(format!("stop-{pid}")), "").unwrap();
        self.until_ended(&[pid], "the fake did not end").await;
    }

    async fn until_ended(&self, pids: &[u32], why: &str) {
        let until = Instant::now() + WAIT;
        while pids.iter().any(|pid| self.running(*pid)) {
            assert!(Instant::now() < until, "{why}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Ends every fake still running and proves none is left.
    async fn none_left(&self) {
        std::fs::write(self.root.join("stop"), "").unwrap();
        self.until_ended(&self.pids("serving"), "a fake is still running").await;
    }
}

impl Drop for Bed {
    fn drop(&mut self) {
        // On a failed test's way out; a fake also ends once the test's folder is gone.
        let _ = std::fs::write(self.root.join("stop"), "");
    }
}

#[tokio::test]
async fn start_with_nothing_serving_starts_one_detached_harness_and_proves_it() {
    let bed = Bed::new();
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await;
    assert_eq!((status.state, status.build.as_deref(), status.bundled_build.as_deref(), status.update), (State::Running, Some("new"), Some("new"), false), "{status:?}");
    let serving = bed.pids("serving");
    assert_eq!(serving.len(), 1);
    // SAFETY: getsid has no preconditions.
    assert_eq!(unsafe { libc::getsid(serving[0] as libc::pid_t) }, serving[0] as libc::pid_t, "it leads a session of its own");
    bed.none_left().await;
}

#[tokio::test]
async fn adopt_a_harness_already_serving_with_the_apps_token_and_start_no_second() {
    let bed = Bed::new();
    let program = bed.fake("harness", PROTOCOL, "new");
    assert_eq!(bed.sidecar(&program).ensure().await.state, State::Running);
    let again = bed.sidecar(&program).ensure().await;
    assert_eq!((again.state, again.build.as_deref()), (State::Running, Some("new")), "{again:?}");
    assert_eq!(bed.pids("serving").len(), 1, "a later run of the app adopts it");
    bed.none_left().await;
}

#[tokio::test]
async fn an_older_build_of_the_same_protocol_is_kept_and_a_restart_updates_it() {
    let bed = Bed::new();
    let old = bed.serve_by_hand(&bed.fake("old", PROTOCOL, "old"), &bed.token()).await;
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    let kept = sidecar.ensure().await;
    assert_eq!((kept.state, kept.build.as_deref(), kept.bundled_build.as_deref(), kept.update), (State::Running, Some("old"), Some("new"), true), "{kept:?}");
    assert!(bed.running(old));
    let restarted = sidecar.act(Action::Restart).await;
    assert_eq!((restarted.state, restarted.build.as_deref(), restarted.update), (State::Running, Some("new"), false), "{restarted:?}");
    assert_eq!(bed.lines(), ["serving", "exit", "serving"]);
    bed.none_left().await;
}

#[tokio::test]
async fn an_older_protocol_is_kept_until_you_restart_it_through_its_own_shutdown() {
    let bed = Bed::new();
    let old = bed.serve_by_hand(&bed.fake("old", PROTOCOL - 1, "old"), &bed.token()).await;
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    let status = sidecar.ensure().await;
    assert_eq!((status.state, status.build.as_deref(), status.update), (State::Failed, Some("old"), true), "{status:?}");
    assert!(status.message.as_deref().is_some_and(|m| m.contains("Restarting it stops any agents")), "{status:?}");
    assert!(bed.running(old), "not stopped without you");
    assert_eq!(sidecar.ensure().await.state, State::Failed, "nor by a later read");
    let restarted = sidecar.act(Action::Restart).await;
    assert_eq!((restarted.state, restarted.build.as_deref()), (State::Running, Some("new")), "{restarted:?}");
    assert_eq!(bed.lines(), ["serving", "exit", "serving"], "the old one stopped itself before the new one started");
    bed.none_left().await;
}

#[tokio::test]
async fn a_bundled_harness_of_another_protocol_is_stopped_and_named() {
    let bed = Bed::new();
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL + 1, "odd")).ensure().await;
    assert_eq!(status.state, State::Failed);
    assert!(status.message.as_deref().is_some_and(|m| m.contains("Reinstall Gossamr")), "{status:?}");
    assert_eq!(bed.pids("serving").len(), 1, "started once, not again and again");
    bed.none_left().await;
}

#[tokio::test]
async fn a_newer_protocol_is_left_running_and_asks_for_an_update() {
    let bed = Bed::new();
    let newer = bed.serve_by_hand(&bed.fake("newer", PROTOCOL + 1, "newer"), &bed.token()).await;
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await;
    assert_eq!(status.state, State::Failed);
    assert!(status.message.as_deref().is_some_and(|m| m.contains("Update Gossamr")), "{status:?}");
    assert!(bed.running(newer), "it is left running");
    assert_eq!(bed.pids("serving").len(), 1);
    bed.none_left().await;
}

#[tokio::test]
async fn a_dead_harness_is_started_again_over_its_stale_socket() {
    let bed = Bed::new();
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    assert_eq!(sidecar.ensure().await.state, State::Running);
    bed.end(bed.pids("serving")[0]).await;
    assert!(bed.dir.join(SOCKET).exists(), "a stale socket is left");
    assert_eq!(sidecar.ensure().await.state, State::Running);
    assert_eq!(bed.pids("serving").len(), 2);
    bed.none_left().await;
}

#[tokio::test]
async fn two_managers_starting_at_once_end_with_one_harness_both_adopt() {
    let bed = Bed::new();
    bed.token();
    let program = bed.fake("harness", PROTOCOL, "new");
    let (one, two) = (bed.sidecar(&program), bed.sidecar(&program));
    let (a, b) = tokio::join!(one.ensure(), two.ensure());
    assert_eq!((a.state, b.state), (State::Running, State::Running), "{a:?} {b:?}");
    assert_eq!(bed.pids("serving").len(), 1);
    assert!(bed.pids("in-use").is_empty(), "no second one was even tried");
    bed.none_left().await;
}

#[tokio::test]
async fn two_managers_at_a_first_start_never_write_over_the_token_the_harness_knows() {
    let bed = Bed::new();
    let program = bed.fake("harness", PROTOCOL, "new");
    // Each read the empty vault before either saved, as two apps opened at once do at launch.
    let warm = || {
        let vault = bed.vault();
        assert_eq!(vault.load::<String>("jira:1").unwrap(), None);
        Sidecar::new(bed.dir.clone(), program.clone(), Box::new(vault), Limits::default())
    };
    let (one, two) = (warm(), warm());
    let (a, b) = tokio::join!(one.ensure(), two.ensure());
    let states = [a.state, b.state];
    assert!(states.contains(&State::Running), "{a:?} {b:?}");
    assert_eq!(bed.pids("serving").len(), 1);
    assert_eq!(bed.sidecar(&program).ensure().await.state, State::Running, "the token in the vault is the one the harness knows");
    bed.none_left().await;
}

#[tokio::test]
async fn a_harness_that_refuses_the_apps_token_is_never_killed_and_none_starts_beside_it() {
    let bed = Bed::new();
    bed.token();
    let foreign = bed.serve_by_hand(&bed.fake("theirs", PROTOCOL, "new"), &Token::random()).await;
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await;
    assert_eq!(status.state, State::Failed);
    assert!(status.message.as_deref().is_some_and(|m| m.contains("doesn't know this Gossamr's key")), "{status:?}");
    assert!(bed.running(foreign), "left alone");
    assert_eq!(bed.pids("serving").len(), 1);
    bed.none_left().await;
}

#[tokio::test]
async fn a_harness_that_refuses_the_apps_token_after_the_app_started_it_is_stopped_alone() {
    let bed = Bed::new();
    bed.token();
    // A folder another install set up: a store whose key is not the vault's, and no harness serving it.
    DirBuilder::new().recursive(true).mode(0o700).create(&bed.dir).unwrap();
    std::fs::write(bed.dir.join(STORE), encode(&Token::random().stored_key())).unwrap();
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await;
    assert_eq!(status.state, State::Failed);
    assert!(status.message.as_deref().is_some_and(|m| m.contains("holds a key this Gossamr doesn't have")), "{status:?}");
    assert_eq!(bed.pids("serving").len(), 1, "it started one, and not again");
    bed.until_ended(&bed.pids("serving"), "the one it started was not stopped").await;
}

#[tokio::test]
async fn a_folder_with_a_store_and_no_token_in_the_vault_gets_no_new_token() {
    let bed = Bed::new();
    DirBuilder::new().recursive(true).mode(0o700).create(&bed.dir).unwrap();
    std::fs::write(bed.dir.join(STORE), encode(&Token::random().stored_key())).unwrap();
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await;
    assert!(status.message.as_deref().is_some_and(|m| m.contains("holds a key this Gossamr doesn't have")), "{status:?}");
    assert_eq!(Keep::load(&bed.vault()).unwrap(), None, "nothing saved");
    assert!(bed.pids("serving").is_empty());
}

#[tokio::test]
async fn a_harness_still_stopping_holds_the_folder_and_the_manager_waits_then_starts() {
    let bed = Bed::new();
    bed.token();
    DirBuilder::new().recursive(true).mode(0o700).create(&bed.dir).unwrap();
    // A harness mid-shutdown: its socket is gone and it still holds the lock.
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(bed.dir.join("lock")).unwrap();
    lock.try_lock().unwrap();
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    let release = async {
        let waited = tokio::time::timeout(WAIT, sidecar.waiting.notified()).await;
        drop(lock);
        assert!(waited.is_ok(), "the manager never waited for the folder");
        assert!(bed.pids("serving").is_empty() && bed.pids("in-use").is_empty(), "nothing started while it was held");
    };
    let (status, ()) = tokio::join!(sidecar.ensure(), release);
    assert_eq!(status.state, State::Running, "{status:?}");
    assert_eq!(bed.lines(), ["serving"]);
    bed.none_left().await;
}

#[tokio::test]
async fn a_harness_that_dies_between_its_hello_and_the_proof_is_started_again() {
    let bed = Bed::new();
    let fake = Fake { protocol: PROTOCOL, build: "new".into(), log: bed.log.clone(), die_once: Some(bed.root.join("died")), mute: false };
    let status = bed.sidecar(&bed.fake_with("harness", fake)).ensure().await;
    assert_eq!(status.state, State::Running, "{status:?}");
    assert_eq!(bed.lines(), ["serving", "died", "serving"]);
    bed.none_left().await;
}

#[tokio::test]
async fn a_data_folder_too_long_for_the_socket_is_refused_before_anything_starts() {
    let bed = Bed::new();
    let dir = bed.root.join("x".repeat(110));
    let sidecar = Sidecar::new(dir.clone(), bed.fake("harness", PROTOCOL, "new"), Box::new(bed.vault()), Limits::default());
    let status = sidecar.ensure().await;
    assert_eq!(status.state, State::Failed);
    let message = status.message.unwrap();
    assert!(message.contains("too long") && message.contains("at most 103"), "{message}");
    assert!(!dir.exists(), "no folder made");
    assert!(bed.pids("serving").is_empty());
}

struct Refusing;

impl Keep for Refusing {
    fn reread(&self) -> crate::error::Result<()> {
        Err(crate::error::Error::KeychainUnavailable("denied".into()))
    }
    fn load(&self) -> crate::error::Result<Option<String>> {
        Err(crate::error::Error::KeychainUnavailable("denied".into()))
    }
    fn save(&self, _: &str) -> crate::error::Result<()> {
        Err(crate::error::Error::KeychainUnavailable("denied".into()))
    }
}

#[tokio::test]
async fn a_vault_that_refuses_starts_nothing_and_says_so() {
    let bed = Bed::new();
    let sidecar = Sidecar::new(bed.dir.clone(), bed.fake("harness", PROTOCOL, "new"), Box::new(Refusing), Limits::default());
    let status = sidecar.ensure().await;
    assert_eq!(status.state, State::Failed);
    assert!(status.message.as_deref().is_some_and(|m| m.contains("Keychain")), "{status:?}");
    assert!(bed.pids("serving").is_empty());
}

fn files_holding(dir: &Path, needle: &str, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_holding(&path, needle, found);
        } else if std::fs::read(&path).is_ok_and(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes())) {
            found.push(path.file_name().unwrap().into());
        }
    }
}

#[tokio::test]
async fn the_token_is_in_the_vault_and_in_no_file_under_the_data_folder_nor_the_harnesss_argv_or_environment() {
    let bed = Bed::new();
    // A descriptor the app holds without close-on-exec, as a library might open one.
    // SAFETY: open with a valid path; the descriptor is owned from here on.
    let held = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
    let held = unsafe { std::os::fd::OwnedFd::from_raw_fd(held) };
    assert_eq!(bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await.state, State::Running);
    let hex = bed.token().hex();
    assert!(std::fs::read_to_string(bed.root.join("vault.json")).unwrap().contains(&hex), "the vault holds it");
    let mut found = vec![];
    files_holding(&bed.dir, &hex, &mut found);
    assert!(found.is_empty(), "files under the data folder hold the token: {found:?}");
    if let Ok(out) = Command::new("rg").args(["--files-with-matches", "--hidden", "--no-ignore", "--fixed-strings"]).arg(&hex).arg(&bed.dir).output() {
        assert_eq!(out.status.code(), Some(1), "rg finds the token in no file under the data folder");
    }
    let pid = bed.pids("serving")[0];
    let seen = std::fs::read_to_string(bed.root.join(format!("seen-{pid}"))).unwrap();
    assert!(seen.starts_with("serve --data "), "its argv");
    assert!(!seen.contains(&hex), "its argv does not hold the token");
    assert!(seen.contains("token in environment: false") && seen.contains("HARNESS_TOKEN: false"), "nor its environment");
    let found: Vec<&str> = seen.lines().skip(1).collect();
    assert!(seen.contains("working folder: the data folder"), "it runs in the data folder: {found:?}");
    assert!(seen.contains("inherited: []"), "it inherits no descriptor above 2 (the app held {}): {found:?}", held.as_raw_fd());
    bed.none_left().await;
}

#[test]
fn the_harness_starts_without_the_variable_serve_refuses() {
    let command = serve_command(Path::new("harness"), Path::new("data"), None);
    assert!(command.get_envs().any(|(name, value)| name == harness::cli::TOKEN_VARIABLE && value.is_none()), "HARNESS_TOKEN is taken out of its environment");
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args, ["serve", "--data", "data", "--turn-limit", "6"], "a limit the app's setting never goes over");
    assert_eq!(command.get_current_dir(), Some(Path::new("data")), "it runs in the data folder");
}

#[test]
fn a_mock_script_is_served_only_when_one_is_given() {
    let command = serve_command(Path::new("harness"), Path::new("data"), Some(Path::new("/scripts/demo.jsonl")));
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args, ["serve", "--data", "data", "--turn-limit", "6", "--mock-script", "/scripts/demo.jsonl"]);
}

#[tokio::test]
async fn the_data_folder_is_excluded_from_time_machine() {
    let bed = Bed::new();
    assert_eq!(bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await.state, State::Running);
    let out = Command::new("/usr/bin/tmutil").arg("isexcluded").arg(&bed.dir).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("[Excluded]"), "tmutil says so");
    // A temporary folder is excluded already, by where it is; the folder itself carries the sticky exclusion.
    let sticky = Command::new("/usr/bin/xattr").args(["-p", "com.apple.metadata:com_apple_backup_excludeItem"]).arg(&bed.dir).output().unwrap();
    assert!(sticky.status.success(), "the folder carries the exclusion that goes with it");
    bed.none_left().await;
}

#[tokio::test]
async fn stop_stops_the_harness_through_shutdown_and_it_stays_stopped_until_asked() {
    let bed = Bed::new();
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    assert_eq!(sidecar.ensure().await.state, State::Running);
    let stopped = sidecar.act(Action::Stop).await;
    assert_eq!(stopped.state, State::Stopped, "{stopped:?}");
    assert_eq!(bed.lines(), ["serving", "exit"]);
    assert_eq!(sidecar.ensure().await.state, State::Stopped, "not started again by a read");
    assert_eq!(bed.pids("serving").len(), 1);
    assert_eq!(sidecar.act(Action::Start).await.state, State::Running);
    assert_eq!(bed.pids("serving").len(), 2);
    bed.none_left().await;
}

#[tokio::test]
async fn a_harness_that_takes_shutdown_and_never_answers_leaves_stop_waiting_only_its_limit() {
    let bed = Bed::new();
    let fake = Fake { protocol: PROTOCOL, build: "new".into(), log: bed.log.clone(), die_once: None, mute: true };
    let limits = Limits { stopping_within: Duration::from_millis(500), ..Limits::default() };
    let sidecar = Sidecar::new(bed.dir.clone(), bed.fake_with("harness", fake), Box::new(bed.vault()), limits);
    assert_eq!(sidecar.ensure().await.state, State::Running);
    let stopped = tokio::time::timeout(WAIT, sidecar.act(Action::Stop)).await.expect("Stop came back");
    assert_eq!(stopped.state, State::Failed);
    assert!(stopped.message.as_deref().is_some_and(|m| m.contains("still stopping")), "{stopped:?}");
    assert_eq!(sidecar.act(Action::Start).await.state, State::Running, "the manager is free again");
    bed.none_left().await;
}

#[tokio::test]
async fn stop_while_a_harness_is_stopping_without_its_socket_waits_for_the_folder_and_never_says_stopped_early() {
    let bed = Bed::new();
    bed.token();
    DirBuilder::new().recursive(true).mode(0o700).create(&bed.dir).unwrap();
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(bed.dir.join("lock")).unwrap();
    lock.try_lock().unwrap();
    let limits = Limits { stopping_within: Duration::from_millis(300), ..Limits::default() };
    let sidecar = Sidecar::new(bed.dir.clone(), bed.fake("harness", PROTOCOL, "new"), Box::new(bed.vault()), limits);
    let held = sidecar.act(Action::Stop).await;
    assert_eq!(held.state, State::Failed, "{held:?}");
    assert!(held.message.as_deref().is_some_and(|m| m.contains("still stopping")), "{held:?}");
    drop(lock);
    assert_eq!(sidecar.act(Action::Stop).await.state, State::Stopped, "once the folder is free");
    assert!(bed.pids("serving").is_empty());
}

#[test]
fn a_restart_that_finds_a_harness_it_cannot_use_keeps_why_and_still_names_the_agents_left() {
    let failed = Status { state: State::Failed, build: None, bundled_build: None, update: true, message: Some("Older.".into()), mock: false };
    let said = restarted(failed, &["s1".into()]).message.unwrap();
    assert!(said.starts_with("Older.") && said.contains("s1"), "{said}");
    let running = Status { state: State::Running, build: None, bundled_build: None, update: false, message: None, mock: false };
    assert_eq!(restarted(running, &[]).message.as_deref(), Some("Restarted."));
}

#[tokio::test]
async fn a_client_is_proven_with_the_managers_token_and_nothing_is_started_or_stopped_for_one() {
    let bed = Bed::new();
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    let none = sidecar.client().await.err().unwrap();
    assert!(none.contains("no key"), "{none}");
    let hex = bed.token().hex();
    let none = sidecar.client().await.err().unwrap();
    assert!(none.contains("isn't running") && !none.contains(&hex), "{none}");
    assert!(bed.pids("serving").is_empty(), "nothing was started for it");

    assert_eq!(sidecar.ensure().await.state, State::Running);
    let client = sidecar.client().await.unwrap();
    assert_eq!(client.hello.protocol, PROTOCOL, "a proven client of this protocol");
    drop(client);
    let started = bed.pids("serving");
    assert_eq!(started.len(), 1, "the one the manager started");
    bed.end(started[0]).await;

    let old = bed.serve_by_hand(&bed.fake("old", PROTOCOL - 1, "old"), &bed.token()).await;
    let other = sidecar.client().await.err().unwrap();
    assert!(other.contains(&format!("protocol {}", PROTOCOL - 1)) && !other.contains(&hex), "{other}");
    assert!(bed.running(old), "not stopped for it");
    bed.none_left().await;
}

#[test]
fn the_mock_line_comes_from_the_drivers_the_harness_names() {
    let served = serde_json::json!({ "drivers": [{ "name": "claude" }, { "name": "mock" }], "logins": [] });
    assert!(offers(&served, "mock") && offers(&served, "claude"));
    assert!(!offers(&serde_json::json!({ "drivers": [{ "name": "claude" }] }), "mock"), "an adopted harness that serves no mock");
    assert!(!offers(&serde_json::json!({}), "mock"));
}
