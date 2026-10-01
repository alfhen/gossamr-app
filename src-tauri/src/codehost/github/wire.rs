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
    /// Null when the repository the branch lived in has been deleted.
    #[serde(default)]
    pub repo: Option<BranchRepo>,
}

#[derive(Debug, Deserialize)]
pub struct BranchRepo {
    pub full_name: String,
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
            head_repo: self.head.repo.as_ref().map(|r| r.full_name.clone()),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Review {
    pub id: u64,
    pub user: Option<Owner>,
    pub state: String,
    pub submitted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CheckRun {
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckRuns {
    pub check_runs: Vec<CheckRun>,
}

#[derive(Debug, Deserialize)]
pub struct CombinedStatus {
    pub state: String,
    #[serde(default)]
    pub total_count: u64,
}

#[derive(Debug, Deserialize)]
pub struct PullFile {
    pub filename: String,
    pub status: String,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    pub patch: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PullCommit {
    pub sha: String,
    pub html_url: String,
    pub commit: CommitBody,
    pub author: Option<Owner>,
}

#[derive(Debug, Deserialize)]
pub struct Sha {
    pub sha: String,
}

#[derive(Debug, Deserialize)]
pub struct Stamp {
    pub name: Option<String>,
    pub date: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CommitBody {
    pub message: String,
    pub author: Option<Stamp>,
    pub committer: Option<Stamp>,
}

#[derive(Debug, Deserialize)]
pub struct RepoName {
    pub full_name: String,
}

/// A commit from a listing or a search.
#[derive(Debug, Deserialize)]
pub struct Commit {
    pub sha: String,
    pub html_url: String,
    pub commit: CommitBody,
    pub author: Option<Owner>,
    pub repository: Option<RepoName>,
}

#[derive(Debug, Deserialize)]
pub struct CommitSearch {
    pub items: Vec<Commit>,
}

#[derive(Debug, Deserialize)]
pub struct BranchItem {
    pub name: String,
    pub commit: Sha,
}

#[derive(Debug, Deserialize)]
pub struct MergedAt {
    pub merged_at: Option<DateTime<Utc>>,
}

/// An issue search hit that is a pull request.
#[derive(Debug, Deserialize)]
pub struct PullHit {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    #[serde(default)]
    pub draft: bool,
    pub user: Option<Owner>,
    pub html_url: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub repository_url: String,
    pub pull_request: Option<MergedAt>,
}

#[derive(Debug, Deserialize)]
pub struct PullHits {
    pub items: Vec<PullHit>,
}

#[derive(Debug, Deserialize)]
pub struct NoticeSubject {
    pub title: String,
    pub url: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Deserialize)]
pub struct Notification {
    pub id: String,
    pub reason: String,
    pub unread: bool,
    pub updated_at: DateTime<Utc>,
    pub subject: NoticeSubject,
    pub repository: RepoName,
}

#[derive(Debug, Deserialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct TextMatch {
    pub fragment: String,
}

#[derive(Debug, Deserialize)]
pub struct CodeItem {
    pub path: String,
    pub html_url: String,
    pub repository: RepoName,
    #[serde(default)]
    pub text_matches: Vec<TextMatch>,
}

#[derive(Debug, Deserialize)]
pub struct CodeItems {
    pub items: Vec<CodeItem>,
}

/// Newest review per reviewer decides, except that a comment doesn't undo an approval or a request for changes and a
/// dismissed or pending review counts for nothing.
pub fn review_state(reviews: &[Review], requested: usize) -> ReviewState {
    let mut latest: Vec<(&str, &str)> = Vec::new();
    let mut commented = false;
    for r in reviews {
        let Some(user) = &r.user else { continue };
        match r.state.as_str() {
            "COMMENTED" => commented = true,
            "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" => {
                latest.retain(|(u, _)| *u != user.login);
                if r.state != "DISMISSED" {
                    latest.push((&user.login, &r.state));
                }
            }
            _ => {}
        }
    }
    if latest.iter().any(|(_, s)| *s == "CHANGES_REQUESTED") {
        ReviewState::ChangesRequested
    } else if latest.iter().any(|(_, s)| *s == "APPROVED") {
        ReviewState::Approved
    } else if requested > 0 {
        ReviewState::Requested
    } else if commented {
        ReviewState::Commented
    } else {
        ReviewState::None
    }
}

/// A failing check outweighs a pending one, which outweighs a passing one; no checks at all is `None`.
pub fn checks_state(runs: &[CheckRun], status: Option<&CombinedStatus>) -> CheckState {
    let mut failing = false;
    let mut pending = false;
    let mut any = false;
    for run in runs {
        any = true;
        if run.status != "completed" {
            pending = true;
        } else if matches!(run.conclusion.as_deref(), Some("failure" | "timed_out" | "cancelled" | "action_required" | "startup_failure")) {
            failing = true;
        }
    }
    if let Some(s) = status.filter(|s| s.total_count > 0) {
        any = true;
        match s.state.as_str() {
            "failure" | "error" => failing = true,
            "pending" => pending = true,
            _ => {}
        }
    }
    match (failing, pending, any) {
        (true, ..) => CheckState::Failing,
        (_, true, _) => CheckState::Pending,
        (_, _, true) => CheckState::Passing,
        _ => CheckState::None,
    }
}

impl PullHit {
    pub fn change(&self, connection_id: &str) -> Option<CodeChange> {
        let repo = self.repository_url.split_once("/repos/")?.1;
        let merged_at = self.pull_request.as_ref().and_then(|p| p.merged_at);
        let state = if merged_at.is_some() {
            CodeChangeState::Merged
        } else if self.state == "closed" {
            CodeChangeState::Closed
        } else if self.draft {
            CodeChangeState::Draft
        } else {
            CodeChangeState::Open
        };
        Some(CodeChange {
            connection_id: connection_id.into(),
            external_id: CodeChange::pr_id(repo, self.number),
            kind: CodeChangeKind::PullRequest,
            repo: repo.into(),
            number: Some(self.number),
            title: self.title.clone(),
            head_ref: String::new(),
            base_ref: None,
            state,
            merged_at,
            created_at: Some(self.created_at),
            updated_at: self.updated_at,
            author: self.user.as_ref().map(|o| PersonRef { connection_id: connection_id.into(), account_id: o.login.clone() }),
            reviewers: Vec::new(),
            checks: CheckState::None,
            review: ReviewState::None,
            url: self.html_url.clone(),
            sha: None,
            additions: None,
            deletions: None,
            changed_files: None,
            body: clip(self.body.as_deref().unwrap_or_default(), BODY_LIMIT),
            linked_keys: Vec::new(),
            head_repo: None,
        })
    }
}

impl Commit {
    /// A commit of `repo` read from `reference` (empty for the default branch, whose commits count as merged).
    pub fn change(&self, connection_id: &str, repo: &str, reference: &str) -> CodeChange {
        let (first, rest) = self.commit.message.split_once('\n').unwrap_or((&self.commit.message, ""));
        let at = self.commit.committer.as_ref().or(self.commit.author.as_ref()).and_then(|s| s.date).unwrap_or_default();
        CodeChange {
            connection_id: connection_id.into(),
            external_id: CodeChange::commit_id(repo, &self.sha),
            kind: CodeChangeKind::Commit,
            repo: repo.into(),
            number: None,
            title: first.trim().into(),
            head_ref: reference.into(),
            base_ref: None,
            state: if reference.is_empty() { CodeChangeState::Merged } else { CodeChangeState::Open },
            merged_at: None,
            created_at: Some(at),
            updated_at: at,
            author: self.author.as_ref().map(|o| PersonRef { connection_id: connection_id.into(), account_id: o.login.clone() }),
            reviewers: Vec::new(),
            checks: CheckState::None,
            review: ReviewState::None,
            url: self.html_url.clone(),
            sha: Some(self.sha.clone()),
            additions: None,
            deletions: None,
            changed_files: None,
            body: clip(rest.trim(), BODY_LIMIT),
            linked_keys: Vec::new(),
            head_repo: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review(user: &str, state: &str) -> Review {
        Review { id: 1, user: Some(Owner { login: user.into() }), state: state.into(), submitted_at: None }
    }

    fn run(status: &str, conclusion: Option<&str>) -> CheckRun {
        CheckRun { status: status.into(), conclusion: conclusion.map(String::from) }
    }

    #[test]
    fn the_review_outcome_follows_each_reviewers_latest_verdict() {
        assert_eq!(review_state(&[], 0), ReviewState::None);
        assert_eq!(review_state(&[], 2), ReviewState::Requested);
        assert_eq!(review_state(&[review("a", "COMMENTED")], 0), ReviewState::Commented);
        assert_eq!(review_state(&[review("a", "APPROVED")], 1), ReviewState::Approved, "an approval outranks a pending request");
        assert_eq!(review_state(&[review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")], 0), ReviewState::ChangesRequested);
        assert_eq!(review_state(&[review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")], 0), ReviewState::Approved, "the newer verdict wins");
        assert_eq!(review_state(&[review("a", "CHANGES_REQUESTED"), review("a", "COMMENTED")], 0), ReviewState::ChangesRequested, "a comment doesn't undo it");
        assert_eq!(review_state(&[review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED")], 0), ReviewState::None);
        assert_eq!(review_state(&[review("a", "PENDING")], 0), ReviewState::None);
    }

    #[test]
    fn checks_roll_up_failing_over_pending_over_passing() {
        assert_eq!(checks_state(&[], None), CheckState::None);
        assert_eq!(checks_state(&[run("completed", Some("success")), run("completed", Some("skipped")), run("completed", Some("neutral"))], None), CheckState::Passing);
        assert_eq!(checks_state(&[run("completed", Some("success")), run("in_progress", None)], None), CheckState::Pending);
        assert_eq!(checks_state(&[run("queued", None), run("completed", Some("failure"))], None), CheckState::Failing);
        for conclusion in ["timed_out", "cancelled", "action_required", "startup_failure"] {
            assert_eq!(checks_state(&[run("completed", Some(conclusion))], None), CheckState::Failing, "{conclusion}");
        }
    }

    #[test]
    fn legacy_commit_statuses_count_too_but_an_empty_one_does_not() {
        let status = |state: &str, n: u64| CombinedStatus { state: state.into(), total_count: n };
        assert_eq!(checks_state(&[], Some(&status("failure", 2))), CheckState::Failing);
        assert_eq!(checks_state(&[], Some(&status("error", 1))), CheckState::Failing);
        assert_eq!(checks_state(&[], Some(&status("pending", 1))), CheckState::Pending);
        assert_eq!(checks_state(&[], Some(&status("success", 1))), CheckState::Passing);
        assert_eq!(checks_state(&[], Some(&status("pending", 0))), CheckState::None, "GitHub reports 'pending' when there are no statuses");
        assert_eq!(checks_state(&[run("completed", Some("success"))], Some(&status("failure", 1))), CheckState::Failing);
    }
}
