//! The app-level list of runs that are alive, kept beside the account databases.
//!
//! Only one account's database is open at a time, so this is how the concurrency cap and "agents keep running"
//! see the runs of every account. It is a hint: the account database and `claude agents` decide a run's state, and
//! a missing or damaged file is simply empty.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::cli::ShortId;
use crate::error::Result;

const FILE: &str = "run-index.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub db_file: String,
    pub run_id: String,
    pub expected_worktree: PathBuf,
    #[serde(default)]
    pub short_id: Option<ShortId>,
    #[serde(default)]
    pub terminal: bool,
}

pub struct RunIndex {
    path: PathBuf,
    entries: Mutex<Vec<Entry>>,
}

impl RunIndex {
    /// The index in `dir`. A missing or unreadable file gives an empty index.
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join(FILE);
        let entries = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, entries: Mutex::new(entries) }
    }

    /// Adds the entry, or replaces the one for the same run.
    pub fn record(&self, entry: Entry) -> Result<()> {
        let mut entries = self.entries.lock().expect("run index poisoned");
        match entries.iter_mut().find(|e| e.run_id == entry.run_id) {
            Some(existing) => *existing = entry,
            None => entries.push(entry),
        }
        self.write(&entries)
    }

    pub fn mark_terminal(&self, run_id: &str) -> Result<()> {
        let mut entries = self.entries.lock().expect("run index poisoned");
        let mut changed = false;
        for e in entries.iter_mut().filter(|e| e.run_id == run_id && !e.terminal) {
            e.terminal = true;
            changed = true;
        }
        if changed {
            self.write(&entries)?;
        }
        Ok(())
    }

    /// Runs that haven't ended, for any account.
    pub fn live(&self) -> Vec<Entry> {
        self.entries.lock().expect("run index poisoned").iter().filter(|e| !e.terminal).cloned().collect()
    }

    pub fn contains(&self, run_id: &str) -> bool {
        self.entries.lock().expect("run index poisoned").iter().any(|e| e.run_id == run_id)
    }

    /// Written to a temporary file and renamed, so a crash leaves the old file or the new one, never half of one.
    fn write(&self, entries: &[Entry]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(entries)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gossamr-run-index-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn entry(run_id: &str, short: Option<&str>) -> Entry {
        Entry {
            db_file: "inbox-a.sqlite".into(),
            run_id: run_id.into(),
            expected_worktree: format!("/c/.claude/worktrees/{run_id}").into(),
            short_id: short.and_then(ShortId::parse),
            terminal: false,
        }
    }

    #[test]
    fn records_replace_by_run_and_survive_a_reload() {
        let d = dir("reload");
        let index = RunIndex::load(&d);
        assert!(index.live().is_empty());
        index.record(entry("r1", None)).unwrap();
        index.record(entry("r2", Some("0a1b2c3d"))).unwrap();
        index.record(entry("r1", Some("1a2b3c4d"))).unwrap();
        let again = RunIndex::load(&d);
        assert_eq!(again.live(), vec![entry("r1", Some("1a2b3c4d")), entry("r2", Some("0a1b2c3d"))]);
        assert!(!d.join("run-index.json.tmp").exists(), "the temporary file is renamed away");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn live_leaves_out_runs_that_ended() {
        let d = dir("terminal");
        let index = RunIndex::load(&d);
        index.record(entry("r1", None)).unwrap();
        index.record(entry("r2", None)).unwrap();
        index.mark_terminal("r1").unwrap();
        index.mark_terminal("unknown").unwrap();
        assert_eq!(index.live().iter().map(|e| e.run_id.as_str()).collect::<Vec<_>>(), ["r2"]);
        assert!(index.contains("r1"));
        assert_eq!(RunIndex::load(&d).live().len(), 1);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_corrupt_or_missing_file_is_an_empty_index_that_can_be_written_over() {
        let d = dir("corrupt");
        std::fs::create_dir_all(&d).unwrap();
        for bad in ["{ nope", "", "[{\"runId\":1}]", "{\"a\":1}"] {
            std::fs::write(d.join("run-index.json"), bad).unwrap();
            let index = RunIndex::load(&d);
            assert!(index.live().is_empty(), "{bad}");
        }
        let index = RunIndex::load(&d);
        index.record(entry("r1", None)).unwrap();
        assert_eq!(RunIndex::load(&d).live().len(), 1);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_short_id_that_is_not_one_makes_the_file_unreadable_rather_than_trusted() {
        let d = dir("badid");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("run-index.json"),
            r#"[{"dbFile":"f","runId":"r","expectedWorktree":"/x","shortId":"../../etc"}]"#,
        )
        .unwrap();
        assert!(RunIndex::load(&d).live().is_empty());
        let _ = std::fs::remove_dir_all(d);
    }
}
