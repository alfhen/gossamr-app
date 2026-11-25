//! Starts the bundled harness beside the app, or adopts the one already serving its data folder (proposal 3.2).
//!
//! The harness is started detached, in a session of its own, so it outlives the app and its agents keep running. The
//! app's client token lives in the vault item and in memory, and reaches the harness on its stdin only. Same protocol:
//! adopted, whatever its build, and an older build is offered a restart. An older protocol: kept, since stopping it
//! ends its agents' turns, and offered a restart, which stops it through its own `shutdown` (every protocol keeps it)
//! and starts the bundled one (H10 resumes the sessions). A newer protocol: left alone, with "update Gossamr". A harness that does not know the app's token is
//! never killed: the app cannot prove it is its own. Only a child the app started itself, still unreaped, is signalled.

use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use harness::api::{socket_path, Op, PROTOCOL};
use harness::auth::Token;
use harness::client::Client;
use harness::error::Error as HarnessError;
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

/// The vault account that holds the client token, as 64 hex digits.
pub const TOKEN_ACCOUNT: &str = "harness";
/// The app's own files in the data folder: the lock two apps take to start or adopt one at a time, and the
/// harness's stderr from its last start by the app.
const APP_LOCK: &str = "app.lock";
const LOG: &str = "harness.log";

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// For one connection and its proof.
    pub prove_within: Duration,
    /// From the start until the socket answers.
    pub start_within: Duration,
    /// For a harness that holds the data folder with no socket, as one does while it shuts down.
    pub stopping_within: Duration,
    /// For the bundled harness to say its build.
    pub probe_within: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { prove_within: Duration::from_secs(10), start_within: Duration::from_secs(10), stopping_within: Duration::from_secs(60), probe_within: Duration::from_secs(5) }
    }
}

/// Where the client token is kept: the vault item, or a test's vault.
pub trait Keep: Send + Sync {
    /// Reads the store again: another app may have saved the token since this one read it.
    fn reread(&self) -> crate::error::Result<()>;
    fn load(&self) -> crate::error::Result<Option<String>>;
    fn save(&self, hex: &str) -> crate::error::Result<()>;
}

/// The app's vault item.
pub struct VaultItem;

impl Keep for VaultItem {
    fn reread(&self) -> crate::error::Result<()> {
        crate::secrets::reread()
    }
    fn load(&self) -> crate::error::Result<Option<String>> {
        crate::secrets::load(TOKEN_ACCOUNT)
    }
    fn save(&self, hex: &str) -> crate::error::Result<()> {
        crate::secrets::save(TOKEN_ACCOUNT, &hex)
    }
}

impl Keep for crate::secrets::Vault {
    fn reread(&self) -> crate::error::Result<()> {
        crate::secrets::Vault::reread(self)
    }
    fn load(&self) -> crate::error::Result<Option<String>> {
        crate::secrets::Vault::load(self, TOKEN_ACCOUNT)
    }
    fn save(&self, hex: &str) -> crate::error::Result<()> {
        crate::secrets::Vault::save(self, TOKEN_ACCOUNT, &hex)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Starting,
    Running,
    /// Stopped from Settings; it starts again only when asked.
    Stopped,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: State,
    /// The running harness's build.
    pub build: Option<String>,
    /// The bundled harness's build.
    pub bundled_build: Option<String>,
    /// The running harness is another build of the same protocol, so a restart updates it.
    pub update: bool,
    /// What the person should know, in the app's words.
    pub message: Option<String>,
    /// The harness serves the mock a debug build's `GOSSAMR_MOCK_SCRIPT` names, and the app's agents run on that.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub mock: bool,
}

impl Status {
    pub fn no_folder() -> Status {
        Status::new(State::Failed, Some("Gossamr couldn't find a folder for the harness: your home folder isn't set.".into()))
    }

