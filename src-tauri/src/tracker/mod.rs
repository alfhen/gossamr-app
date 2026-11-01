//! Work trackers behind one trait. Core holds an `Arc<dyn WorkTracker>` per connection and speaks domain types.
//!
//! Until the inbox is rebuilt on domain types, a tracker also leaves the ticket it reads in `WorkItem::extra`, so
//! Core never needs a tracker's own client.

// Search by filter, comments and capabilities wait for the views and the assistant that will call them.
#![allow(dead_code)]

mod jira;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::auth::Auth;
use crate::domain::{
    Comment, Container, ContainerPage, ContainerQuery, ContainerRef, ContainerScope, Doc, Filter, Footprint, ItemRef, Person, StatusDef, Stray,
    WorkItem, Workflow, Write,
};
use crate::error::Result;
use crate::model::Uploaded;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    Jira,
    Github,
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
    /// A GitHub account or organisation the person signed in to. `login` is the account the token belongs to.
    pub fn github(login: &str, display_name: &str) -> Self {
        Self { id: Self::github_id(login), kind: ConnectionKind::Github, workspace: login.into(), account: login.into(), display_name: display_name.into() }
    }

    /// The Jira connection that `SiteScope::connection_id` made `id` from, which is all its cache file name needs.
    pub fn from_jira_id(id: &str) -> Option<Self> {
        let (workspace, account) = id.strip_prefix("jira:")?.split_once(':')?;
        (!workspace.is_empty() && !account.is_empty())
            .then(|| Self { id: id.into(), kind: ConnectionKind::Jira, workspace: workspace.into(), account: account.into(), display_name: String::new() })
    }

    pub fn github_id(login: &str) -> String {
        format!("github:{}", login.to_ascii_lowercase())
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
    /// Can replace an item's title and description.
    pub edit_text: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    /// Stop paging once this many items are collected. A page may overshoot it.
    pub limit: usize,
    /// Include each item's history back to at least this time (RFC 3339), for deriving events.
    pub history_since: Option<String>,
    /// Only items changed within this many minutes, for `followed` and `children`. A tracker may ignore it and
    /// return more.
    pub updated_since_minutes: Option<u32>,
}

/// What a scoped read of followed items found.
#[derive(Debug, Default)]
pub struct Followed {
    pub items: Vec<WorkItem>,
    /// Containers the tracker refused and the query went on without.
    pub inaccessible: Vec<ContainerRef>,
}

/// A way to move an item, as offered to the person.
#[derive(Clone, Debug, PartialEq, Serialize)]
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

    /// Items in `scope` that changed within `window_days`, newest first, the ones the signed-in
    /// person is involved in. A container the tracker refuses
    /// is left out of the read and reported, rather than failing it.
    async fn followed(&self, window_days: u32, scope: &ContainerScope, opts: &SearchOptions) -> Result<Followed>;

    /// Items directly under any of `parents`.
    async fn children(&self, parents: &[ItemRef], opts: &SearchOptions) -> Result<Vec<WorkItem>>;

    async fn item(&self, item: &ItemRef, history_since: &str) -> Result<WorkItem>;

    /// Every container with its workflow.
    async fn containers(&self) -> Result<Vec<Container>>;

    /// One page of the catalog, matching `q.query` on the server. No workflows, so it stays cheap for thousands.
    async fn list_containers(&self, q: &ContainerQuery) -> Result<ContainerPage>;

    /// The containers among `refs` that exist and can be read, with their workflows. Missing ones are left out.
    async fn containers_of(&self, refs: &[ContainerRef]) -> Result<Vec<Container>>;

    /// Where the person has been involved in the last `window_days`, for suggesting what to watch. Counts only.
    async fn footprint(&self, _window_days: u32) -> Result<Vec<Footprint>> {
        Err(crate::error::Error::Api { status: 501, message: "this tracker can't suggest containers".into() })
    }

    /// Open items assigned to the person outside `watched`, as keys grouped by container.
    async fn assigned_outside(&self, _watched: &[ContainerRef]) -> Result<Vec<Stray>> {
        Ok(Vec::new())
    }

    async fn workflow(&self, container: &ContainerRef) -> Result<Workflow>;

    async fn comments(&self, item: &ItemRef) -> Result<Vec<Comment>>;

    /// The moves open to `item` right now. A move's target is a status id of the item's workflow.
    async fn transitions(&self, item: &ItemRef) -> Result<Vec<Move>>;

    /// People who can see `item` and match `query`, for @mentions.
    async fn people(&self, item: &ItemRef, query: &str) -> Result<Vec<Person>>;

    /// The only write path. `files` are uploads to show in a comment; other writes reject them.
    async fn apply_with_files(&self, write: &Write, files: &[Uploaded]) -> Result<Applied>;

    async fn apply(&self, write: &Write) -> Result<Applied> {
        self.apply_with_files(write, &[]).await
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
    connections: Mutex<HashMap<String, Connection>>,
    trackers: Mutex<HashMap<String, Arc<dyn WorkTracker>>>,
}

