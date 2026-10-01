//! Proposals: writes drafted by a person, Pip or autopilot that only an approval turns into a change in a tracker.
//! `approve` is the single route from here to `WorkTracker::apply`.

// The autopilot origin waits for the rules engine (4a).
#![allow(dead_code)]

use std::collections::HashMap;
use std::mem::discriminant;

use chrono::{DateTime, Utc};

use crate::db::Db;
use crate::domain::{
    reconcile, Basis, ContainerRef, CreatedBy, Identity, Intent, ItemRef, Origin, Proposal, ProposalQuery, ProposalState,
    ReconcileContext, Revision, StateKind, Transitions, Workflow,
};
use crate::error::{Error, Result};
use crate::tracker::WorkTracker;

pub struct Draft {
    pub origin: Origin,
    pub created_by: CreatedBy,
    pub intent: Intent,
    pub label: Option<String>,
    pub basis: Option<Basis>,
}

impl Draft {
    /// What Pip drafts while answering `request_id`.
    pub fn from_pip(request_id: &str, intent: Intent, label: Option<String>) -> Self {
        Self { origin: Origin::Chat { request_id: request_id.into() }, created_by: CreatedBy::Pip, intent, label, basis: None }
    }
}

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

pub(crate) fn new_id() -> Result<String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| refuse(format!("no randomness available: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn check(intent: &Intent) -> Result<()> {
    let blank = |s: &str| s.trim().is_empty();
    match intent {
        Intent::Comment { body, .. } if blank(&body.plain_text()) => Err(refuse("a comment can't be empty")),
        Intent::Transition { to, .. } if blank(to) => Err(refuse("a transition needs a target status")),
        Intent::Subtasks { summaries, .. } if summaries.is_empty() || summaries.iter().any(|s| blank(s)) => {
            Err(refuse("list at least one subtask, and none of them blank"))
        }
        Intent::Update { patch, .. } if patch.is_empty() => Err(refuse("an update has to change something")),
        Intent::Create { fields, .. } if blank(&fields.title) => Err(refuse("a new item needs a title")),
        Intent::StartRun { connection_id, item, spec } => {
            if item.as_ref().is_some_and(|i| i.connection_id != *connection_id) {
                return Err(refuse("the ticket belongs to another connection"));
            }
            if item.is_none() && spec.kind == crate::domain::RunKind::Build {
                return Err(refuse("Build needs a ticket"));
            }
            spec.validate()
        }
        _ => Ok(()),
    }
}

pub fn create(db: &Db, draft: Draft, at: DateTime<Utc>) -> Result<Proposal> {
    // Every draft is stored here, so this is the one place that can keep autopilot from starting an agent.
    let by_autopilot = matches!(draft.origin, Origin::Autopilot { .. }) || draft.created_by == CreatedBy::Autopilot;
    if by_autopilot && matches!(draft.intent, Intent::StartRun { .. }) {
        return Err(refuse("autopilot can't start an agent"));
    }
    check(&draft.intent)?;
    let p = Proposal {
        id: new_id()?,
        created_at: at,
        updated_at: at,
        origin: draft.origin,
        created_by: draft.created_by,
        intent: draft.intent,
        label: draft.label,
        basis: draft.basis,
        state: ProposalState::Pending,
        revisions: vec![],
        created: vec![],
        error: None,
        run: None,
    };
    db.insert_proposal(&p)?;
    Ok(p)
}

fn load(db: &Db, id: &str) -> Result<Proposal> {
    db.proposal(id)?.ok_or_else(|| refuse("that draft no longer exists"))
}

pub(crate) fn not_pending(p: &Proposal) -> Error {
    refuse(match &p.state {
        ProposalState::Pending => "that draft is pending",
        ProposalState::Applying => "that draft is being applied right now",
        ProposalState::Applied => "that draft has already been applied",
        ProposalState::Skipped => "that draft was skipped",
        ProposalState::Retired(_) => "that draft is out of date and was retired",
    })
}

/// Replaces a pending proposal's payload with the person's edit. What it is about and what kind of change it is stay
/// fixed, and subtasks already created stay in front so a retry still lines up.
pub fn edit(db: &Db, id: &str, intent: Intent, at: DateTime<Utc>) -> Result<Proposal> {
    edit_noted(db, id, intent, "Edited", at)
}

pub fn edit_noted(db: &Db, id: &str, intent: Intent, note: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    if p.state != ProposalState::Pending {
        return Err(not_pending(&p));
    }
    if discriminant(&p.intent) != discriminant(&intent) || p.intent.target() != intent.target() {
        return Err(refuse("an edit can't change what the draft is about"));
    }
    check(&intent)?;
    if matches!((&p.intent, &intent), (Intent::StartRun { connection_id: a, .. }, Intent::StartRun { connection_id: b, .. }) if a != b) {
        return Err(refuse("an edit can't change what the draft is about"));
    }
    if let (Intent::Subtasks { summaries: old, .. }, Intent::Subtasks { summaries: new, .. }) = (&p.intent, &intent) {
        let made = p.created.len().min(old.len());
        if new.len() < made || new[..made] != old[..made] {
            return Err(refuse("subtasks that were already created can't be changed"));
        }
    }
    // A transition's label named the old target, so the approve button falls back to the new status's name.
    if matches!((&p.intent, &intent), (Intent::Transition { to: a, .. }, Intent::Transition { to: b, .. }) if a != b) {
        p.label = None;
    }
    p.revisions.push(Revision { at, note: note.into(), intent: intent.clone() });
    p.intent = intent;
    p.updated_at = at;
    p.error = None;
    db.save_proposal(&p)?;
    Ok(p)
}

/// Pip may change only what it drafted itself, and only while nobody has decided it.
pub fn require_pip_pending(p: &Proposal) -> Result<()> {
    if p.created_by != CreatedBy::Pip {
        return Err(refuse("that draft wasn't made by Pip, so Pip can't change it"));
    }
    if p.state != ProposalState::Pending {
        return Err(not_pending(p));
    }
    Ok(())
}

pub fn skip(db: &Db, id: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    match p.state {
        ProposalState::Skipped => return Ok(p),
        ProposalState::Pending => {}
        _ => return Err(not_pending(&p)),
    }
    p.state = ProposalState::Skipped;
    p.updated_at = at;
    db.save_proposal(&p)?;
    Ok(p)
}

pub fn retire(db: &Db, id: &str, reason: &str, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    if p.state != ProposalState::Pending {
        return Err(not_pending(&p));
    }
    p.state = ProposalState::Retired(reason.into());
    p.updated_at = at;
    db.save_proposal(&p)?;
    Ok(p)
}

/// First half of an approval: claims the proposal so nothing else can apply it, and returns it.
pub fn begin(db: &Db, id: &str, at: DateTime<Utc>) -> Result<Proposal> {
    match db.begin_applying(id, at)? {
        Some(p) => Ok(p),
        None => Err(not_pending(&load(db, id)?)),
    }
}

/// What an attempt did. Creating several things can stop part-way, so `error` accompanies whatever was created.
#[derive(Debug, Default)]
pub struct Outcome {
    pub created: Vec<ItemRef>,
    pub error: Option<Error>,
}

/// Hands the proposal's intent to the tracker. Subtasks a previous attempt created are left out.
pub async fn execute(tracker: &dyn WorkTracker, p: &Proposal) -> Outcome {
    let intent = match &p.intent {
        Intent::Subtasks { parent, summaries } => {
            let rest = &summaries[p.created.len().min(summaries.len())..];
            if rest.is_empty() {
                return Outcome::default();
            }
            Intent::Subtasks { parent: parent.clone(), summaries: rest.to_vec() }
        }
        other => other.clone(),
    };
    match tracker.apply(&intent).await {
        Ok(applied) => Outcome { created: applied.created, error: applied.error },
        Err(error) => Outcome { created: vec![], error: Some(error) },
    }
}

/// Second half: a failed attempt goes back to pending with the error, keeping what it created; otherwise it is applied.
pub fn finish(db: &Db, id: &str, outcome: Outcome, at: DateTime<Utc>) -> Result<Proposal> {
    let mut p = load(db, id)?;
    if p.state != ProposalState::Applying {
        return Err(not_pending(&p));
    }
    p.created.extend(outcome.created);
    match outcome.error {
        Some(e) => {
            p.state = ProposalState::Pending;
            p.error = Some(e.to_string());
        }
        None => {
            p.state = ProposalState::Applied;
            p.error = None;
        }
    }
    p.updated_at = at;
    db.save_proposal(&p)?;
    Ok(p)
}

/// Runs `reconcile` over every pending proposal against the cache and stores what it decides. Returns how many changed.
pub fn reconcile_pending(db: &Db, me: &Identity, now: DateTime<Utc>) -> Result<usize> {
    let pending = db.proposals(&ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() })?;
    let mut items = Vec::new();
    let mut workflows: HashMap<ContainerRef, Workflow> = HashMap::new();
    for target in pending.iter().filter_map(Proposal::target) {
        // A ticket that was never cached, or has aged out, can't be judged; retiring its drafts would lose them.
        let Some(item) = db.item(target)? else { continue };
        if !workflows.contains_key(&item.container) {
            // A tracker that lists moves per item leaves the graph empty, which would read as "nothing is reachable".
            if let Some(w) = db.workflow(&item.container)?.filter(|w| !matches!(&w.transitions, Transitions::Graph(m) if m.is_empty())) {
                workflows.insert(item.container.clone(), w);
            }
        }
        items.push(item);
    }
    let ctx = ReconcileContext { me, workflows: &workflows };
    let mut changed = 0;
    for mut p in pending {
        let Some(target) = p.target() else { continue };
        if !items.iter().any(|i| i.item == *target) {
            continue;
        }
        let verdict = reconcile(&p, &items, &ctx);
        let before = p.clone();
        p.absorb(verdict, now);
        if p != before {
            db.save_proposal(&p)?;
            changed += 1;
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::{item_ref, now, person, work_item};
    use crate::domain::{Category, Container, Doc, StatusDef, Transition};
    use crate::tracker::testing::Recorder;
    use crate::tracker::Applied;

    fn comment_draft(id: &str) -> Draft {
        Draft::from_pip("run", Intent::Comment { item: item_ref(id), body: Doc::paragraph("hello") }, None)
    }

    fn subtasks_draft(summaries: &[&str]) -> Draft {
        let summaries = summaries.iter().map(|s| s.to_string()).collect();
        Draft::from_pip("run", Intent::Subtasks { parent: item_ref("1"), summaries }, None)
    }

    fn made(db: &Db, draft: Draft) -> Proposal {
        create(db, draft, now()).unwrap()
    }

    async fn approve(db: &Db, tracker: &Recorder, id: &str) -> Result<Proposal> {
        let claimed = begin(db, id, now())?;
        let outcome = execute(tracker, &claimed).await;
        finish(db, id, outcome, now())
    }

    fn down() -> Result<Applied> {
        Err(Error::Api { status: 503, message: "down".into() })
    }

    fn created(keys: &[&str]) -> Vec<ItemRef> {
        keys.iter().map(|k| ItemRef { connection_id: "c".into(), external_id: (*k).into(), key: (*k).into() }).collect()
    }

    #[test]
    fn drafts_are_stored_and_listed_by_state_item_and_connection() {
        let db = Db::in_memory().unwrap();
        let a = made(&db, comment_draft("1"));
        let b = made(&db, comment_draft("2"));
        skip(&db, &b.id, now()).unwrap();

        assert_eq!(db.proposal(&a.id).unwrap().unwrap(), a);
        assert_eq!(db.proposals(&ProposalQuery::default()).unwrap().len(), 2);
        let pending = ProposalQuery { states: Some(vec![StateKind::Pending]), ..Default::default() };
        assert_eq!(db.proposals(&pending).unwrap(), vec![a.clone()]);
        let on_two = ProposalQuery { item: Some(item_ref("2")), ..Default::default() };
        assert_eq!(db.proposals(&on_two).unwrap()[0].id, b.id);
        let other = ProposalQuery { connection_id: Some("elsewhere".into()), ..Default::default() };
        assert!(db.proposals(&other).unwrap().is_empty());
        assert!(db.proposal("nope").unwrap().is_none());
    }

    #[test]
    fn blank_drafts_are_refused() {
        let db = Db::in_memory().unwrap();
        let empty = Draft::from_pip("r", Intent::Comment { item: item_ref("1"), body: Doc::paragraph("  ") }, None);
        assert!(create(&db, empty, now()).is_err());
        assert!(create(&db, subtasks_draft(&[]), now()).is_err());
        assert!(create(&db, subtasks_draft(&["a", " "]), now()).is_err());
    }

    #[test]
    fn an_edit_replaces_the_payload_but_not_what_it_is_about() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        let new_body = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("better") };
        let edited = edit(&db, &p.id, new_body.clone(), now()).unwrap();
        assert_eq!(edited.intent, new_body);
        assert_eq!(edited.revisions.len(), 1);
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().intent, new_body);

        let elsewhere = Intent::Comment { item: item_ref("2"), body: Doc::paragraph("x") };
        assert!(edit(&db, &p.id, elsewhere, now()).is_err());
        let other_kind = Intent::Transition { item: item_ref("1"), to: "done".into() };
        assert!(edit(&db, &p.id, other_kind, now()).is_err());
        let blank = Intent::Comment { item: item_ref("1"), body: Doc::paragraph("") };
        assert!(edit(&db, &p.id, blank, now()).is_err());
    }

    #[test]
    fn skipped_drafts_cannot_be_edited_or_applied_and_skipping_twice_is_harmless() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        skip(&db, &p.id, now()).unwrap();
        assert_eq!(skip(&db, &p.id, now()).unwrap().state, ProposalState::Skipped);
        assert!(edit(&db, &p.id, p.intent.clone(), now()).is_err());
        assert!(begin(&db, &p.id, now()).is_err());
    }

    #[tokio::test]
    async fn approving_applies_the_intent_once_and_only_once() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        let p = made(&db, comment_draft("1"));

        let done = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(tracker.intents(), vec![p.intent.clone()]);

        assert!(approve(&db, &tracker, &p.id).await.is_err());
        assert_eq!(tracker.intents().len(), 1);
        assert!(skip(&db, &p.id, now()).is_err(), "an applied draft can't be skipped");
    }

    #[test]
    fn a_draft_being_applied_cannot_be_claimed_again() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        assert_eq!(begin(&db, &p.id, now()).unwrap().state, ProposalState::Applying);
        let again = begin(&db, &p.id, now()).unwrap_err().to_string();
        assert!(again.contains("being applied"), "{again}");
        assert!(edit(&db, &p.id, p.intent.clone(), now()).is_err());
        assert!(begin(&db, "missing", now()).is_err());
    }

    #[tokio::test]
    async fn a_failed_attempt_is_recorded_and_can_be_retried() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        tracker.will(down());
        let p = made(&db, comment_draft("1"));

        let failed = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(failed.state, ProposalState::Pending);
        assert!(failed.error.as_deref().unwrap().contains("down"));
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().error, failed.error);

        let retried = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(retried.state, ProposalState::Applied);
        assert_eq!(retried.error, None);
        assert_eq!(tracker.intents().len(), 2);
    }

    #[tokio::test]
    async fn a_subtask_retry_creates_only_what_is_left() {
        let db = Db::in_memory().unwrap();
        let tracker = Recorder::default();
        tracker.will(Ok(Applied { created: created(&["S-1"]), error: Some(Error::Api { status: 500, message: "boom".into() }) }));
        tracker.will(Ok(Applied { created: created(&["S-2", "S-3"]), error: None }));
        let p = made(&db, subtasks_draft(&["a", "b", "c"]));

        let partial = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(partial.state, ProposalState::Pending);
        assert_eq!(partial.created, created(&["S-1"]));

        let done = approve(&db, &tracker, &p.id).await.unwrap();
        assert_eq!(done.state, ProposalState::Applied);
        assert_eq!(done.created, created(&["S-1", "S-2", "S-3"]));
        let sent: Vec<Vec<String>> = tracker
            .intents()
            .into_iter()
            .map(|i| match i {
                Intent::Subtasks { summaries, .. } => summaries,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(sent, vec![vec!["a", "b", "c"], vec!["b", "c"]]);
    }

    #[test]
    fn subtasks_already_created_cannot_be_edited_away_but_the_rest_can() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, subtasks_draft(&["a", "b", "c"]));
        let mut stored = db.proposal(&p.id).unwrap().unwrap();
        stored.created = created(&["S-1"]);
        db.save_proposal(&stored).unwrap();

        let with = |summaries: &[&str]| Intent::Subtasks { parent: item_ref("1"), summaries: summaries.iter().map(|s| s.to_string()).collect() };
        assert!(edit(&db, &p.id, with(&["x", "b", "c"]), now()).is_err());
        assert!(edit(&db, &p.id, with(&[]), now()).is_err());
        assert_eq!(edit(&db, &p.id, with(&["a", "c"]), now()).unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn a_draft_left_applying_by_a_closed_app_is_released_with_a_warning() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        begin(&db, &p.id, now()).unwrap();
        assert_eq!(db.release_interrupted(now()).unwrap(), 1);
        let back = db.proposal(&p.id).unwrap().unwrap();
        assert_eq!(back.state, ProposalState::Pending);
        assert!(back.error.unwrap().contains("Check whether it went through"));
    }

    fn cache(db: &Db, items: &[crate::domain::WorkItem]) {
        db.upsert_items(items, "2026-09-29T12:00:00Z").unwrap();
    }

    fn workflow(transitions: Transitions) -> Container {
        let s = |id: &str, category| StatusDef { id: id.into(), name: id.to_uppercase(), category };
        let statuses = vec![s("todo", Category::Todo), s("doing", Category::Active), s("review", Category::Active), s("done", Category::Done)];
        let container_ref = work_item("1", "todo").container;
        Container { container_ref, key: "P".into(), name: "P".into(), workflow: Workflow { statuses, transitions } }
    }

    fn me() -> Identity {
        Identity { display_name: "Me".into(), accounts: vec![person("me")] }
    }

    fn transition_draft(id: &str, at: &crate::domain::WorkItem, to: &str) -> Draft {
        Draft {
            basis: Some(Basis::of(at)),
            ..Draft::from_pip("run", Intent::Transition { item: item_ref(id), to: to.into() }, None)
        }
    }

    #[test]
    fn a_sync_that_moved_the_item_revises_the_draft_and_one_that_finished_it_retires_it() {
        let db = Db::in_memory().unwrap();
        let todo = work_item("1", "todo");
        let two = work_item("2", "doing");
        cache(&db, &[todo.clone(), two.clone()]);
        let moves = Transitions::Graph(vec![
            Transition { from: "todo".into(), to: "doing".into() },
            Transition { from: "doing".into(), to: "review".into() },
        ]);
        db.replace_containers("c", &[workflow(moves)], "2026-09-29T12:00:00Z").unwrap();
        let revise = made(&db, transition_draft("1", &todo, "review"));
        let retire = made(&db, transition_draft("2", &two, "review"));
        let keep = made(&db, comment_draft("1"));

        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0);

        cache(&db, &[work_item("1", "doing"), work_item("2", "review")]);
        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 2);

        let revised = db.proposal(&revise.id).unwrap().unwrap();
        assert_eq!(revised.state, ProposalState::Pending);
        assert_eq!(revised.revisions.len(), 1);
        assert_eq!(revised.basis.unwrap().status_id, "doing");
        let retired = db.proposal(&retire.id).unwrap().unwrap();
        assert_eq!(retired.state, ProposalState::Retired("the item is already in that status".into()));
        assert_eq!(db.proposal(&keep.id).unwrap().unwrap().state, ProposalState::Pending);

        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0, "a revised draft stays put on the next pass");
    }

    #[test]
    fn drafts_on_uncached_items_and_on_workflows_without_a_graph_are_left_alone() {
        let db = Db::in_memory().unwrap();
        let todo = work_item("1", "todo");
        let uncached = made(&db, transition_draft("9", &work_item("9", "todo"), "done"));
        cache(&db, std::slice::from_ref(&todo));
        db.replace_containers("c", &[workflow(Transitions::Graph(vec![]))], "2026-09-29T12:00:00Z").unwrap();
        let far = made(&db, transition_draft("1", &todo, "done"));

        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0);
        assert_eq!(db.proposal(&uncached.id).unwrap().unwrap().state, ProposalState::Pending);
        assert_eq!(db.proposal(&far.id).unwrap().unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn only_pending_drafts_are_reconciled() {
        let db = Db::in_memory().unwrap();
        let todo = work_item("1", "todo");
        cache(&db, &[work_item("1", "done")]);
        let p = made(&db, transition_draft("1", &todo, "done"));
        skip(&db, &p.id, now()).unwrap();
        assert_eq!(reconcile_pending(&db, &me(), now()).unwrap(), 0);
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().state, ProposalState::Skipped);
    }

    fn start_run_intent() -> Intent {
        Intent::StartRun { connection_id: "c".into(), item: Some(item_ref("1")), spec: crate::domain::fixtures::run_spec() }
    }

    fn run_draft(origin: Origin, by: CreatedBy) -> Draft {
        Draft { origin, created_by: by, intent: start_run_intent(), label: None, basis: None }
    }

    #[test]
    fn autopilot_cannot_create_a_run_draft_but_the_board_and_chat_can() {
        let db = Db::in_memory().unwrap();
        let by_autopilot = create(&db, run_draft(Origin::Autopilot { event_id: "e".into() }, CreatedBy::Autopilot), now());
        assert!(by_autopilot.unwrap_err().to_string().contains("autopilot can't start an agent"));
        let mislabelled = create(&db, run_draft(Origin::Board, CreatedBy::Autopilot), now());
        assert!(mislabelled.is_err());
        assert!(db.proposals(&ProposalQuery::default()).unwrap().is_empty());

        assert!(create(&db, run_draft(Origin::Board, CreatedBy::User), now()).is_ok());
        assert!(create(&db, run_draft(Origin::Chat { request_id: "r".into() }, CreatedBy::Pip), now()).is_ok());
        let still_fine = Draft { origin: Origin::Autopilot { event_id: "e".into() }, created_by: CreatedBy::Autopilot, ..comment_draft("1") };
        assert!(create(&db, still_fine, now()).is_ok(), "autopilot's other drafts are unaffected");
    }

    #[test]
    fn a_run_draft_must_have_a_valid_spec_and_stay_in_its_connection() {
        let db = Db::in_memory().unwrap();
        let Intent::StartRun { connection_id, item, spec } = start_run_intent() else { panic!() };
        let with = |spec: crate::domain::RunSpec| Draft { intent: Intent::StartRun { connection_id: connection_id.clone(), item: item.clone(), spec }, ..run_draft(Origin::Board, CreatedBy::User) };
        assert!(create(&db, with(crate::domain::RunSpec { repo: "a/b/c".into(), ..spec.clone() }), now()).is_err());
        assert!(create(&db, with(crate::domain::RunSpec { instruction: " ".into(), ..spec.clone() }), now()).is_err());
        let foreign = Draft { intent: Intent::StartRun { connection_id: "other".into(), item, spec }, ..run_draft(Origin::Board, CreatedBy::User) };
        assert!(create(&db, foreign, now()).unwrap_err().to_string().contains("another connection"));
    }

    #[test]
    fn the_generic_approval_refuses_a_run_draft_and_leaves_it_pending() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, run_draft(Origin::Board, CreatedBy::User));
        let err = begin(&db, &p.id, now()).unwrap_err().to_string();
        assert!(err.contains("own button"), "{err}");
        assert_eq!(db.proposal(&p.id).unwrap().unwrap().state, ProposalState::Pending);
    }

    #[test]
    fn an_edit_cannot_move_a_run_draft_to_another_connection() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, run_draft(Origin::Board, CreatedBy::User));
        let Intent::StartRun { item, spec, .. } = start_run_intent() else { panic!() };
        let elsewhere = Intent::StartRun { connection_id: "other".into(), item: None, spec: spec.clone() };
        assert!(edit(&db, &p.id, elsewhere, now()).is_err());
        let same = Intent::StartRun { connection_id: "c".into(), item, spec: crate::domain::RunSpec { base: "develop".into(), ..spec } };
        assert_eq!(edit(&db, &p.id, same, now()).unwrap().revisions.len(), 1);
    }

    #[test]
    fn a_proposal_stored_before_runs_existed_reads_with_no_run() {
        let db = Db::in_memory().unwrap();
        let p = made(&db, comment_draft("1"));
        let mut json = serde_json::to_value(&p).unwrap();
        json.as_object_mut().unwrap().remove("run");
        assert_eq!(serde_json::from_value::<Proposal>(json).unwrap().run, None);
    }
}
