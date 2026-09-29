use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::events::NewEvent;
use crate::model::{CachedTicket, EventKind, InboxEvent, MyAction, Person};

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Io(std::io::Error::other(e))
    }
}

mod cache;
mod proposals;
mod schema;

pub use cache::{stamp, SyncState, Upserted};

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        schema::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// Tickets stored by releases before the cache, with when each was last refreshed. Only read to backfill the
    /// cache once; the table is otherwise left as it was.
    pub fn legacy_tickets(&self) -> Result<Vec<(CachedTicket, String)>> {
        let mut stmt = self.conn.prepare("SELECT data, synced_at FROM tickets")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (data, at) = row?;
            // A row that no longer parses is skipped: the next sync stores it again.
            if let Ok(t) = serde_json::from_str(&data) {
                out.push((t, at));
            }
        }
        Ok(out)
    }

    /// Keys of tickets with an unread, undone event that isn't snoozed past `now`.
    pub fn needs_me_keys(&self, now: &str) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT ticket_key FROM events
             WHERE unread = 1 AND done_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?1)",
        )?;
        let rows = stmt.query_map(params![now], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Inserts events that aren't stored yet and returns the ones that were new.
    pub fn insert_events(&self, events: &[NewEvent], unread_after: &str) -> Result<Vec<NewEvent>> {
        let mut stmt = self.conn.prepare(
            "INSERT OR IGNORE INTO events (id, ticket_key, kind, actor, at, text, unread) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut inserted = Vec::new();
        for e in events {
            let unread = e.at.as_str() > unread_after;
            let n = stmt.execute(params![
                e.id,
                e.ticket_key,
                e.kind.as_str(),
                serde_json::to_string(&e.actor)?,
                e.at,
                e.text,
                unread
            ])?;
            if n > 0 && unread {
                inserted.push(e.clone());
            }
        }
        Ok(inserted)
    }

    /// Stores the user's actions that aren't stored yet. They're kept even after a ticket's history is trimmed to
    /// its newest pages, which is why they're stored rather than derived from the cached history each time.
    pub fn insert_activity(&self, actions: &[(String, MyAction)]) -> Result<()> {
        let mut stmt =
            self.conn.prepare("INSERT OR IGNORE INTO activity (id, ticket_key, kind, at, text) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        for (id, a) in actions {
            stmt.execute(params![id, a.ticket_key, a.kind, a.at, a.text])?;
        }
        Ok(())
    }

    /// The user's actions at or after `since`, newest first.
    pub fn activity(&self, since: &str) -> Result<Vec<MyAction>> {
        let mut stmt =
            self.conn.prepare("SELECT ticket_key, kind, at, text FROM activity WHERE at >= ?1 ORDER BY at DESC")?;
        let rows = stmt.query_map(params![since], |r| {
            Ok(MyAction { ticket_key: r.get(0)?, kind: r.get(1)?, at: r.get(2)?, text: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn events(&self, since: &str) -> Result<Vec<InboxEvent>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ticket_key, kind, actor, at, text, unread, done_at, snoozed_until
             FROM events WHERE at >= ?1 OR (done_at IS NULL AND unread = 1) ORDER BY at DESC",
        )?;
        let rows = stmt.query_map(params![since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, bool>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, ticket_key, kind, actor, at, text, unread, done_at, snoozed_until) = row?;
            out.push(InboxEvent {
                id,
                kind: EventKind::parse(&kind),
                ticket_key,
                actor: serde_json::from_str::<Person>(&actor)?,
                at,
                text,
                unread,
                done_at,
                snoozed_until,
            });
        }
        Ok(out)
    }

    pub fn set_unread(&self, id: &str, unread: bool) -> Result<()> {
        self.update_event("UPDATE events SET unread = ?2 WHERE id = ?1", params![id, unread])
    }

    pub fn set_done(&self, id: &str, done_at: Option<&str>) -> Result<()> {
        if done_at.is_some() {
            self.update_event(
                "UPDATE events SET done_at = ?2, unread = 0, snoozed_until = NULL WHERE id = ?1",
                params![id, done_at],
            )
        } else {
            self.update_event("UPDATE events SET done_at = NULL WHERE id = ?1", params![id])
        }
    }

    pub fn snooze(&self, id: &str, until: Option<&str>) -> Result<()> {
        if until.is_some() {
            self.update_event("UPDATE events SET snoozed_until = ?2, unread = 0 WHERE id = ?1", params![id, until])
        } else {
            self.update_event("UPDATE events SET snoozed_until = NULL WHERE id = ?1", params![id])
        }
    }

    fn update_event(&self, sql: &str, p: impl rusqlite::Params) -> Result<()> {
        match self.conn.execute(sql, p)? {
            0 => Err(Error::Api { status: 404, message: "that inbox item no longer exists".into() }),
            _ => Ok(()),
        }
    }

    pub fn mark_seen(&self, key: &str, at: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO seen (ticket_key, at) VALUES (?1, ?2) ON CONFLICT(ticket_key) DO UPDATE SET at = ?2",
            params![key, at],
        )?;
        Ok(())
    }

    pub fn seen(&self) -> Result<std::collections::HashMap<String, String>> {
        let mut stmt = self.conn.prepare("SELECT ticket_key, at FROM seen")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn meta(&self, k: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT v FROM meta WHERE k = ?1", params![k], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, k: &str, v: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
            params![k, v],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::derive;
    use crate::tracker::testing::sample_ticket;

    #[test]
    fn stores_each_action_once_and_reads_back_recent_ones() {
        let db = Db::in_memory().unwrap();
        let action = |at: &str| MyAction { ticket_key: "CA-1".into(), at: at.into(), kind: "transition".into(), text: "A → B".into() };
        let actions = vec![("h:1:status".to_string(), action("2026-09-28T09:00:00Z")), ("h:2:status".to_string(), action("2026-08-01T09:00:00Z"))];
        db.insert_activity(&actions).unwrap();
        db.insert_activity(&actions).unwrap();
        assert_eq!(db.activity("2026-09-01T00:00:00Z").unwrap(), vec![action("2026-09-28T09:00:00Z")]);
        assert_eq!(db.activity("2026-01-01T00:00:00Z").unwrap().len(), 2);
    }

    #[test]
    fn inserting_events_twice_reports_them_once() {
        let db = Db::in_memory().unwrap();
        let events = derive(&sample_ticket(), "me");
        assert_eq!(db.insert_events(&events, "2000-01-01T00:00:00Z").unwrap().len(), 2);
        assert!(db.insert_events(&events, "2000-01-01T00:00:00Z").unwrap().is_empty());
        assert_eq!(db.events("2000-01-01T00:00:00Z").unwrap().len(), 2);
    }

    #[test]
    fn events_before_the_cutoff_arrive_read() {
        let db = Db::in_memory().unwrap();
        let events = derive(&sample_ticket(), "me");
        assert!(db.insert_events(&events, "2030-01-01T00:00:00Z").unwrap().is_empty());
        assert!(db.events("2000-01-01T00:00:00Z").unwrap().iter().all(|e| !e.unread));
    }

    #[test]
    fn done_clears_unread_and_snooze_and_undo_keeps_them_cleared() {
        let db = Db::in_memory().unwrap();
        let events = derive(&sample_ticket(), "me");
        db.insert_events(&events, "2000-01-01T00:00:00Z").unwrap();
        db.snooze("c:10", Some("2030-01-01T00:00:00Z")).unwrap();
        db.set_done("c:10", Some("2026-09-28T12:00:00Z")).unwrap();
        let e = db.events("2000-01-01T00:00:00Z").unwrap().into_iter().find(|e| e.id == "c:10").unwrap();
        assert_eq!(e.done_at.as_deref(), Some("2026-09-28T12:00:00Z"));
        assert!(e.snoozed_until.is_none() && !e.unread);
        assert!(db.set_done("missing", None).is_err());
    }
}
