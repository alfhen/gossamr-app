use chrono::Utc;
use serde::Serialize;

use super::Core;
use crate::domain::{CodeChange, CodeChangeKind, Run, RunState};
use crate::error::{Error, Result};
use crate::runs::pr;
use crate::runs::report::{resolve, ReportStatus, Resolved, ResultSource, StoredReport};

pub const SUMMARY_ONLY: &str = "Only Claude's one-line summary could be read, not the agent's full answer.";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub note: Option<String>,
    pub change: Option<CodeChange>,
    pub summary_only: bool,
    pub source: Option<ResultSource>,
    pub report: Option<ReportView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    /// The session was given the tool when it launched.
    pub offered: bool,
    /// What the agent said about how it ended, when its report is the one in use.
    pub status: Option<ReportStatus>,
    pub revision: u32,
    pub calls: u32,
    pub rejections: u32,
    /// A report exists but was made before the person answered or carried on, so the written answer is used.
    pub stale: bool,
    /// The tool stopped taking calls: too many, or too many refused.
    pub locked: bool,
    pub first_at: Option<chrono::DateTime<Utc>>,
    pub last_at: Option<chrono::DateTime<Utc>>,
}

fn report_view(run: &Run, stored: Option<&StoredReport>, resolved: &Resolved) -> Option<ReportView> {
    if stored.is_none() && !run.spec.report {
        return None;
    }
    let none = StoredReport { report: None, revision: 0, calls: 0, rejections: 0, stale: false, first_at: None, last_at: None };
    let row = stored.unwrap_or(&none);
    Some(ReportView {
        offered: stored.is_some(),
        status: resolved.status,
        revision: row.revision,
        calls: row.calls,
        rejections: row.rejections,
        stale: row.stale && row.report.is_some(),
        locked: row.calls >= crate::runs::report::MAX_CALLS || row.rejections >= crate::runs::report::MAX_REJECTIONS,
        first_at: row.first_at,
        last_at: row.last_at,
    })
}

impl Core {
    pub async fn resolved_of(&self, run: &Run) -> Result<Resolved> {
        let stored = self.report_stored(&run.id).await?;
        Ok(resolve(run, stored.as_ref()))
    }

    fn change_of(&self, run: &Run) -> Result<Option<CodeChange>> {
        self.change_in(run, |id| self.watched_repos(id))
    }

    fn change_in(&self, run: &Run, repos: impl Fn(&str) -> Result<Vec<String>>) -> Result<Option<CodeChange>> {
        let branches = pr::branches_of(run);
        let mut found = Vec::new();
        for id in self.code.connection_ids() {
            let Some(repo) = repos(&id)?.into_iter().find(|r| r.eq_ignore_ascii_case(&run.spec.repo)) else { continue };
            found.extend(self.with_code_db(&id, |db| db.code_changes_for_branch(&id, &repo, &branches))?);
        }
        Ok(pr::change_for(run, &found))
    }

    /// The number of the pull request a build opened in its own repository, as far as a sync has cached it. It reads the
    /// cache of a connection that is off too, so that a finished build is not taken for one still waiting.
    pub(super) fn pull_request_of(&self, run: &Run) -> Result<Option<u64>> {
        Ok(self.change_in(run, |id| self.chosen_repos(id))?.filter(|c| c.kind == CodeChangeKind::PullRequest && c.repo.eq_ignore_ascii_case(&run.spec.repo)).and_then(|c| c.number))
    }

    /// The pull request a build opened in its own repository and the commit at its head, as far as a sync has cached them.
    pub fn pull_head_of(&self, run: &Run) -> Result<Option<(u64, Option<String>)>> {
        Ok(self.change_of(run)?.filter(|c| c.kind == CodeChangeKind::PullRequest && c.repo.eq_ignore_ascii_case(&run.spec.repo)).and_then(|c| c.number.map(|n| (n, c.sha))))
    }

    pub async fn run_outcome(&self, id: &str) -> Result<RunOutcome> {
        let run = self.run(id).await?.ok_or_else(|| Error::Proposal("that run no longer exists".into()))?;
        let stored = self.report_stored(&run.id).await?;
        let resolved = resolve(&run, stored.as_ref());
        Ok(RunOutcome {
            note: resolved.note.clone(),
            change: self.change_of(&run)?,
            summary_only: run.state == RunState::Done && resolved.source == Some(ResultSource::SummaryOnly),
            source: resolved.source,
            report: report_view(&run, stored.as_ref(), &resolved),
        })
    }
}
