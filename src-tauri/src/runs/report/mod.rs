//! The run-report channel: a tool an agent calls to hand Gossamr its result as data, instead of Gossamr reading prose.
//!
//! A call only ever produces a validated, sanitised `Report` stored on the run. It writes nothing to Jira, to the
//! repository or to any other run, and drafts are made from a stored report exactly as they are from the written answer.

mod resolve;
mod server;
mod tool;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use resolve::{resolve, Resolved};
pub use server::{config_dir, ReportChannel, ReportLaunch, ReportServer, ReportSink};
pub use tool::{check, definition, Target, FINDINGS_MAX, FINDING_TEXT_LIMIT, MAX_CALLS, MAX_REJECTIONS};

use super::result::TicketProposal;

/// What an agent says about how its run ended. It never changes the run's state: the session listing decides that.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportStatus {
    Done,
    Blocked,
}

/// A validated report. Every string in it has been through `result::sanitize`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub status: ReportStatus,
    /// The text for the ticket; absent for a run that proposes a new ticket instead.
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub new_ticket: Option<TicketProposal>,
    #[serde(default)]
    pub subtasks: Vec<String>,
    #[serde(default)]
    pub plan: Option<String>,
    /// For a Triage on a ticket: whether it recommends a written plan before anyone builds. A report stored before
    /// triages gave one reads as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_recommended: Option<bool>,
    /// For a Review: whether it found the change ready. A report stored before reviews gave one reads as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<ReviewVerdict>,
    /// For a Review: what it found, most severe first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<Finding>,
}

/// A review's conclusion. `Blocking` means it found at least one finding that has to be fixed before the change is ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewVerdict {
    Pass,
    Blocking,
}

/// How much a review finding matters, most severe first so a sort puts blocking ones on top.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Blocking,
    ShouldFix,
    Nit,
}

impl Severity {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().replace([' ', '_'], "-").as_str() {
            "blocking" | "blocker" => Some(Severity::Blocking),
            "should-fix" | "shouldfix" => Some(Severity::ShouldFix),
            "nit" => Some(Severity::Nit),
            _ => None,
        }
    }
}

/// One thing a review found, and what it rests on. The text is the agent's and only ever shown; only the severity is
/// counted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    pub text: String,
    /// The file and line, the command and its output, or the acceptance point the finding rests on.
    #[serde(default, rename = "where")]
    pub where_: Option<String>,
}

/// A run's stored report with how it came about.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredReport {
    pub report: Option<Report>,
    pub revision: u32,
    pub calls: u32,
    pub rejections: u32,
    /// The person answered or carried on after the report was made, so what it says may be out of date.
    pub stale: bool,
    pub first_at: Option<DateTime<Utc>>,
    pub last_at: Option<DateTime<Utc>>,
}

impl StoredReport {
    /// The report a run's drafts and sheet may rely on.
    pub fn current(&self) -> Option<&Report> {
        self.report.as_ref().filter(|_| !self.stale)
    }
}

/// How the result a run shows was read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSource {
    /// The agent reported it through the tool.
    Structured,
    /// Read from the `For Jira:` section of the written answer.
    Section,
    /// The agent marked no section, so this is its whole answer, shortened.
    Whole,
    /// Only Claude's one-line summary could be read.
    SummaryOnly,
}

/// What a call to the tool came to, as the agent is told and as it is counted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    Recorded { revision: u32, notes: Vec<String> },
    Unchanged,
    /// A report is already stored and the call did not say `revise`.
    Already,
    Invalid(Vec<String>),
    /// Too many calls or refusals for this run.
    Locked,
    /// Wrong token, wrong run, run over, other account, or an older tool version: never says which.
    Unavailable,
}

impl Reply {
    /// The tool result's text and whether it is an error.
    pub fn text(&self) -> (String, bool) {
        match self {
            Reply::Recorded { revision, notes } => {
                let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join("; ")) };
                (format!("Recorded (revision {revision}){notes}. Your written answer is still needed."), false)
            }
            Reply::Unchanged => ("Already recorded exactly as given. Your written answer is still needed.".into(), false),
            Reply::Already => ("A report is already recorded for this run. If it needs correcting, call report_result again with revise set to true.".into(), true),
            Reply::Invalid(problems) => {
                let mut lines: Vec<String> = problems.iter().take(8).cloned().collect();
                lines.push("Fix these and call report_result again. Nothing was saved.".into());
                (lines.join("\n"), true)
            }
            Reply::Locked => ("This run's report has been refused too often and is no longer being recorded. Finish with your written answer.".into(), true),
            Reply::Unavailable => (UNAVAILABLE.into(), true),
        }
    }
}

pub const UNAVAILABLE: &str = "The report can't be recorded now. Finish with your written answer.";

/// A random token that Gossamr recognises by its prefix wherever it shows up (`runs::redact` masks it).
pub fn new_token() -> std::result::Result<String, getrandom::Error> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)?;
    Ok(format!("gsr_{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

pub fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `token` has the shape `new_token` makes.
pub fn well_formed(token: &str) -> bool {
    token.len() == 52 && token.strip_prefix("gsr_").is_some_and(|rest| rest.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests;
