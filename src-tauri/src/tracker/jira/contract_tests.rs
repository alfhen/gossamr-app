//! Bodies shaped like the ones in Atlassian's REST v3 reference, read through the client, and the requests the adapter
//! sends back. Each fixture names the endpoint it follows; none of this has run against a live site yet.

use std::sync::Arc;

use serde_json::{json, Value};

use super::client::Jira;
use super::{adf, JiraTracker};
use crate::auth::{Account, Auth, Credentials, Scope, Site, Tokens};
use crate::codehost::github::testserver::{serve, Reply, Server};
use crate::domain::{
    Block, BodyChange, Category, ContainerRef, Doc, Inline, Intent, ItemKind, ItemRef, Link, LinkKind, Mark, NewItem, Patch, PersonRef, Priority, TitleChange,
};
use crate::error::Error;
use crate::tracker::{Connection, WorkTracker};

/// `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` ("Get create metadata issue types for a project").
const ISSUE_TYPES: &str = include_str!("fixtures/doc_createmeta_issuetypes.json");
/// `POST /rest/api/3/issue` ("Create issue"), the 201 body.
const CREATED: &str = include_str!("fixtures/doc_create_issue_response.json");
/// `GET /rest/api/3/project/{projectIdOrKey}/statuses` ("Get all statuses for project").
const STATUSES: &str = include_str!("fixtures/doc_project_statuses.json");
/// `GET /rest/api/3/project/search` ("Get projects paginated"), with `expand=insight`.
const PROJECTS: &str = include_str!("fixtures/doc_project_search.json");
/// `GET /rest/api/3/issue/{issueIdOrKey}/transitions?expand=transitions.fields` ("Get transitions").
const TRANSITIONS: &str = include_str!("fixtures/doc_transitions_expanded.json");
/// `GET /rest/api/3/issue/{issueIdOrKey}/comment` ("Get comments"), with ADF bodies.
const COMMENTS: &str = include_str!("fixtures/doc_comments_adf.json");
/// `GET /rest/api/3/issue/{issueIdOrKey}?expand=changelog` ("Get issue"), with links, sub-tasks and attachments.
const ISSUE: &str = include_str!("fixtures/doc_issue_get.json");

const API: &str = "/ex/jira/site/rest/api/3";

fn scope() -> Scope {
    Scope { cloud_id: "site".into(), account_id: "me".into() }
}

