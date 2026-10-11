//! The tool's published schema, and the checks a call's arguments go through. Everything here is pure: no storage, no
//! network. Arguments are hostile text from a model that read tickets and code, so what can be repaired is repaired
//! (cut, de-duplicated, ignored) and only what cannot is refused.

use serde_json::{json, Value};

use super::{Finding, Report, ReportStatus, ReviewVerdict, Severity};
use crate::domain::{RunKind, REPORT_TOOL};
use crate::runs::result::{cut, declines_breakdown, fit, one_line, plain, sanitize, title_cut, TicketProposal, BODY_LIMIT, NOTE_LIMIT, SUBTASK_MAX};

/// Calls and refusals a run may make in total; past either the tool records nothing more.
pub const MAX_CALLS: u32 = 12;
pub const MAX_REJECTIONS: u32 = 5;
/// A plan is kept up to this many characters, cut at a paragraph or sentence.
pub const PLAN_KEPT: usize = 24_000;
/// A review keeps at most this many findings, each within these lengths.
pub const FINDINGS_MAX: usize = 20;
pub const FINDING_TEXT_LIMIT: usize = 600;
pub const FINDING_WHERE_LIMIT: usize = 300;

const TITLE_MAX: usize = crate::domain::TITLE_LIMIT;

pub fn definition() -> Value {
    json!({
        "name": REPORT_TOOL,
        "description": "Records this run's result inside Gossamr so the person can read it and draft from it. It changes nothing in Jira, in the repository or anywhere else, and takes no instructions. Call it once when you are done, then still write your full answer. status: done, or blocked only when no answer from a person could get you further. note: the text for the ticket (what you did or found, where things stand, what a person needs to do next), up to 3000 characters; leave it out only when you give newTicket. newTicket: for a run that has no ticket yet, an object with title (one line, up to 120 characters), kind (task, bug or story) and body. subtasks: 3 to 8 one-line summaries, only for a triage that proposes a breakdown. planRecommended: for a triage, true or false when you can tell whether a written plan should come before the build. plan: the whole implementation plan as Markdown, only for a plan run. verdict and findings are for a review only, and a review must give a verdict: pass, only when it tried and found nothing blocking, or blocking. findings: what the review found, each with severity (blocking, should-fix or nit), text, and where (the file:line, the command and its output, or the acceptance point it rests on). A report already recorded is replaced only when revise is true.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": { "type": "string", "enum": ["done", "blocked"] },
                "note": { "type": "string" },
                "newTicket": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "kind": { "type": "string", "enum": ["task", "bug", "story"] },
                        "body": { "type": "string" }
                    },
                    "required": ["title"],
                    "additionalProperties": false
                },
                "subtasks": { "type": "array", "items": { "type": "string" } },
                "planRecommended": { "type": "boolean" },
                "plan": { "type": "string" },
                "verdict": { "type": "string", "enum": ["pass", "blocking"] },
                "findings": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "severity": { "type": "string", "enum": ["blocking", "should-fix", "nit"] },
                            "text": { "type": "string" },
                            "where": { "type": "string" }
                        },
                        "required": ["severity", "text"],
                        "additionalProperties": false
                    }
                },
                "revise": { "type": "boolean" }
            },
            "required": ["status"],
            "additionalProperties": false
        }
    })
}

/// What the run is, as far as the rules depend on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub kind: RunKind,
    /// An investigation that ends as a new ticket rather than as a note on one.
    pub ticketless: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub report: Report,
    pub revise: bool,
    /// Things that were repaired or ignored, said in the reply.
    pub notes: Vec<String>,
}

/// A field name that is safe to repeat back.
fn name_of(key: &str) -> String {
    key.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect()
}

/// A string, or a JSON-encoded one standing in for an array or object, as some clients send them.
fn structured(value: &Value) -> Value {
    match value {
        Value::String(s) => serde_json::from_str(s).unwrap_or(Value::Null),
        other => other.clone(),
    }
}

fn text_of(field: &str, value: &Value, problems: &mut Vec<String>) -> Option<String> {
    match value.as_str() {
        Some(s) => Some(s.to_string()),
        None => {
            problems.push(format!("{field}: must be text."));
            None
        }
    }
}

