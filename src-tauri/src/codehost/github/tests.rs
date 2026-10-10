use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};

use super::testserver::{serve, Reply, Server};
use super::*;
use crate::domain::{CheckState, CodeChangeKind, CodeChangeState, ReviewState};
use crate::domain::CommitQuery;
use crate::error::Error;

const USER: &str = include_str!("fixtures/user.json");
const ORGS: &str = include_str!("fixtures/orgs.json");
const REPOS: &str = include_str!("fixtures/repos.json");
const SEARCH_REPOS: &str = include_str!("fixtures/search_repos.json");
const PULLS_OPEN: &str = include_str!("fixtures/pulls_open.json");
const PULLS_ALL: &str = include_str!("fixtures/pulls_all.json");
const ISSUES_AUTHORED: &str = include_str!("fixtures/search_issues_authored.json");
const ISSUES_REVIEW: &str = include_str!("fixtures/search_issues_review.json");
const EVENTS: &str = include_str!("fixtures/events.json");
const NO_ITEMS: &str = "{\"items\":[]}";

fn host(server: &Server) -> GithubHost {
    GithubHost::new(reqwest::Client::new(), &server.base, "tok", "github:ann", "ann", Arc::new(Mutex::new(Db::in_memory().unwrap())))
}

fn query(text: &str) -> ContainerQuery {
    ContainerQuery { query: text.into(), cursor: None, limit: 50 }
}

#[tokio::test]
async fn me_reads_the_account_and_the_scopes_of_a_classic_token() {
    let server = serve(vec![("/user", vec![Reply::ok(USER).header("x-oauth-scopes", "repo, read:org, notifications")])]).await;
    let me = host(&server).me().await.unwrap();
    assert_eq!((me.login.as_str(), me.name.as_deref()), ("ann", Some("Ann Example")));
    assert_eq!(me.scopes, Some(vec!["repo".to_string(), "read:org".into(), "notifications".into()]));
}

#[tokio::test]
async fn a_fine_grained_token_has_no_scope_list() {
    let server = serve(vec![("/user", vec![Reply::ok(USER)])]).await;
    assert_eq!(host(&server).me().await.unwrap().scopes, None);
}

#[tokio::test]
async fn the_catalog_lists_repositories_with_permission_archived_flag_and_last_push() {
    let server = serve(vec![(
        "/user/repos",
        vec![Reply::ok(REPOS).header("link", "</user/repos?page=2>; rel=\"next\"")],
    )])
    .await;
    let page = host(&server).list_repositories(&query("")).await.unwrap();
    let rows: Vec<_> = page.containers.iter().map(|c| (c.key.as_str(), c.name.as_str(), c.kind.as_deref(), c.archived)).collect();
    assert_eq!(rows, [("acme/webshop", "webshop", Some("push"), false), ("acme/gateway", "gateway", Some("admin"), false), ("acme/legacy-admin", "legacy-admin", Some("pull"), true)]);
    assert_eq!(page.containers[0].last_active.as_deref(), Some("2026-09-29T10:00:00Z"));
    assert_eq!(page.containers[0].container_ref.connection_id, "github:ann");
    assert_eq!(page.next.as_deref(), Some("2"));
    assert!(server.targets()[0].contains("sort=pushed") && server.targets()[0].contains("per_page=50"));
}

#[tokio::test]
async fn the_last_page_has_no_cursor_and_a_cursor_asks_for_that_page() {
    let server = serve(vec![("/user/repos", vec![Reply::ok("[]")])]).await;
    let page = host(&server)
        .list_repositories(&ContainerQuery { query: String::new(), cursor: Some("3".into()), limit: 20 })
        .await
        .unwrap();
    assert_eq!(page.next, None);
    assert!(server.targets()[0].contains("page=3") && server.targets()[0].contains("per_page=20"));
}

#[tokio::test]
async fn a_search_looks_under_the_person_and_each_organisation_and_merges_by_recent_push() {
    let server = serve(vec![
        ("/user/orgs", vec![Reply::ok(ORGS)]),
        ("/search/repositories", vec![Reply::ok(SEARCH_REPOS), Reply::ok(NO_ITEMS), Reply::ok(SEARCH_REPOS)]),
    ])
    .await;
    let page = host(&server).list_repositories(&query("web shop")).await.unwrap();
    assert_eq!(page.containers.len(), 1, "the same repository under two owners is listed once");
    assert_eq!(page.next, None);
    let targets = server.targets();
    assert_eq!(targets.len(), 4);
    assert!(targets[1].contains("user%3Aann") && targets[2].contains("org%3Aacme") && targets[3].contains("org%3Aacme-labs"), "{targets:?}");
    assert!(targets[1].contains("web+shop+in%3Aname"), "{targets:?}");
    host(&server).list_repositories(&query("web")).await.unwrap();
}

#[tokio::test]
async fn an_org_prefix_lists_that_organisation() {
    let server = serve(vec![("/orgs/acme/repos", vec![Reply::ok(REPOS)])]).await;
    let page = host(&server).list_repositories(&query("org:acme")).await.unwrap();
    assert_eq!(page.containers.len(), 3);
}

