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

/// What an agent reported through the run-report tool, apart from the run's own blob so a tracker poll that rewrites the
/// run can't lose it. A token's hash is never deleted while its run exists: revocation is by the run's state, and a
/// launch whose answer was lost can still be adopted with the token it was given.
const RUN_REPORTS: &str = "
CREATE TABLE run_reports (
  run_id TEXT PRIMARY KEY,
  report TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  rejections INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  first_at TEXT, last_at TEXT
) WITHOUT ROWID;
CREATE TABLE run_report_tokens (
  token_hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_version INTEGER NOT NULL,
  minted_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX run_report_tokens_run ON run_report_tokens(run_id);";

/// Pip's conversations, so one outlives a reload and a restart. A turn is two rows under its request id: the person's
/// (`role` 'user': the prompt and `meta`, the quote, what Pip was looking at and how many images were sent) and Pip's
/// (`role` 'pip': the answer, its steps, status, session and usage). 'wake' is kept for turns nobody typed.
const PIP_TURNS: &str = "
CREATE TABLE pip_turns (
  conversation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  role TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  session_id TEXT,
  meta TEXT,
  usage TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, role)
) WITHOUT ROWID;
CREATE INDEX pip_turns_conversation ON pip_turns(conversation, created_at);";

/// Workstreams and their audit. `data` holds the whole workstream; at most one is open per ticket. `workstream_events`
/// is only ever appended to.
const WORKSTREAMS: &str = "
CREATE TABLE workstreams (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  item_key TEXT,
  repo TEXT,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  held_reason TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  data TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX workstreams_open ON workstreams(connection_id, closed_at);
CREATE UNIQUE INDEX workstreams_open_item ON workstreams(connection_id, item_key) WHERE closed_at IS NULL AND item_key IS NOT NULL;
CREATE TABLE workstream_events (
  workstream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  run_id TEXT,
  proposal_id TEXT,
  digest TEXT,
  detail TEXT,
  PRIMARY KEY (workstream_id, seq)
) WITHOUT ROWID;";

/// Which kind of origin made each draft and which workstream it belongs to, as columns lists can narrow on. Rows from
/// before are filled from `data`: the origin's workstream, else that of the run a draft would start. A row whose data
/// isn't JSON is left with both empty.
const PROPOSAL_WORKSTREAMS: &str = "
ALTER TABLE proposals ADD COLUMN origin_kind TEXT;
ALTER TABLE proposals ADD COLUMN workstream TEXT;
UPDATE proposals SET origin_kind = json_extract(data, '$.origin.type'),
  workstream = COALESCE(json_extract(data, '$.origin.workstream'), json_extract(data, '$.intent.spec.workstream'))
  WHERE json_valid(data);
CREATE INDEX proposals_workstream ON proposals(workstream, state);";

/// The Pip pane's conversation was `workspace`; it is now `general`, beside each workstream's `ws:<id>`. A ticket's
/// conversation in the classic drawer keeps its key.
const GENERAL_CONVERSATION: &str = "
UPDATE pip_turns SET conversation = 'general' WHERE conversation = 'workspace';";

const STEPS: &[&str] = &[INBOX, CACHE, PROPOSALS, WATCH, CODE, LINKS, RUNS, RUN_REPORTS, PIP_TURNS, WORKSTREAMS, PROPOSAL_WORKSTREAMS, GENERAL_CONVERSATION];

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
        for t in ["tickets", "events", "activity", "seen", "meta", "items", "containers", "workflows", "cache_events", "sync_state", "proposals", "watch_settings", "watched_containers", "container_catalog", "code_changes", "http_cache", "item_links", "runs", "run_events", "run_reports", "run_report_tokens", "pip_turns", "workstreams", "workstream_events"] {
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
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
    }

    #[test]
    fn a_fresh_file_is_at_version_twelve() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
    }

    #[test]
    fn a_version_eight_file_keeps_its_runs_and_drafts_and_gains_pip_turns() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in &STEPS[..8] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 8).unwrap();
        conn.execute(
            "INSERT INTO runs (id, proposal_id, connection_id, kind, repo, expected_worktree, state, queued_at, last_progress_at, data) VALUES ('r1', 'p1', 'c', 'investigate', 'a/b', '/w', 'done', 't', 't', '{}')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO proposals (id, connection_id, state, created_at, updated_at, data) VALUES ('p1', 'c', 'pending', 't', 't', '{}')", []).unwrap();
        conn.execute("INSERT INTO run_reports (run_id, revision) VALUES ('r1', 2)", []).unwrap();
        assert!(!tables(&conn).contains(&"pip_turns".to_string()));

        migrate(&mut conn).unwrap();

        for t in ["runs", "proposals", "run_reports"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{t}");
        }
        assert!(tables(&conn).contains(&"pip_turns".to_string()));
        assert_eq!(conn.query_row("SELECT count(*) FROM pip_turns", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);

        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
    }

    #[test]
    fn a_file_with_runs_gains_the_report_tables_and_keeps_every_run() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in &STEPS[..7] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 7).unwrap();
        conn.execute(
            "INSERT INTO runs (id, proposal_id, connection_id, kind, repo, expected_worktree, state, queued_at, last_progress_at, data) VALUES ('r1', 'p1', 'c', 'investigate', 'a/b', '/w', 'done', 't', 't', '{}')",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        for t in ["run_reports", "run_report_tokens"] {
            assert!(tables(&conn).contains(&t.to_string()), "missing {t}");
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0, "{t}");
        }
        assert_eq!(conn.query_row("SELECT count(*) FROM runs", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO sync_state (connection_id, cursor) VALUES ('c', 'x')", []).unwrap();
        conn.execute("INSERT INTO pip_turns (conversation, request_id, role, status, created_at) VALUES ('workspace', 'q1', 'pip', 'done', 't')", []).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM sync_state", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT count(*) FROM pip_turns", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
    }

    #[test]
    fn a_version_nine_file_keeps_everything_and_gains_workstreams() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in &STEPS[..9] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 9).unwrap();
        conn.execute(
            "INSERT INTO runs (id, proposal_id, connection_id, kind, repo, expected_worktree, state, queued_at, last_progress_at, data) VALUES ('r1', 'p1', 'c', 'investigate', 'a/b', '/w', 'done', 't', 't', '{}')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO proposals (id, connection_id, state, created_at, updated_at, data) VALUES ('p1', 'c', 'pending', 't', 't', '{}')", []).unwrap();
        conn.execute("INSERT INTO pip_turns (conversation, request_id, role, status, created_at) VALUES ('workspace', 'q1', 'pip', 'done', 't')", []).unwrap();
        assert!(!tables(&conn).contains(&"workstreams".to_string()));

        migrate(&mut conn).unwrap();

        for t in ["runs", "proposals", "pip_turns"] {
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{t}");
        }
        for t in ["workstreams", "workstream_events"] {
            assert!(tables(&conn).contains(&t.to_string()), "missing {t}");
            assert_eq!(conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0, "{t}");
        }
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);

        conn.execute("INSERT INTO workstreams (id, connection_id, item_key, title, mode, created_at, data) VALUES ('w1', 'c', 'CA-1', 't', 'advise', 't', '{}')", []).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM workstreams", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
    }

    #[test]
    fn one_open_workstream_per_ticket_but_any_number_closed_or_ticketless() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let add = |id: &str, key: Option<&str>, closed: Option<&str>| {
            conn.execute(
                "INSERT INTO workstreams (id, connection_id, item_key, title, mode, created_at, closed_at, data) VALUES (?1, 'c', ?2, 't', 'advise', 't', ?3, '{}')",
                rusqlite::params![id, key, closed],
            )
        };
        add("w1", Some("CA-1"), None).unwrap();
        assert!(add("w2", Some("CA-1"), None).is_err());
        add("w3", Some("CA-1"), Some("t")).unwrap();
        add("w4", None, None).unwrap();
        add("w5", None, None).unwrap();
    }

    #[test]
    fn a_version_ten_file_fills_the_origin_kind_and_workstream_of_every_draft() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in &STEPS[..10] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 10).unwrap();
        let add = |id: &str, data: &str| {
            conn.execute("INSERT INTO proposals (id, connection_id, state, created_at, updated_at, data) VALUES (?1, 'c', 'pending', 't', 't', ?2)", rusqlite::params![id, data]).unwrap();
        };
        add("chat", r#"{"origin":{"type":"chat","requestId":"q"},"intent":{"type":"comment"}}"#);
        add("run", r#"{"origin":{"type":"run","runId":"r","shortId":null},"createdBy":"user","intent":{"type":"comment"}}"#);
        add("start", r#"{"origin":{"type":"board"},"intent":{"type":"startRun","spec":{"workstream":"w1"}}}"#);
        add("in-ws", r#"{"origin":{"type":"chat","requestId":"q","workstream":"w2"},"intent":{"type":"startRun","spec":{"workstream":"w3"}}}"#);
        add("empty", "{}");
        add("broken", "not json");

        migrate(&mut conn).unwrap();

        let row = |id: &str| {
            conn.query_row("SELECT origin_kind, workstream FROM proposals WHERE id = ?1", [id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))).unwrap()
        };
        let some = |s: &str| Some(s.to_string());
        assert_eq!(row("chat"), (some("chat"), None));
        assert_eq!(row("run"), (some("run"), None));
        assert_eq!(row("start"), (some("board"), some("w1")));
        assert_eq!(row("in-ws"), (some("chat"), some("w2")), "the origin's workstream wins");
        assert_eq!(row("empty"), (None, None));
        assert_eq!(row("broken"), (None, None));
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
        migrate(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM proposals", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
    }

    #[test]
    fn a_version_eleven_file_moves_the_workspace_conversation_to_general_and_leaves_ticket_conversations_alone() {
        let mut conn = Connection::open_in_memory().unwrap();
        for step in &STEPS[..11] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 11).unwrap();
        let add = |conversation: &str, id: &str| {
            for role in ["user", "pip"] {
                conn.execute(
                    "INSERT INTO pip_turns (conversation, request_id, role, status, created_at) VALUES (?1, ?2, ?3, 'done', 't')",
                    rusqlite::params![conversation, id, role],
                )
                .unwrap();
            }
        };
        add("workspace", "q1");
        add("workspace", "q2");
        add("CA-1", "q3");
        add("ws:w1", "q4");

        migrate(&mut conn).unwrap();

        let in_conversation = |conn: &Connection, c: &str| conn.query_row("SELECT count(*) FROM pip_turns WHERE conversation = ?1", [c], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!((in_conversation(&conn, "general"), in_conversation(&conn, "workspace")), (4, 0));
        assert_eq!((in_conversation(&conn, "CA-1"), in_conversation(&conn, "ws:w1")), (2, 2));
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 12);
        migrate(&mut conn).unwrap();
        assert_eq!(in_conversation(&conn, "general"), 4);
    }
}
