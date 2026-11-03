//! What the person can do to a run: stop it, stop a workstream's, stop everything, open it in Terminal, see how much
//! disk it uses.
//!
//! Only runs Gossamr started are touched: `stop_all` walks the run index, never the full `claude agents` listing.

use std::ffi::OsString;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::backend::{Purpose, RunBackend, Session};
use super::provider_env::ProviderEnv;
use super::service::RunService;
use super::toolchain::Toolchain;
use crate::auth::Scope;
use crate::config::TerminalChoice;
use crate::connections::Driver;
use crate::domain::workstream::PauseReason;
use crate::domain::{Actor, Run, RunFailure, RunQuery, RunState};
use crate::error::{Error, Result};

const DISK_LIMIT: Duration = Duration::from_secs(3);
const ATTACH_KEPT: Duration = Duration::from_secs(24 * 60 * 60);
const ATTACH_DIR: &str = "attach";
/// Why a run stopped while it waited for a slot.
pub const NOT_STARTED: &str = "Stopped before it started";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StopAll {
    pub stopped: usize,
    /// Runs that couldn't be stopped, including ones that aren't working yet.
    pub failed: usize,
    /// Approved runs that were waiting for a slot, stopped before they started so none takes a freed one.
    pub waiting: usize,
}

/// A run queued only because the cap was full: it has no session, and it would start on its own.
fn waits_for_slot(run: &Run) -> bool {
    run.state == RunState::Queued && run.slot_wait_since.is_some() && run.short_id.is_none()
}

/// A run that hasn't launched: queued with no session, whether it waits for a slot or not. Under the launch
/// lock nothing can launch it, so it is withdrawn (stopped before it started) without asking Claude anything.
fn withdrawable(run: &Run) -> bool {
    run.state == RunState::Queued && run.short_id.is_none()
}

fn can_stop(state: RunState) -> bool {
    matches!(state, RunState::Working | RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked)
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// What opens the `.command` file in Terminal.
pub trait Terminal: Send + Sync {
    fn open(&self, file: &Path, app: TerminalChoice) -> std::io::Result<()>;
}

/// `open -a <Terminal or iTerm> <file>`, with the file as its own argument: no shell, no Apple Events and so no
/// permission prompt.
pub fn open_args(file: &Path, app: TerminalChoice) -> Vec<OsString> {
    let name = match app {
        TerminalChoice::Terminal => "Terminal",
        TerminalChoice::ITerm => "iTerm",
    };
    vec!["-a".into(), name.into(), file.as_os_str().to_owned()]
}

pub struct MacTerminal;

impl Terminal for MacTerminal {
    fn open(&self, file: &Path, app: TerminalChoice) -> std::io::Result<()> {
        let status = std::process::Command::new("/usr/bin/open").args(open_args(file, app)).status()?;
        status.success().then_some(()).ok_or_else(|| std::io::Error::other(format!("open exited with {status}")))
    }
}

/// A path that can sit inside single quotes in a script: absolute, and no quote or control character (newline and NUL
/// included). One with a quote is refused rather than escaped, so there is no quoting to get wrong.
pub(super) fn quotable(path: &Path) -> Result<&str> {
    let text = path.to_str().ok_or_else(|| refuse("that path isn't valid text"))?;
    if !path.is_absolute() || text.chars().any(|c| c == '\'' || c.is_control()) {
        return Err(refuse(format!("Gossamr won't open Terminal in {}: the path has a quote or an unusual character in it", text.escape_debug())));
    }
    Ok(text)
}

/// The lines that make a script run as an instance with a folder: the other login variables removed and the folder
/// variable set, so what the shell exports can't pick another login (6.4). Nothing for an instance without a folder,
/// where Terminal's own environment picks the login.
fn login_lines(login: Option<&ProviderEnv>) -> Result<String> {
    let Some(login) = login.and_then(ProviderEnv::terminal_login) else { return Ok(String::new()) };
    let (name, folder) = login.export;
    let folder = quotable(Path::new(folder))?;
    let unset = if login.unset.is_empty() { String::new() } else { format!("unset {}\n", login.unset.join(" ")) };
    Ok(format!("{unset}export {name}='{folder}'\n"))
}

fn digest_of(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Writes `<dir>/<name>-<digest of the script>.command` with the script, private to the user. `name` is made here
/// from a session id or a fixed word, never from outside text. The digest keeps scripts with different content, such
/// as the same clone opened as two instances, from sharing a path that Terminal may not have read yet.
fn write_script(dir: &Path, name: &str, script: &str) -> Result<PathBuf> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let file = dir.join(format!("{name}-{}.command", digest_of(script)));
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&file)?;
    std::io::Write::write_all(&mut out, script.as_bytes())?;
    Ok(file)
}