#[tokio::test]
async fn pull_requests_carry_state_branches_author_and_requested_reviewers() {
    let server = serve(vec![(
        "/repos/acme/webshop/pulls",
        vec![Reply::ok(PULLS_OPEN).header("etag", "\"o\""), Reply::ok(PULLS_ALL).header("etag", "\"a\"")],
    )])
    .await;
    let since = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    let list = host(&server).pull_requests("acme/webshop", since).await.unwrap();
    assert!(!list.unchanged);
    let rows: Vec<_> = list.changes.iter().map(|c| (c.number.unwrap(), c.state)).collect();
    assert_eq!(rows, [(208, CodeChangeState::Draft), (205, CodeChangeState::Merged), (201, CodeChangeState::Closed), (150, CodeChangeState::Open)]);
    let draft = &list.changes[0];
    assert_eq!((draft.kind, draft.external_id.as_str()), (CodeChangeKind::PullRequest, "pr:acme/webshop#208"));
    assert_eq!((draft.head_ref.as_str(), draft.base_ref.as_deref()), ("ca-208-gateway", Some("main")));
    assert_eq!(draft.author.as_ref().unwrap().account_id, "ann");
    assert_eq!(draft.reviewers[0].account_id, "bob");
    assert_eq!((draft.review, draft.checks), (ReviewState::Requested, CheckState::None));
    assert_eq!(draft.label(), "acme/webshop#208");
    assert!(draft.body.contains("DEVOPS-471"));
    assert!(list.changes.iter().all(|c| c.number != Some(120)), "older than the window and not open");
    assert!(list.changes[1].merged_at.is_some());
    let targets = server.targets();
    assert!(targets[0].contains("state=open") && targets[1].contains("state=all") && targets[1].contains("sort=updated"), "{targets:?}");
}

#[tokio::test]
async fn an_unchanged_repository_is_answered_from_the_cache_and_said_to_be_unchanged() {
    let server = serve(vec![(
        "/repos/acme/webshop/pulls",
        vec![
            Reply::ok(PULLS_OPEN).header("etag", "\"o\""),
            Reply::ok(PULLS_ALL).header("etag", "\"a\""),
            Reply::status(304, ""),
        ],
    )])
    .await;
    let host = host(&server);
    let since = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    let first = host.pull_requests("acme/webshop", since).await.unwrap();
    let second = host.pull_requests("acme/webshop", since).await.unwrap();
    assert!(!first.unchanged);
    assert!(second.unchanged, "both first pages came back 304");
    assert_eq!(second.changes, first.changes);
    assert_eq!(server.header_of(2, "if-none-match").as_deref(), Some("\"o\""));
    assert_eq!(server.header_of(3, "if-none-match").as_deref(), Some("\"a\""));
}

#[tokio::test]
async fn paging_stops_once_a_page_is_older_than_the_window() {
    let server = serve(vec![(
        "/repos/acme/webshop/pulls",
        vec![
            Reply::ok("[]"),
            Reply::ok(PULLS_ALL).header("link", "</repos/acme/webshop/pulls?page=2>; rel=\"next\""),
        ],
    )])
    .await;
    let since = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    let list = host(&server).pull_requests("acme/webshop", since).await.unwrap();
    assert_eq!(list.changes.len(), 3);
    assert_eq!(server.targets().len(), 2, "the last entry of the page is already too old, so no third request");
}

#[tokio::test]
async fn a_repository_the_token_cannot_see_is_an_error_naming_the_problem() {
    let server = serve(vec![]).await;
    let err = host(&server).pull_requests("acme/secret", Utc::now()).await.unwrap_err();
    assert!(matches!(err, Error::CodeHost { status: 404, .. }), "{err}");
}

#[tokio::test]
async fn the_footprint_counts_pull_requests_by_how_the_person_is_involved_and_adds_recent_pushes() {
    let server = serve(vec![
        ("/search/issues", vec![Reply::ok(ISSUES_AUTHORED), Reply::ok(NO_ITEMS), Reply::ok(ISSUES_REVIEW), Reply::ok(NO_ITEMS), Reply::ok(ISSUES_AUTHORED)]),
        ("/users/ann/events", vec![Reply::ok(EVENTS)]),
    ])
    .await;
    let rows = host(&server).footprint(90).await.unwrap();
    let by = |k: &str| rows.iter().find(|f| f.key == k).unwrap_or_else(|| panic!("no {k}"));
    let shop = by("acme/webshop");
    assert_eq!((shop.reported, shop.assigned, shop.commented, shop.mentioned), (1, 1, Some(0), Some(1)));
    assert_eq!(shop.last_touch.as_deref(), Some("2026-09-29T09:30:00Z"));
    assert_eq!(by("acme/gateway").reported, 1);
    let tools = by("acme/tools");
    assert_eq!((tools.reported, tools.assigned), (0, 0));
    assert_eq!(tools.last_touch.as_deref(), Some("2026-09-27T10:00:00Z"));
    assert!(rows.iter().all(|f| f.key != "other/thing"), "only pushes count");
    assert_eq!(rows[0].key, "acme/webshop", "most recent first");
    assert!(server.targets()[0].contains("author%3Aann") && server.targets()[0].contains("updated%3A%3E%3D"));
}

const PULL_208: &str = include_str!("fixtures/pull_208.json");
const REVIEWS: &str = include_str!("fixtures/reviews_208.json");
const RUNS_FAILING: &str = include_str!("fixtures/check_runs_failing.json");
const RUNS_PASSING: &str = include_str!("fixtures/check_runs_passing.json");
const STATUS: &str = include_str!("fixtures/combined_status.json");
const FILES: &str = include_str!("fixtures/pull_files.json");
const PULL_COMMITS: &str = include_str!("fixtures/pull_commits.json");
const BRANCHES: &str = include_str!("fixtures/branches.json");
const COMMITS: &str = include_str!("fixtures/commits.json");
const ISSUES_KEY: &str = include_str!("fixtures/search_issues_key.json");
const COMMITS_KEY: &str = include_str!("fixtures/search_commits_key.json");
const NOTIFICATIONS: &str = include_str!("fixtures/notifications.json");
const FILE: &str = include_str!("fixtures/contents_file.json");
const BINARY: &str = include_str!("fixtures/contents_binary.json");
const TOO_LARGE: &str = include_str!("fixtures/contents_toolarge.json");
const DIR: &str = include_str!("fixtures/contents_dir.json");
const CODE: &str = include_str!("fixtures/search_code.json");

