//! Connector-neutral model. Everything above the connector line speaks these types.
//!
//! Items, workflows, docs, people, comments, intents and filters are used by the trackers. Events, proposals with
//! `reconcile`, local filter evaluation and workflow paths wait for their consumers (1a, 1b, 3b, 4a); drop the allow
//! below once they have one.
#![allow(dead_code, unused_imports)]

mod doc;
mod event;
mod filter;
mod item;
mod proposal;
mod workflow;

pub use doc::{Block, Doc, Inline, Mark};
pub use event::{CheckState, CodeChange, CodeChangeState, Event, EventKind, Subject};
pub use filter::{Filter, FilterContext};
pub use item::{
    Comment, Container, ContainerRef, Identity, ItemKind, ItemRef, Link, LinkKind, Person,
    PersonRef, Priority, WorkItem,
};
pub use proposal::{
    reconcile, Basis, Intent, NewItem, Origin, Patch, Proposal, ProposalState, ReconcileContext,
    Revised, Revision, Verdict,
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
        }
    }
}
