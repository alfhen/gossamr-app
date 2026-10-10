//! GitHub as a `CodeHost`, over its REST API. Reads are in `read.rs`; `write.rs` holds the one write, a comment review
//! posted when the person approves a review draft.

pub(crate) mod http;
mod read;
#[cfg(test)]
pub(crate) mod testserver;
mod wire;
mod write;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use url::form_urlencoded;

use self::http::Api;
use self::wire::{IssueSearch, Owner, Pull, Repo, RepoSearch, User, UserEvent};
use super::{CodeAccount, CodeHost, Notices, PullList, Refreshed, ReviewAccess, ReviewComments};
use crate::db::Db;
use crate::domain::{
    ChangedFile, CodeChange, CodeFile, CodeHit, CommitQuery, ContainerPage, ContainerQuery, ContainerRef, Footprint, PostedReview, PullRequestDetail,
    ReviewComment, TreeEntry,
};
use crate::error::{Error, Result};

pub use self::http::error_message;

pub const API_BASE: &str = "https://api.github.com";
const PULL_PAGE: usize = 50;
const PULL_PAGES: usize = 6;
/// Searches list a few owners at most: the person and their organisations.
const SEARCH_OWNERS: usize = 10;
const SEARCH_PER_OWNER: usize = 30;

pub(super) fn encode(q: &str) -> String {
    form_urlencoded::byte_serialize(q.as_bytes()).collect()
}

pub struct GithubHost {
    api: Api,
    connection_id: String,
    login: String,
    owners: Mutex<Option<Vec<String>>>,
    /// Repositories (lowercased) where GitHub refused a review with a 403, with the sentence that says so. That refusal
    /// outranks whatever the token's scopes and permissions suggest.
    refused_reviews: Mutex<HashMap<String, String>>,
}

impl GithubHost {
    pub fn new(http: reqwest::Client, base: &str, token: &str, connection_id: &str, login: &str, db: Arc<Mutex<Db>>) -> Self {
        Self { api: Api::new(http, base, token, connection_id, db), connection_id: connection_id.into(), login: login.into(), owners: Mutex::new(None), refused_reviews: Mutex::new(HashMap::new()) }
    }

    /// The person's login and the organisations they belong to, which is where a repository search looks.
    async fn owners(&self) -> Result<Vec<String>> {
        if let Some(o) = self.owners.lock().expect("owners lock poisoned").clone() {
            return Ok(o);
        }
        let (orgs, _): (Vec<Owner>, _) = self.api.json("/user/orgs?per_page=100").await?;
        let mut owners = vec![self.login.clone()];
        owners.extend(orgs.into_iter().map(|o| o.login).take(SEARCH_OWNERS - 1));
        *self.owners.lock().expect("owners lock poisoned") = Some(owners.clone());
        Ok(owners)
    }

    async fn search_repositories(&self, query: &str, limit: usize) -> Result<Vec<Repo>> {
        let mut found: Vec<Repo> = Vec::new();
        for (n, owner) in self.owners().await?.iter().enumerate() {
            let qualifier = if n == 0 { "user" } else { "org" };
            let q = encode(&format!("{query} in:name fork:true {qualifier}:{owner}"));
            let (hits, _): (RepoSearch, _) = self.api.json(&format!("/search/repositories?q={q}&sort=updated&per_page={SEARCH_PER_OWNER}")).await?;
            found.extend(hits.items);
        }
        let mut seen = HashSet::new();
        found.retain(|r| seen.insert(r.full_name.clone()));
        found.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
        found.truncate(limit);
        Ok(found)
    }

    async fn pulls(&self, repo: &str, state: &str, since: Option<DateTime<Utc>>) -> Result<(Vec<CodeChange>, bool)> {
        let mut out = Vec::new();
        let mut next = Some(format!("/repos/{repo}/pulls?state={state}&sort=updated&direction=desc&per_page={PULL_PAGE}"));
        let mut unchanged = false;
        for n in 0..PULL_PAGES {
            let Some(url) = next.take() else { break };
            let (pulls, page): (Vec<Pull>, _) = self.api.json(&url).await?;
            if n == 0 {
                unchanged = page.unchanged;
            }
            let oldest = pulls.last().map(|p| p.updated_at);
            out.extend(pulls.iter().map(|p| p.change(&self.connection_id, repo)));
            // The list is newest first, so nothing further down can be newer than `since`.
            if since.is_some_and(|s| oldest.is_none_or(|o| o < s)) {
                break;
            }
            next = page.next;
        }
        if let Some(s) = since {
            out.retain(|c| c.updated_at >= s);
        }
        Ok((out, unchanged))
    }
}