fn auth(http: &reqwest::Client) -> Arc<Auth> {
    let credentials = Credentials {
        tokens: Tokens { access_token: "tok-secret".into(), refresh_token: "ref".into(), expires_at: u64::MAX / 2 },
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

fn item(key: &str) -> ItemRef {
    ItemRef { connection_id: "jira:site:me".into(), external_id: key.into(), key: key.into() }
}

fn person(id: &str) -> PersonRef {
    PersonRef { connection_id: "jira:site:me".into(), account_id: id.into() }
}

/// The requests of one method, as `(path and query, body)`.
fn sent(server: &Server, method: &str) -> Vec<(String, Value)> {
    let seen = server.seen.lock().unwrap();
    seen.iter().filter(|s| s.method == method).map(|s| (s.target.clone(), serde_json::from_str(&s.body).unwrap_or(Value::Null))).collect()
}

fn text(s: &str) -> Inline {
    Inline::Text { text: s.into(), marks: vec![] }
}

#[tokio::test]
async fn issue_types_read_the_documented_page_including_nulls_and_extra_fields() {
    let server = serve(vec![(&format!("{API}/issue/createmeta/EX/issuetypes"), vec![Reply::ok(ISSUE_TYPES)])]).await;
    let types = client(&server).issue_types(&scope(), "EX").await.unwrap();
    assert_eq!(types.iter().map(|t| (t.id.as_str(), t.name.as_str(), t.subtask)).collect::<Vec<_>>(), [("10000", "Epic", false), ("10001", "Task", false), ("10002", "Bug", false), ("10003", "Sub-task", true)]);
    assert_eq!(super::intent::pick_type(ItemKind::Bug, &types).unwrap().id, "10002");
    assert_eq!(super::intent::pick_type(ItemKind::Epic, &types).unwrap().id, "10000");
    assert!(super::intent::pick_type(ItemKind::Story, &types).is_none(), "no Story in this project, and the sub-task is never picked");
}

#[tokio::test]
async fn creating_an_issue_sends_the_project_type_id_and_adf_and_reads_the_new_key() {
    let server = serve(vec![
        (&format!("{API}/issue/createmeta/EX/issuetypes"), vec![Reply::ok(ISSUE_TYPES)]),
        (&format!("POST {API}/issue"), vec![Reply::status(201, CREATED)]),
        (&format!("POST {API}/issueLink"), vec![Reply::status(201, "")]),
    ])
    .await;
    let body = Doc { blocks: vec![Block::Paragraph { content: vec![text("Steps")] }, Block::Code { language: Some("sh".into()), text: "make test".into() }] };
    let fields = NewItem {
        title: "Checkout fails".into(),
        body,
        kind: ItemKind::Bug,
        assignee: Some(person("5b10a2844c20165700ede21g")),
        parent: Some(item("EX-100")),
        priority: Some(Priority::High),
        labels: vec!["checkout".into()],
    };
    let link = Link { from: item("NEW"), to: item("EX-7"), kind: LinkKind::Blocks };
    let intent = Intent::Create { container: ContainerRef { connection_id: "jira:site:me".into(), external_id: "EX".into() }, fields, link: Some(link) };
    let applied = tracker(&server).apply(&intent).await.unwrap();
    assert_eq!(applied.created[0].key, "ED-24");
    assert!(applied.error.is_none());
    let posts = sent(&server, "POST");
    assert_eq!(posts[0].0, format!("{API}/issue"));
    assert_eq!(
        posts[0].1,
        json!({ "fields": {
            "assignee": { "accountId": "5b10a2844c20165700ede21g" },
            "parent": { "key": "EX-100" },
            "priority": { "name": "High" },
            "project": { "key": "EX" },
            "issuetype": { "id": "10002" },
            "summary": "Checkout fails",
            "description": { "type": "doc", "version": 1, "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Steps" }] },
                { "type": "codeBlock", "attrs": { "language": "sh" }, "content": [{ "type": "text", "text": "make test" }] },
            ]},
            "labels": ["checkout"],
        }})
    );
    assert_eq!(
        posts[1].1,
        json!({ "type": { "name": "Blocks" }, "inwardIssue": { "key": "ED-24" }, "outwardIssue": { "key": "EX-7" } }),
        "the new issue is the one that blocks"
    );
}

#[tokio::test]
async fn a_failed_link_after_a_create_keeps_the_new_issue_and_carries_jiras_words() {
    let refused = r#"{"errorMessages":["No issue link type with name 'Blocks' found."],"errors":{}}"#;
    let server = serve(vec![
        (&format!("{API}/issue/createmeta/EX/issuetypes"), vec![Reply::ok(ISSUE_TYPES)]),
        (&format!("POST {API}/issue"), vec![Reply::status(201, CREATED)]),
        (&format!("POST {API}/issueLink"), vec![Reply::status(404, refused)]),
    ])
    .await;
    let fields = NewItem { title: "t".into(), body: Doc::default(), kind: ItemKind::Task, assignee: None, parent: None, priority: None, labels: vec![] };
    let link = Link { from: item("NEW"), to: item("EX-7"), kind: LinkKind::Blocks };
    let intent = Intent::Create { container: ContainerRef { connection_id: "jira:site:me".into(), external_id: "EX".into() }, fields, link: Some(link) };
    let applied = tracker(&server).apply(&intent).await.unwrap();
    assert_eq!(applied.created[0].key, "ED-24");
    assert_eq!(applied.error.unwrap().to_string(), "Jira returned 404: POST issueLink: No issue link type with name 'Blocks' found.");
    let posts = sent(&server, "POST");
    assert!(posts[0].1.pointer("/fields/description").is_none(), "an empty description is left out");
}

