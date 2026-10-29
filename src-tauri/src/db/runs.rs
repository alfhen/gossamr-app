//! Runs as stored: the whole value in `data`, with the columns lists and lookups narrow on kept in step with it.

// The launcher and tracker (PRs 4 and 5) are the callers of what `Core` doesn't use yet.
#![allow(dead_code)]

use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, ErrorCode, OptionalExtension};

use super::{stamp, Db};
use crate::domain::{Run, RunEvent, RunQuery, RunState};
use crate::error::{Error, Result};

const EVENTS_PER_RUN: u32 = 500;
const DETAIL_LIMIT: usize = 2_048;

fn path_text(run: &Run) -> String {
    run.expected_worktree.to_string_lossy().into_owned()
}

/// `start_key` defaults to the run's own id; the legacy draft id is stored when there was one.
fn insert(conn: &rusqlite::Connection, run: &Run, start_key: Option<&str>) -> rusqlite::Result<usize> {
    let draft = Some(run.proposal_id.as_str()).filter(|p| !p.is_empty());
    conn.execute(
        "INSERT INTO runs (id, proposal_id, start_key, connection_id, item_id, item_key, role, repo, expected_worktree, short_id, session_id,
           state, queued_at, last_progress_at, ended_at, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            run.id,
            draft,
            start_key.or(draft).unwrap_or(&run.id),
            run.connection_id,
            run.item.as_ref().map(|i| i.external_id.clone()),
            run.item.as_ref().map(|i| i.key.clone()),
            run.spec.role.as_str(),
            run.spec.repo,
            path_text(run),
            run.short_id.as_ref().map(|s| s.as_str().to_owned()),
            run.session_id,
            run.state.as_str(),
            stamp(run.queued_at),
            stamp(run.last_progress_at),
            run.ended_at.map(stamp),
            serde_json::to_string(run).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        ],
    )
}

/// The run as stored, with `archived_at` taken from its column, which is the only place it is written.
fn read_run(data: &str, archived_at: Option<&str>) -> Result<Run> {
    let mut run = serde_json::from_str::<Run>(data)?.with_failure_filled();
    run.archived_at = archived_at.and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at| at.with_timezone(&chrono::Utc));
    Ok(run)
}

/// What can be archived: a run that is over. One still running, queued or waiting on the person is stopped first.
pub const ARCHIVABLE: [RunState; 4] = [RunState::Done, RunState::Failed, RunState::Stopped, RunState::Unknown];

fn clash(e: rusqlite::Error) -> Error {
    match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::ConstraintViolation => {
            Error::Proposal("a run for this draft, start, session or worktree already exists".into())
        }
        _ => e.into(),
    }
}

impl Db {
    pub fn insert_run(&self, run: &Run) -> Result<()> {
        insert(&self.conn, run, None).map(|_| ()).map_err(clash)
    }

    /// Inserts a run Pip started under `start_key`, unless one was already started under it: that run is returned
    /// instead, with `false`. The check and the insert are one statement's worth of work under the database's own lock,
    /// so two calls with the same key can't both start.
    pub fn insert_started_run(&self, run: &Run, start_key: &str) -> Result<(Run, bool)> {
        self.atomically(|db| {
            if let Some(existing) = db.run_by_start_key(start_key)? {
                return Ok((existing, false));
            }
            insert(&db.conn, run, Some(start_key)).map_err(clash)?;
            Ok((run.clone(), true))
        })
    }

    pub fn run_by_start_key(&self, start_key: &str) -> Result<Option<Run>> {
        self.run_where("start_key = ?1", start_key)
    }

    /// Keeps `text` for the run's next `ask` call or the end of its turn, replacing one already waiting.
    pub fn put_run_message(&self, run_id: &str, text: &str, at: chrono::DateTime<chrono::Utc>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO run_messages (run_id, text, queued_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(run_id) DO UPDATE SET text = excluded.text, queued_at = excluded.queued_at",
            params![run_id, text, stamp(at)],
        )?;
        Ok(())
    }

