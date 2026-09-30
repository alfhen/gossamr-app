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
mod watch;
mod workflow;

pub use doc::{Block, Doc, Inline, Mark};
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
    reconcile, Basis, CreatedBy, Intent, NewItem, Origin, Patch, Proposal, ProposalQuery, ProposalState, ReconcileContext,
    Revised, Revision, StateKind, Verdict,
};
pub use watch::{
    ContainerPage, ContainerQuery, ContainerScope, ContainerSummary, Depth, Footprint, Stray, Visible, Watch, WatchChange, WatchMode, WatchSet,
    WatchSource, AUTO_EVERYTHING_MAX,
};
pub use workflow::{Category, StatusDef, StatusRef, Transition, Transitions, Workflow};

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
