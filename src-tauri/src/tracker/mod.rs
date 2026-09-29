//! Work trackers behind one trait. Core holds an `Arc<dyn WorkTracker>` per connection and speaks domain types.
//!
//! Until the cache is rebuilt on domain types, a tracker also leaves the ticket the current inbox reads in
//! `WorkItem::extra`, so Core never needs a tracker's own client.

// Search by filter, containers, workflows, comments and capabilities have no caller until the cache and sync are
// built on domain types.
#![allow(dead_code)]

mod jira;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::auth::{Auth, Scope};
use crate::domain::{Comment, Container, ContainerRef, Doc, Filter, Intent, ItemRef, Person, StatusDef, WorkItem, Workflow};
use crate::error::Result;
use crate::model::Uploaded;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    Jira,
}

/// One signed-in account on one workspace (a Jira site, a Linear organisation).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub kind: ConnectionKind,
    pub workspace: String,
    pub account: String,
    pub display_name: String,
}

impl Connection {
    pub fn jira(scope: &Scope, display_name: &str) -> Self {
        Self {
            id: format!("jira:{}:{}", scope.cloud_id, scope.account_id),
            kind: ConnectionKind::Jira,
            workspace: scope.cloud_id.clone(),
            account: scope.account_id.clone(),
            display_name: display_name.into(),
        }
    }

