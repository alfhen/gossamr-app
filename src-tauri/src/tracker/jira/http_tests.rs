//! The Jira client and tracker against a local server that replays Jira's documented response shapes.

use std::sync::Arc;

use serde_json::{json, Value};

use super::client::Jira;
use super::JiraTracker;
use crate::auth::{Account, Auth, Credentials, Scope, Site, Tokens};
use crate::codehost::github::testserver::{serve, Reply, Server};
use crate::domain::{ContainerRef, Doc, Intent, ItemRef};
use crate::error::Error;
use crate::tracker::{Connection, WorkTracker};

const SEARCH: &str = "/ex/jira/site/rest/api/3/search/jql";
const PAGE_1: &str = include_str!("fixtures/search_page.json");
const PAGE_2: &str = include_str!("fixtures/search_page_2.json");
const COMMENTS: &str = include_str!("fixtures/comments_all.json");
const TRANSITIONS: &str = include_str!("fixtures/transitions_with_fields.json");

fn scope() -> Scope {
    Scope { cloud_id: "site".into(), account_id: "me".into() }
}

fn auth(http: &reqwest::Client) -> Arc<Auth> {
    let credentials = Credentials {
        tokens: Tokens { access_token: "tok".into(), refresh_token: "ref".into(), expires_at: u64::MAX / 2 },
        site: Site { cloud_id: "site".into(), name: "Site".into(), url: "https://site.atlassian.net".into() },
        me: Account { account_id: "me".into(), name: "Me".into(), avatar_url: None },
    };
    Arc::new(Auth::signed_in(http.clone(), credentials))
}

fn client(server: &Server) -> Jira {
    let http = reqwest::Client::new();
    Jira::at(&server.base, http.clone(), auth(&http))
}

fn tracker(server: &Server) -> JiraTracker {
    let http = reqwest::Client::new();
    JiraTracker::at(&server.base, http.clone(), auth(&http), &Connection::jira(&scope(), "Site"))
}

fn bodies(server: &Server) -> Vec<Value> {
    server.seen.lock().unwrap().iter().map(|s| serde_json::from_str(&s.body).unwrap_or(Value::Null)).collect()
}

fn item(key: &str) -> ItemRef {
    ItemRef { connection_id: "jira:site:me".into(), external_id: key.into(), key: key.into() }
}

#[tokio::test]
async fn a_search_follows_its_page_token_and_skips_issues_it_cannot_read() {
    let server = serve(vec![
        (SEARCH, vec![Reply::ok(PAGE_1), Reply::ok(PAGE_2)]),
        ("/ex/jira/site/rest/api/3/issue/CA-1/comment", vec![Reply::ok(COMMENTS)]),
    ])
    .await;
    let found = client(&server).search(&scope(), "project = CA", Some("2026-09-01T00:00:00Z"), 100).await.unwrap();
    assert_eq!(found.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(), ["CA-1", "CA-3"], "CA-2 has no status and is left out");
    let posts: Vec<Value> = bodies(&server).into_iter().filter(|b| b.get("jql").is_some()).collect();
    assert_eq!(posts.len(), 2);
    assert!(posts[0].get("nextPageToken").is_none());
    assert_eq!(posts[1]["nextPageToken"], "page-2");
    assert_eq!(posts[0]["expand"], "changelog");

    let first = &found[0];
    assert_eq!(first.description, "a plain string, not a document");
    assert_eq!(first.comments.len(), 3, "the page held one of three comments, so all were read");
    assert_eq!(first.comments[1].author.account_id, "unknown", "a comment from a deleted account is kept");
    assert_eq!(first.history[0].author.name, "Someone", "so is a change with no author");
    assert_eq!(first.history[0].items[0].field, "priority");
}

#[tokio::test]
async fn the_limit_stops_paging() {
    let server = serve(vec![(SEARCH, vec![Reply::ok(PAGE_1), Reply::ok(PAGE_2)]), ("/ex/jira/site/rest/api/3/issue/CA-1/comment", vec![Reply::ok(COMMENTS)])]).await;
    let found = client(&server).search(&scope(), "x", None, 1).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(server.targets().iter().filter(|t| t.contains("search/jql")).count(), 1);
}

#[tokio::test]
async fn an_empty_page_with_a_token_ends_the_search() {
    let looping = json!({ "issues": [], "nextPageToken": "again" }).to_string();
    let server = serve(vec![(SEARCH, vec![Reply::ok(&looping)])]).await;
    assert!(client(&server).search(&scope(), "x", None, 10).await.unwrap().is_empty());
    assert_eq!(server.targets().len(), 1);
}

