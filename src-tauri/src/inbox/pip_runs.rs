//! What Pip may do with agent runs: read the signed-in account's runs, and draft one for the person to approve. The
//! spec of a drafted run is built here from what Rust knows; Pip supplies only the ticket, the kind and a focus note, or,
//! for an investigation with no ticket, a watched repository and the question. A build or review Pip drafts only as the
//! successor of a finished run, and everything it carries from that run is filled in here.

use chrono::Utc;

use super::ticket_context::snapshot;
use super::Core;
use crate::auth::Scope;
use crate::domain::workstream::Rule;
use crate::domain::{
    default_instruction, pip_chain_kinds, pip_kinds, Actor, AutoStarted, Basis, ClonePlan, CodeChangeKind, ContainerRef, CreatedBy, Intent, Origin, Proposal, ProposalQuery, Run,
    RunEvent, RunKind, RunQuery, RunSpec, RunState, StateKind, WorkstreamEvent,
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
            self.attach_pip_findings(scope, workstream, &item, from_run.as_deref(), true, &mut spec).await?;
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
    /// With `newest` false, as for a run a rule starts, only the run `from_run` names is ever carried: one that isn't
    /// such an investigation is refused, and none named carries none, since the newest may be one a tripwire named or
    /// whose output the supervisor never checked.
    async fn attach_pip_findings(&self, scope: &Scope, workstream: Option<&str>, item: &crate::domain::ItemRef, from_run: Option<&str>, newest: bool, spec: &mut RunSpec) -> Result<()> {
        let of_ticket = |r: &Run| r.spec.kind == RunKind::Investigate && r.state == crate::domain::RunState::Done && r.item.as_ref().is_some_and(|i| (&i.connection_id, &i.external_id) == (&item.connection_id, &item.external_id));
        if let Some(id) = from_run {
            if let Some(named) = self.run_in(scope, id).await?.filter(|r| of_ticket(r) && r.spec.workstream.as_deref() == workstream) {
                spec.findings_from_run = Some(self.attach_findings(spec, &named.id, Some(item)).await?);
                return Ok(());
            }
            if !newest {
                return Err(refuse(format!("run {id} isn't a finished investigation of this ticket in this workstream")));
            }
        }
        if !newest {
            return Ok(());
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
        if kind == RunKind::Review && focus.is_some() {
            return Err(refuse("A review judges the change on its own; it takes no focus note."));
        }
        let repo = source.spec.repo.clone();
        self.require_watched_repo(&repo)?;
        let clone_path = self.resolve_clone(&plan.path)?;
        let item = Self::item(scope, key);
        let mut spec = chain_spec(kind, repo, clone_path, plan, workstream);
        self.fill_chain_slots(scope, &source, &item, true, &mut spec).await?;
        if kind == RunKind::Build {
            spec.focus_from_run = focus.as_ref().map(|_| source.id.clone());
            spec.focus = focus;
        }
        let links = self.ticket_dev_links(&item);
        let connection_id = Connection::jira_id(scope);
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            let work = chain_ticket(db, &connection_id, &item, &links, &mut spec)?;
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

    /// Fills what a run that follows the finished run `source` carries from it, as Core reads it, never from a caller: a
    /// triage or plan the findings of the investigation (`source` when it is one, else the one the spec names, else, with
    /// `newest`, the workstream's newest), a build the plan the person settled and in a workstream a draft pull request,
    /// a review the builder's account and the pull request pinned to its head commit, with its verdict reported.
    pub(super) async fn fill_chain_slots(&self, scope: &Scope, source: &Run, item: &crate::domain::ItemRef, newest: bool, spec: &mut RunSpec) -> Result<()> {
        match spec.kind {
            RunKind::Triage | RunKind::Plan => {
                let named = spec.findings_from_run.take().or_else(|| (source.spec.kind == RunKind::Investigate).then(|| source.id.clone()));
                let workstream = spec.workstream.clone();
                self.attach_pip_findings(scope, workstream.as_deref(), item, named.as_deref(), newest, spec).await?;
            }
            RunKind::Build => {
                spec.plan_from_run = Some(self.attach_plan(spec, &source.id, Some(item)).await?);
                // A workstream's build always ends with a draft pull request, which its review then reads.
                spec.allow_push = spec.workstream.is_some();
            }
            RunKind::Review => {
                spec.build_from_run = Some(self.attach_build_account(spec, &source.id, Some(item)).await?);
                let change = self.review_target(spec).await?;
                spec.base = change.base_ref.unwrap_or_else(|| spec.base.clone());
                spec.pr_sha = change.sha;
                // Its verdict is read by the app; the tool is offered when the setting allows, else the written verdict counts.
                spec.report = true;
            }
            RunKind::Investigate | RunKind::Verify => {}
        }
        Ok(())
    }

    /// Starts the run `spec` describes because auto-start `rule` fired after the finished run `after_run`: the same
    /// handoff steps as a chain draft of Pip's, stored as an agent's draft from that run in its workstream and approved
    /// in the same transaction with the spec's own digest, so it is queued for `launch_waiting`. Nothing of Pip's is
    /// carried: a spec with a focus is refused. A review pinned in `spec` to the commit a sync cached is refused with
    /// `PR_MOVED` when GitHub's head is another one. The audit gets a Supervisor `autostart` line with the digest and
    /// `<rule> after <run>`. The workstream is read again in the same transaction: when it no longer starts steps on its
    /// own (closed, held, advised, out of budget) or `rule` is off in `settings`, nothing is made and the refusal is
    /// `NOT_ON_ITS_OWN`, since what the supervisor decided was decided before the person changed that.
    pub async fn autostart_run(&self, scope: &Scope, mut spec: RunSpec, rule: Rule, after_run: &str, settings: &crate::config::AgentSettings) -> Result<Run> {
        let source = self.run_in(scope, after_run).await?.ok_or_else(|| refuse(format!("there is no run {after_run} for this account")))?;
        if source.state != RunState::Done {
            return Err(refuse(format!("run {after_run} hasn't finished, so nothing starts after it")));
        }
        let Some(ws) = source.spec.workstream.clone().filter(|w| spec.workstream.as_deref() == Some(w.as_str())) else {
            return Err(refuse("a run starts on its own only in the workstream of the run it follows"));
        };
        let item = source.item.clone().ok_or_else(|| refuse("a run starts on its own only on a ticket"))?;
        if spec.focus.is_some() || spec.focus_from_run.is_some() {
            return Err(refuse("a run that starts on its own carries no focus"));
        }
        self.require_watched_repo(&spec.repo)?;
        spec.clone_path = self.resolve_clone(&spec.clone_path)?;
        let cached = spec.pr_sha.take();
        // Only the findings the rule named: the supervisor checked that run, and the workstream's newest it may not have.
        self.fill_chain_slots(scope, &source, &item, false, &mut spec).await?;
        if spec.kind == RunKind::Review && cached.is_some() && cached != spec.pr_sha {
            return Err(refuse(PR_MOVED));
        }
        let links = self.ticket_dev_links(&item);
        let connection_id = Connection::jira_id(scope);
        let file = super::db_file(&self.connection(scope)?);
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            if !db.workstream(&ws)?.is_some_and(|w| crate::config::rule_runs(settings, &w, rule)) {
                return Err(refuse(NOT_ON_ITS_OWN));
            }
            let work = chain_ticket(db, &connection_id, &item, &links, &mut spec)?;
            let digest = spec.digest();
            let intent = Intent::StartRun { connection_id: connection_id.clone(), item: Some(item.clone()), spec };
            let draft = Draft { origin: Origin::of_run(&source), created_by: CreatedBy::Agent, intent, label: None, basis: Some(Basis::of(&work)) };
            let made = proposals::create(db, draft, at)?;
            let run_id = proposals::new_id()?;
            let run = db.approve_start_run(&made.id, &digest, |p| {
                let Intent::StartRun { spec, .. } = &p.intent else { unreachable!("made as a run draft") };
                let mut run = Run::queued(run_id, p.id.clone(), connection_id.clone(), Some(item.clone()), spec.clone(), file, at);
                run.auto_start = Some(AutoStarted { rule, after_run: after_run.to_string() });
                run
            })?;
            let event = WorkstreamEvent::new(&ws, Actor::Supervisor, "autostart", at).run(&run.id).proposal(&made.id).digest(&run.digest).detail(format!("{} after {after_run}", rule.as_str()));
            db.append_workstream_event(&event)?;
            Ok(run)
        })
        .await
    }
}

