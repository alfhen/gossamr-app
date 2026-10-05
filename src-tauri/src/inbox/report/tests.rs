use serde_json::{json, Value};

use super::*;
use crate::domain::{Intent, Run, RunKind, RunSpec, RunState, REPORT_TOOL_VERSION};
use crate::inbox::run_results::tests::{approved, body_of, next_spec, project, run_with};
use crate::inbox::testing::{fixture_watching, Fixture};
use crate::runs::report::{new_token, token_hash, ReportStatus, ResultSource, MAX_CALLS, MAX_REJECTIONS};

const WRITTEN: &str = "Prose findings.\n\nFor Jira:\nFrom the written answer.";

fn good() -> Value {
    json!({ "status": "done", "note": "From the tool." })
}

/// A run that is under way and was given a token.
async fn open(fx: &Fixture, spec: RunSpec, item: Option<crate::domain::ItemRef>) -> (Run, String) {
    fx.core.set_report_enabled(true);
    let run = approved(fx, RunSpec { report: true, ..spec }, item, "", |r| {
        r.state = RunState::Working;
        r.result = None;
        r.result_complete = false;
        r.ended_at = None;
    })
    .await;
    let token = new_token().unwrap();
    fx.core.report_reserve(&run.id, &token_hash(&token), REPORT_TOOL_VERSION).await.unwrap();
    (run, token)
}

async fn ticket_run(fx: &Fixture) -> (Run, String) {
    open(fx, next_spec(fx), Some(fx.item("CA-1"))).await
}

async fn call(fx: &Fixture, run: &Run, token: &str, args: Value) -> Reply {
    fx.core.call(&run.id, &token_hash(token), &args).await
}

async fn set(fx: &Fixture, run: &Run, f: impl FnOnce(&mut Run)) -> Run {
    let mut run = fx.core.run(&run.id).await.unwrap().unwrap();
    f(&mut run);
    fx.core.save_run(&run).await.unwrap();
    run
}

async fn finish(fx: &Fixture, run: &Run, written: Option<&str>) -> Run {
    set(fx, run, |r| {
        r.state = RunState::Done;
        r.result = written.map(Into::into);
        r.result_complete = written.is_some();
        r.ended_at = Some(chrono::Utc::now());
    })
    .await
}

fn recorded(revision: u32) -> Reply {
    Reply::Recorded { revision, notes: vec![] }
}

#[tokio::test]
async fn a_report_is_stored_and_the_comment_is_drafted_from_it_not_from_the_written_answer() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    assert_eq!(call(&fx, &run, &token, good()).await, recorded(1));
    let done = finish(&fx, &run, Some(WRITTEN)).await;

    let outcome = fx.core.run_outcome(&done.id).await.unwrap();
    assert_eq!((outcome.source, outcome.note.as_ref().map(|n| n.text.as_str())), (Some(ResultSource::Structured), Some("From the tool.")));
    let view = outcome.report.unwrap();
    assert_eq!((view.offered, view.revision, view.calls, view.rejections, view.stale, view.locked, view.status), (true, 1, 1, 0, false, false, Some(ReportStatus::Done)));

    let draft = fx.core.auto_draft_run_comment(&done.id).await.unwrap().expect("drafted");
    let text = body_of(&draft);
    assert!(text.ends_with("From the tool.") && !text.contains("written answer") && !text.contains("didn't mark"), "{text}");
    assert!(fx.tracker.intents().is_empty(), "a report writes nothing to Jira, and neither does its draft");
}

#[tokio::test]
async fn a_blocked_report_says_so_ahead_of_the_note() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    call(&fx, &run, &token, json!({ "status": "blocked", "note": "Waiting on the DBA." })).await;
    let done = finish(&fx, &run, Some(WRITTEN)).await;
    let text = body_of(&fx.core.auto_draft_run_comment(&done.id).await.unwrap().unwrap());
    assert!(text.contains("The agent reports it could not finish.\nWaiting on the DBA."), "{text}");
    assert_eq!(fx.core.run_outcome(&done.id).await.unwrap().report.unwrap().status, Some(ReportStatus::Blocked));
}

