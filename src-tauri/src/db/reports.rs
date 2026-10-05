//! Reports an agent made through the run-report tool, and the tokens minted for its runs.

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

use super::{stamp, Db};
use crate::domain::{Run, REPORT_TOOL_VERSION};
use crate::error::Result;
use crate::runs::report::{check, Reply, StoredReport, Target, MAX_CALLS, MAX_REJECTIONS};

/// A call is accepted while the run is in one of these states. `done`, `failed` and `stopped` are over; a stopped run
/// that is being woken with an answer is `working` again by the time its agent can call.
const OPEN: [&str; 6] = ["launching", "working", "needsAnswer", "needsPermission", "systemBlocked", "unknown"];

fn parsed(at: Option<String>) -> Option<DateTime<Utc>> {
    at.and_then(|a| DateTime::parse_from_rfc3339(&a).ok()).map(|d| d.with_timezone(&Utc))
}

fn row_of(tx: &Transaction, run_id: &str) -> Result<Option<StoredReport>> {
    let row = tx
        .query_row("SELECT report, revision, calls, rejections, stale, first_at, last_at FROM run_reports WHERE run_id = ?1", params![run_id], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, u32>(1)?, r.get::<_, u32>(2)?, r.get::<_, u32>(3)?, r.get::<_, i64>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?))
        })
        .optional()?;
    Ok(row.map(|(report, revision, calls, rejections, stale, first_at, last_at)| StoredReport {
        // A stored report that no longer parses reads as none, as a run blob that does not does elsewhere.
        report: report.and_then(|r| serde_json::from_str(&r).ok()),
        revision,
        calls,
        rejections,
        stale: stale != 0,
        first_at: parsed(first_at),
        last_at: parsed(last_at),
    }))
}

fn save(tx: &Transaction, run_id: &str, row: &StoredReport) -> Result<()> {
    let report = row.report.as_ref().map(serde_json::to_string).transpose()?;
    tx.execute(
        "INSERT INTO run_reports (run_id, report, revision, calls, rejections, stale, first_at, last_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(run_id) DO UPDATE SET report = ?2, revision = ?3, calls = ?4, rejections = ?5, stale = ?6, first_at = ?7, last_at = ?8",
        params![run_id, report, row.revision, row.calls, row.rejections, i64::from(row.stale), row.first_at.map(stamp), row.last_at.map(stamp)],
    )?;
    Ok(())
}

impl Db {
    /// Records that a run was offered the tool with this token. Never replaces an earlier token of the run: a launch whose
    /// answer was lost, and then adopted, still holds the one it started with.
    pub fn reserve_report_token(&self, run_id: &str, token_hash: &str, tool_version: u32, now: DateTime<Utc>) -> Result<()> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        tx.execute("INSERT OR IGNORE INTO run_report_tokens (token_hash, run_id, tool_version, minted_at) VALUES (?1, ?2, ?3, ?4)", params![token_hash, run_id, tool_version, stamp(now)])?;
        tx.execute("INSERT OR IGNORE INTO run_reports (run_id) VALUES (?1)", params![run_id])?;
        tx.commit()?;
        Ok(())
    }

    /// The run's report row, or `None` when the run was never offered the tool.
    pub fn report(&self, run_id: &str) -> Result<Option<StoredReport>> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Deferred)?;
        row_of(&tx, run_id)
    }

    /// The person answered or carried on, so a report made before that no longer stands for the run.
    pub fn mark_report_stale(&self, run_id: &str) -> Result<()> {
        self.conn.execute("UPDATE run_reports SET stale = 1 WHERE run_id = ?1 AND report IS NOT NULL", params![run_id])?;
        Ok(())
    }

    /// Drops the run's tokens, for a run whose worktree and session are gone.
    pub fn forget_report_tokens(&self, run_id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM run_report_tokens WHERE run_id = ?1", params![run_id])?;
        Ok(())
    }

    /// Everything a call to the tool does, in one write transaction: the token and the run's state are looked at in the
    /// same transaction that stores the report, so a call checked while the run was open can't land after it ended.
    pub fn record_report(&self, run_id: &str, token_hash: &str, args: &Value, now: DateTime<Utc>) -> Result<Reply> {
        let tx = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)?;
        let version: Option<u32> = tx.query_row("SELECT tool_version FROM run_report_tokens WHERE token_hash = ?1 AND run_id = ?2", params![token_hash, run_id], |r| r.get(0)).optional()?;
        if version != Some(REPORT_TOOL_VERSION) {
            return Ok(Reply::Unavailable);
        }
        let stored: Option<(String, String)> = tx.query_row("SELECT state, data FROM runs WHERE id = ?1", params![run_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((_, data)) = stored.filter(|(state, _)| OPEN.contains(&state.as_str())) else { return Ok(Reply::Unavailable) };
        let Ok(run) = serde_json::from_str::<Run>(&data) else { return Ok(Reply::Unavailable) };
        let target = Target { kind: run.spec.kind, ticketless: run.spec.ends_as_ticket() };

        let mut row = row_of(&tx, run_id)?.unwrap_or(StoredReport { report: None, revision: 0, calls: 0, rejections: 0, stale: false, first_at: None, last_at: None });
        if row.calls >= MAX_CALLS || row.rejections >= MAX_REJECTIONS {
            return Ok(Reply::Locked);
        }
        row.calls += 1;
        let reply = match check(args, target) {
            Err(problems) => {
                row.rejections += 1;
                Reply::Invalid(problems)
            }
            Ok(checked) => match row.report.as_ref().filter(|_| !row.stale) {
                Some(existing) if *existing == checked.report => Reply::Unchanged,
                Some(_) if !checked.revise => Reply::Already,
                _ => {
                    row.revision += 1;
                    row.stale = false;
                    row.first_at.get_or_insert(now);
                    row.last_at = Some(now);
                    let revision = row.revision;
                    row.report = Some(checked.report);
                    Reply::Recorded { revision, notes: checked.notes }
                }
            },
        };
        save(&tx, run_id, &row)?;
        tx.commit()?;
        Ok(reply)
    }
}