/// Why an auto-started review waits: GitHub's head of the pull request isn't the commit the last sync cached.
pub const PR_MOVED: &str = "the pull request has a commit the last sync hasn't seen; the review waits for the next one";

/// Why a step a rule decided on wasn't started or sent after all: the person held the workstream, switched it to Advise
/// or switched the rule off since, or its budget ran out. Not a failure; the rules decide again once it starts steps on
/// its own again.
pub const NOT_ON_ITS_OWN: &str = "this workstream doesn't start steps on its own right now";

/// The spec of a run that follows another before its handoffs are filled: the kind's own template, the source's
/// repository, the clone `plan` found, and nothing of Pip's.
fn chain_spec(kind: RunKind, repo: String, clone_path: std::path::PathBuf, plan: ClonePlan, workstream: Option<&str>) -> RunSpec {
    RunSpec {
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
    }
}

/// The ticket a chained run is about, from the cache: checked against the run's workstream, with its text set as the
/// spec's ticket block.
fn chain_ticket(db: &crate::db::Db, connection_id: &str, item: &crate::domain::ItemRef, links: &[crate::domain::DevLink], spec: &mut RunSpec) -> Result<crate::domain::WorkItem> {
    let work = db.item(item)?.ok_or_else(|| refuse(format!("{} isn't in the cache, so there is nothing to base a run on", item.key)))?;
    if let Some(ws) = &spec.workstream {
        super::workstreams::require_linkable(db, connection_id, ws, Some(item))?;
    }
    spec.ticket_block = Some(snapshot(db, &work, links, spec.plan.is_some()));
    Ok(work)
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

    /// An answer Pip suggests to a run that is asking a question, while answering `request_id`: the exact message the
    /// person reads, may edit and sends. Nothing is sent; approving the draft answers the run the way the person's own
    /// answer does. Refused unless the run belongs to the account and is waiting for an answer. The draft keeps what the
    /// run asked and belongs to the run's workstream, if it has one, whichever conversation asked; there a newer answer
    /// replaces Pip's older one, and outside one a second is refused while the first waits.
    pub async fn propose_answer_as_pip(&self, scope: &Scope, request_id: &str, run_id: &str, message: &str) -> Result<Proposal> {
        let message = crate::runs::result::scrub(message).trim().to_string();
        let run = self.run_in(scope, run_id).await?.ok_or_else(|| refuse(format!("there is no run {run_id} for this account")))?;
        if run.state != RunState::NeedsAnswer {
            return Err(refuse(format!("Run {run_id} is {}, so it isn't waiting for an answer.", run.state.as_str())));
        }
        let question = crate::runs::answer::asked(run.needs.as_deref());
        let connection_id = Connection::jira_id(scope);
        let intent = Intent::RunAnswer { connection_id, run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string), item: run.item.clone(), message, question };
        let at = Utc::now();
        self.with_db_for(scope, |db| {
            if run.spec.workstream.is_none() {
                let query = ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() };
                if let Some(open) = db.proposals(&query)?.into_iter().find(|p| matches!(&p.intent, Intent::RunAnswer { run_id: r, .. } if *r == run.id)) {
                    return Err(refuse(format!("An answer for run {} is already waiting (proposal {}). Revise it or leave it to the user; see list_proposals.", run.id, open.id)));
                }
            }
            proposals::create(db, Draft::from_pip(request_id, run.spec.workstream.as_deref(), intent, None), at)
        })
        .await
    }

    /// Marks an answer draft as sent: applied, with the run it answered, by the person. `sent` is the text that went,
    /// which is recorded as the person's revision when it differs from the draft's.
    pub async fn answer_draft_sent(&self, id: &str, run_id: &str, sent: &str) -> Result<Proposal> {
        self.with_proposals(|db| {
            let mut p = db.proposal(id)?.ok_or_else(|| refuse("that draft no longer exists"))?;
            let at = Utc::now();
            if let Intent::RunAnswer { message, .. } = &p.intent {
                if message.trim() != sent.trim() {
                    let mut went = p.intent.clone();
                    if let Intent::RunAnswer { message, .. } = &mut went {
                        *message = sent.trim().to_string();
                    }
                    p.revisions.push(crate::domain::Revision { at, note: proposals::EDITED_NOTE.into(), intent: went.clone() });
                    p.intent = went;
                }
            }
            p.state = crate::domain::ProposalState::Applied;
            p.run = Some(run_id.to_string());
            p.error = None;
            p.updated_at = at;
            db.save_proposal(&p)?;
            proposals::record(db, &p, crate::domain::Actor::Person, "draft_approved", at);
            Ok(p)
        })
        .await
    }

    /// Keeps an answer draft pending with the reason sending it failed, so the person can try again. A draft decided
    /// meanwhile is left as it is.
    pub async fn answer_draft_failed(&self, id: &str, why: &str) -> Result<()> {
        self.with_proposals(|db| {
            if let Some(mut p) = db.proposal(id)?.filter(|p| p.state == crate::domain::ProposalState::Pending) {
                p.error = Some(why.to_string());
                p.updated_at = Utc::now();
                db.save_proposal(&p)?;
            }
            Ok(())
        })
        .await
    }

    /// Retires the pending answer drafts for `run_id` but `except`, with `reason`: the run was answered, or stopped
    /// asking. Returns how many there were.
    pub async fn retire_answer_drafts(&self, run_id: &str, except: Option<&str>, reason: &str) -> Result<usize> {
        self.with_proposals(|db| {
            let query = ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() };
            let open: Vec<Proposal> = db
                .proposals(&query)?
                .into_iter()
                .filter(|p| matches!(&p.intent, Intent::RunAnswer { run_id: r, .. } if r == run_id) && Some(p.id.as_str()) != except)
                .collect();
            let at = Utc::now();
            for p in &open {
                let retired = proposals::retire(db, &p.id, reason, at)?;
                proposals::record(db, &retired, crate::domain::Actor::Supervisor, "draft_retired", at);
            }
            Ok(open.len())
        })
        .await
    }
}
