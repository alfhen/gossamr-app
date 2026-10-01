//! A fresh copy of a repository in the visible folder `~/Gossamr/agents/<owner>/<repo>`, for a repository the person
//! has no clone of. Nothing here starts by itself: the person has seen the folder and the command and pressed the button.
//!
//! Git runs with the person's shell environment, so their own credentials work, and with hooks switched off. Gossamr's
//! stored GitHub token is never passed on, and `GIT_TERMINAL_PROMPT=0` is set on these processes only, never on `claude`.

use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::repo::{origin_matches, Git};
use crate::domain::valid_repo;

const CLONE_LIMIT: Duration = Duration::from_secs(120);
const GH_AUTH_LIMIT: Duration = Duration::from_secs(10);
const NO_PROMPT: (&str, &str) = ("GIT_TERMINAL_PROMPT", "0");

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
            CloneError::Occupied { repo, path } => write!(f, "{} already exists and isn't a clone of {repo}. Move it away, or clone {repo} into ~/Code yourself.", path.display()),
            CloneError::Auth(line) => write!(f, "Git couldn't sign in to GitHub: {line}"),
            CloneError::Failed(line) => write!(f, "Cloning failed: {line}"),
        }
    }
}

pub fn agents_root(home: &Path) -> PathBuf {
    home.join("Gossamr").join("agents")
}

/// Where the fresh copy of `repo` goes; `None` for a name that could escape the folder.
pub fn fresh_path(home: &Path, repo: &str) -> Option<PathBuf> {
    valid_repo(repo).then(|| agents_root(home).join(repo))
}

fn clone_url(repo: &str) -> String {
    format!("https://github.com/{repo}.git")
}

/// The command as the person reads it before pressing the button.
pub fn clone_command(repo: &str, path: &Path) -> String {
    let shown = path.to_string_lossy();
    let quoted = if shown.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b)) { shown.into_owned() } else { format!("'{}'", shown.replace('\'', r"'\''")) };
    format!("git clone {} {quoted}", clone_url(repo))
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

async fn attempt(git: &Git, repo: &str, path: &Path) -> Result<(), CloneError> {
    let mut args: Vec<OsString> = ["-c", "core.hooksPath=/dev/null", "clone", "--"].map(Into::into).into();
    args.extend([clone_url(repo).into(), path.into()]);
    let first = match git.run(git.git_program(), args, &[NO_PROMPT], CLONE_LIMIT).await {
        Ok(()) => return Ok(()),
        Err(line) => line,
    };
    if !looks_like_auth(&first) {
        return Err(CloneError::Failed(first));
    }
    let _ = std::fs::remove_dir_all(path);
    let Some(gh) = git.tool("gh") else { return Err(CloneError::Auth(first)) };
    if git.run(&gh, ["auth", "status"], &[], GH_AUTH_LIMIT).await.is_err() {
        return Err(CloneError::Auth(first));
    }
    let hooks_off = [NO_PROMPT, ("GIT_CONFIG_COUNT", "1"), ("GIT_CONFIG_KEY_0", "core.hooksPath"), ("GIT_CONFIG_VALUE_0", "/dev/null")];
    let args: Vec<OsString> = vec!["repo".into(), "clone".into(), repo.into(), path.into()];
    git.run(&gh, args, &hooks_off, CLONE_LIMIT).await.map_err(CloneError::Auth)
}

/// The fresh copy of `repo`, cloned now if it isn't there. A folder that is already a clone of `repo` is only fetched
/// into (refs change, the working tree doesn't); any other thing at that path is refused. Only a folder this call made
/// is removed again when the clone fails.
pub async fn ensure_clone(git: &Git, home: &Path, repo: &str) -> Result<PathBuf, CloneError> {
    let path = fresh_path(home, repo).ok_or_else(|| CloneError::Invalid(repo.to_owned()))?;
    if path.symlink_metadata().is_ok() {
        let real_folder = path.symlink_metadata().is_ok_and(|m| m.is_dir());
        if !real_folder || !path.join(".git").exists() || !git.origin(&path).await.is_some_and(|url| origin_matches(&url, repo)) {
            return Err(CloneError::Occupied { repo: repo.to_owned(), path });
        }
        let args: Vec<OsString> = vec!["-c".into(), "core.hooksPath=/dev/null".into(), "-C".into(), (&path).into(), "fetch".into(), "--quiet".into(), "origin".into()];
        let _ = git.run(git.git_program(), args, &[NO_PROMPT], CLONE_LIMIT).await;
        return Ok(path);
    }
    make_parent(home, &path)?;
    match attempt(git, repo, &path).await {
        Ok(()) => Ok(path),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&path);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests;
