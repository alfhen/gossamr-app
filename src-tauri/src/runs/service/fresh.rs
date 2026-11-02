//! Getting Gossamr's clone of a run's repository ready before the run launches.

use std::path::PathBuf;
use std::time::Instant;

use super::*;
use crate::runs::fresh::{ensure_clone, lock_repo, real, remove_stale_temps, work_path, CloneError, Fetched, FETCH_EVERY};

fn clone_failure(e: CloneError) -> Failure {
    match e {
        CloneError::Occupied { repo, path } => Failure::CloneOccupied { repo, path },
        other => Failure::NoClone(other.to_string()),
    }
}

/// What `prepare` found out about a run's clone.
#[derive(Default)]
pub(super) struct Ready {
    /// The `user.email` and `user.signingkey` git uses inside the clone; none when the clone wasn't read.
    identity: Option<(Option<String>, Option<String>)>,
}

impl RunService {
    pub(in crate::runs) fn fresh_home(&self) -> Option<PathBuf> {
        self.home.as_ref().map(|h| h.canonicalize().unwrap_or_else(|_| h.clone()))
    }

    pub(in crate::runs) fn repo_lock(&self, repo: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.repo_locks.lock().expect("repo locks poisoned").entry(repo.to_ascii_lowercase()).or_default().clone()
    }

    /// Whether this service is making or fetching into the repository's clone right now.
    pub(super) fn clone_busy(&self, repo: &str) -> bool {
        self.repo_lock(repo).try_lock().is_err()
    }

    /// Whether the repository was last fetched into more than `FETCH_EVERY` ago; marks it fetched now when it was not.
    fn take_fetch(&self, repo: &str) -> bool {
        let mut fetched = self.fetched.lock().expect("fetch times poisoned");
        let due = fetched.get(&repo.to_ascii_lowercase()).is_none_or(|at| at.elapsed() >= FETCH_EVERY);
        if due {
            fetched.insert(repo.to_ascii_lowercase(), Instant::now());
        }
        due
    }

    /// Points a run whose clone path is the work folder's under another spelling (a folder case, a link) at the path
    /// `work_path` gives, which is the one `check()` accepts. Called under the launch lock.
    pub(super) async fn settle_clone_path(&self, run: &mut Run) -> Result<()> {
        let Some(home) = self.fresh_home() else { return Ok(()) };
        match work_path(&home, &run.spec.repo) {
            Ok(path) if run.spec.clone_path != path && real(&run.spec.clone_path) == path => {
                run.spec.clone_path = path;
                run.expected_worktree = run.spec.worktree();
                self.store(run).await
            }
            _ => Ok(()),
        }
    }

    async fn note_clone(&self, run: &Run, kind: &str, text: String) {
        let text = redact(&text);
        let event = RunEvent { run_id: run.id.clone(), seq: 0, at: Utc::now(), kind: kind.into(), text, detail: None };
        if let Err(e) = self.core.append_run_events(&run.id, &[event]).await {
            eprintln!("couldn't record {kind} on run {}: {e}", run.id);
        }
    }

    /// What a queued run's card says while its clone is made, or nothing once it is.
    async fn show_progress(&self, run_id: &str, line: Option<String>) {
        let _turn = self.launching.lock().await;
        let Ok(mut run) = self.load(run_id).await else { return };
        if run.state == RunState::Queued && run.last_detail != line {
            run.last_detail = line;
            if let Err(e) = self.store(&run).await {
                eprintln!("couldn't update run {run_id}: {e}");
            }
        }
    }

    /// Puts what `prepare` read from the clone onto the run, when it differs. Called under the launch lock with the run
    /// loaded again, so a stale copy is never written over a launch that started meanwhile.
    pub(super) async fn keep_identity(&self, run: &mut Run, ready: Ready) -> Result<()> {
        let Some((commit_email, signing_key)) = ready.identity else { return Ok(()) };
        if run.commit_email != commit_email || run.signing_key != signing_key {
            run.commit_email = commit_email;
            run.signing_key = signing_key;
            self.store(run).await?;
        }
        Ok(())
    }

    /// Makes Gossamr's clone of the run's repository, or fetches into it, before a launch. It takes the repository's
    /// locks, so a second run on the same repository waits for the first one's clone, and it runs outside the launch
    /// lock so a slow clone holds up only runs on this repository. A run set up anywhere but the work folder is left to
    /// `check()` to refuse. A fetch that can't be made is noted on the run and the launch goes on.
    pub(super) async fn prepare(&self, run: &Run) -> std::result::Result<Ready, Failure> {
        let spec = &run.spec;
        let Some(home) = self.fresh_home() else { return Ok(Ready::default()) };
        if work_path(&home, &spec.repo).ok() != Some(real(&spec.clone_path)) {
            return Ok(Ready::default());
        }
        let git = Git::new(self.tools.get().await?.env);
        let lock = self.repo_lock(&spec.repo);
        let _turn = lock.lock().await;
        let _other_process = lock_repo(&home, &spec.repo).await.map_err(clone_failure)?;
        remove_stale_temps(&home, &spec.repo);
        let cloning = real(&spec.clone_path).symlink_metadata().is_err();
        if cloning {
            self.note_clone(run, "clone_started", format!("Cloning {} into ~/Gossamr/agents", spec.repo)).await;
            self.show_progress(&run.id, Some(format!("Cloning {}…", spec.repo))).await;
        }
        let ensured = ensure_clone(&git, &home, &spec.repo, self.take_fetch(&spec.repo)).await;
        if cloning {
            self.show_progress(&run.id, None).await;
        }
        let ensured = ensured.map_err(clone_failure)?;
        let identity = git.commit_identity(&ensured.path).await;
        if let Some(Fetched::Not(why)) = ensured.fetched {
            let text = format!("Couldn't update Gossamr's clone of {}: {why}. The agent starts from what was fetched before.", spec.repo);
            self.note_clone(run, "clone_note", text).await;
        }
        Ok(Ready { identity: Some(identity) })
    }
}