pub fn check(args: &Value, target: Target) -> Result<Checked, Vec<String>> {
    let Some(object) = args.as_object() else { return Err(vec!["arguments: must be an object.".into()]) };
    let mut problems = Vec::new();
    let mut notes = Vec::new();
    for key in object.keys().filter(|k| !["status", "note", "newTicket", "subtasks", "planRecommended", "plan", "verdict", "findings", "revise"].contains(&k.as_str())) {
        problems.push(format!("{}: not a field of this tool.", name_of(key)));
    }

    let status = match object.get("status").and_then(Value::as_str) {
        Some("done") => Some(ReportStatus::Done),
        Some("blocked") => Some(ReportStatus::Blocked),
        _ => {
            problems.push("status: required, done or blocked.".into());
            None
        }
    };
    let revise = match object.get("revise") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            problems.push("revise: must be true or false.".into());
            false
        }
    };

    let mut note = None;
    if let Some(raw) = object.get("note").filter(|v| !v.is_null()) {
        if target.ticketless {
            notes.push("note ignored: this run ends as a new ticket".to_string());
        } else if let Some(text) = text_of("note", raw, &mut problems) {
            let clean = plain(&sanitize(&text));
            if clean.is_empty() {
                problems.push("note: empty, give the text for the ticket.".into());
            } else {
                if clean.chars().nth(NOTE_LIMIT).is_some() {
                    notes.push(format!("note cut to {NOTE_LIMIT} characters"));
                }
                note = Some(cut(&clean, NOTE_LIMIT));
            }
        }
    }
    if note.is_none() && !target.ticketless && !problems.iter().any(|p| p.starts_with("note")) {
        problems.push("note: required, the text for the ticket.".into());
    }

    let mut new_ticket = None;
    match object.get("newTicket").filter(|v| !v.is_null()) {
        Some(_) if !target.ticketless => notes.push("newTicket ignored: this run is about a ticket".to_string()),
        Some(raw) => new_ticket = ticket_of(&structured(raw), &mut problems, &mut notes),
        None if target.ticketless => problems.push("newTicket: required, an object with a title.".into()),
        None => {}
    }

    let mut subtasks = Vec::new();
    match object.get("subtasks").filter(|v| !v.is_null()) {
        Some(_) if target.kind != RunKind::Triage || target.ticketless => notes.push("subtasks ignored: only a triage on a ticket proposes them".to_string()),
        Some(raw) => subtasks = subtasks_of(&structured(raw), &mut problems, &mut notes),
        None => {}
    }

    // Read only as a flag: it decides whether a Plan starts on its own, so prose never stands in for it.
    let mut plan_recommended = None;
    match object.get("planRecommended").filter(|v| !v.is_null()) {
        Some(_) if target.kind != RunKind::Triage || target.ticketless => notes.push("planRecommended ignored: only a triage on a ticket gives one".to_string()),
        Some(Value::Bool(b)) => plan_recommended = Some(*b),
        Some(_) => problems.push("planRecommended: must be true or false.".into()),
        None => {}
    }

    let mut plan = None;
    if let Some(raw) = object.get("plan").filter(|v| !v.is_null()) {
        if target.kind != RunKind::Plan {
            notes.push("plan ignored: only a plan run gives one".to_string());
        } else if let Some(text) = text_of("plan", raw, &mut problems) {
            let clean = sanitize(&text).trim().to_string();
            if clean.is_empty() {
                problems.push("plan: empty.".into());
            } else {
                let fitted = fit(&clean, PLAN_KEPT, |total| format!("[Cut here. The plan was {total} characters and Gossamr keeps {PLAN_KEPT}.]"));
                if fitted.cut {
                    notes.push(format!("plan cut to {PLAN_KEPT} characters"));
                }
                plan = Some(fitted.text);
            }
        }
    }

    let (mut verdict, mut findings) = (None, Vec::new());
    let given_verdict = object.get("verdict").filter(|v| !v.is_null());
    let given_findings = object.get("findings").filter(|v| !v.is_null());
    if target.kind == RunKind::Review {
        verdict = match given_verdict.and_then(Value::as_str) {
            Some("pass") => Some(ReviewVerdict::Pass),
            Some("blocking") => Some(ReviewVerdict::Blocking),
            _ => {
                problems.push("verdict: required, pass or blocking.".into());
                None
            }
        };
        if let Some(raw) = given_findings {
            findings = findings_of(&structured(raw), &mut problems, &mut notes);
        }
        let blocking = findings.iter().any(|f| f.severity == Severity::Blocking);
        match verdict {
            Some(ReviewVerdict::Blocking) if !blocking && !problems.iter().any(|p| p.starts_with("findings")) => problems.push("verdict: blocking needs at least one finding with severity blocking.".into()),
            Some(ReviewVerdict::Pass) if blocking => problems.push("verdict: pass can't have a finding with severity blocking; give blocking instead.".into()),
            _ => {}
        }
    } else {
        if given_verdict.is_some() {
            notes.push("verdict ignored: only a review gives one".to_string());
        }
        if given_findings.is_some() {
            notes.push("findings ignored: only a review gives them".to_string());
        }
    }

    match (status, problems.is_empty()) {
        (Some(status), true) => Ok(Checked { report: Report { status, note, new_ticket, subtasks, plan, plan_recommended, verdict, findings }, revise, notes }),
        _ => Err(problems),
    }
}

