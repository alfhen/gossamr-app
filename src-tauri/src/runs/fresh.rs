//! Gossamr's own clone of each repository, in the work folder `~/Gossamr/agents/<owner>/<repo>`. Every agent session
//! runs there and nowhere else, so it never shares a folder with the person's Claude Code sessions or other tools.
//!
//! Git runs with the person's shell environment, so their own credentials work, and with the settings that could run a
//! program switched off. The token Gossamr reads from `gh` is never passed on, and `GIT_TERMINAL_PROMPT=0` is set on
//! these processes only, never on `claude`.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::repo::{origin_matches, random_hex, Git, PINNED};
use crate::domain::valid_repo;

const CLONE_LIMIT: Duration = Duration::from_secs(120);
const FETCH_LIMIT: Duration = Duration::from_secs(30);
const GH_AUTH_LIMIT: Duration = Duration::from_secs(10);
const LS_REMOTE_LIMIT: Duration = Duration::from_secs(10);
const NO_PROMPT: (&str, &str) = ("GIT_TERMINAL_PROMPT", "0");

/// How long a fetch of one repository counts as fresh enough for the next launch.
pub const FETCH_EVERY: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloneError {
    Invalid(String),
    Occupied { repo: String, path: PathBuf },
    Auth(String),
    Failed(String),
}

impl fmt::Display for CloneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CloneError::Invalid(repo) => write!(f, "{repo} isn't a repository name Gossamr can make a folder for."),
            CloneError::Occupied { repo, path } => write!(f, "{} already exists and isn't a clone of {repo}. Move it away, then retry.", tilde(path)),
            CloneError::Auth(line) => write!(f, "Git couldn't sign in to GitHub: {line}"),
            CloneError::Failed(line) => write!(f, "Cloning failed: {line}"),
        }
    }
}

