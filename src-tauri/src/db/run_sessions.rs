//! Which harness session each run follows, and how far the app has applied its events.

use rusqlite::{params, OptionalExtension};

use super::Db;
use crate::domain::{Run, RunEvent, SessionFollow};
use crate::error::{Error, Result};

/// What applying a session's events did: the run before and after, and how far the app now follows it.
#[derive(Debug)]
pub struct Applied {
    pub before: Run,
    pub run: Run,
    pub follow: SessionFollow,
}

impl Db {
    /// Makes `session` the run's harness session, followed from its first event.
    pub fn bind_run_session(&self, run_id: &str, session: &str) -> Result<()> {
        self.atomically(|db| {
            let mut run = db.run(run_id)?.ok_or_else(|| Error::Proposal("that run no longer exists".into()))?;
            let data = serde_json::to_string(&SessionFollow::default())?;
            db.conn.execute("INSERT INTO run_sessions (run_id, session, data) VALUES (?1, ?2, ?3)", params![run_id, session, data])?;
            run.harness_session = Some(session.to_owned());
            db.save_run(&run)?;
            Ok(())
        })
    }

    /// The run that follows `session`, and how far, when this handle sees it.
    pub fn session_run(&self, session: &str) -> Result<Option<(String, SessionFollow)>> {
        let row: Option<(String, String)> =
            self.conn.query_row("SELECT run_id, data FROM run_sessions WHERE session = ?1", [session], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((run_id, data)) = row else { return Ok(None) };
        if self.run(&run_id)?.is_none() {
            return Ok(None);
        }
        Ok(Some((run_id, serde_json::from_str(&data)?)))
    }

    /// Every session the app still follows, with how far: one that has not closed, of a run this handle sees.
    pub fn followed_sessions(&self) -> Result<Vec<(String, SessionFollow)>> {
        let mut stmt = self.conn.prepare("SELECT session, run_id, data FROM run_sessions ORDER BY run_id")?;
        let rows: Vec<(String, String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (session, run_id, data) in rows {
            let follow: SessionFollow = serde_json::from_str(&data)?;
            if !follow.closed && self.run(&run_id)?.is_some() {
                out.push((session, follow));
            }
        }
        Ok(out)
    }

    /// Applies what `f` makes of the session's run and follow, and the timeline rows it returns, in one transaction:
    /// all of it lands, or none. None when no run this handle sees follows `session`.
    pub fn apply_session(&self, session: &str, f: impl FnOnce(&mut Run, &mut SessionFollow) -> Vec<RunEvent>) -> Result<Option<Applied>> {
        self.apply_session_reporting(session, |run, follow| (f(run, follow), None))
    }

    /// `apply_session`, keeping the report `f` returns as the run's in the same transaction.
    pub fn apply_session_reporting(
        &self,
        session: &str,
        f: impl FnOnce(&mut Run, &mut SessionFollow) -> (Vec<RunEvent>, Option<crate::runs::report::Report>),
    ) -> Result<Option<Applied>> {
        self.atomically(|db| {
            let Some((run_id, mut follow)) = db.session_run(session)? else { return Ok(None) };
            let Some(before) = db.run(&run_id)? else { return Ok(None) };
            let mut run = before.clone();
            let (rows, report) = f(&mut run, &mut follow);
            if run != before {
                db.save_run(&run)?;
            }
            if let Some(report) = report {
                db.keep_result(&run_id, report, chrono::Utc::now())?;
            }
            db.append_events(&run_id, &rows)?;
            db.conn.execute("UPDATE run_sessions SET data = ?2 WHERE run_id = ?1", params![run_id, serde_json::to_string(&follow)?])?;
            Ok(Some(Applied { before, run, follow }))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::domain::fixtures::run_spec;
    use chrono::Utc;

    fn db_with_run() -> (tempfile::TempDir, Db, Run) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open_app(&dir.path().join("app.sqlite")).unwrap();
        let run = Run::queued("r1".into(), "p1".into(), "c1".into(), None, run_spec(), Utc::now());
        db.insert_run(&run).unwrap();
        (dir, db, run)
    }

    fn row(text: &str) -> RunEvent {
        RunEvent { run_id: "r1".into(), seq: 0, at: Utc::now(), kind: "update".into(), text: text.into(), detail: None }
    }

    #[test]
    fn a_bound_run_names_its_session_and_is_followed_from_the_first_event() {
        let (_dir, db, _) = db_with_run();
        db.bind_run_session("r1", "s1").unwrap();
        assert_eq!(db.run("r1").unwrap().unwrap().harness_session.as_deref(), Some("s1"));
        assert_eq!(db.followed_sessions().unwrap(), vec![("s1".to_owned(), SessionFollow::default())]);
        assert!(db.bind_run_session("r1", "s2").is_err(), "a run follows one session");
    }

    #[test]
    fn an_applied_event_moves_the_run_its_timeline_and_the_sequence_together() {
        let (_dir, db, _) = db_with_run();
        db.bind_run_session("r1", "s1").unwrap();
        let applied = db
            .apply_session("s1", |run, follow| {
                run.last_detail = Some("reading".into());
                follow.seq = 3;
                vec![row("Read a file")]
            })
            .unwrap()
            .unwrap();
        assert_eq!((applied.before.last_detail, applied.run.last_detail.as_deref()), (None, Some("reading")));
        assert_eq!(db.session_run("s1").unwrap().unwrap().1.seq, 3);
        assert_eq!(db.run_events("r1").unwrap().len(), 1);
        assert!(db.apply_session("nobody", |_, _| vec![]).unwrap().is_none());
    }

    #[test]
    fn a_failed_write_leaves_the_sequence_where_it_was() {
        let (_dir, db, _) = db_with_run();
        db.bind_run_session("r1", "s1").unwrap();
        // The run is gone by the time the event is applied: its save fails inside the transaction.
        db.conn.execute_batch("CREATE TRIGGER no_events BEFORE INSERT ON run_events BEGIN SELECT RAISE(ABORT, 'full'); END;").unwrap();
        let failed = db.apply_session("s1", |run, follow| {
            run.last_detail = Some("x".into());
            follow.seq = 9;
            vec![row("x")]
        });
        assert!(failed.is_err());
        assert_eq!(db.session_run("s1").unwrap().unwrap().1.seq, 0, "nothing of the event landed");
        assert_eq!(db.run("r1").unwrap().unwrap().last_detail, None);
    }

    #[test]
    fn a_closed_session_is_no_longer_followed() {
        let (_dir, db, _) = db_with_run();
        db.bind_run_session("r1", "s1").unwrap();
        db.apply_session("s1", |_, follow| {
            follow.closed = true;
            vec![]
        })
        .unwrap();
        assert!(db.followed_sessions().unwrap().is_empty());
    }
}