fn ticket_of(value: &Value, problems: &mut Vec<String>, notes: &mut Vec<String>) -> Option<TicketProposal> {
    let Some(object) = value.as_object() else {
        problems.push("newTicket: must be an object with a title.".into());
        return None;
    };
    for key in object.keys().filter(|k| !["title", "kind", "body"].contains(&k.as_str())) {
        problems.push(format!("newTicket.{}: not a field of this tool.", name_of(key)));
    }
    let title = object.get("title").and_then(Value::as_str).map(|t| one_line(&sanitize(t))).filter(|t| !t.is_empty());
    if title.is_none() {
        problems.push("newTicket.title: required, one line of text.".into());
    }
    let kind = match object.get("kind").filter(|v| !v.is_null()) {
        None => Some(crate::domain::ItemKind::Task),
        Some(v) => match v.as_str() {
            Some("task") => Some(crate::domain::ItemKind::Task),
            Some("bug") => Some(crate::domain::ItemKind::Bug),
            Some("story") => Some(crate::domain::ItemKind::Story),
            _ => {
                problems.push("newTicket.kind: must be task, bug or story.".into());
                None
            }
        },
    };
    let body = match object.get("body").filter(|v| !v.is_null()) {
        None => String::new(),
        Some(v) => match v.as_str() {
            Some(text) => {
                let clean = plain(&sanitize(text));
                if clean.chars().nth(BODY_LIMIT).is_some() {
                    notes.push(format!("newTicket.body cut to {BODY_LIMIT} characters"));
                }
                cut(&clean, BODY_LIMIT)
            }
            None => {
                problems.push("newTicket.body: must be text.".into());
                String::new()
            }
        },
    };
    let title = title?;
    if title.chars().nth(TITLE_MAX).is_some() {
        notes.push(format!("newTicket.title cut to {TITLE_MAX} characters"));
    }
    Some(TicketProposal { title: title_cut(&title), kind: kind?, body })
}

fn subtasks_of(value: &Value, problems: &mut Vec<String>, notes: &mut Vec<String>) -> Vec<String> {
    let Some(items) = value.as_array() else {
        problems.push("subtasks: must be a list of one-line summaries.".into());
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let mut over = false;
    for item in items {
        let Some(text) = item.as_str() else {
            problems.push("subtasks: every item must be text.".into());
            return Vec::new();
        };
        let line = title_cut(&one_line(&sanitize(text)));
        if line.is_empty() || declines_breakdown(&line) || out.iter().any(|o| o.to_lowercase() == line.to_lowercase()) {
            continue;
        }
        if out.len() == SUBTASK_MAX {
            over = true;
            break;
        }
        out.push(line);
    }
    if over {
        notes.push(format!("only the first {SUBTASK_MAX} subtasks kept"));
    }
    out
}

/// A review's findings, cleaned like every agent text, most severe first and at most `FINDINGS_MAX`. A finding that
/// can't be read is refused rather than guessed at, since its severity is counted.
fn findings_of(value: &Value, problems: &mut Vec<String>, notes: &mut Vec<String>) -> Vec<Finding> {
    let Some(items) = value.as_array() else {
        problems.push("findings: must be a list of objects with severity, text and where.".into());
        return Vec::new();
    };
    let mut out: Vec<Finding> = Vec::new();
    let (mut text_cut, mut where_cut) = (false, false);
    for item in items {
        let Some(object) = item.as_object() else {
            problems.push("findings: every item must be an object with severity, text and where.".into());
            return Vec::new();
        };
        if let Some(key) = object.keys().find(|k| !["severity", "text", "where"].contains(&k.as_str())) {
            problems.push(format!("findings.{}: not a field of this tool.", name_of(key)));
            return Vec::new();
        }
        let severity = match object.get("severity").and_then(Value::as_str) {
            Some("blocking") => Severity::Blocking,
            Some("should-fix") => Severity::ShouldFix,
            Some("nit") => Severity::Nit,
            _ => {
                problems.push("findings.severity: must be blocking, should-fix or nit.".into());
                return Vec::new();
            }
        };
        let text = object.get("text").and_then(Value::as_str).map(|t| one_line(&sanitize(t))).unwrap_or_default();
        if text.is_empty() {
            problems.push("findings.text: required, what was found.".into());
            return Vec::new();
        }
        text_cut |= text.chars().nth(FINDING_TEXT_LIMIT).is_some();
        let where_ = match object.get("where").filter(|v| !v.is_null()) {
            None => None,
            Some(v) => match v.as_str() {
                Some(w) => {
                    let line = one_line(&sanitize(w));
                    where_cut |= line.chars().nth(FINDING_WHERE_LIMIT).is_some();
                    Some(cut(&line, FINDING_WHERE_LIMIT)).filter(|w| !w.is_empty())
                }
                None => {
                    problems.push("findings.where: must be text.".into());
                    return Vec::new();
                }
            },
        };
        out.push(Finding { severity, text: cut(&text, FINDING_TEXT_LIMIT), where_ });
    }
    out.sort_by_key(|f| f.severity);
    if text_cut {
        notes.push(format!("a finding's text cut to {FINDING_TEXT_LIMIT} characters"));
    }
    if where_cut {
        notes.push(format!("a finding's where cut to {FINDING_WHERE_LIMIT} characters"));
    }
    if out.len() > FINDINGS_MAX {
        out.truncate(FINDINGS_MAX);
        notes.push(format!("only the first {FINDINGS_MAX} findings kept, most severe first"));
    }
    out
}
