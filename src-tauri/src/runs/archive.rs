//! Clearing past runs: archiving keeps a run's row, deleting an archived one removes Gossamr's records of it and, when
//! asked, its worktree in `~/Gossamr/agents`. Claude's own job and session files are never read, edited or removed here.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::cleanup::{cleanable, Cleanup};
use super::fresh::agents_root;
use super::service::RunService;
use crate::db::ARCHIVABLE;
use crate::domain::{Run, RunState};
use crate::error::{Error, Result};

const SIZE_LIMIT: Duration = Duration::from_secs(3);

/// Which finished runs "Clear finished" would archive.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearFilter {
    /// Only runs that ended more than this many days ago; all of them when absent.
    pub older_than_days: Option<u32>,
    pub states: Vec<RunState>,
    /// Runs the page shows as Needs you items, which it alone can tell.
    #[serde(default)]
    pub keep: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub draft: usize,
    pub needs_you: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearPreview {
    pub ids: Vec<String>,
    pub by_state: BTreeMap<String, usize>,
    pub kept: Kept,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Deleted {
    Deleted,
    /// Claude's own explanation; nothing was deleted.
    Refused { message: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    /// Whether Gossamr may remove it: it is inside `~/Gossamr/agents`, still there, and its session can be cleaned up.
    pub removable: bool,
    pub reason: Option<String>,
    pub bytes: Option<u64>,
}

fn age_start(run: &Run) -> DateTime<Utc> {
    run.ended_at.unwrap_or(run.queued_at)
}

/// The runs `filter` selects among `runs`, and how many it left out for a pending draft or a Needs you item. Runs that
/// are archived, or not over, are never selected.
pub fn select_clearable(runs: &[Run], drafts: &HashSet<String>, filter: &ClearFilter, now: DateTime<Utc>) -> ClearPreview {
    let keep: HashSet<&str> = filter.keep.iter().map(String::as_str).collect();
    let mut out = ClearPreview::default();
    for run in runs {
        let old_enough = filter.older_than_days.is_none_or(|days| now - age_start(run) > chrono::Duration::days(i64::from(days)));
        if run.archived_at.is_some() || !ARCHIVABLE.contains(&run.state) || !filter.states.contains(&run.state) || !old_enough {
            continue;
        }
        if drafts.contains(&run.id) {
            out.kept.draft += 1;
        } else if keep.contains(run.id.as_str()) {
            out.kept.needs_you += 1;
        } else {
            out.ids.push(run.id.clone());
            *out.by_state.entry(run.state.as_str().to_owned()).or_default() += 1;
        }
    }
    out
}

/// `path` made real when it exists and lies strictly inside `root`; anything else, a symlink out or `..` included, is None.
pub fn contained(root: &Path, path: &Path) -> Option<PathBuf> {
    let (root, path) = (root.canonicalize().ok()?, path.canonicalize().ok()?);
    (path != root && path.starts_with(&root)).then_some(path)
}

/// Bytes under `dir`, counting until the limit has passed. Symlinks are not followed.
fn size_of(dir: &Path) -> u64 {
    let deadline = std::time::Instant::now() + SIZE_LIMIT;
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

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

impl RunService {
    fn removable_worktree(&self, run: &Run) -> std::result::Result<PathBuf, String> {
        let home = self.home.as_ref().ok_or("Gossamr doesn't know your home folder.")?;
        if run.worktree_removed_at.is_some() {
            return Err("The worktree is already removed.".into());
        }
        if !cleanable(run) {
            return Err("This run has no session whose worktree Gossamr can remove.".into());
        }
        contained(&agents_root(home), &run.expected_worktree).ok_or_else(|| "Its worktree isn't in ~/Gossamr/agents, so Gossamr leaves it where it is.".to_owned())
    }

    /// What deleting `id` could remove besides Gossamr's records, and how big it is.
    pub async fn worktree_info(&self, id: &str) -> Result<WorktreeInfo> {
        let run = self.load(id).await?;
        let path = run.expected_worktree.to_string_lossy().into_owned();
        Ok(match self.removable_worktree(&run) {
            Ok(real) => {
                let bytes = tokio::task::spawn_blocking(move || size_of(&real)).await.map_err(|e| Error::Claude(e.to_string()))?;
                WorktreeInfo { path, removable: true, reason: None, bytes: Some(bytes) }
            }
            Err(reason) => WorktreeInfo { path, removable: false, reason: Some(reason), bytes: None },
        })
    }

    fn changed_for(&self, runs: &[Run]) {
        let connections: HashSet<&str> = runs.iter().map(|r| r.connection_id.as_str()).collect();
        for connection in connections {
            (self.changed)(connection);
        }
    }

    /// Archives runs that are over. One that is still going is refused, with the person told to stop it first.
    pub async fn archive(&self, ids: &[String]) -> Result<Vec<String>> {
        let mut runs = Vec::new();
        for id in ids {
            let run = self.load(id).await?;
            if !ARCHIVABLE.contains(&run.state) {
                return Err(refuse(format!("This run is {}. Stop it first, then archive it.", run.state.as_str())));
            }
            runs.push(run);
        }
        let done = self.core.archive_runs(ids, Utc::now()).await?;
        self.changed_for(&runs);
        Ok(done)
    }

    pub async fn restore(&self, id: &str) -> Result<()> {
        let run = self.load(id).await?;
        if !self.core.restore_run(id).await? {
            return Err(refuse("This run isn't archived."));
        }
        self.changed_for(&[run]);
        Ok(())
    }

    pub async fn clear_preview(&self, filter: &ClearFilter) -> Result<ClearPreview> {
        let runs = self.core.runs_list(&Default::default()).await?;
        let drafts = self.core.runs_with_pending_drafts().await?;
        Ok(select_clearable(&runs, &drafts, filter, Utc::now()))
    }

    /// Archives what `clear_preview` shows for `filter`, worked out again now so a run that changed meanwhile is left alone.
    pub async fn clear(&self, filter: &ClearFilter) -> Result<Vec<String>> {
        let ids = self.clear_preview(filter).await?.ids;
        self.archive(&ids).await
    }

    /// Removes an archived run's records, after its worktree when `remove_worktree` and only if that lies inside
    /// `~/Gossamr/agents`. When Claude refuses to remove the worktree, nothing is deleted.
    pub async fn delete(&self, id: &str, remove_worktree: bool) -> Result<Deleted> {
        let run = self.load(id).await?;
        if run.archived_at.is_none() {
            return Err(refuse("Only an archived run can be deleted."));
        }
        if remove_worktree {
            self.removable_worktree(&run).map_err(refuse)?;
            if let Cleanup::Refused { message } = self.cleanup(id).await? {
                return Ok(Deleted::Refused { message });
            }
        }
        if !self.core.delete_archived_run(id).await? {
            return Err(refuse("That run no longer exists."));
        }
        if let Err(e) = self.index.forget(id) {
            eprintln!("couldn't update the run index: {e}");
        }
        self.forget_tools(id).await;
        self.changed_for(&[run]);
        Ok(Deleted::Deleted)
    }
}

#[cfg(test)]
mod tests;
