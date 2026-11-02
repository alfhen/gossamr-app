//! Claude's folder-trust entry for one clone: which settings file holds it, whether it is there, and how to add it
//! (section 17 of docs/connections-proposal.md).
//!
//! The file can hold account details and an API key, so nothing from it is logged or put in an error, and there is no
//! backup copy. Only `projects[<folder>].hasTrustDialogAccepted` changes; every other key keeps its bytes and place.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::value::RawValue;
use tokio::time::Instant;

use super::cli::AuthStatus;
use super::env::RunEnv;
use super::fresh::real;
use super::repo::random_hex;

type Object = IndexMap<String, Box<RawValue>>;

const KEY: &str = "hasTrustDialogAccepted";
const LIMIT: u64 = 16 * 1024 * 1024;

/// Why Gossamr won't write the entry. Each one has a sentence for the card (`words`) and sends the person to Terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotOurClone,
    Missing,
    UnsafeFile,
    CantTell,
    Busy,
}

impl Refusal {
    /// `login` is the name of the login the run uses.
    pub fn words(self, login: &str) -> String {
        match self {
            Refusal::NotOurClone => "Gossamr trusts only its own clones in ~/Gossamr/agents.".into(),
            Refusal::Missing => format!("Claude hasn't made its settings for {login} yet. Trust it in Terminal."),
            Refusal::UnsafeFile => "Claude's settings file isn't in a form Gossamr can safely change. Trust it in Terminal.".into(),
            Refusal::CantTell => format!("Gossamr can't tell which settings file {login} uses. Trust it in Terminal."),
            Refusal::Busy => "Claude was saving its settings while Gossamr saved the trust. Try again, or trust it in Terminal.".into(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub retry: Duration,
    pub give_up: Duration,
    /// How long after the rename the file is read again.
    pub confirm: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { retry: Duration::from_millis(100), give_up: Duration::from_secs(3), confirm: Duration::from_secs(1) }
    }
}

fn same(a: &Path, b: &Path) -> bool {
    a == b || real(a) == real(b)
}

/// The file `claude` keeps its trust entries in when run with `env`. `auth` is what `claude auth status` said with that
/// same environment; its `configDirectory` must agree with the environment, or Gossamr can't tell which login this is.
pub fn config_file(env: &RunEnv, auth: &AuthStatus) -> Result<PathBuf, Refusal> {
    if env.get("CLAUDE_CODE_CUSTOM_OAUTH_URL").is_some() || env.get("CLAUDE_CODE_IGNORE_PERSISTED_TRUST").is_some() {
        return Err(Refusal::CantTell);
    }
    let absolute = |value: &std::ffi::OsStr| Some(PathBuf::from(value)).filter(|p| p.is_absolute()).ok_or(Refusal::CantTell);
    let (folder, file) = match env.get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => {
            let dir = absolute(dir)?;
            let file = dir.join(".claude.json");
            (dir, file)
        }
        None => {
            let home = absolute(env.get("HOME").unwrap_or_default())?;
            (home.join(".claude"), home.join(".claude.json"))
        }
    };
    if !auth.config_directory.as_deref().is_some_and(|reported| same(reported, &folder)) || folder.join(".config.json").exists() {
        return Err(Refusal::CantTell);
    }
    Ok(file)
}

struct Doc {
    top: Object,
    projects: Object,
    entry: Object,
}

impl Doc {
    fn parse(text: &str, folder: &str) -> Option<Doc> {
        let top: Object = serde_json::from_str(text).ok()?;
        let projects: Object = match top.get("projects") {
            Some(raw) => serde_json::from_str(raw.get()).ok()?,
            None => Object::new(),
        };
        let entry: Object = match projects.get(folder) {
            Some(raw) => serde_json::from_str(raw.get()).ok()?,
            None => Object::new(),
        };
        match entry.get(KEY) {
            None => {}
            Some(flag) if matches!(flag.get(), "true" | "false") => {}
            Some(_) => return None,
        }
        Some(Doc { top, projects, entry })
    }

    fn accepted(entry: &Object) -> bool {
        entry.get(KEY).is_some_and(|flag| flag.get() == "true")
    }

    /// A folder above `folder` is trusted. Claude doesn't count that for a new folder, so it only stops the pre-flight
    /// from refusing a launch Claude may still accept.
    fn above(&self, folder: &Path) -> bool {
        folder.ancestors().skip(1).filter_map(Path::to_str).any(|parent| {
            self.projects.get(parent).and_then(|raw| serde_json::from_str::<Object>(raw.get()).ok()).is_some_and(|entry| Self::accepted(&entry))
        })
    }

