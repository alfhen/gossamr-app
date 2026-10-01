//! Work on a code host: pull requests, branches and commits, and the links that tie them to work items.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{ItemRef, PersonRef};

/// Longest body kept on a change, so a pasted log can't bloat the cache.
pub const BODY_LIMIT: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeChangeKind {
    PullRequest,
    Branch,
    Commit,
}

/// Only pull requests move through every state. A branch is `open` while it exists; a commit on the default branch is `merged`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeChangeState {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    None,
    Pending,
    Passing,
    Failing,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    #[default]
    None,
    Requested,
    Approved,
    ChangesRequested,
    Commented,
}

/// A pull request, a branch or a commit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeChange {
    pub connection_id: String,
    /// Stable id: `pr:acme/webshop#12`, `branch:acme/webshop:ca-208-gateway` or `commit:acme/webshop@<sha>`.
    pub external_id: String,
    pub kind: CodeChangeKind,
    /// `owner/name`.
    pub repo: String,
    pub number: Option<u64>,
    /// A pull request's title, a branch's name, or a commit's first line.
    pub title: String,
    /// Where it was found: the head branch of a pull request, the name of a branch, or the branch a commit was read from.
    pub head_ref: String,
    pub base_ref: Option<String>,
    /// The repository a pull request's head branch is in, `owner/name`. Unknown for anything read without it.
    #[serde(default)]
    pub head_repo: Option<String>,
    pub state: CodeChangeState,
    pub merged_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub author: Option<PersonRef>,
    #[serde(default)]
    pub reviewers: Vec<PersonRef>,
    pub checks: CheckState,
    #[serde(default)]
    pub review: ReviewState,
    pub url: String,
    pub sha: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    /// A pull request's description, or the rest of a commit message, cut at `BODY_LIMIT`.
    #[serde(default)]
    pub body: String,
    /// Item keys found in the branch, title, body or message.
    #[serde(default)]
    pub linked_keys: Vec<String>,
}

impl CodeChange {
    pub fn pr_id(repo: &str, number: u64) -> String {
        format!("pr:{repo}#{number}")
    }

    pub fn branch_id(repo: &str, name: &str) -> String {
        format!("branch:{repo}:{name}")
    }

    pub fn commit_id(repo: &str, sha: &str) -> String {
        format!("commit:{repo}@{sha}")
    }

    /// What a person reads: `acme/webshop#12`, `acme/webshop:branch-name` or `acme/webshop@abc1234`.
    pub fn label(&self) -> String {
        match (self.kind, self.number) {
            (CodeChangeKind::PullRequest, Some(n)) => format!("{}#{n}", self.repo),
            (CodeChangeKind::Commit, _) => format!("{}@{}", self.repo, self.sha.as_deref().unwrap_or("").chars().take(7).collect::<String>()),
            _ => format!("{}:{}", self.repo, self.title),
        }
    }

    /// A pull request whose head is in the repository it targets. Unknown counts as no.
    pub fn is_same_repo(&self) -> bool {
        self.kind == CodeChangeKind::PullRequest && self.head_repo.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(&self.repo))
    }

    /// This change as the far end of a `Link`.
    pub fn item_ref(&self) -> ItemRef {
        ItemRef { connection_id: self.connection_id.clone(), external_id: self.external_id.clone(), key: self.label() }
    }

    /// Text that may name a work item, each with where it came from.
    pub fn texts(&self) -> Vec<(LinkSource, &str)> {
        match self.kind {
            CodeChangeKind::PullRequest => {
                vec![(LinkSource::Branch, self.head_ref.as_str()), (LinkSource::Title, self.title.as_str()), (LinkSource::Body, self.body.as_str())]
            }
            CodeChangeKind::Branch => vec![(LinkSource::Branch, self.title.as_str())],
            CodeChangeKind::Commit => vec![(LinkSource::Commit, self.title.as_str()), (LinkSource::Commit, self.body.as_str())],
        }
    }
}

/// Where in a change a work item's key was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkSource {
    Body,
    Commit,
    Title,
    Branch,
}

impl LinkSource {
    /// A key in a branch name or a title is deliberate; one in a description is often only a mention.
    pub fn confidence(self) -> f32 {
        match self {
            LinkSource::Branch => 0.95,
            LinkSource::Title => 0.9,
            LinkSource::Commit => 0.85,
            LinkSource::Body => 0.6,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LinkSource::Branch => "branch",
            LinkSource::Title => "title",
            LinkSource::Commit => "commit",
            LinkSource::Body => "body",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "branch" => LinkSource::Branch,
            "title" => LinkSource::Title,
            "commit" => LinkSource::Commit,
            _ => LinkSource::Body,
        }
    }
}

/// A work item and the change that carries it out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevLink {
    pub item: ItemRef,
    pub change: CodeChange,
    pub provenance: LinkSource,
    pub confidence: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `added`, `modified`, `removed`, `renamed` and the like, as the host says.
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    /// Cut short; absent for binary files and very large diffs.
    pub patch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub message: String,
    pub author: Option<String>,
    pub at: DateTime<Utc>,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInfo {
    pub id: String,
    pub reviewer: PersonRef,
    pub state: ReviewState,
    pub at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub change: CodeChange,
    pub files: Vec<ChangedFile>,
    /// More files changed than were listed.
    pub files_truncated: bool,
    pub commits: Vec<CommitInfo>,
    pub reviews: Vec<ReviewInfo>,
}

/// `text` cut at `limit` characters on a character boundary.
pub fn clip(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((i, _)) => text[..i].to_string(),
        None => text.to_string(),
    }
}

/// A file's text at a ref.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    pub repo: String,
    pub path: String,
    /// The branch, tag or commit asked for; empty for the default branch.
    pub reference: String,
    pub text: String,
    /// Bytes of the whole file, which may be more than `text` holds.
    pub size: u64,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TreeEntryKind {
    File,
    Dir,
    Symlink,
    Submodule,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    pub path: String,
    pub kind: TreeEntryKind,
    pub size: u64,
}

/// A match of a code search.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeHit {
    pub repo: String,
    pub path: String,
    pub url: String,
    /// The lines that matched, as the host shows them.
    pub fragments: Vec<String>,
}

/// Which commits to list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitQuery {
    pub repo: String,
    /// A branch, tag or commit; the default branch when absent.
    pub reference: Option<String>,
    pub since: Option<DateTime<Utc>>,
    /// Only commits that touch this file or folder.
    pub path: Option<String>,
    /// Only commits whose message contains this, ignoring case (a ticket key, say).
    pub text: Option<String>,
    pub limit: usize,
}

/// A notification thread, as far as the feed needs it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    /// `review_requested`, `mention`, `assign`, `ci_activity` and the like.
    pub reason: String,
    pub repo: String,
    pub title: String,
    /// `PullRequest`, `Issue`, `CheckSuite`, ...
    pub subject: String,
    pub number: Option<u64>,
    pub url: String,
    pub updated_at: DateTime<Utc>,
    pub unread: bool,
}
