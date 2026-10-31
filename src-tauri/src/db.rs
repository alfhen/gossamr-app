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
pub use runs::ARCHIVABLE;
pub use code::CachedHttp;
pub use pip_turns::{PipTurn, NEVER_RAN};
#[cfg(test)]
pub use pip_turns::INTERRUPTED;

pub struct Db {
    conn: Connection,
    /// The connection whose drafts and runs this handle may see; `None` sees all of them.
    home: Option<String>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    fn init(mut conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        schema::migrate(&mut conn)?;
        Ok(Self { conn, home: None })
    }

    /// A cache file with the app database attached, which is where drafts, runs, workstreams and Pip's conversations
    /// live. The app database is the main schema so its tables are found first; the cache's copies of them, left
    /// from before the move, are never read.
    pub fn open_with_app(cache: &Path, app: &Path) -> Result<Self> {
        Self::open_with_app_steps(cache, app, schema::STEPS)
    }

    fn open_with_app_steps(cache: &Path, app: &Path, steps: &[&str]) -> Result<Self> {
        let cache_str = cache.to_str().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("cache path is not valid UTF-8: {}", cache.display())))?;
        let through = schema::CACHE_STEPS_WITH_APP_STATE.min(steps.len());
        let mut file = Self::open_file(cache)?;
        schema::apply(&mut file, &steps[..through])?;
        drop(file);
        if let Some(dir) = app.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let db = Self::attach(Connection::open(app)?, cache_str)?;
        schema::adopt_cached_app_state(&db.conn, &cache.file_name().unwrap_or_default().to_string_lossy())?;
        let mut file = Self::open_file(cache)?;
        schema::apply(&mut file, steps)?;
        Ok(db)
    }

    fn open_file(path: &Path) -> Result<Connection> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        Ok(conn)
    }

    /// Limits the drafts and runs this handle lists and claims to `connection_id`'s, and to the code host's, whose
    /// drafts are made and posted through whichever account is signed in.
    pub fn for_connection(mut self, connection_id: &str) -> Self {
        self.home = Some(connection_id.to_string());
        self
    }

    /// ` AND (connection_id = ? OR connection_id LIKE 'github:%')` and its argument, when this handle has a home.
    fn visible(&self, sql: &mut String, args: &mut Vec<rusqlite::types::Value>) {
        if let Some(home) = &self.home {
            sql.push_str(" AND (connection_id = ? OR connection_id LIKE 'github:%')");
            args.push(rusqlite::types::Value::Text(home.clone()));
        }
    }

    fn attach(mut conn: Connection, cache: &str) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        schema::migrate_app(&mut conn)?;
        conn.execute("ATTACH DATABASE ?1 AS cache", [cache])?;
        Ok(Self { conn, home: None })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let uri = format!("file:cache{}?mode=memory&cache=shared", NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        let mut seed = Connection::open(&uri)?;
        schema::migrate(&mut seed)?;
        Self::attach(Connection::open_in_memory()?, &uri)
    }

    /// Runs raw SQL, for tests that need the database to refuse a write.
    #[cfg(test)]
    pub fn execute_batch(&self, sql: &str) -> Result<()> {
        Ok(self.conn.execute_batch(sql)?)
    }

    /// Runs `f` as one transaction: every write it makes lands, or none does. Inside another `atomically` it joins that one.
    pub fn atomically<T>(&self, f: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        if !self.conn.is_autocommit() {
            return f(self);
        }
        let tx = self.conn.unchecked_transaction()?;
        let out = f(self)?;
        tx.commit()?;
        Ok(out)
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

    #[cfg(test)]
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

    #[cfg(test)]
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

    /// Like `meta`, for what belongs to the app and not to a connection's cache.
    pub fn app_meta(&self, k: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT v FROM app_meta WHERE k = ?1", params![k], |r| r.get(0)).optional()?)
    }

    pub fn set_app_meta(&self, k: &str, v: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO app_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2",
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

    mod app_database {
        use super::*;

        fn files(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
            let dir = std::env::temp_dir().join(format!("gossamr-app-db-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            (dir.join("inbox-site-me.sqlite"), dir.join("app.sqlite"), dir)
        }

        fn count(file: &std::path::Path, table: &str) -> i64 {
            let conn = Connection::open(file).unwrap();
            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
        }

        const WORKSTREAM: &str = "INSERT INTO workstreams (id, connection_id, title, mode, created_at, data) VALUES ('w1', 'c', 'Fix it', 'open', '2026-10-01T10:00:00Z', '{}');";
        const TURN: &str = "INSERT INTO pip_turns (conversation, request_id, role, status, created_at) VALUES ('general', 'q1', 'user', 'done', '2026-10-01T10:00:00Z');";

        #[test]
        fn app_state_is_written_to_the_app_file_and_cache_to_the_connections_file() {
            let (cache, app, dir) = files("split");
            let db = Db::open_with_app(&cache, &app).unwrap();
            db.execute_batch(&format!("{WORKSTREAM}{TURN}")).unwrap();
            db.set_app_meta("pip_sessions", "[]").unwrap();
            db.set_meta("last_sync_at", "2026-10-01T10:00:00Z").unwrap();
            drop(db);

            assert_eq!((count(&app, "workstreams"), count(&app, "pip_turns"), count(&app, "app_meta")), (1, 1, 2));
            assert_eq!((count(&cache, "workstreams"), count(&cache, "pip_turns")), (0, 0));
            assert_eq!(count(&cache, "meta"), 1);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_cache_that_held_app_state_hands_it_over_once_and_keeps_its_own_rows() {
            let (cache, app, dir) = files("adopt");
            {
                let old = Db::open(&cache).unwrap();
                old.execute_batch(&format!("{WORKSTREAM}{TURN}")).unwrap();
                old.set_meta("claude:CA-1", r#"{"id":"s1"}"#).unwrap();
                old.set_meta("pip_sessions", r#"["s1"]"#).unwrap();
                old.set_meta("last_sync_at", "2026-10-01T10:00:00Z").unwrap();
            }
            drop(Db::open_with_app(&cache, &app).unwrap());
            let db = Db::open_with_app(&cache, &app).unwrap();
            db.execute_batch("DELETE FROM workstreams;").unwrap();
            drop(db);
            let db = Db::open_with_app(&cache, &app).unwrap();

            assert_eq!(db.app_meta("claude:CA-1").unwrap().as_deref(), Some(r#"{"id":"s1"}"#));
            assert_eq!(db.app_meta("pip_sessions").unwrap().as_deref(), Some(r#"["s1"]"#));
            assert_eq!(db.app_meta("last_sync_at").unwrap(), None, "cache bookkeeping stays with the cache");
            drop(db);
            assert_eq!((count(&app, "workstreams"), count(&app, "pip_turns")), (0, 1), "a workstream the app deleted is not copied back");
            assert_eq!((count(&cache, "workstreams"), count(&cache, "pip_turns")), (1, 1), "the cache's own rows stay until a later step drops them");
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn two_connections_files_share_one_app_database() {
            let (cache, app, dir) = files("shared");
            let other = dir.join("inbox-site-you.sqlite");
            let db = Db::open_with_app(&cache, &app).unwrap();
            db.execute_batch(WORKSTREAM).unwrap();
            db.set_meta("last_sync_at", "mine").unwrap();
            drop(db);

            let db = Db::open_with_app(&other, &app).unwrap();
            assert_eq!(db.conn.query_row("SELECT count(*) FROM workstreams", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(db.meta("last_sync_at").unwrap(), None);
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    mod shared_app_database {
        use super::*;
        use crate::domain::fixtures::{item_ref, now, run_spec};
        use crate::domain::{Doc, Intent, ItemRef, Proposal, ProposalQuery, ProposalState, Run, RunEvent, RunQuery, RunState};
        use crate::proposals::{create, Draft};

        fn files(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
            let dir = std::env::temp_dir().join(format!("gossamr-shared-app-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            (dir.join("inbox-site-ann.sqlite"), dir.join("app.sqlite"), dir)
        }

        fn comment_on(connection: &str) -> Draft {
            let item = ItemRef { connection_id: connection.into(), ..item_ref("1") };
            Draft::from_pip("q", None, Intent::Comment { item, body: Doc::paragraph("hello") }, None)
        }

        fn review_on_github() -> Draft {
            let intent = Intent::GithubReview {
                connection_id: "github:ann".into(),
                item: None,
                run_id: "r1".into(),
                repo: "acme/webshop".into(),
                number: 218,
                commit_sha: "a1b2c3d4e5f6".into(),
                summary: "Review.".into(),
                comments: vec![],
            };
            Draft::from_pip("q", None, intent, None)
        }

        fn run_of(id: &str, connection: &str) -> Run {
            let spec = crate::domain::RunSpec { name: format!("name-{id}"), ..run_spec() };
            Run::queued(id.into(), format!("p{id}"), connection.into(), None, spec, "f".into(), now())
        }

        #[test]
        fn a_connection_cannot_list_read_or_claim_what_another_one_drafted_or_ran() {
            let (ann_cache, app, dir) = files("isolation");
            let ann = Db::open_with_app(&ann_cache, &app).unwrap().for_connection("jira:site:ann");
            let hers = create(&ann, comment_on("jira:site:ann"), now()).unwrap();
            let review = create(&ann, review_on_github(), now()).unwrap();
            ann.insert_run(&run_of("ann-run", "jira:site:ann")).unwrap();

            let bob = Db::open_with_app(&dir.join("inbox-site-bob.sqlite"), &app).unwrap().for_connection("jira:site:bob");
            let ids = |db: &Db| db.proposals(&ProposalQuery::default()).unwrap().into_iter().map(|p| p.id).collect::<Vec<_>>();
            assert_eq!(ids(&bob), vec![review.id.clone()], "the code host's drafts go through whoever is signed in");
            assert!(bob.proposal(&hers.id).unwrap().is_none());
            assert!(bob.begin_applying(&hers.id, now()).unwrap().is_none());
            assert!(bob.runs(&RunQuery::default()).unwrap().is_empty());
            assert!(bob.runs_with_pending_drafts().unwrap().is_empty());
            assert_eq!(bob.release_interrupted(now()).unwrap(), 0);

            assert_eq!(ann.proposal(&hers.id).unwrap().unwrap().state, ProposalState::Pending, "left as it was");
            assert_eq!(ann.runs(&RunQuery::default()).unwrap().len(), 1);
            assert!(bob.begin_posting_review(&review.id, now(), None).unwrap().is_some());
            assert!(bob.begin_posting_review(&hers.id, now(), None).unwrap().is_none());
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_connection_cannot_read_or_change_another_ones_run_by_its_id() {
            let (ann_cache, app, dir) = files("run-ids");
            let ann = Db::open_with_app(&ann_cache, &app).unwrap().for_connection("jira:site:ann");
            let done = |id: &str| Run { state: RunState::Done, ..run_of(id, "jira:site:ann") };
            let event = |id: &str| RunEvent { run_id: id.into(), seq: 0, at: now(), kind: "k".into(), text: "t".into(), detail: None };
            for id in ["open", "archived"] {
                ann.insert_run(&done(id)).unwrap();
                ann.append_events(id, &[event(id)]).unwrap();
            }
            ann.archive_runs(&["archived".into()], now()).unwrap();
            ann.put_run_message("open", "Later.", now()).unwrap();

            let bob = Db::open_with_app(&dir.join("inbox-site-bob.sqlite"), &app).unwrap().for_connection("jira:site:bob");
            assert!(bob.run("open").unwrap().is_none());
            assert!(bob.run_by_start_key("popen").unwrap().is_none());
            assert!(bob.run_events("open").unwrap().is_empty());
            assert!(bob.run_messages_waiting().unwrap().is_empty());
            assert!(!bob.save_run(&Run { last_detail: Some("bob's".into()), ..done("open") }).unwrap());
            assert!(bob.archive_runs(&["open".into()], now()).unwrap().is_empty());
            assert_eq!(bob.append_events("open", &[event("open")]).unwrap(), 0);
            assert!(!bob.restore_run("archived").unwrap());
            assert!(!bob.delete_archived_run("archived").unwrap());

            let open = ann.run("open").unwrap().unwrap();
            assert_eq!((open.last_detail, open.archived_at), (None, None), "left as it was");
            assert_eq!(ann.run_events("open").unwrap().len(), 1);
            assert_eq!(ann.run_messages_waiting().unwrap(), ["open"]);
            assert!(ann.run("archived").unwrap().unwrap().archived_at.is_some());
            assert_eq!(ann.run_events("archived").unwrap().len(), 1);
            let _ = std::fs::remove_dir_all(dir);
        }

        fn legacy_cache_with(tag: &str, draft: &Draft) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf, Proposal) {
            let (cache, app, dir) = files(tag);
            let old = Db::open(&cache).unwrap();
            let p = create(&old, Draft::from_pip("q", None, draft.intent.clone(), None), now()).unwrap();
            drop(old);
            (cache, app, dir, p)
        }

        #[test]
        fn drafts_still_open_in_a_copied_cache_are_retired_there_so_an_older_release_cannot_post_them_again() {
            let (cache, app, dir, p) = legacy_cache_with("retire", &comment_on("jira:site:ann"));
            let db = Db::open_with_app(&cache, &app).unwrap().for_connection("jira:site:ann");
            assert_eq!(db.proposal(&p.id).unwrap().unwrap().state, ProposalState::Pending, "the app copy is still waiting for the person");
            drop(db);

            let old_release = Db::open(&cache).unwrap();
            let stored = old_release.proposal(&p.id).unwrap().unwrap();
            assert!(matches!(stored.state, ProposalState::Retired(_)), "{:?}", stored.state);
            assert_eq!(old_release.release_interrupted(now()).unwrap(), 0);
            assert!(old_release.proposals(&ProposalQuery { states: Some(vec![crate::domain::StateKind::Pending, crate::domain::StateKind::Applying]), ..Default::default() }).unwrap().is_empty());
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn the_copy_happens_before_a_later_cache_step_drops_the_app_tables() {
            let (cache, app, dir, p) = legacy_cache_with("order", &comment_on("jira:site:ann"));
            let mut steps = schema::STEPS.to_vec();
            steps.push("DROP TABLE proposals; DROP TABLE pip_turns;");

            let db = Db::open_with_app_steps(&cache, &app, &steps).unwrap().for_connection("jira:site:ann");
            assert_eq!(db.proposal(&p.id).unwrap().map(|p| p.id), Some(p.id.clone()));
            drop(db);
            let gone = Connection::open(&cache).unwrap().prepare("SELECT 1 FROM proposals").is_err();
            assert!(gone, "the later step ran, after the copy");

            let db = Db::open_with_app_steps(&cache, &app, &steps).unwrap();
            assert!(db.proposal(&p.id).unwrap().is_some(), "a cache with the tables already gone is skipped, not an error");
            drop(db);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn the_sessions_pip_started_are_merged_across_cache_files() {
            let (ann_cache, app, dir) = files("sessions");
            let bob_cache = dir.join("inbox-site-bob.sqlite");
            for (file, sessions) in [(&ann_cache, r#"["s1","s2"]"#), (&bob_cache, r#"["s3","s1"]"#)] {
                Db::open(file).unwrap().set_meta("pip_sessions", sessions).unwrap();
            }
            drop(Db::open_with_app(&ann_cache, &app).unwrap());
            let db = Db::open_with_app(&bob_cache, &app).unwrap();
            assert_eq!(db.app_meta("pip_sessions").unwrap().as_deref(), Some(r#"["s1","s2","s3"]"#));
            drop(db);
            let _ = std::fs::remove_dir_all(dir);
        }
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
