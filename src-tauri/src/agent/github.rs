//! Pip's read-only view of GitHub. Every tool goes through `Core`'s watched-repository checks and none of them can
//! write: the `CodeHost` trait has no write methods, and the tests watch the wire for anything but GET.

use serde_json::{json, Value};

use super::mcp::{item_ref, opt, reachable, required, tool, McpState, Reply, PipRun};
use crate::domain::{
    clip, CheckState, CodeChange, CodeChangeKind, CodeChangeState, CommitQuery, PullRequestDetail,
    ReviewState, TreeEntryKind,
};
use crate::inbox::CodeRef;

const FILE_CHARS: usize = 15_000;
const TREE_SHOWN: usize = 150;
const COMMITS_DEFAULT: usize = 20;
const COMMITS_MAX: usize = 50;
const PULLS_SHOWN: usize = 30;
const HITS_SHOWN: usize = 20;
const FRAGMENTS_SHOWN: usize = 3;
const FRAGMENT_CHARS: usize = 300;
const LINKS_SHOWN: usize = 30;
const LINKED_PRS_DETAILED: usize = 10;
const LINKED_FILES_SHOWN: usize = 15;
const PR_FILES_SHOWN: usize = 50;
const PR_COMMITS_SHOWN: usize = 15;
const PATCH_CHARS: usize = 1_500;
const PATCHES_TOTAL_CHARS: usize = 10_000;
const PR_BODY_CHARS: usize = 1_500;
const TITLE_CHARS: usize = 120;

pub(super) const NAMES: [&str; 8] = [
    "ticket_changes",
    "get_pull_request",
    "list_pull_requests",
    "read_repo_file",
    "list_repo_files",
    "list_commits",
    "search_code",
    "list_watched_repos",
];

pub(super) fn tools() -> Vec<Value> {
    let text = |d: &str| json!({ "type": "string", "description": d });
    let repo =
        text("Repository as owner/name, e.g. acme/webshop. Must be one of list_watched_repos.");
    let reference = text("Branch, tag or commit. The default branch when left out.");
    vec![
        tool(
            "ticket_changes",
            "What has been done on a ticket in code: the pull requests, branches and commits in the watched repositories that name its key, with state, checks, review outcome and the files each pull request changes. Read-only. Cite the pull request links in your answer.",
            json!({ "key": json!({ "type": "string", "description": "Item key, e.g. CA-412" }) }),
            &["key"],
        ),
        tool(
            "get_pull_request",
            "Read one pull request in a watched repository: description, state, checks, reviews, recent commits and the files it changes with cut-short diffs. Read-only.",
            json!({ "repo": repo, "number": { "type": "integer" } }),
            &["repo", "number"],
        ),
        tool(
            "list_pull_requests",
            "List a watched repository's open pull requests and those updated in the last month, newest first. Read-only.",
            json!({ "repo": repo }),
            &["repo"],
        ),
        tool(
            "read_repo_file",
            "Read a text file from a watched repository. Long files are cut short and say so. Read-only.",
            json!({ "repo": repo, "path": text("File path, e.g. src/main.rs"), "ref": reference }),
            &["repo", "path"],
        ),
        tool(
            "list_repo_files",
            "List the files and folders in one folder of a watched repository (the top level when path is left out). Long listings are cut short and say so. Read-only.",
            json!({ "repo": repo, "path": text("Folder path; empty for the top level"), "ref": reference }),
            &["repo"],
        ),
        tool(
            "list_commits",
            "Recent commits of a watched repository, newest first, optionally on one branch, touching one file or folder, or mentioning some text such as a ticket key. Read-only.",
            json!({
                "repo": repo,
                "ref": reference,
                "path": text("Only commits touching this file or folder"),
                "query": text("Only commits whose message contains this"),
                "limit": { "type": "integer" }
            }),
            &["repo"],
        ),
        tool(
            "search_code",
            "Search the code of the watched repositories, or of one of them. Read-only.",
            json!({ "query": text("Search terms"), "repo": text("Limit to one watched repository, owner/name") }),
            &["query"],
        ),
        tool("list_watched_repos", "List the GitHub repositories the user watches. The other GitHub tools work only on these.", json!({}), &[]),
    ]
}

fn unwatched(repo: &str) -> String {
    format!(
        "{repo} isn't a repository the user watches, so it is out of reach. Ask the person to watch it in Gossamr's GitHub settings, then try again. list_watched_repos shows what is watched."
    )
}