/// The words after the program in a script: each only letters, digits and `-`, so none can be quoting or a separator. A
/// backend's words are a session id or a fixed flag; this keeps it so.
fn plain_words(words: &[String]) -> Result<String> {
    if words.iter().any(|w| w.is_empty() || !w.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        return Err(refuse("Gossamr won't open Terminal with that: a word in it isn't plain letters, digits and dashes."));
    }
    Ok(words.iter().map(|w| format!(" {w}")).collect())
}

/// Writes `<dir>/<last word>-<digest>.command`: `cd` into the worktree, then the program with the backend's `words`
/// that attach to the session. Nothing from a model or a ticket can be in it: the words are checked, and so are both paths.
pub fn write_attach_file(dir: &Path, login: Option<&ProviderEnv>, program: &Path, worktree: &Path, words: &[String]) -> Result<PathBuf> {
    let name = words.last().ok_or_else(|| refuse("that isn't a session"))?;
    let (program, worktree, words_text) = (quotable(program)?, quotable(worktree)?, plain_words(words)?);
    let login = login_lines(login)?;
    write_script(dir, name, &format!("#!/bin/zsh\n{login}cd '{worktree}'\nexec '{program}'{words_text}\n"))
}

impl Purpose {
    fn allows(self, failure: Option<&RunFailure>) -> bool {
        matches!((self, failure), (Purpose::Trust, Some(RunFailure::UntrustedFolder { .. })) | (Purpose::SignIn, Some(RunFailure::NotSignedIn)))
            || matches!((self, failure), (Purpose::Mode(wanted), Some(RunFailure::ModeRefused { mode })) if wanted == *mode)
    }

    fn refusal(self) -> &'static str {
        match self {
            Purpose::Trust => "Terminal can be opened to trust a folder only for a run that failed because Claude doesn't trust it.",
            Purpose::SignIn => "Terminal can be opened to sign in only for a run that failed because Claude isn't signed in.",
            Purpose::Mode(_) => "Terminal can be opened to accept a permission mode only for a run that failed because Claude refused that mode.",
        }
    }
}

/// `clone` as a folder it is safe to open Terminal in: a real path (no symlink on the way) strictly inside `home`,
/// holding a git clone, and fit for single quotes.
fn checked_clone(clone: &Path, home: Option<&Path>) -> Result<PathBuf> {
    let text = quotable(clone)?;
    let home = home.and_then(|h| h.canonicalize().ok()).ok_or_else(|| refuse("Gossamr can't tell where your home folder is."))?;
    let real = clone.canonicalize().map_err(|_| refuse(format!("{text} isn't a folder that exists")))?;
    if real != clone {
        return Err(refuse(format!("{text} isn't its real path: it goes through a link")));
    }
    if real == home || !real.starts_with(&home) {
        return Err(refuse(format!("{text} isn't inside your home folder")));
    }
    if !(real.is_dir() && real.join(".git").exists()) {
        return Err(refuse(format!("{text} isn't a git clone")));
    }
    Ok(real)
}

/// Writes `<dir>/<trust|signin|auto|bypass>-<digest>.command`: `cd` into the clone, then the program, which is
/// interactive and, for a refused mode, started with the backend's `words` for that mode. Both paths and the words are
/// checked, and the name is a digest, so no outside text reaches the script or its name.
pub fn write_claude_file(dir: &Path, login: Option<&ProviderEnv>, purpose: Purpose, program: &Path, words: &[String], clone: &Path, home: Option<&Path>) -> Result<PathBuf> {
    let clone = checked_clone(clone, home)?;
    let (program, clone_text, words_text) = (quotable(program)?, quotable(&clone)?, plain_words(words)?);
    let login_text = login_lines(login)?;
    write_script(dir, purpose.prefix(), &format!("#!/bin/zsh\n{login_text}cd '{clone_text}'\nexec '{program}'{words_text}\n"))
}