#[tokio::test]
async fn a_run_that_never_reports_reads_as_it_always_did_and_says_where_it_came_from() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let plain = run_with(&fx, |_| {}).await;
    let outcome = fx.core.run_outcome(&plain.id).await.unwrap();
    assert_eq!((outcome.source, outcome.report), (Some(ResultSource::Section), None));
    assert_eq!(outcome.note.unwrap().text, "Add a backoff to the consumer.");

    let (run, _) = ticket_run(&fx).await;
    let done = finish(&fx, &run, Some("No marker at all.")).await;
    let outcome = fx.core.run_outcome(&done.id).await.unwrap();
    assert_eq!(outcome.source, Some(ResultSource::Whole));
    let view = outcome.report.unwrap();
    assert_eq!((view.offered, view.revision, view.calls), (true, 0, 0), "the tool was offered and not used");

    let only = set(&fx, &run, |r| (r.result, r.result_complete) = (Some("One line.".into()), false)).await;
    let outcome = fx.core.run_outcome(&only.id).await.unwrap();
    assert_eq!((outcome.source, outcome.summary_only), (Some(ResultSource::SummaryOnly), true));
}

#[tokio::test]
async fn a_report_stands_in_for_an_answer_that_could_not_be_read() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    call(&fx, &run, &token, good()).await;
    let done = set(&fx, &run, |r| (r.state, r.result, r.result_complete, r.ended_at) = (RunState::Done, Some("One line.".into()), false, Some(chrono::Utc::now()))).await;
    let outcome = fx.core.run_outcome(&done.id).await.unwrap();
    assert_eq!((outcome.source, outcome.summary_only), (Some(ResultSource::Structured), false));
    let text = body_of(&fx.core.auto_draft_run_comment(&done.id).await.unwrap().unwrap());
    assert!(text.ends_with("From the tool.") && !text.contains("one-line summary"), "{text}");
}

#[tokio::test]
async fn a_token_works_for_its_own_run_while_it_is_open_and_for_nothing_else() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (a, token_a) = ticket_run(&fx).await;
    let (b, token_b) = ticket_run(&fx).await;
    assert_eq!(call(&fx, &b, &token_a, good()).await, Reply::Unavailable, "a's token on b's run");
    assert_eq!(call(&fx, &a, &token_b, good()).await, Reply::Unavailable, "b's token on a's run");
    assert_eq!(call(&fx, &a, &new_token().unwrap(), good()).await, Reply::Unavailable, "a token nobody minted");
    assert_eq!(fx.core.call("no-such-run", &token_hash(&token_a), &good()).await, Reply::Unavailable);
    assert!(fx.core.report_stored(&b.id).await.unwrap().unwrap().report.is_none(), "nothing landed on b");

    for state in [RunState::Queued, RunState::Done, RunState::Failed, RunState::Stopped] {
        set(&fx, &a, |r| r.state = state).await;
        assert_eq!(call(&fx, &a, &token_a, good()).await, Reply::Unavailable, "{state:?}");
    }
    set(&fx, &a, |r| r.state = RunState::Working).await;
    assert_eq!(call(&fx, &a, &token_a, good()).await, recorded(1), "a stopped run that was woken is open again");
}

#[tokio::test]
async fn every_state_a_live_run_can_be_in_takes_a_call() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    for state in [RunState::Launching, RunState::Working, RunState::NeedsAnswer, RunState::NeedsPermission, RunState::SystemBlocked, RunState::Unknown] {
        let (run, token) = ticket_run(&fx).await;
        set(&fx, &run, |r| r.state = state).await;
        assert_eq!(call(&fx, &run, &token, good()).await, recorded(1), "{state:?}");
    }
}

#[tokio::test]
async fn a_token_minted_for_another_tool_version_is_refused() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, _) = ticket_run(&fx).await;
    let old = new_token().unwrap();
    fx.core.report_reserve(&run.id, &token_hash(&old), REPORT_TOOL_VERSION + 1).await.unwrap();
    assert_eq!(call(&fx, &run, &old, good()).await, Reply::Unavailable);
}

