//! What Pip may do with agent runs: read the signed-in account's runs, and draft one for the person to approve. The
//! spec of a drafted run is built here from what Rust knows; Pip supplies only the ticket, the kind and a focus note, or,
//! for an investigation with no ticket, a watched repository and the question.

use chrono::Utc;

use super::ticket_context::snapshot;
use super::Core;
use crate::auth::Scope;
use crate::domain::{
    default_instruction, pip_kinds, Basis, ClonePlan, CodeChangeKind, ContainerRef, Intent, Proposal, ProposalQuery, Run, RunEvent, RunKind, RunQuery,
    RunSpec, StateKind,
};
use crate::error::{Error, Result};
use crate::proposals::{self, Draft};
use crate::tracker::Connection;

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// The part of a run request that makes two drafts the same ask; the name differs every time.
fn same_ask(a: &RunSpec, b: &RunSpec) -> bool {
    (a.kind, &a.repo, &a.focus, &a.focus_from_run) == (b.kind, &b.repo, &b.focus, &b.focus_from_run)
}

/// What Pip asks of a run: the ticket, the kind, and its own words.
pub struct PipRunAsk {
    pub key: String,
    pub kind: RunKind,
    pub focus: Option<String>,
    pub from_run: Option<String>,
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
    /// answer the person has to choose.
    pub async fn pip_run_target(&self, scope: &Scope, key: &str) -> Result<(String, String)> {
        let item = Self::item(scope, key);
        let work = self
            .with_db_for(scope, |db| db.item(&item))
            .await?
            .ok_or_else(|| refuse(format!("{key} isn't in the cache, so there is nothing to base a run on")))?;
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
                "It isn't clear which repository to use ({}). Ask the person which repository; they can start the agent from the ticket themselves.",
                several.join(", ")
            ))),
        }
    }

    /// The watched repository `repo` names (spelling case is forgiven) and the project a ticket from an investigation
    /// there lands in: the repository's usual one, else the first watched. Pip never names either path or project.
    pub async fn pip_ticketless_target(&self, scope: &Scope, repo: &str) -> Result<(String, ContainerRef)> {
        let names = self.watched_repo_names()?;
        if names.is_empty() {
            return Err(refuse("No repository is watched, so there is nowhere to run an agent. Ask the person to watch one in Settings."));
        }
        let Some(repo) = names.iter().find(|n| n.eq_ignore_ascii_case(repo.trim())) else {
            return Err(refuse(format!("{} isn't a repository the user watches. The watched ones are: {}.", repo.trim(), names.join(", "))));
        };
        let project = match self.repo_project(repo).await? {
            Some(project) => project,
            None => self
                .containers_in(scope)
                .await?
                .into_iter()
                .next()
                .map(|c| c.container_ref)
                .ok_or_else(|| refuse("No project is watched, so a ticket from this investigation would have nowhere to go. Ask the person to watch one in Settings."))?,
        };
        Ok((repo.clone(), project))
    }

    /// An investigation with no ticket that Pip proposes while answering `request_id`. `prompt` is the one thing of
    /// Pip's that becomes the instruction, in full, for the person to read and edit; the clone, branch and project are
    /// Rust's. It ends as a draft ticket in `project` once approved and finished, like one the person started.
    pub async fn draft_ticketless_run_as_pip(&self, scope: &Scope, request_id: &str, prompt: String, repo: String, project: ContainerRef, plan: ClonePlan) -> Result<Proposal> {
        self.require_watched_repo(&repo)?;
        let clone_path = self.resolve_clone(&plan.path)?;
        let connection_id = Connection::jira_id(scope);
        let spec = RunSpec {
            kind: RunKind::Investigate,
            repo,
            clone_path,
            base: plan.base,
            name: plan.name,
            instruction: prompt,
            focus: None,
            focus_from_run: None,
            ticket_block: None,
            pr: None,
            pr_sha: None,
            plan: None,
            plan_from_run: None,
            build_account: None,
            build_from_run: None,
            allow_push: false,
            project: Some(project),
        };
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            let query = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
            let same = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::StartRun { item: None, spec: s, .. } if (s.kind, &s.repo, &s.instruction) == (spec.kind, &spec.repo, &spec.instruction)));
            if let Some(same) = same {
                return Err(refuse(format!("An identical draft is already open (proposal {}). Don't propose it again; see list_proposals.", same.id)));
            }
            proposals::create(db, Draft::from_pip(request_id, Intent::StartRun { connection_id, item: None, spec }, None), at)
        })
        .await
    }

    /// A run Pip proposes while answering `request_id`. Its prompt is the kind's own template, its ticket text the cached
    /// ticket, its clone and branch what `plan` found; only `focus` and `from_run` are Pip's words. Nothing starts: the
    /// person reads the exact prompt and approves it in the setup sheet.
    pub async fn draft_run_as_pip(&self, scope: &Scope, request_id: &str, ask: PipRunAsk, repo: String, plan: ClonePlan) -> Result<Proposal> {
        let PipRunAsk { key, kind, focus, from_run } = ask;
        let key = key.as_str();
        if !pip_kinds().contains(&kind) {
            return Err(refuse("Pip can only propose investigations, triage, plans and checks"));
        }
        let instruction = default_instruction(kind);
        self.require_watched_repo(&repo)?;
        let clone_path = self.resolve_clone(&plan.path)?;
        let item = Self::item(scope, key);
        let links = self.ticket_dev_links(&item);
        let connection_id = Connection::jira_id(scope);
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            let work = db.item(&item)?.ok_or_else(|| refuse(format!("{key} isn't in the cache, so there is nothing to base a run on")))?;
            let spec = RunSpec {
                kind,
                repo,
                clone_path,
                base: plan.base,
                name: plan.name,
                instruction: instruction.into(),
                focus,
                focus_from_run: from_run,
                ticket_block: Some(snapshot(db, &work, &links)),
                pr: None,
                pr_sha: None,
                plan: None,
                plan_from_run: None,
                build_account: None,
                build_from_run: None,
                allow_push: false,
                project: None,
            };
            let query = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), item: Some(item.clone()), ..Default::default() };
            let same = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::StartRun { spec: s, .. } if same_ask(s, &spec)));
            if let Some(same) = same {
                return Err(refuse(format!("An identical draft is already open (proposal {}). Don't propose it again; see list_proposals.", same.id)));
            }
            let mut draft = Draft::from_pip(request_id, Intent::StartRun { connection_id, item: Some(item.clone()), spec }, None);
            draft.basis = Some(Basis::of(&work));
            proposals::create(db, draft, at)
        })
        .await
    }
}