fn listed_pr() -> CodeChange {
    let pulls: Vec<serde_json::Value> = serde_json::from_str(PULLS_OPEN).unwrap();
    let pull: super::wire::Pull = serde_json::from_value(pulls[0].clone()).unwrap();
    let mut c = pull.change("github:ann", "acme/webshop");
    c.linked_keys = vec!["CA-208".into()];
    c
}

fn pr_routes(runs: &'static str) -> Vec<(&'static str, Vec<Reply>)> {
    vec![
        ("/repos/acme/webshop/pulls/208", vec![Reply::ok(PULL_208)]),
        ("/repos/acme/webshop/pulls/208/reviews", vec![Reply::ok(REVIEWS)]),
        ("/repos/acme/webshop/commits/aaa1111/check-runs", vec![Reply::ok(runs)]),
        ("/repos/acme/webshop/commits/aaa1111/status", vec![Reply::ok(STATUS)]),
    ]
}

#[tokio::test]
async fn a_pull_request_read_in_full_has_its_size_review_outcome_and_failing_checks() {
    let server = serve(pr_routes(RUNS_FAILING)).await;
    let read = host(&server).refresh_pull_request(&listed_pr(), true).await.unwrap();
    let c = &read.change;
    assert_eq!((c.additions, c.deletions, c.changed_files), (Some(120), Some(14), Some(4)));
    assert_eq!((c.checks, c.review, c.state), (CheckState::Failing, ReviewState::ChangesRequested, CodeChangeState::Draft));
    assert_eq!(c.linked_keys, ["CA-208"], "what discovery found is kept");
    let reviews: Vec<_> = read.reviews.iter().map(|r| (r.id.as_str(), r.reviewer.account_id.as_str(), r.state)).collect();
    assert_eq!(reviews, [("501", "bob", ReviewState::Commented), ("502", "cy", ReviewState::ChangesRequested), ("503", "cy", ReviewState::Commented)], "a pending review isn't one yet");
}

#[tokio::test]
async fn passing_checks_and_skipping_them() {
    let server = serve(pr_routes(RUNS_PASSING)).await;
    let with = host(&server).refresh_pull_request(&listed_pr(), true).await.unwrap();
    assert_eq!(with.change.checks, CheckState::Passing);
    let mut cached = listed_pr();
    cached.checks = CheckState::Pending;
    let without = host(&server).refresh_pull_request(&cached, false).await.unwrap();
    assert_eq!(without.change.checks, CheckState::Pending, "not asked, so what was known stays");
    assert_eq!(server.targets().iter().filter(|t| t.contains("check-runs")).count(), 1);
}

#[tokio::test]
async fn a_token_without_the_checks_permission_leaves_checks_unknown() {
    let mut routes = pr_routes(RUNS_FAILING);
    routes[2].1 = vec![Reply::status(403, "{\"message\":\"Resource not accessible by personal access token\"}")];
    routes[3].1 = vec![Reply::status(403, "{\"message\":\"Resource not accessible by personal access token\"}")];
    let server = serve(routes).await;
    let read = host(&server).refresh_pull_request(&listed_pr(), true).await.unwrap();
    assert_eq!(read.change.checks, CheckState::None);
    assert_eq!(read.change.additions, Some(120), "the rest is still read");
}

#[tokio::test]
async fn a_rate_limit_while_reading_checks_is_not_swallowed() {
    let mut routes = pr_routes(RUNS_FAILING);
    routes[2].1 = vec![Reply::status(403, "{\"message\":\"API rate limit exceeded\"}").header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "4102444800")];
    let server = serve(routes).await;
    let err = host(&server).refresh_pull_request(&listed_pr(), true).await.unwrap_err();
    assert!(matches!(err, Error::RateLimited { .. }), "{err}");
}

#[tokio::test]
async fn pull_request_details_list_files_with_cut_short_patches_and_recent_commits() {
    let mut routes = pr_routes(RUNS_FAILING);
    routes.push(("/repos/acme/webshop/pulls/208/files", vec![Reply::ok(FILES)]));
    routes.push(("/repos/acme/webshop/pulls/208/commits", vec![Reply::ok(PULL_COMMITS)]));
    let server = serve(routes).await;
    let d = host(&server).pull_request("acme/webshop", 208).await.unwrap();
    assert_eq!(d.files.iter().map(|f| (f.path.as_str(), f.additions, f.deletions)).collect::<Vec<_>>(), [("src/gateway/routes.ts", 80, 10), ("docs/logo.png", 0, 0), ("src/big.ts", 40, 4)]);
    assert!(d.files[0].patch.as_deref().unwrap().starts_with("@@ -1,3"));
    assert_eq!(d.files[1].patch, None);
    assert_eq!(d.files[2].patch.as_ref().unwrap().len(), 4000);
    assert!(d.files_truncated, "4 files changed, 3 listed");
    assert_eq!(d.commits.len(), 2);
    assert_eq!((d.commits[0].author.as_deref(), d.commits[1].author.as_deref()), (Some("ann"), Some("Ann Example")));
    assert_eq!(d.commits[0].message, "CA-208: first step\n\nlonger text");
    assert_eq!(d.change.checks, CheckState::Failing);
    assert_eq!(d.reviews.len(), 3);
}

