//! The description update a finished Plan run leaves: the ticket's description with a `Gossamr Plan` section added, or
//! replaced when the ticket already has one. Assembled here from the run's own answer, never by a model, and stored
//! against the description it was written from so an approval can tell when the ticket moved on.

use chrono::Utc;
use serde::Serialize;

use super::run_results::{label_of, RunDraft};
use super::{ticket_of, Core};
use crate::model::CachedTicket;
use crate::domain::{Basis, BodyChange, CreatedBy, Doc, Intent, ItemRef, Origin, Proposal, ProposalQuery, ProposalState, Run, RunKind, RunState, WorkItem, DESCRIPTION_LIMIT, PLAN_HEADING, PLAN_LIMIT};
use crate::error::{Error, Result};
use crate::proposals::{self, Draft};
use crate::runs::result::{fit, plan_without_note};
use crate::tracker::{self, Connection};

/// Below this much room the plan would be cut to a stub, which helps nobody; the comment path takes the whole plan.
const MIN_PLAN_ROOM: usize = 1_000;

const NO_EDIT: &str = "This tracker can't change a ticket's description, so the plan can only go to the ticket as a comment.";

/// What the sheet shows about a Plan run's description update.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDescription {
    /// The draft made from this run, in whatever state it is now.
    pub draft: Option<RunDraft>,
    /// Why there is none and none can be made; the plan can still go to the ticket as a comment.
    pub unavailable: Option<String>,
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

/// How the intro paragraph `intro` writes starts. An approved section is matched by this, not by the whole sentence, so
/// a draft written on another day or before the run had a short id is still recognised.
const INTRO_START: &str = "Drafted by an agent run";

fn intro(run: &Run) -> String {
    let date = run.ended_at.unwrap_or(run.queued_at).format("%Y-%m-%d");
    let which = run.short_id.as_ref().map(|s| format!(" ({s})")).unwrap_or_default();
    format!("Drafted by an agent run{which} on {date}. A person read and approved it in Gossamr before it was added here.")
}

/// The description with the plan in its `Gossamr Plan` section, and whether the plan had to be cut to fit. The
/// description can hold 30,000 characters in all, so what the rest of it leaves is what the plan gets.
fn assemble(run: &Run, body: &Doc, plan: &str) -> std::result::Result<(Doc, bool), String> {
    let intro = intro(run);
    let rest = body.without_plan_section().to_markdown().chars().count();
    let overhead = PLAN_HEADING.len() + intro.chars().count() + 64;
    let which = run.short_id.as_ref().map_or_else(|| run.id.clone(), ToString::to_string);
    let mut room = PLAN_LIMIT.min(DESCRIPTION_LIMIT.saturating_sub(rest + overhead));
    for _ in 0..4 {
        if room < MIN_PLAN_ROOM {
            break;
        }
        let fitted = fit(plan, room, |total| format!("[Cut here. The plan was {total} characters and this section holds {room}. The whole of it is in agent run {which}.]"));
        let to = body.with_plan_section(&intro, &Doc::from_markdown(&fitted.text, &[]));
        let size = to.to_markdown().chars().count();
        if size <= DESCRIPTION_LIMIT {
            return Ok((to, fitted.cut));
        }
        room = room.saturating_sub(size - DESCRIPTION_LIMIT + 100);
    }
    Err(format!("The description is too long to add a plan to: Jira holds {DESCRIPTION_LIMIT} characters in all. Post the plan as a comment instead."))
}

/// The cached ticket, its description and the description with the plan in it, or why that can't be done.
fn prepare(run: &Run, item: &ItemRef, work: Option<WorkItem>, plan: &str) -> std::result::Result<(WorkItem, CachedTicket, Doc), String> {
    let work = work.ok_or_else(|| format!("{} isn't in the cache, so Gossamr can't read its description. Open the ticket so it refreshes.", item.key))?;
    let ticket = ticket_of(&work).map_err(|_| format!("{} hasn't been read in full yet. Open the ticket so it refreshes.", item.key))?;
    if work.body.blocks.is_empty() && !ticket.description.trim().is_empty() {
        return Err(format!("{}'s description is stored as plain text, which Gossamr can't edit yet. Open the ticket so it refreshes, or post the plan as a comment.", item.key));
    }
    let (to, _) = assemble(run, &work.body, plan)?;
    Ok((work, ticket, to))
}

