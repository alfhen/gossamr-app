//! What Pip may do with agent runs: read the signed-in account's runs, and start one. The spec of a started run is
//! built here from what Rust knows; Pip supplies the workstream, a role, a brief and, to work on a pull request, its
//! number.

use chrono::Utc;

use super::ticket_context::snapshot;
use super::Core;
use crate::auth::Scope;
use crate::domain::{Actor, ClonePlan, CodeChangeKind, ItemRef, LegacySpec, Role, Run, RunEvent, RunQuery, RunSpec, WorkstreamEvent};
use crate::error::{Error, Result};
use crate::proposals;
use crate::tracker::Connection;

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// What Pip asks of a run: a role, its brief, and a pull request to check out.
pub struct PipRunAsk {
    pub role: Role,
    pub brief: String,
    pub pr: Option<u64>,
}

/// Which Pip turn starts a run, and the key that makes the start happen at most once.
pub struct PipStart<'a> {
    pub request_id: &'a str,
    pub key: &'a str,
    /// The turn is a wake, which Gossamr started, not a message from the person.
    pub wake: bool,
}

impl Core {
    /// The runs of `scope`'s account, newest first. Whatever `query` says, only that account's runs come back.
    pub async fn runs_in(&self, scope: &Scope, query: &RunQuery) -> Result<Vec<Run>> {
        let connection_id = Connection::jira_id(scope);
        let query = RunQuery { connection_id: Some(connection_id.clone()), ..query.clone() };
        let found = self.with_db_for(scope, |db| db.runs(&query)).await?;
        Ok(found.into_iter().filter(|r| r.connection_id == connection_id).collect())
    }

    pub async fn run_in(&self, scope: &Scope, id: &str) -> Result<Option<Run>> {
        let connection_id = Connection::jira_id(scope);
        Ok(self.with_db_for(scope, |db| db.run(id)).await?.filter(|r| r.connection_id == connection_id))
    }

    pub async fn run_events_in(&self, scope: &Scope, run_id: &str) -> Result<Vec<RunEvent>> {
        self.with_db_for(scope, |db| db.run_events(run_id)).await
    }

    /// The repository an agent on `key` would work in, and the ticket's title: the one repository its linked pull
    /// requests and branches are in, or with no links the only repository that is watched. When that isn't a single
    /// answer, Pip's `repo` settles it when it names a watched repository.
    pub async fn pip_run_target(&self, scope: &Scope, key: &str, repo: Option<&str>) -> Result<(String, String)> {
        let item = Self::item(scope, key);
        let work = self
            .with_db_for(scope, |db| db.item(&item))
            .await?
            .ok_or_else(|| refuse(format!("{key} isn't in the cache, so there is nothing to base a run on")))?;
        if let Some(named) = repo {
            return Ok((self.watched_repo_named(named)?, work.title));
        }
        let mut repos: Vec<String> = Vec::new();
        for link in self.dev_links(&item)?.iter().filter(|l| matches!(l.change.kind, CodeChangeKind::PullRequest | CodeChangeKind::Branch)) {
            if !repos.iter().any(|r| r.eq_ignore_ascii_case(&link.change.repo)) {
                repos.push(link.change.repo.clone());
            }
        }
        if repos.is_empty() {
            repos = self.watched_repo_names()?;
        }
        match repos.as_slice() {
            [only] => Ok((only.clone(), work.title)),
            [] => Err(refuse("No repository is watched, so there is nowhere to run an agent. Ask the person to watch one in Settings.")),
            several => Err(refuse(format!(
                "It isn't clear which repository to use ({}): pass repo, or ask the person which one.",
                several.join(", ")
            ))),
        }
    }

    /// The watched repository `repo` names, spelling case forgiven.
    pub(crate) fn watched_repo_named(&self, repo: &str) -> Result<String> {
        let names = self.watched_repo_names()?;
        if names.is_empty() {
            return Err(refuse("No repository is watched, so there is nowhere to run an agent. Ask the person to watch one in Settings."));
        }
        names.iter().find(|n| n.eq_ignore_ascii_case(repo.trim())).cloned().ok_or_else(|| refuse(format!("{} isn't a repository the user watches. The watched ones are: {}.", repo.trim(), names.join(", "))))
    }

    /// The spec of a run Pip starts in `workstream`. The role, the brief and the pull request number are Pip's; the
    /// clone and branch are what `plan` found, and the ticket text is the cached ticket. The workstream must be an open
    /// one on `ticket`, or with no ticket when there is none. A pull request has its head commit pinned now, and one from
    /// a fork is refused.
    pub(crate) async fn build_pip_run(&self, scope: &Scope, workstream: &str, ticket: Option<&str>, ask: PipRunAsk, repo: String, plan: ClonePlan) -> Result<(RunSpec, Option<ItemRef>)> {
        self.require_watched_repo(&repo)?;
        let clone_path = self.resolve_clone(&plan.path)?;
        let item = ticket.map(|key| Self::item(scope, key));
        let links = item.as_ref().map(|i| self.ticket_dev_links(i)).unwrap_or_default();
        let connection_id = Connection::jira_id(scope);
        let mut spec = RunSpec {
            role: ask.role,
            repo,
            clone_path,
            base: plan.base,
            name: plan.name,
            brief: ask.brief,
            ticket: item.as_ref().map(|i| i.key.clone()),
            ticket_block: None,
            pr: ask.pr,
            pr_sha: None,
            report: true,
            workstream: Some(workstream.into()),
            earlier: LegacySpec::default(),
        };
        if spec.pr.is_some() {
            let change = self.review_target(&spec).await?;
            spec.base = change.base_ref.unwrap_or(spec.base);
            spec.pr_sha = change.sha;
        }
        self.with_db_for(scope, |db| {
            super::workstreams::require_linkable(db, &connection_id, workstream, item.as_ref())?;
            if let Some(item) = &item {
                let work = db.item(item)?.ok_or_else(|| refuse(format!("{} isn't in the cache, so there is nothing to base a run on", item.key)))?;
                spec.ticket_block = Some(snapshot(db, &work, &links));
            }
            Ok(())
        })
        .await?;
        Ok((spec, item))
    }