    /// The file's text with the entry set and every other value as it was.
    fn trusting(mut self, folder: &str, ends_with_newline: bool) -> String {
        let raw = |text: String| RawValue::from_string(text).expect("rendered JSON parses");
        self.entry.insert(KEY.into(), raw("true".into()));
        self.projects.insert(folder.into(), raw(object(&self.entry, 2)));
        self.top.insert("projects".into(), raw(object(&self.projects, 1)));
        let text = object(&self.top, 0);
        if ends_with_newline {
            text + "\n"
        } else {
            text
        }
    }
}

/// `map` laid out with two-space indents, its values exactly as they were.
fn object(map: &Object, depth: usize) -> String {
    if map.is_empty() {
        return "{}".into();
    }
    let pad = "  ".repeat(depth + 1);
    let lines: Vec<String> = map.iter().map(|(key, value)| format!("{pad}{}: {}", serde_json::to_string(key).expect("a string serializes"), value.get())).collect();
    format!("{{\n{}\n{}}}", lines.join(",\n"), "  ".repeat(depth))
}

fn read(file: &Path, folder: &Path) -> Option<Doc> {
    if file.metadata().ok()?.len() > LIMIT {
        return None;
    }
    Doc::parse(&std::fs::read_to_string(file).ok()?, folder.to_str()?)
}

/// Whether `file` holds a true entry for exactly `folder`. None when the file can't be read or isn't in the shape Gossamr
/// knows.
pub fn trusted(file: &Path, folder: &Path) -> Option<bool> {
    read(file, folder).map(|doc| Doc::accepted(&doc.entry))
}

/// Whether a folder above `folder` has a true entry in `file`.
pub fn trusted_above(file: &Path, folder: &Path) -> bool {
    read(file, folder).is_some_and(|doc| doc.above(folder))
}

fn owner(path: &Path) -> Result<u32, Refusal> {
    path.symlink_metadata().map(|m| m.uid()).map_err(|_| Refusal::NotOurClone)
}

/// The settings file's real path, once it is a regular file of the person's, not too big.
fn inspect(file: &Path, me: u32) -> Result<(PathBuf, std::fs::Metadata), Refusal> {
    let meta = file.symlink_metadata().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { Refusal::Missing } else { Refusal::UnsafeFile })?;
    if !meta.file_type().is_file() || meta.uid() != me || meta.len() > LIMIT {
        return Err(Refusal::UnsafeFile);
    }
    Ok((file.canonicalize().map_err(|_| Refusal::UnsafeFile)?, meta))
}

fn temp_prefix(file: &Path) -> String {
    format!("{}.gossamr-", file.file_name().map(|n| n.to_string_lossy()).unwrap_or_default())
}

fn clean_leftovers(dir: &Path, prefix: &str, me: u32) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let stale = entry.file_name().to_string_lossy().starts_with(prefix) && entry.metadata().is_ok_and(|m| m.file_type().is_file() && m.uid() == me);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Start-up clean-up for a folder holding a `.claude.json`: the person's own leftovers only.
pub fn clean_folder(dir: &Path) {
    if let Ok(meta) = dir.metadata() {
        clean_leftovers(dir, ".claude.json.gossamr-", meta.uid());
    }
}

/// Claude's lock on a file: a folder `<file>.lock`. Dropping removes the folder this value made, and nothing else.
struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

async fn take(file: &Path, timing: Timing) -> Result<Lock, Refusal> {
    let mut name: OsString = file.as_os_str().to_owned();
    name.push(".lock");
    let folder = PathBuf::from(name);
    let started = Instant::now();
    loop {
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(Lock(folder)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && started.elapsed() < timing.give_up => tokio::time::sleep(timing.retry).await,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(Refusal::Busy),
            Err(_) => return Err(Refusal::UnsafeFile),
        }
    }
}

fn write_over(file: &Path, mode: u32, text: &str) -> std::io::Result<()> {
    let temp = file.with_file_name(format!("{}{}", temp_prefix(file), random_hex(12)));
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(mode).open(&temp)?;
    let done = out
        .set_permissions(std::fs::Permissions::from_mode(mode))
        .and_then(|()| out.write_all(text.as_bytes()))
        .and_then(|()| out.sync_all())
        .and_then(|()| std::fs::rename(&temp, file));
    if done.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    done
}

enum Wrote {
    Already,
    Yes,
}

async fn write_once(file: &Path, folder: &str, me: u32, timing: Timing) -> Result<Wrote, Refusal> {
    let _lock = take(file, timing).await?;
    let (_, meta) = inspect(file, me)?;
    let text = std::fs::read_to_string(file).map_err(|_| Refusal::UnsafeFile)?;
    let doc = Doc::parse(&text, folder).ok_or(Refusal::UnsafeFile)?;
    if Doc::accepted(&doc.entry) {
        return Ok(Wrote::Already);
    }
    let new = doc.trusting(folder, text.ends_with('\n'));
    write_over(file, meta.mode() & 0o7777, &new).map_err(|_| Refusal::UnsafeFile)?;
    Ok(Wrote::Yes)
}

/// One writer per file at a time inside Gossamr.
fn turn_for(file: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static TURNS: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);
    TURNS.lock().expect("trust turns poisoned").entry(file.to_path_buf()).or_default().clone()
}

/// Sets `projects[folder].hasTrustDialogAccepted` to true in `file`. `folder` must already be checked to be one of
/// Gossamr's own clones. Returns whether the file changed.
pub async fn trust(file: &Path, folder: &Path) -> Result<bool, Refusal> {
    trust_with(file, folder, Timing::default()).await
}

pub(super) async fn trust_with(file: &Path, folder: &Path, timing: Timing) -> Result<bool, Refusal> {
    let key = folder.to_str().ok_or(Refusal::NotOurClone)?;
    let me = owner(folder)?;
    let (file, _) = inspect(file, me)?;
    let turn = turn_for(&file);
    let _one_writer = turn.lock().await;
    if let Some(dir) = file.parent() {
        clean_leftovers(dir, &temp_prefix(&file), me);
    }
    let mut wrote = false;
    for _ in 0..2 {
        if matches!(write_once(&file, key, me, timing).await?, Wrote::Already) {
            return Ok(wrote);
        }
        wrote = true;
        tokio::time::sleep(timing.confirm).await;
        if trusted(&file, folder) == Some(true) {
            return Ok(true);
        }
    }
    Err(Refusal::Busy)
}

#[cfg(test)]
mod tests;
