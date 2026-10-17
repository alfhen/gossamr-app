//! The description update a finished Triage leaves: the ticket's description with a `Triage` section holding the
//! Triage's note and the questions it left open, added or replaced when the ticket already has one. It stands where the
//! note used to go to the ticket as a comment, so the open questions sit in the description for the person to approve.
//! Assembled here from the run's own answer, never by a model, and stored against the description it was written from
//! so an approval can tell when the ticket moved on.

use chrono::Utc;

use super::run_results::label_of;
use super::{ticket_of, Core};
use crate::domain::{Basis, BodyChange, CreatedBy, Intent, ItemRef, Origin, Proposal, ProposalQuery, ProposalState, Run, RunKind, RunState, DESCRIPTION_LIMIT};
use crate::error::Result;
use crate::proposals::{self, Draft};
use crate::tracker::{self, Connection};

/// What a Triage's description draft is made of: the note it wrote for the ticket and the questions it left open.
struct Section {
    note: String,
    questions: Vec<String>,
}

enum Made {
    Draft(Box<Proposal>),
    /// The description can't take the update, so the note goes to the ticket as a comment instead.
    Gap,
    /// Nothing to make: the run has a draft already, the ticket already says this, or the person's own edit is waiting.
    Have,
}

fn from_run(p: &Proposal, run_id: &str) -> bool {
    matches!(&p.origin, Origin::Run { run_id: r, .. } if r == run_id) && p.is_triage_description()
}

impl Core {
    /// The description update a finished Triage on a ticket leaves, made when it finishes; the note as a comment when the
    /// description can't take it (the tracker can't edit text, the description is stored as plain text, or it would be
    /// over Jira's limit). `None` when the run isn't a Triage on a ticket, is not complete, has neither a `For Jira:`
    /// note nor open questions, or already has a draft in any state. An older pending Triage draft on the ticket is
    /// retired when this one replaces it, except one the person edited: that stays, and no second is made beside it.
    pub async fn auto_draft_run_triage(&self, id: &str) -> Result<Option<Proposal>> {
        let Some(run) = self.run(id).await? else { return Ok(None) };
        let (RunKind::Triage, RunState::Done, Some(item)) = (run.spec.kind, run.state, run.item.clone()) else { return self.auto_draft_run_comment(id).await };
        let resolved = self.resolved_of(&run).await?;
        let questions = resolved.readiness.as_ref().filter(|r| !r.ready).map(|r| r.questions.clone()).unwrap_or_default();
        let note = resolved.note.clone().filter(|n| n.from_marker && !n.text.is_empty()).map(|n| n.text).unwrap_or_default();
        if !resolved.complete() || (note.is_empty() && questions.is_empty()) {
            return Ok(None);
        }
        if !self.comment_drafts_of(&run).await?.is_empty() {
            return Ok(None);
        }
        match self.make_triage_description(&run, &item, Section { note, questions }).await? {
            Made::Draft(p) => Ok(Some(*p)),
            Made::Have => Ok(None),
            Made::Gap => self.auto_draft_run_comment(id).await,
        }
    }

