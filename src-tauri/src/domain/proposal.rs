use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    ContainerRef, Doc, Identity, ItemKind, ItemRef, Link, LinkKind, PersonRef, Priority, Run, RunSpec, WorkItem,
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

/// The longest title and description a rewrite may set; Jira's own limits.
pub const SUMMARY_LIMIT: usize = 255;
pub const DESCRIPTION_LIMIT: usize = 30_000;

/// A title as it read when the rewrite was drafted, and as it would read after.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TitleChange {
    pub from: String,
    pub to: String,
}

/// A description as it read when the rewrite was drafted, and as it would read after. The page gets both as Markdown
/// next to the documents, so it can show a diff and edit the text without a converter of its own.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct BodyChange {
    pub from: Doc,
    pub to: Doc,
}

impl Serialize for BodyChange {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            from: &'a Doc,
            to: &'a Doc,
            from_text: String,
            to_text: String,
        }
        Wire { from: &self.from, to: &self.to, from_text: self.from.to_markdown(), to_text: self.to.to_markdown() }.serialize(s)
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
    /// Replaces an item's title and/or description. Each change carries what it was drafted against, so an approval
    /// can tell the text moved and refuse instead of overwriting someone else's edit. `flattened` names what the
    /// description holds that a rewrite turns into plain text (images, tables, panels).
    Rewrite { item: ItemRef, title: Option<TitleChange>, body: Option<BodyChange>, #[serde(default)] flattened: Vec<String> },
    /// Starts a background agent. Never applied through a tracker: it has its own approval, bound to a digest.
    #[serde(rename_all = "camelCase")]
    StartRun { connection_id: String, item: Option<ItemRef>, spec: RunSpec },
    /// Sends a finished agent back for another pass with this exact message. Never applied through a tracker: the
    /// person's approval resumes the run.
    #[serde(rename_all = "camelCase")]
    FollowUp { connection_id: String, run_id: String, #[serde(default)] short_id: Option<String>, item: Option<ItemRef>, message: String, reason: String },
}

impl Intent {
    /// The existing item the intent was drafted against, if any.
    pub fn target(&self) -> Option<&ItemRef> {
        match self {
            Intent::Comment { item, .. } | Intent::Transition { item, .. } | Intent::Update { item, .. } | Intent::Rewrite { item, .. } => Some(item),
            Intent::Link { from, .. } => Some(from),
            Intent::Subtasks { parent, .. } => Some(parent),
            Intent::StartRun { item, .. } | Intent::FollowUp { item, .. } => item.as_ref(),
            Intent::Create { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Origin {
    /// Drafted by Pip while answering `request_id`, in the conversation of `workstream` when it belongs to one.
    Chat {
        request_id: String,
        #[serde(default)]
        workstream: Option<String>,
    },
    Board,
    Autopilot { event_id: String },
    /// Made from what an agent run reported. The text is the agent's, which is why it is marked. `workstream` is the
    /// run's own, copied when the draft is made.
    Run {
        run_id: String,
        short_id: Option<String>,
        #[serde(default)]
        workstream: Option<String>,
    },
}

impl Origin {
    /// What Pip drafts while answering `request_id`, outside any workstream.
    pub fn chat(request_id: &str) -> Self {
        Origin::Chat { request_id: request_id.into(), workstream: None }
    }

    /// A draft made from `run`'s result, in the run's workstream.
    pub fn of_run(run: &Run) -> Self {
        Origin::Run { run_id: run.id.clone(), short_id: run.short_id.as_ref().map(ToString::to_string), workstream: run.spec.workstream.clone() }
    }

    /// The workstream the draft was made in, if any.
    pub fn workstream(&self) -> Option<&str> {
        match self {
            Origin::Chat { workstream, .. } | Origin::Run { workstream, .. } => workstream.as_deref(),
            Origin::Board | Origin::Autopilot { .. } => None,
        }
    }

    /// The `type` tag as stored, for the column lists narrow on.
    pub fn kind(&self) -> &'static str {
        match self {
            Origin::Chat { .. } => "chat",
            Origin::Board => "board",
            Origin::Autopilot { .. } => "autopilot",
            Origin::Run { .. } => "run",
        }
    }
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

/// Who drafted a proposal. `Agent` is a run's result turned into a draft by Gossamr; drafts stored before it existed
/// say `User` for that, and are treated alike wherever it matters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CreatedBy {
    User,
    Pip,
    Autopilot,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "reason", rename_all = "camelCase")]
pub enum ProposalState {
    Pending,
    /// A connector is executing it; nothing else may start it again.
    Applying,
    Applied,
    Skipped,
    Retired(String),
}

impl ProposalState {
    pub fn kind(&self) -> StateKind {
        match self {
            ProposalState::Pending => StateKind::Pending,
            ProposalState::Applying => StateKind::Applying,
            ProposalState::Applied => StateKind::Applied,
            ProposalState::Skipped => StateKind::Skipped,
            ProposalState::Retired(_) => StateKind::Retired,
        }
    }
}

/// A state without its payload, as stored in a column and used to select proposals.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StateKind {
    Pending,
    Applying,
    Applied,
    Skipped,
    Retired,
}

impl StateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StateKind::Pending => "pending",
            StateKind::Applying => "applying",
            StateKind::Applied => "applied",
            StateKind::Skipped => "skipped",
            StateKind::Retired => "retired",
        }
    }
}

