//! Code hosts behind one trait. Core holds an `Arc<dyn CodeHost>` per connection and speaks domain types.

// `me` and `branches` are for the Pip tools, which wire them up next.
#![allow(dead_code)]

pub mod events;
pub mod github;
pub mod keys;
pub mod links;

use async_trait::async_trait;
use chrono::{DateTime, Utc};

use crate::domain::{
    CodeChange, CodeFile, CodeHit, CommitQuery, ContainerPage, ContainerQuery, Footprint, Notice, PullRequestDetail, ReviewInfo, TreeEntry,
};
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

/// A pull request read in full, with the reviews it was judged from.
#[derive(Clone, Debug, PartialEq)]
pub struct Refreshed {
    pub change: CodeChange,
    pub reviews: Vec<ReviewInfo>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notices {
    pub notices: Vec<Notice>,
    /// Nothing is new since the last poll.
    pub unchanged: bool,
    /// Seconds the host asks pollers to wait.
    pub poll_interval: Option<u64>,
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

    /// `change` read again in full: size, review outcome and, when `with_checks`, the checks rollup. What the list
    /// can't tell is filled in; `linked_keys` are carried over.
    async fn refresh_pull_request(&self, change: &CodeChange, with_checks: bool) -> Result<Refreshed>;

    /// One pull request with the files it changes (paths, stats, cut-short patches) and its recent commits.
    async fn pull_request(&self, repo: &str, number: u64) -> Result<PullRequestDetail>;

    async fn branches(&self, repo: &str) -> Result<Vec<CodeChange>>;

    /// Commits of a branch (the default one when none is named), newest first, optionally only those whose message
    /// contains `q.text`.
    async fn commits(&self, q: &CommitQuery) -> Result<Vec<CodeChange>>;

    /// Pull requests, branches and commits in `repos` that match `query`. For a work item key the match is exact:
    /// the key appears in the title or description, the branch name or the commit message.
    async fn search(&self, query: &str, repos: &[String]) -> Result<Vec<CodeChange>>;

    /// The person's notification threads, read only. Fails unless the token may read notifications.
    async fn notifications(&self) -> Result<Notices>;

    /// A text file at a ref, cut short when long. Binary files are refused.
    async fn file(&self, repo: &str, path: &str, reference: Option<&str>) -> Result<CodeFile>;

    async fn tree(&self, repo: &str, path: &str, reference: Option<&str>) -> Result<Vec<TreeEntry>>;

    /// Code search limited to `repos`.
    async fn search_code(&self, query: &str, repos: &[String]) -> Result<Vec<CodeHit>>;
}
