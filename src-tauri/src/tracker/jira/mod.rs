//! Jira as a `WorkTracker`. ADF, JQL and Jira's transition ids stay in this module.

#![allow(dead_code)]

mod adf;
mod client;
mod convert;
mod intent;
mod jql;
#[cfg(test)]
mod http_tests;

use std::sync::Arc;

use async_trait::async_trait;

use std::collections::HashMap;

use super::{Applied, Connection, Followed, Grouping, Move, SearchOptions, TrackerCaps, TransitionModel, WorkTracker};
use crate::auth::{Auth, Scope};
use crate::domain::{
    Comment, Container, ContainerPage, ContainerQuery, ContainerRef, ContainerScope, ContainerSummary, Filter, Footprint, Intent, ItemRef, Person, Stray,
    Transitions, Watch, WorkItem, Workflow,
};
use crate::error::{Error, Result};
use crate::model::{CachedTicket, Uploaded};
use client::Jira;

#[cfg(test)]
pub(super) use client::{parse_issue, tests::sample_issue};

/// A ticket stored before the cache existed, as the work item a sync would have produced.
pub(super) fn item_from_ticket(connection_id: &str, t: &CachedTicket) -> WorkItem {
    convert::work_item(connection_id, t)
}

/// The comments a stored ticket carries, for when Jira can't be reached.
pub(super) fn comments_from_ticket(connection_id: &str, t: &CachedTicket) -> Vec<Comment> {
    t.comments.iter().map(|c| convert::comment(connection_id, c)).collect()
}

const CONTAINER_LIMIT: usize = 100;
/// Rows read per footprint question; the picker needs a ranking, not a census.
const FOOTPRINT_ROWS: usize = 500;
const RADAR_ROWS: usize = 200;

/// Runs the scoped search through `run`. Jira fails the whole search when `project in (...)` names a project that
/// doesn't exist or can't be read, and says which. That project is dropped and reported, and the search runs again
/// without it. A 400 that names no project is retried once without the mention clause, which Jira may not accept.
async fn scoped_search<F, Fut>(connection_id: &str, window_days: u32, since: Option<u32>, watches: &[Watch], mut run: F) -> Result<Followed>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<WorkItem>>>,
{
    let mut watches = watches.to_vec();
    let mut inaccessible = Vec::new();
    let mut mentions = true;
    loop {
        let Some(q) = jql::followed_in(window_days, since, &watches, mentions) else {
            return Ok(Followed { items: Vec::new(), inaccessible });
        };
        match run(q).await {
            Ok(items) => return Ok(Followed { items, inaccessible }),
            Err(Error::Api { status: 400, message }) => {
                let keys: Vec<&str> = watches.iter().map(|w| w.container.external_id.as_str()).collect();
                if let Some(bad) = jql::bad_project(&message, &keys) {
                    watches.retain(|w| w.container.external_id != bad);
                    inaccessible.push(ContainerRef { connection_id: connection_id.into(), external_id: bad });
                } else if mentions {
                    mentions = false;
                } else {
                    return Err(Error::Api { status: 400, message });
                }
            }
            Err(e) => return Err(e),
        }
    }
}

pub(super) struct JiraTracker {
    client: Jira,
    scope: Scope,
    connection_id: String,
}

impl JiraTracker {
    pub(super) fn new(http: reqwest::Client, auth: Arc<Auth>, connection: &Connection) -> Self {
        Self {
            client: Jira::new(http, auth),
            scope: Scope { cloud_id: connection.workspace.clone(), account_id: connection.account.clone() },
            connection_id: connection.id.clone(),
        }
    }

    #[cfg(test)]
    fn at(base: &str, http: reqwest::Client, auth: Arc<Auth>, connection: &Connection) -> Self {
        Self { client: Jira::at(base, http, auth), scope: Scope { cloud_id: connection.workspace.clone(), account_id: connection.account.clone() }, connection_id: connection.id.clone() }
    }

    fn items(&self, tickets: Vec<CachedTicket>) -> Vec<WorkItem> {
        tickets.iter().map(|t| convert::work_item(&self.connection_id, t)).collect()
    }