#[tokio::test]
async fn branches_and_commits_are_changes_of_their_own_kind() {
    let server = serve(vec![("/repos/acme/webshop/branches", vec![Reply::ok(BRANCHES)]), ("/repos/acme/webshop/commits", vec![Reply::ok(COMMITS)])]).await;
    let host = host(&server);
    let branches = host.branches("acme/webshop").await.unwrap();
    assert_eq!(branches.len(), 4);
    assert_eq!((branches[1].kind, branches[1].external_id.as_str(), branches[1].title.as_str()), (CodeChangeKind::Branch, "branch:acme/webshop:ca-208-gateway", "ca-208-gateway"));
    assert_eq!(branches[2].url, "https://github.com/acme/webshop/tree/feature/CA-209_cache-warmup");

    let since = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    let q = CommitQuery { repo: "acme/webshop".into(), reference: Some("release/1".into()), since: Some(since), path: Some("src/cart.rs".into()), text: Some("ca-190".into()), limit: 0 };
    let commits = host.commits(&q).await.unwrap();
    assert_eq!(commits.len(), 1, "filtered by message, ignoring case");
    let c = &commits[0];
    assert_eq!((c.kind, c.external_id.as_str(), c.title.as_str(), c.body.as_str()), (CodeChangeKind::Commit, "commit:acme/webshop@1111111aaaaaaa", "CA-190: fix cart rounding", "Rounds half up."));
    assert_eq!((c.head_ref.as_str(), c.state, c.author.as_ref().unwrap().account_id.as_str()), ("release/1", CodeChangeState::Open, "bob"));
    let target = &server.targets()[1];
    assert!(target.contains("sha=release%2F1") && target.contains("since=2026-09-01T00%3A00%3A00Z") && target.contains("path=src%2Fcart.rs"), "{target}");
    let default = host.commits(&CommitQuery { repo: "acme/webshop".into(), limit: 1, ..Default::default() }).await.unwrap();
    assert_eq!((default.len(), default[0].state), (1, CodeChangeState::Merged), "commits of the default branch count as merged");
}

#[tokio::test]
async fn a_key_search_finds_the_pull_request_of_a_matching_branch_and_checks_what_the_search_returns() {
    let server = serve(vec![
        ("/repos/acme/webshop/branches", vec![Reply::ok(BRANCHES)]),
        ("/repos/acme/webshop/pulls", vec![Reply::ok(&format!("[{}]", PULL_208))]),
        ("/search/issues", vec![Reply::ok(ISSUES_KEY)]),
        ("/search/commits", vec![Reply::ok(COMMITS_KEY)]),
    ])
    .await;
    let found = host(&server).search("CA-208", &["acme/webshop".to_string()]).await.unwrap();
    let ids: Vec<_> = found.iter().map(|c| c.external_id.as_str()).collect();
    assert_eq!(ids, ["pr:acme/webshop#208", "commit:acme/webshop@9999999ccccccc", "pr:acme/webshop#205"], "newest first; the search's false hits are dropped: {ids:?}");
    assert_eq!(found[0].head_ref, "ca-208-gateway", "read from the branch, which the search result can't tell");
    assert_eq!(found[2].state, CodeChangeState::Merged);
    let targets = server.targets();
    assert!(targets.iter().any(|t| t.contains("head=acme%3Aca-208-gateway") && t.contains("state=all")), "{targets:?}");
    assert!(targets.iter().any(|t| t.starts_with("/search/issues") && t.contains("is%3Apr+CA-208+in%3Atitle%2Cbody+repo%3Aacme%2Fwebshop")), "{targets:?}");
}

#[tokio::test]
async fn a_matching_branch_without_a_pull_request_is_a_branch_dated_by_its_tip() {
    let tip: Vec<serde_json::Value> = serde_json::from_str(COMMITS).unwrap();
    let server = serve(vec![
        ("/repos/acme/webshop/branches", vec![Reply::ok(BRANCHES)]),
        ("/repos/acme/webshop/pulls", vec![Reply::ok("[]")]),
        ("/repos/acme/webshop/commits/ccc3333", vec![Reply::ok(&tip[0].to_string())]),
        ("/search/issues", vec![Reply::ok("{\"items\":[]}")]),
        ("/search/commits", vec![Reply::ok("{\"items\":[]}")]),
    ])
    .await;
    let found = host(&server).search("ca-209", &["acme/webshop".to_string()]).await.unwrap();
    assert_eq!(found.len(), 1);
    let b = &found[0];
    assert_eq!((b.kind, b.title.as_str(), b.state), (CodeChangeKind::Branch, "feature/CA-209_cache-warmup", CodeChangeState::Open));
    assert_eq!(b.updated_at, Utc.with_ymd_and_hms(2026, 9, 26, 9, 10, 0).unwrap());
    assert_eq!(b.author.as_ref().unwrap().account_id, "bob");
}

#[tokio::test]
async fn free_text_searches_are_not_filtered_for_keys() {
    let server = serve(vec![("/search/issues", vec![Reply::ok(ISSUES_KEY)]), ("/search/commits", vec![Reply::ok(COMMITS_KEY)])]).await;
    let found = host(&server).search("cart rounding", &["acme/webshop".to_string()]).await.unwrap();
    assert_eq!(found.len(), 5);
    assert!(server.targets().iter().all(|t| !t.contains("/branches")), "branches are only scanned for keys");
}

#[tokio::test]
async fn notifications_are_read_conditionally_with_the_poll_interval() {
    let server = serve(vec![("/notifications", vec![Reply::ok(NOTIFICATIONS).header("last-modified", "Tue, 29 Sep 2026 10:00:00 GMT").header("x-poll-interval", "60"), Reply::status(304, "").header("x-poll-interval", "120")])]).await;
    let host = host(&server);
    let first = host.notifications().await.unwrap();
    assert_eq!((first.notices.len(), first.unchanged, first.poll_interval), (4, false, Some(60)));
    let n = &first.notices[0];
    assert_eq!((n.id.as_str(), n.reason.as_str(), n.repo.as_str(), n.number, n.subject.as_str()), ("n1", "review_requested", "acme/webshop", Some(210), "PullRequest"));
    assert_eq!(first.notices[3].number, None, "a check suite has no number");
    let second = host.notifications().await.unwrap();
    assert_eq!((second.unchanged, second.poll_interval), (true, Some(120)));
    assert_eq!(server.header_of(1, "if-modified-since").as_deref(), Some("Tue, 29 Sep 2026 10:00:00 GMT"));
}

