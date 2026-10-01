//! Versioned schema. `PRAGMA user_version` counts the steps applied, so a file from any earlier release is brought
//! forward in place and never rebuilt.

use rusqlite::Connection;

use crate::error::Result;

/// The inbox's own tables, as every release before the connector-neutral cache created them. Idempotent, so a legacy
/// file passes through untouched and a fresh one gets them.
const INBOX: &str = "
CREATE TABLE IF NOT EXISTS tickets (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ticket_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL,
  unread INTEGER NOT NULL,
  done_at TEXT,
  snoozed_until TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ticket_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
CREATE TABLE IF NOT EXISTS seen (ticket_key TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);";

/// Work items, containers, workflows and events keyed by connection. `data` holds the whole domain value; the other
/// columns exist so queries can narrow before it is read. Timestamps are RFC 3339 in UTC with a `Z`, so text order
/// is time order.
const CACHE: &str = "
CREATE TABLE items (
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  key TEXT NOT NULL,
  container_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status_id TEXT NOT NULL,
  status_name TEXT NOT NULL,
  status_category TEXT NOT NULL,
  assignee TEXT,
  reporter TEXT,
  priority TEXT,
  parent_id TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  data TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_id)
) WITHOUT ROWID;
CREATE INDEX items_container ON items(connection_id, container_id);
CREATE INDEX items_parent ON items(connection_id, parent_id);
CREATE INDEX items_assignee ON items(connection_id, assignee);
CREATE INDEX items_updated ON items(connection_id, updated);
CREATE TABLE containers (
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_id)
) WITHOUT ROWID;
CREATE TABLE workflows (
  connection_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  data TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, container_id)
) WITHOUT ROWID;
CREATE TABLE cache_events (
  connection_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (connection_id, id)
) WITHOUT ROWID;
CREATE INDEX cache_events_item ON cache_events(connection_id, item_id, at);
CREATE TABLE sync_state (
  connection_id TEXT PRIMARY KEY,
  cursor TEXT,
  full_at TEXT,
  containers_at TEXT
) WITHOUT ROWID;";

/// Drafted writes. `data` holds the whole proposal; `state` and the target columns exist so lists can narrow first.
const PROPOSALS: &str = "
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  item_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX proposals_state ON proposals(state, created_at);
CREATE INDEX proposals_item ON proposals(connection_id, item_id);";

/// What each connection follows. A connection with no `watch_settings` row has not chosen yet (`unset`), which is what
/// every database from before this step is, so it keeps syncing everything. `watched_containers` is separate from
/// `containers` because that table is rewritten on every refresh.
const WATCH: &str = "
CREATE TABLE watch_settings (
  connection_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE watched_containers (
  connection_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  depth TEXT NOT NULL DEFAULT 'involved',
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  added_at TEXT NOT NULL,
  unwatched_at TEXT,
  inaccessible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, container_id)
) WITHOUT ROWID;
CREATE TABLE container_catalog (
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  last_active TEXT,
  item_hint INTEGER,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_id)
) WITHOUT ROWID;";

/// What a code host connection caches. `data` holds the whole `CodeChange`. `http_cache` keeps the last answer to each
/// GET with its validators, so polling sends conditional requests and a 304 is answered from here.
const CODE: &str = "
CREATE TABLE code_changes (
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  number INTEGER,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_id)
) WITHOUT ROWID;
CREATE INDEX code_changes_repo ON code_changes(connection_id, repo, kind, updated_at);
CREATE TABLE http_cache (
  connection_id TEXT NOT NULL,
  url TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  link_next TEXT,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, url)
) WITHOUT ROWID;";

/// Which work items a code change carries out. Derived from the cached changes and rebuilt whenever they or the known
/// project keys change, so a row is never authoritative; `provenance` is where the key was found.
const LINKS: &str = "
CREATE TABLE item_links (
  item_connection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  code_id TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL NOT NULL,
  found_at TEXT NOT NULL,
  PRIMARY KEY (item_connection_id, item_id, connection_id, code_id)
) WITHOUT ROWID;
CREATE INDEX item_links_code ON item_links(connection_id, code_id);";

/// Background agent runs. `expected_worktree` is the join key to the CLI's session list, chosen before launch; the
/// unique indexes are what make an approval produce at most one run.
const RUNS: &str = "
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  item_id TEXT, item_key TEXT,
  kind TEXT NOT NULL, repo TEXT NOT NULL,
  expected_worktree TEXT NOT NULL,
  short_id TEXT, session_id TEXT,
  state TEXT NOT NULL,
  queued_at TEXT NOT NULL, last_progress_at TEXT NOT NULL, ended_at TEXT,
  data TEXT NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX runs_proposal ON runs(proposal_id);
