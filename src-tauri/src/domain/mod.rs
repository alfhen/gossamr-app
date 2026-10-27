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

pub use doc::{Block, Doc, Inline, Mark, PLAN_HEADING, TRIAGE_HEADING};
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
    reconcile, Basis, BodyChange, CreatedBy, DiffSide, Intent, MaybePosted, PostedReview, ReviewComment, TitleChange, DESCRIPTION_LIMIT, SUMMARY_LIMIT, NewItem, Origin, Patch, Proposal, ProposalQuery, ProposalState, ReconcileContext,
    Revised, Revision, StateKind, Verdict,
};
pub use run::{
    agent_allow_rules, has_markers, render_prompt, valid_repo, without_markers, ClonePlan, Continuation, EarlierSession, LegacySpec, Role, Run, RunEvent, RefusedMode, RunFailure, RunQuery, RunSpec, RunState,
    PIP_BRIEF_LIMIT, ROLE_LIMIT, GUARD, GUARD_VERSION, AGENT_CALL_TIMEOUT_MS, AGENT_GUARD, AGENT_SERVER, AGENT_TOOLS, ASK_TOOL, READ_TICKET_TOOL, READ_WORKSTREAM_TOOL, REPORT_TOOL, REPORT_TOOL_VERSION, PLAN_LIMIT, TICKET_BLOCK_LIMIT, TITLE_LIMIT,
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
            role: Role::parse("investigate").unwrap(),
            repo: "acme/webshop".into(),
            clone_path: "/Users/me/Code/webshop".into(),
            base: "main".into(),
            name: "eng-1-fix-cart-3f9a".into(),
            brief: "Find out why the cart total is wrong.".into(),
            ticket: None,
            ticket_block: None,
            pr: None,
            pr_sha: None,
            report: false,
            workstream: None,
            earlier: LegacySpec::default(),
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
