use super::{ReportStatus, ResultSource, StoredReport};
use crate::domain::Run;
use crate::runs::result::sanitize;

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub source: Option<ResultSource>,
    pub note: Option<String>,
    pub status: Option<ReportStatus>,
}

impl Resolved {
    pub fn complete(&self) -> bool {
        matches!(self.source, Some(ResultSource::Structured | ResultSource::Whole))
    }
}

pub fn resolve(run: &Run, stored: Option<&StoredReport>) -> Resolved {
    if let Some(report) = stored.and_then(StoredReport::current) {
        if let Some(note) = report.note.as_deref().map(sanitize).filter(|note| !note.trim().is_empty()) {
            return Resolved { source: Some(ResultSource::Structured), note: Some(note), status: Some(report.status) };
        }
    }
    let note = run.result.as_deref().map(sanitize).filter(|note| !note.trim().is_empty());
    Resolved {
        source: note.as_ref().map(|_| if run.result_complete { ResultSource::Whole } else { ResultSource::SummaryOnly }),
        note,
        status: None,
    }
}
