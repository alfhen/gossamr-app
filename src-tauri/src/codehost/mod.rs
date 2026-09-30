//! Code hosts behind one trait. Core holds an `Arc<dyn CodeHost>` per connection and speaks domain types.

// The tracker-facing readers (branches, commits, search) wait for link discovery.
#![allow(dead_code)]

pub mod github;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::{CodeChange, ContainerPage, ContainerQuery, Footprint};
use crate::error::Result;

/// The account a token signs in as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeAccount {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    /// What a classic token may do. `None` for fine-grained tokens and apps, which don't list scopes.
    pub scopes: Option<Vec<String>>,
}

/// Pull requests of one repository.
#[derive(Clone, Debug, PartialEq)]
pub struct PullList {
    pub changes: Vec<CodeChange>,
    /// The host reported nothing changed since the last answer, so what is cached is still right.
    pub unchanged: bool,
}

#[async_trait]
pub trait CodeHost: Send + Sync {
    async fn me(&self) -> Result<CodeAccount>;

    /// One page of the repositories the person can reach, matching `q.query` on the server where the host can.
    /// The key of a container is its `owner/name`.
    async fn list_repositories(&self, q: &ContainerQuery) -> Result<ContainerPage>;

    /// Repositories the person has been active in during the last `window_days`, for suggesting what to watch.
    async fn footprint(&self, window_days: u32) -> Result<Vec<Footprint>>;

    /// Every open pull request of `repo` and those updated since `since`, newest first, with the state, draft flag,
    /// branches, author and requested reviewers the list carries. Review outcome, checks and change size need
    /// `pull_request`.
    async fn pull_requests(&self, repo: &str, since: DateTime<Utc>) -> Result<PullList>;
}
