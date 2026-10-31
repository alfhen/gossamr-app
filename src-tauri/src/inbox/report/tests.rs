use serde_json::{json, Value};

use super::*;
use crate::domain::{fixtures::run_spec, ProposalQuery, Run, RunState, REPORT_TOOL_VERSION};
use crate::inbox::testing::{fixture_watching, Fixture};
use crate::runs::report::{new_token, token_hash, ReportStatus, ResultSource, MAX_CALLS, MAX_REJECTIONS};

async fn open(fx: &Fixture) -> (Run, String) {
    let mut run = Run::queued("report-run".into(), "p1".into(), fx.scope.connection_id.clone(), Some(fx.item("CA-1")), run_spec(), Utc::now());
    run.state = RunState::Working;
    run.spec.report = true;
    fx.insert_run(&run).await;
    let token = new_token().unwrap();
    fx.core.report_reserve(&run.id, &token_hash(&token), REPORT_TOOL_VERSION).await.unwrap();
    (run, token)
}

async fn call(fx: &Fixture, run: &Run, token: &str, args: Value) -> Reply {
    fx.core.report_call(&run.id, &token_hash(token), &args).await
}

fn good() -> Value { json!({"status":"done", "note":"## Findings\nA full prose report."}) }

#[tokio::test]
async fn a_report_is_stored_as_prose_and_leaves_no_automatic_drafts_or_tracker_writes() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (mut run, token) = open(&fx).await;
    assert!(matches!(call(&fx, &run, &token, good()).await, Reply::Recorded {revision:1,..}));
    run.state = RunState::Done;
    run.result = Some("For Jira:\nA written answer.".into());
    run.result_complete = true;
    fx.core.save_run(&run).await.unwrap();
    let outcome = fx.core.run_outcome(&run.id).await.unwrap();
    assert_eq!((outcome.source, outcome.note.as_deref()), (Some(ResultSource::Structured), Some("## Findings\nA full prose report.")));
    let view = outcome.report.unwrap();
    assert_eq!((view.status, view.calls, view.revision, view.stale), (Some(ReportStatus::Done), 1, 1, false));
    assert!(fx.core.proposals(&ProposalQuery::default()).await.unwrap().is_empty());
    assert!(fx.tracker.intents().is_empty());
    assert_eq!(call(&fx, &run, &token, good()).await, Reply::Unavailable);
}

#[tokio::test]
async fn revisions_are_explicit_and_answers_stale_the_report_without_losing_it() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (mut run, token) = open(&fx).await;
    assert!(matches!(call(&fx, &run, &token, good()).await, Reply::Recorded {revision:1,..}));
    assert_eq!(call(&fx, &run, &token, good()).await, Reply::Unchanged);
    assert_eq!(call(&fx, &run, &token, json!({"status":"blocked","note":"Changed"})).await, Reply::Already);
    assert!(matches!(call(&fx, &run, &token, json!({"status":"blocked","note":"Changed","revise":true})).await, Reply::Recorded {revision:2,..}));
    fx.core.report_stale(&run.id).await.unwrap();
    run.result = Some("For Jira:\nKeep the entire answer.".into());
    run.result_complete = true;
    fx.core.save_run(&run).await.unwrap();
    let outcome = fx.core.run_outcome(&run.id).await.unwrap();
    assert_eq!((outcome.source, outcome.note.as_deref()), (Some(ResultSource::Whole), Some("For Jira:\nKeep the entire answer.")));
    assert!(outcome.report.unwrap().stale);
    assert!(fx.core.report_stored(&run.id).await.unwrap().unwrap().report.is_some());
}

#[tokio::test]
async fn report_tokens_versions_and_limits_are_checked_before_any_report_is_stored() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = open(&fx).await;
    assert_eq!(call(&fx, &run, &new_token().unwrap(), good()).await, Reply::Unavailable);
    let older_token = new_token().unwrap();
    fx.core.report_reserve(&run.id, &token_hash(&older_token), REPORT_TOOL_VERSION - 1).await.unwrap();
    assert_eq!(call(&fx, &run, &older_token, good()).await, Reply::Unavailable);
    for _ in 0..MAX_REJECTIONS {
        assert!(matches!(call(&fx, &run, &token, json!({"status":"done"})).await, Reply::Invalid(_)));
    }
    assert_eq!(call(&fx, &run, &token, good()).await, Reply::Locked);
    let stored = fx.core.report_stored(&run.id).await.unwrap().unwrap();
    assert_eq!(stored.rejections, MAX_REJECTIONS);
    assert!(stored.report.is_none());
    assert!(stored.calls <= MAX_CALLS);
}

#[tokio::test]
async fn repeated_valid_calls_are_also_capped_and_cannot_change_the_report_after_locking() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = open(&fx).await;
    assert!(matches!(call(&fx, &run, &token, good()).await, Reply::Recorded { revision: 1, .. }));
    for _ in 1..MAX_CALLS {
        assert_eq!(call(&fx, &run, &token, good()).await, Reply::Unchanged);
    }
    assert_eq!(call(&fx, &run, &token, json!({"status":"blocked","note":"Changed","revise":true})).await, Reply::Locked);
    let stored = fx.core.report_stored(&run.id).await.unwrap().unwrap();
    assert_eq!((stored.calls, stored.revision, stored.rejections), (MAX_CALLS, 1, 0));
    assert_eq!(stored.report.unwrap().note.as_deref(), Some("## Findings\nA full prose report."));
}
