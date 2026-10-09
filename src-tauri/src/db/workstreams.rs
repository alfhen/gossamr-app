//! Workstreams as stored: the whole value in `data`, with the columns lists narrow on kept in step with it, and their
//! audit, which is only ever appended to.

use chrono::{DateTime, Utc};
use rusqlite::{params, ErrorCode, OptionalExtension};

use super::{stamp, Db};
use crate::domain::{Actor, Workstream, WorkstreamEvent};
use crate::error::{Error, Result};

const DETAIL_LIMIT: usize = 2_048;

fn clash(e: rusqlite::Error) -> Error {
    match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::ConstraintViolation => {
            Error::Proposal("this ticket already has an open workstream".into())
        }
        _ => e.into(),
    }
}

fn parse_at(at: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(at).map(|d| d.with_timezone(&Utc)).unwrap_or_default()
}

impl Db {
    /// Stores a new workstream. Refused when its ticket already has an open one.
    pub fn insert_workstream(&self, ws: &Workstream) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO workstreams (id, connection_id, item_key, repo, title, mode, held_reason, created_at, closed_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    ws.id,
                    ws.connection_id,
                    ws.item_key,
                    ws.repo,
                    ws.title,
                    ws.mode.as_str(),
                    ws.held_reason,
                    stamp(ws.created_at),
                    ws.closed_at.map(stamp),
                    serde_json::to_string(ws)?,
                ],
            )
            .map_err(clash)?;
        Ok(())
    }

    /// Replaces a stored workstream. Its id, connection and ticket never change. Returns false when there is none.
    pub fn save_workstream(&self, ws: &Workstream) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE workstreams SET repo = ?2, title = ?3, mode = ?4, held_reason = ?5, closed_at = ?6, data = ?7 WHERE id = ?1",
                params![ws.id, ws.repo, ws.title, ws.mode.as_str(), ws.held_reason, ws.closed_at.map(stamp), serde_json::to_string(ws)?],
            )
            .map_err(clash)?;
        Ok(n > 0)
    }

    pub fn workstream(&self, id: &str) -> Result<Option<Workstream>> {
        let data: Option<String> = self.conn.query_row("SELECT data FROM workstreams WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// The connection's workstreams, newest first; closed ones only when asked for.
    pub fn workstreams(&self, connection_id: &str, include_closed: bool) -> Result<Vec<Workstream>> {
        let only_open = if include_closed { "" } else { " AND closed_at IS NULL" };
        let mut stmt = self.conn.prepare(&format!("SELECT data FROM workstreams WHERE connection_id = ?1{only_open} ORDER BY created_at DESC, id"))?;
        let rows = stmt.query_map(params![connection_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    /// The open workstream of a ticket, if it has one.
    pub fn open_workstream_for_item(&self, connection_id: &str, item_key: &str) -> Result<Option<Workstream>> {
        let data: Option<String> = self
            .conn
            .query_row(
                "SELECT data FROM workstreams WHERE connection_id = ?1 AND item_key = ?2 AND closed_at IS NULL",
                params![connection_id, item_key],
                |r| r.get(0),
            )
            .optional()?;
        Ok(data.map(|d| serde_json::from_str(&d)).transpose()?)
    }

    /// Whether `session_id` is the Pip session of an open workstream, which keeps it resumable however many other
    /// sessions Pip has started since.
    pub fn is_open_workstream_session(&self, session_id: &str) -> Result<bool> {
        let n: i64 = self.conn.query_row(
            "SELECT count(*) FROM workstreams WHERE closed_at IS NULL AND json_extract(data, '$.pipSession') = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// Appends one line to a workstream's audit after its last, numbering it itself, and returns it as stored. `detail`
    /// is cut to 2 KB. There is no way to change or remove a line once written.
    pub fn append_workstream_event(&self, event: &WorkstreamEvent) -> Result<WorkstreamEvent> {
        let tx = self.conn.unchecked_transaction()?;
        let last: Option<u32> =
            tx.query_row("SELECT max(seq) FROM workstream_events WHERE workstream_id = ?1", params![event.workstream_id], |r| r.get(0))?;
        let mut stored = event.clone();
        stored.seq = last.map_or(0, |n| n + 1);
        stored.detail = event.detail.as_deref().map(|d| d.chars().take(DETAIL_LIMIT).collect());
        tx.execute(
            "INSERT INTO workstream_events (workstream_id, seq, at, actor, action, run_id, proposal_id, digest, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                stored.workstream_id,
                stored.seq,
                stamp(stored.at),
                stored.actor.as_str(),
                stored.action,
                stored.run_id,
                stored.proposal_id,
                stored.digest,
                stored.detail
            ],
        )?;
        tx.commit()?;
        Ok(stored)
    }

    /// A workstream's audit, oldest first.
    pub fn workstream_events(&self, workstream_id: &str) -> Result<Vec<WorkstreamEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, at, actor, action, run_id, proposal_id, digest, detail FROM workstream_events WHERE workstream_id = ?1 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![workstream_id], |r| {
            Ok(WorkstreamEvent {
                workstream_id: workstream_id.to_string(),
                seq: r.get(0)?,
                at: parse_at(&r.get::<_, String>(1)?),
                // An actor this version doesn't know reads as the run, the one that claims least.
                actor: Actor::parse(&r.get::<_, String>(2)?).unwrap_or(Actor::Run),
                action: r.get(3)?,
                run_id: r.get(4)?,
                proposal_id: r.get(5)?,
                digest: r.get(6)?,
                detail: r.get(7)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::fixtures::now;
    use crate::domain::workstream::Mode;

    fn ws(id: &str, connection: &str, key: Option<&str>, mins: i64) -> Workstream {
        Workstream {
            id: id.into(),
            connection_id: connection.into(),
            item_key: key.map(Into::into),
            repo: None,
            title: format!("{id} title"),
            pip_session: None,
            mode: Mode::Advise,
            held_reason: None,
            notes: None,
            created_at: now() + Duration::minutes(mins),
            closed_at: None,
            budget: Default::default(),
            spent: Default::default(),
        }
    }

    #[test]
    fn workstreams_are_stored_read_back_and_listed_newest_first() {
        let db = Db::in_memory().unwrap();
        let a = ws("a", "c", Some("CA-1"), 0);
        db.insert_workstream(&a).unwrap();
        db.insert_workstream(&ws("b", "c", None, 1)).unwrap();
        db.insert_workstream(&ws("x", "other", Some("CA-1"), 2)).unwrap();
        assert_eq!(db.workstream("a").unwrap().unwrap(), a);
        assert!(db.workstream("missing").unwrap().is_none());
        let ids = |include: bool| db.workstreams("c", include).unwrap().into_iter().map(|w| w.id).collect::<Vec<_>>();
        assert_eq!(ids(false), ["b", "a"]);

        let mut closed = a.clone();
        closed.closed_at = Some(now());
        closed.notes = Some("looked at the cart".into());
        assert!(db.save_workstream(&closed).unwrap());
        assert_eq!(ids(false), ["b"]);
        assert_eq!(ids(true), ["b", "a"]);
        assert_eq!(db.workstream("a").unwrap().unwrap(), closed);
        assert!(!db.save_workstream(&ws("missing", "c", None, 0)).unwrap());
    }

    #[test]
    fn a_ticket_has_at_most_one_open_workstream() {
        let db = Db::in_memory().unwrap();
        let mut first = ws("a", "c", Some("CA-1"), 0);
        db.insert_workstream(&first).unwrap();
        let err = db.insert_workstream(&ws("b", "c", Some("CA-1"), 1)).unwrap_err().to_string();
        assert!(err.contains("already has an open workstream"), "{err}");
        assert_eq!(db.open_workstream_for_item("c", "CA-1").unwrap().unwrap().id, "a");
        assert!(db.open_workstream_for_item("c", "CA-2").unwrap().is_none());
        assert!(db.open_workstream_for_item("other", "CA-1").unwrap().is_none());

        first.closed_at = Some(now());
        db.save_workstream(&first).unwrap();
        assert!(db.open_workstream_for_item("c", "CA-1").unwrap().is_none());
        db.insert_workstream(&ws("b", "c", Some("CA-1"), 1)).unwrap();
        assert_eq!(db.open_workstream_for_item("c", "CA-1").unwrap().unwrap().id, "b");
    }

    #[test]
    fn events_are_numbered_in_order_per_workstream_and_only_appended() {
        let db = Db::in_memory().unwrap();
        let e = |w: &str, action: &str| WorkstreamEvent::new(w, Actor::Person, action, now());
        assert_eq!(db.append_workstream_event(&e("a", "opened")).unwrap().seq, 0);
        assert_eq!(db.append_workstream_event(&e("b", "opened")).unwrap().seq, 0);
        let stored = db.append_workstream_event(&e("a", "run_approved").run("r1").proposal("p1").digest("abc").detail("é".repeat(3_000))).unwrap();
        assert_eq!(stored.seq, 1);
        db.append_workstream_event(&WorkstreamEvent { seq: 99, ..e("a", "closed") }).unwrap();

        let events = db.workstream_events("a").unwrap();
        assert_eq!(events.iter().map(|e| (e.seq, e.action.as_str())).collect::<Vec<_>>(), [(0, "opened"), (1, "run_approved"), (2, "closed")]);
        assert_eq!(events[1], WorkstreamEvent { detail: Some("é".repeat(2_048)), ..stored });
        assert_eq!((events[1].run_id.as_deref(), events[1].proposal_id.as_deref(), events[1].digest.as_deref()), (Some("r1"), Some("p1"), Some("abc")));
        assert_eq!(db.workstream_events("b").unwrap().len(), 1);
        assert!(db.workstream_events("none").unwrap().is_empty());
    }
}