CREATE UNIQUE INDEX runs_worktree ON runs(expected_worktree);
CREATE UNIQUE INDEX runs_short ON runs(short_id) WHERE short_id IS NOT NULL;
CREATE INDEX runs_state ON runs(state, queued_at);
CREATE INDEX runs_item ON runs(connection_id, item_id);
CREATE TABLE run_events (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, detail TEXT,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;";

const STEPS: &[&str] = &[INBOX, CACHE, PROPOSALS, WATCH, CODE, LINKS, RUNS];

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let applied: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in STEPS.iter().enumerate().skip(applied as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn a_fresh_file_gets_every_table_and_the_latest_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let names = tables(&conn);
        for t in ["tickets", "events", "activity", "seen", "meta", "items", "containers", "workflows", "cache_events", "sync_state", "proposals", "watch_settings", "watched_containers", "container_catalog", "code_changes", "http_cache", "item_links", "runs", "run_events"] {
            assert!(names.contains(&t.to_string()), "missing {t}");
        }
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), STEPS.len() as i64);
    }

    #[test]
    fn a_file_from_before_the_cache_keeps_its_rows_and_gains_the_new_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(INBOX).unwrap();
        conn.execute("INSERT INTO tickets (key, data, synced_at) VALUES ('CA-1', '{}', '2026-09-01T00:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO seen (ticket_key, at) VALUES ('CA-1', '2026-09-02T00:00:00Z')", []).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 0);

        migrate(&mut conn).unwrap();

        assert_eq!(conn.query_row("SELECT count(*) FROM tickets", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT count(*) FROM seen", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(tables(&conn).contains(&"items".to_string()));
    }

    #[test]
    fn a_cache_from_before_proposals_gains_the_table_and_keeps_its_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(INBOX).unwrap();
        conn.execute_batch(CACHE).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute("INSERT INTO sync_state (connection_id, cursor) VALUES ('c', 'x')", []).unwrap();

        migrate(&mut conn).unwrap();

        assert!(tables(&conn).contains(&"proposals".to_string()));
        assert_eq!(conn.query_row("SELECT count(*) FROM sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn a_cache_from_before_watching_keeps_everything_and_has_not_chosen_yet() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in [INBOX, CACHE, PROPOSALS] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute("INSERT INTO sync_state (connection_id, cursor) VALUES ('c', 'x')", []).unwrap();
        conn.execute("INSERT INTO containers (connection_id, external_id, key, name, synced_at) VALUES ('c', 'CA', 'CA', 'Cats', 't')", []).unwrap();
        conn.execute(
            "INSERT INTO items (connection_id, external_id, key, container_id, kind, title, status_id, status_name, status_category,
               created, updated, data, synced_at) VALUES ('c', 'CA-1', 'CA-1', 'CA', 'task', 't', '1', 'To Do', 'todo', 'a', 'a', '{}', 'a')",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        for t in ["sync_state", "containers", "items"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{t}");
        }
        for t in ["watch_settings", "watched_containers", "container_catalog"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0, "{t}");
        }
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), STEPS.len() as i64);
        for t in ["code_changes", "http_cache"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0, "{t}");
        }
    }

    #[test]
    fn a_cache_from_before_code_hosts_keeps_its_rows_and_gains_the_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in [INBOX, CACHE, PROPOSALS, WATCH] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 4).unwrap();
        conn.execute("INSERT INTO watch_settings (connection_id, mode, updated_at) VALUES ('c', 'selected', 't')", []).unwrap();
        conn.execute("INSERT INTO container_catalog (connection_id, external_id, key, name, seen_at) VALUES ('c', 'CA', 'CA', 'Cats', 't')", []).unwrap();

        migrate(&mut conn).unwrap();

        assert!(tables(&conn).contains(&"code_changes".to_string()));
        assert_eq!(conn.query_row("SELECT count(*) FROM watch_settings", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT count(*) FROM container_catalog", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), STEPS.len() as i64);
    }

    #[test]
    fn a_code_cache_from_before_links_keeps_its_changes_and_gains_the_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in [INBOX, CACHE, PROPOSALS, WATCH, CODE] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 5).unwrap();
        conn.execute(
            "INSERT INTO code_changes (connection_id, external_id, repo, kind, number, state, updated_at, data, synced_at)
             VALUES ('github:ann', 'pr:acme/webshop#1', 'acme/webshop', 'pullRequest', 1, 'open', 't', '{}', 't')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO http_cache (connection_id, url, body, fetched_at) VALUES ('github:ann', 'u', '[]', 't')", []).unwrap();

        migrate(&mut conn).unwrap();

        assert!(tables(&conn).contains(&"item_links".to_string()));
        for t in ["code_changes", "http_cache"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{t}");
        }
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), STEPS.len() as i64);
    }

    #[test]
    fn a_file_from_before_agent_runs_keeps_its_rows_and_gains_the_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in [INBOX, CACHE, PROPOSALS, WATCH, CODE, LINKS] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn.execute(
            "INSERT INTO proposals (id, connection_id, state, created_at, updated_at, data) VALUES ('p', 'c', 'pending', 't', 't', '{}')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO item_links (item_connection_id, item_id, item_key, connection_id, code_id, provenance, confidence, found_at) VALUES ('c', '1', 'A-1', 'g', 'x', 'branch', 1.0, 't')", []).unwrap();

        migrate(&mut conn).unwrap();

        for t in ["runs", "run_events"] {
            assert!(tables(&conn).contains(&t.to_string()), "missing {t}");
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0, "{t}");
        }
        for t in ["proposals", "item_links"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{t}");
        }
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 7);
    }

    #[test]
    fn a_fresh_file_is_at_version_seven() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 7);
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO sync_state (connection_id, cursor) VALUES ('c', 'x')", []).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
}