fn comment_page(start: u64, count: u64, total: u64) -> String {
    let comments: Vec<Value> = (start..start + count)
        .map(|i| json!({ "id": i.to_string(), "author": { "accountId": "sam", "displayName": "Sam" }, "created": "2026-09-28T10:00:00.000+0000", "body": "x" }))
        .collect();
    json!({ "startAt": start, "maxResults": 100, "total": total, "comments": comments }).to_string()
}

#[tokio::test]
async fn comments_are_read_page_by_page_until_the_total() {
    let base = "/ex/jira/site/rest/api/3/issue/CA-1/comment";
    let server = serve(vec![
        (&format!("{base}?startAt=0&maxResults=100"), vec![Reply::ok(&comment_page(0, 100, 230))]),
        (&format!("{base}?startAt=100&maxResults=100"), vec![Reply::ok(&comment_page(100, 100, 230))]),
        (&format!("{base}?startAt=200&maxResults=100"), vec![Reply::ok(&comment_page(200, 30, 230))]),
    ])
    .await;
    let all = client(&server).comments(&scope(), "CA-1").await.unwrap();
    assert_eq!(all.len(), 230);
    assert_eq!(all.last().unwrap().id, "229");
}

#[tokio::test]
async fn a_changelog_without_a_total_that_came_back_full_is_paged_to_its_end() {
    let histories: Vec<Value> = (0..100)
        .map(|i| json!({ "id": format!("a{i}"), "author": { "accountId": "sam", "displayName": "Sam" }, "created": "2026-09-01T00:00:00.000+0000", "items": [] }))
        .collect();
    let page = json!({ "issues": [{
        "key": "CA-1",
        "fields": { "summary": "s", "status": { "id": "1", "name": "To Do", "statusCategory": { "key": "new" } }, "updated": "2026-09-28T10:00:00.000+0000" },
        "changelog": { "histories": histories }
    }]})
    .to_string();
    let values = |from: usize, n: usize| {
        let v: Vec<Value> = (from..from + n)
            .map(|i| json!({ "id": format!("h{i}"), "author": { "accountId": "sam", "displayName": "Sam" }, "created": "2026-09-20T00:00:00.000+0000", "items": [] }))
            .collect();
        json!({ "total": 120, "values": v }).to_string()
    };
    let log = "/ex/jira/site/rest/api/3/issue/CA-1/changelog";
    let server = serve(vec![
        (SEARCH, vec![Reply::ok(&page)]),
        (&format!("{log}?startAt=0&maxResults=1"), vec![Reply::ok(&json!({ "total": 120, "values": [] }).to_string())]),
        (&format!("{log}?startAt=20&maxResults=100"), vec![Reply::ok(&values(20, 100))]),
        (&format!("{log}?startAt=0&maxResults=20"), vec![Reply::ok(&values(0, 20))]),
    ])
    .await;
    let found = client(&server).search(&scope(), "x", Some("2026-01-01T00:00:00Z"), 10).await.unwrap();
    assert_eq!(found[0].history.len(), 120);
    assert_eq!(found[0].history[0].id, "h0", "oldest first");
}

#[tokio::test]
async fn a_rate_limited_request_waits_as_told_and_goes_again() {
    let server = serve(vec![(
        "/ex/jira/site/rest/api/3/issue/CA-1/comment",
        vec![Reply::status(429, "{}").header("Retry-After", "0"), Reply::status(429, "{}").header("retry-after", "0"), Reply::ok(COMMENTS)],
    )])
    .await;
    let comments = client(&server).comments(&scope(), "CA-1").await.unwrap();
    assert_eq!(comments.len(), 3);
    assert_eq!(server.targets().len(), 3);
}

#[tokio::test]
async fn a_limit_that_does_not_lift_is_reported_with_how_long_to_wait() {
    let server = serve(vec![("/ex/jira/site/rest/api/3/issue/CA-1/comment", vec![Reply::status(429, "{}").header("Retry-After", "0")])]).await;
    let err = client(&server).comments(&scope(), "CA-1").await.unwrap_err();
    assert!(matches!(err, Error::RateLimited { .. }), "{err}");
    assert_eq!(server.targets().len(), 4, "the first try and three retries");

    let server = serve(vec![("/ex/jira/site/rest/api/3/issue/CA-1/comment", vec![Reply::status(429, "{}").header("Retry-After", "300")])]).await;
    let err = client(&server).comments(&scope(), "CA-1").await.unwrap_err();
    assert!(matches!(err, Error::RateLimited { retry_after_secs: 300, .. }), "{err}");
    assert_eq!(server.targets().len(), 1, "a long wait is not sat out");
}