/// Writes `<dir>/provider-signin-<digest>.command`: the instance's login lines, then its CLI's sign-in command. The
/// subcommand comes from a fixed table per driver, and `login` can only come from `provider_env::states`, which has
/// already applied the folder rules, so nothing from the page or from a probe reaches the script. Without a folder the
/// script is the `exec` line alone and Terminal's own environment picks the login.
pub fn write_provider_signin(dir: &Path, driver: Driver, binary: &Path, login: Option<&ProviderEnv>) -> Result<PathBuf> {
    let subcommand = match driver {
        Driver::Claude => "auth login",
        Driver::Codex => "login",
    };
    let (binary, login) = (quotable(binary)?, login_lines(login)?);
    write_script(dir, "provider-signin", &format!("#!/bin/zsh\n{login}exec '{binary}' {subcommand}\n"))
}

/// Writes `<dir>/fix-<digest>.command` running `command`. The command comes from a probe's fixed
/// strings, but its host part is read from config.json, so only plain words, dots, dashes, colons and underscores
/// pass: nothing in it can be quoting, a separator or a substitution.
pub fn write_fix_file(dir: &Path, command: &str) -> Result<PathBuf> {
    let plain = !command.trim().is_empty() && command.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_' | ':'));
    if !plain {
        return Err(refuse("Gossamr won't run that command: it has a character in it that a fix never needs."));
    }
    write_script(dir, "fix", &format!("#!/bin/zsh\nunset GH_TOKEN GITHUB_TOKEN GH_HOST\n{command}\n"))
}