fn footprint_row<'a>(rows: &'a mut HashMap<String, Footprint>, connection_id: &str, repo: &str, at: &str) -> &'a mut Footprint {
    let f = rows.entry(repo.to_string()).or_insert_with(|| Footprint {
        container: ContainerRef { connection_id: connection_id.into(), external_id: repo.into() },
        key: repo.into(),
        name: repo.rsplit('/').next().unwrap_or(repo).into(),
        commented: Some(0),
        mentioned: Some(0),
        ..Default::default()
    });
    if f.last_touch.as_deref() < Some(at) {
        f.last_touch = Some(at.into());
    }
    f
}

/// Whether a token may post a review on `repo`, from the repository as it reads to the token and the scopes a classic
/// token carries (`None` for a fine-grained token or an app). A classic token needs the `repo` scope, or `public_repo`
/// on a public repository, and read access; the others need write access to the repository. For a fine-grained token
/// those permissions are the person's role, not what the token was granted, so a token without `pull_requests: write`
/// reads as able to post until its first post is refused with a 403, which `refused_reviews` then keeps for the host's
/// life.
fn review_access_of(repo: &Repo, scopes: Option<&[String]>) -> ReviewAccess {
    let permissions = repo.permissions.as_ref();
    let has = |s: &str| scopes.is_some_and(|all| all.iter().any(|x| x == s));
    let lacks = match scopes {
        Some(_) if !has("repo") && !(has("public_repo") && !repo.private) => Some(if has("public_repo") {
            "it has only the public_repo scope, and the repository is private"
        } else {
            "it lacks the repo scope"
        }),
        Some(_) if !permissions.is_some_and(|p| p.pull || p.push || p.admin || p.maintain || p.triage) => Some("it can't read the repository"),
        Some(_) => None,
        None if !permissions.is_some_and(|p| p.push || p.admin || p.maintain) => Some("it lacks write access to its pull requests"),
        None => None,
    };
    match lacks {
        Some(why) => ReviewAccess { can_post: false, reason: Some(format!("This GitHub token can't post reviews on {} ({why}).", repo.full_name)) },
        None => ReviewAccess { can_post: true, reason: None },
    }
}

fn repo_of(repository_url: &str) -> Option<&str> {
    repository_url.split_once("/repos/").map(|(_, r)| r)
}

#[async_trait]
impl CodeHost for GithubHost {
    async fn me(&self) -> Result<CodeAccount> {
        let (user, page): (User, _) = self.api.json("/user").await?;
        Ok(CodeAccount { login: user.login, name: user.name, avatar_url: user.avatar_url, scopes: page.scopes })
    }

    async fn list_repositories(&self, q: &ContainerQuery) -> Result<ContainerPage> {
        let limit = q.limit.clamp(1, 100);
        let query = q.query.trim();
        let page_no: usize = q.cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(1);
        let listing = if let Some(org) = query.strip_prefix("org:") {
            Some(format!("/orgs/{}/repos?type=all&sort=pushed&per_page={limit}&page={page_no}", org.trim()))
        } else if query.is_empty() {
            Some(format!("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page={limit}&page={page_no}"))
        } else {
            None
        };
        let Some(listing) = listing else {
            let repos = self.search_repositories(query, limit).await?;
            return Ok(ContainerPage { containers: repos.iter().map(|r| r.summary(&self.connection_id)).collect(), next: None });
        };
        let (repos, page): (Vec<Repo>, _) = self.api.json(&listing).await?;
        Ok(ContainerPage { containers: repos.iter().map(|r| r.summary(&self.connection_id)).collect(), next: page.next.map(|_| (page_no + 1).to_string()) })
    }

    async fn footprint(&self, window_days: u32) -> Result<Vec<Footprint>> {
        let since = (Utc::now() - Duration::days(i64::from(window_days))).format("%Y-%m-%d");
        let login = &self.login;
        let searches = [
            ("reported", format!("is:pr author:{login}")),
            ("assigned", format!("is:pr is:open assignee:{login}")),
            ("assigned", format!("is:pr is:open review-requested:{login}")),
            ("commented", format!("is:pr commenter:{login}")),
            ("mentioned", format!("is:pr mentions:{login}")),
        ];
        let mut rows: HashMap<String, Footprint> = HashMap::new();
        let mut counted: HashSet<(String, u64, &str)> = HashSet::new();
        for (bucket, query) in searches {
            let q = encode(&format!("{query} updated:>={since}"));
            let (hits, _): (IssueSearch, _) = self.api.json(&format!("/search/issues?q={q}&per_page=100")).await?;
            for hit in hits.items {
                let Some(repo) = repo_of(&hit.repository_url) else { continue };
                if !counted.insert((repo.to_string(), hit.number, bucket)) {
                    continue;
                }
                let f = footprint_row(&mut rows, &self.connection_id, repo, &hit.updated_at);
                match bucket {
                    "reported" => f.reported += 1,
                    "assigned" => f.assigned += 1,
                    "commented" => f.commented = f.commented.map(|n| n + 1),
                    _ => f.mentioned = f.mentioned.map(|n| n + 1),
                }
            }
        }
        let (events, _): (Vec<UserEvent>, _) = self.api.json(&format!("/users/{login}/events?per_page=100")).await?;
        for e in events.iter().filter(|e| e.kind == "PushEvent") {
            footprint_row(&mut rows, &self.connection_id, &e.repo.name, &e.created_at);
        }
        let mut out: Vec<Footprint> = rows.into_values().collect();
        out.sort_by(|a, b| b.last_touch.cmp(&a.last_touch).then(a.key.cmp(&b.key)));
        Ok(out)
    }