#[tokio::test]
async fn files_come_back_as_text_and_binary_or_huge_ones_are_refused() {
    let server = serve(vec![
        ("/repos/acme/webshop/contents/src/main.rs", vec![Reply::ok(FILE)]),
        ("/repos/acme/webshop/contents/logo.png", vec![Reply::ok(BINARY)]),
        ("/repos/acme/webshop/contents/dump.sql", vec![Reply::ok(TOO_LARGE)]),
        ("/repos/acme/webshop/contents/src", vec![Reply::ok(DIR)]),
    ])
    .await;
    let host = host(&server);
    let f = host.file("acme/webshop", "src/main.rs", Some("main")).await.unwrap();
    assert_eq!((f.text.as_str(), f.size, f.truncated, f.reference.as_str()), ("fn main() {\n    println!(\"gateway\");\n}\n", 39, false, "main"));
    assert!(server.targets()[0].ends_with("?ref=main"));
    assert!(host.file("acme/webshop", "logo.png", None).await.unwrap_err().to_string().contains("binary"));
    assert!(host.file("acme/webshop", "dump.sql", None).await.unwrap_err().to_string().contains("too large"));
    assert!(host.file("acme/webshop", "src", None).await.unwrap_err().to_string().contains("directory"));
}

#[tokio::test]
async fn a_long_file_is_cut_and_says_so() {
    let big = "x".repeat(70_000);
    let body = serde_json::json!({ "type": "file", "encoding": "base64", "size": big.len(), "content": base64_of(big.as_bytes()) });
    let server = serve(vec![("/repos/acme/webshop/contents/big.txt", vec![Reply::ok(&body.to_string())])]).await;
    let f = host(&server).file("acme/webshop", "big.txt", None).await.unwrap();
    assert_eq!((f.text.len(), f.truncated, f.size), (60_000, true, 70_000));
}