#[tokio::test]
async fn a_503_is_only_a_rate_limit_when_it_says_when_to_return() {
    let server = serve(vec![("/ex/jira/site/rest/api/3/issue/CA-1/comment", vec![Reply::status(503, "down")])]).await;
    let err = client(&server).comments(&scope(), "CA-1").await.unwrap_err();
    assert!(matches!(err, Error::Api { status: 503, .. }), "{err}");
    assert_eq!(server.targets().len(), 1);
}

const TRANSITION_PATH: &str = "/ex/jira/site/rest/api/3/issue/CA-1/transitions";

#[tokio::test]
async fn closing_an_issue_fills_the_resolution_its_screen_requires() {
    let server = serve(vec![(TRANSITION_PATH, vec![Reply::ok(TRANSITIONS), Reply::status(204, "")])]).await;
    let intent = Intent::Transition { item: item("CA-1"), to: "10001".into() };
    tracker(&server).apply(&intent).await.unwrap();
    let seen = server.seen.lock().unwrap().clone();
    assert_eq!(seen[0].target, format!("{TRANSITION_PATH}?expand=transitions.fields"));
    let sent: Value = serde_json::from_str(&seen[1].body).unwrap();
    assert_eq!(sent, json!({ "transition": { "id": "31" }, "fields": { "resolution": { "id": "10001" } } }));
}

#[tokio::test]
async fn a_required_field_it_cannot_fill_is_named_and_nothing_is_sent() {
    let server = serve(vec![(TRANSITION_PATH, vec![Reply::ok(TRANSITIONS)])]).await;
    let intent = Intent::Transition { item: item("CA-1"), to: "10002".into() };
    let err = tracker(&server).apply(&intent).await.unwrap_err();
    let Error::Api { status: 400, message } = err else { panic!("{err}") };
    assert!(message.contains("Reason") && message.contains("CA-1") && message.contains("Rejected"), "{message}");
    assert_eq!(server.seen.lock().unwrap().iter().filter(|s| s.method == "POST").count(), 0);
}