fn is_plan_rewrite(p: &Proposal) -> bool {
    matches!(&p.intent, Intent::Rewrite { body: Some(b), .. } if b.to.plan_section().is_some())
}

fn from_run(p: &Proposal, run_id: &str) -> bool {
    matches!(&p.origin, Origin::Run { run_id: r, .. } if r == run_id) && is_plan_rewrite(p)
}

/// The `Gossamr Plan` section a description draft ends with, as Markdown, without the intro paragraph Gossamr put at its
/// top. Empty when nothing but the intro is left.
fn plan_text_of(p: &Proposal) -> Option<String> {
    let Intent::Rewrite { body: Some(b), .. } = &p.intent else { return None };
    let mut section = b.to.plan_section()?;
    let first = section.blocks.first().map(|b| Doc { blocks: vec![b.clone()] }.plain_text());
    if first.is_some_and(|text| text.trim_start().starts_with(INTRO_START)) {
        section.blocks.remove(0);
    }
    Some(section.to_markdown().trim().to_string())
}

fn section_of(p: &Proposal) -> Option<String> {
    match &p.intent {
        Intent::Rewrite { body: Some(b), .. } => b.to.plan_section().map(|s| s.to_markdown()),
        _ => None,
    }
}

enum Made {
    Draft(Box<Proposal>),
    /// Nothing to make, and why.
    Gap(String),
    /// The ticket already has this plan, or a draft for it is waiting or was decided.
    Have,
}

impl Core {
    async fn plan_description_for(&self, id: &str) -> Result<(Run, ItemRef, String)> {
        let run = self.run(id).await?.ok_or_else(|| refuse("that run no longer exists"))?;
        if run.spec.kind != RunKind::Plan {
            return Err(refuse("only a plan run has a plan to add to a description"));
        }
        if run.state != RunState::Done {
            return Err(refuse("that run hasn't finished"));
        }
        let item = run.item.clone().ok_or_else(|| refuse("that run isn't about a ticket"))?;
        let resolved = self.resolved_of(&run).await?;
        let plan = match resolved.plan.clone() {
            Some(plan) => plan,
            None if resolved.complete() => plan_without_note(run.result.as_deref().unwrap_or("")),
            None => return Err(refuse(format!("{} There is no plan to add.", super::SUMMARY_ONLY))),
        };
        if plan.is_empty() {
            return Err(refuse("the run finished without a written answer, so there is no plan to add"));
        }
        Ok((run, item, plan))
    }