fn base64_of(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |a, (i, b)| a | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[tokio::test]
async fn a_directory_lists_folders_first_and_a_file_is_not_a_directory() {
    let server = serve(vec![("/repos/acme/webshop/contents", vec![Reply::ok(DIR)]), ("/repos/acme/webshop/contents/src/main.rs", vec![Reply::ok(FILE)])]).await;
    let host = host(&server);
    let tree = host.tree("acme/webshop", "", None).await.unwrap();
    let rows: Vec<_> = tree.iter().map(|e| (e.name.as_str(), e.kind)).collect();
    assert_eq!(rows, [("src", crate::domain::TreeEntryKind::Dir), ("Cargo.toml", crate::domain::TreeEntryKind::File), ("README.md", crate::domain::TreeEntryKind::File), ("link", crate::domain::TreeEntryKind::Symlink)]);
    assert!(host.tree("acme/webshop", "src/main.rs", None).await.unwrap_err().to_string().contains("is a file"));
}

#[tokio::test]
async fn code_search_asks_for_text_matches_and_stays_inside_the_given_repositories() {
    let server = serve(vec![("/search/code", vec![Reply::ok(CODE)])]).await;
    let hits = host(&server).search_code("checkout route", &["acme/webshop".to_string(), "acme/gateway".to_string()]).await.unwrap();
    assert_eq!(hits.len(), 2, "both repositories share one search");
    assert_eq!((hits[0].repo.as_str(), hits[0].path.as_str(), hits[0].fragments.len()), ("acme/webshop", "src/gateway/routes.ts", 1));
    assert!(hits[1].fragments.is_empty());
    assert_eq!(server.header_of(0, "accept").as_deref(), Some("application/vnd.github.text-match+json"));
    let targets = server.targets();
    assert_eq!(targets.len(), 1, "{targets:?}");
    assert!(targets[0].contains("repo%3Aacme%2Fwebshop") && targets[0].contains("repo%3Aacme%2Fgateway"), "{targets:?}");
}

fn pull_with_head_repo(head_repo: &str) -> String {
    format!(
        "{{\"number\":12,\"state\":\"open\",\"draft\":false,\"title\":\"Fix the cart\",\"body\":null,\"created_at\":\"2026-09-25T08:00:00Z\",\"updated_at\":\"2026-09-29T09:30:00Z\",\"merged_at\":null,\"html_url\":\"https://github.com/acme/webshop/pull/12\",\"user\":{{\"login\":\"ann\"}},\"head\":{{\"ref\":\"fix-cart\",\"sha\":\"aaa\"{head_repo}}},\"base\":{{\"ref\":\"main\",\"sha\":\"bbb\",\"repo\":{{\"full_name\":\"acme/webshop\"}}}}}}"
    )
}

#[tokio::test]
async fn a_pull_request_says_which_repository_its_head_branch_is_in() {
    let cases = [
        (",\"repo\":{\"full_name\":\"acme/webshop\"}", Some("acme/webshop"), true),
        (",\"repo\":{\"full_name\":\"Acme/WebShop\"}", Some("Acme/WebShop"), true),
        (",\"repo\":{\"full_name\":\"mallory/webshop\"}", Some("mallory/webshop"), false),
        (",\"repo\":null", None, false),
        ("", None, false),
    ];
    for (head_repo, expected, same) in cases {
        let server = serve(vec![("/repos/acme/webshop/pulls/12", vec![Reply::ok(&pull_with_head_repo(head_repo))])]).await;
        let change = host(&server).pull_request_change("acme/webshop", 12).await.unwrap();
        assert_eq!((change.head_repo.as_deref(), change.is_same_repo()), (expected, same), "{head_repo}");
        assert_eq!((change.number, change.base_ref.as_deref(), change.state), (Some(12), Some("main"), CodeChangeState::Open));
        assert_eq!(server.targets(), ["/repos/acme/webshop/pulls/12"], "one request");
    }
}

#[tokio::test]
async fn listed_pull_requests_carry_their_head_repository_too() {
    let list = format!("[{}]", pull_with_head_repo(",\"repo\":{\"full_name\":\"mallory/webshop\"}"));
    let server = serve(vec![("/repos/acme/webshop/pulls", vec![Reply::ok(&list)])]).await;
    let since = Utc.with_ymd_and_hms(2026, 9, 1, 0, 0, 0).unwrap();
    let found = host(&server).pull_requests("acme/webshop", since).await.unwrap();
    assert_eq!(found.changes[0].head_repo.as_deref(), Some("mallory/webshop"));
}

#[tokio::test]
async fn a_review_reads_the_files_of_a_pull_request_with_long_patches_cut_at_a_whole_line_and_nothing_else() {
    let hunks: serde_json::Value = serde_json::from_str(include_str!("../../../../src/lib/diffHunks.fixtures.json")).unwrap();
    let retry = hunks["patches"]["retry"].as_str().unwrap();
    // 25_002 lines of "+line\n" is far past the limit, so the cut lands inside one and it is dropped.
    let long: String = format!("@@ -0,0 +1,30000 @@\n{}", "+line\n".repeat(25_002));
    let page1 = serde_json::json!([{ "filename": "src/consumer/retry.ts", "status": "modified", "additions": 6, "deletions": 1, "patch": retry }]);
    let page2 = serde_json::json!([{ "filename": "src/generated.ts", "status": "added", "additions": 30000, "deletions": 0, "patch": long }, { "filename": "docs/logo.png", "status": "added" }]);
    let server = serve(vec![
        ("/repos/acme/webshop/pulls/218/files?per_page=100", vec![Reply::ok(&page1.to_string()).header("link", "</repos/acme/webshop/pulls/218/files?per_page=100&page=2>; rel=\"next\"")]),
        ("/repos/acme/webshop/pulls/218/files?per_page=100&page=2", vec![Reply::ok(&page2.to_string())]),
    ])
    .await;
    let files = host(&server).pull_files("acme/webshop", 218).await.unwrap();
    assert_eq!(files.iter().map(|f| (f.path.as_str(), f.truncated)).collect::<Vec<_>>(), [("src/consumer/retry.ts", false), ("src/generated.ts", true), ("docs/logo.png", false)]);
    assert_eq!(files[0].patch.as_deref(), Some(retry), "a patch under the limit is kept whole");
    let cut = files[1].patch.as_deref().unwrap();
    assert!(cut.chars().count() <= super::read::REVIEW_PATCH_LIMIT && !cut.ends_with('\n') && cut.ends_with("+line"), "cut at a whole line");
    let shown = cut.lines().count() as u32 - 1;
    use crate::codehost::diff::commentable;
    use crate::domain::DiffSide;
    assert!(commentable(cut, shown, DiffSide::Right));
    assert!(!commentable(cut, shown + 1, DiffSide::Right), "nothing past the cut");
    assert_eq!(files[2].patch, None);
    let seen = server.seen.lock().unwrap().clone();
    assert!(seen.iter().all(|s| s.method == "GET" && s.target.contains("/pulls/218/files")), "only the files list is read: {:?}", server.targets());
    assert_eq!(seen.len(), 2);
}

const REVIEWS_POST: &str = "POST /repos/acme/webshop/pulls/218/reviews";

fn review_comments() -> Vec<crate::domain::ReviewComment> {
    use crate::domain::{DiffSide, ReviewComment};
    vec![
        ReviewComment { path: "src/consumer/retry.ts".into(), line: 42, side: DiffSide::Right, body: "**Blocking:** no backoff.".into() },
        ReviewComment { path: "src/consumer/old.ts".into(), line: 7, side: DiffSide::Left, body: "Removed too early.".into() },
    ]
}

#[tokio::test]
async fn a_review_is_posted_once_as_a_comment_with_its_commit_summary_and_inline_comments() {
    let server = serve(vec![(REVIEWS_POST, vec![Reply::ok("{\"id\":901,\"html_url\":\"https://github.com/acme/webshop/pull/218#pullrequestreview-901\"}")])]).await;
    let posted = host(&server).post_review("acme/webshop", 218, "a1b2c3d4e5f6", "Gossamr review of #218.", &review_comments()).await.unwrap();
    assert_eq!((posted.id, posted.url.as_str()), (901, "https://github.com/acme/webshop/pull/218#pullrequestreview-901"));
    let seen = server.seen.lock().unwrap().clone();
    let [one] = seen.as_slice() else { panic!("{:?}", server.targets()) };
    assert_eq!((one.method.as_str(), one.target.as_str()), ("POST", "/repos/acme/webshop/pulls/218/reviews"));
    let body: serde_json::Value = serde_json::from_str(&one.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({
            "commit_id": "a1b2c3d4e5f6",
            "body": "Gossamr review of #218.",
            "event": "COMMENT",
            "comments": [
                { "path": "src/consumer/retry.ts", "line": 42, "side": "RIGHT", "body": "**Blocking:** no backoff." },
                { "path": "src/consumer/old.ts", "line": 7, "side": "LEFT", "body": "Removed too early." }
            ]
        })
    );
    assert_eq!(one.headers.get("authorization").map(String::as_str), Some("Bearer tok"));
}

#[tokio::test]
async fn a_review_that_fails_at_the_gateway_is_not_sent_again() {
    let server = serve(vec![(REVIEWS_POST, vec![Reply::status(502, "{\"message\":\"bad gateway\"}"), Reply::ok("{\"id\":1}")])]).await;
    let err = host(&server).post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &review_comments()).await.unwrap_err();
    assert!(matches!(err, Error::CodeHost { status: 502, .. }), "{err}");
    assert_eq!(server.targets().len(), 1, "a write is never repeated");
    let server = serve(vec![(REVIEWS_POST, vec![Reply::hang_up(), Reply::ok("{\"id\":1}")])]).await;
    assert!(host(&server).post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &[]).await.is_err());
    assert_eq!(server.targets().len(), 1, "not even after a failure in transit");
}