impl Registry {
    pub fn new(factory: impl Fn(&Connection) -> Arc<dyn WorkTracker> + Send + Sync + 'static) -> Self {
        Self { factory: Box::new(factory), connections: Mutex::new(HashMap::new()), trackers: Mutex::new(HashMap::new()) }
    }

    pub fn jira(http: reqwest::Client, auth: Arc<Auth>) -> Self {
        Self::new(move |c| Arc::new(jira::JiraTracker::new(http.clone(), auth.clone(), c)))
    }

    /// Adds a signed-in connection, or replaces it after a new sign-in so its tracker is built from the new details.
    pub fn register(&self, connection: Connection) {
        self.trackers.lock().expect("registry lock poisoned").remove(&connection.id);
        self.connections.lock().expect("registry lock poisoned").insert(connection.id.clone(), connection);
    }

    pub fn connection(&self, id: &str) -> Option<Connection> {
        self.connections.lock().expect("registry lock poisoned").get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        self.trackers.lock().expect("registry lock poisoned").remove(id);
        self.connections.lock().expect("registry lock poisoned").remove(id);
    }

    pub fn tracker(&self, connection: &Connection) -> Arc<dyn WorkTracker> {
        let mut trackers = self.trackers.lock().expect("registry lock poisoned");
        trackers.entry(connection.id.clone()).or_insert_with(|| (self.factory)(connection)).clone()
    }
}

/// A ticket stored before the cache existed, as the work item a sync of `connection` would have produced. `None` for a
/// connection that never stored tickets.
pub fn item_from_ticket(connection: &Connection, t: &crate::model::CachedTicket) -> Option<WorkItem> {
    match connection.kind {
        ConnectionKind::Jira => Some(jira::item_from_ticket(&connection.id, t)),
        ConnectionKind::Github => None,
    }
}

/// The comments a stored ticket carries, oldest first.
pub fn comments_from_ticket(connection: &Connection, t: &crate::model::CachedTicket) -> Vec<Comment> {
    match connection.kind {
        ConnectionKind::Jira => jira::comments_from_ticket(&connection.id, t),
        ConnectionKind::Github => Vec::new(),
    }
}

/// What replacing `t`'s description with a `Doc` would flatten to plain text, by name.
pub fn flattened_by_rewrite(connection: &Connection, t: &crate::model::CachedTicket) -> Vec<String> {
    match connection.kind {
        ConnectionKind::Jira => t.description_doc.as_ref().map(jira::flattened).unwrap_or_default(),
        ConnectionKind::Github => Vec::new(),
    }
}

/// A plain-text comment as a document: blank lines separate paragraphs and `@Name` for each of `mentions` becomes a
/// mention.
pub fn comment_doc(text: &str, mentions: &[(crate::domain::PersonRef, String)]) -> Doc {
    Doc::from_text(text, mentions)
}

#[cfg(test)]
pub(crate) mod testing {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::model::CachedTicket;

