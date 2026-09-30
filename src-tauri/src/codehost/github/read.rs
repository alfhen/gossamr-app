//! GitHub reads beyond the catalog: pull request details, branches, commits, search, notifications and files.

use std::collections::HashMap;

use chrono::Utc;
use url::Url;

use super::wire::{
    checks_state, review_state, BranchItem, CheckRuns, CodeItems, CombinedStatus, Commit, CommitSearch, Entry, Notification, Pull, PullCommit, PullFile,
    PullHits, Review,
};
use super::{encode, GithubHost};
use crate::codehost::keys::KeyMatcher;
use crate::codehost::{Notices, Refreshed};
use crate::domain::{
    clip, ChangedFile, CheckState, CodeChange, CodeChangeKind, CodeChangeState, CodeFile, CodeHit, CommitInfo, CommitQuery, Notice, PersonRef,
    PullRequestDetail, ReviewInfo, ReviewState, TreeEntry, TreeEntryKind,
};
use crate::error::{Error, Result};

const PATCH_LIMIT: usize = 4000;
const FILE_PAGES: usize = 3;
const COMMITS_SHOWN: usize = 30;
const BRANCH_PAGES: usize = 3;
const COMMIT_PAGES: usize = 3;
/// Characters of a file handed on; the rest is reported as `truncated`.
const FILE_TEXT_LIMIT: usize = 60_000;
/// Repositories whose branches are scanned for a key in one search.
const BRANCH_SCAN_REPOS: usize = 20;
const BRANCH_MATCHES: usize = 10;
/// A search query may be 256 characters; the repositories share what the terms leave.
const REPO_QUALIFIERS_MAX: usize = 190;
const TEXT_MATCH: &str = "application/vnd.github.text-match+json";

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in text.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// `/repos/{repo}/contents/{path}` with each path segment escaped, and the ref as a query.
fn contents_path(repo: &str, path: &str, reference: Option<&str>) -> String {
    let mut url = Url::parse("https://x.invalid/").expect("static url");
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.clear().extend(["repos"]).extend(repo.split('/')).extend(["contents"]).extend(path.split('/').filter(|s| !s.is_empty()));
    }
    let mut out = url.path().to_string();
    if let Some(r) = reference.filter(|r| !r.is_empty()) {
        out.push_str(&format!("?ref={}", encode(r)));
    }
    out
}

/// Groups repositories into `repo:` qualifiers that fit a search query.
fn qualifier_groups(repos: &[String]) -> Vec<String> {
    let mut groups: Vec<String> = Vec::new();
    for r in repos {
        let q = format!("repo:{r}");
        match groups.last_mut() {
            Some(g) if g.len() + q.len() < REPO_QUALIFIERS_MAX => {
                g.push(' ');
                g.push_str(&q);
            }
            _ => groups.push(q),
        }
    }
    groups
}

