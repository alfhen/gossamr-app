//! Repositories with no clone of the person's own: the offer to make one in `~/Gossamr/agents`, and making it.

use std::path::PathBuf;

use serde::Serialize;

use super::*;
use crate::runs::fresh::{clone_command, ensure_clone, fresh_path};
use crate::runs::repo::inspect;

/// What the person is shown before choosing to clone: the folder and the exact command.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshCopy {
    pub path: PathBuf,
    pub command: String,
    /// `gh` is on the shell's PATH, so a sign-in failure falls back to `gh repo clone`.
    pub gh_fallback: bool,
    /// Something that isn't a clone of this repository is already at `path`.
    pub occupied: bool,
}

pub(super) struct Cloning<'a> {
    set: &'a Mutex<HashSet<String>>,
    repo: String,
}

impl<'a> Cloning<'a> {
    pub(super) fn take(set: &'a Mutex<HashSet<String>>, repo: &str) -> Result<Self> {
        let repo = repo.to_ascii_lowercase();
        if !set.lock().expect("cloning lock poisoned").insert(repo.clone()) {
            return Err(Error::Claude(format!("{repo} is already being cloned.")));
        }
        Ok(Self { set, repo })
    }
}

impl Drop for Cloning<'_> {
    fn drop(&mut self) {
        self.set.lock().expect("cloning lock poisoned").remove(&self.repo);
    }
}

impl RunService {
    fn fresh_home(&self) -> Option<PathBuf> {
        self.home.as_ref().map(|h| h.canonicalize().unwrap_or_else(|_| h.clone()))
    }

    /// The fresh copy of `repo` when it is already there and really is a clone of it.
    pub(super) async fn existing_fresh(&self, git: &Git, repo: &str) -> Option<LocalClone> {
        let path = fresh_path(&self.fresh_home()?, repo)?;
        if !path.join(".git").exists() || !git.origin(&path).await.is_some_and(|url| origin_matches(&url, repo)) {
            return None;
        }
        inspect(git, &path).await
    }

    pub(super) async fn fresh_offer(&self, repo: &str) -> Option<FreshCopy> {
        let path = fresh_path(&self.fresh_home()?, repo)?;
        let gh_fallback = self.git().await.is_ok_and(|git| git.tool("gh").is_some());
        Some(FreshCopy { command: clone_command(repo, &path), occupied: path.symlink_metadata().is_ok(), path, gh_fallback })
    }

    /// Clones a watched repository into `~/Gossamr/agents/<owner>/<repo>` (or, if a clone is already there, fetches
    /// into it). Only the person's explicit choice calls this.
    pub async fn clone_fresh(&self, repo: &str) -> Result<LocalClone> {
        self.ensure_enabled()?;
        self.core.require_watched_repo(repo)?;
        let home = self.fresh_home().ok_or_else(|| Error::Claude("Gossamr can't find your home folder.".into()))?;
        let _only_one = Cloning::take(&self.cloning, repo)?;
        let git = self.git().await?;
        let path = ensure_clone(&git, &home, repo).await.map_err(|e| Error::Claude(e.to_string()))?;
        let clone = inspect(&git, &path).await.ok_or_else(|| Error::Claude(format!("Git couldn't read {}", path.display())))?;
        self.clones.clear();
        Ok(clone)
    }
}
