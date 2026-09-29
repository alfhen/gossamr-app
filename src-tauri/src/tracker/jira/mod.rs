//! Jira as a `WorkTracker`. ADF, JQL and Jira's transition ids stay in this module.

#![allow(dead_code)]

mod adf;
mod client;
mod convert;
mod intent;
mod jql;

use std::sync::Arc;

use async_trait::async_trait;

use super::{Applied, Connection, Grouping, Move, SearchOptions, TrackerCaps, TransitionModel, WorkTracker};
use crate::auth::{Auth, Scope};
use crate::domain::{Comment, Container, ContainerRef, Filter, Intent, ItemRef, Person, Transitions, WorkItem, Workflow};
use crate::error::{Error, Result};
use crate::model::{CachedTicket, Uploaded};
use client::Jira;

#[cfg(test)]
pub(super) use client::{parse_issue, tests::sample_issue};

const CONTAINER_LIMIT: usize = 100;

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

    fn items(&self, tickets: Vec<CachedTicket>) -> Vec<WorkItem> {
        tickets.iter().map(|t| convert::work_item(&self.connection_id, t)).collect()
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

    async fn followed(&self, window_days: u32, opts: &SearchOptions) -> Result<Vec<WorkItem>> {
        self.query(&jql::followed(window_days), opts).await
    }

    async fn children(&self, parents: &[ItemRef], opts: &SearchOptions) -> Result<Vec<WorkItem>> {
        if parents.is_empty() {
            return Ok(vec![]);
        }
        let keys: Vec<&str> = parents.iter().map(|p| p.external_id.as_str()).collect();
        self.query(&jql::children(&keys), opts).await
    }

    async fn item(&self, item: &ItemRef, history_since: &str) -> Result<WorkItem> {
        let t = self.client.issue(&self.scope, &item.external_id, history_since).await?;
        Ok(convert::work_item(&self.connection_id, &t))
    }

    async fn containers(&self) -> Result<Vec<Container>> {
        let mut out = Vec::new();
        for (key, name) in self.client.projects(&self.scope, CONTAINER_LIMIT).await? {
            let container_ref = ContainerRef { connection_id: self.connection_id.clone(), external_id: key.clone() };
            let workflow = self.workflow(&container_ref).await?;
            out.push(Container { container_ref, key, name, workflow });
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
        for t in self.client.transitions(&self.scope, &item.external_id).await? {
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
                let available = self.client.transitions(scope, &item.external_id).await?;
                let t = intent::transition_to(&available, to).ok_or_else(|| Error::Api {
                    status: 400,
                    message: format!("{} can't move to that status from where it is", item.key),
                })?;
                self.client.transition(scope, &item.external_id, &t.id).await?;
                Ok(Applied::default())
            }
            Intent::Update { item, patch } => {
                if !patch.is_empty() {
                    self.client.update_issue(scope, &item.external_id, intent::update_fields(patch)).await?;
                }
                Ok(Applied::default())
            }
            Intent::Link { from, to, kind } => {
                self.client.link_issues(scope, &intent::link_body(from, to, *kind)).await?;
                Ok(Applied::default())
            }
            Intent::Subtasks { parent, summaries } => {
                let (keys, error) = self.client.create_subtasks(scope, &parent.external_id, summaries).await?;
                let connection = self.connection_id.as_str();
                let created = keys.into_iter().map(|key| ItemRef { connection_id: connection.into(), external_id: key.clone(), key }).collect();
                Ok(Applied { created, error })
            }
            // The link's `from` stands for the new item, so only its `to` and kind are used.
            Intent::Create { container, fields, link } => {
                let project = container.external_id.as_str();
                let types = self.client.issue_types(scope, project).await?;
                let issue_type = intent::pick_type(fields.kind, &types).ok_or_else(|| Error::Api {
                    status: 400,
                    message: format!("project {project} has no matching issue type"),
                })?;
                let key = self.client.create_issue(scope, intent::create_fields(project, issue_type, fields)).await?;
                let created = ItemRef { connection_id: self.connection_id.clone(), external_id: key.clone(), key };
                let error = match link {
                    Some(l) => self.client.link_issues(scope, &intent::link_body(&created, &l.to, l.kind)).await.err(),
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
        let opts = SearchOptions { limit: 10, history_since: None };
        assert!(matches!(t.followed(30, &opts).await, Err(Error::NotSignedIn)));
        assert!(matches!(t.transitions(&item()).await, Err(Error::NotSignedIn)));
        let comment = Intent::Comment { item: item(), body: Doc::paragraph("hi") };
        assert!(matches!(t.apply(&comment).await, Err(Error::NotSignedIn)));
    }

    #[tokio::test]
    async fn a_filter_jira_cannot_narrow_is_refused_before_any_request() {
        let err = tracker().search(&Filter::NeedsMe, &SearchOptions::default()).await.unwrap_err();
        assert!(matches!(err, Error::Api { status: 400, .. }));
        assert!(tracker().search(&Filter::Items { items: vec![] }, &SearchOptions::default()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_comments_take_files() {
        let files = [Uploaded { id: "1".into(), filename: "a.png".into(), mime_type: "image/png".into(), media_id: None, width: None, height: None }];
        let update = Intent::Update { item: item(), patch: Patch::default() };
        let err = tracker().apply_with_files(&update, &files).await.unwrap_err();
        assert!(matches!(err, Error::Api { status: 400, .. }));
    }
}
