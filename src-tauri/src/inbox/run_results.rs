//! What a finished run leaves behind for the person: the change it produced, and drafts they can approve.
//!
//! Everything here makes drafts only. The text in them is the agent's, so each draft says which run it came from
//! and the person reads and edits it like any other before anything is posted.

use chrono::Utc;
use serde::Serialize;

use super::Core;
use crate::domain::{Basis, CodeChange, CodeChangeKind, ContainerRef, CreatedBy, Doc, Intent, ItemRef, LinkKind, NewItem, Origin, Proposal, ProposalQuery, ProposalState, Run, RunKind, RunState, StateKind};
use crate::error::{Error, Result};
use crate::proposals::{self, Draft};
use crate::runs::pr;
use crate::runs::result::{jira_note, subtask_proposals, ticket_from_answer, ticket_keys, ticket_proposal, JiraNote, TicketProposal};
use crate::tracker::{self, Connection};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutcome {
    pub note: Option<JiraNote>,
    pub keys: Vec<String>,
    pub change: Option<CodeChange>,
    pub draft: Option<RunDraft>,
    /// For a run with no ticket: the ticket its `New ticket:` section proposes, when it has one.
    pub ticket: Option<TicketProposal>,
    /// The ticket draft made from this run, in whatever state it is now.
    pub ticket_draft: Option<RunDraft>,
    /// For a Triage run on a ticket: the breakdown its `Subtasks:` section proposes.
    pub subtasks: Vec<String>,
    /// The subtasks draft made from this run, in whatever state it is now.
    pub subtasks_draft: Option<RunDraft>,
    /// The run's full answer couldn't be read, so `note` is only Claude's one-line summary of it.
    pub summary_only: bool,
}

/// The comment draft made from a run, in whatever state it is now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDraft {
    pub id: String,
    pub state: ProposalState,
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

fn state_words(state: &ProposalState) -> &'static str {
    match state {
        ProposalState::Pending | ProposalState::Applying => "waiting for you",
        ProposalState::Applied => "already created",
        ProposalState::Skipped => "skipped",
        ProposalState::Retired(_) => "out of date",
    }
}

fn intro(kind: RunKind) -> &'static str {
    match kind {
        RunKind::Investigate => "Looked into this with an agent (it was asked to only read code and change nothing).",
        _ => "An agent worked on this.",
    }
}

/// The comment as it is first drafted. The person edits it before posting.
pub fn comment_text(run: &Run, note: &JiraNote, change: Option<&CodeChange>) -> String {
    let mut parts = vec![intro(run.spec.kind).to_string()];
    if !run.result_complete {
        parts.push(SUMMARY_ONLY.into());
    } else if !note.from_marker {
        parts.push("The agent didn't mark anything for Jira, so this is its whole answer, shortened:".into());
    }
    parts.push(note.text.clone());
    if let Some(pull) = change.filter(|c| c.kind == CodeChangeKind::PullRequest) {
        parts.push(format!("Pull request: {}", pull.url));
    }
    parts.join("\n\n")
}

/// Said wherever a run's result is only the one-line summary Claude keeps, so nobody takes it for the whole answer.
pub const SUMMARY_ONLY: &str = "Gossamr could only read a one-line summary of the run, not its full answer. Open the session to see the rest.";

const FOUND_BY: &str = "Found by an agent that was asked to only read code and change nothing.";

fn ticket_drafts(all: Vec<Proposal>, run_id: &str) -> Vec<Proposal> {
    all.into_iter().filter(|p| matches!((&p.origin, &p.intent), (Origin::Run { run_id: r, .. }, Intent::Create { .. }) if r == run_id)).collect()
}

fn subtask_drafts(all: Vec<Proposal>, run_id: &str) -> Vec<Proposal> {
    all.into_iter().filter(|p| matches!((&p.origin, &p.intent), (Origin::Run { run_id: r, .. }, Intent::Subtasks { .. }) if r == run_id)).collect()
}

/// The ticket an approved draft made.
fn ticket_made(draft: &Proposal) -> Option<&ItemRef> {
    draft.created.first().filter(|_| draft.state == ProposalState::Applied)
}

fn ticket_fields(proposal: &TicketProposal) -> NewItem {
    let body = if proposal.body.is_empty() { FOUND_BY.to_string() } else { format!("{}\n\n{FOUND_BY}", proposal.body) };
    NewItem { title: proposal.title.clone(), body: Doc::from_text(&body, &[]), kind: proposal.kind, assignee: None, parent: None, priority: None, labels: Vec::new() }
}

fn label_of(run: &Run) -> String {
    match &run.short_id {
        Some(short) => format!("From agent run {short}"),
        None => "From an agent run".into(),
    }
}

impl Core {
    fn change_of(&self, run: &Run) -> Result<Option<CodeChange>> {
        let branches = pr::branches_of(run);
        let mut found = Vec::new();
        for id in self.code.connection_ids() {
            let Some(repo) = self.watched_repos(&id)?.into_iter().find(|r| r.eq_ignore_ascii_case(&run.spec.repo)) else { continue };
            found.extend(self.with_code_db(&id, |db| db.code_changes_for_branch(&id, &repo, &branches))?);
        }
        Ok(pr::change_for(run, &found))
    }

