//! What Pip may do with agent runs: read the signed-in account's runs, and draft one for the person to approve. The
//! spec of a drafted run is built here from what Rust knows; Pip supplies only the ticket, the kind and a focus note, or,
//! for an investigation with no ticket, a watched repository and the question. A build or review Pip drafts only as the
//! successor of a finished run, and everything it carries from that run is filled in here.

use chrono::Utc;

use super::ticket_context::snapshot;
use super::Core;
use crate::auth::Scope;
use crate::domain::{
    default_instruction, pip_chain_kinds, pip_kinds, Basis, ClonePlan, CodeChangeKind, ContainerRef, Intent, Proposal, ProposalQuery, Run, RunEvent, RunKind, RunQuery,
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
    (a.kind, &a.repo, &a.focus, &a.focus_from_run, &a.findings_from_run) == (b.kind, &b.repo, &b.focus, &b.focus_from_run, &b.findings_from_run)
}

/// Two chained drafts are the same ask when they follow the same run as the same kind, whatever their focus.
fn same_chain(a: &RunSpec, b: &RunSpec) -> bool {
    a.kind == b.kind && (a.plan_from_run.is_some() || a.build_from_run.is_some()) && (&a.plan_from_run, &a.build_from_run) == (&b.plan_from_run, &b.build_from_run)
}