    /// Makes the one description draft of `run`, or says why not. Looking and storing happen under one lock, so two
    /// callers can't both make one. A pending draft from an earlier plan, this run's or another's, is retired when a
    /// new one replaces it, except one the person edited: that stays, and no second draft is made beside it. `manual` is the person asking: a draft they skipped may be made again.
    async fn make_plan_description(&self, run: &Run, item: &ItemRef, plan: &str, manual: bool) -> Result<Made> {
        let scope = self.scope().await?;
        if item.connection_id != Connection::jira_id(&scope) {
            return Err(refuse("that item belongs to another connection"));
        }
        if !self.can_edit_text(&scope)? {
            return Ok(Made::Gap(NO_EDIT.into()));
        }
        self.with_db_for(&scope, |db| {
            let (work, ticket, to) = match prepare(run, item, db.item(item)?, plan) {
                Ok(ready) => ready,
                Err(why) => return Ok(Made::Gap(why)),
            };
            if to.to_markdown() == work.body.to_markdown() {
                return Ok(Made::Have);
            }
            let found = db.proposals(&ProposalQuery { item: Some(item.clone()), ..Default::default() })?;
            let section = to.plan_section().map(|s| s.to_markdown());
            let current = |p: &Proposal| matches!(&p.intent, Intent::Rewrite { body: Some(b), .. } if b.from == work.body);
            let same = |p: &Proposal| from_run(p, &run.id) && section_of(p) == section;
            let decided_same = found.iter().any(|p| same(p) && p.state != ProposalState::Pending && (!manual || p.state == ProposalState::Applied));
            let waiting_same = found.iter().any(|p| same(p) && p.state == ProposalState::Pending && current(p));
            if decided_same || waiting_same {
                return Ok(Made::Have);
            }
            let waiting = |p: &&Proposal| p.state == ProposalState::Pending && is_plan_rewrite(p) && matches!(p.origin, Origin::Run { .. });
            if let Some(edited) = found.iter().filter(waiting).find(|p| proposals::person_edited_rewrite(p)) {
                return Ok(Made::Gap(format!("A description update you edited is already waiting on {} (draft {}). Approve or skip it, then draft the plan again.", item.key, edited.id)));
            }
            let at = Utc::now();
            for older in found.iter().filter(waiting) {
                proposals::retire(db, &older.id, "replaced by a newer plan", at)?;
            }
            let flattened = tracker::flattened_by_rewrite(&Connection::jira(&scope, ""), &ticket);
            let intent = Intent::Rewrite { item: item.clone(), title: None, body: Some(BodyChange { from: work.body.clone(), to }), flattened };
            let draft = Draft {
                origin: Origin::of_run(run),
                created_by: CreatedBy::Agent,
                intent,
                label: Some(label_of(run)),
                basis: Some(Basis::of(&work)),
            };
            Ok(Made::Draft(Box::new(proposals::create(db, draft, at)?)))
        })
        .await
    }

    /// The description update a finished Plan run leaves, made when it finishes. `None` when the run isn't a Plan on a
    /// ticket with a plan in full, when the description can't be edited, or when this plan already has a draft.
    pub async fn auto_draft_run_plan_description(&self, id: &str) -> Result<Option<Proposal>> {
        let Ok((run, item, plan)) = self.plan_description_for(id).await else { return Ok(None) };
        Ok(match self.make_plan_description(&run, &item, &plan, false).await? {
            Made::Draft(p) => Some(*p),
            Made::Gap(_) | Made::Have => None,
        })
    }

    /// The same draft, made when the person asks for it.
    pub async fn draft_run_plan_description(&self, id: &str) -> Result<Proposal> {
        let (run, item, plan) = self.plan_description_for(id).await?;
        match self.make_plan_description(&run, &item, &plan, true).await? {
            Made::Draft(p) => Ok(*p),
            Made::Gap(why) => Err(refuse(why)),
            Made::Have => Err(refuse(format!("{} already has this plan, or a draft of it is waiting", item.key))),
        }
    }

    /// What the run sheet shows: the draft this run made, or what stops one.
    pub(super) async fn plan_description_of(&self, run: &Run) -> Result<Option<PlanDescription>> {
        let Some(item) = run.item.clone().filter(|_| run.spec.kind == RunKind::Plan && run.state == RunState::Done) else { return Ok(None) };
        let found = self.proposals(&ProposalQuery { item: Some(item.clone()), ..Default::default() }).await?;
        let draft = found.into_iter().find(|p| from_run(p, &run.id)).map(|p| RunDraft { id: p.id, state: p.state });
        let unavailable = match (&draft, self.resolved_of(run).await?.complete()) {
            (None, true) => match self.plan_description_for(&run.id).await {
                Ok((run, item, plan)) => self.probe_plan_description(&run, &item, &plan).await?,
                Err(_) => None,
            },
            _ => None,
        };
        Ok(Some(PlanDescription { draft, unavailable }))
    }

    /// The plan as the person settled it on the ticket: the newest description draft from `run` that was applied, with
    /// the edits the person made before approving it and without Gossamr's intro paragraph. `None` when no such draft
    /// was applied, so a build falls back to the run's own answer. Waiting, skipped, retired and failed drafts don't count.
    pub(super) async fn approved_plan_of(&self, run: &Run) -> Result<Option<String>> {
        let Some(item) = run.item.clone() else { return Ok(None) };
        let found = self.proposals(&ProposalQuery { item: Some(item), ..Default::default() }).await?;
        let newest = found.into_iter().filter(|p| from_run(p, &run.id) && p.state == ProposalState::Applied).max_by_key(|p| (p.updated_at, p.created_at));
        Ok(newest.and_then(|p| plan_text_of(&p)).filter(|text| !text.is_empty()))
    }

