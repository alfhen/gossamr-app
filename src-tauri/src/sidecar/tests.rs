//! The manager against a fake harness: this test binary, run again through a link to the harness crate's checked
//! `run-body.sh` (a new executable's first run is checked by macOS, which made tests that write one flaky). The fake
//! speaks the hello and the proof with the protocol and build its body names, keeps only stored keys, holds the data
//! folder's lock as the harness does, and logs each life to a file of the test's. Every test proves afterwards that
//! no fake still runs.

use std::io::BufRead;
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
/// Only a failure waits this long.
const WAIT: Duration = Duration::from_secs(20);

#[derive(Serialize, Deserialize)]
struct Fake {
    protocol: u32,
    build: String,
    /// Where each life writes `serving <pid>`, `in-use <pid>` and `died <pid>`, and `seen-<pid>` its argv and env.
    log: PathBuf,
    /// Dies after its first hello, once: the file says it already has.
    die_once: Option<PathBuf>,
}

/// Is the fake harness when its variable is set, and a test that passes otherwise.
#[test]
fn fake_harness() {
    let Some(config) = std::env::var_os(FAKE) else { return };
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
    let env: Vec<String> = std::env::vars().filter(|(name, _)| name != FAKE).map(|(name, value)| format!("{name}={value}")).collect();
    std::fs::write(seen, format!("{argv}\n{}", env.join("\n"))).unwrap();
    let ["serve", "--data", dir] = args[..] else { return 2 };
    let dir = PathBuf::from(dir);
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
        self.fake_with(name, Fake { protocol, build: build.into(), log: self.log.clone(), die_once: None })
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

    /// Starts `program` as an earlier run of the app would have, and waits until it serves.
    async fn serve_by_hand(&self, program: &Path, token: &Token) -> u32 {
        DirBuilder::new().recursive(true).mode(0o700).create(&self.dir).unwrap();
        let before = self.pids("serving").len();
        let child = spawn(program, &self.dir, token).unwrap();
        let pid = child.id();
        reap(child);
        let until = Instant::now() + WAIT;
        while self.pids("serving").len() == before {
            assert!(Instant::now() < until, "the fake did not serve");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        pid
    }

    fn pids(&self, what: &str) -> Vec<u32> {
        let log = std::fs::read_to_string(&self.log).unwrap_or_default();
        log.lines().filter_map(|line| line.strip_prefix(what)?.trim().parse().ok()).collect()
    }

    fn lines(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines().map(|line| line.split(' ').next().unwrap().to_owned()).collect()
    }

    /// Stops every fake still running and proves none is left.
    async fn none_left(&self) {
        for pid in self.pids("serving") {
            if alive(pid) {
                // SAFETY: kill has no preconditions; the pid is a fake this test started.
                unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            }
        }
        let until = Instant::now() + WAIT;
        while self.pids("serving").into_iter().any(alive) {
            assert!(Instant::now() < until, "a fake is still running");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for Bed {
    fn drop(&mut self) {
        for pid in self.pids("serving").into_iter().filter(|pid| alive(*pid)) {
            // SAFETY: as in `none_left`, on a failed test's way out.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
    }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
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
    assert!(alive(old));
    let restarted = sidecar.act(Action::Restart).await;
    assert_eq!((restarted.state, restarted.build.as_deref(), restarted.update), (State::Running, Some("new"), false), "{restarted:?}");
    assert_eq!(bed.lines(), ["serving", "exit", "serving"]);
    bed.none_left().await;
}

#[tokio::test]
async fn an_older_protocol_is_shut_down_through_its_own_call_and_the_bundled_one_starts() {
    let bed = Bed::new();
    bed.serve_by_hand(&bed.fake("old", PROTOCOL - 1, "old"), &bed.token()).await;
    let status = bed.sidecar(&bed.fake("harness", PROTOCOL, "new")).ensure().await;
    assert_eq!((status.state, status.build.as_deref()), (State::Running, Some("new")), "{status:?}");
    assert!(status.message.as_deref().is_some_and(|m| m.contains("replaced") && m.contains("stopped its agents")), "{status:?}");
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
    assert!(alive(newer), "it is left running");
    assert_eq!(bed.pids("serving").len(), 1);
    bed.none_left().await;
}

#[tokio::test]
async fn a_dead_harness_is_started_again_over_its_stale_socket() {
    let bed = Bed::new();
    let sidecar = bed.sidecar(&bed.fake("harness", PROTOCOL, "new"));
    assert_eq!(sidecar.ensure().await.state, State::Running);
    let first = bed.pids("serving")[0];
    // SAFETY: kill has no preconditions; the pid is the fake this test's manager started.
    unsafe { libc::kill(first as libc::pid_t, libc::SIGKILL) };
    let until = Instant::now() + WAIT;
    while alive(first) {
        assert!(Instant::now() < until);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
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
    // Each read the empty vault before either saved, as two apps opened at once do.
    let (one, two) = (bed.sidecar(&program), bed.sidecar(&program));
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
    assert!(alive(foreign), "left alone");
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
    let until = Instant::now() + WAIT;
    while bed.pids("serving").into_iter().any(alive) {
        assert!(Instant::now() < until, "the one it started was not stopped");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
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
    let fake = Fake { protocol: PROTOCOL, build: "new".into(), log: bed.log.clone(), die_once: Some(bed.root.join("died")) };
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
    assert!(!seen.contains(&hex), "neither its argv nor its environment holds the token");
    bed.none_left().await;
}

#[test]
fn the_harness_starts_without_the_variable_serve_refuses() {
    let command = serve_command(Path::new("harness"), Path::new("data"));
    assert!(command.get_envs().any(|(name, value)| name == harness::cli::TOKEN_VARIABLE && value.is_none()), "HARNESS_TOKEN is taken out of its environment");
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args, ["serve", "--data", "data"]);
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