/// The words a refusal uses for what a chained kind must follow.
fn source_words(kind: RunKind) -> &'static str {
    match kind {
        RunKind::Build => "a finished plan run",
        _ => "a finished build whose pull request has been found",
    }
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
    /// Rust's. It ends as a draft ticket in `project` once approved and finished, like one the person started. Asked in
    /// a workstream's conversation, the run belongs to that workstream, which must be an open one with no ticket.
    #[allow(clippy::too_many_arguments)]
    pub async fn draft_ticketless_run_as_pip(&self, scope: &Scope, request_id: &str, workstream: Option<&str>, prompt: String, repo: String, project: ContainerRef, plan: ClonePlan) -> Result<Proposal> {
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
            plan_approved: false,
            build_account: None,
            build_from_run: None,
            findings: None,
            findings_from_run: None,
            allow_push: false,
            project: Some(project),
            report: false,
            workstream: workstream.map(Into::into),
        };
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            if let Some(ws) = workstream {
                super::workstreams::require_linkable(db, &connection_id, ws, None)?;
            }
            let query = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
            let same = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::StartRun { item: None, spec: s, .. } if (s.kind, &s.repo, &s.instruction) == (spec.kind, &spec.repo, &spec.instruction)));
            if let Some(same) = same {
                return Err(refuse(format!("An identical draft is already open (proposal {}). Don't propose it again; see list_proposals.", same.id)));
            }
            proposals::create(db, Draft::from_pip(request_id, workstream, Intent::StartRun { connection_id, item: None, spec }, None), at)
        })
        .await
    }

    /// A run Pip proposes while answering `request_id`. Its prompt is the kind's own template, its ticket text the cached
    /// ticket, its clone and branch what `plan` found; only `focus` and `from_run` are Pip's words. Nothing starts: the
    /// person reads the exact prompt and approves it in the setup sheet. Asked in a workstream's conversation, the run
    /// belongs to that workstream, which must be an open one on the same ticket. A triage or plan carries what an
    /// investigation found, as Gossamr reads it from that run: the one `from_run` names when it is a finished
    /// investigation on this ticket, else the workstream's newest.
    pub async fn draft_run_as_pip(&self, scope: &Scope, request_id: &str, workstream: Option<&str>, ask: PipRunAsk, repo: String, plan: ClonePlan) -> Result<Proposal> {
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
        let mut spec = RunSpec {
            kind,
            repo,
            clone_path,
            base: plan.base,
            name: plan.name,
            instruction: instruction.into(),
            focus,
            focus_from_run: from_run.clone(),
            ticket_block: None,
            pr: None,
            pr_sha: None,
            plan: None,
            plan_from_run: None,
            plan_approved: false,
            build_account: None,
            build_from_run: None,
            findings: None,
            findings_from_run: None,
            allow_push: false,
            project: None,
            report: false,
            workstream: workstream.map(Into::into),
        };
        if matches!(kind, RunKind::Triage | RunKind::Plan) {
            self.attach_pip_findings(scope, workstream, &item, from_run.as_deref(), &mut spec).await?;
        }
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            let work = db.item(&item)?.ok_or_else(|| refuse(format!("{key} isn't in the cache, so there is nothing to base a run on")))?;
            if let Some(ws) = workstream {
                super::workstreams::require_linkable(db, &connection_id, ws, Some(&item))?;
            }
            spec.ticket_block = Some(snapshot(db, &work, &links, false));
            let query = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), item: Some(item.clone()), ..Default::default() };
            let same = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::StartRun { spec: s, .. } if same_ask(s, &spec)));
            if let Some(same) = same {
                return Err(refuse(format!("An identical draft is already open (proposal {}). Don't propose it again; see list_proposals.", same.id)));
            }
            let mut draft = Draft::from_pip(request_id, workstream, Intent::StartRun { connection_id, item: Some(item.clone()), spec }, None);
            draft.basis = Some(Basis::of(&work));
            proposals::create(db, draft, at)
        })
        .await
    }

    /// Fills a triage or plan Pip drafts with what an investigation found. `from_run` counts when it names a finished
    /// investigation on this ticket in the same workstream, and then a failure to read it is Pip's to hear; otherwise the
    /// newest finished investigation on this ticket in the conversation's workstream, if any, is used when it can be read.
    async fn attach_pip_findings(&self, scope: &Scope, workstream: Option<&str>, item: &crate::domain::ItemRef, from_run: Option<&str>, spec: &mut RunSpec) -> Result<()> {
        let of_ticket = |r: &Run| r.spec.kind == RunKind::Investigate && r.state == crate::domain::RunState::Done && r.item.as_ref().is_some_and(|i| (&i.connection_id, &i.external_id) == (&item.connection_id, &item.external_id));
        if let Some(id) = from_run {
            if let Some(named) = self.run_in(scope, id).await?.filter(|r| of_ticket(r) && r.spec.workstream.as_deref() == workstream) {
                spec.findings_from_run = Some(self.attach_findings(spec, &named.id, Some(item)).await?);
                return Ok(());
            }
        }
        let Some(ws) = workstream else { return Ok(()) };
        let newest = self
            .runs_in(scope, &RunQuery::default())
            .await?
            .into_iter()
            .filter(|r| of_ticket(r) && r.spec.workstream.as_deref() == Some(ws))
            .max_by_key(|r| (r.ended_at.unwrap_or(r.queued_at), r.queued_at));
        if let Some(found) = newest {
            let mut with = spec.clone();
            if let Ok(id) = self.attach_findings(&mut with, &found.id, Some(item)).await {
                with.findings_from_run = Some(id);
                *spec = with;
            }
        }
        Ok(())
    }

    /// The finished run a build or review Pip asks for would follow, after every check that doesn't need a clone: it
    /// belongs to this account, is of the kind `kind` follows (`pip_chain_kinds`), has finished, is on ticket `key` and in
    /// the conversation's workstream (none for none), and for a build its plan is one the person settled. Returns it with
    /// the ticket's title, to plan a clone from.
    pub async fn pip_chain_source(&self, scope: &Scope, workstream: Option<&str>, key: &str, kind: RunKind, from_run: Option<&str>) -> Result<(Run, String)> {
        let Some(&(_, needed)) = pip_chain_kinds().iter().find(|(k, _)| *k == kind) else {
            return Err(refuse(format!("a {} isn't drafted as the successor of a run", kind.as_str())));
        };
        let Some(id) = from_run else {
            return Err(refuse(format!("A {} can only follow {}: pass from_run with that run's id from list_runs.", kind.as_str(), source_words(kind))));
        };
        let source = self.run_in(scope, id).await?.ok_or_else(|| refuse(format!("There is no run {id} for this account. Call list_runs to see the ids.")))?;
        if source.spec.kind != needed {
            return Err(refuse(format!("A {} can only follow {}; run {} is a {} run.", kind.as_str(), source_words(kind), source.id, source.spec.kind.as_str())));
        }
        if source.state != crate::domain::RunState::Done {
            return Err(refuse(format!("that {} run hasn't finished", needed.as_str())));
        }
        let item = Self::item(scope, key);
        if source.item.as_ref().is_none_or(|i| (&i.connection_id, &i.external_id) != (&item.connection_id, &item.external_id)) {
            return Err(refuse(format!("that {} run is about another ticket", needed.as_str())));
        }
        match (source.spec.workstream.as_deref(), workstream) {
            (a, b) if a == b => {}
            (Some(_), _) => return Err(refuse(format!("run {} belongs to another workstream; ask in that workstream's conversation", source.id))),
            (None, _) => return Err(refuse(format!("run {} isn't part of this workstream; Pip can only follow a run of the workstream it is asked in", source.id))),
        }
        // Found before a clone is planned for it; `attach_build_account` checks it again as it fills the draft.
        // Only a plan the person settled on the ticket, never one Gossamr retired or one they haven't seen.
        if kind == RunKind::Build {
            if let Some(why) = self.plan_unsettled(&source).await? {
                return Err(refuse(why));
            }
        }
        // No sync is asked for here: the tracker asked once when the build finished, and Pip asking again and again must
        // not drive GitHub past its back-off.
        if kind == RunKind::Review && self.pull_request_of(&source)?.is_none() {
            return Err(refuse(format!("that build has no pull request in this repository yet. {}", super::workstreams::WAITING_FOR_PR_HINT)));
        }
        let work = self.with_db_for(scope, |db| db.item(&item)).await?.ok_or_else(|| refuse(format!("{key} isn't in the cache, so there is nothing to base a run on")))?;
        Ok((source, work.title))
    }

    /// A build or review Pip proposes while answering `request_id`, as the successor of the finished run `ask.from_run`.
    /// It runs the same handoff steps as the person's `draft_run`, so what it carries comes from that run and its drafts,
    /// never from Pip: a build the plan the person settled on the ticket (approved, or skipped for the run's own answer;
    /// refused before that) and a review the builder's account and the pull request pinned to its commit. Its repository
    /// is the source run's and its clone what `plan` found. Pip's own words are only a focus note, and a review takes none. A build in a workstream may push
    /// its branch and open a draft pull request; outside one it may not. The draft is Pip's, never the person's, and
    /// nothing starts until the person approves it in the setup sheet.
    pub async fn draft_chain_run_as_pip(&self, scope: &Scope, request_id: &str, workstream: Option<&str>, ask: PipRunAsk, plan: ClonePlan) -> Result<Proposal> {
        let PipRunAsk { key, kind, focus, from_run } = ask;
        let key = key.as_str();
        let (source, _) = self.pip_chain_source(scope, workstream, key, kind, from_run.as_deref()).await?;
        let repo = source.spec.repo.clone();
        self.require_watched_repo(&repo)?;
        let clone_path = self.resolve_clone(&plan.path)?;
        let item = Self::item(scope, key);
        let mut spec = RunSpec {
            kind,
            repo,
            clone_path,
            base: plan.base,
            name: plan.name,
            instruction: default_instruction(kind).into(),
            focus: None,
            focus_from_run: None,
            ticket_block: None,
            pr: None,
            pr_sha: None,
            plan: None,
            plan_from_run: None,
            plan_approved: false,
            build_account: None,
            build_from_run: None,
            findings: None,
            findings_from_run: None,
            allow_push: false,
            project: None,
            report: false,
            workstream: workstream.map(Into::into),
        };
        match kind {
            RunKind::Build => {
                spec.plan_from_run = Some(self.attach_plan(&mut spec, &source.id, Some(&item)).await?);
                // A workstream's build always ends with a draft pull request, which its review then reads.
                spec.allow_push = workstream.is_some();
                spec.focus_from_run = focus.as_ref().map(|_| source.id.clone());
                spec.focus = focus;
            }
            _ => {
                if focus.is_some() {
                    return Err(refuse("A review judges the change on its own; it takes no focus note."));
                }
                spec.build_from_run = Some(self.attach_build_account(&mut spec, &source.id, Some(&item)).await?);
                let change = self.review_target(&spec).await?;
                spec.base = change.base_ref.unwrap_or(spec.base);
                spec.pr_sha = change.sha;
                // Its verdict is read by the app; the tool is offered when the setting allows, else the written verdict counts.
                spec.report = true;
            }
        }
        let links = self.ticket_dev_links(&item);
        let connection_id = Connection::jira_id(scope);
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            let work = db.item(&item)?.ok_or_else(|| refuse(format!("{key} isn't in the cache, so there is nothing to base a run on")))?;
            if let Some(ws) = workstream {
                super::workstreams::require_linkable(db, &connection_id, ws, Some(&item))?;
            }
            spec.ticket_block = Some(snapshot(db, &work, &links, spec.plan.is_some()));
            let query = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), item: Some(item.clone()), ..Default::default() };
            let same = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::StartRun { spec: s, .. } if same_chain(s, &spec)));
            if let Some(same) = same {
                return Err(refuse(format!("An identical draft is already open (proposal {}). Don't propose it again; see list_proposals.", same.id)));
            }
            let mut draft = Draft::from_pip(request_id, workstream, Intent::StartRun { connection_id, item: Some(item.clone()), spec }, None);
            draft.basis = Some(Basis::of(&work));
            proposals::create(db, draft, at)
        })
        .await
    }
}

