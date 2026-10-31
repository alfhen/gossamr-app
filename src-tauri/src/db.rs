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
pub use proposals::is_for;
pub use pip_turns::{PipTurn, DISCONNECTED, NEVER_RAN, SIGNED_OUT};
#[cfg(test)]
pub use pip_turns::INTERRUPTED;

pub struct Db {
    conn: Connection,
    /// The connection whose drafts and runs this handle may see; `None` sees all of them.
    home: Option<String>,
}

impl Db {
    /// A cache file on its own, which holds no drafts, runs or conversations: GitHub's per-account files. Whatever app
    /// tables it carries are left as they are, because only `open_with_app` copies them out and clears them.
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
    /// live. The app database is the main schema so its tables are found first. A cache that still holds app tables
    /// is copied into the app database, and only then are its copies emptied.
    pub fn open_with_app(cache: &Path, app: &Path) -> Result<Self> {
        let cache_str = cache.to_str().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("cache path is not valid UTF-8: {}", cache.display())))?;
        let mut file = Self::open_file(cache)?;
        schema::migrate(&mut file)?;
        drop(file);
        if let Some(dir) = app.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let db = Self::attach(Connection::open(app)?, cache_str)?;
        let adopted = schema::adopt_cached_app_state(&db.conn, &cache.file_name().unwrap_or_default().to_string_lossy())?;
        db.release_copied(&adopted.applying, chrono::Utc::now())?;
        db.fail_copied_pip_turns(&adopted.pip_turns)?;
        let mut file = Self::open_file(cache)?;
        schema::apply(&mut file, schema::STEPS)?;
        Ok(db)
    }

    /// The app database alone, with no cache attached, for work that touches only app tables. Anything that reads
    /// items, events or a cache's `meta` needs `open_with_app`.
    pub fn open_app(app: &Path) -> Result<Self> {
        if let Some(dir) = app.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Self { conn: Self::migrated_app(Connection::open(app)?)?, home: None })
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

    /// Runs `f` with this handle limited to `connection_id`'s drafts and runs, as `for_connection` limits it for good.
    pub fn homed<T>(&mut self, connection_id: &str, f: impl FnOnce(&Self) -> T) -> T {
        self.home = Some(connection_id.to_string());
        let out = f(self);
        self.home = None;
        out
    }

    fn migrated_app(mut conn: Connection) -> Result<Connection> {
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;
        schema::migrate_app(&mut conn)?;
        Ok(conn)
    }

    fn attach(conn: Connection, cache: &str) -> Result<Self> {
        let conn = Self::migrated_app(conn)?;
        conn.execute("ATTACH DATABASE ?1 AS cache", [cache])?;
        Ok(Self { conn, home: None })
    }

    /// A cache file as the releases before the move to the app database left it, with its own app tables.
    #[cfg(test)]
    pub fn open_before_the_move(path: &Path) -> Result<Self> {
        let mut file = Self::open_file(path)?;
        schema::apply(&mut file, &schema::STEPS[..schema::CACHE_STEPS_WITH_APP_STATE])?;
        Ok(Self { conn: file, home: None })
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

    fn has_table(file: &std::path::Path, table: &str) -> bool {
        let conn = Connection::open(file).unwrap();
        conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [table], |_| Ok(())).optional().unwrap().is_some()
    }

    fn count(file: &std::path::Path, table: &str) -> i64 {
        let conn = Connection::open(file).unwrap();
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    mod app_database {
        use super::*;

        fn files(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
            let dir = std::env::temp_dir().join(format!("gossamr-app-db-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            (dir.join("inbox-site-me.sqlite"), dir.join("app.sqlite"), dir)
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
        fn a_cache_that_held_app_state_hands_it_over_once_and_keeps_only_its_own_rows() {
            let (cache, app, dir) = files("adopt");
            {
                let old = Db::open_before_the_move(&cache).unwrap();
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
            for table in ["proposals", "runs", "run_events", "run_messages", "run_reports", "run_report_tokens", "pip_turns", "workstreams", "workstream_events"] {
                assert!(has_table(&cache, table), "{table} stays so a release from before the move can still open the file");
                assert_eq!(count(&cache, table), 0, "{table} was emptied once the app database held its rows");
            }
            let cache_meta = Connection::open(&cache).unwrap();
            let kept: Vec<String> = cache_meta.prepare("SELECT k FROM meta").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
            assert_eq!(kept, ["last_sync_at"], "the sessions Pip started left the cache's meta");
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
        use crate::domain::{Doc, Intent, ItemRef, Proposal, ProposalQuery, ProposalState, Run, RunQuery};
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
            Run::queued(id.into(), format!("p{id}"), connection.into(), None, spec, now())
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

        fn legacy_cache_with(tag: &str, draft: &Draft) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf, Proposal) {
            let (cache, app, dir) = files(tag);
            let old = Db::open_before_the_move(&cache).unwrap();
            let p = create(&old, Draft::from_pip("q", None, draft.intent.clone(), None), now()).unwrap();
            drop(old);
            (cache, app, dir, p)
        }

        fn cache_version(file: &std::path::Path) -> i64 {
            Connection::open(file).unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
        }

        #[test]
        fn a_cache_is_emptied_of_app_rows_only_after_the_app_database_holds_the_copy() {
            let (cache, app, dir, p) = legacy_cache_with("order", &comment_on("jira:site:ann"));
            Db::open_app(&app).unwrap().execute_batch("CREATE TRIGGER refuse BEFORE INSERT ON proposals BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();

            assert!(Db::open_with_app(&cache, &app).is_err());
            assert_eq!(count(&cache, "proposals"), 1, "the copy failed, so the cache keeps its rows");
            assert_eq!(cache_version(&cache), schema::CACHE_STEPS_WITH_APP_STATE as i64);

            Db::open_app(&app).unwrap().execute_batch("DROP TRIGGER refuse;").unwrap();
            let db = Db::open_with_app(&cache, &app).unwrap().for_connection("jira:site:ann");
            assert_eq!(db.proposal(&p.id).unwrap().map(|p| p.id), Some(p.id.clone()));
            drop(db);
            assert_eq!(count(&cache, "proposals"), 0);
            assert_eq!(cache_version(&cache), schema::STEPS.len() as i64);

            let db = Db::open_with_app(&cache, &app).unwrap();
            assert!(db.proposal(&p.id).unwrap().is_some(), "a cache that was already emptied is skipped, not an error");
            drop(db);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_cache_not_yet_copied_keeps_its_rows_when_opened_on_its_own() {
            let (cache, app, dir, p) = legacy_cache_with("on-its-own", &comment_on("jira:site:ann"));
            drop(Db::open(&cache).unwrap());
            assert_eq!(count(&cache, "proposals"), 1);
            assert_eq!(cache_version(&cache), schema::CACHE_STEPS_WITH_APP_STATE as i64);

            let db = Db::open_with_app(&cache, &app).unwrap().for_connection("jira:site:ann");
            assert!(db.proposal(&p.id).unwrap().is_some(), "the draft reached the app database");
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_cache_that_was_copied_still_opens_for_a_release_from_before_the_move() {
            let (cache, app, dir, _) = legacy_cache_with("downgrade", &comment_on("jira:site:ann"));
            drop(Db::open_with_app(&cache, &app).unwrap());

            for table in ["proposals", "runs", "pip_turns", "workstreams"] {
                assert_eq!(count(&cache, table), 0, "{table}");
            }
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_github_file_is_opened_with_the_cache_tables() {
            let (_, _, dir) = files("github-file");
            let file = dir.join("github-ann.sqlite");
            drop(Db::open(&file).unwrap());
            assert!(has_table(&file, "items") && has_table(&file, "code_changes"));
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_handle_with_no_cache_holds_the_app_tables_and_nothing_else() {
            let (_, app, dir) = files("app-only");
            let db = Db::open_app(&app).unwrap();
            db.set_app_meta("k", "v").unwrap();
            assert_eq!(db.app_meta("k").unwrap().as_deref(), Some("v"));
            assert!(db.item(&item_ref("1")).is_err(), "there is no cache to read");
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn a_draft_that_was_mid_post_in_a_copied_cache_is_released_but_this_launchs_own_is_not() {
            let (cache, app, dir) = files("copied-applying");
            let old = Db::open_before_the_move(&cache).unwrap();
            let stuck = create(&old, Draft::from_pip("q", None, comment_on("jira:site:ann").intent, None), now()).unwrap();
            old.begin_applying(&stuck.id, now()).unwrap().unwrap();
            drop(old);

            let running = Db::open_app(&app).unwrap();
            let posting = create(&running, comment_on("jira:site:bob"), now()).unwrap();
            running.begin_applying(&posting.id, now()).unwrap().unwrap();

            let db = Db::open_with_app(&cache, &app).unwrap();
            assert_eq!(db.proposal(&stuck.id).unwrap().unwrap().state, ProposalState::Pending);
            assert_eq!(db.proposal(&stuck.id).unwrap().unwrap().error.as_deref(), Some(crate::db::proposals::INTERRUPTED_NOTE));
            assert_eq!(db.proposal(&posting.id).unwrap().unwrap().state, ProposalState::Applying);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn pip_turns_cut_off_in_a_copied_cache_are_failed_but_this_launchs_own_are_not() {
            let (cache, app, dir) = files("copied-pip-turns");
            let old = Db::open_before_the_move(&cache).unwrap();
            old.begin_pip_turn("workspace", "cut-off", "Running", &Default::default(), "running", "t1").unwrap();
            old.begin_pip_wake("ws:w1", "never-ran", "[Event] run r1 (triage) Done", &[("r1".into(), "done".into())], "queued", "t2").unwrap();
            old.begin_pip_turn("workspace", "answered", "Fine", &Default::default(), "running", "t3").unwrap();
            old.finish_pip_turn("answered", "Fine", true, None, None, None).unwrap();
            drop(old);

            let running = Db::open_app(&app).unwrap();
            running.begin_pip_turn("workspace", "this-launch", "Running now", &Default::default(), "running", "t4").unwrap();

            let db = Db::open_with_app(&cache, &app).unwrap();
            let status = |id: &str| -> (String, Option<String>) {
                db.conn.query_row("SELECT status, error FROM pip_turns WHERE request_id = ?1 AND role = 'pip'", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
            };
            assert_eq!(status("cut-off"), ("failed".into(), Some(crate::db::INTERRUPTED.into())));
            assert_eq!(status("never-ran"), ("failed".into(), Some(crate::db::NEVER_RAN.into())));
            assert_eq!(status("answered").0, "done");
            assert_eq!(status("this-launch").0, "running");
            let dropped: Vec<_> = db.workstream_events("w1").unwrap().into_iter().filter(|e| e.action == "wake_dropped").map(|e| (e.run_id, e.detail)).collect();
            assert_eq!(dropped, [(Some("r1".to_string()), Some("done".to_string()))]);
            let _ = std::fs::remove_dir_all(dir);
        }

        #[test]
        fn the_sessions_pip_started_are_merged_across_cache_files() {
            let (ann_cache, app, dir) = files("sessions");
            let bob_cache = dir.join("inbox-site-bob.sqlite");
            for (file, sessions) in [(&ann_cache, r#"["s1","s2"]"#), (&bob_cache, r#"["s3","s1"]"#)] {
                Db::open_before_the_move(file).unwrap().set_meta("pip_sessions", sessions).unwrap();
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
