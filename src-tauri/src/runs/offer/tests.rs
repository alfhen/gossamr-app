use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::config::AgentSettings;
use crate::domain::{RunKind, RunSpec, GUARD, REPORT_GUARD};
use crate::runs::launcher::RunLauncher;
use crate::runs::report::{token_hash, well_formed, ReportChannel, ReportSink, Reply};
use crate::runs::rig::{ready_with, reporting, Rig};
use crate::runs::testing::Outcome;

fn dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gossamr-offer-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn token_in(config: &Path) -> String {
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
    json["mcpServers"]["run-report"]["headers"]["Authorization"].as_str().unwrap().strip_prefix("Bearer ").unwrap().to_owned()
}

fn first_launch(rig: &Rig) -> crate::runs::cli::LaunchRequest {
    rig.cli.0.lock().unwrap().launches[0].clone()
}

async fn queued_reporting(rig: &Rig, n: u32) -> Run {
    rig.fx.core.set_report_enabled(true);
    let p = rig.fx.core.draft_run(RunSpec { report: true, ..rig.spec(n) }, Some(rig.fx.item("CA-1"))).await.unwrap();
    let digest = rig.fx.core.runs_review(&p.id).await.unwrap().digest;
    rig.fx.core.runs_approve(&p.id, &digest).await.unwrap()
}

async fn report_as(rig: &Rig, run: &Run, token: &str, note: &str) -> Reply {
    rig.fx.core.call(&run.id, &token_hash(token), &json!({ "status": "done", "note": note, "revise": true })).await
}

