//! What the person can do to a run: stop it, stop everything, open it in Terminal, see how much disk it uses.
//!
//! Only runs Gossamr started are touched: `stop_all` walks the run index, never the full `claude agents` listing.

use std::ffi::OsString;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::Utc;
use serde::Serialize;

use super::cli::ShortId;
use super::failure::Failure;
use super::service::RunService;
use super::toolchain::Toolchain;
use crate::domain::{Run, RunState};
use crate::error::{Error, Result};

const STOP_LIMIT: Duration = Duration::from_secs(5);
const DISK_LIMIT: Duration = Duration::from_secs(3);
const ATTACH_KEPT: Duration = Duration::from_secs(24 * 60 * 60);
const ATTACH_DIR: &str = "attach";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StopAll {
    pub stopped: usize,
    /// Runs that couldn't be stopped, including ones that aren't working yet.
    pub failed: usize,
}

fn can_stop(state: RunState) -> bool {
    matches!(state, RunState::Working | RunState::NeedsAnswer | RunState::NeedsPermission | RunState::SystemBlocked)
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// What opens the `.command` file in Terminal.
pub trait Terminal: Send + Sync {
    fn open(&self, file: &Path) -> std::io::Result<()>;
}

/// `open -a Terminal <file>`, with the file as its own argument: no shell, no Apple Events and so no permission prompt.
pub fn open_args(file: &Path) -> Vec<OsString> {
    vec!["-a".into(), "Terminal".into(), file.as_os_str().to_owned()]
}

pub struct MacTerminal;

impl Terminal for MacTerminal {
    fn open(&self, file: &Path) -> std::io::Result<()> {
        let status = std::process::Command::new("/usr/bin/open").args(open_args(file)).status()?;
        status.success().then_some(()).ok_or_else(|| std::io::Error::other(format!("open exited with {status}")))
    }
}

/// A path that can sit inside single quotes in a script: absolute, and no quote or control character (newline and NUL
/// included). One with a quote is refused rather than escaped, so there is no quoting to get wrong.
fn quotable(path: &Path) -> Result<&str> {
    let text = path.to_str().ok_or_else(|| refuse("that path isn't valid text"))?;
    if !path.is_absolute() || text.chars().any(|c| c == '\'' || c.is_control()) {
        return Err(refuse(format!("Gossamr won't open Terminal in {}: the path has a quote or an unusual character in it", text.escape_debug())));
    }
    Ok(text)
}

/// Writes `<dir>/<short id>.command`: `cd` into the worktree, then `claude attach`. Nothing from a model or a ticket
/// can be in it: the id is eight hex characters, and both paths are checked.
pub fn write_attach_file(dir: &Path, claude: &Path, worktree: &Path, id: &ShortId) -> Result<PathBuf> {
    let id = ShortId::parse(id.as_str()).ok_or_else(|| refuse("that isn't a session id"))?;
    let (claude, worktree) = (quotable(claude)?, quotable(worktree)?);
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let file = dir.join(format!("{id}.command"));
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    let script = format!("#!/bin/zsh\ncd '{worktree}'\nexec '{claude}' attach {id}\n");
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&file)?;
    std::io::Write::write_all(&mut out, script.as_bytes())?;
    Ok(file)
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
    async fn toolchain(&self) -> Result<Toolchain> {
        self.tools.get().await.map_err(|e| Error::Claude(Failure::from(e).to_string()))
    }

    fn stopped(run: &mut Run) {
        let now = Utc::now();
        run.state = RunState::Stopped;
        run.needs = None;
        run.error = None;
        run.ended_at = Some(now);
        run.last_progress_at = now;
    }

    /// Stops a run that is working or waiting on the person. Its conversation and worktree are kept.
    pub async fn stop(&self, run_id: &str) -> Result<Run> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if !can_stop(run.state) {
            return Err(refuse(match run.state {
                RunState::Queued | RunState::Launching => "It can be stopped once it is working.".to_owned(),
                other => format!("This run is {}, so there is nothing to stop.", other.as_str()),
            }));
        }
        let id = run.short_id.clone().ok_or_else(|| refuse("This run has no session to stop."))?;
        let tc = self.toolchain().await?;
        tc.cli.stop(&id).await?;
        Self::stopped(&mut run);
        if let Err(e) = self.index.mark_terminal(&run.id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.misses.lock().expect("misses lock poisoned").remove(&run.id);
        self.store(&run).await?;
        Ok(run)
    }

    /// Stops the runs Gossamr started, in any account. A session that isn't in the run index is never touched.
    pub async fn stop_all(&self) -> Result<StopAll> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        let tc = self.toolchain().await?;
        let mut tally = StopAll::default();
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
            let Some(id) = entry.short_id else {
                tally.failed += 1;
                continue;
            };
            match tokio::time::timeout(STOP_LIMIT, tc.cli.stop(&id)).await {
                Ok(Ok(())) => {
                    tally.stopped += 1;
                    let _ = self.index.mark_terminal(&entry.run_id);
                    self.misses.lock().expect("misses lock poisoned").remove(&entry.run_id);
                    if let Some(mut run) = mine {
                        Self::stopped(&mut run);
                        let _ = self.store(&run).await;
                    }
                }
                _ => tally.failed += 1,
            }
        }
        Ok(tally)
    }

    /// Opens Terminal in the run's worktree with `claude attach` for its session.
    pub async fn attach(&self, run_id: &str) -> Result<()> {
        self.ensure_enabled()?;
        let run = self.load(run_id).await?;
        let id = run.short_id.clone().ok_or_else(|| refuse("This run has no session to open yet."))?;
        let tc = self.toolchain().await?;
        let claude = tc.cli.binary().ok_or_else(|| Error::Claude("Gossamr can't tell which Claude to open.".into()))?;
        let dir = self.core.data_dir().join(ATTACH_DIR);
        let file = write_attach_file(&dir, &claude, &run.expected_worktree, &id)?;
        self.terminal.open(&file).map_err(|e| Error::Claude(format!("Couldn't open Terminal: {e}")))
    }

    /// Bytes under the run's folder in Claude's `jobs` directory (where multi-gigabyte scratch space lives): at least
    /// this much, as the count stops after three seconds. Only this run's folder is read.
    pub async fn disk(&self, run_id: &str) -> Result<u64> {
        self.ensure_enabled()?;
        let run = self.load(run_id).await?;
        let id = run.short_id.ok_or_else(|| refuse("This run has no session yet."))?;
        let tc = self.toolchain().await?;
        let config = self.claude_config_dir(&tc).await.ok_or_else(|| Error::Claude("Couldn't find Claude's folder.".into()))?;
        let dir = config.join("jobs").join(id.as_str());
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