    /// Puts back a message that was taken but not delivered, unless a newer one is waiting.
    pub fn restore_run_message(&self, run_id: &str, text: &str, at: chrono::DateTime<chrono::Utc>) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO run_messages (run_id, text, queued_at) VALUES (?1, ?2, ?3)", params![run_id, text, stamp(at)])?;
        Ok(())
    }

    /// The message waiting for the run, if any, and removes it.
    pub fn take_run_message(&self, run_id: &str) -> Result<Option<String>> {
        self.atomically(|db| {
            let text: Option<String> = db.conn.query_row("SELECT text FROM run_messages WHERE run_id = ?1", params![run_id], |r| r.get(0)).optional()?;
            if text.is_some() {
                db.conn.execute("DELETE FROM run_messages WHERE run_id = ?1", params![run_id])?;
            }
            Ok(text)
        })
    }

    pub fn run_message(&self, run_id: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT text FROM run_messages WHERE run_id = ?1", params![run_id], |r| r.get(0)).optional()?)
    }

    /// The ids of the runs with a message waiting, oldest message first.
    pub fn run_messages_waiting(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT run_id FROM run_messages ORDER BY queued_at, run_id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Replaces a stored run. Returns false when there is none with that id.
    pub fn save_run(&self, run: &Run) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET short_id = ?2, session_id = ?3, state = ?4, last_progress_at = ?5, ended_at = ?6, data = ?7 WHERE id = ?1",
                params![
                    run.id,
                    run.short_id.as_ref().map(|s| s.as_str().to_owned()),
                    run.session_id,
                    run.state.as_str(),
                    stamp(run.last_progress_at),
                    run.ended_at.map(stamp),
                    serde_json::to_string(run)?,
                ],
            )
            .map_err(clash)?;
        Ok(n > 0)
    }

    pub fn run(&self, id: &str) -> Result<Option<Run>> {
        self.run_where("id = ?1", id)
    }

    fn run_where(&self, clause: &str, arg: &str) -> Result<Option<Run>> {
        let row: Option<(String, Option<String>)> =
            self.conn.query_row(&format!("SELECT data, archived_at FROM runs WHERE {clause}"), params![arg], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        row.map(|(data, archived)| read_run(&data, archived.as_deref())).transpose()
    }

    /// Runs matching the query, newest first.
    pub fn runs(&self, q: &RunQuery) -> Result<Vec<Run>> {
        let mut sql = String::from("SELECT data, archived_at FROM runs WHERE 1 = 1");
        let mut args: Vec<Sql> = Vec::new();
        if let Some(states) = &q.states {
            let marks = vec!["?"; states.len()].join(",");
            sql.push_str(&format!(" AND state IN ({marks})"));
            args.extend(states.iter().map(|s| Sql::Text(s.as_str().into())));
        }
        if let Some(item) = &q.item {
            sql.push_str(" AND connection_id = ? AND item_id = ?");
            args.push(Sql::Text(item.connection_id.clone()));
            args.push(Sql::Text(item.external_id.clone()));
        }
        if let Some(c) = &q.connection_id {
            sql.push_str(" AND connection_id = ?");
            args.push(Sql::Text(c.clone()));
        }
        if let Some(w) = &q.workstream {
            sql.push_str(" AND json_extract(data, '$.spec.workstream') = ?");
            args.push(Sql::Text(w.clone()));
        }
        self.visible(&mut sql, &mut args);
        sql.push_str(" ORDER BY queued_at DESC, id");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (data, archived) = row?;
            out.push(read_run(&data, archived.as_deref())?);
        }
        Ok(out)
    }

    /// Archives each listed run that is over and not archived already, and returns the ids that were.
    pub fn archive_runs(&self, ids: &[String], at: chrono::DateTime<chrono::Utc>) -> Result<Vec<String>> {
        self.atomically(|db| {
            let marks = vec!["?"; ARCHIVABLE.len()].join(",");
            let sql = format!("UPDATE runs SET archived_at = ? WHERE id = ? AND archived_at IS NULL AND state IN ({marks})");
            let mut done = Vec::new();
            for id in ids {
                let args = std::iter::once(Sql::Text(stamp(at))).chain(std::iter::once(Sql::Text(id.clone()))).chain(ARCHIVABLE.iter().map(|s| Sql::Text(s.as_str().into())));
                if db.conn.execute(&sql, params_from_iter(args))? > 0 {
                    done.push(id.clone());
                }
            }
            Ok(done)
        })
    }

    /// Brings an archived run back. False when there was nothing archived under that id.
    pub fn restore_run(&self, id: &str) -> Result<bool> {
        Ok(self.conn.execute("UPDATE runs SET archived_at = NULL WHERE id = ?1 AND archived_at IS NOT NULL", params![id])? > 0)
    }

    /// Removes an archived run with its events and reports; an unarchived run is never touched. False when nothing was removed.
    pub fn delete_archived_run(&self, id: &str) -> Result<bool> {
        self.atomically(|db| {
            let archived: bool = db.conn.query_row("SELECT archived_at IS NOT NULL FROM runs WHERE id = ?1", params![id], |r| r.get(0)).optional()?.unwrap_or(false);
            if !archived {
                return Ok(false);
            }
            for table in ["run_events", "run_reports", "run_report_tokens", "run_messages"] {
                db.conn.execute(&format!("DELETE FROM {table} WHERE run_id = ?1"), params![id])?;
            }
            Ok(db.conn.execute("DELETE FROM runs WHERE id = ?1", params![id])? > 0)
        })
    }

    /// Ids of the runs that have a draft still waiting for the person.
    pub fn runs_with_pending_drafts(&self) -> Result<std::collections::HashSet<String>> {
        let mut sql = String::from("SELECT DISTINCT json_extract(data, '$.origin.runId') FROM proposals WHERE state = 'pending' AND json_extract(data, '$.origin.type') = 'run'");
        let mut args: Vec<Sql> = Vec::new();
        self.visible(&mut sql, &mut args);
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| r.get::<_, Option<String>>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().flatten().collect())
    }

    /// Stores events after the run's last one, numbering them itself. At most 500 are kept per run and `detail` is cut
    /// to 2 KB. Returns how many were stored.
    pub fn append_events(&self, run_id: &str, events: &[RunEvent]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let last: Option<u32> = tx.query_row("SELECT max(seq) FROM run_events WHERE run_id = ?1", params![run_id], |r| r.get(0))?;
        let start = last.map_or(0, |n| n + 1);
        let room = EVENTS_PER_RUN.saturating_sub(start) as usize;
        let kept = &events[..events.len().min(room)];
        for (seq, e) in (start..).zip(kept) {
            let detail = e.detail.as_deref().map(|d| d.chars().take(DETAIL_LIMIT).collect::<String>());
            tx.execute(
                "INSERT INTO run_events (run_id, seq, at, kind, text, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![run_id, seq, stamp(e.at), e.kind, e.text, detail],
            )?;
        }
        tx.commit()?;
        Ok(kept.len())
    }

    pub fn run_events(&self, run_id: &str) -> Result<Vec<RunEvent>> {
        let mut stmt = self.conn.prepare("SELECT seq, at, kind, text, detail FROM run_events WHERE run_id = ?1 ORDER BY seq")?;
        let rows = stmt.query_map(params![run_id], |r| {
            let at: String = r.get(1)?;
            Ok(RunEvent {
                run_id: run_id.to_string(),
                seq: r.get(0)?,
                at: chrono::DateTime::parse_from_rfc3339(&at).map(|d| d.with_timezone(&chrono::Utc)).unwrap_or_default(),
                kind: r.get(2)?,
                text: r.get(3)?,
                detail: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use super::*;
    use crate::domain::fixtures::{item_ref, now, run_spec};

    fn count_runs(db: &Db) -> usize {
        db.runs(&RunQuery::default()).unwrap().len()
    }

    fn queued(id: &str, worktree: &str) -> Run {
        let spec = crate::domain::RunSpec { name: worktree.into(), ..run_spec() };
        Run::started_by_pip(id.into(), "c".into(), None, spec, "inbox.sqlite".into(), "req-1", now())
    }

    #[test]
    fn a_second_run_in_the_same_worktree_is_refused() {
        let db = Db::in_memory().unwrap();
        db.insert_started_run(&queued("a", "eng-1-cart-0001"), "pip:one").unwrap();
        let err = db.insert_started_run(&queued("b", "eng-1-cart-0001"), "pip:two").unwrap_err().to_string();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(count_runs(&db), 1);
    }

    #[test]
    fn a_session_id_per_run_and_a_draft_per_old_run_are_enforced_by_the_table() {
        let db = Db::in_memory().unwrap();
        let run = |id: &str, draft: &str, name: &str| {
            let mut r = Run::queued(id.into(), draft.into(), "c".into(), None, crate::domain::RunSpec { name: name.into(), ..run_spec() }, "f".into(), now());
            r.short_id = crate::runs::cli::ShortId::parse("0123abcd");
            r
        };
        db.insert_run(&run("a", "p1", "name-one")).unwrap();
        assert!(db.insert_run(&run("b", "p1", "name-two")).is_err(), "one run per old draft");
        assert!(db.insert_run(&run("c", "p2", "name-three")).is_err(), "one run per short id");
    }

    #[test]
    fn a_queued_run_survives_a_restart_untouched() {
        let dir = std::env::temp_dir().join(format!("gossamr-runs-{}", std::process::id()));
        let file = dir.join("inbox.sqlite");
        let run = {
            let db = Db::open(&file).unwrap();
            db.insert_started_run(&queued("a", "eng-1-cart-0001"), "pip:one").unwrap().0
        };

        let db = Db::open(&file).unwrap();
        assert_eq!(db.release_interrupted(now()).unwrap(), 0);
        assert_eq!(db.run(&run.id).unwrap().unwrap().state, RunState::Queued);
        assert_eq!(count_runs(&db), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn runs_are_listed_newest_first_and_filtered_by_state_item_and_connection() {
        let db = Db::in_memory().unwrap();
        let mk = |id: &str, item: &str, state: RunState, mins: i64| {
            let mut spec = run_spec();
            spec.name = format!("name-{id}");
            let mut r = Run::queued(id.into(), format!("p{id}"), "c".into(), Some(item_ref(item)), spec, "f".into(), now() + Duration::minutes(mins));
            r.state = state;
            db.insert_run(&r).unwrap();
            r
        };
        mk("a", "1", RunState::Working, 0);
        mk("b", "2", RunState::Done, 1);
        mk("c", "1", RunState::Done, 2);

        let ids = |q: RunQuery| db.runs(&q).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(RunQuery::default()), ["c", "b", "a"]);
        assert_eq!(ids(RunQuery { states: Some(vec![RunState::Done]), ..Default::default() }), ["c", "b"]);
        assert_eq!(ids(RunQuery { item: Some(item_ref("1")), ..Default::default() }), ["c", "a"]);
        assert!(ids(RunQuery { connection_id: Some("other".into()), ..Default::default() }).is_empty());
    }

    #[test]
    fn runs_are_filtered_by_their_workstream() {
        let db = Db::in_memory().unwrap();
        let mk = |id: &str, workstream: Option<&str>, mins: i64| {
            let spec = crate::domain::RunSpec { name: format!("name-{id}"), workstream: workstream.map(Into::into), ..run_spec() };
            db.insert_run(&Run::queued(id.into(), format!("p{id}"), "c".into(), None, spec, "f".into(), now() + Duration::minutes(mins))).unwrap();
        };
        mk("a", Some("ws-1"), 0);
        mk("b", None, 1);
        mk("c", Some("ws-1"), 2);
        mk("d", Some("ws-2"), 3);
        let ids = |w: &str| db.runs(&RunQuery { workstream: Some(w.into()), ..Default::default() }).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids("ws-1"), ["c", "a"]);
        assert_eq!(ids("ws-2"), ["d"]);
        assert!(ids("ws-3").is_empty());
        assert_eq!(db.runs(&RunQuery::default()).unwrap().len(), 4);
    }

    #[test]
    fn a_saved_run_replaces_the_stored_one_and_its_columns() {
        let db = Db::in_memory().unwrap();
        let mut run = db.insert_started_run(&queued("a", "eng-1-cart-0001"), "pip:one").unwrap().0;
        run.state = RunState::Working;
        run.short_id = crate::runs::cli::ShortId::parse("0123abcd");
        run.tokens = Some(10);
        assert!(db.save_run(&run).unwrap());
        assert_eq!(db.run(&run.id).unwrap().unwrap(), run);
        let working = RunQuery { states: Some(vec![RunState::Working]), ..Default::default() };
        assert_eq!(db.runs(&working).unwrap().len(), 1);
        run.id = "missing".into();
        assert!(!db.save_run(&run).unwrap());
    }

    #[test]
    fn events_are_numbered_in_order_capped_at_500_and_their_detail_cut() {
        let db = Db::in_memory().unwrap();
        let event = |n: usize| RunEvent {
            run_id: "r".into(),
            seq: 0,
            at: now(),
            kind: "note".into(),
            text: format!("step {n}"),
            detail: Some("é".repeat(3_000)),
        };
        let first: Vec<_> = (0..3).map(event).collect();
        assert_eq!(db.append_events("r", &first).unwrap(), 3);
        let more: Vec<_> = (3..600).map(event).collect();
        assert_eq!(db.append_events("r", &more).unwrap(), 497);
        assert_eq!(db.append_events("r", &[event(0)]).unwrap(), 0);

        let stored = db.run_events("r").unwrap();
        assert_eq!(stored.len(), 500);
        assert_eq!((stored[0].seq, stored[499].seq, stored[499].text.as_str()), (0, 499, "step 499"));
        assert_eq!(stored[0].detail.as_ref().unwrap().chars().count(), 2_048);
        assert!(db.run_events("other").unwrap().is_empty());
    }

    fn stored(db: &Db, id: &str, state: RunState) -> Run {
        let spec = crate::domain::RunSpec { name: format!("name-{id}"), ..run_spec() };
        let mut r = Run::queued(id.into(), format!("p{id}"), "c".into(), None, spec, "f".into(), now());
        r.state = state;
        db.insert_run(&r).unwrap();
        r
    }

    #[test]
    fn an_archived_run_stays_archived_after_a_restart_and_after_the_tracker_saves_it() {
        let dir = std::env::temp_dir().join(format!("gossamr-archive-{}", std::process::id()));
        let file = dir.join("inbox.sqlite");
        {
            let db = Db::open(&file).unwrap();
            stored(&db, "a", RunState::Done);
            stored(&db, "b", RunState::Done);
            assert_eq!(db.archive_runs(&["a".into()], now()).unwrap(), ["a"]);
            let mut stale = db.run("a").unwrap().unwrap();
            stale.archived_at = None;
            stale.last_detail = Some("polled".into());
            db.save_run(&stale).unwrap();
        }
        let db = Db::open(&file).unwrap();
        let by_id = |id: &str| db.runs(&RunQuery::default()).unwrap().into_iter().find(|r| r.id == id).unwrap();
        assert!(by_id("a").archived_at.is_some(), "a run saved from an older copy is still archived");
        assert_eq!(by_id("a").last_detail.as_deref(), Some("polled"));
        assert!(by_id("b").archived_at.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_runs_that_are_over_are_archived_and_restore_brings_one_back() {
        let db = Db::in_memory().unwrap();
        for (id, state) in [("w", RunState::Working), ("n", RunState::NeedsAnswer), ("q", RunState::Queued), ("d", RunState::Done), ("f", RunState::Failed), ("s", RunState::Stopped), ("u", RunState::Unknown)] {
            stored(&db, id, state);
        }
        let all: Vec<String> = ["w", "n", "q", "d", "f", "s", "u"].map(String::from).to_vec();
        assert_eq!(db.archive_runs(&all, now()).unwrap(), ["d", "f", "s", "u"]);
        assert!(db.archive_runs(&all, now()).unwrap().is_empty(), "archiving twice changes nothing");
        assert!(db.restore_run("d").unwrap());
        assert!(!db.restore_run("d").unwrap());
        assert!(db.run("d").unwrap().unwrap().archived_at.is_none());
    }

    #[test]
    fn deleting_removes_an_archived_run_with_its_events_and_reports_and_nothing_else() {
        let db = Db::in_memory().unwrap();
        for id in ["a", "b"] {
            stored(&db, id, RunState::Done);
            db.append_events(id, &[RunEvent { run_id: id.into(), seq: 0, at: now(), kind: "k".into(), text: "t".into(), detail: None }]).unwrap();
            db.execute_batch(&format!("INSERT INTO run_reports (run_id, revision) VALUES ('{id}', 1); INSERT INTO run_report_tokens (token_hash, run_id, tool_version, minted_at) VALUES ('h{id}', '{id}', 1, 't');")).unwrap();
        }
        assert!(!db.delete_archived_run("a").unwrap(), "a run that is not archived is kept");
        db.archive_runs(&["a".into()], now()).unwrap();
        assert!(db.delete_archived_run("a").unwrap());
        assert!(db.run("a").unwrap().is_none() && db.run_events("a").unwrap().is_empty());
        assert!(db.run("b").unwrap().is_some() && db.run_events("b").unwrap().len() == 1);
        let count = |table: &str| db.conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!((count("run_reports"), count("run_report_tokens")), (1, 1));
        assert!(!db.delete_archived_run("a").unwrap());
    }

    fn started(id: &str) -> Run {
        let spec = crate::domain::RunSpec { name: format!("name-{id}"), ..run_spec() };
        Run::started_by_pip(id.into(), "c".into(), None, spec, "f".into(), "req-1", now())
    }

    #[test]
    fn a_start_key_starts_one_run_and_a_second_call_with_it_gets_the_first_back() {
        let db = Db::in_memory().unwrap();
        let (first, fresh) = db.insert_started_run(&started("r1"), "pip:aa").unwrap();
        assert!(fresh);
        assert_eq!(db.run("r1").unwrap().unwrap(), first);
        assert_eq!(db.run_by_start_key("pip:aa").unwrap().unwrap().id, "r1");

        let (again, fresh) = db.insert_started_run(&started("r2"), "pip:aa").unwrap();
        assert_eq!((fresh, again.id.as_str()), (false, "r1"));
        assert!(db.run("r2").unwrap().is_none());
        db.insert_started_run(&started("r3"), "pip:bb").unwrap();
        assert_eq!(count_runs(&db), 2);
    }

    #[test]
    fn an_old_runs_start_key_is_its_drafts_id_and_cannot_be_used_to_start_another() {
        let db = Db::in_memory().unwrap();
        let mut old = Run::queued("old".into(), "p1".into(), "c".into(), None, crate::domain::RunSpec { name: "eng-1-cart-0001".into(), ..run_spec() }, "f".into(), now());
        old.state = RunState::Done;
        db.insert_run(&old).unwrap();
        assert_eq!(db.run_by_start_key("p1").unwrap().unwrap().id, "old");
        assert!(!db.insert_started_run(&started("r1"), "p1").unwrap().1);
        assert_eq!(count_runs(&db), 1);
    }

    #[test]
    fn a_run_stored_with_a_kind_and_the_fields_of_its_kind_reads_as_a_role_and_keeps_them() {
        let db = Db::in_memory().unwrap();
        let mut run = serde_json::to_value(Run::queued("old".into(), "p1".into(), "c".into(), None, run_spec(), "f".into(), now())).unwrap();
        run["spec"] = serde_json::json!({
            "kind": "review", "repo": "acme/webshop", "clonePath": "/Users/me/Code/webshop", "base": "main", "name": "eng-1-cart-0001",
            "instruction": "Review the pull request.", "buildAccount": "Rounded.", "buildFromRun": "b1", "pr": 12, "prSha": "a1b2c3d4e5f6", "allowPush": false
        });
        run["state"] = "done".into();
        run["readOnly"] = serde_json::json!({ "mode": "dontAsk", "allow": [], "deny": ["Edit"], "guard": "read-only" });
        db.execute_batch(&format!(
            "INSERT INTO runs (id, proposal_id, start_key, connection_id, role, repo, expected_worktree, state, queued_at, last_progress_at, data) VALUES ('old', 'p1', 'p1', 'c', 'review', 'acme/webshop', '/w', 'done', 't', 't', '{}')",
            run.to_string().replace('\'', "''")
        ))
        .unwrap();
        let read = db.run("old").unwrap().unwrap();
        assert_eq!((read.spec.role.as_str(), read.spec.brief.as_str(), read.spec.pr), ("review", "Review the pull request.", Some(12)));
        assert_eq!((read.spec.earlier.build_account.as_deref(), read.spec.earlier.build_from_run.as_deref()), (Some("Rounded."), Some("b1")));
        db.save_run(&read).unwrap();
        let again = db.run("old").unwrap().unwrap();
        assert_eq!(again, read, "saved and read again it is the same run, under its new names");
        let json: String = db.conn.query_row("SELECT data FROM runs WHERE id = 'old'", [], |r| r.get(0)).unwrap();
        assert!(json.contains("\"role\":\"review\"") && !json.contains("\"kind\":\"review\""), "{json}");
    }

    #[test]
    fn a_new_run_is_stored_under_its_role() {
        let db = Db::in_memory().unwrap();
        let spec = crate::domain::RunSpec { role: crate::domain::Role::parse("Code Reviewer").unwrap(), name: "eng-1-cart-0002".into(), ..run_spec() };
        db.insert_run(&Run::queued("r".into(), String::new(), "c".into(), None, spec, "f".into(), now())).unwrap();
        let role: String = db.conn.query_row("SELECT role FROM runs WHERE id = 'r'", [], |r| r.get(0)).unwrap();
        assert_eq!(role, "code reviewer");
    }

    #[test]
    fn a_message_for_a_run_waits_until_taken_and_a_newer_one_replaces_it() {
        let db = Db::in_memory().unwrap();
        assert_eq!(db.take_run_message("r1").unwrap(), None);
        db.put_run_message("r1", "First.", now()).unwrap();
        db.put_run_message("r1", "Second.", now()).unwrap();
        db.put_run_message("r2", "Other.", now() + Duration::seconds(1)).unwrap();
        assert_eq!(db.run_message("r1").unwrap().as_deref(), Some("Second."));
        assert_eq!(db.run_messages_waiting().unwrap(), ["r1", "r2"]);
        assert_eq!(db.take_run_message("r1").unwrap().as_deref(), Some("Second."));
        assert_eq!(db.take_run_message("r1").unwrap(), None, "taken once");
        assert_eq!(db.run_messages_waiting().unwrap(), ["r2"]);
    }

    #[test]
    fn deleting_an_archived_run_takes_its_waiting_message_too() {
        let db = Db::in_memory().unwrap();
        stored(&db, "a", RunState::Done);
        db.put_run_message("a", "Never sent.", now()).unwrap();
        db.archive_runs(&["a".into()], now()).unwrap();
        assert!(db.delete_archived_run("a").unwrap());
        assert!(db.run_message("a").unwrap().is_none());
    }
}