    /// A tracker that only records what it is asked to apply and answers from a script (success when it runs out).
    #[derive(Default)]
    pub struct Recorder {
        pub applied: Mutex<Vec<Write>>,
        pub script: Mutex<VecDeque<Result<Applied>>>,
        pub moves: Mutex<Vec<Move>>,
        /// What `comments` returns; `None` fails the request, as an offline tracker would.
        pub comments: Mutex<Option<Vec<Comment>>>,
        /// What `list_containers` returns.
        pub catalog: Mutex<Vec<crate::domain::ContainerSummary>>,
        /// What `footprint` returns, and how many times it was asked.
        pub footprint: Mutex<Vec<Footprint>>,
        pub footprint_calls: std::sync::atomic::AtomicUsize,
        /// What `assigned_outside` returns.
        pub strays: Mutex<Vec<Stray>>,
        /// What `item` returns instead of the sample ticket, as Jira would after someone edited it.
        pub live: Mutex<Option<WorkItem>>,
        /// Makes the tracker say it can't edit text.
        pub cannot_edit_text: std::sync::atomic::AtomicBool,
        /// Makes an applied description rewrite or transition change `live`, as Jira would.
        pub writes_live: std::sync::atomic::AtomicBool,
    }

    impl Recorder {
        pub fn will(&self, outcome: Result<Applied>) {
            self.script.lock().unwrap().push_back(outcome);
        }

        /// What was applied, as the drafts that produce those writes.
        pub fn intents(&self) -> Vec<crate::domain::Intent> {
            self.applied.lock().unwrap().iter().cloned().map(Into::into).collect()
        }
    }