/// `path` with the home folder written `~`, as the person knows it.
pub fn tilde(path: &Path) -> String {
    match dirs::home_dir().and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

pub fn agents_root(home: &Path) -> PathBuf {
    home.join("Gossamr").join("agents")
}

/// The nearest existing ancestor made real, with the rest appended: a path that doesn't exist yet still compares equal
/// to the one it will have once it does, even when a parent is a symlink (`/var` and `/private/var`).
pub fn real(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut base = path.to_path_buf();
    loop {
        if let Ok(canon) = base.canonicalize() {
            return rest.iter().rev().fold(canon, |p, part| p.join(part));
        }
        match (base.file_name().map(|n| n.to_owned()), base.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                base = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The only place the path of a repository's clone is worked out. Makes `~/Gossamr/agents` if it is missing and takes
/// its real path, so a linked `~/Gossamr` gives the path Claude's trust lookup and `check()` see. The folder is
/// `<owner>/<repo>` in lower case, or, when a clone is already there, the real path of that clone, which is the case
/// the disk keeps. One repository so always has one path, however it was spelled.
pub fn work_path(home: &Path, repo: &str) -> Result<PathBuf, CloneError> {
    let (owner, name) = repo.split_once('/').filter(|_| valid_repo(repo)).ok_or_else(|| CloneError::Invalid(repo.to_owned()))?;
    let root = agents_root(home);
    let failed = |e: std::io::Error| CloneError::Failed(format!("couldn't make {}: {e}", root.display()));
    std::fs::create_dir_all(&root).map_err(failed)?;
    let path = root.canonicalize().map_err(failed)?.join(owner.to_ascii_lowercase()).join(name.to_ascii_lowercase());
    let there = path.symlink_metadata().is_ok_and(|m| !m.file_type().is_symlink());
    Ok(if there { path.canonicalize().unwrap_or(path) } else { path })
}

/// Whether `path` is a folder inside the work folder, as the disk has it.
pub fn in_work_folder(home: &Path, path: &Path) -> bool {
    let (root, path) = (real(&agents_root(home)), real(path));
    path.starts_with(&root) && path != root
}

/// Whether `path` is the clone of `repo` in the work folder: its parent's parent is the real work folder, and its last
/// two parts name the repository, whatever their case.
pub fn is_work_path(home: &Path, repo: &str, path: &Path) -> bool {
    let Some((owner, name)) = repo.split_once('/').filter(|_| valid_repo(repo)) else { return false };
    let mut parts = path.components().rev();
    let (last, owner_part) = (parts.next(), parts.next());
    let same = |part: Option<std::path::Component>, want: &str| part.is_some_and(|p| p.as_os_str().eq_ignore_ascii_case(want));
    let root = path.parent().and_then(Path::parent);
    same(last, name) && same(owner_part, owner) && root.is_some_and(|r| real(r) == real(&agents_root(home)))
}

fn clone_url(repo: &str) -> String {
    format!("https://github.com/{repo}.git")
}

fn looks_like_auth(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    ["authentication", "could not read username", "terminal prompts disabled", "repository not found", "permission denied", "invalid credentials", "returned error: 40"].iter().any(|s| line.contains(s))
}

fn make_parent(home: &Path, path: &Path) -> Result<(), CloneError> {
    let parent = path.parent().ok_or_else(|| CloneError::Failed("the folder has no parent".into()))?;
    let io = |e: std::io::Error| CloneError::Failed(format!("couldn't make {}: {e}", parent.display()));
    std::fs::create_dir_all(parent).map_err(io)?;
    let inside = parent.canonicalize().ok().zip(agents_root(home).canonicalize().ok()).is_some_and(|(parent, root)| parent.starts_with(root));
    if inside {
        Ok(())
    } else {
        Err(CloneError::Failed(format!("{} isn't inside {}", parent.display(), agents_root(home).display())))
    }
}

async fn attempt(git: &Git, repo: &str, target: &Path) -> Result<(), CloneError> {
    let mut args: Vec<OsString> = PINNED.iter().map(OsString::from).collect();
    args.extend(["clone", "--"].map(OsString::from));
    args.extend([clone_url(repo).into(), target.into()]);
    let first = match git.run(git.git_program(), args, &[NO_PROMPT], CLONE_LIMIT).await {
        Ok(()) => return Ok(()),
        Err(line) => line,
    };
    if !looks_like_auth(&first) {
        return Err(CloneError::Failed(first));
    }
    let _ = std::fs::remove_dir_all(target);
    let Some(gh) = git.tool("gh") else { return Err(CloneError::Auth(first)) };
    if git.run(&gh, ["auth", "status"], &[], GH_AUTH_LIMIT).await.is_err() {
        return Err(CloneError::Auth(first));
    }
    let hooks_off = [
        NO_PROMPT,
        ("GIT_CONFIG_COUNT", "3"),
        ("GIT_CONFIG_KEY_0", "core.hooksPath"),
        ("GIT_CONFIG_VALUE_0", "/dev/null"),
        ("GIT_CONFIG_KEY_1", "core.fsmonitor"),
        ("GIT_CONFIG_VALUE_1", "false"),
        ("GIT_CONFIG_KEY_2", "protocol.ext.allow"),
        ("GIT_CONFIG_VALUE_2", "never"),
    ];
    let args: Vec<OsString> = vec!["repo".into(), "clone".into(), repo.into(), target.into()];
    git.run(&gh, args, &hooks_off, CLONE_LIMIT).await.map_err(CloneError::Auth)
}

/// What a fetch into the clone came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fetched {
    Done,
    /// Not tried, or tried and failed; the launch goes on from what was fetched before.
    Not(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ensured {
    pub path: PathBuf,
    /// This call made the clone.
    pub cloned: bool,
    /// `None` when no fetch was due.
    pub fetched: Option<Fetched>,
}

/// Whether `git clone` and Claude's worktrees, or `gh repo clone`, write this key into a clone's `.git/config`.
fn written_by_gossamr_tools(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let parts: Vec<&str> = key.split('.').collect();
    match parts.as_slice() {
        ["core", var] => matches!(*var, "repositoryformatversion" | "filemode" | "bare" | "logallrefupdates" | "ignorecase" | "precomposeunicode"),
        ["remote", "origin" | "upstream", "url" | "fetch"] => true,
        ["remote", middle @ .., "gh-resolved"] | ["branch", middle @ .., "remote" | "merge"] => !middle.is_empty(),
        _ => false,
    }
}

/// A fetch can run a program named in the clone's own config, and agents can change that config. So it happens only
/// when every key is one Gossamr's tools write. The keys are named in the answer, never their values.
async fn fetch(git: &Git, path: &Path) -> Fetched {
    let Some(keys) = git.local_config_keys(path).await else { return Fetched::Not("Git couldn't read the clone's settings".into()) };
    let mut odd: Vec<String> = keys.into_iter().filter(|k| !written_by_gossamr_tools(k)).map(|k| k.to_ascii_lowercase()).collect();
    odd.sort();
    odd.dedup();
    if !odd.is_empty() {
        odd.truncate(5);
        return Fetched::Not(format!("the clone has settings Gossamr didn't make ({}), which a fetch would honour", odd.join(", ")));
    }
    let mut args: Vec<OsString> = PINNED.iter().map(OsString::from).collect();
    args.extend(["-C".into(), path.into(), "fetch".into(), "--prune".into(), "--quiet".into(), "origin".into()]);
    match git.run(git.git_program(), args, &[NO_PROMPT], FETCH_LIMIT).await {
        Ok(()) => Fetched::Done,
        Err(line) => Fetched::Not(line),
    }
}

/// Gossamr's clone of `repo`, made now if it isn't there. A missing clone is cloned into a new folder beside it and
/// renamed into place, and a failure removes only that folder. One that is already there is checked to be a clone of
/// `repo`, and fetched into when `fetch_due`. Gossamr never removes the target. Callers hold the repository's lock.
pub async fn ensure_clone(git: &Git, home: &Path, repo: &str, fetch_due: bool) -> Result<Ensured, CloneError> {
    let path = work_path(home, repo)?;
    if path.symlink_metadata().is_ok() {
        let real_folder = path.symlink_metadata().is_ok_and(|m| m.is_dir());
        if !real_folder || !path.join(".git").exists() || !git.origin(&path).await.is_some_and(|url| origin_matches(&url, repo)) {
            return Err(CloneError::Occupied { repo: repo.to_owned(), path });
        }
        let fetched = if fetch_due { Some(fetch(git, &path).await) } else { None };
        return Ok(Ensured { path, cloned: false, fetched });
    }
    make_parent(home, &path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = path.with_file_name(format!(".{name}.cloning-{}", random_hex(12)));
    let made = attempt(git, repo, &temp).await;
    let placed = match made {
        Ok(()) if path.symlink_metadata().is_ok() => Err(CloneError::Failed(format!("{} appeared while it was being cloned", tilde(&path)))),
        Ok(()) => std::fs::rename(&temp, &path).map_err(|e| CloneError::Failed(format!("couldn't move the clone into place: {e}"))),
        Err(e) => Err(e),
    };
    match placed {
        Ok(()) => Ok(Ensured { path, cloned: true, fetched: None }),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&temp);
            Err(e)
        }
    }
}

/// The branch `repo` is cloned from when there is no clone yet: what the remote's `HEAD` points at. Falls back to `gh`
/// when git can't sign in.
pub async fn remote_default_branch(git: &Git, repo: &str) -> Result<String, CloneError> {
    let mut args: Vec<OsString> = PINNED.iter().map(OsString::from).collect();
    args.extend(["ls-remote", "--symref", "--"].map(OsString::from));
    args.extend([clone_url(repo).into(), "HEAD".into()]);
    let first = match git.run_stdout(git.git_program(), args, &[NO_PROMPT], LS_REMOTE_LIMIT).await {
        Ok(out) => {
            let branch = out.lines().find_map(|l| l.strip_prefix("ref: refs/heads/")).and_then(|l| l.split_whitespace().next());
            return branch.map(str::to_owned).ok_or_else(|| CloneError::Failed(format!("{repo} has no default branch to start from")));
        }
        Err(line) => line,
    };
    let gh = git.tool("gh").filter(|_| looks_like_auth(&first)).ok_or_else(|| if looks_like_auth(&first) { CloneError::Auth(first.clone()) } else { CloneError::Failed(first.clone()) })?;
    let args = ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"];
    match git.run_stdout(&gh, args, &[NO_PROMPT], LS_REMOTE_LIMIT).await {
        Ok(branch) if !branch.is_empty() => Ok(branch),
        Ok(_) => Err(CloneError::Failed(format!("{repo} has no default branch to start from"))),
        Err(_) => Err(CloneError::Auth(first)),
    }
}

/// Holds a repository's file lock until dropped, so a second Gossamr process takes turns with this one.
pub struct FileLock(#[allow(dead_code)] std::fs::File);

/// Takes `~/Gossamr/agents/.locks/<owner>__<repo>`, waiting for another process to let go of it.
pub async fn lock_repo(home: &Path, repo: &str) -> Result<FileLock, CloneError> {
    let invalid = || CloneError::Invalid(repo.to_owned());
    let (owner, name) = repo.split_once('/').filter(|_| valid_repo(repo)).ok_or_else(invalid)?;
    let dir = agents_root(home).join(".locks");
    let failed = |e: std::io::Error| CloneError::Failed(format!("couldn't lock {repo}: {e}"));
    std::fs::create_dir_all(&dir).map_err(failed)?;
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join(format!("{}__{}", owner.to_ascii_lowercase(), name.to_ascii_lowercase()))).map_err(failed)?;
    let locked = tokio::task::spawn_blocking(move || file.lock().map(|()| file)).await.map_err(|e| CloneError::Failed(e.to_string()))?;
    locked.map(FileLock).map_err(failed)
}

#[cfg(test)]
mod tests;