#[tokio::test]
async fn sub_tasks_are_created_under_the_parent_with_the_sub_task_type_id() {
    let server = serve(vec![
        (&format!("{API}/issue/createmeta/EX/issuetypes"), vec![Reply::ok(ISSUE_TYPES)]),
        (&format!("POST {API}/issue"), vec![Reply::status(201, CREATED), Reply::status(400, r#"{"errorMessages":[],"errors":{"summary":"Summary is too long."}}"#)]),
    ])
    .await;
    let intent = Intent::Subtasks { parent: item("EX-1"), summaries: vec!["Reproduce".into(), "Fix".into(), "Never reached".into()] };
    let applied = tracker(&server).apply(&intent).await.unwrap();
    assert_eq!(applied.created.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["ED-24"]);
    assert_eq!(applied.error.unwrap().to_string(), "Jira returned 400: POST issue: summary: Summary is too long.");
    let posts = sent(&server, "POST");
    assert_eq!(posts.len(), 2, "it stops at the first refusal");
    assert_eq!(posts[0].1, json!({ "fields": { "project": { "key": "EX" }, "parent": { "key": "EX-1" }, "issuetype": { "id": "10003" }, "summary": "Reproduce" } }));
}

#[tokio::test]
async fn a_project_without_a_sub_task_type_says_so_before_anything_is_created() {
    let only_tasks = json!({ "maxResults": 50, "startAt": 0, "total": 1, "issueTypes": [{ "id": "1", "name": "Task", "subtask": false }] }).to_string();
    let server = serve(vec![(&format!("{API}/issue/createmeta/EX/issuetypes"), vec![Reply::ok(&only_tasks)])]).await;
    let err = tracker(&server).apply(&Intent::Subtasks { parent: item("EX-1"), summaries: vec!["a".into()] }).await.unwrap_err();
    assert_eq!(err.to_string(), "Jira returned 400: project EX has no sub-task issue type");
    assert!(sent(&server, "POST").is_empty());
}

#[tokio::test]
async fn links_name_the_type_and_put_the_blocker_in_the_inward_end() {
    let server = serve(vec![(&format!("POST {API}/issueLink"), vec![Reply::status(201, "")])]).await;
    for (kind, name) in [(LinkKind::Blocks, "Blocks"), (LinkKind::Relates, "Relates"), (LinkKind::Duplicates, "Duplicate")] {
        tracker(&server).apply(&Intent::Link { from: item("EX-1"), to: item("EX-2"), kind }).await.unwrap();
        let (target, body) = sent(&server, "POST").pop().unwrap();
        assert_eq!(target, format!("{API}/issueLink"));
        assert_eq!(body, json!({ "type": { "name": name }, "inwardIssue": { "key": "EX-1" }, "outwardIssue": { "key": "EX-2" } }));
    }
    let err = tracker(&server).apply(&Intent::Link { from: item("EX-1"), to: item("pr"), kind: LinkKind::ImplementedBy }).await.unwrap_err();
    assert!(matches!(err, Error::Proposal(_)));
    assert_eq!(sent(&server, "POST").len(), 3, "a code change is never sent to Jira as a link");
}

#[tokio::test]
async fn an_update_sends_only_the_fields_in_the_patch() {
    let server = serve(vec![(&format!("PUT {API}/issue/EX-1"), vec![Reply::status(204, "")])]).await;
    let patch = Patch { assignee: Some(person("5b10a2844c20165700ede21g")), parent: Some(item("EX-100")), priority: Some(Priority::Lowest) };
    tracker(&server).apply(&Intent::Update { item: item("EX-1"), patch }).await.unwrap();
    tracker(&server).apply(&Intent::Update { item: item("EX-1"), patch: Patch { priority: Some(Priority::Highest), ..Default::default() } }).await.unwrap();
    tracker(&server).apply(&Intent::Update { item: item("EX-1"), patch: Patch::default() }).await.unwrap();
    let puts = sent(&server, "PUT");
    assert_eq!(puts.len(), 2, "an empty patch sends nothing");
    assert_eq!(puts[0].1, json!({ "fields": { "assignee": { "accountId": "5b10a2844c20165700ede21g" }, "parent": { "key": "EX-100" }, "priority": { "name": "Lowest" } } }));
    assert_eq!(puts[1].1, json!({ "fields": { "priority": { "name": "Highest" } } }));
}

#[tokio::test]
async fn a_rewrite_sends_the_description_as_adf_with_marks_mentions_links_code_and_lists() {
    let server = serve(vec![(&format!("PUT {API}/issue/EX-1"), vec![Reply::status(204, "")])]).await;
    let to = Doc {
        blocks: vec![
            Block::Heading { level: 2, content: vec![text("Scope")] },
            Block::Paragraph {
                content: vec![
                    Inline::Text { text: "bold".into(), marks: vec![Mark::Bold, Mark::Italic] },
                    text(" "),
                    Inline::Mention { person: person("5b109f2e9729b51b54dc274d"), name: "Carolyn".into() },
                    text(" "),
                    Inline::Link { href: "https://example.com".into(), text: "docs".into() },
                    Inline::LineBreak,
                    Inline::Text { text: "x".into(), marks: vec![Mark::Strike] },
                ],
            },
            Block::List { ordered: true, items: vec![vec![Block::Paragraph { content: vec![text("one")] }], vec![Block::Paragraph { content: vec![text("two")] }]] },
            Block::Quote { content: vec![Block::Paragraph { content: vec![text("quoted")] }] },
            Block::Code { language: None, text: "plain".into() },
            Block::Rule,
        ],
    };
    let change = Intent::Rewrite {
        item: item("EX-1"),
        title: Some(TitleChange { from: "Old".into(), to: "New".into() }),
        body: Some(BodyChange { from: Doc::paragraph("old"), to }),
        flattened: vec![],
    };
    tracker(&server).apply(&change).await.unwrap();
    let (target, body) = sent(&server, "PUT").remove(0);
    assert_eq!(target, format!("{API}/issue/EX-1"));
    assert_eq!(
        body,
        json!({ "fields": {
            "summary": "New",
            "description": { "type": "doc", "version": 1, "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Scope" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "bold", "marks": [{ "type": "strong" }, { "type": "em" }] },
                    { "type": "text", "text": " " },
                    { "type": "mention", "attrs": { "id": "5b109f2e9729b51b54dc274d", "text": "@Carolyn" } },
                    { "type": "text", "text": " " },
                    { "type": "text", "text": "docs", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "x", "marks": [{ "type": "strike" }] },
                ]},
                { "type": "orderedList", "content": [
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }] },
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "two" }] }] },
                ]},
                { "type": "blockquote", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "quoted" }] }] },
                { "type": "codeBlock", "content": [{ "type": "text", "text": "plain" }] },
                { "type": "rule" },
            ]},
        }})
    );
}