#[tokio::test]
async fn forgetting_the_tokens_of_a_run_ends_every_one_of_them() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, first) = ticket_run(&fx).await;
    let second = new_token().unwrap();
    fx.core.report_reserve(&run.id, &token_hash(&second), REPORT_TOOL_VERSION).await.unwrap();
    assert_eq!(call(&fx, &run, &first, good()).await, recorded(1));
    assert_eq!(call(&fx, &run, &second, json!({ "status": "done", "note": "Again.", "revise": true })).await, recorded(2), "every launch's token stays valid");
    fx.core.report_forget(&run.id).await.unwrap();
    assert_eq!(call(&fx, &run, &first, good()).await, Reply::Unavailable);
    assert_eq!(call(&fx, &run, &second, good()).await, Reply::Unavailable);
    assert_eq!(fx.core.report_stored(&run.id).await.unwrap().unwrap().revision, 2, "what was reported stays");
}

#[tokio::test]
async fn the_first_report_stands_until_a_call_says_revise() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    assert_eq!(call(&fx, &run, &token, good()).await, recorded(1));
    assert_eq!(call(&fx, &run, &token, good()).await, Reply::Unchanged, "the same report again changes nothing");
    assert_eq!(call(&fx, &run, &token, json!({ "status": "blocked", "note": "Other." })).await, Reply::Already);
    assert_eq!(call(&fx, &run, &token, json!({ "status": "blocked", "note": "Other.", "revise": true })).await, recorded(2));
    let row = fx.core.report_stored(&run.id).await.unwrap().unwrap();
    assert_eq!((row.report.unwrap().status, row.revision, row.calls, row.rejections), (ReportStatus::Blocked, 2, 4, 0));
}

#[tokio::test]
async fn an_answer_makes_an_earlier_report_stale_and_a_new_call_replaces_it_without_revise() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    call(&fx, &run, &token, good()).await;
    fx.core.report_stale(&run.id).await.unwrap();
    let done = finish(&fx, &run, Some(WRITTEN)).await;
    let outcome = fx.core.run_outcome(&done.id).await.unwrap();
    assert_eq!((outcome.source, outcome.note.unwrap().text.as_str()), (Some(ResultSource::Section), "From the written answer."));
    assert!(outcome.report.unwrap().stale);

    set(&fx, &run, |r| r.state = RunState::Working).await;
    assert_eq!(call(&fx, &run, &token, json!({ "status": "done", "note": "After the answer." })).await, recorded(2));
    let outcome = fx.core.run_outcome(&run.id).await.unwrap();
    assert_eq!((outcome.source, outcome.report.unwrap().stale), (Some(ResultSource::Structured), false));
}

#[tokio::test]
async fn too_many_calls_or_refusals_lock_the_tool_for_the_run() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    for n in 1..=MAX_REJECTIONS {
        assert!(matches!(call(&fx, &run, &token, json!({ "status": "done" })).await, Reply::Invalid(_)), "{n}");
    }
    assert_eq!(call(&fx, &run, &token, good()).await, Reply::Locked, "even a good call is refused now");
    let row = fx.core.report_stored(&run.id).await.unwrap().unwrap();
    assert_eq!((row.report, row.rejections, row.calls), (None, MAX_REJECTIONS, MAX_REJECTIONS));
    assert!(fx.core.run_outcome(&run.id).await.unwrap().report.unwrap().locked);

    let (busy, token) = ticket_run(&fx).await;
    call(&fx, &busy, &token, good()).await;
    for _ in 1..MAX_CALLS {
        assert_eq!(call(&fx, &busy, &token, good()).await, Reply::Unchanged);
    }
    assert_eq!(call(&fx, &busy, &token, good()).await, Reply::Locked);
    assert_eq!(fx.core.report_stored(&busy.id).await.unwrap().unwrap().calls, MAX_CALLS);
}

#[tokio::test]
async fn a_refused_call_changes_nothing_but_the_counts() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = ticket_run(&fx).await;
    call(&fx, &run, &token, good()).await;
    let Reply::Invalid(problems) = call(&fx, &run, &token, json!({ "status": "done", "note": "Changed.", "revise": true, "extra": 1 })).await else { panic!() };
    assert_eq!(problems, ["extra: not a field of this tool."]);
    let row = fx.core.report_stored(&run.id).await.unwrap().unwrap();
    assert_eq!((row.report.unwrap().note.as_deref(), row.revision, row.calls, row.rejections), (Some("From the tool."), 1, 2, 1));
}