#[tokio::test]
async fn a_project_that_lists_but_cannot_be_read_is_left_out_of_the_containers() {
    let projects = json!({ "isLast": true, "values": [{ "key": "A", "name": "Alpha" }, { "key": "B", "name": "Beta" }] }).to_string();
    let statuses = json!([{ "name": "Task", "statuses": [{ "id": "1", "name": "To Do", "statusCategory": { "key": "new" } }] }]).to_string();
    let server = serve(vec![
        ("/ex/jira/site/rest/api/3/project/search", vec![Reply::ok(&projects)]),
        ("/ex/jira/site/rest/api/3/project/A/statuses", vec![Reply::ok(&statuses)]),
        ("/ex/jira/site/rest/api/3/project/B/statuses", vec![Reply::status(403, "{}")]),
    ])
    .await;
    let refs = [ContainerRef { connection_id: "jira:site:me".into(), external_id: "A".into() }, ContainerRef { connection_id: "jira:site:me".into(), external_id: "B".into() }];
    let got = tracker(&server).containers_of(&refs).await.unwrap();
    assert_eq!(got.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["A"]);
    assert_eq!(tracker(&server).containers().await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_comment_posts_its_body_as_adf() {
    let server = serve(vec![("/ex/jira/site/rest/api/3/issue/CA-1/comment", vec![Reply::status(201, "{}")])]).await;
    tracker(&server).apply(&Intent::Comment { item: item("CA-1"), body: Doc::paragraph("hi") }).await.unwrap();
    assert_eq!(bodies(&server)[0]["body"]["type"], "doc");
}

#[tokio::test]
async fn a_rewrite_puts_only_the_fields_it_changes_the_description_as_adf() {
    use crate::domain::{BodyChange, TitleChange};
    let server = serve(vec![("/ex/jira/site/rest/api/3/issue/CA-1", vec![Reply::status(204, ""), Reply::status(204, "")])]).await;
    let body = BodyChange { from: Doc::paragraph("old"), to: Doc::from_markdown("# Scope\n\n- one\n- two", &[]) };
    let both = Intent::Rewrite { item: item("CA-1"), title: Some(TitleChange { from: "Old".into(), to: " New title ".into() }), body: Some(body.clone()), flattened: vec![] };
    tracker(&server).apply(&both).await.unwrap();
    let only_title = Intent::Rewrite { item: item("CA-1"), title: Some(TitleChange { from: "Old".into(), to: "Newer".into() }), body: None, flattened: vec![] };
    tracker(&server).apply(&only_title).await.unwrap();
    let seen = server.seen.lock().unwrap().clone();
    assert!(seen.iter().all(|s| s.method == "PUT" && s.target == "/ex/jira/site/rest/api/3/issue/CA-1"));
    let first: Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(first["fields"]["summary"], "New title");
    assert_eq!(first["fields"]["description"]["type"], "doc");
    assert_eq!(first["fields"]["description"]["content"][0]["type"], "heading");
    assert_eq!(first["fields"]["description"]["content"][1]["type"], "bulletList");
    let second: Value = serde_json::from_str(&seen[1].body).unwrap();
    assert_eq!(second, json!({ "fields": { "summary": "Newer" } }), "a title-only rewrite can't touch the description");
}

#[tokio::test]
async fn a_deleted_or_unreadable_issue_reads_as_gone_not_as_raw_json() {
    let body = r#"{"errorMessages":["Issue does not exist or you do not have permission to see it."],"errors":{}}"#;
    let server = serve(vec![("/ex/jira/site/rest/api/3/issue/CA-9", vec![Reply::status(404, body)])]).await;
    let err = tracker(&server).item(&item("CA-9"), "2026-01-01T00:00:00Z").await.unwrap_err();
    let Error::Api { status: 404, message } = err else { panic!("{err}") };
    assert_eq!(message, "CA-9 doesn't exist, or you can no longer see it");
}

#[tokio::test]
async fn a_search_naming_a_project_the_person_cannot_see_drops_it_and_reports_it() {
    let refused = r#"{"errorMessages":["The value 'SECRET' does not exist for the field 'project'."],"errors":{}}"#;
    let server = serve(vec![(SEARCH, vec![Reply::status(400, refused), Reply::ok(PAGE_2)])]).await;
    let watches = ["CA", "SECRET"].map(|k| crate::domain::Watch {
        container: ContainerRef { connection_id: "jira:site:me".into(), external_id: k.into() },
        depth: crate::domain::Depth::Involved,
        pinned: false,
        source: crate::domain::WatchSource::Manual,
        added_at: String::new(),
        unwatched_at: None,
        inaccessible: false,
    });
    let opts = crate::tracker::SearchOptions { limit: 10, ..Default::default() };
    let found = tracker(&server).followed(30, &crate::domain::ContainerScope::Only(watches.to_vec()), &opts).await.unwrap();
    assert_eq!(found.items.iter().map(|i| i.item.key.as_str()).collect::<Vec<_>>(), ["CA-3"]);
    assert_eq!(found.inaccessible.iter().map(|c| c.external_id.as_str()).collect::<Vec<_>>(), ["SECRET"]);
    let second = &bodies(&server)[1]["jql"];
    assert!(!second.as_str().unwrap().contains("SECRET"));
}

#[tokio::test]
async fn a_retry_after_given_as_a_past_date_retries_at_once() {
    let server = serve(vec![(
        "/ex/jira/site/rest/api/3/issue/CA-1/comment",
        vec![Reply::status(429, "{}").header("Retry-After", "Wed, 21 Oct 2015 07:28:00 GMT"), Reply::ok(COMMENTS)],
    )])
    .await;
    assert_eq!(client(&server).comments(&scope(), "CA-1").await.unwrap().len(), 3);
    assert_eq!(server.targets().len(), 2);
}

#[tokio::test]
async fn an_answer_to_an_agent_is_refused_and_nothing_is_sent_to_jira() {
    let server = serve(vec![]).await;
    let answer = Intent::RunAnswer { connection_id: "jira:site:me".into(), run_id: "r1".into(), short_id: None, item: Some(item("CA-1")), message: "Use staging.".into(), question: None };
    let err = tracker(&server).apply(&answer).await.unwrap_err();
    assert!(matches!(&err, Error::Proposal(m) if m.contains("its own button")), "{err}");
    assert!(server.seen.lock().unwrap().is_empty(), "no request reached Jira");
}

#[tokio::test]
async fn a_github_review_is_refused_and_nothing_is_sent_to_jira() {
    let server = serve(vec![]).await;
    let review = Intent::GithubReview {
        connection_id: "github:ann".into(),
        item: Some(item("CA-1")),
        run_id: "r1".into(),
        repo: "acme/webshop".into(),
        number: 218,
        commit_sha: "a1b2c3d4e5f6".into(),
        summary: "Gossamr review of #218.".into(),
        comments: vec![crate::domain::ReviewComment { path: "src/consumer/retry.ts".into(), line: 42, side: crate::domain::DiffSide::Right, body: "No backoff.".into() }],
    };
    let err = tracker(&server).apply(&review).await.unwrap_err();
    assert!(matches!(&err, Error::Proposal(m) if m.contains("posted to GitHub with its own button")), "{err}");
    assert!(server.seen.lock().unwrap().is_empty(), "no request reached Jira");
}