impl Core {
    /// Marks a follow-up as sent: applied, with the run it resumed.
    pub async fn follow_up_sent(&self, id: &str, run_id: &str) -> Result<Proposal> {
        self.with_proposals(|db| {
            let mut p = db.proposal(id)?.ok_or_else(|| refuse("that draft no longer exists"))?;
            p.state = crate::domain::ProposalState::Applied;
            p.run = Some(run_id.to_string());
            p.error = None;
            p.updated_at = Utc::now();
            db.save_proposal(&p)?;
            proposals::record(db, &p, crate::domain::Actor::Person, "draft_approved", p.updated_at);
            Ok(p)
        })
        .await
    }

    /// Keeps a follow-up pending with the reason sending it failed, so the person can try again. `kept_on_run` is the message that
    /// now waits on the stopped run, as it was when the send began, which is what lets a retry (even of an edited message) go ahead.
    pub async fn follow_up_failed(&self, id: &str, why: &str, kept_on_run: Option<&str>) -> Result<()> {
        self.with_proposals(|db| {
            if let Some(mut p) = db.proposal(id)? {
                if let Some(sent) = kept_on_run {
                    let mut attempted = p.intent.clone();
                    if let Intent::FollowUp { message, .. } = &mut attempted {
                        *message = sent.to_string();
                    }
                    p.revisions.push(crate::domain::Revision { at: Utc::now(), note: proposals::SEND_FAILED_NOTE.into(), intent: attempted });
                }
                p.error = Some(why.to_string());
                p.updated_at = Utc::now();
                db.save_proposal(&p)?;
            }
            Ok(())
        })
        .await
    }

