//! GitHub as a `CodeHost`, over its REST API. Everything here only reads.

pub(crate) mod http;
#[cfg(test)]
pub(crate) mod testserver;
mod wire;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use url::form_urlencoded;

use self::http::Api;
use self::wire::{IssueSearch, Owner, Pull, Repo, RepoSearch, User, UserEvent};
use super::{CodeAccount, CodeHost, PullList};
use crate::db::Db;
use crate::domain::{CodeChange, ContainerPage, ContainerQuery, ContainerRef, Footprint};
use crate::error::Result;

pub use self::http::error_message;

pub const API_BASE: &str = "https://api.github.com";
const PULL_PAGE: usize = 50;
const PULL_PAGES: usize = 6;
/// Searches list a few owners at most: the person and their organisations.
const SEARCH_OWNERS: usize = 10;
const SEARCH_PER_OWNER: usize = 30;

fn encode(q: &str) -> String {
    form_urlencoded::byte_serialize(q.as_bytes()).collect()
}

pub struct GithubHost {
    api: Api,
    connection_id: String,
    login: String,
    owners: Mutex<Option<Vec<String>>>,
}

impl GithubHost {
    pub fn new(http: reqwest::Client, base: &str, token: &str, connection_id: &str, login: &str, db: Arc<Mutex<Db>>) -> Self {
        Self { api: Api::new(http, base, token, connection_id, db), connection_id: connection_id.into(), login: login.into(), owners: Mutex::new(None) }
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
}

#[cfg(test)]
mod tests;