    #[async_trait]
    impl WorkTracker for Recorder {
        fn capabilities(&self) -> TrackerCaps {
            let edit_text = !self.cannot_edit_text.load(std::sync::atomic::Ordering::SeqCst);
            TrackerCaps { subtasks: true, mentions: true, attachments: true, transitions: TransitionModel::PerItem, grouping: Grouping::Epics, custom_workflows: true, edit_text }
        }
        async fn search(&self, _: &Filter, _: &SearchOptions) -> Result<Vec<WorkItem>> {
            unimplemented!()
        }
        async fn search_native(&self, _: &str, _: &SearchOptions) -> Result<Vec<WorkItem>> {
            unimplemented!()
        }
        async fn followed(&self, _: u32, _: &ContainerScope, _: &SearchOptions) -> Result<Followed> {
            Ok(Followed::default())
        }
        async fn children(&self, _: &[ItemRef], _: &SearchOptions) -> Result<Vec<WorkItem>> {
            Ok(Vec::new())
        }
        async fn item(&self, item: &ItemRef, _: &str) -> Result<WorkItem> {
            if let Some(live) = self.live.lock().unwrap().clone() {
                return Ok(live);
            }
            let connection = Connection { id: item.connection_id.clone(), kind: ConnectionKind::Jira, workspace: "site".into(), account: "me".into(), display_name: "Site".into() };
            let mut fresh = item_from_ticket(&connection, &sample_ticket()).expect("a Jira ticket");
            fresh.item = item.clone();
            Ok(fresh)
        }
        async fn containers(&self) -> Result<Vec<Container>> {
            Ok(Vec::new())
        }
        async fn list_containers(&self, q: &ContainerQuery) -> Result<ContainerPage> {
            let all = self.catalog.lock().unwrap();
            let needle = q.query.to_lowercase();
            let containers = all.iter().filter(|c| c.key.to_lowercase().contains(&needle) || c.name.to_lowercase().contains(&needle)).take(q.limit.max(1)).cloned().collect();
            Ok(ContainerPage { containers, next: None })
        }
        async fn containers_of(&self, _: &[ContainerRef]) -> Result<Vec<Container>> {
            Ok(Vec::new())
        }
        async fn footprint(&self, _: u32) -> Result<Vec<Footprint>> {
            self.footprint_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.footprint.lock().unwrap().clone())
        }
        async fn assigned_outside(&self, _: &[ContainerRef]) -> Result<Vec<Stray>> {
            Ok(self.strays.lock().unwrap().clone())
        }
        async fn workflow(&self, _: &ContainerRef) -> Result<Workflow> {
            unimplemented!()
        }
        async fn comments(&self, _: &ItemRef) -> Result<Vec<Comment>> {
            self.comments.lock().unwrap().clone().ok_or(crate::error::Error::Api { status: 503, message: "offline".into() })
        }
        async fn transitions(&self, _: &ItemRef) -> Result<Vec<Move>> {
            Ok(self.moves.lock().unwrap().clone())
        }
        async fn people(&self, _: &ItemRef, _: &str) -> Result<Vec<Person>> {
            unimplemented!()
        }
        async fn apply_with_files(&self, write: &Write, _: &[Uploaded]) -> Result<Applied> {
            self.applied.lock().unwrap().push(write.clone());
            if self.writes_live.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(live) = self.live.lock().unwrap().as_mut() {
                    match write {
                        Write::Rewrite { body: Some(change), .. } => live.body = change.to.clone(),
                        Write::Transition { to, .. } => live.status.id = to.clone(),
                        _ => {}
                    }
                }
            }
            self.script.lock().unwrap().pop_front().unwrap_or_else(|| Ok(Applied::default()))
        }
        async fn attach(&self, _: &ItemRef, _: &str, _: &str, _: Vec<u8>) -> Result<Uploaded> {
            unimplemented!()
        }
        async fn attachment_limit(&self) -> Result<Option<u64>> {
            unimplemented!()
        }
        async fn media_id(&self, _: &str) -> Result<Option<String>> {
            unimplemented!()
        }
        async fn download(&self, _: &str) -> Result<(String, Vec<u8>)> {
            unimplemented!()
        }
    }

    pub fn sample_ticket() -> CachedTicket {
        super::jira::parse_issue(&super::jira::sample_issue()).expect("sample issue parses")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::auth::SiteScope;

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
        let scope = |account: &str| SiteScope { cloud_id: "site".into(), account_id: account.into() };
        let a = scope("a").connection("Site");
        let b = scope("b").connection("Site");
        registry.tracker(&a);
        registry.tracker(&a);
        registry.tracker(&b);
        assert_eq!(made.load(Ordering::SeqCst), 2);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn item_refs_carry_the_connection_and_key() {
        let c = SiteScope { cloud_id: "site".into(), account_id: "me".into() }.connection("Site");
        let r = c.item("CA-1");
        assert_eq!((r.connection_id.as_str(), r.external_id.as_str(), r.key.as_str()), ("jira:site:me", "CA-1", "CA-1"));
    }

    #[test]
    fn a_code_host_connection_has_no_stored_tickets_to_read_back() {
        let github = Connection::github("ann", "Ann");
        let ticket = testing::sample_ticket();
        assert!(item_from_ticket(&github, &ticket).is_none());
        assert!(comments_from_ticket(&github, &ticket).is_empty());
        let jira = SiteScope { cloud_id: "site".into(), account_id: "me".into() }.connection("Site");
        assert!(item_from_ticket(&jira, &ticket).is_some());
    }

    #[test]
    fn a_jira_connection_id_keeps_the_stored_format() {
        let scope = SiteScope { cloud_id: "c1".into(), account_id: "712020:ab".into() };
        assert_eq!(scope.connection_id(), "jira:c1:712020:ab");
        assert_eq!(scope.scope().connection_id, scope.connection("Acme").id);
    }

    #[test]
    fn a_registered_connection_can_be_found_and_removed() {
        let registry = Registry::new(|_| unreachable!("no tracker is built here"));
        let c = SiteScope { cloud_id: "site".into(), account_id: "me".into() }.connection("Acme");
        assert!(registry.connection(&c.id).is_none());
        registry.register(c.clone());
        assert_eq!(registry.connection(&c.id), Some(c.clone()));
        registry.remove(&c.id);
        assert!(registry.connection(&c.id).is_none());
    }

    #[test]
    fn registering_again_rebuilds_the_tracker_with_the_new_details() {
        let made = Arc::new(AtomicUsize::new(0));
        let counter = made.clone();
        let http = reqwest::Client::new();
        let auth = Arc::new(Auth::signed_out(http.clone()));
        let registry = Registry::new(move |c| {
            counter.fetch_add(1, Ordering::SeqCst);
            Arc::new(jira::JiraTracker::new(http.clone(), auth.clone(), c))
        });
        let scope = SiteScope { cloud_id: "site".into(), account_id: "me".into() };
        registry.register(scope.connection("Old name"));
        let c = registry.connection("jira:site:me").unwrap();
        registry.tracker(&c);
        registry.register(scope.connection("New name"));
        registry.tracker(&registry.connection("jira:site:me").unwrap());
        assert_eq!(made.load(Ordering::SeqCst), 2);
        assert_eq!(registry.connection("jira:site:me").unwrap().display_name, "New name");
    }
}
