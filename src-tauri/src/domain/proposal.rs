use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    ContainerRef, Doc, Identity, ItemKind, ItemRef, Link, LinkKind, PersonRef, Priority, WorkItem,
    Workflow,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub title: String,
    pub body: Doc,
    pub kind: ItemKind,
    pub assignee: Option<PersonRef>,
    pub parent: Option<ItemRef>,
    pub priority: Option<Priority>,
    #[serde(default)]
    pub labels: Vec<String>,
}

/// Triage fields. `None` leaves a field alone; there is no way to clear one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub assignee: Option<PersonRef>,
    /// The epic.
    pub parent: Option<ItemRef>,
    pub priority: Option<Priority>,
}

impl Patch {
    pub fn is_empty(&self) -> bool {
        self.assignee.is_none() && self.parent.is_none() && self.priority.is_none()
    }
}

/// A write, described neutrally. Only the approval layer hands one to a connector.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Intent {
    Comment { item: ItemRef, body: Doc },
    Transition { item: ItemRef, to: String },
    Create { container: ContainerRef, fields: NewItem, link: Option<Link> },
    Update { item: ItemRef, patch: Patch },
    Link { from: ItemRef, to: ItemRef, kind: LinkKind },
    Subtasks { parent: ItemRef, summaries: Vec<String> },
}