/// Atlassian's schema doesn't let `code` share a text node with other formatting marks (only a link), and Jira answers
/// 400 INVALID_INPUT to a node that does.
#[test]
fn inline_code_is_sent_without_other_formatting_marks() {
    let doc = Doc { blocks: vec![Block::Paragraph { content: vec![Inline::Text { text: "run".into(), marks: vec![Mark::Bold, Mark::Code] }] }] };
    assert_eq!(adf::from_doc(&doc)["content"][0]["content"][0], json!({ "type": "text", "text": "run", "marks": [{ "type": "code" }] }));
}

#[tokio::test]
async fn a_refused_write_reaches_the_person_with_status_method_path_and_jiras_text() {
    let refused = r#"{"errorMessages":[],"errors":{"description":"Operation value must be an Atlassian Document Format document."}}"#;
    let server = serve(vec![(&format!("PUT {API}/issue/EX-1"), vec![Reply::status(400, refused)])]).await;
    let change = Intent::Rewrite { item: item("EX-1"), title: None, body: Some(BodyChange { from: Doc::default(), to: Doc::paragraph("x") }), flattened: vec![] };
    let err = tracker(&server).apply(&change).await.unwrap_err().to_string();
    assert_eq!(err, "Jira returned 400: PUT issue/EX-1: description: Operation value must be an Atlassian Document Format document.");
    assert!(!err.contains("tok-secret") && !err.to_lowercase().contains("authorization"));

    let server = serve(vec![(&format!("POST {API}/issue/EX-1/comment"), vec![Reply::status(403, r#"{"errorMessages":["You do not have permission to comment on this issue."],"errors":{}}"#)])]).await;
    let err = tracker(&server).apply(&Intent::Comment { item: item("EX-1"), body: Doc::paragraph("hi") }).await.unwrap_err();
    assert_eq!(err.to_string(), "Jira returned 403: POST issue/EX-1/comment: You do not have permission to comment on this issue.");
}

#[tokio::test]
async fn a_project_s_statuses_are_read_once_each_with_their_category() {
    let server = serve(vec![(&format!("{API}/project/EX/statuses"), vec![Reply::ok(STATUSES)])]).await;
    let statuses = client(&server).project_statuses(&scope(), "EX").await.unwrap();
    assert_eq!(statuses.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Open", "In Progress", "Done", "Triage"], "Open is on two issue types and listed once");
    assert_eq!(statuses.iter().map(|s| s.category).collect::<Vec<_>>(), [Category::Todo, Category::Active, Category::Done, Category::Active], "'No Category' reads as active");
    assert_eq!(statuses[2].id, "10002");
}

#[tokio::test]
async fn the_project_catalog_reads_the_documented_page_with_insight_archived_and_nulls() {
    let server = serve(vec![(&format!("{API}/project/search"), vec![Reply::ok(PROJECTS)])]).await;
    let (page, last) = client(&server).project_page(&scope(), "ex", 0, 50).await.unwrap();
    assert!(last);
    assert_eq!(page.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["EX", "OLD", "SVC"]);
    assert_eq!(page[0].kind.as_deref(), Some("software"));
    assert_eq!((page[0].issue_count, page[0].last_active.as_deref()), (Some(100), Some("2021-04-22T05:37:05Z")));
    assert!(page[1].archived && page[1].issue_count.is_none() && page[1].last_active.is_none(), "insight: null");
    assert_eq!((page[2].issue_count, page[2].last_active.clone()), (Some(0), None), "lastIssueUpdateTime: null");
    let all = client(&server).projects(&scope(), 10).await.unwrap();
    assert_eq!(all, [("EX".to_string(), "Example".to_string()), ("OLD".into(), "Old stuff".into()), ("SVC".into(), "Service desk".into())]);
    let asked = server.targets();
    assert!(asked[0].contains("expand=insight") && asked[0].contains("query=ex"), "{asked:?}");
}

#[tokio::test]
async fn transitions_are_read_with_their_screens_and_the_right_one_is_posted_at_approval() {
    let path = format!("{API}/issue/EX-1/transitions");
    let server = serve(vec![(&path, vec![Reply::ok(TRANSITIONS)]), (&format!("POST {path}"), vec![Reply::status(204, "")])]).await;
    let all = client(&server).transitions(&scope(), "EX-1", true).await.unwrap();
    assert_eq!(all.iter().map(|t| (t.id.as_str(), t.to.id.as_str(), t.required.len())).collect::<Vec<_>>(), [("2", "10000", 0), ("711", "5", 2), ("712", "10000", 0), ("713", "6", 1)]);
    assert_eq!(all[1].required[0].id, "customfield_10010");
    assert_eq!(all[1].required[0].allowed, [("10112".to_string(), "Red".to_string()), ("10113".into(), "Blue".into())], "custom options carry `value`, not `name`");

    // Closing: the first transition that reaches the status, as long as it needs nothing.
    tracker(&server).apply(&Intent::Transition { item: item("EX-1"), to: "10000".into() }).await.unwrap();
    // Resolving: the screen insists on a resolution, so Done is sent by id, in `fields`.
    tracker(&server).apply(&Intent::Transition { item: item("EX-1"), to: "6".into() }).await.unwrap();
    let posts = sent(&server, "POST");
    assert_eq!(posts[0].1, json!({ "transition": { "id": "2" } }));
    assert_eq!(posts[1].1, json!({ "transition": { "id": "713" }, "fields": { "resolution": { "id": "10000" } } }));

    // A required custom field can't be guessed: it is named, and nothing is posted.
    let err = tracker(&server).apply(&Intent::Transition { item: item("EX-1"), to: "5".into() }).await.unwrap_err();
    assert_eq!(err.to_string(), "Jira returned 400: Jira needs Colour to move EX-1 to In QA; set it in Jira.");
    // A status no transition reaches.
    let err = tracker(&server).apply(&Intent::Transition { item: item("EX-1"), to: "99".into() }).await.unwrap_err();
    assert!(err.to_string().contains("can't move to that status"), "{err}");
    assert_eq!(sent(&server, "POST").len(), 2);
}

#[tokio::test]
async fn a_refused_transition_names_the_workflow_rule_jira_gave() {
    let path = format!("{API}/issue/EX-1/transitions");
    let refused = r#"{"errorMessages":["Transition id '2' is not valid for this issue."],"errors":{}}"#;
    let server = serve(vec![(&path, vec![Reply::ok(TRANSITIONS)]), (&format!("POST {path}"), vec![Reply::status(400, refused)])]).await;
    let err = tracker(&server).apply(&Intent::Transition { item: item("EX-1"), to: "10000".into() }).await.unwrap_err();
    assert_eq!(err.to_string(), "Jira returned 400: POST issue/EX-1/transitions: Transition id '2' is not valid for this issue.");
}

#[tokio::test]
async fn comments_read_adf_with_marks_mentions_code_panels_and_media() {
    let server = serve(vec![(&format!("{API}/issue/EX-1/comment"), vec![Reply::ok(COMMENTS)])]).await;
    let comments = client(&server).comments(&scope(), "EX-1").await.unwrap();
    assert_eq!(comments.len(), 3, "a reported maxResults of 1048576 doesn't matter, the total ends the paging");

    let first = &comments[0];
    assert_eq!((first.author.name.as_str(), first.created.as_str()), ("Mia Krystof", "2021-01-17T12:34:00Z"));
    for needle in ["Hi @Carolyn, this is important and see the docs", "👍", "https://your-domain.atlassian.net/browse/EX-12", "println!(\"hi\");", "no language", "Heads up from the panel", "first", "nested", "quoted"] {
        assert!(first.body.contains(needle), "missing {needle:?} in {:?}", first.body);
    }
    assert_eq!(first.mentions, ["5b109f2e9729b51b54dc274d"]);
    assert_eq!((first.mentioned[0].account_id.as_str(), first.mentioned[0].name.as_str()), ("5b109f2e9729b51b54dc274d", "Carolyn"));
    let doc = adf::to_doc(first.doc.as_ref().unwrap(), "c");
    let Block::Paragraph { content } = &doc.blocks[0] else { panic!("{:?}", doc.blocks[0]) };
    assert!(content.iter().any(|i| matches!(i, Inline::Mention { name, .. } if name == "Carolyn")));
    assert!(content.iter().any(|i| matches!(i, Inline::Link { href, text } if href == "https://example.com/docs" && text == "see the docs")));
    assert!(content.iter().any(|i| matches!(i, Inline::Text { text, marks } if text == "important" && marks == &[Mark::Bold])), "textColor is dropped, bold kept");
    assert!(doc.blocks.iter().any(|b| matches!(b, Block::Code { language: Some(l), text } if l == "rust" && text.starts_with("fn main()"))));
    assert!(doc.blocks.iter().any(|b| matches!(b, Block::Code { language: None, .. })), "an empty attrs object is no language");
    assert!(doc.blocks.iter().any(|b| matches!(b, Block::Quote { .. })), "the panel reads as a quote");
    assert!(doc.blocks.iter().any(|b| matches!(b, Block::Rule)));

    assert_eq!((comments[1].author.name.as_str(), comments[1].created.as_str()), ("Carolyn", "2021-01-19T07:00:00Z"), "an inactive author is kept, and +0100 becomes UTC");
    assert_eq!((comments[2].author.account_id.as_str(), comments[2].body.as_str()), ("unknown", ""), "author: null and an empty document");
}

#[tokio::test]
async fn an_issue_reads_its_links_sub_tasks_attachments_and_history_and_ignores_what_it_does_not_know() {
    let server = serve(vec![(&format!("{API}/issue/EX-1"), vec![Reply::ok(ISSUE)])]).await;
    let t = client(&server).issue(&scope(), "EX-1", "2021-01-01T00:00:00Z").await.unwrap();
    assert_eq!((t.key.as_str(), t.summary.as_str(), t.issue_type.as_str(), t.is_epic), ("EX-1", "Checkout fails for guests", "Bug", false));
    assert_eq!((t.status.id.as_str(), t.status.category.as_str()), ("3", "indeterminate"));
    assert!(t.assignee.is_none() && t.due_date.is_none() && t.resolved.is_none());
    assert_eq!(t.reporter.as_ref().unwrap().name, "Mia Krystof");
    let parent = t.parent.as_ref().unwrap();
    assert_eq!((parent.key.as_str(), parent.summary.as_str()), ("EX-100", "Payments epic"));
    assert_eq!(t.subtasks.iter().map(|s| (s.key.as_str(), s.done)).collect::<Vec<_>>(), [("EX-2", true)]);
    assert_eq!(t.links.iter().map(|l| (l.kind.as_str(), l.other.as_str(), l.outward)).collect::<Vec<_>>(), [("Blocks", "EX-3", true), ("Duplicate", "EX-4", false)]);
    assert_eq!(t.attachments.iter().map(|a| (a.id.as_str(), a.mime_type.as_str(), a.size)).collect::<Vec<_>>(), [("10000", "image/png", 23123), ("10001", "application/octet-stream", 0)]);
    assert_eq!(t.labels, ["checkout", "p1"]);
    for needle in ["Steps", "Add to basket", "Pay as guest", "Production only", "{\"error\": 500}"] {
        assert!(t.description.contains(needle), "missing {needle:?} in {:?}", t.description);
    }
    assert!(t.description_doc.is_some());
    assert_eq!(t.comments.len(), 1);
    assert_eq!(t.created.as_deref(), Some("2021-01-17T12:34:00Z"));
    assert_eq!(t.history.len(), 1);
    let change = &t.history[0].items;
    assert_eq!((change[0].field.as_str(), change[0].from.as_deref(), change[0].to.as_deref(), change[0].to_id.as_deref()), ("status", Some("To Do"), Some("In Progress"), Some("3")));
    assert_eq!((change[1].from.as_deref(), change[1].to_id.as_deref()), (None, None), "nulls are absent, not empty");
}

#[test]
fn the_issue_fixture_is_the_shape_the_unit_tests_expect_of_every_issue() {
    let raw: Value = serde_json::from_str(ISSUE).unwrap();
    assert!(super::client::parse_issue(&raw).is_some());
}