    /// Why a description draft can't be made now, without making one.
    async fn probe_plan_description(&self, run: &Run, item: &ItemRef, plan: &str) -> Result<Option<String>> {
        let scope = self.scope().await?;
        if item.connection_id != Connection::jira_id(&scope) {
            return Ok(Some("That ticket belongs to another connection.".into()));
        }
        if !self.can_edit_text(&scope)? {
            return Ok(Some(NO_EDIT.into()));
        }
        self.with_db_for(&scope, |db| Ok(prepare(run, item, db.item(item)?, plan).err())).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::run_results::tests::{approved, next_spec, plan_with, PLAN};
    use crate::inbox::testing::{fixture_watching, Fixture};
    use crate::inbox::Edit;

    fn rewrite_of(p: &Proposal) -> (&Doc, &Doc) {
        match &p.intent {
            Intent::Rewrite { body: Some(b), title: None, .. } => (&b.from, &b.to),
            other => panic!("{other:?}"),
        }
    }

    async fn rewrites(fx: &Fixture) -> Vec<Proposal> {
        fx.core.proposals(&ProposalQuery::default()).await.unwrap().into_iter().filter(|p| matches!(p.intent, Intent::Rewrite { .. })).collect()
    }

    async fn describe(fx: &Fixture, markdown: &str) {
        let doc = Doc::from_markdown(markdown, &[]);
        fx.edit_item("CA-1", |item| item.body = doc).await;
    }

    #[tokio::test]
    async fn a_finished_plan_leaves_the_description_with_a_gossamr_plan_section_and_the_status_comment_too() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = plan_with(&fx, PLAN).await;
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        assert_eq!((made.created_by, made.state.clone()), (CreatedBy::Agent, ProposalState::Pending));
        assert_eq!(made.origin, Origin::of_run(&run));
        assert_eq!(made.label, Some(format!("From agent run {}", run.short_id.as_ref().unwrap())));
        assert!(made.basis.is_some());
        let (from, to) = rewrite_of(&made);
        assert_eq!(from.to_markdown(), "Hi");
        let date = run.ended_at.unwrap().format("%Y-%m-%d");
        assert_eq!(
            to.to_markdown(),
            format!(
                "Hi\n\n## Gossamr Plan\n\nDrafted by an agent run ({}) on {date}. A person read and approved it in Gossamr before it was added here.\n\n### Approach\n\nRound in one place.\n\n### Files\n\n- src/cart.rs\n\n### Steps\n\n1. Fix the rounding.\n2. Add a test.",
                run.short_id.as_ref().unwrap()
            )
        );
        assert!(!to.to_markdown().contains("For Jira"), "the closing note goes to the ticket on its own");
        assert!(fx.tracker.intents().is_empty(), "a draft writes nothing");
        let status = fx.core.auto_draft_run_comment(&run.id).await.unwrap();
        assert!(status.is_some(), "the status comment is still drafted");
    }

