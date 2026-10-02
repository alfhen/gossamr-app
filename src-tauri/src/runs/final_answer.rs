//! A finished run's own final answer. `state.json` only holds Claude's one-line summary; the answer is the last
//! message of the session, read from its transcript (see `transcript`), or failing that the text of the timeline's
//! `done` line, which carries the same message.

use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Utc};

use super::cli::{AgentEntry, JobInfo};
use super::service::{real, RunService};
use super::toolchain::Toolchain;
use super::tracker::{cleaned, RESULT_KEPT};
use crate::domain::{Run, RunQuery, RunState};

/// A finished run is looked at again for its answer for this long after it ended.
const AWAIT_WINDOW: Duration = Duration::from_secs(120);

/// The text of the timeline's `done` line. Equal to the summary it can't be told from one, so it doesn't count.
fn timeline_answer(job: &JobInfo) -> Option<String> {
    let text = job.timeline.iter().rev().find(|l| l.state.as_deref() == Some("done")).and_then(|l| l.text.as_deref())?.trim();
    (!text.is_empty() && Some(text) != job.result.as_deref().map(str::trim)).then(|| text.to_owned())
}

fn folders(run: &Run, entry: Option<&AgentEntry>, job: Option<&JobInfo>) -> Vec<PathBuf> {
    let named = [job.and_then(|j| j.worktree_path.as_deref()), entry.and_then(|e| e.cwd.as_deref())].into_iter().flatten().map(PathBuf::from);
    let mut out: Vec<PathBuf> = Vec::new();
    for path in named.chain([run.expected_worktree.clone()]) {
        for p in [real(&path), path] {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Stores `answer` as the run's result, keeping what it replaces as the summary. False when nothing usable is left
/// after cleaning.
fn adopt(run: &mut Run, answer: &str) -> bool {
    let Some(text) = cleaned(answer, RESULT_KEPT) else { return false };
    run.summary = run.summary.take().or_else(|| run.result.take());
    run.result = Some(text);
    run.result_complete = true;
    true
}

impl RunService {
    /// `projects` under the config directory `claude auth status` reports.
    async fn claude_projects_dir(&self, tc: &Toolchain) -> Option<PathBuf> {
        if let Some(known) = self.projects_dir.lock().expect("projects dir lock poisoned").clone() {
            return Some(known);
        }
        let status = tc.cli.auth_status().await.ok()?;
        let found = status.projects_directory.or_else(|| status.config_directory.map(|c| c.join("projects")))?;
        *self.projects_dir.lock().expect("projects dir lock poisoned") = Some(found.clone());
        Some(found)
    }

    /// The run's final answer: the transcript's last message, else the timeline's `done` text. One look: the message
    /// can land after the session is listed as done, which the polling of recently finished runs covers.
    pub(super) async fn read_answer(&self, tc: &Toolchain, run: &Run, entry: Option<&AgentEntry>, job: Option<&JobInfo>) -> Option<String> {
        let session = run.session_id.clone().or_else(|| entry.and_then(|e| e.session_id.clone()));
        if let (Some(session), Some(projects)) = (session, self.claude_projects_dir(tc).await) {
            if let Some(answer) = tc.cli.final_answer(&projects, &session, &folders(run, entry, job)).await {
                return Some(answer);
            }
        }
        job.and_then(timeline_answer)
    }

    async fn job_of(&self, tc: &Toolchain, run: &Run) -> Option<JobInfo> {
        let (id, dir) = (run.short_id.as_ref()?, self.claude_config_dir(tc).await?);
        tc.cli.job(&dir, id).await.ok().flatten()
    }

    /// Replaces a finished run's summary with its full answer when one can be read now. True when the run changed.
    /// Safe to call at any time and for any run: anything but a finished run with only a summary is left alone.
    pub async fn refresh_result(&self, run_id: &str) -> bool {
        if !self.is_enabled() {
            return false;
        }
        let Ok(Some(run)) = self.core.run(run_id).await else { return false };
        if run.state != RunState::Done || run.result_complete {
            return false;
        }
        let Ok(tc) = self.tools.get().await else { return false };
        self.refresh_with(&tc, &run).await
    }

    async fn refresh_with(&self, tc: &Toolchain, run: &Run) -> bool {
        let job = self.job_of(tc, run).await;
        let Some(answer) = self.read_answer(tc, run, None, job.as_ref()).await else { return false };
        let _turn = self.launching.lock().await;
        let Ok(Some(mut run)) = self.core.run(&run.id).await else { return false };
        if run.state != RunState::Done || run.result_complete || !adopt(&mut run, &answer) {
            return false;
        }
        if let Err(e) = self.core.save_run(&run).await {
            eprintln!("couldn't store the full answer of run {}: {e}", run.id);
            return false;
        }
        (self.changed)(&run.connection_id);
        true
    }

    /// Runs that finished a moment ago with only a summary: their answer may still be on its way.
    pub(super) async fn awaiting_answer(&self, now: DateTime<Utc>) -> Vec<Run> {
        let query = RunQuery { states: Some(vec![RunState::Done]), ..RunQuery::default() };
        let Ok(done) = self.core.runs_list(&query).await else { return Vec::new() };
        done.into_iter()
            .filter(|r| !r.result_complete && r.ended_at.is_some_and(|at| (now - at).to_std().is_ok_and(|age| age <= AWAIT_WINDOW)))
            .collect()
    }

    /// The same, for the polling loop, and when the answer arrives the drafts a finishing run would have made.
    pub(super) async fn collect_answers(&self, tc: &Toolchain, waiting: &[Run]) {
        for run in waiting {
            if self.refresh_with(tc, run).await && self.settings().draft_on_finish {
                if let Ok(Some(found)) = self.core.run(&run.id).await {
                    if let Some(why) = self.draft_for(&found).await {
                        self.notifier.notify(&found, why);
                    }
                }
            }
        }
    }
}