/// Deletes attach scripts older than a day.
pub fn clean_attach_dir(dir: &Path, older_than: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > older_than);
        if old && path.extension().is_some_and(|e| e == "command") {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Bytes under `dir`, counting until `limit` has passed. Symlinks are not followed, and a folder that can't be read
/// counts as empty.
fn size_within(dir: &Path, limit: Duration) -> u64 {
    let deadline = std::time::Instant::now() + limit;
    let (mut total, mut pending) = (0u64, vec![dir.to_path_buf()]);
    while let Some(folder) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            if std::time::Instant::now() >= deadline {
                return total;
            }
            let Ok(meta) = entry.path().symlink_metadata() else { continue };
            if meta.is_dir() {
                pending.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

impl RunService {
    pub(super) fn stopped(run: &mut Run) {
        let now = Utc::now();
        run.state = RunState::Stopped;
        run.needs = None;
        run.error = None;
        run.failure = None;
        run.ended_at = Some(now);
        run.last_progress_at = now;
    }

    /// Stops a run that is working or waiting on the person. Its conversation and worktree are kept. A queued run that
    /// hasn't launched, waiting for a slot or not, has no session yet, so it is withdrawn: marked stopped before it
    /// started, without asking Claude anything (the person's Cancel).
    pub async fn stop(&self, run_id: &str) -> Result<Run> {
        self.stop_as(run_id, Actor::Person).await
    }

    /// `stop`, recorded as `by`'s. Whoever it is, the supervisor takes the stop for a deliberate one and wakes nobody.
    pub async fn stop_as(&self, run_id: &str, by: Actor) -> Result<Run> {
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if withdrawable(&run) {
            self.withdraw(&mut run, by).await?;
            return Ok(run);
        }
        if !can_stop(run.state) {
            return Err(refuse(match run.state {
                RunState::Queued | RunState::Launching => "It can be stopped once it is working.".to_owned(),
                other => format!("This run is {}, so there is nothing to stop.", other.as_str()),
            }));
        }
        let session = Session::of(&run).ok_or_else(|| refuse("This run has no session to stop."))?;
        let tc = self.observing_toolchain(&run).await?;
        tc.backend.stop(&session).await?;
        self.end_ask_on(tc.backend.as_ref(), &run);
        Self::stopped(&mut run);
        if let Err(e) = self.index.mark_terminal(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.reset_counts(&run.id);
        // Before the run reads as stopped, so the waker never takes it for a stop from outside.
        self.note_by(&run, by, "run_stopped", None).await;
        self.store(&run).await?;
        Ok(run)
    }

    /// The person's Stop for one of `scope`'s workstreams: pauses it, so nothing wakes Pip, then stops each of its runs
    /// that can be stopped, as `stop` does one. Runs not yet working are left queued, and the pause keeps anything from
    /// starting them on its own.
    pub async fn stop_workstream(&self, scope: &Scope, id: &str) -> Result<StopAll> {
        let ws = self.core.pause_workstream(scope, id, PauseReason::Person, Actor::Person).await?;
        let runs = self.core.runs_in(scope, &RunQuery { workstream: Some(ws.id.clone()), ..Default::default() }).await?;
        let mut tally = StopAll::default();
        for run in runs.iter().filter(|r| can_stop(r.state)) {
            match self.stop(&run.id).await {
                Ok(_) => tally.stopped += 1,
                Err(e) => {
                    eprintln!("couldn't stop run {} of workstream {}: {e}", run.id, ws.id);
                    tally.failed += 1;
                }
            }
        }
        Ok(tally)
    }

    /// Marks a run waiting for a slot stopped before it started; there is no session, so Claude isn't asked. Called with
    /// the launch lock held, so nothing launches it in between.
    async fn withdraw(&self, run: &mut Run, by: Actor) -> Result<()> {
        Self::stopped(run);
        run.slot_wait_since = None;
        run.error = Some(NOT_STARTED.into());
        self.note_by(run, by, "run_stopped", None).await;
        self.store(run).await?;
        Ok(())
    }

    /// Stops the runs Gossamr started, in any account, and, in this one, the queued runs waiting for a slot, all under
    /// one hold of the launch lock: the slots it frees are never taken by a waiting run. A session that isn't in the run
    /// index is never touched.
    pub async fn stop_all(&self) -> Result<StopAll> {
        let _turn = self.launching.lock().await;
        let mut tally = StopAll::default();
        let mut toolchains: std::collections::HashMap<String, Option<Toolchain>> = Default::default();
        for entry in self.index.live() {
            // This account's run says what it is doing; another account's can only be stopped by its session id.
            let mine = self.core.run(&entry.run_id).await.ok().flatten();
            if let Some(run) = &mine {
                if !can_stop(run.state) {
                    if matches!(run.state, RunState::Done | RunState::Failed | RunState::Stopped) {
                        let _ = self.index.mark_terminal(&run.id);
                    } else {
                        tally.failed += 1;
                    }
                    continue;
                }
            }
            let Some(session) = Session::of_entry(&entry) else {
                tally.failed += 1;
                continue;
            };
            if !toolchains.contains_key(&entry.instance_id) {
                toolchains.insert(entry.instance_id.clone(), self.tools.observe_instance(&entry.instance_id).await.ok());
            }
            let Some(tc) = &toolchains[&entry.instance_id] else {
                tally.failed += 1;
                continue;
            };
            match tokio::time::timeout(tc.backend.stop_budget(), tc.backend.stop(&session)).await {
                Ok(Ok(())) => {
                    match &mine {
                        Some(run) => self.end_ask_on(tc.backend.as_ref(), run),
                        None => self.core.asks().cancel(&entry.run_id),
                    }
                    tally.stopped += 1;
                    let _ = self.index.mark_terminal(&entry.run_id);
                    self.reset_counts(&entry.run_id);
                    if let Some(mut run) = mine {
                        Self::stopped(&mut run);
                        self.note_person(&run, "run_stopped", None).await;
                        let _ = self.store(&run).await;
                    }
                }
                _ => tally.failed += 1,
            }
        }
        let queued = self.core.runs_list(&RunQuery { states: Some(vec![RunState::Queued]), ..RunQuery::default() }).await?;
        for listed in queued.iter().filter(|r| waits_for_slot(r)) {
            let Ok(mut run) = self.load(&listed.id).await else { continue };
            if !waits_for_slot(&run) {
                continue;
            }
            match self.withdraw(&mut run, Actor::Person).await {
                Ok(()) => tally.waiting += 1,
                Err(e) => {
                    eprintln!("couldn't stop waiting run {}: {e}", run.id);
                    tally.failed += 1;
                }
            }
        }
        Ok(tally)
    }

    /// Opens Terminal in the run's worktree with the backend's attach command for its session.
    pub async fn attach(&self, run_id: &str) -> Result<()> {
        let run = self.load(run_id).await?;
        let session = Session::of(&run).ok_or_else(|| refuse("This run has no session to open yet."))?;
        let tc = self.observing_toolchain(&run).await?;
        let program = tc.backend.binary().ok_or_else(|| Error::Claude("Gossamr can't tell which program to open.".into()))?;
        if tc.backend.prepare_attach(&session).await? {
            self.leave_to_terminal(run_id, tc.backend.as_ref()).await?;
        }
        let dir = self.core.data_dir().join(ATTACH_DIR);
        let file = write_attach_file(&dir, tc.login.as_ref(), &program, &run.expected_worktree, &tc.backend.attach_words(&session))?;
        self.terminal.open(&file, self.settings().terminal).map_err(|e| Error::Claude(format!("Couldn't open Terminal: {e}")))
    }

    /// Hands the run to the terminal that is about to open it: its held question is cancelled and it reads as stopped.
    async fn leave_to_terminal(&self, run_id: &str, backend: &dyn RunBackend) -> Result<()> {
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        self.end_ask_on(backend, &run);
        Self::stopped(&mut run);
        run.last_detail = Some("Opened in Terminal".into());
        if let Err(e) = self.index.mark_terminal(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.reset_counts(&run.id);
        self.store(&run).await
    }

    /// Opens Terminal running `command`, in the Terminal or iTerm the person chose. The caller takes `command` from
    /// Rust's own state, never from the page.
    pub fn open_fix(&self, command: &str) -> Result<()> {
        let file = write_fix_file(&self.core.data_dir().join(ATTACH_DIR), command)?;
        self.terminal.open(&file, self.settings().terminal).map_err(|e| Error::Claude(format!("Couldn't open Terminal: {e}")))
    }

    /// Opens Terminal on the sign-in command of provider instance `instance_id`, built from the instance as it is now.
    pub async fn open_provider_signin(&self, instance_id: &str) -> Result<()> {
        let target = self.core.provider_signin(instance_id).await?;
        let file = write_provider_signin(&self.core.data_dir().join(ATTACH_DIR), target.driver, &target.binary, Some(&target.login))?;
        self.terminal.open(&file, self.settings().terminal).map_err(|e| Error::Claude(format!("Couldn't open Terminal: {e}")))
    }

    /// Opens Terminal in the run's clone running `claude`, so Claude can ask its one-time trust question, sign the
    /// person in or take their opt-in to a permission mode. Only for a failed run whose reason is that one, and only for
    /// the clone in its stored spec.
    pub async fn open_claude(&self, run_id: &str, purpose: Purpose) -> Result<()> {
        let run = self.load(run_id).await?;
        if run.state != RunState::Failed || !purpose.allows(run.failure.as_ref()) {
            return Err(refuse(purpose.refusal()));
        }
        let tc = self.acting_toolchain(&run).await?;
        self.open_claude_in(&tc, &run.spec.clone_path, purpose).await
    }

    async fn open_claude_in(&self, tc: &Toolchain, folder: &Path, purpose: Purpose) -> Result<()> {
        let program = tc.backend.binary().ok_or_else(|| Error::Claude("Gossamr can't tell which Claude to open.".into()))?;
        let words = tc.backend.terminal_words(purpose).ok_or_else(|| refuse("There is nothing to open Terminal for here."))?;
        let dir = self.core.data_dir().join(ATTACH_DIR);
        let file = write_claude_file(&dir, tc.login.as_ref(), purpose, &program, &words, folder, self.home.as_deref())?;
        self.terminal.open(&file, self.settings().terminal).map_err(|e| Error::Claude(format!("Couldn't open Terminal: {e}")))
    }

    /// Bytes under the run's folder in Claude's `jobs` directory (where multi-gigabyte scratch space lives): at least
    /// this much, as the count stops after three seconds. Only this run's folder is read.
    pub async fn disk(&self, run_id: &str) -> Result<u64> {
        let run = self.load(run_id).await?;
        let session = Session::of(&run).ok_or_else(|| refuse("This run has no session yet."))?;
        let tc = self.observing_toolchain(&run).await?;
        let dirs = self.folders_of(&tc).await;
        let dir = tc.backend.scratch_dir(&session, &dirs)?;
        tokio::task::spawn_blocking(move || size_within(&dir, DISK_LIMIT)).await.map_err(|e| Error::Claude(e.to_string()))
    }

    /// How many agents are still running, in any account, for the sign-out and quit messages.
    pub fn keep_running(&self) -> usize {
        self.index.live().len()
    }

    /// Removes attach scripts left from earlier days.
    pub fn clean_attach_files(&self) {
        clean_attach_dir(&self.core.data_dir().join(ATTACH_DIR), ATTACH_KEPT);
    }
}

#[cfg(test)]
mod tests;