/// Which proposals to list. Every field that is set must match.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalQuery {
    pub states: Option<Vec<StateKind>>,
    pub item: Option<ItemRef>,
    pub connection_id: Option<String>,
    #[serde(default)]
    pub workstream: Option<String>,
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
    pub updated_at: DateTime<Utc>,
    pub origin: Origin,
    pub created_by: CreatedBy,
    pub intent: Intent,
    /// What the approve button says, for intents that don't say it themselves (a transition's name).
    pub label: Option<String>,
    pub basis: Option<Basis>,
    pub state: ProposalState,
    #[serde(default)]
    pub revisions: Vec<Revision>,
    /// Items an attempt created before it stopped. For subtasks, entry `i` belongs to summary `i`, so a retry skips
    /// the ones already made.
    #[serde(default)]
    pub created: Vec<ItemRef>,
    /// Why the last attempt to apply it failed.
    pub error: Option<String>,
    /// The run an approved `StartRun` became.
    #[serde(default)]
    pub run: Option<String>,
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
    /// The existing item the proposal is about, if any.
    pub fn target(&self) -> Option<&ItemRef> {
        self.intent.target()
    }

    /// The workstream the draft belongs to: the one it was made in, else the one a run it would start is linked to.
    pub fn workstream(&self) -> Option<&str> {
        self.origin.workstream().or(match &self.intent {
            Intent::StartRun { spec, .. } => spec.workstream.as_deref(),
            _ => None,
        })
    }

    /// Applies a reconcile verdict. Only a pending proposal changes, and never to `Applied`.
    pub fn absorb(&mut self, verdict: Verdict, at: DateTime<Utc>) {
        if self.state != ProposalState::Pending {
            return;
        }
        match verdict {
            Verdict::Keep => {}
            Verdict::Retire { reason } => {
                self.state = ProposalState::Retired(reason);
                self.updated_at = at;
            }
            Verdict::Revise(revised) => {
                let Revised { note, intent, basis } = *revised;
                if let Some(intent) = intent {
                    self.intent = intent;
                }
                self.revisions.push(Revision { at, note, intent: self.intent.clone() });
                self.basis = Some(basis);
                self.updated_at = at;
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
        Intent::Rewrite { title, body, .. } => reconcile_rewrite(title.as_ref(), body.as_ref(), current),
        Intent::Subtasks { .. } | Intent::Create { .. } | Intent::StartRun { .. } | Intent::FollowUp { .. } => Verdict::Keep,
    }
}

/// A rewrite never absorbs someone else's edit into its basis: its text was written against the old one.
fn reconcile_rewrite(title: Option<&TitleChange>, body: Option<&BodyChange>, current: &WorkItem) -> Verdict {
    let title_done = title.is_none_or(|t| t.to == current.title);
    let body_done = body.is_none_or(|b| b.to == current.body);
    if title_done && body_done {
        return retire("the ticket already reads that way");
    }
    if title.is_some_and(|t| t.from != current.title) || body.is_some_and(|b| b.from != current.body) {
        return retire("the ticket's text changed since this was drafted");
    }
    Verdict::Keep
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
        if w.path(&current.status.id, to).is_none() {
            return retire("the target is not reachable from the current status");
        }
    }
    if basis.status_id == current.status.id {
        return Verdict::Keep;
    }
    Verdict::Revise(Box::new(Revised {
        note: format!("The item moved to {} since this was drafted.", current.status.name),
        intent: None,
        basis: fresh,
    }))
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
            updated_at: now(),
            origin: Origin::chat("r"),
            created_by: CreatedBy::Pip,
            intent,
            label: None,
            basis: Some(Basis::of(basis)),
            state: ProposalState::Pending,
            revisions: vec![],
            created: vec![],
            error: None,
            run: None,
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
    fn transition_revised_when_target_is_several_steps_away() {
        let drafted = work_item("1", "todo");
        let p = transition_to("done", &drafted);
        assert!(matches!(run(&p, &[work_item("1", "doing")]), Verdict::Revise(_)));
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
        assert_eq!(p.state, ProposalState::Retired("gone".into()));

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
    fn serialises_origin_and_state_the_way_the_page_reads_them() {
        let chat = serde_json::to_value(Origin::chat("r1")).unwrap();
        assert_eq!(chat, serde_json::json!({ "type": "chat", "requestId": "r1", "workstream": null }));
        let from_run = serde_json::to_value(Origin::Run { run_id: "r".into(), short_id: Some("ab12cd34".into()), workstream: Some("w1".into()) }).unwrap();
        assert_eq!(from_run, serde_json::json!({ "type": "run", "runId": "r", "shortId": "ab12cd34", "workstream": "w1" }));
        let retired = serde_json::to_value(ProposalState::Retired("gone".into())).unwrap();
        assert_eq!(retired, serde_json::json!({ "type": "retired", "reason": "gone" }));
        assert_eq!(serde_json::to_value(ProposalState::Applying).unwrap(), serde_json::json!({ "type": "applying" }));
    }

    #[test]
    fn serialises_intent_with_a_type_tag() {
        let json = serde_json::to_value(Intent::Subtasks { parent: item_ref("1"), summaries: vec!["a".into()] }).unwrap();
        assert_eq!(json["type"], "subtasks");
    }

    #[test]
    fn a_run_draft_is_kept_while_its_item_exists_and_retired_when_it_is_gone_and_its_spec_never_changes() {
        let item = work_item("1", "todo");
        let intent = Intent::StartRun { connection_id: "c".into(), item: Some(item.item.clone()), spec: run_spec() };
        let mut p = proposal(intent.clone(), &item);
        assert_eq!(run(&p, std::slice::from_ref(&item)), Verdict::Keep);

        let mut changed = work_item("1", "doing");
        changed.title = "Something else entirely".into();
        changed.comment_count = 4;
        let verdict = run(&p, std::slice::from_ref(&changed));
        assert_eq!(verdict, Verdict::Keep);
        p.absorb(verdict, now());
        assert_eq!((p.intent.clone(), p.revisions.len()), (intent, 0));

        assert!(matches!(run(&p, &[]), Verdict::Retire { .. }));
        let itemless = proposal(Intent::StartRun { connection_id: "c".into(), item: None, spec: run_spec() }, &item);
        assert_eq!(run(&itemless, &[]), Verdict::Keep);
    }

    #[test]
    fn a_run_draft_serialises_with_a_start_run_tag_and_camel_case_fields() {
        let json = serde_json::to_value(Intent::StartRun { connection_id: "c".into(), item: Some(item_ref("1")), spec: run_spec() }).unwrap();
        assert_eq!(json["type"], "startRun");
        assert_eq!(json["connectionId"], "c");
        assert_eq!(json["item"]["externalId"], "1");
        assert_eq!(json["spec"]["clonePath"], "/Users/me/Code/webshop");
        let back: Intent = serde_json::from_value(json).unwrap();
        assert_eq!(back.target(), Some(&item_ref("1")));
    }

    fn rewrite_of(item: &WorkItem, title: Option<&str>, body: Option<&str>) -> Proposal {
        let intent = Intent::Rewrite {
            item: item.item.clone(),
            title: title.map(|to| TitleChange { from: item.title.clone(), to: to.into() }),
            body: body.map(|to| BodyChange { from: item.body.clone(), to: Doc::from_markdown(to, &[]) }),
            flattened: vec![],
        };
        proposal(intent, item)
    }

    #[test]
    fn a_rewrite_is_kept_while_the_text_it_replaces_is_unchanged() {
        let mut item = work_item("1", "todo");
        item.body = Doc::paragraph("old");
        let p = rewrite_of(&item, Some("New title"), Some("new"));
        assert_eq!(run(&p, std::slice::from_ref(&item)), Verdict::Keep);
        let mut elsewhere = item.clone();
        elsewhere.status = crate::domain::fixtures::status("doing");
        elsewhere.comment_count = 3;
        assert_eq!(run(&p, &[elsewhere]), Verdict::Keep, "only the text it rewrites matters");
    }

    #[test]
    fn a_rewrite_is_retired_when_someone_else_changed_the_text_it_replaces() {
        let mut item = work_item("1", "todo");
        item.body = Doc::paragraph("old");
        let p = rewrite_of(&item, Some("New title"), Some("new"));
        let mut retitled = item.clone();
        retitled.title = "Someone else's title".into();
        let mut reworded = item.clone();
        reworded.body = Doc::paragraph("someone else's text");
        for changed in [retitled, reworded] {
            assert!(matches!(run(&p, &[changed]), Verdict::Retire { ref reason } if reason.contains("text changed")));
        }
        let only_body = rewrite_of(&item, None, Some("new"));
        let mut retitled = item.clone();
        retitled.title = "Other".into();
        assert_eq!(run(&only_body, &[retitled]), Verdict::Keep, "a title nobody asked to change doesn't matter");
    }

    #[test]
    fn a_rewrite_is_retired_once_the_ticket_already_reads_that_way() {
        let mut item = work_item("1", "todo");
        item.body = Doc::paragraph("old");
        let p = rewrite_of(&item, None, Some("new"));
        let mut done = item.clone();
        done.body = Doc::from_markdown("new", &[]);
        assert!(matches!(run(&p, &[done]), Verdict::Retire { ref reason } if reason.contains("already reads")));
    }

    #[test]
    fn a_rewrite_serialises_with_markdown_beside_the_documents_and_reads_back() {
        let item = work_item("1", "todo");
        let mut with_body = item.clone();
        with_body.body = Doc::from_markdown("# Old\n\n- a", &[]);
        let intent = rewrite_of(&with_body, Some("New"), Some("# New\n\n- b")).intent;
        let json = serde_json::to_value(&intent).unwrap();
        assert_eq!(json["type"], "rewrite");
        assert_eq!(json["title"], serde_json::json!({ "from": "Task 1", "to": "New" }));
        assert_eq!(json["body"]["fromText"], "# Old\n\n- a");
        assert_eq!(json["body"]["toText"], "# New\n\n- b");
        assert_eq!(json["body"]["to"]["blocks"][0]["type"], "heading");
        assert_eq!(json["flattened"], serde_json::json!([]));
        assert_eq!(serde_json::from_value::<Intent>(json).unwrap(), intent);
        assert_eq!(intent.target(), Some(&item_ref("1")));
    }

    #[test]
    fn a_rewrite_stored_without_flattened_still_reads() {
        let json = serde_json::json!({ "type": "rewrite", "item": item_ref("1"), "title": null, "body": { "from": { "blocks": [] }, "to": { "blocks": [] } } });
        assert!(matches!(serde_json::from_value::<Intent>(json).unwrap(), Intent::Rewrite { flattened, .. } if flattened.is_empty()));
    }

    #[test]
    fn agent_is_a_copyable_maker_that_serialises_as_agent() {
        let by = CreatedBy::Agent;
        let copied = by;
        assert_eq!((by, copied), (CreatedBy::Agent, CreatedBy::Agent));
        assert_eq!(serde_json::to_value(by).unwrap(), serde_json::json!("agent"));
        assert_eq!(serde_json::from_value::<CreatedBy>(serde_json::json!("agent")).unwrap(), CreatedBy::Agent);
        assert_eq!(serde_json::from_value::<CreatedBy>(serde_json::json!("user")).unwrap(), CreatedBy::User);
    }

    #[test]
    fn proposals_stored_before_workstreams_still_read_and_round_trip() {
        let stored = |origin: serde_json::Value, by: &str| {
            serde_json::json!({
                "id": "p1", "createdAt": "2026-09-01T10:00:00Z", "updatedAt": "2026-09-01T10:00:00Z",
                "origin": origin, "createdBy": by,
                "intent": { "type": "comment", "item": item_ref("1"), "body": { "blocks": [] } },
                "label": null, "basis": null, "state": { "type": "pending" }, "revisions": [], "created": [], "error": null, "run": null
            })
        };
        let chat: Proposal = serde_json::from_value(stored(serde_json::json!({ "type": "chat", "requestId": "q1" }), "pip")).unwrap();
        assert_eq!((chat.origin.clone(), chat.workstream()), (Origin::chat("q1"), None));
        let from_run: Proposal = serde_json::from_value(stored(serde_json::json!({ "type": "run", "runId": "r", "shortId": null }), "user")).unwrap();
        assert_eq!(from_run.origin, Origin::Run { run_id: "r".into(), short_id: None, workstream: None });
        assert_eq!(from_run.created_by, CreatedBy::User);
        for p in [chat, from_run] {
            let back: Proposal = serde_json::from_value(serde_json::to_value(&p).unwrap()).unwrap();
            assert_eq!(back, p);
        }
    }

    #[test]
    fn a_draft_belongs_to_its_origin_s_workstream_or_else_the_one_of_the_run_it_would_start() {
        let item = work_item("1", "todo");
        let mut p = comment_on(&item);
        assert_eq!(p.workstream(), None);
        p.origin = Origin::Chat { request_id: "r".into(), workstream: Some("w1".into()) };
        assert_eq!(p.workstream(), Some("w1"));
        let spec = RunSpec { workstream: Some("w2".into()), ..run_spec() };
        let mut start = proposal(Intent::StartRun { connection_id: "c".into(), item: None, spec }, &item);
        assert_eq!(start.workstream(), Some("w2"));
        start.origin = Origin::Board;
        assert_eq!((start.workstream(), start.origin.kind()), (Some("w2"), "board"));
        let query: ProposalQuery = serde_json::from_value(serde_json::json!({ "workstream": "w1" })).unwrap();
        assert_eq!(query.workstream.as_deref(), Some("w1"));
    }
}