    /// What the sheet shows about a run's result: the part meant for Jira, the tickets it names, and the pull request
    /// or branch it produced as far as a sync has cached them.
    pub async fn run_outcome(&self, id: &str) -> Result<RunOutcome> {
        let run = self.run(id).await?.ok_or_else(|| refuse("that run no longer exists"))?;
        let own = run.item.as_ref().map(|i| i.key.to_uppercase());
        let result = run.result.as_deref().map(str::trim).filter(|r| !r.is_empty());
        let ticket_draft = self.ticket_drafts_of(&run).await?.into_iter().next();
        if let Some(made) = ticket_draft.as_ref().and_then(ticket_made) {
            if let Err(e) = self.record_created_from_run(&run.id, made).await {
                eprintln!("couldn't note the created ticket on run {}: {e}", run.id);
            }
        }
        Ok(RunOutcome {
            note: result.map(jira_note),
            keys: result.map(ticket_keys).unwrap_or_default().into_iter().filter(|k| Some(k) != own.as_ref()).collect(),
            change: self.change_of(&run)?,
            draft: self.comment_drafts_of(&run).await?.into_iter().next().map(|p| RunDraft { id: p.id, state: p.state }),
            ticket: result.filter(|_| run.item.is_none()).and_then(ticket_proposal),
            ticket_draft: ticket_draft.map(|p| RunDraft { id: p.id, state: p.state }),
            subtasks: result.filter(|_| run.spec.kind == RunKind::Triage && run.item.is_some()).map(subtask_proposals).unwrap_or_default(),
            subtasks_draft: self.subtask_drafts_of(&run).await?.into_iter().next().map(|p| RunDraft { id: p.id, state: p.state }),
            summary_only: run.state == RunState::Done && result.is_some() && !run.result_complete,
        })
    }

    /// Every ticket draft made from `run`, newest first, whether it is still waiting or was decided. A run has at most one.
    async fn ticket_drafts_of(&self, run: &Run) -> Result<Vec<Proposal>> {
        Ok(ticket_drafts(self.proposals(&ProposalQuery::default()).await?, &run.id))
    }

    /// Every subtasks draft made from `run`, whether it is still waiting or was decided. A run has at most one.
    async fn subtask_drafts_of(&self, run: &Run) -> Result<Vec<Proposal>> {
        let Some(item) = run.item.clone() else { return Ok(Vec::new()) };
        let found = self.proposals(&ProposalQuery { item: Some(item), ..Default::default() }).await?;
        Ok(subtask_drafts(found, &run.id))
    }

    /// Every comment draft made from `run`, newest first, whether it is still waiting or was decided.
    async fn comment_drafts_of(&self, run: &Run) -> Result<Vec<Proposal>> {
        let Some(item) = run.item.clone() else { return Ok(Vec::new()) };
        let found = self.proposals(&ProposalQuery { item: Some(item), ..Default::default() }).await?;
        Ok(found.into_iter().filter(|p| matches!((&p.origin, &p.intent), (Origin::Run { run_id, .. }, Intent::Comment { .. }) if *run_id == run.id)).collect())
    }

    async fn finished_run(&self, id: &str) -> Result<(Run, ItemRef)> {
        let run = self.run(id).await?.ok_or_else(|| refuse("that run no longer exists"))?;
        if run.state != RunState::Done {
            return Err(refuse("that run hasn't finished"));
        }
        let item = run.item.clone().ok_or_else(|| refuse("that run isn't about a ticket"))?;
        Ok((run, item))
    }

