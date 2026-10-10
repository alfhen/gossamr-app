//! Code hosts behind one trait. Core holds an `Arc<dyn CodeHost>` per connection and speaks domain types.

// `me` and `branches` are for the Pip tools, which wire them up next.
#![allow(dead_code)]

pub mod diff;
pub mod events;
pub mod github;
pub mod keys;
pub mod links;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::domain::{
    ChangedFile, CodeChange, CodeFile, CodeHit, CommitQuery, ContainerPage, ContainerQuery, Footprint, Notice, PostedReview, PullRequestDetail, ReviewComment,
    ReviewInfo, TreeEntry,
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
    /// Reviews or checks couldn't be read just now, so `change` keeps what was known of them before.
    pub incomplete: bool,
}

/// A pull request with the files it changes, for showing it in Gossamr: what it is and where its head is, and each
/// file's patch long enough for a review draft's comments.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullDiff {
    pub change: CodeChange,
    pub files: Vec<ChangedFile>,
}

/// Whether the token may post a review on a repository, and when not, why, in a sentence for the person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAccess {
    pub can_post: bool,
    pub reason: Option<String>,
}

/// One review already submitted on a pull request: who, how it came out, its summary and when.
#[derive(Clone, Debug, PartialEq)]
pub struct ReviewSummary {
    pub author: Option<String>,
    /// GitHub's word for it: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`.
    pub state: String,
    pub body: String,
    pub at: Option<DateTime<Utc>>,
}

/// One inline comment already on a pull request. `line` is where it sits in the current diff, or `None` when the code
/// it was left on has changed since (`original_line` is then where it was).
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadComment {
    pub path: String,
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub side: Option<String>,
    pub author: Option<String>,
    /// The state of the review it was left in, when it was left in one that is listed.
    pub state: Option<String>,
    pub body: String,
    pub at: Option<DateTime<Utc>>,
}

/// What reviewers have already said on a pull request: the reviews and their inline comments, oldest first.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ReviewComments {
    pub reviews: Vec<ReviewSummary>,
    pub comments: Vec<ThreadComment>,
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

    /// The files a pull request changes with their patches, each kept long enough for a review draft's comments
    /// (`truncated` when cut). Reads only the files list, never the pull request itself.
    async fn pull_files(&self, repo: &str, number: u64) -> Result<Vec<ChangedFile>>;

    /// Just the pull request itself, one request: state, branches and the repository its head is in.
    async fn pull_request_change(&self, repo: &str, number: u64) -> Result<CodeChange>;

    /// The pull request and its files, read together: `pull_request_change` plus `pull_files`. Reads only.
    async fn pull_diff(&self, repo: &str, number: u64) -> Result<PullDiff> {
        let change = self.pull_request_change(repo, number).await?;
        let files = self.pull_files(repo, number).await?;
        Ok(PullDiff { change, files })
    }

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

    /// The reviews already submitted on pull request `number` and their inline comments, a few pages at most. Reads only.
    async fn review_comments(&self, repo: &str, number: u64) -> Result<ReviewComments>;

    /// Whether this token may post a review on `repo`. Reads only.
    async fn review_access(&self, repo: &str) -> Result<ReviewAccess>;

    /// The comment review of pull request `number` at `commit_sha` with `summary` as its body that this token's account
    /// already submitted, if any: how a post whose outcome was unknown is found to have gone through. Reads only.
    async fn posted_review(&self, repo: &str, number: u64, commit_sha: &str, summary: &str) -> Result<Option<PostedReview>>;

    /// The one write a code host has: posts a plain comment review of pull request `number` at `commit_sha`, once,
    /// never an approval or a request for changes. Only the person's approval of a review draft calls it
    /// (`Core::post_review_draft`); Pip, agents and the supervisor have no path to it.
    async fn post_review(&self, repo: &str, number: u64, commit_sha: &str, summary: &str, comments: &[ReviewComment]) -> Result<PostedReview>;
}
