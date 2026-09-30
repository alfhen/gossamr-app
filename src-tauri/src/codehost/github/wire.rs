//! GitHub's JSON, as much of it as we read, and its conversion to domain types.

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::domain::{clip, CheckState, CodeChange, CodeChangeKind, CodeChangeState, ContainerRef, ContainerSummary, PersonRef, ReviewState, BODY_LIMIT};

#[derive(Debug, Deserialize)]
pub struct User {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Permissions {
    #[serde(default)]
    pub admin: bool,
    #[serde(default)]
    pub maintain: bool,
    #[serde(default)]
    pub push: bool,
    #[serde(default)]
    pub triage: bool,
}

#[derive(Debug, Deserialize)]
pub struct Repo {
    pub full_name: String,
    pub name: String,
    #[serde(default)]
    pub archived: bool,
    pub pushed_at: Option<String>,
    pub permissions: Option<Permissions>,
}

#[derive(Debug, Deserialize)]
pub struct RepoSearch {
    pub items: Vec<Repo>,
}

#[derive(Debug, Deserialize)]
pub struct Owner {
    pub login: String,
}

#[derive(Debug, Deserialize)]
pub struct Branch {
    #[serde(rename = "ref")]
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Deserialize)]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    #[serde(default)]
    pub draft: bool,
    pub merged_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub html_url: String,
    pub user: Option<Owner>,
    pub head: Branch,
    pub base: Branch,
    #[serde(default)]
    pub requested_reviewers: Vec<Owner>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
}

/// An entry of an issue search: a pull request when `pull_request` is present.
#[derive(Debug, Deserialize)]
pub struct IssueHit {
    pub repository_url: String,
    pub number: u64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct IssueSearch {
    pub items: Vec<IssueHit>,
}

#[derive(Debug, Deserialize)]
pub struct EventRepo {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UserEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub repo: EventRepo,
    pub created_at: String,
}

impl Repo {
    pub fn summary(&self, connection_id: &str) -> ContainerSummary {
        let permission = self.permissions.as_ref().map(|p| {
            match (p.admin, p.maintain, p.push, p.triage) {
                (true, ..) => "admin",
                (_, true, ..) => "maintain",
                (_, _, true, _) => "push",
                (_, _, _, true) => "triage",
                _ => "pull",
            }
            .to_string()
        });
        ContainerSummary {
            container_ref: ContainerRef { connection_id: connection_id.into(), external_id: self.full_name.clone() },
            key: self.full_name.clone(),
            name: self.name.clone(),
            kind: permission,
            archived: self.archived,
            last_active: self.pushed_at.clone(),
            item_hint: None,
        }
    }
}

impl Pull {
    pub fn change(&self, connection_id: &str, repo: &str) -> CodeChange {
        let state = if self.merged_at.is_some() {
            CodeChangeState::Merged
        } else if self.state == "closed" {
            CodeChangeState::Closed
        } else if self.draft {
            CodeChangeState::Draft
        } else {
            CodeChangeState::Open
        };
        let person = |o: &Owner| PersonRef { connection_id: connection_id.into(), account_id: o.login.clone() };
        let reviewers: Vec<PersonRef> = self.requested_reviewers.iter().map(person).collect();
        CodeChange {
            connection_id: connection_id.into(),
            external_id: CodeChange::pr_id(repo, self.number),
            kind: CodeChangeKind::PullRequest,
            repo: repo.into(),
            number: Some(self.number),
            title: self.title.clone(),
            head_ref: self.head.name.clone(),
            base_ref: Some(self.base.name.clone()),
            state,
            merged_at: self.merged_at,
            created_at: Some(self.created_at),
            updated_at: self.updated_at,
            author: self.user.as_ref().map(person),
            review: if reviewers.is_empty() { ReviewState::None } else { ReviewState::Requested },
            reviewers,
            checks: CheckState::None,
            url: self.html_url.clone(),
            sha: Some(self.head.sha.clone()),
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            body: clip(self.body.as_deref().unwrap_or_default(), BODY_LIMIT),
            linked_keys: Vec::new(),
        }
    }
}