#[tokio::test]
async fn a_triage_drafts_its_breakdown_from_the_report_even_when_the_text_has_none() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = open(&fx, RunSpec { kind: RunKind::Triage, ..next_spec(&fx) }, Some(fx.item("CA-1"))).await;
    call(&fx, &run, &token, json!({ "status": "done", "note": "Too big for one.", "subtasks": ["Split the consumer", "Add the backoff", "split the consumer"] })).await;
    let done = finish(&fx, &run, Some("Prose with no subtasks.\n\nFor Jira: x")).await;
    assert_eq!(fx.core.run_outcome(&done.id).await.unwrap().subtasks, ["Split the consumer", "Add the backoff"]);
    let draft = fx.core.draft_run_subtasks(&done.id).await.unwrap().expect("drafted");
    assert!(matches!(&draft.intent, Intent::Subtasks { summaries, .. } if summaries == &["Split the consumer", "Add the backoff"]));
    assert!(fx.tracker.intents().is_empty());
}

#[tokio::test]
async fn an_investigation_without_a_ticket_drafts_its_ticket_from_the_report() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let spec = RunSpec { instruction: String::new(), project: Some(project(&fx).await), ..next_spec(&fx) };
    let (run, token) = open(&fx, spec, None).await;
    assert!(matches!(call(&fx, &run, &token, json!({ "status": "done", "note": "n" })).await, Reply::Invalid(_)), "a ticketless run reports a ticket");
    let args = json!({ "status": "done", "newTicket": { "title": "Add a backoff to the consumer", "kind": "bug", "body": "It spins." } });
    assert_eq!(call(&fx, &run, &token, args).await, recorded(1));
    let done = finish(&fx, &run, Some("Prose only, no sections.")).await;
    let draft = fx.core.auto_draft_run_ticket(&done.id).await.unwrap().expect("drafted from the report alone");
    match &draft.intent {
        Intent::Create { fields, .. } => assert_eq!((fields.title.as_str(), fields.kind), ("Add a backoff to the consumer", crate::domain::ItemKind::Bug)),
        other => panic!("{other:?}"),
    }
    assert_eq!(fx.core.run_outcome(&done.id).await.unwrap().ticket.unwrap().title, "Add a backoff to the consumer");
}

#[tokio::test]
async fn a_plan_run_carries_the_plan_it_reported() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let (run, token) = open(&fx, RunSpec { kind: RunKind::Plan, ..next_spec(&fx) }, Some(fx.item("CA-1"))).await;
    call(&fx, &run, &token, json!({ "status": "done", "note": "Plan attached.", "plan": "## Approach\n\n1. Reported step." })).await;
    let done = finish(&fx, &run, Some("## Approach\n\n1. Written step.\n\nFor Jira: Plan attached.")).await;
    let comment = fx.core.draft_run_plan_comment(&done.id).await.unwrap();
    let text = body_of(&comment.proposal);
    assert!(text.contains("Reported step.") && !text.contains("Written step."), "{text}");
}

#[tokio::test]
async fn drafting_with_the_tool_is_refused_while_the_setting_is_off() {
    let fx = fixture_watching(&["acme/webshop"]).await;
    let spec = RunSpec { report: true, ..next_spec(&fx) };
    let off = fx.core.draft_run(spec.clone(), Some(fx.item("CA-1"))).await.unwrap_err().to_string();
    assert!(off.contains("Reporting through Gossamr is off"), "{off}");
    let plain = fx.core.draft_run(RunSpec { report: false, ..spec.clone() }, Some(fx.item("CA-1"))).await.unwrap();
    let edit = crate::inbox::Edit::Run { instruction: None, base: None, clone_path: None, kind: None, name: None, pr: None, allow_push: None, report: Some(true), plan: None, build_account: None, project: None };
    assert!(fx.core.edit_proposal(&plain.id, &edit).await.is_err());

    fx.core.set_report_enabled(true);
    let on = fx.core.draft_run(spec, Some(fx.item("CA-1"))).await.unwrap();
    let review = fx.core.runs_review(&on.id).await.unwrap();
    assert!(review.spec.report && review.prompt.contains("If the run-report tool `report_result` is available"));
    let before = fx.core.runs_review(&plain.id).await.unwrap().digest;
    let edited = fx.core.edit_proposal(&plain.id, &edit).await.unwrap();
    assert!(matches!(&edited.intent, Intent::StartRun { spec, .. } if spec.report));
    assert_ne!(fx.core.runs_review(&edited.id).await.unwrap().digest, before, "the digest follows what the draft now says");
}
