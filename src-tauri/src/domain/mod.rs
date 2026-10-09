//! Connector-neutral model. Everything above the connector line speaks these types.
//!
//! Items, workflows, containers, events, filters, docs, people and comments are used by the trackers and the cache.
//! Proposals with `reconcile`, code changes and workflow paths wait for their consumers (1b, 3b, 4a); drop the allow
//! below once they have one.
#![allow(dead_code, unused_imports)]

mod code;
mod doc;
mod event;
mod filter;
mod item;
mod proposal;
mod run;
mod snapshot;
mod watch;
mod workflow;
pub mod workstream;

pub use doc::{Block, Doc, Inline, Mark, PLAN_HEADING};
pub use code::{
    clip, ChangedFile, CheckState, CodeChange, CodeChangeKind, CodeChangeState, CodeFile, CodeHit, CommitInfo, CommitQuery, Notice, TreeEntry, TreeEntryKind, DevLink, LinkSource, PullRequestDetail, ReviewInfo, ReviewState, BODY_LIMIT,
};
pub use event::{Event, EventKind, FeedCursor, FeedEntry, FeedPage, FeedQuery, Subject};
pub use filter::{Filter, FilterContext};
pub use item::{
    Comment, Container, ContainerRef, Identity, ItemKind, ItemRef, Link, LinkKind, Person,
    PersonRef, Priority, WorkItem,
};
pub use proposal::{
    reconcile, Basis, BodyChange, CreatedBy, Intent, TitleChange, DESCRIPTION_LIMIT, SUMMARY_LIMIT, NewItem, Origin, Patch, Proposal, ProposalQuery, ProposalState, ReconcileContext,
    Revised, Revision, StateKind, Verdict,
};
pub use run::{
    allowed_kinds, default_instruction, has_markers, pip_chain_kinds, pip_kinds, render_prompt, valid_repo, without_markers, ClonePlan, Continuation, EarlierSession, ReportOffer, Run, RunEvent, RunFailure, RunKind, RunQuery, RunReview, RunSpec, RunState, FOCUS_LIMIT, LIMIT_STOP, PIP_PROMPT_LIMIT, GUARD, GUARD_VERSION, INVESTIGATE_INSTRUCTION, REPORT_GUARD, REPORT_SERVER, REPORT_TOOL, REPORT_TOOL_VERSION,
    NEW_TICKET_TAIL, PLAN_LIMIT, BUILD_ACCOUNT_LIMIT, FINDINGS_LIMIT, plan_label, build_account_label, findings_label, TICKET_BLOCK_LIMIT, TICKETLESS_STARTER, TITLE_LIMIT,
};
pub use snapshot::{ticket_snapshot, SnapComment, TicketFacts};
pub use watch::{
    ContainerPage, ContainerQuery, ContainerScope, ContainerSummary, Depth, Footprint, Stray, Visible, Watch, WatchChange, WatchMode, WatchSet,
    WatchSource, AUTO_EVERYTHING_MAX,
};
pub use workflow::{Category, StatusDef, StatusRef, Transition, Transitions, Workflow};
pub use workstream::{Actor, Workstream, WorkstreamEvent};

#[cfg(test)]
pub(crate) mod fixtures {
    use chrono::{DateTime, TimeZone, Utc};

    use super::*;

    pub fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 29, 12, 0, 0).unwrap()
    }

    pub fn person(id: &str) -> PersonRef {
        PersonRef { connection_id: "c".into(), account_id: id.into() }
    }

    pub fn item_ref(id: &str) -> ItemRef {
        ItemRef { connection_id: "c".into(), external_id: id.into(), key: format!("ENG-{id}") }
    }

    pub fn status(id: &str) -> StatusRef {
        let category = match id {
            "todo" => Category::Todo,
            "done" => Category::Done,
            _ => Category::Active,
        };
        StatusDef { id: id.into(), name: id.to_uppercase(), category }
    }

    pub fn run_spec() -> RunSpec {
        RunSpec {
            kind: RunKind::Investigate,
            repo: "acme/webshop".into(),
            clone_path: "/Users/me/Code/webshop".into(),
            base: "main".into(),
            name: "eng-1-fix-cart-3f9a".into(),
            instruction: "Find out why the cart total is wrong.".into(),
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
            workstream: None,
        }
    }

    pub fn work_item(id: &str, status_id: &str) -> WorkItem {
        WorkItem {
            item: item_ref(id),
            container: ContainerRef { connection_id: "c".into(), external_id: "p".into() },
            kind: ItemKind::Task,
            title: format!("Task {id}"),
            body: Doc::default(),
            status: status(status_id),
            assignee: None,
            reporter: None,
            priority: None,
            parent: None,
            labels: vec![],
            created: now(),
            updated: now(),
            links: vec![],
            comment_count: 0,
            last_commenter: None,
            extra: serde_json::Value::Null,
            unwatched: false,
        }
    }
}