    async fn make_triage_description(&self, run: &Run, item: &ItemRef, section: Section) -> Result<Made> {
        let scope = self.scope().await?;
        if item.connection_id != Connection::jira_id(&scope) || !self.can_edit_text(&scope)? {
            return Ok(Made::Gap);
        }
        self.with_db_for(&scope, |db| {
            let Some(work) = db.item(item)? else { return Ok(Made::Gap) };
            let Ok(ticket) = ticket_of(&work) else { return Ok(Made::Gap) };
            if work.body.blocks.is_empty() && !ticket.description.trim().is_empty() {
                return Ok(Made::Gap);
            }
            let to = work.body.with_triage_section(&section.note, &section.questions);
            if to.to_markdown().chars().count() > DESCRIPTION_LIMIT {
                return Ok(Made::Gap);
            }
            let found = db.proposals(&ProposalQuery { item: Some(item.clone()), ..Default::default() })?;
            if found.iter().any(|p| from_run(p, &run.id)) || to.to_markdown() == work.body.to_markdown() {
                return Ok(Made::Have);
            }
            let waiting = |p: &&Proposal| p.state == ProposalState::Pending && p.is_triage_description() && matches!(p.origin, Origin::Run { .. });
            if found.iter().filter(waiting).any(proposals::person_edited_rewrite) {
                return Ok(Made::Have);
            }
            let at = Utc::now();
            for older in found.iter().filter(waiting) {
                proposals::retire(db, &older.id, "replaced by a newer triage", at)?;
            }
            let flattened = tracker::flattened_by_rewrite(&Connection::jira(&scope, ""), &ticket);
            let intent = Intent::Rewrite { item: item.clone(), title: None, body: Some(BodyChange { from: work.body.clone(), to }), flattened };
            let draft = Draft { origin: Origin::of_run(run), created_by: CreatedBy::Agent, intent, label: Some(label_of(run)), basis: Some(Basis::of(&work)) };
            Ok(Made::Draft(Box::new(proposals::create(db, draft, at)?)))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Doc;
    use crate::inbox::run_results::tests::{approved, next_spec, plan_with, PLAN};
    use crate::inbox::testing::{fixture_watching, Fixture};
    use crate::inbox::Edit;

    const NOT_READY: &str = "About a week.\n\nReady to plan: no\nOpen questions:\n- What does done look like?\n- Who is waiting on it?\n\nFor Jira:\nThe ticket cannot be sized yet: the description is one line.";
    const READY: &str = "A day.\n\nReady to plan: yes\n\nFor Jira:\nSize: 3 points (about a day). The answers in the ticket's comments were used, so no questions are open.";

    async fn triage_with(fx: &Fixture, result: &str) -> Run {
        approved(fx, crate::domain::RunSpec { kind: RunKind::Triage, ..next_spec(fx) }, Some(fx.item("CA-1")), result, |_| {}).await
    }

    /// The drafts about the ticket's text: not the drafts that started the runs.
    async fn all(fx: &Fixture) -> Vec<Proposal> {
        fx.core.proposals(&ProposalQuery::default()).await.unwrap().into_iter().filter(|p| !matches!(p.intent, Intent::StartRun { .. })).collect()
    }

    async fn describe(fx: &Fixture, markdown: &str) {
        let doc = Doc::from_markdown(markdown, &[]);
        fx.edit_item("CA-1", |item| item.body = doc).await;
    }

    fn sections(p: &Proposal) -> (String, String) {
        match &p.intent {
            Intent::Rewrite { body: Some(b), title: None, .. } => (b.from.to_markdown(), b.to.to_markdown()),
            other => panic!("a description update: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_finished_triage_drafts_its_note_and_open_questions_as_a_description_update_not_a_comment() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = triage_with(&fx, NOT_READY).await;
        let made = fx.core.auto_draft_run_triage(&run.id).await.unwrap().expect("drafted");
        assert!(matches!(made.intent, Intent::Rewrite { .. }), "a Rewrite, not a Comment: {:?}", made.intent);
        assert!(made.is_triage_description());
        assert_eq!((made.created_by, made.state.clone(), made.origin.clone()), (CreatedBy::Agent, ProposalState::Pending, Origin::of_run(&run)));
        assert_eq!(made.label, Some(format!("From agent run {}", run.short_id.as_ref().unwrap())));
        assert!(made.basis.is_some());
        let (from, to) = sections(&made);
        assert_eq!(from, "Hi");
        assert_eq!(to, "Hi\n\n## Triage\n\nThe ticket cannot be sized yet: the description is one line.\n\nOpen questions:\n\n- What does done look like?\n- Who is waiting on it?");
        for word in [" I ", " we ", "Gossamr", "Pip", "workstream"] {
            assert!(!to.contains(word), "Jira text is neutral: {word:?} in {to}");
        }
        assert!(all(&fx).await.iter().all(|p| !matches!(p.intent, Intent::Comment { .. })), "no comment is drafted");
        assert!(fx.tracker.intents().is_empty(), "a draft writes nothing");
        assert!(fx.core.auto_draft_run_triage(&run.id).await.unwrap().is_none(), "one per run, in any state");
        assert_eq!(all(&fx).await.len(), 1);
    }

    #[tokio::test]
    async fn another_kind_of_run_still_drafts_its_note_as_a_comment() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = approved(&fx, crate::domain::RunSpec { kind: RunKind::Investigate, ..next_spec(&fx) }, Some(fx.item("CA-1")), "Found it.\n\nFor Jira:\nThe consumer retries without backoff.", |_| {}).await;
        let made = fx.core.auto_draft_run_triage(&run.id).await.unwrap().expect("drafted");
        assert!(matches!(made.intent, Intent::Comment { .. }) && !made.is_triage_description());
    }

    #[tokio::test]
    async fn a_ready_triage_still_writes_its_note_and_takes_the_open_questions_out_replacing_the_section_not_stacking_it() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let first = triage_with(&fx, NOT_READY).await;
        let one = fx.core.auto_draft_run_triage(&first.id).await.unwrap().unwrap();
        // The person approved the first one: the description now carries its Triage section.
        describe(&fx, &sections(&one).1).await;
        fx.core.skip_proposal(&one.id).await.unwrap();
        let second = triage_with(&fx, READY).await;
        let two = fx.core.auto_draft_run_triage(&second.id).await.unwrap().expect("a ready triage drafts its note too");
        let (from, to) = sections(&two);
        assert!(from.contains("Open questions:"));
        assert_eq!(to, "Hi\n\n## Triage\n\nSize: 3 points (about a day). The answers in the ticket's comments were used, so no questions are open.");
        assert_eq!(to.matches("## Triage").count(), 1, "replaced, never stacked");
        assert!(!to.contains("Open questions"));
    }

    #[tokio::test]
    async fn a_newer_triage_retires_an_older_unedited_draft_and_leaves_one_the_person_edited() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let first = triage_with(&fx, NOT_READY).await;
        let one = fx.core.auto_draft_run_triage(&first.id).await.unwrap().unwrap();
        let second = triage_with(&fx, READY).await;
        let two = fx.core.auto_draft_run_triage(&second.id).await.unwrap().unwrap();
        assert!(matches!(fx.core.proposal(&one.id).await.unwrap().unwrap().state, ProposalState::Retired(_)), "superseded");
        assert_eq!(fx.core.proposal(&two.id).await.unwrap().unwrap().state, ProposalState::Pending);

        let third = triage_with(&fx, NOT_READY).await;
        let edited = fx.core.edit_proposal(&two.id, &Edit::Rewrite { title: None, body: Some("Hi\n\n## Triage\n\nThe person's own words.".into()) }).await.unwrap();
        assert!(fx.core.auto_draft_run_triage(&third.id).await.unwrap().is_none(), "no second one is made beside the person's edit");
        assert_eq!(fx.core.proposal(&two.id).await.unwrap().unwrap().intent, edited.intent);
        assert_eq!(all(&fx).await.iter().filter(|p| p.state == ProposalState::Pending).count(), 1);
    }

    #[tokio::test]
    async fn a_triage_draft_and_a_plan_draft_are_two_things_on_one_description_and_neither_replaces_the_other() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let triage = triage_with(&fx, NOT_READY).await;
        let note = fx.core.auto_draft_run_triage(&triage.id).await.unwrap().unwrap();
        let plan = plan_with(&fx, PLAN).await;
        let plan_draft = fx.core.auto_draft_run_plan_description(&plan.id).await.unwrap().expect("the plan's draft");
        assert!(!plan_draft.is_triage_description());
        assert_eq!(fx.core.proposal(&note.id).await.unwrap().unwrap().state, ProposalState::Pending, "the plan leaves the triage's draft");
        // A re-triage leaves the plan's draft alone.
        let again = triage_with(&fx, READY).await;
        fx.core.auto_draft_run_triage(&again.id).await.unwrap().unwrap();
        assert_eq!(fx.core.proposal(&plan_draft.id).await.unwrap().unwrap().state, ProposalState::Pending, "the plan's draft stays");
        assert!(matches!(fx.core.proposal(&note.id).await.unwrap().unwrap().state, ProposalState::Retired(_)));
    }

    #[tokio::test]
    async fn a_triage_with_neither_a_note_nor_a_question_drafts_nothing() {
        let fx = fixture_watching(&["acme/webshop"]).await;
        let run = triage_with(&fx, "Small.").await;
        assert!(fx.core.auto_draft_run_triage(&run.id).await.unwrap().is_none());
        assert!(all(&fx).await.is_empty());
    }
}