#[tokio::test]
async fn refused_reviews_read_plainly_and_a_403_means_the_repository_cannot_take_reviews() {
    let server = serve(vec![
        ("/repos/acme/webshop", vec![Reply::ok("{\"full_name\":\"acme/webshop\",\"name\":\"webshop\",\"private\":true,\"permissions\":{\"pull\":true,\"push\":true}}")]),
        (REVIEWS_POST, vec![Reply::status(403, "{\"message\":\"Resource not accessible by personal access token\"}")]),
        ("POST /repos/acme/webshop/pulls/219/reviews", vec![Reply::status(404, "{\"message\":\"Not Found\"}")]),
        ("POST /repos/acme/webshop/pulls/220/reviews", vec![Reply::status(422, "{\"message\":\"Unprocessable Entity\",\"errors\":[\"Line could not be resolved\"]}")]),
    ])
    .await;
    let host = host(&server);
    assert!(host.review_access("acme/webshop").await.unwrap().can_post, "a fine-grained token with push may post");
    let err = host.post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &[]).await.unwrap_err();
    assert_eq!(err.to_string(), "GitHub refused to post the review: the token can't write to pull requests in acme/webshop. Open the PR view instead, or reconnect GitHub with write access.");
    let access = host.review_access("acme/webshop").await.unwrap();
    assert!(!access.can_post && access.reason.as_deref() == Some(err.to_string().as_str()), "the refusal wins over the permissions: {access:?}");
    let err = host.post_review("acme/webshop", 219, "a1b2c3d4e5f6", "s", &[]).await.unwrap_err();
    assert_eq!(err.to_string(), "GitHub couldn't find pull request #219 in acme/webshop, or the token can't see it.");
    let err = host.post_review("acme/webshop", 220, "a1b2c3d4e5f6", "s", &review_comments()).await.unwrap_err();
    let Error::ReviewOutdated(said) = &err else { panic!("{err:?}") };
    assert!(said.contains("Line could not be resolved"), "{said}");
    assert_eq!(server.targets().iter().filter(|t| t.ends_with("/reviews")).count(), 3, "each was sent once");
}

#[tokio::test]
async fn a_422_that_isnt_about_the_reviews_lines_says_what_github_said_rather_than_outdated() {
    let server = serve(vec![(REVIEWS_POST, vec![Reply::status(422, "{\"message\":\"Unprocessable Entity\",\"errors\":[\"User can only have one pending review per pull request\"]}")])]).await;
    let err = host(&server).post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &review_comments()).await.unwrap_err();
    let Error::CodeHost { status: 422, message } = &err else { panic!("{err:?}") };
    assert_eq!(message, "GitHub didn't accept the review: User can only have one pending review per pull request.");
    let server = serve(vec![(REVIEWS_POST, vec![Reply::status(422, "{\"message\":\"Validation Failed\",\"errors\":[{\"message\":\"commit_id is not part of the pull request\"}]}")])]).await;
    let err = host(&server).post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &review_comments()).await.unwrap_err();
    assert!(matches!(&err, Error::ReviewOutdated(said) if said.contains("commit_id is not part of the pull request")), "{err:?}");
}

#[tokio::test]
async fn a_post_refused_for_single_sign_on_isnt_remembered_as_the_repository_refusing_reviews() {
    let server = serve(vec![
        ("/repos/acme/webshop", vec![Reply::ok("{\"full_name\":\"acme/webshop\",\"name\":\"webshop\",\"private\":true,\"permissions\":{\"pull\":true,\"push\":true}}")]),
        (REVIEWS_POST, vec![Reply::status(403, "{\"message\":\"Resource protected by organization SAML enforcement.\"}").header("x-github-sso", "required; url=https://github.com/orgs/acme/sso?authorization_request=1")]),
    ])
    .await;
    let host = host(&server);
    let err = host.post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &[]).await.unwrap_err();
    assert!(err.to_string().contains("SAML single sign-on"), "{err}");
    assert!(host.refused_reviews.lock().unwrap().is_empty(), "authorising single sign-on lifts it");
    assert!(host.review_access("acme/webshop").await.unwrap().can_post);
}

#[tokio::test]
async fn a_rate_limited_post_says_so_rather_than_blaming_the_token() {
    let server = serve(vec![(REVIEWS_POST, vec![Reply::status(403, "{\"message\":\"API rate limit exceeded\"}").header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "4102444800")])]).await;
    let host = host(&server);
    assert!(matches!(host.post_review("acme/webshop", 218, "a1b2c3d4e5f6", "s", &[]).await, Err(Error::RateLimited { .. })));
    assert!(host.refused_reviews.lock().unwrap().is_empty(), "a rate limit says nothing about access");
}

#[tokio::test]
async fn review_access_follows_a_classic_tokens_scopes_and_a_fine_grained_tokens_permissions() {
    let repo = |private: bool, pull: bool, push: bool| format!("{{\"full_name\":\"acme/webshop\",\"name\":\"webshop\",\"private\":{private},\"permissions\":{{\"pull\":{pull},\"push\":{push}}}}}");
    let cases: Vec<(Option<&str>, String, bool, Option<&str>)> = vec![
        (Some("repo, read:org"), repo(true, true, false), true, None),
        (Some("public_repo"), repo(false, true, false), true, None),
        (Some("public_repo"), repo(true, true, false), false, Some("it has only the public_repo scope, and the repository is private")),
        (Some("read:org, notifications"), repo(false, true, true), false, Some("it lacks the repo scope")),
        (Some(""), repo(false, true, true), false, Some("it lacks the repo scope")),
        (Some("repo"), repo(true, false, false), false, Some("it can't read the repository")),
        (None, repo(true, true, true), true, None),
        (None, repo(true, true, false), false, Some("it lacks write access to its pull requests")),
    ];
    for (scopes, body, can_post, why) in cases {
        let reply = match scopes {
            Some(s) => Reply::ok(&body).header("x-oauth-scopes", s),
            None => Reply::ok(&body),
        };
        let server = serve(vec![("/repos/acme/webshop", vec![reply])]).await;
        let access = host(&server).review_access("acme/webshop").await.unwrap();
        assert_eq!(access.can_post, can_post, "{scopes:?} {body}");
        assert_eq!(access.reason, why.map(|w| format!("This GitHub token can't post reviews on acme/webshop ({w}).")), "{scopes:?} {body}");
        assert!(server.seen.lock().unwrap().iter().all(|s| s.method == "GET"));
    }
}