    /// Stores the queued run for `spec` as started by Pip, and returns it with whether it is new. A run already started
    /// under `start.key` (an MCP retry of the same call) comes back instead, unchanged, and nothing is recorded again.
    /// The workstream's audit says Pip started it, in which turn kind, and as what.
    pub(crate) async fn commit_pip_run(&self, scope: &Scope, start: &PipStart<'_>, item: Option<ItemRef>, spec: RunSpec) -> Result<(Run, bool)> {
        let connection_id = Connection::jira_id(scope);
        let file = super::db_file(&self.connection(scope)?);
        let workstream = spec.workstream.clone();
        let role = spec.role.clone();
        let id = proposals::new_id()?;
        let run = Run::started_by_pip(id, connection_id.clone(), item.clone(), spec, file, start.request_id, Utc::now());
        self.with_db_atomically_for(scope, |db| {
            if let Some(ws) = workstream.as_deref() {
                super::workstreams::require_startable(db, &connection_id, ws, item.as_ref())?;
            }
            let (run, fresh) = db.insert_started_run(&run, start.key)?;
            if let (true, Some(ws)) = (fresh, workstream.as_deref()) {
                let how = if start.wake { "wake turn" } else { "conversation" };
                db.append_workstream_event(&WorkstreamEvent::new(ws, Actor::Pip, "agent_started", run.queued_at).run(&run.id).detail(format!("{} · {how}", role.as_str())))?;
            }
            Ok((run, fresh))
        })
        .await
    }

    /// Keeps Pip's `text` for the run until its next `ask` call or the end of its turn. A message already waiting is replaced.
    pub async fn queue_run_message(&self, run_id: &str, text: &str) -> Result<()> {
        let at = Utc::now();
        self.with_proposals(|db| db.put_run_message(run_id, text, at)).await
    }

    pub async fn restore_run_message(&self, run_id: &str, text: &str) -> Result<()> {
        let at = Utc::now();
        self.with_proposals(|db| db.restore_run_message(run_id, text, at)).await
    }

    /// The message waiting for the run, removed as it is taken.
    pub async fn take_run_message(&self, run_id: &str) -> Result<Option<String>> {
        self.with_proposals(|db| db.take_run_message(run_id)).await
    }

    pub async fn run_message(&self, run_id: &str) -> Result<Option<String>> {
        self.with_proposals(|db| db.run_message(run_id)).await
    }

    /// The runs with a message waiting, oldest first.
    pub async fn runs_with_messages(&self) -> Result<Vec<String>> {
        self.with_proposals(|db| db.run_messages_waiting()).await
    }

    /// The run already started under `key`, if any.
    pub(crate) async fn run_started_as(&self, scope: &Scope, key: &str) -> Result<Option<Run>> {
        let connection_id = Connection::jira_id(scope);
        Ok(self.with_db_for(scope, |db| db.run_by_start_key(key)).await?.filter(|r| r.connection_id == connection_id))
    }
}

#[cfg(test)]
impl Core {
    /// Queues a run for `spec` the way a Pip start does, for tests that need a run and not the tool call: the clone is
    /// resolved, a pull request is pinned, and the ticket text comes from the cache.
    pub async fn queue_test_run(&self, mut spec: RunSpec, item: Option<ItemRef>) -> Result<Run> {
        let scope = self.scope().await?;
        self.require_watched_repo(&spec.repo)?;
        spec.report = true;
        spec.clone_path = self.resolve_clone(&spec.clone_path)?;
        if spec.brief.trim().is_empty() {
            spec.brief = "Look into this.".into();
        }
        spec.ticket = item.as_ref().map(|i| i.key.clone());
        if spec.pr.is_some() {
            let change = self.review_target(&spec).await?;
            spec.base = change.base_ref.unwrap_or(spec.base);
            spec.pr_sha = change.sha;
        }
        let links = item.as_ref().map(|i| self.ticket_dev_links(i)).unwrap_or_default();
        self.with_db_for(&scope, |db| {
            spec.ticket_block = item.as_ref().map(|i| db.item(i)).transpose()?.flatten().map(|w| snapshot(db, &w, &links));
            Ok(())
        })
        .await?;
        let key = format!("test:{}", proposals::new_id()?);
        let start = PipStart { request_id: "test", key: &key, wake: false };
        self.commit_pip_run(&scope, &start, item, spec).await.map(|(run, _)| run)
    }
}