/// The connection that watches `repo` and the repository as GitHub spells it, or the refusal to give Pip.
fn connection(st: &McpState, repo: &str) -> std::result::Result<(String, String), String> {
    st.core
        .code_connection_for(repo)
        .map_err(|_| unwatched(repo))
}

fn kind_word(c: &CodeChange) -> &'static str {
    match c.kind {
        CodeChangeKind::PullRequest => "pull request",
        CodeChangeKind::Branch => "branch",
        CodeChangeKind::Commit => "commit",
    }
}

fn review_word(r: ReviewState) -> Option<&'static str> {
    match r {
        ReviewState::None => None,
        ReviewState::Requested => Some("review requested"),
        ReviewState::Approved => Some("approved"),
        ReviewState::ChangesRequested => Some("changes requested"),
        ReviewState::Commented => Some("commented"),
    }
}

pub(super) fn change_line(c: &CodeChange) -> String {
    let state = match c.state {
        CodeChangeState::Draft => "draft",
        CodeChangeState::Open => "open",
        CodeChangeState::Merged => "merged",
        CodeChangeState::Closed => "closed",
    };
    let mut parts = vec![
        format!("{} ({})", c.label(), kind_word(c)),
        state.to_string(),
        clip(c.title.lines().next().unwrap_or_default(), TITLE_CHARS),
    ];
    if c.kind == CodeChangeKind::PullRequest {
        parts.extend(match c.checks {
            CheckState::None => None,
            CheckState::Pending => Some("checks pending".to_string()),
            CheckState::Passing => Some("checks passing".into()),
            CheckState::Failing => Some("checks failing".into()),
        });
        parts.extend(review_word(c.review).map(String::from));
    }
    parts.extend(c.author.as_ref().map(|a| format!("by {}", a.account_id)));
    parts.push(format!("updated {}", c.updated_at.format("%Y-%m-%d")));
    parts.push(c.url.clone());
    parts.join(" · ")
}