/// Whether `text` is a work item key such as `CA-208`.
fn is_key(text: &str) -> bool {
    text.rsplit_once('-').is_some_and(|(p, n)| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

fn names(query: &str, text: &str) -> bool {
    let Some((prefix, _)) = query.rsplit_once('-') else { return false };
    KeyMatcher::new([prefix]).find(text).iter().any(|k| k.eq_ignore_ascii_case(query))
}

fn status_error(e: &Error) -> bool {
    matches!(e, Error::CodeHost { status: 403 | 404 | 422, .. })
}

impl GithubHost {
    fn person(&self, login: &str) -> PersonRef {
        PersonRef { connection_id: self.connection_id.clone(), account_id: login.into() }
    }

    /// Checks need permissions a token may lack, so a refusal means "unknown", not a failure.
    async fn checks(&self, repo: &str, sha: &str) -> Result<CheckState> {
        let runs = match self.api.json::<CheckRuns>(&format!("/repos/{repo}/commits/{sha}/check-runs?per_page=100")).await {
            Ok((r, _)) => r.check_runs,
            Err(e) if status_error(&e) => Vec::new(),
            Err(e) => return Err(e),
        };
        let status = match self.api.json::<CombinedStatus>(&format!("/repos/{repo}/commits/{sha}/status")).await {
            Ok((s, _)) => Some(s),
            Err(e) if status_error(&e) => None,
            Err(e) => return Err(e),
        };
        Ok(checks_state(&runs, status.as_ref()))
    }

    async fn reviews(&self, repo: &str, number: u64) -> Result<Vec<Review>> {
        Ok(self.api.paged(&format!("/repos/{repo}/pulls/{number}/reviews?per_page=100"), 3).await?.0)
    }

    fn review_infos(&self, reviews: &[Review]) -> Vec<ReviewInfo> {
        reviews
            .iter()
            .filter_map(|r| {
                let state = match r.state.as_str() {
                    "APPROVED" => ReviewState::Approved,
                    "CHANGES_REQUESTED" => ReviewState::ChangesRequested,
                    "COMMENTED" => ReviewState::Commented,
                    _ => return None,
                };
                Some(ReviewInfo { id: r.id.to_string(), reviewer: self.person(&r.user.as_ref()?.login), state, at: r.submitted_at })
            })
            .collect()
    }

    pub(super) async fn refresh(&self, change: &CodeChange, with_checks: bool) -> Result<Refreshed> {
        let number = change.number.unwrap_or_default();
        let (pull, _): (Pull, _) = self.api.json(&format!("/repos/{}/pulls/{number}", change.repo)).await?;
        let mut fresh = pull.change(&self.connection_id, &change.repo);
        let reviews = self.reviews(&change.repo, number).await?;
        fresh.review = review_state(&reviews, pull.requested_reviewers.len());
        fresh.checks = change.checks;
        let open = matches!(fresh.state, CodeChangeState::Open | CodeChangeState::Draft);
        if with_checks && open {
            fresh.checks = self.checks(&change.repo, &pull.head.sha).await?;
        }
        if fresh.sha != change.sha {
            // The cached rollup belongs to another commit.
            fresh.checks = if with_checks && open { fresh.checks } else { CheckState::None };
        }
        fresh.linked_keys = change.linked_keys.clone();
        Ok(Refreshed { reviews: self.review_infos(&reviews), change: fresh })
    }

    pub(super) async fn detail(&self, repo: &str, number: u64) -> Result<PullRequestDetail> {
        let (pull, _): (Pull, _) = self.api.json(&format!("/repos/{repo}/pulls/{number}")).await?;
        let Refreshed { change, reviews } = self.refresh(&pull.change(&self.connection_id, repo), true).await?;
        let (files, _): (Vec<PullFile>, _) = self.api.paged(&format!("/repos/{repo}/pulls/{number}/files?per_page=100"), FILE_PAGES).await?;
        let (commits, _): (Vec<PullCommit>, _) = self.api.paged(&format!("/repos/{repo}/pulls/{number}/commits?per_page=100"), 1).await?;
        let listed = files.len() as u64;
        let skip = commits.len().saturating_sub(COMMITS_SHOWN);
        Ok(PullRequestDetail {
            files_truncated: change.changed_files.is_some_and(|n| n > listed),
            files: files
                .into_iter()
                .map(|f| ChangedFile { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch.map(|p| clip(&p, PATCH_LIMIT)) })
                .collect(),
            commits: commits
                .into_iter()
                .skip(skip)
                .map(|c| CommitInfo {
                    sha: c.sha,
                    message: clip(&c.commit.message, 500),
                    author: c.author.map(|a| a.login).or_else(|| c.commit.author.as_ref().and_then(|a| a.name.clone())),
                    at: c.commit.committer.as_ref().or(c.commit.author.as_ref()).and_then(|s| s.date).unwrap_or_default(),
                    url: c.html_url,
                })
                .collect(),
            reviews,
            change,
        })
    }

    pub(super) async fn list_branches(&self, repo: &str) -> Result<Vec<CodeChange>> {
        let (branches, _): (Vec<BranchItem>, _) = self.api.paged(&format!("/repos/{repo}/branches?per_page=100"), BRANCH_PAGES).await?;
        let now = Utc::now();
        Ok(branches
            .into_iter()
            .map(|b| CodeChange {
                connection_id: self.connection_id.clone(),
                external_id: CodeChange::branch_id(repo, &b.name),
                kind: CodeChangeKind::Branch,
                repo: repo.into(),
                number: None,
                url: format!("https://github.com/{repo}/tree/{}", b.name),
                head_ref: b.name.clone(),
                title: b.name,
                base_ref: None,
                state: CodeChangeState::Open,
                merged_at: None,
                created_at: None,
                updated_at: now,
                author: None,
                reviewers: Vec::new(),
                checks: CheckState::None,
                review: ReviewState::None,
                sha: Some(b.commit.sha),
                additions: None,
                deletions: None,
                changed_files: None,
                body: String::new(),
                linked_keys: Vec::new(),
            })
            .collect())
    }

    pub(super) async fn list_commits(&self, q: &CommitQuery) -> Result<Vec<CodeChange>> {
        let limit = if q.limit == 0 { COMMITS_SHOWN } else { q.limit.min(100) };
        let reference = q.reference.clone().unwrap_or_default();
        let mut target = format!("/repos/{}/commits?per_page=100", q.repo);
        if !reference.is_empty() {
            target.push_str(&format!("&sha={}", encode(&reference)));
        }
        if let Some(since) = q.since {
            target.push_str(&format!("&since={}", encode(&since.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))));
        }
        if let Some(path) = q.path.as_deref().filter(|p| !p.is_empty()) {
            target.push_str(&format!("&path={}", encode(path)));
        }
        let text = q.text.as_deref().map(str::to_lowercase).filter(|t| !t.is_empty());
        let mut out = Vec::new();
        let mut next = Some(target);
        for _ in 0..COMMIT_PAGES {
            let Some(url) = next.take() else { break };
            let (commits, page): (Vec<Commit>, _) = self.api.json(&url).await?;
            out.extend(commits.iter().filter(|c| text.as_ref().is_none_or(|t| c.commit.message.to_lowercase().contains(t))).map(|c| c.change(&self.connection_id, &q.repo, &reference)));
            if out.len() >= limit {
                break;
            }
            next = page.next;
        }
        out.truncate(limit);
        Ok(out)
    }

    pub(super) async fn search_changes(&self, query: &str, repos: &[String]) -> Result<Vec<CodeChange>> {
        let query = query.trim();
        let exact = is_key(query);
        let mut found: HashMap<String, CodeChange> = HashMap::new();
        let mut add = |c: CodeChange| {
            let richer = found.get(&c.external_id).is_none_or(|old| old.head_ref.is_empty());
            if richer {
                found.insert(c.external_id.clone(), c);
            }
        };
        if exact {
            for repo in repos.iter().take(BRANCH_SCAN_REPOS) {
                // One repository the token can't read must not hide what the others have.
                let branches = match self.list_branches(repo).await {
                    Ok(b) => b,
                    Err(e) if status_error(&e) => continue,
                    Err(e) => return Err(e),
                };
                let matching: Vec<CodeChange> = branches.into_iter().filter(|b| names(query, &b.title)).take(BRANCH_MATCHES).collect();
                for branch in matching {
                    let owner = repo.split('/').next().unwrap_or_default();
                    let (pulls, _): (Vec<Pull>, _) = self.api.json(&format!("/repos/{repo}/pulls?head={}&state=all&per_page=5", encode(&format!("{owner}:{}", branch.title)))).await?;
                    if pulls.is_empty() {
                        let mut branch = branch;
                        if let Some(sha) = branch.sha.clone() {
                            if let Ok((c, _)) = self.api.json::<Commit>(&format!("/repos/{repo}/commits/{sha}")).await {
                                let tip = c.change(&self.connection_id, repo, &branch.title);
                                branch.updated_at = tip.updated_at;
                                branch.author = tip.author;
                            }
                        }
                        add(branch);
                    }
                    pulls.iter().for_each(|p| add(p.change(&self.connection_id, repo)));
                }
            }
        }
        for group in qualifier_groups(repos) {
            let q = encode(&format!("is:pr {query} in:title,body {group}"));
            let (hits, _): (PullHits, _) = self.api.json(&format!("/search/issues?q={q}&per_page=30")).await?;
            for c in hits.items.iter().filter_map(|h| h.change(&self.connection_id)) {
                if !exact || names(query, &c.title) || names(query, &c.body) {
                    add(c);
                }
            }
            let q = encode(&format!("{query} {group}"));
            let (hits, _): (CommitSearch, _) = self.api.json(&format!("/search/commits?q={q}&per_page=30")).await?;
            for c in hits.items {
                let Some(repo) = c.repository.as_ref().map(|r| r.full_name.clone()) else { continue };
                if !exact || names(query, &c.commit.message) {
                    add(c.change(&self.connection_id, &repo, ""));
                }
            }
        }
        let mut out: Vec<CodeChange> = found.into_values().collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.external_id.cmp(&b.external_id)));
        Ok(out)
    }

    pub(super) async fn poll_notifications(&self) -> Result<Notices> {
        let (threads, page): (Vec<Notification>, _) = self.api.json("/notifications?per_page=50").await?;
        let notices = threads
            .into_iter()
            .map(|n| Notice {
                number: n.subject.url.as_deref().and_then(|u| u.rsplit('/').next()).and_then(|s| s.parse().ok()),
                id: n.id,
                reason: n.reason,
                repo: n.repository.full_name,
                title: n.subject.title,
                subject: n.subject.kind,
                url: n.subject.url.unwrap_or_default(),
                updated_at: n.updated_at,
                unread: n.unread,
            })
            .collect();
        Ok(Notices { notices, unchanged: page.unchanged, poll_interval: page.poll_interval })
    }

    pub(super) async fn read_file(&self, repo: &str, path: &str, reference: Option<&str>) -> Result<CodeFile> {
        let page = self.api.get(&contents_path(repo, path, reference)).await?;
        let value: serde_json::Value = serde_json::from_str(&page.body)?;
        if value.is_array() {
            return Err(Error::CodeHost { status: 400, message: format!("{path} is a directory; list it instead.") });
        }
        let size = value["size"].as_u64().unwrap_or_default();
        let encoded = value["content"].as_str().unwrap_or_default();
        if value["type"] != "file" || encoded.is_empty() && size > 0 {
            return Err(Error::CodeHost { status: 413, message: format!("{path} is too large for GitHub to return ({size} bytes).") });
        }
        let bytes = base64_decode(encoded).ok_or_else(|| Error::CodeHost { status: 502, message: "GitHub returned content that isn't base64.".into() })?;
        let text = String::from_utf8(bytes).ok().filter(|t| !t.contains('\0')).ok_or_else(|| Error::CodeHost { status: 415, message: format!("{path} is a binary file.") })?;
        let truncated = text.chars().count() > FILE_TEXT_LIMIT;
        Ok(CodeFile { repo: repo.into(), path: path.into(), reference: reference.unwrap_or_default().into(), text: clip(&text, FILE_TEXT_LIMIT), size, truncated })
    }

    pub(super) async fn list_tree(&self, repo: &str, path: &str, reference: Option<&str>) -> Result<Vec<TreeEntry>> {
        let page = self.api.get(&contents_path(repo, path, reference)).await?;
        let value: serde_json::Value = serde_json::from_str(&page.body)?;
        if !value.is_array() {
            return Err(Error::CodeHost { status: 400, message: format!("{path} is a file; read it instead.") });
        }
        let entries: Vec<Entry> = serde_json::from_value(value)?;
        let mut out: Vec<TreeEntry> = entries
            .into_iter()
            .map(|e| TreeEntry {
                kind: match e.kind.as_str() {
                    "dir" => TreeEntryKind::Dir,
                    "symlink" => TreeEntryKind::Symlink,
                    "submodule" => TreeEntryKind::Submodule,
                    _ => TreeEntryKind::File,
                },
                name: e.name,
                path: e.path,
                size: e.size,
            })
            .collect();
        out.sort_by(|a, b| (a.kind != TreeEntryKind::Dir).cmp(&(b.kind != TreeEntryKind::Dir)).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    pub(super) async fn code_search(&self, query: &str, repos: &[String]) -> Result<Vec<CodeHit>> {
        let mut out = Vec::new();
        for group in qualifier_groups(repos) {
            let q = encode(&format!("{query} {group}"));
            let page = self.api.get_with(&format!("/search/code?q={q}&per_page=20"), TEXT_MATCH).await?;
            let hits: CodeItems = serde_json::from_str(&page.body)?;
            out.extend(hits.items.into_iter().map(|h| CodeHit {
                repo: h.repository.full_name,
                path: h.path,
                url: h.html_url,
                fragments: h.text_matches.into_iter().map(|m| clip(&m.fragment, 400)).collect(),
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes_with_line_breaks_and_padding() {
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(base64_decode("aGVs\nbG8g\nd29y\nbGQ=\n").unwrap(), b"hello world");
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("YQ==").unwrap(), b"a");
        assert!(base64_decode("a$b").is_none());
    }

    #[test]
    fn content_paths_escape_each_segment_and_the_ref() {
        assert_eq!(contents_path("acme/webshop", "src/my file.rs", Some("feature/x y")), "/repos/acme/webshop/contents/src/my%20file.rs?ref=feature%2Fx+y");
        assert_eq!(contents_path("acme/webshop", "", None), "/repos/acme/webshop/contents");
        assert_eq!(contents_path("acme/webshop", "/a//b/", Some("")), "/repos/acme/webshop/contents/a/b");
    }

    #[test]
    fn repositories_are_grouped_to_fit_a_search_query() {
        let repos: Vec<String> = (0..40).map(|i| format!("acme/repository-{i}")).collect();
        let groups = qualifier_groups(&repos);
        assert!(groups.len() > 1 && groups.iter().all(|g| g.len() < 256 - 60));
        assert_eq!(groups.iter().map(|g| g.matches("repo:").count()).sum::<usize>(), 40);
        assert!(qualifier_groups(&[]).is_empty());
    }

    #[test]
    fn keys_are_told_from_free_text() {
        assert!(is_key("CA-208") && is_key("ca-208") && is_key("DEVOPS-471"));
        assert!(!is_key("checkout gateway") && !is_key("CA-") && !is_key("-208") && !is_key("CA-20x"));
        assert!(names("CA-208", "Fix CA-208: gateway") && !names("CA-208", "CA-2081") && !names("CA-208", "fix the gateway"));
    }
}