    /// Stores a draft the person made from a run's result, after checking the ticket is on the signed-in connection.
    async fn draft_from_run(&self, run: &Run, intent: Intent, label: String) -> Result<Proposal> {
        let scope = self.scope().await?;
        if intent.target().is_none_or(|t| t.connection_id != Connection::jira_id(&scope)) {
            return Err(refuse("that item belongs to another connection"));
        }
        let origin = Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) };
        self.propose(&scope, Draft { origin, created_by: CreatedBy::User, intent, label: Some(label), basis: None }).await
    }

    async fn pending_same(&self, same: impl Fn(&Intent) -> bool) -> Result<Option<Proposal>> {
        let waiting = self.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() }).await?;
        Ok(waiting.into_iter().find(|p| same(&p.intent)))
    }

    async fn comment_intent(&self, run: &Run, item: ItemRef, note: &JiraNote) -> Result<Intent> {
        let change = self.change_of(run)?;
        let body = tracker::comment_doc(&comment_text(run, note, change.as_ref()), &[]);
        Ok(Intent::Comment { item, body })
    }

    /// A comment on the run's ticket made from the `For Jira:` part of its result. Built here, without Pip.
    pub async fn draft_run_comment(&self, id: &str) -> Result<Proposal> {
        let (run, item) = self.finished_run(id).await?;
        let note = jira_note(run.result.as_deref().unwrap_or(""));
        if note.text.is_empty() {
            return Err(refuse("the run finished without a written answer, so there is nothing to draft"));
        }
        let intent = self.comment_intent(&run, item.clone(), &note).await?;
        let same = |i: &Intent| matches!((i, &intent), (Intent::Comment { item: a, body: x }, Intent::Comment { item: b, body: y }) if a == b && x.plain_text() == y.plain_text());
        if let Some(existing) = self.pending_same(same).await? {
            return Err(refuse(format!("that comment is already waiting as a draft on {} (draft {})", item.key, existing.id)));
        }
        self.draft_from_run(&run, intent, label_of(&run)).await
    }

    /// The same draft, made when a run finishes. Only a full answer that marked a `For Jira:` section is used, and a
    /// run that already has a comment draft in any state, even a skipped one, gets no second.
    pub async fn auto_draft_run_comment(&self, id: &str) -> Result<Option<Proposal>> {
        let Ok((run, item)) = self.finished_run(id).await else { return Ok(None) };
        if !run.result_complete {
            return Ok(None);
        }
        let note = jira_note(run.result.as_deref().unwrap_or(""));
        if !note.from_marker || note.text.is_empty() || !self.comment_drafts_of(&run).await?.is_empty() {
            return Ok(None);
        }
        let intent = self.comment_intent(&run, item, &note).await?;
        Ok(Some(self.draft_from_run(&run, intent, label_of(&run)).await?))
    }

    /// The breakdown a finished Triage run proposed, drafted as subtasks on its ticket. Never created in Jira until
    /// approved. `None` when the run isn't a Triage on a ticket, has no `Subtasks:` section, or already has a draft in
    /// any state, even a skipped one. Looking and storing happen under one lock, so two callers can't both make one.
    pub async fn draft_run_subtasks(&self, id: &str) -> Result<Option<Proposal>> {
        let Ok((run, item)) = self.finished_run(id).await else { return Ok(None) };
        let summaries = subtask_proposals(run.result.as_deref().unwrap_or(""));
        if !run.result_complete || run.spec.kind != RunKind::Triage || summaries.is_empty() {
            return Ok(None);
        }
        let scope = self.scope().await?;
        if item.connection_id != Connection::jira_id(&scope) {
            return Err(refuse("that item belongs to another connection"));
        }
        let mut draft = Draft {
            origin: Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) },
            created_by: CreatedBy::User,
            intent: Intent::Subtasks { parent: item.clone(), summaries },
            label: Some(label_of(&run)),
            basis: None,
        };
        self.with_db_for(&scope, |db| {
            let found = db.proposals(&ProposalQuery { item: Some(item.clone()), ..Default::default() })?;
            if !subtask_drafts(found, &run.id).is_empty() {
                return Ok(None);
            }
            draft.basis = db.item(&item)?.as_ref().map(Basis::of);
            Ok(Some(proposals::create(db, draft, Utc::now())?))
        })
        .await
    }

    async fn ticketless_run(&self, id: &str) -> Result<Run> {
        let run = self.run(id).await?.ok_or_else(|| refuse("that run no longer exists"))?;
        if run.state != RunState::Done {
            return Err(refuse("that run hasn't finished"));
        }
        if run.item.is_some() {
            return Err(refuse("that run is about a ticket, so its result goes to that ticket as a comment"));
        }
        Ok(run)
    }

    /// Where a run's ticket lands: the project chosen when it started, else the repository's usual one.
    async fn project_of(&self, run: &Run) -> Result<ContainerRef> {
        match &run.spec.project {
            Some(project) => Ok(project.clone()),
            None => self.repo_project(&run.spec.repo).await?.ok_or_else(|| refuse("there is no project to put the ticket in; start the run again and choose one")),
        }
    }

    /// Stores the one ticket draft of `run`. Looking and storing happen under one lock, so two callers can't both make
    /// one; an existing draft, in any state, is returned as `Err`.
    async fn draft_ticket_once(&self, run: &Run, proposal: &TicketProposal) -> Result<std::result::Result<Proposal, Proposal>> {
        let scope = self.scope().await?;
        let container = self.project_of(run).await?;
        if container.connection_id != Connection::jira_id(&scope) {
            return Err(refuse("that project belongs to another connection"));
        }
        let draft = Draft {
            origin: Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) },
            created_by: CreatedBy::User,
            intent: Intent::Create { container, fields: ticket_fields(proposal), link: None },
            label: Some(label_of(run)),
            basis: None,
        };
        self.with_db_for(&scope, |db| {
            if let Some(existing) = ticket_drafts(db.proposals(&ProposalQuery::default())?, &run.id).into_iter().next() {
                return Ok(Err(existing));
            }
            Ok(Ok(proposals::create(db, draft, Utc::now())?))
        })
        .await
    }

    /// A draft ticket from a finished run that has no ticket: the one its `New ticket:` section proposes, or, when it has
    /// none, the answer as written for the person to edit. Never created in Jira until approved. A run that already has
    /// a ticket draft, even a skipped one, gets no second.
    pub async fn draft_run_ticket(&self, id: &str) -> Result<Proposal> {
        let run = self.ticketless_run(id).await?;
        let result = run.result.as_deref().unwrap_or("");
        let proposal = ticket_proposal(result).or_else(|| ticket_from_answer(result)).ok_or_else(|| refuse("the run finished without a written answer, so there is nothing to draft"))?;
        self.draft_ticket_once(&run, &proposal).await?.map_err(|existing| refuse(format!("that run already has a ticket draft ({}), {}", existing.id, state_words(&existing.state))))
    }

    /// The same draft, made when an investigation that was started to end as a ticket finishes. Only a result with a
    /// `New ticket:` section and a title is used.
    pub async fn auto_draft_run_ticket(&self, id: &str) -> Result<Option<Proposal>> {
        let Ok(run) = self.ticketless_run(id).await else { return Ok(None) };
        if !run.result_complete {
            return Ok(None);
        }
        let Some(proposal) = run.spec.project.as_ref().and(run.result.as_deref()).and_then(ticket_proposal) else { return Ok(None) };
        Ok(self.draft_ticket_once(&run, &proposal).await?.ok())
    }

    /// The watched project that most recently had a ticket linked to a pull request of `repo`.
    pub async fn repo_project(&self, repo: &str) -> Result<Option<ContainerRef>> {
        let scope = self.scope().await?;
        let jira = Connection::jira_id(&scope);
        let mut linked: Vec<(String, String)> = Vec::new();
        for id in self.code.connection_ids() {
            linked.extend(self.with_code_db(&id, |db| db.item_keys_for_repo(&jira, repo))?);
        }
        linked.sort_by(|a, b| b.1.cmp(&a.1));
        let projects = self.containers_in(&scope).await?;
        Ok(linked.iter().find_map(|(key, _)| {
            let prefix = key.rsplit_once('-')?.0;
            projects.iter().find(|c| c.key.eq_ignore_ascii_case(prefix)).map(|c| c.container_ref.clone())
        }))
    }

    /// Remembers on the run which ticket its approved draft created, so the run can say so.
    pub(super) async fn record_created_from_run(&self, run_id: &str, made: &ItemRef) -> Result<()> {
        self.with_db_for(&self.scope().await?, |db| match db.run(run_id)? {
            Some(mut run) if run.created_item.as_ref() != Some(made) => {
                run.created_item = Some(made.clone());
                db.save_run(&run).map(|_| ())
            }
            _ => Ok(()),
        })
        .await
    }

    /// A link saying the run's ticket is blocked by `blocker_key`. The blocker is the end that blocks, so it is the
    /// draft's `from`, and the draft shows on the blocker's ticket.
    pub async fn draft_run_blocker(&self, id: &str, blocker_key: &str) -> Result<Proposal> {
        let (run, item) = self.finished_run(id).await?;
        let key = blocker_key.trim().to_uppercase();
        if ticket_keys(&key) != [key.clone()] {
            return Err(refuse(format!("\"{}\" doesn't look like a ticket key", blocker_key.trim())));
        }
        if key.eq_ignore_ascii_case(&item.key) {
            return Err(refuse("a ticket can't block itself"));
        }
        let wanted = ItemRef { connection_id: item.connection_id.clone(), external_id: key.clone(), key: key.clone() };
        let blocker = self.cache_item(&wanted).await?.ok_or_else(|| refuse(format!("{key} wasn't found in Jira, so it can't be linked")))?.item;
        let same = |i: &Intent| matches!(i, Intent::Link { from, to, kind: LinkKind::Blocks } if *from == blocker && *to == item);
        if let Some(existing) = self.pending_same(same).await? {
            return Err(refuse(format!("that link is already waiting as a draft (draft {})", existing.id)));
        }
        let label = format!("Blocked by {key}");
        self.draft_from_run(&run, Intent::Link { from: blocker, to: item, kind: LinkKind::Blocks }, label).await
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::domain::fixtures::run_spec;
    use crate::domain::{CodeChangeState, ItemKind, RunSpec};
    use crate::inbox::testing::{fixture_watching, Fixture};

    const RESULT: &str = "The lag comes from one consumer.\n\nFor Jira:\nAdd a backoff to the consumer.";

    async fn approved(fx: &Fixture, spec: RunSpec, item: Option<ItemRef>, result: &str, edit: impl FnOnce(&mut Run)) -> Run {
        let p = fx.core.draft_run(spec, item).await.unwrap();
        let digest = fx.core.runs_review(&p.id).await.unwrap().digest;
        let mut run = fx.core.runs_approve(&p.id, &digest).await.unwrap();
        run.state = RunState::Done;
        run.result = Some(result.into());
        run.result_complete = true;
        run.short_id = crate::runs::cli::ShortId::parse(&format!("ab12{:04x}", N.load(std::sync::atomic::Ordering::SeqCst)));
        run.ended_at = Some(Utc::now());
        edit(&mut run);
        fx.core.save_run(&run).await.unwrap();
        run
    }

    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

    fn next_spec(fx: &Fixture) -> RunSpec {
        let clone = fx.home.join("webshop");
        std::fs::create_dir_all(clone.join(".git")).unwrap();
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        RunSpec { clone_path: clone, name: format!("eng-1-fix-cart-{n:04x}"), ..run_spec() }
    }

    async fn run_with(fx: &Fixture, edit: impl FnOnce(&mut Run)) -> Run {
        approved(fx, next_spec(fx), Some(fx.item("CA-1")), RESULT, edit).await
    }

    const TICKET_RESULT: &str = "I read the consumer.\n\nNew ticket:\nTitle: Add a backoff to the order consumer\nKind: bug\nIt retries in a tight loop.";

    async fn project(fx: &Fixture) -> ContainerRef {
        fx.core.containers_in(&fx.scope).await.unwrap()[0].container_ref.clone()
    }

    /// A finished investigation with no ticket that was started to end as one.
    async fn ticketless(fx: &Fixture, result: &str, edit: impl FnOnce(&mut Run)) -> Run {
        let spec = RunSpec { instruction: String::new(), project: Some(project(fx).await), ..next_spec(fx) };
        approved(fx, spec, None, result, edit).await
    }

    fn create_of(p: &Proposal) -> (&ContainerRef, &NewItem) {
        match &p.intent {
            Intent::Create { container, fields, .. } => (container, fields),
            other => panic!("{other:?}"),
        }
    }

    async fn ticket_drafts_in(fx: &Fixture) -> Vec<Proposal> {
        fx.core.proposals(&ProposalQuery::default()).await.unwrap().into_iter().filter(|p| matches!(p.intent, Intent::Create { .. })).collect()
    }

    async fn cache_change(fx: &Fixture, change: CodeChange) {
        fx.core.with_code_db("github:ann", |db| db.upsert_code_changes(&[change], "2026-09-29T00:00:00Z")).unwrap();
    }

    fn pull(n: u64, head: &str, state: CodeChangeState) -> CodeChange {
        let mut c = crate::codehost::links::tests::pr(n, head, "T", "");
        c.state = state;
        c
    }

    fn body_of(p: &Proposal) -> String {
        match &p.intent {
            Intent::Comment { body, .. } => body.plain_text(),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_comment_is_drafted_from_the_for_jira_part_marked_as_from_the_run_and_nothing_is_posted() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        let p = fx.core.draft_run_comment(&run.id).await.unwrap();
        assert_eq!((p.state.clone(), p.created_by), (crate::domain::ProposalState::Pending, CreatedBy::User));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert_eq!(p.label, Some(format!("From agent run {}", run.short_id.as_ref().unwrap())));
        assert_eq!(body_of(&p), "Looked into this with an agent (it was asked to only read code and change nothing).\nAdd a backoff to the consumer.");
        assert!(matches!(&p.intent, Intent::Comment { item, .. } if *item == fx.item("CA-1")));
        assert!(fx.tracker.intents().is_empty(), "a draft writes nothing");
    }

    #[tokio::test]
    async fn without_a_for_jira_section_the_draft_says_so() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.result = Some("It is the rounding.".into())).await;
        let text = body_of(&fx.core.draft_run_comment(&run.id).await.unwrap());
        assert!(text.contains("didn't mark anything for Jira") && text.ends_with("It is the rounding."), "{text}");
    }

    #[tokio::test]
    async fn a_summary_only_run_is_drafted_on_request_with_honest_wording_and_never_automatically() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let summary = "Triage complete: small PR.\n\nFor Jira: a marker inside a summary.";
        let run = run_with(&fx, |r| (r.result, r.summary, r.result_complete) = (Some(summary.into()), Some(summary.into()), false)).await;
        assert_eq!(fx.core.auto_draft_run_comment(&run.id).await.unwrap(), None);
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Comment { .. })));

        let text = body_of(&fx.core.draft_run_comment(&run.id).await.unwrap());
        assert!(text.contains(SUMMARY_ONLY) && !text.contains("didn't mark anything"), "{text}");
        assert!(fx.core.run_outcome(&run.id).await.unwrap().summary_only);
        assert!(!fx.core.run_outcome(&run_with(&fx, |_| {}).await.id).await.unwrap().summary_only);
    }

    #[tokio::test]
    async fn nothing_else_is_drafted_automatically_from_a_bare_summary() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let triage = triage_with(&fx, BREAKDOWN).await;
        fx.core.save_run(&Run { result_complete: false, ..triage.clone() }).await.unwrap();
        assert_eq!(fx.core.draft_run_subtasks(&triage.id).await.unwrap(), None);

        let loose = ticketless(&fx, TICKET_RESULT, |r| r.result_complete = false).await;
        assert_eq!(fx.core.auto_draft_run_ticket(&loose.id).await.unwrap(), None);
        let full = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        assert!(fx.core.auto_draft_run_ticket(&full.id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn the_pull_request_link_is_added_only_when_a_cached_pull_request_has_the_runs_branch() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        cache_change(&fx, pull(7, "unrelated", CodeChangeState::Open)).await;
        assert!(!body_of(&fx.core.draft_run_comment(&run.id).await.unwrap()).contains("Pull request"));

        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        cache_change(&fx, pull(7, &format!("worktree-{}", run.spec.name), CodeChangeState::Open)).await;
        let text = body_of(&fx.core.draft_run_comment(&run.id).await.unwrap());
        assert!(text.ends_with("Pull request: https://github.com/acme/webshop/pull/7"), "{text}");
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().change.unwrap().number, Some(7));
    }

    #[tokio::test]
    async fn a_pull_request_in_an_unwatched_repository_is_not_matched() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.spec.repo = "acme/gateway".into()).await;
        let mut c = pull(7, &format!("worktree-{}", run.spec.name), CodeChangeState::Open);
        c.repo = "acme/gateway".into();
        cache_change(&fx, c).await;
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().change, None);
    }

    #[tokio::test]
    async fn drafting_is_refused_unless_the_run_is_done_has_a_ticket_and_an_answer() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let working = run_with(&fx, |r| r.state = RunState::Working).await;
        assert!(fx.core.draft_run_comment(&working.id).await.unwrap_err().to_string().contains("hasn't finished"));
        assert!(fx.core.draft_run_blocker(&working.id, "CA-2").await.is_err());

        let fx = fixture_watching(&["acme/webshop"]).await;
        let blank = run_with(&fx, |r| r.result = Some(" \n".into())).await;
        assert!(fx.core.draft_run_comment(&blank.id).await.unwrap_err().to_string().contains("nothing to draft"));
        let none = run_with(&fx, |r| r.result = None).await;
        assert!(fx.core.draft_run_comment(&none.id).await.is_err());

        let fx = fixture_watching(&["acme/webshop"]).await;
        let no_ticket = run_with(&fx, |r| r.item = None).await;
        assert!(fx.core.draft_run_comment(&no_ticket.id).await.unwrap_err().to_string().contains("isn't about a ticket"));
        assert!(fx.core.draft_run_comment("missing").await.is_err());
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Comment { .. })));
    }

    #[tokio::test]
    async fn a_run_of_another_connection_cannot_draft_here() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.item.as_mut().unwrap().connection_id = "elsewhere".into()).await;
        let err = fx.core.draft_run_comment(&run.id).await.unwrap_err();
        assert!(err.to_string().contains("another connection"), "{err}");
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Comment { .. })));
    }

    #[tokio::test]
    async fn the_same_comment_is_not_drafted_twice_while_the_first_waits() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        let first = fx.core.draft_run_comment(&run.id).await.unwrap();
        let err = fx.core.draft_run_comment(&run.id).await.unwrap_err();
        assert!(err.to_string().contains(&first.id), "{err}");
        fx.core.skip_proposal(&first.id).await.unwrap();
        assert!(fx.core.draft_run_comment(&run.id).await.is_ok(), "once it is decided a new one may be drafted");
    }

    #[tokio::test]
    async fn a_blocker_draft_links_the_blocking_ticket_to_the_runs_ticket_and_applies_nothing() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        fx.add_item(2).await;
        let run = run_with(&fx, |_| {}).await;
        let p = fx.core.draft_run_blocker(&run.id, " ca-2 ").await.unwrap();
        assert!(matches!(&p.intent, Intent::Link { from, to, kind: LinkKind::Blocks } if *from == fx.item("CA-2") && *to == fx.item("CA-1")));
        assert_eq!((p.label.as_deref(), p.created_by), (Some("Blocked by CA-2"), CreatedBy::User));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert!(fx.tracker.intents().is_empty());
        let err = fx.core.draft_run_blocker(&run.id, "CA-2").await.unwrap_err();
        assert!(err.to_string().contains(&p.id), "{err}");
    }

    #[tokio::test]
    async fn a_blocker_must_look_like_a_ticket_and_not_be_the_runs_own() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        for bad in ["", "not a key", "CA-1", "ca-1", "CA-2 CA-3", "CA-"] {
            assert!(fx.core.draft_run_blocker(&run.id, bad).await.is_err(), "{bad:?}");
        }
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Link { .. })));
    }

    #[tokio::test]
    async fn the_outcome_offers_the_note_and_the_other_tickets_the_result_names() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |r| r.result = Some("Blocked by CA-9, related to CA-1.\n\nFor Jira: waiting on CA-9 and CA-12.".into())).await;
        let outcome = fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!(outcome.keys, ["CA-9", "CA-12"], "the run's own ticket is not offered");
        assert_eq!(outcome.note.unwrap(), JiraNote { text: "waiting on CA-9 and CA-12.".into(), from_marker: true });
        let empty = run_with(&fx, |r| r.result = None).await;
        assert_eq!(fx.core.run_outcome(&empty.id).await.unwrap().note, None);
    }

    #[tokio::test]
    async fn an_automatic_draft_is_the_same_user_draft_from_the_run_and_is_made_once_whatever_happens_to_it() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = run_with(&fx, |_| {}).await;
        let auto = fx.core.auto_draft_run_comment(&run.id).await.unwrap().unwrap();
        assert_eq!((auto.state.clone(), auto.created_by), (crate::domain::ProposalState::Pending, CreatedBy::User));
        assert_eq!(auto.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert_eq!(body_of(&auto), "Looked into this with an agent (it was asked to only read code and change nothing).\nAdd a backoff to the consumer.");
        assert!(fx.tracker.intents().is_empty());
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().draft, Some(RunDraft { id: auto.id.clone(), state: crate::domain::ProposalState::Pending }));

        assert_eq!(fx.core.auto_draft_run_comment(&run.id).await.unwrap(), None, "waiting");
        assert!(fx.core.draft_run_comment(&run.id).await.unwrap_err().to_string().contains(&auto.id));
        fx.core.skip_proposal(&auto.id).await.unwrap();
        assert_eq!(fx.core.auto_draft_run_comment(&run.id).await.unwrap(), None, "skipped");
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().draft.unwrap().state, crate::domain::ProposalState::Skipped);
        assert!(fx.core.draft_run_comment(&run.id).await.is_ok(), "the button still works after a skip");
    }

    #[tokio::test]
    async fn nothing_is_drafted_automatically_without_a_marked_section_a_ticket_or_a_clean_finish() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let unmarked = run_with(&fx, |r| r.result = Some("It is the rounding.".into())).await;
        let empty = run_with(&fx, |r| r.result = Some("For Jira:".into())).await;
        let no_ticket = run_with(&fx, |r| r.item = None).await;
        let failed = run_with(&fx, |r| r.state = RunState::Failed).await;
        let stopped = run_with(&fx, |r| r.state = RunState::Stopped).await;
        for run in [unmarked, empty, no_ticket, failed, stopped] {
            assert_eq!(fx.core.auto_draft_run_comment(&run.id).await.unwrap(), None, "{:?}", run.state);
        }
        assert_eq!(fx.core.auto_draft_run_comment("missing").await.unwrap(), None);
        assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().iter().all(|p| !matches!(p.intent, Intent::Comment { .. })));
    }

    #[tokio::test]
    async fn a_ticketless_run_leaves_one_draft_ticket_in_its_project_marked_as_from_the_run_and_creates_nothing() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        let p = fx.core.auto_draft_run_ticket(&run.id).await.unwrap().unwrap();
        assert_eq!((p.state.clone(), p.created_by), (ProposalState::Pending, CreatedBy::User));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert_eq!(p.label, Some(format!("From agent run {}", run.short_id.as_ref().unwrap())));
        let (container, fields) = create_of(&p);
        assert_eq!(*container, project(&fx).await);
        assert_eq!((fields.title.as_str(), fields.kind, fields.assignee.as_ref(), fields.parent.as_ref(), fields.priority), ("Add a backoff to the order consumer", ItemKind::Bug, None, None, None));
        assert!(fields.labels.is_empty());
        assert_eq!(fields.body.plain_text(), format!("It retries in a tight loop.\n{FOUND_BY}"));
        assert!(fx.tracker.intents().is_empty(), "a draft creates nothing in Jira");

        let outcome = fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!(outcome.ticket_draft, Some(RunDraft { id: p.id.clone(), state: ProposalState::Pending }));
        assert_eq!(outcome.ticket.map(|t| t.title), Some("Add a backoff to the order consumer".into()));
        assert_eq!(outcome.draft, None, "no comment draft: there is no ticket to comment on");
    }

    #[tokio::test]
    async fn a_run_gets_one_ticket_draft_whatever_happens_to_it_and_whoever_asks() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        let first = fx.core.auto_draft_run_ticket(&run.id).await.unwrap().unwrap();
        assert_eq!(fx.core.auto_draft_run_ticket(&run.id).await.unwrap(), None, "waiting");
        let err = fx.core.draft_run_ticket(&run.id).await.unwrap_err().to_string();
        assert!(err.contains(&first.id) && err.contains("waiting for you"), "{err}");

        fx.core.skip_proposal(&first.id).await.unwrap();
        assert_eq!(fx.core.auto_draft_run_ticket(&run.id).await.unwrap(), None, "skipped");
        assert!(fx.core.draft_run_ticket(&run.id).await.unwrap_err().to_string().contains("skipped"));
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().ticket_draft.unwrap().state, ProposalState::Skipped);
        assert_eq!(ticket_drafts_in(&fx).await.len(), 1);
    }

    #[tokio::test]
    async fn two_asks_at_once_make_one_draft() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        let (a, b) = tokio::join!(fx.core.draft_run_ticket(&run.id), fx.core.auto_draft_run_ticket(&run.id));
        assert_eq!([a.is_ok(), b.ok().flatten().is_some()].iter().filter(|made| **made).count(), 1);
        assert_eq!(ticket_drafts_in(&fx).await.len(), 1);
    }

    #[tokio::test]
    async fn no_section_or_no_title_means_no_automatic_draft_and_the_button_seeds_one_from_the_answer() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        for answer in ["The consumer retries in a loop.\nIt never backs off.", "New ticket:\nKind: bug\nNo title here.", "For Jira: only a comment."] {
            let run = ticketless(&fx, answer, |_| {}).await;
            assert_eq!(fx.core.auto_draft_run_ticket(&run.id).await.unwrap(), None, "{answer}");
        }
        assert!(ticket_drafts_in(&fx).await.is_empty());

        let run = ticketless(&fx, "The consumer retries in a loop.\nIt never backs off.", |_| {}).await;
        let p = fx.core.draft_run_ticket(&run.id).await.unwrap();
        let (container, fields) = create_of(&p);
        assert_eq!((fields.title.as_str(), fields.kind, container.clone()), ("The consumer retries in a loop.", ItemKind::Task, project(&fx).await));
        assert!(fields.body.plain_text().starts_with("The consumer retries in a loop.\nIt never backs off."));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
    }

    #[tokio::test]
    async fn only_a_run_that_started_to_end_as_a_ticket_is_drafted_automatically_and_only_when_it_finished_cleanly() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let plain = approved(&fx, RunSpec { instruction: String::new(), ..next_spec(&fx) }, None, TICKET_RESULT, |_| {}).await;
        assert_eq!(fx.core.auto_draft_run_ticket(&plain.id).await.unwrap(), None, "no project was chosen");
        let on_ticket = run_with(&fx, |r| r.result = Some(TICKET_RESULT.into())).await;
        assert_eq!(fx.core.auto_draft_run_ticket(&on_ticket.id).await.unwrap(), None);
        for state in [RunState::Working, RunState::Failed, RunState::Stopped] {
            let run = ticketless(&fx, TICKET_RESULT, |r| r.state = state).await;
            assert_eq!(fx.core.auto_draft_run_ticket(&run.id).await.unwrap(), None, "{state:?}");
        }
        assert_eq!(fx.core.auto_draft_run_ticket("missing").await.unwrap(), None);
        assert!(ticket_drafts_in(&fx).await.is_empty());
    }

    #[tokio::test]
    async fn the_button_refuses_a_run_with_a_ticket_one_that_is_unfinished_or_has_no_answer() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let on_ticket = run_with(&fx, |_| {}).await;
        assert!(fx.core.draft_run_ticket(&on_ticket.id).await.unwrap_err().to_string().contains("about a ticket"));
        let working = ticketless(&fx, TICKET_RESULT, |r| r.state = RunState::Working).await;
        assert!(fx.core.draft_run_ticket(&working.id).await.unwrap_err().to_string().contains("hasn't finished"));
        let blank = ticketless(&fx, " \n", |_| {}).await;
        assert!(fx.core.draft_run_ticket(&blank.id).await.unwrap_err().to_string().contains("nothing to draft"));
        assert!(fx.core.draft_run_ticket("missing").await.is_err());
        assert!(ticket_drafts_in(&fx).await.is_empty());
    }

    #[tokio::test]
    async fn a_project_of_another_connection_is_refused_and_nothing_is_stored() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |r| r.spec.project = Some(ContainerRef { connection_id: "elsewhere".into(), external_id: "x".into() })).await;
        for made in [fx.core.draft_run_ticket(&run.id).await.map(|_| ()), fx.core.auto_draft_run_ticket(&run.id).await.map(|_| ())] {
            assert!(made.unwrap_err().to_string().contains("another connection"));
        }
        assert!(ticket_drafts_in(&fx).await.is_empty());
    }

    #[tokio::test]
    async fn an_older_run_with_no_project_uses_the_repositorys_usual_one_or_says_there_is_none() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = approved(&fx, RunSpec { instruction: String::new(), ..next_spec(&fx) }, None, TICKET_RESULT, |_| {}).await;
        let err = fx.core.draft_run_ticket(&run.id).await.unwrap_err().to_string();
        assert!(err.contains("no project"), "{err}");
        link_repo_to(&fx, &[("CA-1", 4, 9)]).await;
        let p = fx.core.draft_run_ticket(&run.id).await.unwrap();
        assert_eq!(*create_of(&p).0, project(&fx).await);
    }

    async fn link_repo_to(fx: &Fixture, links: &[(&str, u64, u32)]) {
        use chrono::TimeZone;
        let linked: Vec<crate::domain::DevLink> = links
            .iter()
            .map(|(key, number, day)| {
                let mut change = crate::codehost::links::tests::pr(*number, "branch", "T", "");
                change.updated_at = Utc.with_ymd_and_hms(2026, 9, *day, 9, 0, 0).unwrap();
                crate::domain::DevLink { item: fx.item(key), change, provenance: crate::domain::LinkSource::Branch, confidence: 1.0 }
            })
            .collect();
        let changes: Vec<CodeChange> = linked.iter().map(|l| l.change.clone()).collect();
        fx.core.with_code_db("github:ann", |db| {
            db.upsert_code_changes(&changes, "2026-09-29T00:00:00Z")?;
            db.replace_item_links("github:ann", &linked, "2026-09-29T00:00:00Z")
        })
        .unwrap();
    }

    #[tokio::test]
    async fn the_repositorys_usual_project_is_the_watched_one_of_its_newest_linked_pull_request() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        assert_eq!(fx.core.repo_project("acme/webshop").await.unwrap(), None, "nothing is linked yet");
        let ca = project(&fx).await;
        fx.add_in("OTH-5", "oth").await;
        let oth = fx.core.cache_item(&fx.item("OTH-5")).await.unwrap().unwrap().container;
        let containers = fx.core.containers_in(&fx.scope).await.unwrap();
        let mut other = containers[0].clone();
        (other.container_ref, other.key, other.name) = (oth.clone(), "OTH".into(), "Others".into());
        fx.set_containers(&[containers[0].clone(), other]).await;

        link_repo_to(&fx, &[("CA-1", 1, 3), ("OTH-5", 2, 20)]).await;
        assert_eq!(fx.core.repo_project("ACME/webshop").await.unwrap(), Some(oth.clone()));
        link_repo_to(&fx, &[("CA-1", 1, 25), ("OTH-5", 2, 20)]).await;
        assert_eq!(fx.core.repo_project("acme/webshop").await.unwrap(), Some(ca.clone()));
        assert_eq!(fx.core.repo_project("acme/other").await.unwrap(), None);

        fx.set_containers(&[containers[0].clone()]).await;
        link_repo_to(&fx, &[("CA-1", 1, 3), ("OTH-5", 2, 20)]).await;
        assert_eq!(fx.core.repo_project("acme/webshop").await.unwrap(), Some(ca), "a project that isn't there is skipped");
    }

    #[tokio::test]
    async fn approving_the_draft_records_the_created_ticket_on_the_run() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        let p = fx.core.auto_draft_run_ticket(&run.id).await.unwrap().unwrap();
        assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap().created_item, None);
        let made = fx.item("CA-812");
        fx.tracker.will(Ok(crate::tracker::Applied { created: vec![made.clone()], error: None }));
        let done = fx.core.approve_proposal(&p.id).await.unwrap();
        assert_eq!((done.state.clone(), done.created.clone()), (ProposalState::Applied, vec![made.clone()]));
        assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap().created_item, Some(made.clone()));
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().ticket_draft.unwrap().state, ProposalState::Applied);

        let other = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        assert_eq!(fx.core.run(&other.id).await.unwrap().unwrap().created_item, None, "another run is not touched");
    }

    #[tokio::test]
    async fn a_failed_approval_leaves_the_run_without_a_ticket() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        let p = fx.core.auto_draft_run_ticket(&run.id).await.unwrap().unwrap();
        fx.tracker.will(Err(Error::Api { status: 503, message: "down".into() }));
        let failed = fx.core.approve_proposal(&p.id).await.unwrap();
        assert_eq!(failed.state, ProposalState::Pending);
        assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap().created_item, None);
    }

    #[tokio::test]
    async fn reading_the_outcome_catches_up_a_run_whose_approved_ticket_was_never_noted() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = ticketless(&fx, TICKET_RESULT, |_| {}).await;
        let p = fx.core.auto_draft_run_ticket(&run.id).await.unwrap().unwrap();
        let made = fx.item("CA-812");
        fx.tracker.will(Ok(crate::tracker::Applied { created: vec![made.clone()], error: None }));
        fx.core.approve_proposal(&p.id).await.unwrap();
        let mut lost = fx.core.run(&run.id).await.unwrap().unwrap();
        lost.created_item = None;
        fx.core.save_run(&lost).await.unwrap();
        assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap().created_item, None);
        fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!(fx.core.run(&run.id).await.unwrap().unwrap().created_item, Some(made));
    }

    const BREAKDOWN: &str = "Large.\n\nSubtasks:\n- Add a backoff\n- Report the lag\n- Survive a restart\n\nFor Jira:\nA breakdown is proposed.";

    async fn triage_with(fx: &Fixture, result: &str) -> Run {
        approved(fx, RunSpec { kind: RunKind::Triage, ..next_spec(fx) }, Some(fx.item("CA-1")), result, |_| {}).await
    }

    async fn subtask_drafts_in(fx: &Fixture) -> Vec<Proposal> {
        fx.core.proposals(&ProposalQuery::default()).await.unwrap().into_iter().filter(|p| matches!(p.intent, Intent::Subtasks { .. })).collect()
    }

    #[tokio::test]
    async fn a_triage_breakdown_is_drafted_once_as_subtasks_from_the_run_and_nothing_is_created() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = triage_with(&fx, BREAKDOWN).await;
        let p = fx.core.draft_run_subtasks(&run.id).await.unwrap().unwrap();
        assert_eq!((p.state.clone(), p.created_by), (ProposalState::Pending, CreatedBy::User));
        assert_eq!(p.origin, Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string) });
        assert_eq!(p.label, Some(format!("From agent run {}", run.short_id.as_ref().unwrap())));
        assert!(matches!(&p.intent, Intent::Subtasks { parent, summaries } if *parent == fx.item("CA-1") && summaries == &["Add a backoff", "Report the lag", "Survive a restart"]));
        assert!(fx.tracker.intents().is_empty());
        assert!(fx.core.draft_run_subtasks(&run.id).await.unwrap().is_none(), "a second call makes no second draft");
        assert_eq!(subtask_drafts_in(&fx).await.len(), 1);
    }

    #[tokio::test]
    async fn two_callers_at_once_make_one_breakdown_and_a_decided_one_is_never_made_again() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = triage_with(&fx, BREAKDOWN).await;
        let (a, b) = tokio::join!(fx.core.draft_run_subtasks(&run.id), fx.core.draft_run_subtasks(&run.id));
        assert_eq!([a.unwrap(), b.unwrap()].iter().flatten().count(), 1);
        let only = subtask_drafts_in(&fx).await.remove(0);
        fx.core.skip_proposal(&only.id).await.unwrap();
        assert!(fx.core.draft_run_subtasks(&run.id).await.unwrap().is_none());
        assert_eq!(subtask_drafts_in(&fx).await.len(), 1);
        let other = triage_with(&fx, BREAKDOWN).await;
        assert!(fx.core.draft_run_subtasks(&other.id).await.unwrap().is_some(), "another run's breakdown is its own");
    }

    #[tokio::test]
    async fn no_breakdown_for_other_kinds_ticketless_runs_unfinished_runs_or_results_without_the_section() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let investigate = run_with(&fx, |r| r.result = Some(BREAKDOWN.into())).await;
        assert!(fx.core.draft_run_subtasks(&investigate.id).await.unwrap().is_none());
        let fits = triage_with(&fx, "Fits as one piece.\n\nFor Jira: small.").await;
        assert!(fx.core.draft_run_subtasks(&fits.id).await.unwrap().is_none());
        let working = approved(&fx, RunSpec { kind: RunKind::Triage, ..next_spec(&fx) }, Some(fx.item("CA-1")), BREAKDOWN, |r| r.state = RunState::Working).await;
        assert!(fx.core.draft_run_subtasks(&working.id).await.unwrap().is_none());
        assert!(fx.core.draft_run_subtasks("missing").await.unwrap().is_none());
        assert!(subtask_drafts_in(&fx).await.is_empty());
    }

    #[tokio::test]
    async fn the_outcome_names_the_proposed_breakdown_and_its_draft() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = triage_with(&fx, BREAKDOWN).await;
        let before = fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!((before.subtasks.as_slice(), before.subtasks_draft), (["Add a backoff", "Report the lag", "Survive a restart"].map(String::from).as_slice(), None));
        let p = fx.core.draft_run_subtasks(&run.id).await.unwrap().unwrap();
        let after = fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!(after.subtasks_draft, Some(RunDraft { id: p.id, state: ProposalState::Pending }));
        let plain = run_with(&fx, |r| r.result = Some(BREAKDOWN.into())).await;
        assert!(fx.core.run_outcome(&plain.id).await.unwrap().subtasks.is_empty(), "only a Triage proposes a breakdown");
    }
}