    pub fn item(&self, key: &str) -> ItemRef {
        ItemRef { connection_id: self.id.clone(), external_id: key.into(), key: key.into() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionModel {
    /// Any status can follow any other.
    Any,
    /// A workflow lists its moves.
    Graph,
    /// Moves are only known for a particular item, through `WorkTracker::transitions`.
    PerItem,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Grouping {
    Epics,
    Projects,
    Cycles,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerCaps {
    pub subtasks: bool,
    pub mentions: bool,
    pub attachments: bool,
    pub transitions: TransitionModel,
    pub grouping: Grouping,
    pub custom_workflows: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    /// Stop paging once this many items are collected. A page may overshoot it.
    pub limit: usize,
    /// Include each item's history back to at least this time (RFC 3339), for deriving events.
    pub history_since: Option<String>,
}

/// A way to move an item, as offered to the person.
#[derive(Clone, Debug, PartialEq)]
pub struct Move {
    pub name: String,
    pub to: StatusDef,
}

/// What a write did. Creating several things can stop part-way, so `error` accompanies whatever was created.
#[derive(Debug, Default)]
pub struct Applied {
    pub created: Vec<ItemRef>,
    pub error: Option<crate::error::Error>,
}

#[async_trait]
pub trait WorkTracker: Send + Sync {
    fn capabilities(&self) -> TrackerCaps;

    /// Items the filter can match, narrowed on the server as far as the tracker can express it. The result may
    /// include items the filter would reject, so apply `Filter::select` to it. Fails when nothing of the filter can
    /// be expressed.
    async fn search(&self, filter: &Filter, opts: &SearchOptions) -> Result<Vec<WorkItem>>;

    /// A query in the tracker's own language, for tools that still speak it.
    async fn search_native(&self, query: &str, opts: &SearchOptions) -> Result<Vec<WorkItem>>;

    /// Items the signed-in person is involved in that changed within `window_days`, newest first.
    async fn followed(&self, window_days: u32, opts: &SearchOptions) -> Result<Vec<WorkItem>>;

    /// Items directly under any of `parents`.
    async fn children(&self, parents: &[ItemRef], opts: &SearchOptions) -> Result<Vec<WorkItem>>;

    async fn item(&self, item: &ItemRef, history_since: &str) -> Result<WorkItem>;

    async fn containers(&self) -> Result<Vec<Container>>;

    async fn workflow(&self, container: &ContainerRef) -> Result<Workflow>;

    async fn comments(&self, item: &ItemRef) -> Result<Vec<Comment>>;

    /// The moves open to `item` right now. A move's target is a status id of the item's workflow.
    async fn transitions(&self, item: &ItemRef) -> Result<Vec<Move>>;

    /// People who can see `item` and match `query`, for @mentions.
    async fn people(&self, item: &ItemRef, query: &str) -> Result<Vec<Person>>;

    /// The only write path. `files` are uploads to show in a comment; other intents reject them.
    async fn apply_with_files(&self, intent: &Intent, files: &[Uploaded]) -> Result<Applied>;

    async fn apply(&self, intent: &Intent) -> Result<Applied> {
        self.apply_with_files(intent, &[]).await
    }

    async fn attach(&self, item: &ItemRef, filename: &str, mime_type: &str, bytes: Vec<u8>) -> Result<Uploaded>;

    /// The per-file upload limit in bytes, or `None` when attachments are off.
    async fn attachment_limit(&self) -> Result<Option<u64>>;

    /// Where an attachment lives in the tracker's media service, if it says.
    async fn media_id(&self, attachment_id: &str) -> Result<Option<String>>;

    /// An attachment's content type and bytes.
    async fn download(&self, attachment_id: &str) -> Result<(String, Vec<u8>)>;
}

type Factory = Box<dyn Fn(&Connection) -> Arc<dyn WorkTracker> + Send + Sync>;

/// The trackers Core can reach, one per connection, created on first use.
pub struct Registry {
    factory: Factory,
    trackers: Mutex<HashMap<String, Arc<dyn WorkTracker>>>,
}

impl Registry {
    pub fn new(factory: impl Fn(&Connection) -> Arc<dyn WorkTracker> + Send + Sync + 'static) -> Self {
        Self { factory: Box::new(factory), trackers: Mutex::new(HashMap::new()) }
    }

    pub fn jira(http: reqwest::Client, auth: Arc<Auth>) -> Self {
        Self::new(move |c| Arc::new(jira::JiraTracker::new(http.clone(), auth.clone(), c)))
    }

    pub fn tracker(&self, connection: &Connection) -> Arc<dyn WorkTracker> {
        let mut trackers = self.trackers.lock().expect("registry lock poisoned");
        trackers.entry(connection.id.clone()).or_insert_with(|| (self.factory)(connection)).clone()
    }
}

/// A plain-text comment as a document: blank lines separate paragraphs and `@Name` for each of `mentions` becomes a
/// mention.
pub fn comment_doc(text: &str, mentions: &[(crate::domain::PersonRef, String)]) -> Doc {
    Doc::from_text(text, mentions)
}

#[cfg(test)]
pub(crate) mod testing {
    use crate::model::CachedTicket;

    pub fn sample_ticket() -> CachedTicket {
        super::jira::parse_issue(&super::jira::sample_issue()).expect("sample issue parses")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn a_tracker_is_created_once_per_connection() {
        let made = Arc::new(AtomicUsize::new(0));
        let counter = made.clone();
        let http = reqwest::Client::new();
        let auth = Arc::new(Auth::signed_out(http.clone()));
        let registry = Registry::new(move |c| {
            counter.fetch_add(1, Ordering::SeqCst);
            Arc::new(jira::JiraTracker::new(http.clone(), auth.clone(), c))
        });
        let scope = |account: &str| Scope { cloud_id: "site".into(), account_id: account.into() };
        let a = Connection::jira(&scope("a"), "Site");
        let b = Connection::jira(&scope("b"), "Site");
        registry.tracker(&a);
        registry.tracker(&a);
        registry.tracker(&b);
        assert_eq!(made.load(Ordering::SeqCst), 2);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn item_refs_carry_the_connection_and_key() {
        let c = Connection::jira(&Scope { cloud_id: "site".into(), account_id: "me".into() }, "Site");
        let r = c.item("CA-1");
        assert_eq!((r.connection_id.as_str(), r.external_id.as_str(), r.key.as_str()), ("jira:site:me", "CA-1", "CA-1"));
    }
}