fn pull_detail(d: &PullRequestDetail, files_shown: usize, with_patches: bool) -> String {
    let mut out = String::new();
    let c = &d.change;
    if let (Some(a), Some(del), Some(n)) = (c.additions, c.deletions, c.changed_files) {
        out.push_str(&format!("Size: +{a} −{del} in {n} files\n"));
    }
    if !d.reviews.is_empty() {
        let reviews: Vec<String> = d
            .reviews
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.reviewer.account_id,
                    review_word(r.state).unwrap_or("pending")
                )
            })
            .collect();
        out.push_str(&format!("Reviews: {}\n", reviews.join(", ")));
    }
    if !c.reviewers.is_empty() {
        out.push_str(&format!(
            "Review requested from: {}\n",
            c.reviewers
                .iter()
                .map(|r| r.account_id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !d.commits.is_empty() {
        out.push_str("Commits:\n");
        for k in d.commits.iter().take(PR_COMMITS_SHOWN) {
            out.push_str(&format!(
                "  {} {}\n",
                k.sha.chars().take(7).collect::<String>(),
                clip(k.message.lines().next().unwrap_or_default(), TITLE_CHARS)
            ));
        }
        if d.commits.len() > PR_COMMITS_SHOWN {
            out.push_str(&format!(
                "  …and {} more commits not shown\n",
                d.commits.len() - PR_COMMITS_SHOWN
            ));
        }
    }
    out.push_str("Files:\n");
    let mut budget = PATCHES_TOTAL_CHARS;
    for f in d.files.iter().take(files_shown) {
        out.push_str(&format!(
            "  {} {} +{} −{}\n",
            f.status, f.path, f.additions, f.deletions
        ));
        if let (true, Some(patch)) = (with_patches, &f.patch) {
            let shown = clip(patch, PATCH_CHARS.min(budget));
            if shown.is_empty() {
                continue;
            }
            budget -= shown.chars().count();
            let cut = if shown.chars().count() < patch.chars().count() {
                "\n  [diff cut short]"
            } else {
                ""
            };
            out.push_str(&format!(
                "{}{cut}\n",
                shown
                    .lines()
                    .map(|l| format!("    {l}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
    }
    if d.files.len() > files_shown || d.files_truncated {
        let note = if d.files.len() > files_shown {
            format!("{} of {} files", files_shown, d.files.len())
        } else {
            format!("the first {} files", d.files.len())
        };
        out.push_str(&format!("  [Truncated: showing {note}.]\n"));
    }
    out
}

fn number(args: &Value) -> std::result::Result<u64, String> {
    args["number"]
        .as_u64()
        .or_else(|| args["number"].as_str().and_then(|s| s.trim().parse().ok()))
        .ok_or_else(|| "number is required".to_string())
}

pub(super) async fn run(st: &McpState, run: &PipRun, name: &str, args: &Value) -> Option<Reply> {
    if !NAMES.contains(&name) {
        return None;
    }
    Some(dispatch(st, run, name, args).await)
}

async fn dispatch(st: &McpState, run: &PipRun, name: &str, args: &Value) -> Reply {
    let core = &st.core;
    match name {
        "list_watched_repos" => {
            let repos = core.watched_code_repos().map_err(|e| e.to_string())?;
            if repos.is_empty() {
                return Ok("No repositories are watched. Ask the person to connect GitHub and choose repositories in Gossamr's settings.".into());
            }
            Ok(repos
                .iter()
                .map(|(_, r)| r.as_str())
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "ticket_changes" => {
            let key = required(args, "key")?;
            reachable(st, run, key).await?;
            let item = item_ref(&run.scope, key);
            let (links, stale) = match core.dev_links_live(&item).await {
                Ok((links, _)) => (links, None),
                Err(e) => (
                    core.dev_links(&item).map_err(|e| e.to_string())?,
                    Some(e.to_string()),
                ),
            };
            let mut out = String::new();
            if let Some(why) = stale {
                out.push_str(&format!("GitHub couldn't be searched just now ({why}); this is what was cached earlier.\n"));
            }
            if links.is_empty() {
                out.push_str(&format!("No pull request, branch or commit in the watched repositories names {key}. Work in a repository that isn't watched is invisible here."));
                return Ok(out);
            }
            out.push_str(&format!("{} linked changes", links.len()));
            if links.len() > LINKS_SHOWN {
                out.push_str(&format!(", showing {LINKS_SHOWN}"));
            }
            let mut detailed = 0;
            for l in links.iter().take(LINKS_SHOWN) {
                let c = &l.change;
                out.push_str(&format!(
                    "\n\n{} · linked by its {}",
                    change_line(c),
                    l.provenance.as_str()
                ));
                let Some(n) = c.number.filter(|_| c.kind == CodeChangeKind::PullRequest) else {
                    continue;
                };
                if detailed == LINKED_PRS_DETAILED {
                    out.push_str("\n(details not read; ask for get_pull_request)");
                    continue;
                }
                detailed += 1;
                match core
                    .code_pull_request(&CodeRef {
                        connection_id: c.connection_id.clone(),
                        repo: c.repo.clone(),
                        number: n,
                    })
                    .await
                {
                    Ok(d) => {
                        out.push('\n');
                        out.push_str(pull_detail(&d, LINKED_FILES_SHOWN, false).trim_end());
                    }
                    Err(e) => out.push_str(&format!("\n(details unavailable: {e})")),
                }
            }
            Ok(out)
        }
        "get_pull_request" => {
            let repo = required(args, "repo")?;
            let (id, repo) = connection(st, repo)?;
            let repo = repo.as_str();
            let d = core
                .code_pull_request(&CodeRef {
                    connection_id: id,
                    repo: repo.into(),
                    number: number(args)?,
                })
                .await
                .map_err(|e| e.to_string())?;
            let body = if d.change.body.trim().is_empty() {
                String::new()
            } else {
                format!("\n{}\n", clip(&d.change.body, PR_BODY_CHARS))
            };
            Ok(format!(
                "{}{body}\n{}",
                change_line(&d.change),
                pull_detail(&d, PR_FILES_SHOWN, true).trim_end()
            ))
        }
        "list_pull_requests" => {
            let repo = required(args, "repo")?;
            let (id, repo) = connection(st, repo)?;
            let repo = repo.as_str();
            let found = core
                .code_pull_requests(&id, repo)
                .await
                .map_err(|e| e.to_string())?;
            if found.is_empty() {
                return Ok(format!(
                    "No open or recently updated pull requests in {repo}."
                ));
            }
            let mut out = format!("{} pull requests", found.len());
            if found.len() > PULLS_SHOWN {
                out.push_str(&format!(", showing the newest {PULLS_SHOWN}"));
            }
            found
                .iter()
                .take(PULLS_SHOWN)
                .for_each(|c| out.push_str(&format!("\n{}", change_line(c))));
            Ok(out)
        }
        "read_repo_file" => {
            let repo = required(args, "repo")?;
            let (id, repo) = connection(st, repo)?;
            let repo = repo.as_str();
            let f = core
                .code_file(&id, repo, required(args, "path")?, opt(args, "ref"))
                .await
                .map_err(|e| e.to_string())?;
            let shown = clip(&f.text, FILE_CHARS);
            let mut out = format!("{}:{} ({} bytes)\n\n{shown}", f.repo, f.path, f.size);
            if f.truncated || shown.chars().count() < f.text.chars().count() {
                out.push_str(&format!(
                    "\n\n[Truncated: the file is longer than what is shown ({} characters).]",
                    shown.chars().count()
                ));
            }
            Ok(out)
        }
        "list_repo_files" => {
            let repo = required(args, "repo")?;
            let (id, repo) = connection(st, repo)?;
            let repo = repo.as_str();
            let entries = core
                .code_tree(
                    &id,
                    repo,
                    opt(args, "path").unwrap_or_default(),
                    opt(args, "ref"),
                )
                .await
                .map_err(|e| e.to_string())?;
            if entries.is_empty() {
                return Ok("Nothing there.".into());
            }
            let mut out = format!("{} entries", entries.len());
            if entries.len() > TREE_SHOWN {
                out.push_str(&format!(
                    ", showing the first {TREE_SHOWN}; [Truncated] list a subfolder for the rest"
                ));
            }
            for e in entries.iter().take(TREE_SHOWN) {
                let kind = match e.kind {
                    TreeEntryKind::Dir => "dir ",
                    TreeEntryKind::File => "file",
                    TreeEntryKind::Symlink => "link",
                    TreeEntryKind::Submodule => "submodule",
                };
                out.push_str(&format!("\n{kind} {} ({} bytes)", e.path, e.size));
            }
            Ok(out)
        }
        "list_commits" => {
            let repo = required(args, "repo")?;
            let (id, repo) = connection(st, repo)?;
            let repo = repo.as_str();
            let limit = args["limit"]
                .as_u64()
                .map_or(COMMITS_DEFAULT, |n| (n as usize).clamp(1, COMMITS_MAX));
            let q = CommitQuery {
                repo: repo.into(),
                reference: opt(args, "ref").map(String::from),
                since: None,
                path: opt(args, "path").map(String::from),
                text: opt(args, "query").map(String::from),
                limit,
            };
            let found = core
                .code_commits(&id, &q)
                .await
                .map_err(|e| e.to_string())?;
            if found.is_empty() {
                return Ok("No commits match.".into());
            }
            let mut out = format!("{} commits, newest first", found.len());
            if found.len() >= limit {
                out.push_str(&format!(" (limited to {limit}; there may be more)"));
            }
            found
                .iter()
                .for_each(|c| out.push_str(&format!("\n{}", change_line(c))));
            Ok(out)
        }
        "search_code" => {
            let query = required(args, "query")?;
            let hits = match opt(args, "repo") {
                Some(repo) => {
                    let (id, repo) = connection(st, repo)?;
                    let repo = repo.as_str();
                    core.code_search_code(&id, query, Some(&[repo.to_string()]))
                        .await
                        .map_err(|e| e.to_string())?
                }
                None => {
                    let mut all = Vec::new();
                    let mut ids: Vec<String> = core
                        .watched_code_repos()
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .map(|(id, _)| id)
                        .collect();
                    ids.dedup();
                    for id in ids {
                        all.extend(
                            core.code_search_code(&id, query, None)
                                .await
                                .map_err(|e| e.to_string())?,
                        );
                    }
                    all
                }
            };
            if hits.is_empty() {
                return Ok("No matches in the watched repositories.".into());
            }
            let mut out = format!("{} matching files", hits.len());
            if hits.len() > HITS_SHOWN {
                out.push_str(&format!(", showing {HITS_SHOWN}"));
            }
            for h in hits.iter().take(HITS_SHOWN) {
                out.push_str(&format!("\n{}:{} · {}", h.repo, h.path, h.url));
                for f in h.fragments.iter().take(FRAGMENTS_SHOWN) {
                    out.push_str(&format!(
                        "\n    {}",
                        clip(
                            &f.split_whitespace().collect::<Vec<_>>().join(" "),
                            FRAGMENT_CHARS
                        )
                    ));
                }
            }
            Ok(out)
        }
        _ => unreachable!("NAMES lists what dispatch handles"),
    }
}

/// A short description of one of these tools' calls for the activity line.
pub(super) fn label(name: &str, input: &Value) -> Option<String> {
    let s = |k: &str| input[k].as_str().unwrap_or_default();
    Some(match name {
        "ticket_changes" => format!("Looked up the code changes for {}", s("key")),
        "get_pull_request" => format!("Read {}#{}", s("repo"), input["number"]),
        "list_pull_requests" => format!("Listed the pull requests of {}", s("repo")),
        "read_repo_file" => format!("Read {} in {}", s("path"), s("repo")),
        "list_repo_files" => format!("Listed the files of {}", s("repo")),
        "list_commits" => format!("Looked at the commits of {}", s("repo")),
        "search_code" => format!("Searched the code for {}", s("query")),
        "list_watched_repos" => "Listed the watched repositories".into(),
        _ => return None,
    })
}

#[cfg(test)]
pub(crate) mod testing {
    use crate::codehost::github::testserver::Reply;
    use crate::domain::{WatchChange, WatchMode};
    use crate::inbox::code::tests::{linked, Linked};

    pub const FILE: &str = include_str!("../codehost/github/fixtures/contents_file.json");
    pub const DIR: &str = include_str!("../codehost/github/fixtures/contents_dir.json");
    pub const COMMITS: &str = include_str!("../codehost/github/fixtures/commits.json");
    pub const CODE: &str = include_str!("../codehost/github/fixtures/search_code.json");
    pub const BRANCHES: &str = include_str!("../codehost/github/fixtures/branches.json");
    pub const PULL_FILES: &str = include_str!("../codehost/github/fixtures/pull_files.json");
    pub const PULL_COMMITS: &str = include_str!("../codehost/github/fixtures/pull_commits.json");

    pub fn base64_of(bytes: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        bytes
            .chunks(3)
            .flat_map(|c| {
                let n = c
                    .iter()
                    .enumerate()
                    .fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
                (0..4).map(move |i| {
                    if i <= c.len() {
                        T[(n >> (18 - 6 * i) & 63) as usize] as char
                    } else {
                        '='
                    }
                })
            })
            .collect()
    }

    /// GitHub as a scripted server, with Jira's `CA-208` cached and only `acme/webshop` watched; `acme/gateway` exists but isn't.
    pub async fn watching_webshop(extra: Vec<(String, Vec<Reply>)>) -> Linked {
        let mut routes = vec![
            (
                "/repos/acme/webshop/contents/src/main.rs".to_string(),
                vec![Reply::ok(FILE)],
            ),
            (
                "/repos/acme/webshop/contents".to_string(),
                vec![Reply::ok(DIR)],
            ),
            (
                "/repos/acme/webshop/commits".to_string(),
                vec![Reply::ok(COMMITS)],
            ),
            (
                "/repos/acme/webshop/branches".to_string(),
                vec![Reply::ok(BRANCHES)],
            ),
            (
                "/repos/acme/webshop/pulls/208/files".to_string(),
                vec![Reply::ok(PULL_FILES)],
            ),
            (
                "/repos/acme/webshop/pulls/208/commits".to_string(),
                vec![Reply::ok(PULL_COMMITS)],
            ),
            ("/search/code".to_string(), vec![Reply::ok(CODE)]),
            (
                "/search/issues".to_string(),
                vec![Reply::ok("{\"items\":[]}")],
            ),
            (
                "/search/commits".to_string(),
                vec![Reply::ok("{\"items\":[]}")],
            ),
        ];
        routes.extend(extra);
        let lx = linked(routes, Some("repo")).await;
        lx.fx.add_item(208).await;
        lx.fx
            .core
            .watch_set_mode("github:ann", WatchMode::Selected)
            .await
            .unwrap();
        lx.fx
            .core
            .watch_set_containers(
                "github:ann",
                &[WatchChange {
                    container_id: "acme/webshop".into(),
                    watched: Some(true),
                    ..Default::default()
                }],
            )
            .await
            .unwrap();
        lx.sync().await;
        lx
    }

    pub fn methods(lx: &Linked) -> Vec<String> {
        lx.server
            .seen
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.method.clone())
            .collect()
    }

    /// Requests that name `repo` in a path or a search qualifier.
    pub fn requests_about(lx: &Linked, repo: &str) -> usize {
        let (path, qualifier) = (format!("/repos/{repo}/"), repo.replace('/', "%2F"));
        lx.server
            .targets()
            .iter()
            .filter(|t| {
                t.contains(&path)
                    || t.contains(&qualifier)
                    || t.ends_with(&format!("/repos/{repo}"))
            })
            .count()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::testing::*;
    use super::*;
    use crate::agent::mcp::{call_tool, PipRun, PipRuns};
    use crate::codehost::github::testserver::Reply;
    use crate::inbox::code::tests::Linked;

    struct Gh {
        lx: Linked,
        st: McpState,
    }

    async fn gh(extra: Vec<(String, Vec<Reply>)>) -> Gh {
        let lx = watching_webshop(extra).await;
        let runs: PipRuns = Arc::default();
        runs.lock()
            .unwrap()
            .insert("run-1".into(), PipRun::new(lx.fx.scope.clone()));
        let st = McpState {
            core: lx.fx.core.clone(),
            tokens: Default::default(),
            sink: Arc::new(|_| {}),
            view: Arc::new(|_, _, _| {}),
            runs,
            planner: crate::agent::runs::testing::FakePlanner::unused(),
        };
        Gh { lx, st }
    }

    impl Gh {
        async fn call(&self, name: &str, args: Value) -> (String, bool) {
            let r = call_tool(
                &self.st,
                "run-1",
                &json!({ "name": name, "arguments": args }),
            )
            .await;
            (
                r["content"][0]["text"].as_str().unwrap().to_string(),
                r["isError"].as_bool().unwrap(),
            )
        }

        async fn ok(&self, name: &str, args: Value) -> String {
            let (text, is_error) = self.call(name, args).await;
            assert!(!is_error, "{name}: {text}");
            text
        }

        async fn refused(&self, name: &str, args: Value) -> String {
            let (text, is_error) = self.call(name, args).await;
            assert!(is_error, "{name} should have been refused: {text}");
            text
        }
    }

    #[tokio::test]
    async fn a_ticket_shows_its_pull_requests_with_state_checks_reviews_and_changed_files() {
        let g = gh(vec![]).await;
        let out = g.ok("ticket_changes", json!({ "key": "CA-208" })).await;
        assert!(
            out.contains("acme/webshop#208 (pull request)")
                && out.contains("https://github.com/acme/webshop/pull/208"),
            "{out}"
        );
        assert!(
            out.contains("checks failing") && out.contains("Reviews:"),
            "{out}"
        );
        assert!(
            out.contains("modified src/gateway/routes.ts +80 −10"),
            "{out}"
        );
        assert!(
            !out.contains("@@ -1,3 +1,4 @@"),
            "a summary of many pull requests carries no diffs: {out}"
        );
        assert!(g
            .ok("ticket_changes", json!({ "key": "CA-1" }))
            .await
            .contains("No pull request, branch or commit"));
    }

    #[tokio::test]
    async fn one_pull_request_comes_with_its_commits_and_cut_short_diffs() {
        let g = gh(vec![]).await;
        let out = g
            .ok(
                "get_pull_request",
                json!({ "repo": "acme/webshop", "number": 208 }),
            )
            .await;
        assert!(
            out.contains("Commits:") && out.contains("@@ -1,3 +1,4 @@"),
            "{out}"
        );
        assert!(
            out.contains("[diff cut short]"),
            "a patch longer than the cap says so: {out}"
        );
        assert!(out.chars().count() < 20_000);
        g.refused(
            "get_pull_request",
            json!({ "repo": "acme/webshop", "number": "x" }),
        )
        .await;
    }

    #[tokio::test]
    async fn a_repositorys_pull_requests_are_listed_and_capped() {
        let g = gh(vec![]).await;
        let out = g
            .ok("list_pull_requests", json!({ "repo": "acme/webshop" }))
            .await;
        assert!(out.contains("acme/webshop#208"));

        let first: Value = serde_json::from_str::<Vec<Value>>(include_str!(
            "../codehost/github/fixtures/pulls_open.json"
        ))
        .unwrap()
        .remove(0);
        let many: Vec<Value> = (0..40)
            .map(|i| {
                let mut p = first.clone();
                p["number"] = json!(300 + i);
                p["id"] = json!(9000 + i);
                p["html_url"] = json!(format!("https://github.com/acme/webshop/pull/{}", 300 + i));
                p
            })
            .collect();
        let mut routes = vec![(
            "/repos/acme/webshop/pulls".to_string(),
            vec![Reply::ok(&Value::Array(many.clone()).to_string())],
        )];
        for p in &many {
            let n = p["number"].as_u64().unwrap();
            routes.push((
                format!("/repos/acme/webshop/pulls/{n}"),
                vec![Reply::ok(&p.to_string())],
            ));
            routes.push((
                format!("/repos/acme/webshop/pulls/{n}/reviews"),
                vec![Reply::ok("[]")],
            ));
        }
        let g = gh(routes).await;
        let out = g
            .ok("list_pull_requests", json!({ "repo": "acme/webshop" }))
            .await;
        assert!(
            out.starts_with("40 pull requests, showing the newest 30"),
            "{}",
            out.lines().next().unwrap()
        );
        assert_eq!(out.lines().count(), 31);
    }

    #[tokio::test]
    async fn files_are_read_and_long_ones_are_cut_and_say_so() {
        let g = gh(vec![]).await;
        let out = g
            .ok(
                "read_repo_file",
                json!({ "repo": "acme/webshop", "path": "src/main.rs", "ref": "release/1" }),
            )
            .await;
        assert!(
            out.contains("println!(\"gateway\")") && !out.contains("Truncated"),
            "{out}"
        );
        assert!(g
            .lx
            .server
            .targets()
            .iter()
            .any(|t| t.starts_with("/repos/acme/webshop/contents/src/main.rs?ref=release%2F1")));

        let long = "a line of code\n".repeat(3000);
        let big = json!({ "type": "file", "encoding": "base64", "size": long.len(), "content": base64_of(long.as_bytes()) }).to_string();
        let g = gh(vec![(
            "/repos/acme/webshop/contents/big.rs".into(),
            vec![Reply::ok(&big)],
        )])
        .await;
        let out = g
            .ok(
                "read_repo_file",
                json!({ "repo": "acme/webshop", "path": "big.rs" }),
            )
            .await;
        assert!(
            out.contains("[Truncated") && out.chars().count() < 16_000,
            "{}",
            out.chars().count()
        );
    }

    #[tokio::test]
    async fn listings_of_files_are_cut_and_say_so() {
        let g = gh(vec![]).await;
        let out = g
            .ok("list_repo_files", json!({ "repo": "acme/webshop" }))
            .await;
        assert!(
            out.contains("dir  src")
                && out.contains("file README.md")
                && !out.contains("Truncated"),
            "{out}"
        );

        let many: Vec<Value> = (0..200).map(|i| json!({ "name": format!("f{i:03}"), "path": format!("f{i:03}"), "type": "file", "size": 1 })).collect();
        let g = gh(vec![(
            "/repos/acme/webshop/contents".into(),
            vec![Reply::ok(&Value::Array(many).to_string())],
        )])
        .await;
        let out = g
            .ok("list_repo_files", json!({ "repo": "acme/webshop" }))
            .await;
        assert!(
            out.starts_with("200 entries, showing the first 150")
                && out.contains("[Truncated]")
                && !out.contains("f150"),
            "{}",
            out.lines().next().unwrap()
        );
    }

    #[tokio::test]
    async fn commits_can_be_limited_to_a_path_a_branch_and_a_count() {
        let g = gh(vec![]).await;
        g.ok("list_commits", json!({ "repo": "acme/webshop", "ref": "release/1", "path": "src/cart.rs", "limit": 500 })).await;
        let asked =
            g.lx.server
                .targets()
                .into_iter()
                .find(|t| t.starts_with("/repos/acme/webshop/commits?"))
                .unwrap();
        assert!(
            asked.contains("sha=release%2F1") && asked.contains("path=src%2Fcart.rs"),
            "{asked}"
        );
        assert_eq!(COMMITS_MAX, 50);
    }

    #[tokio::test]
    async fn code_search_stays_in_the_watched_repositories_and_keeps_the_answer_short() {
        let g = gh(vec![]).await;
        let out = g.ok("search_code", json!({ "query": "checkout" })).await;
        assert!(
            out.contains("acme/webshop:src/gateway/routes.ts")
                && out.contains("export const checkout"),
            "{out}"
        );
        let searched =
            g.lx.server
                .targets()
                .into_iter()
                .find(|t| t.starts_with("/search/code"))
                .unwrap();
        assert!(
            searched.contains("repo%3Aacme%2Fwebshop") && !searched.contains("gateway"),
            "{searched}"
        );

        let fragment = "x ".repeat(400);
        let hits: Vec<Value> = (0..25)
            .map(|i| json!({ "name": "f", "path": format!("p{i}.rs"), "html_url": "u", "repository": { "full_name": "acme/webshop" }, "text_matches": (0..5).map(|_| json!({ "fragment": fragment })).collect::<Vec<_>>() }))
            .collect();
        let body = json!({ "total_count": 25, "items": hits }).to_string();
        let g = gh(vec![("/search/code".into(), vec![Reply::ok(&body)])]).await;
        let out = g.ok("search_code", json!({ "query": "x" })).await;
        assert!(
            out.starts_with("25 matching files, showing 20") && !out.contains("p20.rs"),
            "{}",
            out.lines().next().unwrap()
        );
        assert_eq!(out.matches("\n    x x").count(), 20 * 3);
        assert!(out.chars().count() < 20 * (3 * (FRAGMENT_CHARS + 6) + 80));
    }

    #[tokio::test]
    async fn an_unwatched_repository_is_refused_before_anything_is_sent_and_spelling_case_is_forgiven(
    ) {
        let g = gh(vec![]).await;
        let before = requests_about(&g.lx, "acme/gateway");
        let calls = [
            (
                "get_pull_request",
                json!({ "repo": "acme/gateway", "number": 1 }),
            ),
            ("list_pull_requests", json!({ "repo": "acme/gateway" })),
            (
                "read_repo_file",
                json!({ "repo": "acme/gateway", "path": "README.md" }),
            ),
            ("list_repo_files", json!({ "repo": "acme/gateway" })),
            ("list_commits", json!({ "repo": "acme/gateway" })),
            (
                "search_code",
                json!({ "query": "x", "repo": "acme/gateway" }),
            ),
            (
                "read_repo_file",
                json!({ "repo": "other/thing", "path": "a" }),
            ),
        ];
        for (name, args) in calls {
            let text = g.refused(name, args).await;
            assert!(
                text.contains("Ask the person to watch it"),
                "{name}: {text}"
            );
        }
        assert_eq!(requests_about(&g.lx, "acme/gateway"), before);
        assert_eq!(requests_about(&g.lx, "other/thing"), 0);

        let shouted = g
            .ok(
                "read_repo_file",
                json!({ "repo": "ACME/WebShop", "path": "src/main.rs" }),
            )
            .await;
        assert!(shouted.starts_with("acme/webshop:src/main.rs"), "{shouted}");
        assert_eq!(g.ok("list_watched_repos", json!({})).await, "acme/webshop");
    }

    #[tokio::test]
    async fn a_ticket_out_of_reach_shows_no_code_either() {
        let g = gh(vec![]).await;
        let text = g
            .refused("ticket_changes", json!({ "key": "NOPE-1" }))
            .await;
        assert!(text.contains("out of reach"), "{text}");
    }

    #[tokio::test]
    async fn nothing_pip_can_call_writes_to_github() {
        let g = gh(vec![]).await;
        g.ok("ticket_changes", json!({ "key": "CA-208" })).await;
        g.ok(
            "get_pull_request",
            json!({ "repo": "acme/webshop", "number": 208 }),
        )
        .await;
        g.ok("list_pull_requests", json!({ "repo": "acme/webshop" }))
            .await;
        g.ok(
            "read_repo_file",
            json!({ "repo": "acme/webshop", "path": "src/main.rs" }),
        )
        .await;
        g.ok("list_repo_files", json!({ "repo": "acme/webshop" }))
            .await;
        g.ok("list_commits", json!({ "repo": "acme/webshop" }))
            .await;
        g.ok("search_code", json!({ "query": "checkout" })).await;
        g.ok("list_watched_repos", json!({})).await;
        let methods = methods(&g.lx);
        assert!(
            methods.len() > 10 && methods.iter().all(|m| m == "GET"),
            "{methods:?}"
        );

        let names: Vec<String> = tools()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, NAMES);
        assert!(tools()
            .iter()
            .all(|t| t["description"].as_str().unwrap().contains("Read-only")
                || t["name"] == "list_watched_repos"));
    }

    #[test]
    fn every_tool_has_a_label_for_the_activity_line() {
        for name in NAMES {
            assert!(label(name, &json!({})).is_some(), "{name}");
        }
        assert_eq!(
            label("read_repo_file", &json!({ "repo": "a/b", "path": "x.rs" })).unwrap(),
            "Read x.rs in a/b"
        );
    }
}