#[test]
fn the_one_write_to_github_is_the_comment_review_in_write_rs() {
    let elsewhere = [
        ("github/mod.rs", include_str!("mod.rs")),
        ("github/read.rs", include_str!("read.rs")),
        ("github/wire.rs", include_str!("wire.rs")),
        ("codehost/mod.rs", include_str!("../mod.rs")),
        ("codehost/events.rs", include_str!("../events.rs")),
        ("codehost/links.rs", include_str!("../links.rs")),
        ("codehost/diff.rs", include_str!("../diff.rs")),
        ("codehost/keys.rs", include_str!("../keys.rs")),
    ];
    for (name, source) in elsewhere {
        assert!(!source.contains("post_json") && !source.contains(".post(") && !source.contains(".put(") && !source.contains(".patch("), "{name} writes to GitHub");
    }
    let write = include_str!("write.rs");
    assert_eq!(write.matches("post_json(").count(), 1, "one request");
    assert_eq!(write.matches("/reviews").count(), 1, "to one endpoint");
    assert!(write.contains("const EVENT: &str = \"COMMENT\";") && !write.contains("APPROVE") && !write.contains("REQUEST_CHANGES"), "as a comment only");
    let http = include_str!("http.rs");
    assert_eq!(http.matches(".post(").count(), 1, "the transport has one way to post, post_json");
}

#[tokio::test]
async fn a_pull_diff_reads_the_pull_request_and_its_files_and_nothing_else() {
    let server = serve(vec![
        ("/repos/acme/webshop/pulls/208", vec![Reply::ok(PULL_208)]),
        ("/repos/acme/webshop/pulls/208/files?per_page=100", vec![Reply::ok(FILES)]),
    ])
    .await;
    let diff = host(&server).pull_diff("acme/webshop", 208).await.unwrap();
    assert_eq!((diff.change.number, diff.change.title.as_str()), (Some(208), "CA-208: Route checkout through the gateway"));
    assert_eq!(diff.change.sha.as_deref(), Some("aaa1111"), "the head commit, to tell whether a review is outdated");
    assert_eq!(diff.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["src/gateway/routes.ts", "docs/logo.png", "src/big.ts"]);
    assert!(diff.files[0].patch.is_some());
    let seen = server.seen.lock().unwrap().clone();
    assert!(seen.iter().all(|s| s.method == "GET"), "reads only: {:?}", server.targets());
    assert_eq!(server.targets(), ["/repos/acme/webshop/pulls/208", "/repos/acme/webshop/pulls/208/files?per_page=100"]);
}

#[tokio::test]
async fn review_comments_read_the_reviews_and_at_most_three_pages_of_inline_comments_and_nothing_else() {
    let reviews = r#"[{"id":5,"user":{"login":"bea"},"state":"CHANGES_REQUESTED","submitted_at":"2026-09-30T09:00:00Z","body":"Please add a backoff."},{"id":6,"user":null,"state":"COMMENTED","submitted_at":null}]"#;
    let page = |n: u32| format!(r#"[{{"path":"src/a.ts","line":{n},"original_line":{n},"side":"RIGHT","user":{{"login":"bea"}},"body":"Comment {n}","created_at":"2026-09-30T09:00:00Z","pull_request_review_id":5}}]"#);
    let next = |n: u32| format!("</repos/acme/webshop/pulls/208/comments?per_page=100&page={n}>; rel=\"next\"");
    let outdated = r#"[{"path":"src/b.ts","line":null,"original_line":9,"side":"RIGHT","user":{"login":"cy"},"body":"Old","created_at":null,"pull_request_review_id":99}]"#;
    let server = serve(vec![
        ("/repos/acme/webshop/pulls/208/reviews?per_page=100", vec![Reply::ok(reviews)]),
        ("/repos/acme/webshop/pulls/208/comments?per_page=100", vec![Reply::ok(&page(1)).header("link", &next(2))]),
        ("/repos/acme/webshop/pulls/208/comments?per_page=100&page=2", vec![Reply::ok(outdated).header("link", &next(3))]),
        ("/repos/acme/webshop/pulls/208/comments?per_page=100&page=3", vec![Reply::ok(&page(3)).header("link", &next(4))]),
        ("/repos/acme/webshop/pulls/208/comments?per_page=100&page=4", vec![Reply::ok(&page(4))]),
    ])
    .await;
    let got = host(&server).review_comments("acme/webshop", 208).await.unwrap();
    assert_eq!(got.reviews.len(), 2);
    assert_eq!((got.reviews[0].author.as_deref(), got.reviews[0].state.as_str(), got.reviews[0].body.as_str()), (Some("bea"), "CHANGES_REQUESTED", "Please add a backoff."));
    assert_eq!((got.reviews[1].author.as_deref(), got.reviews[1].body.as_str()), (None, ""));
    let rows: Vec<_> = got.comments.iter().map(|c| (c.path.as_str(), c.line, c.original_line, c.state.as_deref(), c.body.as_str())).collect();
    assert_eq!(rows, [("src/a.ts", Some(1), Some(1), Some("CHANGES_REQUESTED"), "Comment 1"), ("src/b.ts", None, Some(9), None, "Old"), ("src/a.ts", Some(3), Some(3), Some("CHANGES_REQUESTED"), "Comment 3")], "three pages at most");
    assert!(server.seen.lock().unwrap().iter().all(|s| s.method == "GET"), "reads only: {:?}", server.targets());
    assert_eq!(server.targets().len(), 4);
}