    async fn pull_requests(&self, repo: &str, since: DateTime<Utc>) -> Result<PullList> {
        let (open, open_unchanged) = self.pulls(repo, "open", None).await?;
        let (recent, recent_unchanged) = self.pulls(repo, "all", Some(since)).await?;
        let mut seen: HashSet<u64> = HashSet::new();
        let mut changes: Vec<CodeChange> = open.into_iter().chain(recent).filter(|c| seen.insert(c.number.unwrap_or_default())).collect();
        changes.sort_by_key(|c| std::cmp::Reverse(c.updated_at));
        Ok(PullList { changes, unchanged: open_unchanged && recent_unchanged })
    }

    async fn refresh_pull_request(&self, change: &CodeChange, with_checks: bool) -> Result<Refreshed> {
        self.refresh(change, with_checks, true).await
    }

    async fn pull_request(&self, repo: &str, number: u64) -> Result<PullRequestDetail> {
        self.detail(repo, number).await
    }

    async fn pull_files(&self, repo: &str, number: u64) -> Result<Vec<ChangedFile>> {
        self.files_of(repo, number).await
    }

    async fn pull_request_change(&self, repo: &str, number: u64) -> Result<CodeChange> {
        let (pull, _): (Pull, _) = self.api.json(&format!("/repos/{repo}/pulls/{number}")).await?;
        Ok(pull.change(&self.connection_id, repo))
    }

    async fn branches(&self, repo: &str) -> Result<Vec<CodeChange>> {
        self.list_branches(repo).await
    }

    async fn commits(&self, q: &CommitQuery) -> Result<Vec<CodeChange>> {
        self.list_commits(q).await
    }

    async fn search(&self, query: &str, repos: &[String]) -> Result<Vec<CodeChange>> {
        self.search_changes(query, repos).await
    }

    async fn notifications(&self) -> Result<Notices> {
        self.poll_notifications().await
    }

    async fn file(&self, repo: &str, path: &str, reference: Option<&str>) -> Result<CodeFile> {
        self.read_file(repo, path, reference).await
    }

    async fn tree(&self, repo: &str, path: &str, reference: Option<&str>) -> Result<Vec<TreeEntry>> {
        self.list_tree(repo, path, reference).await
    }

    async fn search_code(&self, query: &str, repos: &[String]) -> Result<Vec<CodeHit>> {
        self.code_search(query, repos).await
    }

    async fn review_comments(&self, repo: &str, number: u64) -> Result<ReviewComments> {
        self.review_thread(repo, number).await
    }

    async fn review_access(&self, repo: &str) -> Result<ReviewAccess> {
        if let Some(reason) = self.refused_reviews.lock().expect("access lock poisoned").get(&repo.to_lowercase()) {
            return Ok(ReviewAccess { can_post: false, reason: Some(reason.clone()) });
        }
        let (found, page): (Repo, _) = self.api.json(&format!("/repos/{repo}")).await?;
        Ok(review_access_of(&found, page.scopes.as_deref()))
    }

    async fn posted_review(&self, repo: &str, number: u64, commit_sha: &str, summary: &str) -> Result<Option<PostedReview>> {
        let found = self.reviews(repo, number).await?.into_iter().find(|r| {
            r.user.as_ref().is_some_and(|u| u.login.eq_ignore_ascii_case(&self.login)) && r.state == "COMMENTED" && r.commit_id.as_deref() == Some(commit_sha) && r.body.as_deref() == Some(summary)
        });
        Ok(found.map(|r| PostedReview {
            url: r.html_url.filter(|u| !u.is_empty()).unwrap_or_else(|| format!("https://github.com/{repo}/pull/{number}#pullrequestreview-{}", r.id)),
            id: r.id,
            at: r.submitted_at.unwrap_or_else(Utc::now),
        }))
    }

    async fn post_review(&self, repo: &str, number: u64, commit_sha: &str, summary: &str, comments: &[ReviewComment]) -> Result<PostedReview> {
        let posted = write::post_review(&self.api, repo, number, commit_sha, summary, comments).await;
        if let Err(Error::CodeHost { status: 403, message }) = &posted {
            // Only the refusal of write access lasts; one asking for single sign-on is gone once the person authorises it.
            if *message == write::no_write_access(repo) {
                self.refused_reviews.lock().expect("access lock poisoned").insert(repo.to_lowercase(), message.clone());
            }
        }
        posted
    }
}

#[cfg(test)]
mod tests;
