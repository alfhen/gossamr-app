//! Which of a run's two results its drafts and sheet use: the report the agent made through the tool, else the written
//! answer as the parsers read it. One source per run, never a mixture, and the source is said wherever the result is.

use super::{Finding, Report, ReportStatus, ResultSource, ReviewVerdict, StoredReport};
use crate::domain::{Run, RunKind};
use crate::runs::result::{jira_note, plan_recommended, review_verdict, subtask_proposals, ticket_keys, ticket_proposal, JiraNote, TicketProposal};

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    /// `None` when the run has neither a report nor a written result.
    pub source: Option<ResultSource>,
    pub note: Option<JiraNote>,
    /// For a run with no ticket: the ticket it proposes.
    pub ticket: Option<TicketProposal>,
    /// For a Triage on a ticket: the breakdown it proposes.
    pub subtasks: Vec<String>,
    pub keys: Vec<String>,
    /// For a Plan run that reported its plan.
    pub plan: Option<String>,
    pub status: Option<ReportStatus>,
    /// For a Review: its verdict, from the report when that gave one, else from the `Verdict:` line of its whole written
    /// answer. Never from a one-line summary.
    pub verdict: Option<ReviewVerdict>,
    pub findings: Vec<Finding>,
    /// Whether `verdict` came from the report rather than the written answer.
    pub verdict_structured: bool,
    /// For a Triage on a ticket: whether it recommends a plan, from the report when that gave it, else from the
    /// `Plan recommended:` lines of its whole written answer (`plan_recommended`). Never from a one-line summary.
    pub plan_recommended: Option<bool>,
}

impl Resolved {
    /// The result is the agent's own whole account, not Claude's one-line summary of it.
    pub fn complete(&self) -> bool {
        matches!(self.source, Some(ResultSource::Structured | ResultSource::Section | ResultSource::Whole))
    }
}

fn keys_of(texts: &[&str], own: Option<&str>) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for key in texts.iter().flat_map(|t| ticket_keys(t)) {
        if Some(key.as_str()) != own && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

pub fn resolve(run: &Run, stored: Option<&StoredReport>) -> Resolved {
    let mut resolved = read(run, stored);
    if run.spec.kind == RunKind::Review {
        let reported = stored.and_then(StoredReport::current).and_then(|r| r.verdict.map(|v| (v, r.findings.clone())));
        let written = || run.result.as_deref().filter(|_| run.result_complete).and_then(review_verdict);
        resolved.verdict_structured = reported.is_some();
        if let Some((verdict, findings)) = reported.or_else(written) {
            (resolved.verdict, resolved.findings) = (Some(verdict), findings);
        }
    }
    if run.spec.kind == RunKind::Triage && run.item.is_some() {
        let reported = stored.and_then(StoredReport::current).and_then(|r| r.plan_recommended);
        let written = || run.result.as_deref().filter(|_| run.result_complete).and_then(plan_recommended);
        resolved.plan_recommended = reported.or_else(written);
    }
    resolved
}

fn read(run: &Run, stored: Option<&StoredReport>) -> Resolved {
    let own = run.item.as_ref().map(|i| i.key.to_uppercase());
    let result = run.result.as_deref().map(str::trim).filter(|r| !r.is_empty());
    let on_ticket = run.item.is_some();
    if let Some(report) = stored.and_then(StoredReport::current) {
        return structured(run, report, result, own.as_deref(), on_ticket);
    }
    Resolved {
        source: result.map(|_| match (run.result_complete, result.map(jira_note)) {
            (false, _) => ResultSource::SummaryOnly,
            (true, Some(note)) if note.from_marker => ResultSource::Section,
            _ => ResultSource::Whole,
        }),
        note: result.map(jira_note),
        ticket: result.filter(|_| !on_ticket).and_then(ticket_proposal),
        subtasks: result.filter(|_| run.spec.kind == RunKind::Triage && on_ticket).map(subtask_proposals).unwrap_or_default(),
        keys: result.map(|r| keys_of(&[r], own.as_deref())).unwrap_or_default(),
        plan: None,
        status: None,
        verdict: None,
        findings: Vec::new(),
        verdict_structured: false,
        plan_recommended: None,
    }
}

fn structured(run: &Run, report: &Report, result: Option<&str>, own: Option<&str>, on_ticket: bool) -> Resolved {
    let note = report.note.as_ref().map(|text| JiraNote { text: text.clone(), from_marker: true });
    let mut texts: Vec<&str> = result.into_iter().collect();
    texts.extend(report.note.as_deref());
    Resolved {
        source: Some(ResultSource::Structured),
        note,
        ticket: report.new_ticket.clone().filter(|_| !on_ticket),
        subtasks: if run.spec.kind == RunKind::Triage && on_ticket { report.subtasks.clone() } else { Vec::new() },
        keys: keys_of(&texts, own),
        plan: report.plan.clone(),
        status: Some(report.status),
        verdict: None,
        findings: Vec::new(),
        verdict_structured: false,
        plan_recommended: None,
    }
}