impl Intent {
    /// The existing item the intent was drafted against, if any.
    pub fn target(&self) -> Option<&ItemRef> {
        match self {
            Intent::Comment { item, .. } | Intent::Transition { item, .. } | Intent::Update { item, .. } => Some(item),
            Intent::Link { from, .. } => Some(from),
            Intent::Subtasks { parent, .. } => Some(parent),
            Intent::Create { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Origin {
    Chat,
    Board,
    Autopilot { event_id: String },
}

/// Fingerprint of the item as it was when the proposal was drafted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Basis {
    pub item: ItemRef,
    pub status_id: String,
    pub comment_count: u32,
    pub assignee: Option<PersonRef>,
    pub parent: Option<ItemRef>,
    pub priority: Option<Priority>,
}

impl Basis {
    pub fn of(item: &WorkItem) -> Self {
        Basis {
            item: item.item.clone(),
            status_id: item.status.id.clone(),
            comment_count: item.comment_count,
            assignee: item.assignee.clone(),
            parent: item.parent.clone(),
            priority: item.priority,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "reason", rename_all = "camelCase")]
pub enum ProposalState {
    Pending,
    Applied,
    Discarded,
    Superseded(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub at: DateTime<Utc>,
    pub note: String,
    pub intent: Intent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub origin: Origin,
    pub intent: Intent,
    pub basis: Option<Basis>,
    pub state: ProposalState,
    #[serde(default)]
    pub revisions: Vec<Revision>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Keep,
    Revise(Box<Revised>),
    Retire { reason: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Revised {
    pub note: String,
    /// The corrected intent; `None` means the drafter should extend the text.
    pub intent: Option<Intent>,
    pub basis: Basis,
}

impl Proposal {
    /// Applies a reconcile verdict. Only a pending proposal changes, and never to `Applied`.
    pub fn absorb(&mut self, verdict: Verdict, at: DateTime<Utc>) {
        if self.state != ProposalState::Pending {
            return;
        }
        match verdict {
            Verdict::Keep => {}
            Verdict::Retire { reason } => self.state = ProposalState::Superseded(reason),
            Verdict::Revise(revised) => {
                let Revised { note, intent, basis } = *revised;
                if let Some(intent) = intent {
                    self.intent = intent;
                }
                self.revisions.push(Revision { at, note, intent: self.intent.clone() });
                self.basis = Some(basis);
            }
        }
    }
}

pub struct ReconcileContext<'a> {
    pub me: &'a Identity,
    pub workflows: &'a HashMap<ContainerRef, Workflow>,
}

/// Decides whether a pending proposal still fits the current items. Pure: no model call, no I/O.
pub fn reconcile(proposal: &Proposal, items: &[WorkItem], ctx: &ReconcileContext) -> Verdict {
    if proposal.state != ProposalState::Pending {
        return Verdict::Keep;
    }
    let Some(target) = proposal.intent.target() else {
        return Verdict::Keep;
    };
    let Some(current) = items.iter().find(|i| i.item == *target) else {
        return retire("the item is no longer available");
    };
    let Some(basis) = &proposal.basis else {
        return Verdict::Keep;
    };
    let fresh = Basis::of(current);
    match &proposal.intent {
        Intent::Transition { to, .. } => reconcile_transition(to, current, basis, fresh, ctx),
        Intent::Comment { .. } => reconcile_comment(current, basis, fresh, ctx),
        Intent::Update { item, patch } => reconcile_update(item, patch, current, basis, fresh),
        Intent::Link { to, kind, .. } => {
            let exists = current.links.iter().any(|l| l.kind == *kind && l.to == *to);
            if exists { retire("the link already exists") } else { Verdict::Keep }
        }
        Intent::Subtasks { .. } | Intent::Create { .. } => Verdict::Keep,
    }
}

fn retire(reason: &str) -> Verdict {
    Verdict::Retire { reason: reason.into() }
}

fn reconcile_transition(to: &str, current: &WorkItem, basis: &Basis, fresh: Basis, ctx: &ReconcileContext) -> Verdict {
    if current.status.id == to {
        return retire("the item is already in that status");
    }
    let workflow = ctx.workflows.get(&current.container);
    if let Some(w) = workflow {
        if w.status(to).is_none() {
            return retire("the target status no longer exists");
        }
    }
    if basis.status_id == current.status.id {
        return Verdict::Keep;
    }
    match workflow {
        Some(w) if !w.can_move(&current.status.id, to) => retire("the item moved and the target is no longer reachable"),
        _ => Verdict::Revise(Box::new(Revised {
            note: format!("The item moved to {} since this was drafted.", current.status.name),
            intent: None,
            basis: fresh,
        })),
    }
}

fn reconcile_comment(current: &WorkItem, basis: &Basis, fresh: Basis, ctx: &ReconcileContext) -> Verdict {
    if current.comment_count <= basis.comment_count {
        return Verdict::Keep;
    }
    if current.last_commenter.as_ref().is_some_and(|p| ctx.me.owns(p)) {
        return retire("you already commented");
    }
    Verdict::Revise(Box::new(Revised {
        note: "A new comment arrived since this was drafted.".into(),
        intent: None,
        basis: fresh,
    }))
}

fn reconcile_update(item: &ItemRef, patch: &Patch, current: &WorkItem, basis: &Basis, fresh: Basis) -> Verdict {
    fn still_wanted<T: PartialEq + Clone>(wanted: &Option<T>, now: &Option<T>, then: &Option<T>) -> Option<T> {
        wanted.clone().filter(|w| now == then && now.as_ref() != Some(w))
    }
    let kept = Patch {
        assignee: still_wanted(&patch.assignee, &current.assignee, &basis.assignee),
        parent: still_wanted(&patch.parent, &current.parent, &basis.parent),
        priority: still_wanted(&patch.priority, &current.priority, &basis.priority),
    };
    if kept == *patch {
        return Verdict::Keep;
    }
    if kept.is_empty() {
        return retire("everything it would set has already been set");
    }
    Verdict::Revise(Box::new(Revised {
        note: "Some fields were already set by someone else and were dropped.".into(),
        intent: Some(Intent::Update { item: item.clone(), patch: kept }),
        basis: fresh,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::*;
    use crate::domain::workflow::tests::linear;

    fn me() -> Identity {
        Identity { display_name: "Me".into(), accounts: vec![person("me")] }
    }

    fn proposal(intent: Intent, basis: &WorkItem) -> Proposal {
        Proposal {
            id: "p1".into(),
            created_at: now(),
            origin: Origin::Chat,
            intent,
            basis: Some(Basis::of(basis)),
            state: ProposalState::Pending,
            revisions: vec![],
        }
    }

    fn run(p: &Proposal, items: &[WorkItem]) -> Verdict {
        let me = me();
        let workflows = HashMap::from([(items.first().map_or_else(|| work_item("0", "todo").container, |i| i.container.clone()), linear())]);
        reconcile(p, items, &ReconcileContext { me: &me, workflows: &workflows })
    }

    fn transition_to(to: &str, at: &WorkItem) -> Proposal {
        proposal(Intent::Transition { item: at.item.clone(), to: to.into() }, at)
    }

    #[test]
    fn transition_kept_while_nothing_changed() {
        let item = work_item("1", "doing");
        assert_eq!(run(&transition_to("review", &item), &[item]), Verdict::Keep);
    }

    #[test]
    fn transition_retired_when_target_already_reached_or_item_gone() {
        let drafted = work_item("1", "doing");
        let p = transition_to("review", &drafted);
        assert!(matches!(run(&p, &[work_item("1", "review")]), Verdict::Retire { .. }));
        assert!(matches!(run(&p, &[]), Verdict::Retire { .. }));
    }

    #[test]
    fn transition_revised_when_item_moved_but_target_still_reachable() {
        let drafted = work_item("1", "todo");
        let p = transition_to("review", &drafted);
        let moved = work_item("1", "doing");
        match run(&p, std::slice::from_ref(&moved)) {
            Verdict::Revise(r) => {
                assert_eq!(r.basis.status_id, "doing");
                assert_eq!(r.intent, None);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn transition_retired_when_no_longer_reachable() {
        let drafted = work_item("1", "todo");
        let p = transition_to("doing", &drafted);
        assert!(matches!(run(&p, &[work_item("1", "done")]), Verdict::Retire { .. }));
    }

    fn comment_on(item: &WorkItem) -> Proposal {
        proposal(Intent::Comment { item: item.item.clone(), body: Doc::paragraph("on it") }, item)
    }

    #[test]
    fn comment_retired_if_you_replied_and_revised_on_someone_elses_follow_up() {
        let drafted = work_item("1", "doing");
        let p = comment_on(&drafted);
        assert_eq!(run(&p, std::slice::from_ref(&drafted)), Verdict::Keep);

        let mut mine = drafted.clone();
        mine.comment_count = 1;
        mine.last_commenter = Some(person("me"));
        assert!(matches!(run(&p, &[mine]), Verdict::Retire { .. }));

        let mut theirs = drafted.clone();
        theirs.comment_count = 1;
        theirs.last_commenter = Some(person("them"));
        assert!(matches!(run(&p, &[theirs]), Verdict::Revise(ref r) if r.intent.is_none()));
    }

    fn triage(patch: Patch, item: &WorkItem) -> Proposal {
        proposal(Intent::Update { item: item.item.clone(), patch }, item)
    }

    #[test]
    fn triage_drops_fields_someone_else_set_and_retires_when_none_left() {
        let drafted = work_item("1", "todo");
        let p = triage(
            Patch { assignee: Some(person("me")), priority: Some(Priority::High), parent: None },
            &drafted,
        );
        assert_eq!(run(&p, std::slice::from_ref(&drafted)), Verdict::Keep);

        let mut someone_assigned = drafted.clone();
        someone_assigned.assignee = Some(person("them"));
        match run(&p, &[someone_assigned.clone()]) {
            Verdict::Revise(r) => {
                let Some(Intent::Update { patch, .. }) = r.intent else { panic!() };
                assert_eq!(patch, Patch { priority: Some(Priority::High), ..Patch::default() });
            }
            other => panic!("{other:?}"),
        }

        someone_assigned.priority = Some(Priority::Low);
        assert!(matches!(run(&p, &[someone_assigned]), Verdict::Retire { .. }));
    }

    #[test]
    fn triage_drops_a_field_that_already_holds_the_wanted_value() {
        let drafted = work_item("1", "todo");
        let p = triage(Patch { priority: Some(Priority::High), ..Patch::default() }, &drafted);
        let mut same = drafted.clone();
        same.priority = Some(Priority::High);
        assert!(matches!(run(&p, &[same]), Verdict::Retire { .. }));
    }

    #[test]
    fn link_retired_when_it_exists() {
        let drafted = work_item("1", "todo");
        let intent = Intent::Link { from: item_ref("1"), to: item_ref("2"), kind: LinkKind::Blocks };
        let p = proposal(intent, &drafted);
        assert_eq!(run(&p, std::slice::from_ref(&drafted)), Verdict::Keep);
        let mut linked = drafted.clone();
        linked.links.push(Link { from: item_ref("1"), to: item_ref("2"), kind: LinkKind::Blocks });
        assert!(matches!(run(&p, &[linked]), Verdict::Retire { .. }));
    }

    #[test]
    fn absorb_never_applies_and_only_touches_pending() {
        let item = work_item("1", "todo");
        let mut p = transition_to("doing", &item);
        p.absorb(Verdict::Retire { reason: "gone".into() }, now());
        assert_eq!(p.state, ProposalState::Superseded("gone".into()));

        let mut applied = transition_to("doing", &item);
        applied.state = ProposalState::Applied;
        applied.absorb(Verdict::Retire { reason: "x".into() }, now());
        assert_eq!(applied.state, ProposalState::Applied);
    }

    #[test]
    fn absorbed_revision_updates_the_basis_so_the_next_pass_keeps() {
        let drafted = work_item("1", "todo");
        let mut p = transition_to("review", &drafted);
        let moved = work_item("1", "doing");
        let verdict = run(&p, std::slice::from_ref(&moved));
        p.absorb(verdict, now());
        assert_eq!(p.revisions.len(), 1);
        assert_eq!(run(&p, &[moved]), Verdict::Keep);
    }

    #[test]
    fn serialises_intent_with_a_type_tag() {
        let json = serde_json::to_value(Intent::Subtasks { parent: item_ref("1"), summaries: vec!["a".into()] }).unwrap();
        assert_eq!(json["type"], "subtasks");
    }
}
