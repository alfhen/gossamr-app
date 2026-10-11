use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::Visible;
use crate::error::{Error, Result};
use crate::events::NewEvent;
use crate::model::{CachedTicket, EventKind, InboxEvent, MyAction, Person};

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Io(std::io::Error::other(e))
    }
}

mod cache;
mod code;
mod pip_turns;
mod proposals;
mod reports;
mod runs;
mod schema;
mod watch;
mod workstreams;

pub use cache::{stamp, SyncState, Upserted};
pub use code::CachedHttp;
pub use pip_turns::PipTurn;
#[cfg(test)]
pub use pip_turns::{INTERRUPTED, NEVER_RAN};

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

    /// Keys of tickets that need the user: an unread, undone event that isn't snoozed past `now`, or a mention (or a
    /// comment on a ticket they're assigned or reported) on an open ticket that they haven't answered since.
    /// Mirrors `waitingOnMe` in `src/lib/views.ts`: a mention counts even after its notification was cleared.
    pub fn needs_me_keys(&self, connection_id: &str, me: &str, now: &str, visible: &Visible) -> Result<Vec<String>> {
        const AWAKE: &str = "(e.snoozed_until IS NULL OR e.snoozed_until <= ?3)";
        const OPEN: &str = "i.status_category != 'done'";
        // My own comments are stored as activity; `lastCommenter` covers ones from before they were.
        const NOT_ANSWERED: &str = "json_extract(i.data, '$.lastCommenter.accountId') IS NOT ?2
             AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.ticket_key = e.ticket_key AND a.kind = 'comment' AND a.at > e.at)";
        const NO_LATER_ACTION: &str = "NOT EXISTS (SELECT 1 FROM activity a WHERE a.ticket_key = e.ticket_key AND a.at > e.at)";
        // Numbered so the one list of containers serves all three branches.
        let (only, unread_join, args): (String, String, Vec<&str>) = match visible {
            Visible::All => (String::new(), String::new(), Vec::new()),
            Visible::Only(ids) => {
                let marks: Vec<String> = (0..ids.len()).map(|n| format!("?{}", n + 4)).collect();
                let list = if ids.is_empty() { "0 = 1".to_string() } else { format!("i.container_id IN ({})", marks.join(",")) };
                let join = format!("JOIN items i ON i.connection_id = ?1 AND i.key = e.ticket_key AND {list}");
                (format!(" AND {list}"), join, ids.iter().map(String::as_str).collect())
            }
        };
        let sql = format!(
            "SELECT e.ticket_key FROM events e {unread_join}
               WHERE e.unread = 1 AND e.done_at IS NULL AND {AWAKE}
             UNION
             SELECT e.ticket_key FROM events e JOIN items i ON i.connection_id = ?1 AND i.key = e.ticket_key
               WHERE e.kind = 'mention' AND {AWAKE} AND {OPEN} AND {NOT_ANSWERED}{only}
             UNION
             SELECT e.ticket_key FROM events e JOIN items i ON i.connection_id = ?1 AND i.key = e.ticket_key
               WHERE e.kind = 'comment' AND (i.assignee = ?2 OR i.reporter = ?2) AND {AWAKE} AND {OPEN}
                 AND {NOT_ANSWERED} AND {NO_LATER_ACTION}{only}"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let all: Vec<&str> = [connection_id, me, now].into_iter().chain(args).collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(all), |r| r.get(0))?;
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

    /// The user's transitions and creations at or after `since`, newest first. Their comments are stored too, for
    /// `needs_me_keys`, but the page derives those from the tickets and would list them twice.
    pub fn activity(&self, since: &str) -> Result<Vec<MyAction>> {
        let mut stmt = self.conn.prepare(
            "SELECT ticket_key, kind, at, text FROM activity WHERE at >= ?1 AND kind != 'comment' ORDER BY at DESC",
        )?;
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

    mod needs_me {
        use super::*;
        use crate::domain::fixtures::{person, work_item};
        use crate::model::Person;

        const NOW: &str = "2026-09-29T12:00:00Z";

        fn sam() -> Person {
            Person { account_id: "sam".into(), name: "Sam".into(), avatar_url: None }
        }

        fn event(id: &str, key: &str, kind: EventKind, at: &str) -> NewEvent {
            NewEvent { id: id.into(), kind, ticket_key: key.into(), actor: sam(), at: at.into(), text: String::new(), field: None }
        }

        fn my_comment(id: &str, key: &str, at: &str) -> (String, MyAction) {
            (id.into(), MyAction { ticket_key: key.into(), at: at.into(), kind: "comment".into(), text: String::new() })
        }

        fn db_with(status: &str, assignee: Option<&str>, events: &[NewEvent]) -> Db {
            let db = Db::in_memory().unwrap();
            let mut item = work_item("1", status);
            item.assignee = assignee.map(person);
            db.upsert_items(&[item], "t").unwrap();
            db.insert_events(events, "2000-01-01T00:00:00Z").unwrap();
            db.conn.execute("UPDATE events SET unread = 0", []).unwrap();
            db
        }

        fn keys(db: &Db) -> Vec<String> {
            db.needs_me_keys("c", "me", NOW, &Visible::All).unwrap()
        }

        #[test]
        fn an_unread_undone_unsnoozed_event_counts_without_the_ticket() {
            let db = Db::in_memory().unwrap();
            db.insert_events(&[event("c:1", "GONE-1", EventKind::Status, "2026-09-28T09:00:00Z")], "2000-01-01T00:00:00Z").unwrap();
            assert_eq!(keys(&db), ["GONE-1"]);
            db.snooze("c:1", Some("2026-09-30T00:00:00Z")).unwrap();
            assert!(keys(&db).is_empty());
        }

        #[test]
        fn an_unanswered_mention_counts_even_once_cleared() {
            let db = db_with("doing", None, &[event("c:1", "ENG-1", EventKind::Mention, "2026-09-28T09:00:00Z")]);
            db.set_done("c:1", Some("2026-09-28T10:00:00Z")).unwrap();
            assert_eq!(keys(&db), ["ENG-1"]);
        }

        #[test]
        fn a_reply_after_the_mention_answers_it_and_one_before_does_not() {
            let db = db_with("doing", None, &[event("c:1", "ENG-1", EventKind::Mention, "2026-09-28T09:00:00Z")]);
            db.insert_activity(&[my_comment("c:0", "ENG-1", "2026-09-28T08:00:00Z")]).unwrap();
            assert_eq!(keys(&db), ["ENG-1"]);
            db.insert_activity(&[my_comment("c:2", "ENG-1", "2026-09-28T09:30:00Z")]).unwrap();
            assert!(keys(&db).is_empty());
        }

        #[test]
        fn being_the_last_commenter_answers_mentions_that_predate_stored_replies() {
            let db = Db::in_memory().unwrap();
            let mut item = work_item("1", "doing");
            item.last_commenter = Some(person("me"));
            db.upsert_items(&[item], "t").unwrap();
            db.insert_events(&[event("c:1", "ENG-1", EventKind::Mention, "2026-09-28T09:00:00Z")], "2030-01-01T00:00:00Z").unwrap();
            assert!(keys(&db).is_empty());
        }

        #[test]
        fn needs_me_leaves_out_tickets_of_containers_that_are_not_visible_including_unread_events() {
            let mut other = work_item("2", "doing");
            other.container.external_id = "q".into();
            let db = db_with("doing", None, &[event("c:1", "ENG-1", EventKind::Mention, "2026-09-28T09:00:00Z")]);
            db.upsert_items(&[other], "t").unwrap();
            db.insert_events(&[event("c:2", "ENG-2", EventKind::Mention, "2026-09-28T09:00:00Z"), event("c:3", "ENG-1", EventKind::Status, "2026-09-28T09:00:00Z")], "2000-01-01T00:00:00Z").unwrap();
            db.conn.execute("UPDATE events SET unread = 1 WHERE id = 'c:3'", []).unwrap();
            db.insert_events(&[event("c:9", "GONE-1", EventKind::Status, "2026-09-28T09:00:00Z")], "2000-01-01T00:00:00Z").unwrap();

            let ask = |v: &Visible| {
                let mut k = db.needs_me_keys("c", "me", NOW, v).unwrap();
                k.sort();
                k
            };
            assert_eq!(ask(&Visible::All), ["ENG-1", "ENG-2", "GONE-1"]);
            assert_eq!(ask(&Visible::Only(vec!["p".into()])), ["ENG-1"]);
            assert_eq!(ask(&Visible::Only(vec!["q".into()])), ["ENG-2"]);
            assert!(ask(&Visible::Only(vec![])).is_empty());
        }

        #[test]
        fn a_closed_ticket_needs_nobody() {
            let db = db_with("done", None, &[event("c:1", "ENG-1", EventKind::Mention, "2026-09-28T09:00:00Z")]);
            assert!(keys(&db).is_empty());
        }

        #[test]
        fn a_snoozed_mention_waits_until_the_snooze_ends() {
            let db = db_with("doing", None, &[event("c:1", "ENG-1", EventKind::Mention, "2026-09-28T09:00:00Z")]);
            db.snooze("c:1", Some("2026-09-30T00:00:00Z")).unwrap();
            assert!(keys(&db).is_empty());
            assert_eq!(db.needs_me_keys("c", "me", "2026-09-30T00:00:01Z", &Visible::All).unwrap(), ["ENG-1"]);
        }

        #[test]
        fn a_comment_needs_me_only_on_a_ticket_i_own_and_until_i_act() {
            let comment = event("c:1", "ENG-1", EventKind::Comment, "2026-09-28T09:00:00Z");
            let mine = db_with("doing", Some("me"), std::slice::from_ref(&comment));
            assert_eq!(keys(&mine), ["ENG-1"]);
            let transition = MyAction { ticket_key: "ENG-1".into(), at: "2026-09-28T10:00:00Z".into(), kind: "transition".into(), text: "A → B".into() };
            mine.insert_activity(&[("h:1:status".into(), transition)]).unwrap();
            assert!(keys(&mine).is_empty());

            let not_involved = db_with("doing", Some("sam"), &[comment]);
            assert!(keys(&not_involved).is_empty());
        }
    }
}
