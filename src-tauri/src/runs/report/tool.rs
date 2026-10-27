use serde_json::{json, Value};

use super::{Report, ReportStatus};
use crate::domain::REPORT_TOOL;
use crate::runs::result::{cut, sanitize};

pub const MAX_CALLS: u32 = 12;
pub const MAX_REJECTIONS: u32 = 5;
const REPORT_LIMIT: usize = 24_000;

pub fn definition() -> Value {
    json!({
        "name": REPORT_TOOL,
        "description": "Records this run's prose report inside Gossamr so Pip and the person can read it. It changes nothing in Jira, GitHub or the repository. Call it once when you are done, then still write your full answer.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": { "type": "string", "enum": ["done", "blocked"] },
                "note": { "type": "string", "description": "Your full prose report: what you did or found, evidence, and what should happen next. Up to 24000 characters." },
                "revise": { "type": "boolean", "description": "True to replace a report already recorded." }
            },
            "required": ["status", "note"],
            "additionalProperties": false
        }
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub report: Report,
    pub revise: bool,
    pub notes: Vec<String>,
}

pub fn check(args: &Value) -> Result<Checked, Vec<String>> {
    let Some(object) = args.as_object() else { return Err(vec!["arguments: must be an object.".into()]) };
    let mut problems = Vec::new();
    for key in object.keys().filter(|key| !["status", "note", "revise"].contains(&key.as_str())) {
        let name: String = key.chars().filter(|letter| letter.is_ascii_alphanumeric() || *letter == '_').take(40).collect();
        problems.push(format!("{name}: not a field of this tool."));
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
        Some(Value::Bool(revise)) => *revise,
        Some(_) => {
            problems.push("revise: must be true or false.".into());
            false
        }
    };
    let note = object.get("note").and_then(Value::as_str).map(sanitize).map(|note| note.trim().to_string()).filter(|note| !note.is_empty());
    if note.is_none() {
        problems.push("note: required, your prose report.".into());
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let note = note.expect("checked note");
    let notes = if note.chars().count() > REPORT_LIMIT { vec![format!("note cut to {REPORT_LIMIT} characters")] } else { Vec::new() };
    Ok(Checked { report: Report { status: status.expect("checked status"), note: Some(cut(&note, REPORT_LIMIT)) }, revise, notes })
}