    /// Each project with its workflow. One the person can list but not read the statuses of is left out, as a project
    /// that can't be read, rather than failing the rest.
    async fn with_workflows(&self, projects: Vec<(String, String)>) -> Result<Vec<Container>> {
        let mut out = Vec::new();
        for (key, name) in projects {
            let container_ref = ContainerRef { connection_id: self.connection_id.clone(), external_id: key.clone() };
            match self.workflow(&container_ref).await {
                Ok(workflow) => out.push(Container { container_ref, key, name, workflow }),
                Err(Error::Api { status: 403 | 404 | 410, .. }) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    async fn followed_in(&self, window_days: u32, watches: &[Watch], opts: &SearchOptions) -> Result<Followed> {
        scoped_search(&self.connection_id, window_days, opts.updated_since_minutes, watches, |q| async move { self.query(&q, opts).await }).await
    }

    async fn query(&self, jql: &str, opts: &SearchOptions) -> Result<Vec<WorkItem>> {
        let found = self.client.search(&self.scope, jql, opts.history_since.as_deref(), opts.limit).await?;
        Ok(self.items(found))
    }
}

#[async_trait]
impl WorkTracker for JiraTracker {
    fn capabilities(&self) -> TrackerCaps {
        TrackerCaps {
            subtasks: true,
            mentions: true,
            attachments: true,
            transitions: TransitionModel::PerItem,
            grouping: Grouping::Epics,
            custom_workflows: true,
        }
    }

    async fn search(&self, filter: &Filter, opts: &SearchOptions) -> Result<Vec<WorkItem>> {
        match jql::compile(filter) {
            jql::Clause::Nothing => Ok(vec![]),
            jql::Clause::Everything => Err(Error::Api {
                status: 400,
                message: "Jira can't narrow this filter; add a project, assignee, status or text".into(),
            }),
            jql::Clause::Jql(q) => self.query(&jql::ordered(&q), opts).await,
        }
    }

    async fn search_native(&self, query: &str, opts: &SearchOptions) -> Result<Vec<WorkItem>> {
        self.query(query, opts).await
    }

    async fn followed(&self, window_days: u32, scope: &ContainerScope, opts: &SearchOptions) -> Result<Followed> {
        match scope {
            ContainerScope::Everything => {
                Ok(Followed { items: self.query(&jql::followed(window_days, opts.updated_since_minutes), opts).await?, inaccessible: Vec::new() })
            }
            ContainerScope::Only(watches) => self.followed_in(window_days, watches, opts).await,
        }
    }

    async fn children(&self, parents: &[ItemRef], opts: &SearchOptions) -> Result<Vec<WorkItem>> {
        if parents.is_empty() {
            return Ok(vec![]);
        }
        let keys: Vec<&str> = parents.iter().map(|p| p.external_id.as_str()).collect();
        self.query(&jql::children(&keys, opts.updated_since_minutes), opts).await
    }

    async fn item(&self, item: &ItemRef, history_since: &str) -> Result<WorkItem> {
        let t = self.client.issue(&self.scope, &item.external_id, history_since).await?;
        Ok(convert::work_item(&self.connection_id, &t))
    }

    async fn containers(&self) -> Result<Vec<Container>> {
        let projects = self.client.projects(&self.scope, CONTAINER_LIMIT).await?;
        self.with_workflows(projects).await
    }

    async fn list_containers(&self, q: &ContainerQuery) -> Result<ContainerPage> {
        let start = q.cursor.as_deref().and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);
        let limit = if q.limit == 0 { 50 } else { q.limit };
        let (projects, last) = self.client.project_page(&self.scope, &q.query, start, limit).await?;
        let next = (!last).then(|| (start + projects.len()).to_string());
        let containers = projects
            .into_iter()
            .take(limit)
            .map(|p| ContainerSummary {
                container_ref: ContainerRef { connection_id: self.connection_id.clone(), external_id: p.key.clone() },
                key: p.key,
                name: p.name,
                kind: p.kind,
                archived: p.archived,
                last_active: p.last_active,
                item_hint: p.issue_count,
            })
            .collect();
        Ok(ContainerPage { containers, next })
    }

    async fn containers_of(&self, refs: &[ContainerRef]) -> Result<Vec<Container>> {
        let keys: Vec<&str> = refs.iter().map(|r| r.external_id.as_str()).collect();
        let projects = self.client.projects_by_keys(&self.scope, &keys).await?;
        self.with_workflows(projects).await
    }

    async fn footprint(&self, window_days: u32) -> Result<Vec<Footprint>> {
        let mut by_project: HashMap<String, Footprint> = HashMap::new();
        for (answered, (kind, q)) in jql::footprint(window_days).into_iter().enumerate() {
            let hits = match self.client.search_hits(&self.scope, &q, FOOTPRINT_ROWS).await {
                Ok(h) => h,
                // Rate limited: what has been counted so far still ranks the projects.
                Err(Error::RateLimited { .. }) if answered > 0 => break,
                Err(e) => return Err(e),
            };
            for h in hits {
                let f = by_project.entry(h.project_key.clone()).or_insert_with(|| Footprint {
                    container: ContainerRef { connection_id: self.connection_id.clone(), external_id: h.project_key.clone() },
                    key: h.project_key.clone(),
                    name: h.project_name.clone(),
                    ..Default::default()
                });
                match kind {
                    "assigned" => f.assigned += 1,
                    "reported" => f.reported += 1,
                    "watching" => f.watching += 1,
                    _ => *f.mentioned.get_or_insert(0) += 1,
                }
                if h.updated.as_ref() > f.last_touch.as_ref() {
                    f.last_touch = h.updated;
                }
            }
        }
        let mut out: Vec<Footprint> = by_project.into_values().collect();
        out.sort_by(|a, b| (b.assigned, b.reported + b.watching).cmp(&(a.assigned, a.reported + a.watching)).then_with(|| a.key.cmp(&b.key)));
        Ok(out)
    }

    async fn assigned_outside(&self, watched: &[ContainerRef]) -> Result<Vec<Stray>> {
        let keys: Vec<&str> = watched.iter().map(|w| w.external_id.as_str()).collect();
        let hits = self.client.search_hits(&self.scope, &jql::assigned_outside(&keys), RADAR_ROWS).await?;
        let mut out: Vec<Stray> = Vec::new();
        for h in hits {
            match out.iter_mut().find(|s| s.container.external_id == h.project_key) {
                Some(s) => s.keys.push(h.key),
                None => out.push(Stray {
                    container: ContainerRef { connection_id: self.connection_id.clone(), external_id: h.project_key },
                    container_name: h.project_name,
                    keys: vec![h.key],
                }),
            }
        }
        Ok(out)
    }

    /// Jira only reveals moves per issue, so the graph is empty; ask `transitions` for a real item.
    async fn workflow(&self, container: &ContainerRef) -> Result<Workflow> {
        let statuses = self.client.project_statuses(&self.scope, &container.external_id).await?;
        Ok(Workflow { statuses, transitions: Transitions::Graph(vec![]) })
    }

    async fn comments(&self, item: &ItemRef) -> Result<Vec<Comment>> {
        let comments = self.client.comments(&self.scope, &item.external_id).await?;
        Ok(comments.iter().map(|c| convert::comment(&self.connection_id, c)).collect())
    }

    async fn transitions(&self, item: &ItemRef) -> Result<Vec<Move>> {
        let mut moves: Vec<Move> = Vec::new();
        for t in self.client.transitions(&self.scope, &item.external_id, false).await? {
            if !moves.iter().any(|m| m.to.id == t.to.id) {
                moves.push(Move { name: t.name, to: t.to });
            }
        }
        Ok(moves)
    }

    async fn people(&self, item: &ItemRef, query: &str) -> Result<Vec<Person>> {
        let people = self.client.mentionable(&self.scope, &item.external_id, query).await?;
        Ok(people.iter().map(|p| convert::person(&self.connection_id, p)).collect())
    }

    async fn apply_with_files(&self, intent: &Intent, files: &[Uploaded]) -> Result<Applied> {
        if !files.is_empty() && !matches!(intent, Intent::Comment { .. }) {
            return Err(Error::Api { status: 400, message: "files can only go with a comment".into() });
        }
        let scope = &self.scope;
        match intent {
            Intent::Comment { item, body } => {
                let doc = adf::with_files(adf::from_doc(body), files);
                self.client.comment(scope, &item.external_id, &doc).await?;
                Ok(Applied::default())
            }
            Intent::Transition { item, to } => {
                let available = self.client.transitions(scope, &item.external_id, true).await?;
                let t = intent::transition_to(&available, to).ok_or_else(|| Error::Api {
                    status: 400,
                    message: format!("{} can't move to that status from where it is", item.key),
                })?;
                let body = intent::transition_body(t).map_err(|missing| Error::Api {
                    status: 400,
                    message: format!("Jira needs {} to move {} to {}; set it in Jira.", missing.join(", "), item.key, t.to.name),
                })?;
                self.client.transition(scope, &item.external_id, &body).await?;
                Ok(Applied::default())
            }
            Intent::Update { item, patch } => {
                if !patch.is_empty() {
                    self.client.update_issue(scope, &item.external_id, intent::update_fields(patch)).await?;
                }
                Ok(Applied::default())
            }
            Intent::Link { from, to, kind } => {
                let body = intent::link_body(from, to, *kind).ok_or_else(not_an_issue_link)?;
                self.client.link_issues(scope, &body).await?;
                Ok(Applied::default())
            }
            Intent::StartRun { .. } => Err(Error::Proposal("a run is approved with its own button, not applied to Jira".into())),
            Intent::Subtasks { parent, summaries } => {
                let (keys, error) = self.client.create_subtasks(scope, &parent.external_id, summaries).await?;
                let connection = self.connection_id.as_str();
                let created = keys.into_iter().map(|key| ItemRef { connection_id: connection.into(), external_id: key.clone(), key }).collect();
                Ok(Applied { created, error })
            }
            // The link's `from` stands for the new item, so only its `to` and kind are used.
            Intent::Create { container, fields, link } => {
                if link.as_ref().is_some_and(|l| intent::link_body(&l.from, &l.to, l.kind).is_none()) {
                    return Err(not_an_issue_link());
                }
                let project = container.external_id.as_str();
                let types = self.client.issue_types(scope, project).await?;
                let issue_type = intent::pick_type(fields.kind, &types).ok_or_else(|| Error::Api {
                    status: 400,
                    message: format!("project {project} has no matching issue type"),
                })?;
                let key = self.client.create_issue(scope, intent::create_fields(project, issue_type, fields)).await?;
                let created = ItemRef { connection_id: self.connection_id.clone(), external_id: key.clone(), key };
                let error = match link {
                    Some(l) => match intent::link_body(&created, &l.to, l.kind) {
                        Some(body) => self.client.link_issues(scope, &body).await.err(),
                        None => Some(not_an_issue_link()),
                    },
                    None => None,
                };
                Ok(Applied { created: vec![created], error })
            }
        }
    }

    async fn attach(&self, item: &ItemRef, filename: &str, mime_type: &str, bytes: Vec<u8>) -> Result<Uploaded> {
        self.client.attach(&self.scope, &item.external_id, filename, mime_type, bytes).await
    }

    async fn attachment_limit(&self) -> Result<Option<u64>> {
        self.client.attachment_limit(&self.scope).await
    }

    async fn media_id(&self, attachment_id: &str) -> Result<Option<String>> {
        self.client.media_id(&self.scope, attachment_id).await
    }

    async fn download(&self, attachment_id: &str) -> Result<(String, Vec<u8>)> {
        self.client.download(&self.scope, attachment_id).await
    }
}

fn not_an_issue_link() -> Error {
    Error::Proposal("code changes are read from the code host; they can't be linked as a Jira issue link".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Doc, Patch};

    fn tracker() -> JiraTracker {
        let http = reqwest::Client::new();
        let connection = Connection::jira(&Scope { cloud_id: "site".into(), account_id: "me".into() }, "Site");
        JiraTracker::new(http.clone(), Arc::new(Auth::signed_out(http)), &connection)
    }

    fn item() -> ItemRef {
        ItemRef { connection_id: "jira:site:me".into(), external_id: "CA-1".into(), key: "CA-1".into() }
    }

    #[test]
    fn declares_what_jira_can_do() {
        let caps = tracker().capabilities();
        assert_eq!(caps.transitions, TransitionModel::PerItem);
        assert!(caps.subtasks && caps.mentions && caps.attachments);
    }

    #[tokio::test]
    async fn reads_and_writes_need_a_signed_in_account() {
        let t = tracker();
        let opts = SearchOptions { limit: 10, ..Default::default() };
        assert!(matches!(t.followed(30, &ContainerScope::Everything, &opts).await, Err(Error::NotSignedIn)));
        assert!(matches!(t.transitions(&item()).await, Err(Error::NotSignedIn)));
        let comment = Intent::Comment { item: item(), body: Doc::paragraph("hi") };
        assert!(matches!(t.apply(&comment).await, Err(Error::NotSignedIn)));
    }

    fn watch(key: &str) -> Watch {
        Watch {
            container: ContainerRef { connection_id: "jira:site:me".into(), external_id: key.into() },
            depth: crate::domain::Depth::Involved,
            pinned: false,
            source: crate::domain::WatchSource::Manual,
            added_at: String::new(),
            unwatched_at: None,
            inaccessible: false,
        }
    }

    fn bad(key: &str) -> Error {
        Error::Api { status: 400, message: format!("{{\"errorMessages\":[\"The value '{key}' does not exist for the field 'project'.\"]}}") }
    }

    #[tokio::test]
    async fn a_project_jira_refuses_is_dropped_reported_and_the_search_retried() {
        let queries = std::sync::Mutex::new(Vec::new());
        let found = scoped_search("c", 30, None, &[watch("CA"), watch("OLD"), watch("GONE")], |q| {
            queries.lock().unwrap().push(q.clone());
            async move {
                match (q.contains("\"OLD\""), q.contains("\"GONE\"")) {
                    (true, _) => Err(bad("OLD")),
                    (_, true) => Err(bad("GONE")),
                    _ => Ok(vec![]),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(found.inaccessible.iter().map(|c| c.external_id.as_str()).collect::<Vec<_>>(), ["OLD", "GONE"]);
        let queries = queries.lock().unwrap();
        assert_eq!(queries.len(), 3);
        assert!(queries[2].contains("\"CA\"") && !queries[2].contains("OLD") && !queries[2].contains("GONE"));
    }

    #[tokio::test]
    async fn when_every_project_is_refused_nothing_more_is_asked() {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let found = scoped_search("c", 30, None, &[watch("OLD")], |_| {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Err(bad("OLD")) }
        })
        .await
        .unwrap();
        assert!(found.items.is_empty() && found.inaccessible.len() == 1);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_unrelated_400_retries_once_without_mentions_then_fails() {
        let queries = std::sync::Mutex::new(Vec::new());
        let err = scoped_search("c", 30, None, &[watch("CA")], |q| {
            queries.lock().unwrap().push(q);
            async { Err(Error::Api { status: 400, message: "Error in the JQL Query".into() }) }
        })
        .await
        .unwrap_err();
        assert!(matches!(err, Error::Api { status: 400, .. }));
        let queries = queries.lock().unwrap();
        assert_eq!(queries.len(), 2);
        assert!(queries[0].contains("comment ~") && !queries[1].contains("comment ~"));
    }

    #[tokio::test]
    async fn other_failures_are_not_retried_and_an_empty_scope_asks_nothing() {
        let err = scoped_search("c", 30, None, &[watch("CA")], |_| async { Err(Error::Api { status: 503, message: "down".into() }) }).await.unwrap_err();
        assert!(matches!(err, Error::Api { status: 503, .. }));
        let none = scoped_search("c", 30, None, &[], |_| async { panic!("no request expected") }).await.unwrap();
        assert!(none.items.is_empty());
    }

    #[tokio::test]
    async fn a_filter_jira_cannot_narrow_is_refused_before_any_request() {
        let err = tracker().search(&Filter::NeedsMe, &SearchOptions::default()).await.unwrap_err();
        assert!(matches!(err, Error::Api { status: 400, .. }));
        assert!(tracker().search(&Filter::Items { items: vec![] }, &SearchOptions::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_code_link_is_refused_before_anything_is_sent_to_jira() {
        let link = Intent::Link { from: item(), to: item(), kind: crate::domain::LinkKind::ImplementedBy };
        let err = tracker().apply(&link).await.unwrap_err();
        assert!(matches!(err, Error::Proposal(_)), "{err}");
    }

    #[tokio::test]
    async fn only_comments_take_files() {
        let files = [Uploaded { id: "1".into(), filename: "a.png".into(), mime_type: "image/png".into(), media_id: None, width: None, height: None }];
        let update = Intent::Update { item: item(), patch: Patch::default() };
        let err = tracker().apply_with_files(&update, &files).await.unwrap_err();
        assert!(matches!(err, Error::Api { status: 400, .. }));
    }
}