    /// A follow-up Pip proposes for a finished run while answering `request_id`: the exact message the person will read,
    /// edit and send. Nothing is sent; approving the draft resumes the run. Refused unless the run belongs to the
    /// account and can be sent back, and when one is already waiting for it. The draft belongs to the run's workstream,
    /// if it has one, whichever conversation asked.
    pub async fn propose_follow_up_as_pip(&self, scope: &Scope, request_id: &str, run_id: &str, message: &str, reason: Option<&str>) -> Result<Proposal> {
        let message = crate::runs::result::scrub(message).trim().to_string();
        let flat = |t: &str| crate::runs::result::scrub(t).split_whitespace().collect::<Vec<_>>().join(" ");
        let reason = match reason.map(flat).filter(|r| !r.is_empty()) {
            Some(r) => r.chars().take(proposals::FOLLOW_UP_REASON_LIMIT).collect(),
            None => flat(message.lines().next().unwrap_or_default()).chars().take(proposals::FOLLOW_UP_REASON_LIMIT).collect(),
        };
        let run = self.run_in(scope, run_id).await?.ok_or_else(|| refuse(format!("there is no run {run_id} for this account")))?;
        if let Some(why) = run.follow_up_blocker() {
            return Err(refuse(format!("Run {run_id} can't be sent back: {why}.")));
        }
        let connection_id = Connection::jira_id(scope);
        let intent = Intent::FollowUp { connection_id, run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string), item: run.item.clone(), message, reason };
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            let query = ProposalQuery { states: Some(vec![StateKind::Pending, StateKind::Applying]), ..Default::default() };
            let open = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::FollowUp { run_id: r, .. } if *r == run.id));
            if let Some(open) = open {
                return Err(refuse(format!("A follow-up for run {} is already waiting (proposal {}). Revise it or leave it to the user; see list_proposals.", run.id, open.id)));
            }
            // It belongs to the run's workstream, whichever conversation Pip drafted it in.
            proposals::create(db, Draft::from_pip(request_id, run.spec.workstream.as_deref(), intent, None), at)
        })
        .await
    }
}
