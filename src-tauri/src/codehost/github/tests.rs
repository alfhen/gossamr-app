use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};

use super::testserver::{serve, Reply, Server};
use super::*;
use crate::domain::{CheckState, CodeChangeKind, CodeChangeState, ReviewState};
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