#[tokio::test]
async fn a_run_that_asked_for_the_tool_launches_with_a_config_file_and_a_token_that_is_on_no_command_line() {
    let d = dir("offer");
    let rig = ready_with(reporting(&d)).await;
    let run = rig.launched_reporting(1, RunKind::Investigate).await;

    let request = first_launch(&rig);
    let launch = request.report.clone().expect("offered");
    assert_eq!(request.guard, format!("{GUARD} {REPORT_GUARD}"));
    assert_eq!(launch.config, d.join("report").join(format!("{}.json", run.id)));
    assert_eq!(std::fs::metadata(&launch.config).unwrap().permissions().mode() & 0o777, 0o600);
    let token = token_in(&launch.config);
    assert!(well_formed(&token));
    assert!(!request.guard.contains(&token) && !request.prompt.contains(&token) && !format!("{request:?}").contains(&token[4..]), "the token is in the file alone");

    assert!(rig.fx.core.report_stored(&run.id).await.unwrap().is_some_and(|r| r.report.is_none()), "recorded as offered, nothing reported");
    assert_eq!(report_as(&rig, &run, &token, "From the agent.").await, Reply::Recorded { revision: 1, notes: vec![] });
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn nothing_changes_for_a_run_that_did_not_ask_or_when_the_setting_or_the_server_is_off() {
    let d = dir("off");
    let channel = std::sync::Arc::new(ReportChannel::new(4242, d.join("report")));

    let rig = ready_with(reporting(&d)).await;
    rig.launched(1).await;
    let plain = first_launch(&rig);
    assert!((plain.report.is_none(), plain.guard.as_str()) == (true, GUARD), "a run that never asked is launched as before");

    let off = ready_with(|svc| svc.with_report(channel)).await;
    let run = queued_reporting(&off, 1).await;
    off.svc.launch(&run.id).await.unwrap();
    let request = first_launch(&off);
    assert!(request.report.is_none() && request.guard == GUARD, "the setting is off");
    assert!(off.fx.core.report_stored(&run.id).await.unwrap().is_none());
    assert_eq!(off.get(&run).await.state, RunState::Launching);

    let no_server = ready_with(|svc| svc.with_settings(AgentSettings { report_result: true, ..AgentSettings::default() })).await;
    let run = queued_reporting(&no_server, 1).await;
    no_server.svc.launch(&run.id).await.unwrap();
    assert!(first_launch(&no_server).report.is_none(), "no server, no offer, and the run still starts");
    assert_eq!(no_server.get(&run).await.state, RunState::Launching);
    assert!(!d.join("report").exists());
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn a_launch_whose_answer_was_lost_and_is_adopted_by_retry_can_still_report_with_its_first_token() {
    let d = dir("retry");
    let rig = ready_with(reporting(&d)).await;
    rig.cli.with(|s| s.outcome = Outcome::Garbled);
    let run = queued_reporting(&rig, 1).await;
    rig.svc.launch(&run.id).await.unwrap();
    assert_eq!(rig.get(&run).await.state, RunState::Failed, "the launch failed while its session started");
    let token = token_in(&first_launch(&rig).report.unwrap().config);

    let adopted = rig.svc.retry_launch(&run.id).await.unwrap();
    assert_eq!((adopted.state, rig.cli.launches()), (RunState::Launching, 1), "the session is adopted, not launched again");
    assert_eq!(report_as(&rig, &run, &token, "Reported by the adopted session.").await, Reply::Recorded { revision: 1, notes: vec![] });
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn a_failed_launch_that_started_nothing_is_launched_again_with_a_new_token_and_both_stay_valid() {
    let d = dir("again");
    let rig = ready_with(reporting(&d)).await;
    rig.cli.with(|s| s.outcome = Outcome::Exits);
    let run = queued_reporting(&rig, 1).await;
    rig.svc.launch(&run.id).await.unwrap();
    let first = token_in(&first_launch(&rig).report.unwrap().config);
    assert_eq!(rig.get(&run).await.state, RunState::Failed);

    rig.cli.with(|s| s.outcome = Outcome::Starts);
    rig.svc.retry_launch(&run.id).await.unwrap();
    let second = token_in(&rig.cli.0.lock().unwrap().launches[1].report.clone().unwrap().config);
    assert_ne!(first, second);
    assert_eq!(report_as(&rig, &run, &first, "From a session that started with the first token.").await, Reply::Recorded { revision: 1, notes: vec![] });
    assert_eq!(report_as(&rig, &run, &second, "From the second.").await, Reply::Recorded { revision: 2, notes: vec![] });
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn a_launch_error_that_echoes_a_token_never_puts_it_in_the_stored_failure() {
    let d = dir("redact");
    let rig = ready_with(reporting(&d)).await;
    let run = queued_reporting(&rig, 1).await;
    rig.cli.with(|s| s.outcome = Outcome::Leaks);
    rig.svc.launch(&run.id).await.unwrap();
    let failed = rig.get(&run).await;
    let error = failed.error.as_deref().unwrap();
    assert_eq!(failed.state, RunState::Failed);
    assert!(error.contains("bad --mcp-config") && !error.contains("0123456789abcdef"), "{error}");
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn cleaning_up_a_run_ends_its_tokens_and_removes_its_config() {
    let d = dir("cleanup");
    let rig = ready_with(reporting(&d)).await;
    let run = rig.launched_reporting(1, RunKind::Investigate).await;
    let config = first_launch(&rig).report.unwrap().config;
    let token = token_in(&config);
    rig.set(&run, |r| {
        r.state = RunState::Done;
        r.ended_at = Some(chrono::Utc::now());
    })
    .await;
    assert_eq!(report_as(&rig, &run, &token, "n").await, Reply::Unavailable, "a finished run is closed to the tool at once");

    rig.svc.cleanup(&run.id).await.unwrap();
    assert!(!config.exists());
    rig.set(&run, |r| r.state = RunState::Working).await;
    assert_eq!(report_as(&rig, &run, &token, "n").await, Reply::Unavailable, "and with its worktree gone even a reopened run has no token");
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn the_sweep_keeps_what_a_live_or_recently_finished_run_may_still_need_and_removes_the_rest() {
    let d = dir("sweep");
    let rig = ready_with(reporting(&d)).await;
    let live = rig.launched_reporting(1, RunKind::Investigate).await;
    let recent = rig.launched_reporting(2, RunKind::Investigate).await;
    let old = rig.launched_reporting(3, RunKind::Investigate).await;
    let failed = rig.launched_reporting(4, RunKind::Investigate).await;
    let channel = rig.svc.report.clone().unwrap();
    channel.write_config("run-with-no-row", "gsr_0").unwrap();
    let now = chrono::Utc::now();
    rig.set(&recent, |r| (r.state, r.ended_at) = (RunState::Done, Some(now))).await;
    rig.set(&old, |r| (r.state, r.ended_at) = (RunState::Done, Some(now - chrono::Duration::hours(7)))).await;
    rig.set(&failed, |r| (r.state, r.ended_at) = (RunState::Failed, Some(now))).await;

    rig.svc.sweep_report_files().await;
    let mut kept = channel.configured();
    kept.sort();
    let mut expected = vec![live.id.clone(), recent.id.clone()];
    expected.sort();
    assert_eq!(kept, expected);
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn answering_a_question_makes_the_report_made_before_it_stale() {
    let d = dir("answer");
    let rig = ready_with(reporting(&d)).await;
    let run = rig.launched_reporting(1, RunKind::Investigate).await;
    let token = token_in(&first_launch(&rig).report.unwrap().config);
    rig.poll().await;
    assert_eq!(report_as(&rig, &run, &token, "Early.").await, Reply::Recorded { revision: 1, notes: vec![] });
    rig.job(run.short_id.as_ref().unwrap(), |j| j.suggested_reply = None);
    rig.session(&run, |e| {
        e.state = Some("blocked".into());
        e.pid = None;
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::NeedsAnswer);
    std::fs::create_dir_all(&run.expected_worktree).unwrap();
    rig.svc.answer(&run.id, "Yes, go on.").await.unwrap();

    assert!(rig.fx.core.report_stored(&run.id).await.unwrap().unwrap().stale);
    let outcome = rig.fx.core.run_outcome(&run.id).await.unwrap();
    assert_ne!(outcome.source, Some(crate::runs::report::ResultSource::Structured));
    assert_eq!(report_as(&rig, &run, &token, "After the answer.").await, Reply::Recorded { revision: 2, notes: vec![] }, "the woken session can report again");
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn a_run_that_finishes_after_reporting_drafts_from_the_report_on_the_same_poll() {
    let d = dir("finish");
    let rig = ready_with(reporting(&d)).await;
    let run = rig.launched_reporting(1, RunKind::Investigate).await;
    let token = token_in(&first_launch(&rig).report.unwrap().config);
    rig.poll().await;
    assert_eq!(report_as(&rig, &run, &token, "Reported: close as a duplicate.").await, Reply::Recorded { revision: 1, notes: vec![] });
    let id = run.short_id.clone().unwrap();
    rig.job(&id, |j| j.result = Some("One-line summary.".into()));
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = Some("idle".into());
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done, "the report is not what ends a run");
    let drafts = rig.fx.core.proposals(&crate::domain::ProposalQuery::default()).await.unwrap();
    let comment = drafts.iter().find(|p| matches!(p.intent, crate::domain::Intent::Comment { .. })).expect("a comment draft");
    let text = match &comment.intent {
        crate::domain::Intent::Comment { body, .. } => body.plain_text(),
        other => panic!("{other:?}"),
    };
    assert!(text.ends_with("Reported: close as a duplicate."), "{text}");
    assert_eq!(report_as(&rig, &run, &token, "Too late.").await, Reply::Unavailable);
    let _ = std::fs::remove_dir_all(&d);
}

#[tokio::test]
async fn a_finished_run_carried_on_in_terminal_no_longer_stands_behind_its_earlier_report() {
    let d = dir("carried");
    let rig = ready_with(reporting(&d)).await;
    let run = rig.launched_reporting(1, RunKind::Investigate).await;
    let token = token_in(&first_launch(&rig).report.unwrap().config);
    rig.poll().await;
    report_as(&rig, &run, &token, "First turn.").await;
    rig.cli.with(|s| {
        s.answers.insert("b0000001-0000-4000-8000-000000000000".into(), "Done.\n\nFor Jira: written.".into());
    });
    rig.job(run.short_id.as_ref().unwrap(), |j| j.result = Some("One line.".into()));
    rig.session(&run, |e| {
        e.state = Some("done".into());
        e.status = Some("idle".into());
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Done);
    assert!(!rig.fx.core.report_stored(&run.id).await.unwrap().unwrap().stale);

    rig.session(&run, |e| {
        e.state = Some("working".into());
        e.status = Some("busy".into());
        e.pid = Some(4242);
    });
    rig.poll().await;
    assert_eq!(rig.get(&run).await.state, RunState::Working);
    assert!(rig.fx.core.report_stored(&run.id).await.unwrap().unwrap().stale);
    let _ = std::fs::remove_dir_all(&d);
}
