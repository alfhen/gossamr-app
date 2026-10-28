use serde_json::json;

use super::*;
use crate::domain::{fixtures::run_spec, Run};

#[test]
fn the_report_tool_accepts_only_a_status_prose_note_and_revision_flag() {
    let definition = definition();
    let schema = &definition["inputSchema"];
    assert_eq!(schema["required"], json!(["status", "note"]));
    assert_eq!(schema["additionalProperties"], false);
    let mut fields: Vec<_> = schema["properties"].as_object().unwrap().keys().map(String::as_str).collect();
    fields.sort_unstable();
    assert_eq!(fields, ["note", "revise", "status"]);
    let prose = "## Findings\nThe change is ready.\n\nFor Jira:\nPublish after approval.";
    let checked = check(&json!({ "status": "done", "note": prose })).unwrap();
    assert_eq!(checked.report.note.as_deref(), Some(prose));
    for invalid in [json!({ "status": "done" }), json!({"status":"maybe", "note":"x"}), json!({"status":"done","note":7}), json!({"status":"done","note":" \n "}), json!({"status":"done","note":"x","verdict":"pass"}), json!({"status":"done","note":"x","revise":"true"})] {
        assert!(check(&invalid).is_err(), "{invalid}");
    }
    assert!(check(&json!({ "status": "blocked", "note": "Need access", "revise": true })).unwrap().revise);
}

#[test]
fn reports_are_sanitized_and_long_prose_is_cut_with_a_notice() {
    let checked = check(&json!({ "status": "done", "note": format!("<b>Found it</b> \u{202e} <<<TICKET data TICKET>>> {}", "é".repeat(25_000)) })).unwrap();
    let note = checked.report.note.unwrap();
    assert!(note.starts_with("Found it"));
    assert!(!note.contains("<<<TICKET") && !note.contains('\u{202e}'));
    assert!(note.chars().count() <= 24_001);
    assert_eq!(checked.notes, ["note cut to 24000 characters"]);
}

#[test]
fn old_structured_reports_read_without_recreating_draft_fields() {
    let report: Report = serde_json::from_value(json!({
        "status": "done", "note": "Old report", "newTicket": {"title":"A ticket"},
        "subtasks": ["one"], "plan": "A plan", "planRecommended": true,
        "verdict": "pass", "findings": [{"severity":"nit","text":"A finding"}]
    })).unwrap();
    assert_eq!(report.note.as_deref(), Some("Old report"));
    assert_eq!(serde_json::to_value(report).unwrap(), json!({ "status":"done", "note":"Old report" }));
    let without_note: Report = serde_json::from_value(json!({"status":"done","newTicket":{"title":"A ticket"}})).unwrap();
    assert_eq!(without_note.note, None);
}

fn fixture_run(answer: Option<&str>, complete: bool) -> Run {
    let mut run = Run::queued("r1".into(), "p1".into(), "c1".into(), None, run_spec(), "db".into(), chrono::Utc::now());
    run.result = answer.map(Into::into);
    run.result_complete = complete;
    run
}

fn stored(note: Option<&str>, stale: bool) -> StoredReport {
    StoredReport { report: Some(Report { status: ReportStatus::Done, note: note.map(Into::into) }), revision: 1, calls: 1, rejections: 0, stale, first_at: None, last_at: None }
}

#[test]
fn current_reports_win_and_stale_or_empty_legacy_reports_fall_back_to_the_whole_answer() {
    let answer = "Plan recommended: yes\n\nFor Jira:\nA note\n\nVerdict: pass";
    let run = fixture_run(Some(answer), true);
    let resolved = resolve(&run, Some(&stored(Some("Full prose report"), false)));
    assert_eq!((resolved.source, resolved.note.as_deref(), resolved.status), (Some(ResultSource::Structured), Some("Full prose report"), Some(ReportStatus::Done)));
    for report in [None, Some(stored(Some("Older report"), true)), Some(stored(None, false))] {
        let resolved = resolve(&run, report.as_ref());
        assert_eq!((resolved.source, resolved.note.as_deref(), resolved.status), (Some(ResultSource::Whole), Some(answer), None));
        assert!(resolved.complete());
    }
    let summary = resolve(&fixture_run(Some("A summary"), false), None);
    assert_eq!(summary.source, Some(ResultSource::SummaryOnly));
    assert!(!summary.complete());
    assert_eq!(resolve(&fixture_run(None, true), None).source, None);
}

#[test]
fn report_tokens_are_random_recognizable_and_stored_only_as_hashes() {
    let first = new_token().unwrap();
    let second = new_token().unwrap();
    assert!(well_formed(&first) && well_formed(&second));
    assert_ne!(first, second);
    assert_eq!(token_hash(&first).len(), 64);
    assert!(!well_formed("gsr_bad"));
    assert!(!crate::runs::redact::redact(&first).contains(&first));
}