    fn new(state: State, message: Option<String>) -> Status {
        Status { state, build: None, bundled_build: None, update: false, message, mock: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Start,
    Restart,
    /// Stops all agents and the harness.
    Stop,
}

struct Inner {
    token: Option<Token>,
    /// Once asked: the bundled harness's build, if it said one.
    bundled_build: Option<Option<String>>,
    excluded: bool,
    stopped_by_you: bool,
}

pub struct Sidecar {
    dir: PathBuf,
    program: PathBuf,
    keep: Box<dyn Keep>,
    limits: Limits,
    /// Held for each start, adopt, stop or restart, so two of them in this app never interleave.
    work: tokio::sync::Mutex<Inner>,
    status: Mutex<Status>,
    #[cfg(test)]
    waiting: tokio::sync::Notify,
}

impl Sidecar {
    pub fn new(dir: PathBuf, program: PathBuf, keep: Box<dyn Keep>, limits: Limits) -> Sidecar {
        // The harness runs in its data folder, so a relative one would name another folder there.
        let dir = std::path::absolute(&dir).unwrap_or(dir);
        let inner = Inner { token: None, bundled_build: None, excluded: false, stopped_by_you: false };
        Sidecar {
            dir,
            program,
            keep,
            limits,
            work: tokio::sync::Mutex::new(inner),
            status: Mutex::new(Status::new(State::Starting, None)),
            #[cfg(test)]
            waiting: tokio::sync::Notify::new(),
        }
    }

    /// The harness next to the app's own executable, on the data folder the harness itself would choose.
    pub fn bundled(limits: Limits) -> Option<Sidecar> {
        let program = std::env::current_exe().ok()?.parent()?.join("harness");
        Some(Sidecar::new(harness::store::default_dir()?, program, Box::new(VaultItem), limits))
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Starts or adopts the harness unless it was stopped from Settings. While another call is at work, its status.
    pub async fn ensure(&self) -> Status {
        let Ok(mut inner) = self.work.try_lock() else { return self.status() };
        if inner.stopped_by_you {
            return self.status();
        }
        self.run(&mut inner, None).await
    }

    pub async fn act(&self, action: Action) -> Status {
        let mut inner = self.work.lock().await;
        // Before the call: a Stop whose answer is lost may still have stopped it, and a read must not start it again.
        inner.stopped_by_you = action == Action::Stop;
        self.run(&mut inner, Some(action)).await
    }

    /// Whether the running harness offers `provider`, as its `providers` says.
    pub async fn serves(&self, provider: &str) -> bool {
        let Ok(mut client) = self.client().await else { return false };
        let Ok(offered) = client.call(Op::Providers { logins: Vec::new() }).await else { return false };
        offers(&offered, provider)
    }

    /// A client of the harness, proven with the app's token, which never leaves the manager. It starts and stops
    /// nothing: with no harness serving, one of another protocol, or one that doesn't know the token, it says why, and
    /// starting or restarting stays with `ensure` and Settings. Before the first start it reads the vault but makes no
    /// token.
    pub async fn client(&self) -> Result<Client, String> {
        let token = {
            let mut inner = self.work.lock().await;
            match &inner.token {
                Some(token) => token.clone(),
                None => {
                    let refused = |e: crate::error::Error| format!("The harness needs Gossamr's key from the Keychain, which couldn't be read: {e}");
                    self.keep.reread().map_err(refused)?;
                    let found = self.keep.load().map_err(refused)?;
                    let token = found.as_deref().and_then(Token::parse).ok_or("Gossamr has no key for the harness yet. It makes one when it first starts the harness.")?;
                    inner.token = Some(token.clone());
                    token
                }
            }
        };
        let client = match Client::connect_any_protocol(&self.dir, &token, self.limits.prove_within).await {
            Ok(client) => client,
            Err(e) if harness::client::not_proven(&e) => return Err(self.not_this_key()),
            Err(e) if nothing_serving(&e) => return Err("The harness isn't running. Start it in Settings > Harness.".into()),
            Err(e) => return Err(format!("Gossamr couldn't reach the harness: {e}")),
        };
        match client.hello.protocol {
            PROTOCOL => Ok(client),
            other => Err(format!("The running harness speaks protocol {other}, and Gossamr {PROTOCOL}. Settings > Harness says what to do.")),
        }
    }

    async fn run(&self, inner: &mut Inner, action: Option<Action>) -> Status {
        self.set(Status::new(State::Starting, None));
        let mut status = match self.work_on(inner, action).await {
            Ok(status) => status,
            Err(message) => Status::new(State::Failed, Some(message)),
        };
        if status.bundled_build.is_none() {
            status.bundled_build = self.bundled_build(inner).await;
        }
        if status.state == State::Running {
            status.update = status.build.is_some() && status.build != status.bundled_build && status.bundled_build.is_some();
        }
        self.set(status.clone());
        status
    }

    fn set(&self, status: Status) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    async fn work_on(&self, inner: &mut Inner, action: Option<Action>) -> Result<Status, String> {
        let socket = socket_path(&self.dir).map_err(|e| match e {
            HarnessError::SocketPathTooLong { len, max, .. } => {
                format!("The harness can't start: the path of its folder is too long for macOS ({len} bytes, at most {max}). Its folder: {}", self.dir.display())
            }
            other => other.to_string(),
        })?;
        self.prepare(inner).map_err(|e| format!("Gossamr couldn't make the harness's folder: {e}"))?;
        let lock = self.app_lock().await?;
        let token = self.token(inner)?;
        let result = match action {
            Some(Action::Stop) => self.stop(&token).await.map(|left| Status::new(State::Stopped, Some(left_message("Stopped.", &left)))),
            Some(Action::Restart) => match self.stop(&token).await {
                Ok(left) => restarted(self.start_or_adopt(&token, &socket).await, &left),
                Err(e) => Err(e),
            },
            Some(Action::Start) | None => self.start_or_adopt(&token, &socket).await,
        };
        drop(lock);
        result
    }

    /// The token from the vault, or a new one saved there first, so a harness never learns a token the app could lose.
    /// A new one only for a folder with no store yet: a store with tokens takes no new one on stdin. Read again under
    /// the app lock first: a second app that read the vault before the first saved its token would otherwise miss it
    /// and write its older copy over it.
    fn token(&self, inner: &mut Inner) -> Result<Token, String> {
        if let Some(token) = &inner.token {
            return Ok(token.clone());
        }
        let refused = |e: crate::error::Error| format!("The harness needs Gossamr's key from the Keychain, which couldn't be read or saved: {e}");
        self.keep.reread().map_err(refused)?;
        let token = match self.keep.load().map_err(refused)? {
            Some(hex) => Token::parse(&hex).ok_or("The harness key in Gossamr's Keychain item is damaged.")?,
            None if harness::store::holds_client_tokens(&self.dir) => return Err(self.not_this_key()),
            None => {
                let token = Token::random();
                self.keep.save(&token.hex()).map_err(refused)?;
                token
            }
        };
        inner.token = Some(token.clone());
        Ok(token)
    }

    /// Makes the data folder, only you can open it, and keeps it out of Time Machine once per run.
    fn prepare(&self, inner: &mut Inner) -> std::io::Result<()> {
        DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
        if !inner.excluded {
            inner.excluded = exclude_from_backups(&self.dir);
        }
        Ok(())
    }

    async fn app_lock(&self) -> Result<File, String> {
        let file = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(self.dir.join(APP_LOCK));
        let file = file.map_err(|e| format!("Gossamr couldn't open its lock in the harness's folder: {e}"))?;
        let locked = tokio::task::spawn_blocking(move || file.lock().map(|()| file));
        match tokio::time::timeout(self.limits.stopping_within + self.limits.start_within, locked).await {
            Ok(Ok(Ok(file))) => Ok(file),
            Ok(Ok(Err(e))) => Err(format!("Gossamr couldn't take its lock in the harness's folder: {e}")),
            _ => Err("Another Gossamr is still starting the harness. Try again in a minute.".into()),
        }
    }

    async fn start_or_adopt(&self, token: &Token, socket: &Path) -> Result<Status, String> {
        let mut started: Option<Child> = None;
        let mut failures = 0;
        let mut waiting_since: Option<Instant> = None;
        loop {
            match Client::connect_any_protocol(&self.dir, token, self.limits.prove_within).await {
                Ok(client) => {
                    let hello = client.hello.clone();
                    if hello.protocol != PROTOCOL && started.is_some() {
                        stop_started(started.take().expect("a child was started"), self.limits.prove_within).await;
                        return Err(format!("The harness that came with Gossamr speaks protocol {}, and Gossamr {PROTOCOL}. Reinstall Gossamr.", hello.protocol));
                    }
                    if hello.protocol == PROTOCOL {
                        if let Some(child) = started.take() {
                            reap(child);
                        }
                        return Ok(Status { build: Some(hello.build), ..Status::new(State::Running, None) });
                    }
                    if hello.protocol > PROTOCOL {
                        let message = format!("The running harness is newer than this Gossamr (protocol {}, Gossamr knows {PROTOCOL}). Update Gossamr.", hello.protocol);
                        return Err(message);
                    }
                    // Stopping it ends its agents' turns, so that is yours to choose: Restart does it through its own `shutdown`.
                    let message = format!("The running harness came with an older Gossamr (protocol {}), so this one can't use it. Restarting it stops any agents it runs.", hello.protocol);
                    return Ok(Status { build: Some(hello.build), update: true, ..Status::new(State::Failed, Some(message)) });
                }
                Err(e) if harness::client::not_proven(&e) => {
                    if let Some(child) = started.take() {
                        stop_started(child, self.limits.prove_within).await;
                        return Err(self.not_this_key());
                    }
                    return Err("A harness is running that doesn't know this Gossamr's key, so Gossamr leaves it alone. Stop it with `harness shutdown`, then try again.".into());
                }
                Err(e) if nothing_serving(&e) => {
                    if let Some(mut child) = started.take() {
                        if let Ok(Some(exit)) = child.try_wait() {
                            // A store of another install's key: starting it again would only be refused again.
                            if exit.code() == Some(i32::from(harness::server::UNKNOWN_TOKEN_EXIT)) {
                                return Err(self.not_this_key());
                            }
                            failures += 1;
                        } else {
                            started = Some(child);
                        }
                    }
                    if started.is_none() {
                        if held(&self.dir.join("lock")) {
                            let since = *waiting_since.get_or_insert_with(Instant::now);
                            #[cfg(test)]
                            self.waiting.notify_one();
                            if since.elapsed() > self.limits.stopping_within {
                                return Err("The harness is still stopping. Try again in a minute.".into());
                            }
                            tokio::time::sleep(Duration::from_millis(25)).await;
                            continue;
                        }
                        if failures >= 3 {
                            return Err(format!("The harness stopped as it started: {}", self.last_log_line()));
                        }
                        let child = spawn(&self.program, &self.dir, token).map_err(|e| format!("Gossamr couldn't start the harness at {}: {e}", self.program.display()))?;
                        started = Some(child);
                    }
                    let child = started.as_mut().expect("a child was just started");
                    if !self.wait_ready(child, socket).await && matches!(child.try_wait(), Ok(None)) {
                        failures += 1;
                        stop_started(started.take().expect("a child was just started"), self.limits.prove_within).await;
                    }
                }
                Err(e) => {
                    // It answered and went: a harness that died before the proof, or one still starting.
                    failures += 1;
                    if let Some(child) = started.take() {
                        stop_started(child, self.limits.prove_within).await;
                    }
                    if failures >= 3 {
                        return Err(format!("Gossamr couldn't reach the harness: {e}"));
                    }
                }
            }
        }
    }

    /// Until the socket takes a connection (true), the child exits, or the start limit passes.
    async fn wait_ready(&self, child: &mut Child, socket: &Path) -> bool {
        let until = Instant::now() + self.limits.start_within;
        while Instant::now() < until {
            if std::os::unix::net::UnixStream::connect(socket).is_ok() {
                return true;
            }
            if !matches!(child.try_wait(), Ok(None)) {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// Tells a harness of this app's token to stop every session and itself, and waits until the data folder is free.
    async fn stop(&self, token: &Token) -> Result<Vec<String>, String> {
        let mut client = match Client::connect_any_protocol(&self.dir, token, self.limits.prove_within).await {
            Ok(client) => client,
            // One that is stopping has taken its socket away and still holds the folder: wait for it below.
            Err(e) if nothing_serving(&e) => return self.until_free().await.map(|()| vec![]),
            Err(e) if harness::client::not_proven(&e) => return Err("A harness is running that doesn't know this Gossamr's key, so Gossamr leaves it alone.".into()),
            Err(e) => return Err(format!("Gossamr couldn't reach the harness: {e}")),
        };
        let stopping = || "The harness is still stopping. Try again in a minute.".to_owned();
        let answer = tokio::time::timeout(self.limits.stopping_within, client.call(Op::Shutdown)).await.map_err(|_| stopping())?;
        let answer = answer.map_err(|e| format!("Gossamr couldn't stop the harness: {e}"))?;
        drop(client);
        self.until_free().await?;
        Ok(left_of(&answer))
    }

    /// Until no harness holds the data folder, or `stopping_within` passes.
    async fn until_free(&self) -> Result<(), String> {
        let until = Instant::now() + self.limits.stopping_within;
        while held(&self.dir.join("lock")) {
            if Instant::now() > until {
                return Err("The harness is still stopping. Try again in a minute.".into());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok(())
    }

    /// What the bundled harness says its build is, asked once per run.
    async fn bundled_build(&self, inner: &mut Inner) -> Option<String> {
        if inner.bundled_build.is_none() {
            let (program, within) = (self.program.clone(), self.limits.probe_within);
            inner.bundled_build = Some(tokio::task::spawn_blocking(move || build_of(&program, within)).await.ok().flatten());
        }
        inner.bundled_build.clone().flatten()
    }

    fn not_this_key(&self) -> String {
        format!("The harness's folder holds a key this Gossamr doesn't have. If another Gossamr is open, quit both and open one; otherwise move the folder away: {}", self.dir.display())
    }

    fn last_log_line(&self) -> String {
        let log = std::fs::read_to_string(self.dir.join(LOG)).unwrap_or_default();
        log.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("it said nothing").trim_start_matches("harness: ").to_owned()
    }
}

/// Starts `harness serve` in a session of its own, with stderr in the log and the token on stdin. Its environment is
/// the app's without `HARNESS_TOKEN`, which `serve` refuses.
fn spawn(program: &Path, dir: &Path, token: &Token) -> std::io::Result<Child> {
    let log = OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(dir.join(LOG))?;
    let mut command = serve_command(program, dir, mock_script().as_deref());
    command.stderr(log);
    // SAFETY: sysconf has no preconditions.
    let open_max = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) }.clamp(256, 1 << 16) as libc::c_int;
    // SAFETY: `setsid` and `fcntl` are async-signal-safe and the closure touches nothing else.
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // A descriptor the app or a library opened without close-on-exec would stay open in the harness, which
            // outlives the app. Marking them, not closing them, keeps the pipe that reports a failed exec.
            for fd in 3..open_max {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags != -1 && flags & libc::FD_CLOEXEC == 0 {
                    libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
                }
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{}\n", token.hex()).as_bytes());
    }
    Ok(child)
}

/// What `program --version` says its build is. One that hasn't exited within `within` is killed and says none: the
/// manager holds its lock while it waits.
fn build_of(program: &Path, within: Duration) -> Option<String> {
    let mut child = Command::new(program).arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let until = Instant::now() + within;
    while matches!(child.try_wait(), Ok(None)) {
        if Instant::now() > until {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    out.split("(build ").nth(1).and_then(|rest| rest.split(')').next()).map(str::to_owned)
}

/// Runs in the data folder, so the harness holds no other folder of the person's open as its working folder.
fn serve_command(program: &Path, dir: &Path, mock: Option<&Path>) -> Command {
    let mut command = Command::new(program);
    command.arg("serve").arg("--data").arg(dir).current_dir(dir).env_remove(harness::cli::TOKEN_VARIABLE).stdin(Stdio::piped()).stdout(Stdio::null());
    // The person's "Agents running at once" is the app's to hold: the harness may never hold back fewer.
    command.arg("--turn-limit").arg(crate::config::MAX_RUNS.end().to_string());
    if let Some(script) = mock {
        command.arg("--mock-script").arg(script);
    }
    command
}

/// Whether a `providers` answer names `provider` among its drivers.
fn offers(offered: &serde_json::Value, provider: &str) -> bool {
    offered["drivers"].as_array().is_some_and(|drivers| drivers.iter().any(|driver| driver["name"] == provider))
}

/// The variable that makes a debug build serve the harness's mock provider from the script it names, and open its
/// runs on it, so a run can be tried with no provider. A release build has no such code.
#[cfg(debug_assertions)]
pub const MOCK_SCRIPT_VARIABLE: &str = "GOSSAMR_MOCK_SCRIPT";

/// The mock script a debug build was started with, as a full path, since the harness runs in its data folder.
pub fn mock_script() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os(MOCK_SCRIPT_VARIABLE).filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return Some(std::fs::canonicalize(&path).unwrap_or(path));
    }
    None
}

/// Waits for the child in the background, so it leaves no zombie while the app runs; once the app quits, launchd does.
fn reap(mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
}

/// `stop_child` off the async worker, which its wait would hold for up to `within`.
async fn stop_started(child: Child, within: Duration) {
    let _ = tokio::task::spawn_blocking(move || stop_child(child, within)).await;
}

/// Stops a child this app started and has not reaped, so its pid is still its own.
fn stop_child(mut child: Child, within: Duration) {
    if let Ok(None) = child.try_wait() {
        // SAFETY: kill has no preconditions; the pid is an unreaped child's, so no other process can have it.
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        let until = Instant::now() + within;
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = child.kill();
    }
    reap(child);
}

/// No harness takes connections on the socket: there is none, or one left by a harness that died.
fn nothing_serving(e: &HarnessError) -> bool {
    matches!(e, HarnessError::Io(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused))
}

/// Whether a harness holds the data folder's lock. Taken and given back at once when it is free.
fn held(lock: &Path) -> bool {
    match File::open(lock) {
        Ok(file) => matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        Err(_) => false,
    }
}

fn left_of(answer: &serde_json::Value) -> Vec<String> {
    answer["left"].as_array().map(|left| left.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

/// What Restart says: that it restarted, why the harness found in its place can't be used, as one may come up in
/// between, or why the new one didn't start; then any agents the old one left.
fn restarted(started: Result<Status, String>, left: &[String]) -> Result<Status, String> {
    let mut status = started.map_err(|why| left_message(why.trim(), left))?;
    let done = match status.state {
        State::Running => "Restarted.".to_owned(),
        _ => status.message.take().unwrap_or_default(),
    };
    status.message = Some(left_message(done.trim(), left));
    Ok(status)
}

fn left_message(done: &str, left: &[String]) -> String {
    match left {
        [] => done.to_owned(),
        left => format!("{done} The agents of these sessions didn't stop and may still run: {}.", left.join(", ")),
    }
}

/// Keeps the folder out of Time Machine with the sticky exclusion `tmutil addexclusion` sets, which goes with the folder
/// (`NSURLIsExcludedFromBackupKey`; `tmutil` itself takes seconds). True when it holds.
#[cfg(target_os = "macos")]
fn exclude_from_backups(dir: &Path) -> bool {
    use objc2_foundation::{NSNumber, NSString, NSURL};
    let Some(path) = dir.to_str() else { return false };
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let yes = NSNumber::numberWithBool(true);
    // SAFETY: the key takes an NSNumber holding a boolean.
    let done = unsafe { url.setResourceValue_forKey_error(Some(yes.as_ref()), objc2_foundation::NSURLIsExcludedFromBackupKey) };
    if done.is_err() {
        eprintln!("couldn't keep the harness's folder out of Time Machine");
    }
    done.is_ok()
}

#[cfg(not(target_os = "macos"))]
fn exclude_from_backups(_: &Path) -> bool {
    true
}