    #[tokio::test]
    async fn drafting_twice_makes_one_and_the_outcome_names_it() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = plan_with(&fx, PLAN).await;
        let first = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none());
        assert!(fx.core.draft_run_plan_description(&run.id).await.unwrap_err().to_string().contains("already has this plan"));
        assert_eq!(rewrites(&fx).await.len(), 1);
        let outcome = fx.core.run_outcome(&run.id).await.unwrap();
        assert_eq!(outcome.plan_description, Some(PlanDescription { draft: Some(RunDraft { id: first.id.clone(), state: ProposalState::Pending }), unavailable: None }));
        fx.core.skip_proposal(&first.id).await.unwrap();
        assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none(), "a skipped draft is not made again on its own");
        assert_eq!(rewrites(&fx).await.len(), 1);
        assert!(fx.core.draft_run_plan_description(&run.id).await.is_ok(), "the person may ask again");
    }

    #[tokio::test]
    async fn a_second_plan_replaces_the_section_and_retires_the_draft_it_makes_stale() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        describe(&fx, "Intro\n\n## Gossamr Plan\n\nOld plan.\n\n## Notes\n\nKeep me.").await;
        let first = plan_with(&fx, "1. First idea.").await;
        let one = fx.core.auto_draft_run_plan_description(&first.id).await.unwrap().unwrap();
        let second = plan_with(&fx, "1. Better idea.").await;
        let two = fx.core.auto_draft_run_plan_description(&second.id).await.unwrap().unwrap();
        let (_, to) = rewrite_of(&two);
        let md = to.to_markdown();
        assert_eq!(md.matches("Gossamr Plan").count(), 1, "{md}");
        assert!(md.starts_with("Intro\n\n## Gossamr Plan\n\nDrafted by an agent run") && md.contains("1. Better idea.") && md.ends_with("## Notes\n\nKeep me."), "{md}");
        assert!(!md.contains("Old plan") && !md.contains("First idea"));
        let now = fx.core.proposal(&one.id).await.unwrap().unwrap();
        assert!(matches!(now.state, ProposalState::Retired(_)), "{:?}", now.state);
    }

    #[tokio::test]
    async fn a_continued_run_that_plans_again_replaces_its_waiting_draft() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let mut run = plan_with(&fx, "1. First idea.").await;
        let one = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        run.result = Some("1. Second idea.".into());
        fx.core.save_run(&run).await.unwrap();
        let two = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        assert_ne!(one.id, two.id);
        assert!(matches!(fx.core.proposal(&one.id).await.unwrap().unwrap().state, ProposalState::Retired(_)));
        assert_eq!(rewrites(&fx).await.iter().filter(|p| p.state == ProposalState::Pending).count(), 1);
    }

    #[tokio::test]
    async fn a_description_update_the_person_edited_is_kept_and_no_second_one_is_made_beside_it() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let mut run = plan_with(&fx, "1. First idea.").await;
        let first = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        let edited = fx.core.edit_proposal(&first.id, &Edit::Rewrite { title: None, body: Some("Hi\n\n## Gossamr Plan\n\nThe person's own words.".into()) }).await.unwrap();
        run.result = Some("1. Second idea.".into());
        fx.core.save_run(&run).await.unwrap();
        assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none());
        let why = fx.core.draft_run_plan_description(&run.id).await.unwrap_err().to_string();
        assert!(why.contains("you edited") && why.contains(&first.id), "{why}");
        let later = plan_with(&fx, "1. Another run's idea.").await;
        assert!(fx.core.auto_draft_run_plan_description(&later.id).await.unwrap().is_none(), "another run's plan doesn't replace it either");
        let kept = fx.core.proposal(&first.id).await.unwrap().unwrap();
        assert_eq!((kept.state.clone(), kept.intent.clone()), (ProposalState::Pending, edited.intent));
        assert_eq!(rewrites(&fx).await.len(), 1);
        assert_eq!(fx.core.run_outcome(&run.id).await.unwrap().plan_description.unwrap().draft.map(|d| d.id), Some(first.id.clone()));

        fx.core.skip_proposal(&first.id).await.unwrap();
        let fresh = fx.core.auto_draft_run_plan_description(&later.id).await.unwrap().unwrap();
        assert!(rewrite_of(&fresh).1.to_markdown().contains("Another run's idea."), "once the edited draft is decided the newer plan is drafted");
    }

    #[tokio::test]
    async fn an_unedited_waiting_draft_is_replaced_by_a_newer_plan_but_a_decided_one_is_left_alone() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let first_run = plan_with(&fx, "1. First idea.").await;
        let one = fx.core.auto_draft_run_plan_description(&first_run.id).await.unwrap().unwrap();
        fx.core.skip_proposal(&one.id).await.unwrap();
        let second_run = plan_with(&fx, "1. Second idea.").await;
        let two = fx.core.auto_draft_run_plan_description(&second_run.id).await.unwrap().unwrap();
        let third_run = plan_with(&fx, "1. Third idea.").await;
        let three = fx.core.auto_draft_run_plan_description(&third_run.id).await.unwrap().unwrap();
        let state = |id: &str| {
            let core = &fx.core;
            let id = id.to_string();
            async move { core.proposal(&id).await.unwrap().unwrap().state }
        };
        assert_eq!(state(&one.id).await, ProposalState::Skipped);
        assert!(matches!(state(&two.id).await, ProposalState::Retired(_)));
        assert_eq!(state(&three.id).await, ProposalState::Pending);
    }

    #[tokio::test]
    async fn the_plan_is_cut_to_what_the_description_has_room_for_and_the_note_names_the_run() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        describe(&fx, &format!("{}\n\nEnd.", "Some long background sentence here. ".repeat(500))).await;
        let long = format!("{}\n\nFor Jira:\nNote.", "Step: change the consumer. ".repeat(1_500));
        let run = plan_with(&fx, &long).await;
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        let (from, to) = rewrite_of(&made);
        let md = to.to_markdown();
        assert!(md.chars().count() <= DESCRIPTION_LIMIT, "{}", md.chars().count());
        let section = to.plan_section().unwrap().plain_text();
        assert!(section.chars().count() <= PLAN_LIMIT, "{}", section.chars().count());
        let (kept, note) = section.split_once("[Cut here.").unwrap();
        assert!(kept.trim_end().ends_with("change the consumer.") && note.contains(&format!("agent run {}", run.short_id.as_ref().unwrap())), "{note}");
        assert_eq!(from.to_markdown(), to.without_plan_section().to_markdown(), "the rest of the description is untouched");
    }

    #[tokio::test]
    async fn a_description_with_no_room_makes_no_draft_and_the_sheet_says_why() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        describe(&fx, &"A background sentence that fills the description. ".repeat(600)).await;
        let run = plan_with(&fx, PLAN).await;
        assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none());
        let why = fx.core.run_outcome(&run.id).await.unwrap().plan_description.unwrap().unavailable.unwrap();
        assert!(why.contains("too long") && why.contains("comment"), "{why}");
        assert!(fx.core.draft_run_plan_description(&run.id).await.unwrap_err().to_string().contains("too long"));
        assert!(fx.core.draft_run_plan_comment(&run.id).await.is_ok(), "the comment path stays");
    }

    #[tokio::test]
    async fn a_tracker_that_cannot_edit_text_or_a_plain_text_description_falls_back_to_the_comment() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = plan_with(&fx, PLAN).await;
        fx.tracker.cannot_edit_text.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none());
        let why = fx.core.run_outcome(&run.id).await.unwrap().plan_description.unwrap().unavailable.unwrap();
        assert!(why.contains("can't change a ticket's description") && why.contains("comment"), "{why}");
        fx.tracker.cannot_edit_text.store(false, std::sync::atomic::Ordering::SeqCst);

        fx.edit_item("CA-1", |item| item.body = Doc::default()).await;
        let why = fx.core.run_outcome(&run.id).await.unwrap().plan_description.unwrap().unavailable.unwrap();
        assert!(why.contains("stored as plain text"), "{why}");
        assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none());
        assert!(fx.core.draft_run_plan_comment(&run.id).await.is_ok());
        assert!(rewrites(&fx).await.is_empty());
    }

    #[tokio::test]
    async fn only_a_complete_finished_plan_run_on_a_ticket_makes_one() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let triage = approved(&fx, crate::domain::RunSpec { kind: RunKind::Triage, ..next_spec(&fx) }, Some(fx.item("CA-1")), PLAN, |_| {}).await;
        let working = approved(&fx, crate::domain::RunSpec { kind: RunKind::Plan, ..next_spec(&fx) }, Some(fx.item("CA-1")), PLAN, |r| r.state = RunState::Working).await;
        let summary = approved(&fx, crate::domain::RunSpec { kind: RunKind::Plan, ..next_spec(&fx) }, Some(fx.item("CA-1")), "One line.", |r| r.result_complete = false).await;
        let only_note = plan_with(&fx, "For Jira:\nJust a note.").await;
        for run in [&triage, &working, &summary] {
            assert!(fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().is_none(), "{:?}", run.spec.kind);
            assert!(fx.core.draft_run_plan_description(&run.id).await.is_err());
        }
        assert!(fx.core.run_outcome(&triage.id).await.unwrap().plan_description.is_none());
        assert!(fx.core.auto_draft_run_plan_description("missing").await.unwrap().is_none());
        let from_note = fx.core.auto_draft_run_plan_description(&only_note.id).await.unwrap().unwrap();
        assert!(rewrite_of(&from_note).1.to_markdown().contains("Just a note."));
    }

    #[tokio::test]
    async fn approving_writes_the_description_and_a_ticket_that_moved_on_is_left_alone() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = plan_with(&fx, PLAN).await;
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        let (from, _) = rewrite_of(&made);
        *fx.tracker.live.lock().unwrap() = Some({
            let mut live = fx.core.with_db_for(&fx.scope, |db| db.item(&fx.item("CA-1"))).await.unwrap().unwrap();
            live.body = Doc::paragraph("A colleague rewrote this");
            live
        });
        let stale = fx.core.approve_proposal(&made.id).await.unwrap();
        assert!(stale.error.as_deref().is_some_and(|e| e.contains("changed since this was drafted")), "{:?}", stale.error);
        assert_ne!(*from, Doc::paragraph("A colleague rewrote this"));
        assert!(fx.tracker.intents().is_empty());

        *fx.tracker.live.lock().unwrap() = None;
        let done = fx.core.approve_proposal(&made.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert!(matches!(fx.tracker.intents().last(), Some(Intent::Rewrite { .. })));
    }

    #[tokio::test]
    async fn the_person_edits_it_but_pip_may_revise_only_before_that_and_never_what_it_was_drafted_against() {
        use crate::proposals::require_pip_may_revise;
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = plan_with(&fx, PLAN).await;
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        require_pip_may_revise(&made, None).unwrap();
        let revised = fx.core.revise_as_pip(&fx.scope, None, &made.id, {
            let (from, _) = rewrite_of(&made);
            Intent::Rewrite { item: fx.item("CA-1"), title: None, body: Some(BodyChange { from: from.clone(), to: Doc::from_markdown("Hi\n\n## Gossamr Plan\n\nPip's tighter plan.", &[]) }), flattened: vec![] }
        }).await.unwrap();
        assert_eq!(revised.revisions.last().unwrap().note, "Revised by Pip");
        let edited = fx.core.edit_proposal(&made.id, &Edit::Rewrite { title: None, body: Some("Hi\n\n## Gossamr Plan\n\nThe person's words.".into()) }).await.unwrap();
        assert!(require_pip_may_revise(&edited, None).unwrap_err().to_string().contains("edited this description draft"));
    }

    #[tokio::test]
    async fn a_build_that_carries_the_plan_is_not_shown_the_ticket_copy_of_it_but_a_verify_or_review_is() {
        use crate::domain::RunSpec;
        let fx = fixture_watching(&["acme/webshop"]).await;
        let plan = plan_with(&fx, PLAN).await;
        let made = fx.core.auto_draft_run_plan_description(&plan.id).await.unwrap().unwrap();
        let Intent::Rewrite { body: Some(b), .. } = &made.intent else { panic!() };
        fx.edit_item("CA-1", |item| item.body = b.to.clone()).await;
        let block_of = |p: &Proposal| match &p.intent {
            Intent::StartRun { spec, .. } => spec.ticket_block.clone().unwrap(),
            other => panic!("{other:?}"),
        };
        let build = fx.core.draft_run(RunSpec { kind: RunKind::Build, instruction: String::new(), plan_from_run: Some(plan.id.clone()), ..next_spec(&fx) }, Some(fx.item("CA-1"))).await.unwrap();
        let block = block_of(&build);
        assert!(block.contains("Gossamr Plan: left out here") && !block.contains("Round in one place."), "{block}");
        let verify = fx.core.draft_run(RunSpec { kind: RunKind::Verify, instruction: String::new(), ..next_spec(&fx) }, Some(fx.item("CA-1"))).await.unwrap();
        let block = block_of(&verify);
        assert!(block.contains("Gossamr Plan (the agreed plan") && block.contains("Round in one place.") && block.contains("1. Fix the rounding."), "{block}");
        let review = fx.core.runs_review(&build.id).await.unwrap();
        assert!(review.ticket_block.as_deref().unwrap().contains("left out here") && review.prompt.matches("Round in one place.").count() == 1, "one copy of the plan in the prompt");
    }

    #[tokio::test]
    async fn only_an_applied_draft_is_the_settled_plan_and_one_left_with_only_the_intro_is_none() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = plan_with(&fx, PLAN).await;
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        assert_eq!(fx.core.approved_plan_of(&run).await.unwrap(), None, "a waiting draft isn't settled");
        let (_, to) = rewrite_of(&made);
        let intro_only = format!("Hi\n\n## Gossamr Plan\n\n{}", to.plan_section().unwrap().blocks.first().map(|b| Doc { blocks: vec![b.clone()] }.to_markdown()).unwrap());
        fx.core.edit_proposal(&made.id, &Edit::Rewrite { title: None, body: Some(intro_only) }).await.unwrap();
        assert_eq!(fx.core.approve_proposal(&made.id).await.unwrap().state, ProposalState::Applied);
        assert_eq!(fx.core.approved_plan_of(&run).await.unwrap(), None, "nothing but the intro is no plan");

        let other = plan_with(&fx, "1. Another idea.").await;
        let next = fx.core.auto_draft_run_plan_description(&other.id).await.unwrap().unwrap();
        assert_eq!(fx.core.approve_proposal(&next.id).await.unwrap().state, ProposalState::Applied);
        assert_eq!(fx.core.approved_plan_of(&other).await.unwrap().as_deref(), Some("1. Another idea."));
        assert_eq!(fx.core.approved_plan_of(&run).await.unwrap(), None, "another run's draft is not this run's plan");
    }

    #[tokio::test]
    async fn the_loss_warning_travels_with_a_description_that_has_images_or_tables() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let key = fx.item("CA-1");
        let mut item = fx.core.with_db_for(&fx.scope, |db| db.item(&key)).await.unwrap().unwrap();
        let mut ticket: crate::model::CachedTicket = serde_json::from_value(item.extra.clone()).unwrap();
        let doc = serde_json::json!({ "type": "doc", "version": 1, "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "See table" }] },
            { "type": "table", "content": [] }
        ] });
        ticket.description_doc = Some(doc);
        item.body = crate::tracker::item_from_ticket(&fx.core.connection(&fx.scope).unwrap(), &ticket).body;
        item.extra = serde_json::to_value(&ticket).unwrap();
        fx.core.with_db_for(&fx.scope, |db| db.upsert_items(&[item], "2026-09-29T13:00:00Z").map(|_| ())).await.unwrap();
        let run = plan_with(&fx, PLAN).await;
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        let Intent::Rewrite { flattened, .. } = &made.intent else { panic!() };
        assert!(!flattened.is_empty(), "the tables are named so the person is told before approving");
    }

    #[tokio::test]
    async fn the_description_update_of_a_plan_in_a_workstream_is_the_agent_s_in_that_workstream() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let ws = fx.core.open_workstream(&fx.scope, Some(fx.item("CA-1")), None).await.unwrap();
        let run = plan_with(&fx, PLAN).await;
        let mut linked = run.clone();
        linked.spec.workstream = Some(ws.id.clone());
        fx.core.save_run(&linked).await.unwrap();
        let made = fx.core.auto_draft_run_plan_description(&run.id).await.unwrap().unwrap();
        assert_eq!((made.created_by, made.workstream()), (CreatedBy::Agent, Some(ws.id.as_str())));
        assert!(crate::proposals::require_pip_may_revise(&made, Some(&ws.id)).is_ok());
        assert!(crate::proposals::require_pip_may_revise(&made, Some("other")).is_err());
    }
}
