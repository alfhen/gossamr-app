//! The harness's own SQLite file, in a data folder it locks for as long as it runs. Sessions, and their events with a
//! sequence number. A locked session's events keep their number, type and fields that are not private, and nothing
//! the agent or the person wrote; any session's private fields are dropped at clean-up or once they are 30 days old.

use std::fs::{DirBuilder, File, OpenOptions, TryLockError};
use std::ffi::OsString;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Error, Result};
use crate::event::{Body, Event, KEPT_FIELDS};
use crate::tools::ToolSpec;
use crate::work::Work;

/// The migration steps, in order. `PRAGMA user_version` counts the steps applied, so a step that has shipped is never
/// edited: a change is a new step at the end.
const STEPS: &[&str] = &["CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        locked INTEGER NOT NULL,
        cwd BLOB NOT NULL,
        model TEXT,
        provider_session TEXT,
        created_ms INTEGER NOT NULL,
        cleaned_ms INTEGER
    );
    CREATE TABLE events (
        session TEXT NOT NULL REFERENCES sessions (id),
        seq INTEGER NOT NULL,
        ms INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        withheld INTEGER NOT NULL,
        PRIMARY KEY (session, seq)
    );
    CREATE INDEX events_kept_by_age ON events (ms) WHERE withheld = 0;",
    "CREATE TABLE client_tokens (stored_key BLOB PRIMARY KEY, created_ms INTEGER NOT NULL);
    ALTER TABLE events ADD COLUMN cut INTEGER;",
    // `last_seq` keeps the numbers going once the sweep has deleted a session's rows; `last_ms` lets the sweep find an
    // idle session without reading its events. Token ids come from AUTOINCREMENT, so a revoked one is never reused.
    "ALTER TABLE sessions ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
    UPDATE sessions SET last_seq = (SELECT COALESCE(MAX(seq), 0) FROM events WHERE session = sessions.id);
    ALTER TABLE sessions ADD COLUMN last_ms INTEGER NOT NULL DEFAULT 0;
    UPDATE sessions SET last_ms = COALESCE((SELECT MAX(ms) FROM events WHERE session = sessions.id), created_ms);
    ALTER TABLE sessions ADD COLUMN ends_with_client INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN cannot_resume INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN handed_over INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, stored_key BLOB NOT NULL UNIQUE, created_ms INTEGER NOT NULL);
    INSERT INTO tokens (id, stored_key, created_ms) SELECT rowid, stored_key, created_ms FROM client_tokens ORDER BY rowid;
    DROP TABLE client_tokens;
    ALTER TABLE tokens RENAME TO client_tokens;",
    // The login folder as typed and the effort a session runs with, and the repo, base, branch and clone of one that
    // named a repo (its `cwd` is the worktree), so a resume starts it the same way and clean-up finds its worktree.
    "ALTER TABLE sessions ADD COLUMN login TEXT;
    ALTER TABLE sessions ADD COLUMN effort TEXT;
    ALTER TABLE sessions ADD COLUMN repo TEXT;
    ALTER TABLE sessions ADD COLUMN base TEXT;
    ALTER TABLE sessions ADD COLUMN branch TEXT;
    ALTER TABLE sessions ADD COLUMN clone BLOB;",
    // The session's tools endpoint name, so a resume serves it under the same name; the tools its client declared, and
    // the schema its result must fit, both as JSON.
    "ALTER TABLE sessions ADD COLUMN endpoint TEXT;
    ALTER TABLE sessions ADD COLUMN tools TEXT;
    ALTER TABLE sessions ADD COLUMN result_schema TEXT;"];

/// What the sweep deletes: the event rows of a session cleaned up before ?1, or never cleaned up and idle since ?2,
/// unless it runs (?3, a JSON array of ids). It reads the sessions table only.
pub const SWEEP_ROWS: &str = "DELETE FROM events WHERE session IN (SELECT id FROM sessions
    WHERE (cleaned_ms < ?1 OR (cleaned_ms IS NULL AND last_ms < ?2)) AND id NOT IN (SELECT value FROM json_each(?3)))";

pub const KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// The most an event adds to its payload as JSON: `"seq"`, `"ms"`, `"cut"` and their separators.
pub const EVENT_FRAME: usize = 96;
/// The most client tokens the harness keeps; each connection's proof tries every one.
pub const MAX_CLIENT_TOKENS: usize = 16;

/// A client token as the store keeps it: never the token, only its stored key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientToken {
    pub id: i64,
    pub created_ms: i64,
    pub stored_key: [u8; 32],
}
/// How long a session's event rows stay after its clean-up.
pub const ROWS_AFTER_CLEAN_UP_MS: i64 = KEEP_MS;
/// How long the event rows of a session never cleaned up stay after its last event.
pub const ROWS_AFTER_LAST_EVENT_MS: i64 = 90 * 24 * 60 * 60 * 1000;

pub struct Store {
    conn: Connection,
    // Held for the store's life: the lock is what keeps a second harness out.
    _lock: File,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow {
    pub provider: String,
    pub locked: bool,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub provider_session: Option<String>,
    pub cleaned: bool,
    pub ends_with_client: bool,
    /// The session said it cannot be resumed: its provider id was not kept.
    pub cannot_resume: bool,
    /// Its last stop was a hand over to Terminal.
    pub handed_over: bool,
    pub login: Option<String>,
    pub effort: Option<String>,
    pub work: Option<Work>,
    /// None for a session made before the store kept it.
    pub endpoint: Option<String>,
    pub tools: Vec<ToolSpec>,
    pub result_schema: Option<serde_json::Value>,
}

/// What a new session's row holds besides its id.
#[derive(Debug, Clone)]
pub struct NewSession<'a> {
    pub provider: &'a str,
    pub locked: bool,
    pub cwd: &'a Path,
    pub model: Option<&'a str>,
    pub login: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub work: Option<&'a Work>,
    pub endpoint: Option<&'a str>,
    pub tools: &'a [ToolSpec],
    pub result_schema: Option<&'a serde_json::Value>,
}

/// A session as `sessions` lists it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Listed {
    pub id: String,
    pub provider: String,
    pub locked: bool,
    pub model: Option<String>,
    pub created_ms: i64,
    pub cleaned: bool,
    pub ends_with_client: bool,
    pub last_seq: u64,
    /// Set by the harness: the session's agent runs.
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// The login folder as typed.
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

impl Store {
    /// Opens the store in `dir`, making the folder (only you can open it) and the file (only you can read it).
    pub fn open(dir: &Path) -> Result<Store> {
        if std::fs::symlink_metadata(dir).is_ok_and(|link| link.is_symlink()) && std::fs::metadata(dir).is_err() {
            return Err(Error::DanglingLink(dir.to_owned()));
        }
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let folder = std::fs::metadata(dir)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if folder.permissions().mode() & 0o077 != 0 || folder.uid() != unsafe { libc::geteuid() } {
            return Err(Error::NotPrivate(dir.to_owned()));
        }
        let lock = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(dir.join("lock"))?;
        lock.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => Error::InUse(dir.to_owned()),
            TryLockError::Error(e) => Error::Io(e),
        })?;
        let path = dir.join("harness.sqlite");
        OpenOptions::new().create(true).append(true).mode(0o600).open(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let mut conn = Connection::open(&path)?;
        // Dropped payload is overwritten in the file, not only unlinked from it.
        conn.execute_batch("PRAGMA secure_delete = ON;")?;
        migrate(&mut conn)?;
        // Not before: inside the migration's transaction this pragma does nothing.
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let store = Store { conn, _lock: lock };
        store.sweep(now_ms())?;
        Ok(store)
    }

    pub fn create_session(&self, id: &str, provider: &str, locked: bool, cwd: &Path, model: Option<&str>) -> Result<()> {
        self.insert_session(id, &NewSession { provider, locked, cwd, model, login: None, effort: None, work: None, endpoint: None, tools: &[], result_schema: None })
    }

    pub fn insert_session(&self, id: &str, new: &NewSession) -> Result<()> {
        let work = new.work;
        self.conn.execute(
            "INSERT INTO sessions (id, provider, locked, cwd, model, created_ms, login, effort, repo, base, branch, clone, endpoint, tools, result_schema)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            // The folders' bytes, as they are: a path need not be UTF-8.
            params![
                id,
                new.provider,
                new.locked,
                new.cwd.as_os_str().as_bytes(),
                new.model,
                now_ms(),
                new.login,
                new.effort,
                work.map(|w| &w.repo),
                work.map(|w| &w.base),
                work.map(|w| &w.branch),
                work.map(|w| w.clone.as_os_str().as_bytes()),
                new.endpoint,
                serde_json::to_string(new.tools)?,
                new.result_schema.map(serde_json::Value::to_string)
            ],
        )?;
        Ok(())
    }

    pub fn session(&self, id: &str) -> Result<SessionRow> {
        self.conn
            .query_row(
                "SELECT provider, locked, cwd, model, provider_session, cleaned_ms IS NOT NULL, ends_with_client, cannot_resume, handed_over,
                 login, effort, repo, base, branch, clone, endpoint, tools, result_schema FROM sessions WHERE id = ?1",
                [id],
                |row| {
                    Ok(SessionRow {
                        provider: row.get(0)?,
                        locked: row.get(1)?,
                        cwd: PathBuf::from(OsString::from_vec(row.get(2)?)),
                        model: row.get(3)?,
                        provider_session: row.get(4)?,
                        cleaned: row.get(5)?,
                        ends_with_client: row.get(6)?,
                        cannot_resume: row.get(7)?,
                        handed_over: row.get(8)?,
                        login: row.get(9)?,
                        effort: row.get(10)?,
                        work: match (row.get::<_, Option<String>>(11)?, row.get(12)?, row.get(13)?, row.get::<_, Option<Vec<u8>>>(14)?) {
                            (Some(repo), Some(base), Some(branch), Some(clone)) => Some(Work { repo, base, branch, clone: PathBuf::from(OsString::from_vec(clone)) }),
                            _ => None,
                        },
                        endpoint: row.get(15)?,
                        // Written by `insert_session` only, so a value that does not read is a broken file.
                        tools: json_column(row, 16)?.unwrap_or_default(),
                        result_schema: json_column(row, 17)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::NoSuchSession(id.to_owned()))
    }

    /// Names the tools endpoint of a session made before the store kept the name.
    pub fn set_endpoint(&self, id: &str, endpoint: &str) -> Result<()> {
        self.conn.execute("UPDATE sessions SET endpoint = ?2 WHERE id = ?1 AND endpoint IS NULL", params![id, endpoint])?;
        Ok(())
    }

    /// Which session owns the worktree of this clone and branch, among those not cleaned up that name it: one that
    /// `is_live` says runs, else the latest. A session runs in its worktree whether or not its provider id has come
    /// yet, and a later session can only take a branch once an earlier one's worktree is gone, so the latest row is
    /// the one whose worktree is on disk.
    pub fn worktree_owner(&self, work: &Work, is_live: impl Fn(&str) -> bool) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM sessions WHERE clone = ?1 AND branch = ?2 AND cleaned_ms IS NULL
             ORDER BY created_ms DESC, rowid DESC",
        )?;
        let holders: Vec<String> = stmt.query_map(params![work.clone.as_os_str().as_bytes(), work.branch], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(holders.iter().find(|id| is_live(id)).or(holders.first()).cloned())
    }

    /// The session ends when the client that opened it leaves, and is never resumed.
    pub fn set_ends_with_client(&self, id: &str) -> Result<()> {
        self.conn.execute("UPDATE sessions SET ends_with_client = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn sessions(&self) -> Result<Vec<Listed>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, provider, locked, model, created_ms, cleaned_ms IS NOT NULL, ends_with_client, last_seq, repo, branch, login, effort
             FROM sessions ORDER BY created_ms, id",
        )?;
        let rows = stmt.query_map([], |row| {
            let (id, provider, locked, model, created_ms, cleaned) = (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?);
            let (ends_with_client, last_seq) = (row.get(6)?, row.get::<_, i64>(7)? as u64);
            let (repo, branch, login, effort) = (row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?);
            Ok(Listed { id, provider, locked, model, created_ms, cleaned, ends_with_client, last_seq, running: false, repo, branch, login, effort })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The number of the session's last event, even when the sweep has deleted it.
    pub fn last_seq(&self, session: &str) -> Result<u64> {
        let seq: i64 = self.conn.query_row("SELECT last_seq FROM sessions WHERE id = ?1", [session], |row| row.get(0))?;
        Ok(seq as u64)
    }

    /// Adds a token by its stored key, unless there are `MAX_CLIENT_TOKENS` already. The count and the insert are one
    /// statement, so two adds at once cannot pass the cap.
    pub fn add_client_token(&self, stored_key: &[u8; 32]) -> Result<()> {
        let added = self.conn.execute(
            "INSERT OR IGNORE INTO client_tokens (stored_key, created_ms) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM client_tokens) < ?3",
            params![&stored_key[..], now_ms(), MAX_CLIENT_TOKENS as i64],
        )?;
        if added == 0 && !self.client_tokens()?.iter().any(|token| token.stored_key == *stored_key) {
            return Err(Error::Refused(format!("there are {MAX_CLIENT_TOKENS} client tokens already: revoke one first")));
        }
        Ok(())
    }

    pub fn client_tokens(&self) -> Result<Vec<ClientToken>> {
        let mut stmt = self.conn.prepare("SELECT id, created_ms, stored_key FROM client_tokens ORDER BY id")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, Vec<u8>>(2)?)))?;
        let rows = rows.collect::<rusqlite::Result<Vec<(i64, i64, Vec<u8>)>>>()?;
        Ok(rows.into_iter().filter_map(|(id, created_ms, key)| Some(ClientToken { id, created_ms, stored_key: key.try_into().ok()? })).collect())
    }

    /// Revokes a token, unless it is the last: with none, no client could reach the harness again. Gives its stored key.
    pub fn revoke_client_token(&self, id: i64) -> Result<[u8; 32]> {
        let tx = self.conn.unchecked_transaction()?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM client_tokens", [], |row| row.get(0))?;
        let key: Option<Vec<u8>> = tx.query_row("SELECT stored_key FROM client_tokens WHERE id = ?1", [id], |row| row.get(0)).optional()?;
        let key = key.and_then(|key| <[u8; 32]>::try_from(key).ok()).ok_or_else(|| Error::Refused(format!("no client token {id}")))?;
        if count <= 1 {
            return Err(Error::Refused("the last client token cannot be revoked: add another first".into()));
        }
        tx.execute("DELETE FROM client_tokens WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(key)
    }

    /// Clears the session's provider id and marks it as one that cannot be resumed, with the `failed` that says so, in
    /// one transaction: no stale id is ever left without the mark.
    pub fn refuse_resume(&self, session: &str, failed: &Body, ms: i64) -> Result<Event> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE sessions SET provider_session = NULL, cannot_resume = 1 WHERE id = ?1", [session])?;
        let event = self.insert_event(session, failed, ms, None)?;
        tx.commit()?;
        Ok(event)
    }

    pub fn set_handed_over(&self, session: &str, handed_over: bool) -> Result<()> {
        self.conn.execute("UPDATE sessions SET handed_over = ?2 WHERE id = ?1", params![session, handed_over])?;
        Ok(())
    }

    /// None clears the id, so the session cannot be resumed.
    pub fn set_provider_session(&self, id: &str, provider_session: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE sessions SET provider_session = ?2 WHERE id = ?1", params![id, provider_session])?;
        Ok(())
    }

    /// Stores `body` as the session's next event, without its private fields for a locked or cleaned-up session.
    /// Redaction is the caller's: this stores what it is given.
    pub fn append(&self, session: &str, body: &Body, ms: i64) -> Result<Event> {
        self.append_cut(session, body, ms, None)
    }

    /// As `append`, for a body that was cut by `cut` bytes.
    pub fn append_cut(&self, session: &str, body: &Body, ms: i64, cut: Option<u64>) -> Result<Event> {
        let tx = self.conn.unchecked_transaction()?;
        let event = self.insert_event(session, body, ms, cut)?;
        tx.commit()?;
        Ok(event)
    }

    /// Numbers and stores an event; the caller holds the transaction.
    fn insert_event(&self, session: &str, body: &Body, ms: i64, cut: Option<u64>) -> Result<Event> {
        let row = self.session(session)?;
        // A body already withheld, such as one too large to keep, is marked so: the sweep's rewrite would lose its type.
        let withheld = row.locked || row.cleaned || matches!(body, Body::Withheld { .. });
        let payload = serde_json::to_string(&if withheld { body.withheld() } else { body.clone() })?;
        let seq = self.conn.query_row(
            "UPDATE sessions SET last_seq = MAX(last_seq, (SELECT COALESCE(MAX(seq), 0) FROM events WHERE session = ?1)) + 1, last_ms = MAX(last_ms, ?2)
             WHERE id = ?1 RETURNING last_seq",
            params![session, ms],
            |row| row.get::<_, i64>(0),
        )?;
        self.conn.execute(
            "INSERT INTO events (session, seq, ms, type, payload, withheld, cut) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![session, seq, ms, body.type_name(), payload, withheld, cut.map(|cut| cut as i64)],
        )?;
        Ok(Event { seq: seq as u64, ms, body: body.clone(), cut })
    }

    /// The session's events after `after`, in order. An event of a type this build does not know reads as withheld.
    pub fn events(&self, session: &str, after: u64) -> Result<Vec<Event>> {
        Ok(self.events_page(session, after, u64::MAX, usize::MAX)?.0)
    }

    /// The session's events after `after`, in order, until they would pass `budget` bytes as JSON (at least one), and
    /// whether more follow. Each counts its payload and `EVENT_FRAME` for its number, time and cut.
    /// No event past `upto` is read.
    pub fn events_page(&self, session: &str, after: u64, upto: u64, budget: usize) -> Result<(Vec<Event>, bool)> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, ms, type, payload, cut FROM events WHERE session = ?1 AND seq > ?2 AND seq <= ?3 ORDER BY seq")?;
        let (after, upto) = (i64::try_from(after).unwrap_or(i64::MAX), i64::try_from(upto).unwrap_or(i64::MAX));
        let mut rows = stmt.query(params![session, after, upto])?;
        let (mut page, mut bytes) = (vec![], 0);
        while let Some(row) = rows.next()? {
            let (seq, ms, of, payload, cut): (i64, i64, String, String, Option<i64>) = (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?);
            if !page.is_empty() && bytes + payload.len() + EVENT_FRAME > budget {
                return Ok((page, true));
            }
            bytes += payload.len() + EVENT_FRAME;
            let body = serde_json::from_str(&payload).unwrap_or_else(|_| Body::Withheld { of, kept: Default::default() });
            page.push(Event { seq: seq as u64, ms, body, cut: cut.map(|cut| cut as u64) });
        }
        Ok((page, false))
    }

    /// Drops the session's payload, now and for any event it has later.
    pub fn clean_up(&self, session: &str) -> Result<()> {
        self.session(session)?;
        // Both or neither: a session marked clean must not keep its payload.
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("UPDATE sessions SET cleaned_ms = ?2 WHERE id = ?1", params![session, now_ms()])?;
        tx.execute(&format!("UPDATE events SET {} WHERE withheld = 0 AND session = ?1", WITHHOLD.as_str()), [session])?;
        tx.commit()?;
        Ok(())
    }

    /// Drops the private fields of every event older than 30 days at `now`, and deletes the event rows of a session
    /// cleaned up more than 30 days ago, or never cleaned up and with no event in 90 days. Says how many rows changed.
    pub fn sweep(&self, now: i64) -> Result<usize> {
        self.sweep_except(now, &[])
    }

    /// As `sweep`, but the rows of the sessions in `running` stay.
    pub fn sweep_except(&self, now: i64, running: &[String]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let withheld = tx.execute(&format!("UPDATE events SET {} WHERE withheld = 0 AND ms < ?1", WITHHOLD.as_str()), [now - KEEP_MS])?;
        let running = serde_json::to_string(running)?;
        let deleted = tx.execute(SWEEP_ROWS, params![now - ROWS_AFTER_CLEAN_UP_MS, now - ROWS_AFTER_LAST_EVENT_MS, running])?;
        tx.commit()?;
        Ok(withheld + deleted)
    }
}

/// Turns a stored event into `Body::Withheld`: its type in `of`, and only its fields on `KEPT_FIELDS` in `kept`.
/// `json_each` gives `true` and `false` as the numbers 1 and 0, so they are made JSON again.
static WITHHOLD: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let kept: Vec<String> = KEPT_FIELDS.iter().map(|field| format!("'{field}'")).collect();
    let kept = kept.join(", ");
    format!(
        "withheld = 1, payload = json_object('type', 'withheld', 'of', type, 'kept', \
         (SELECT json_group_object(key, CASE type WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') ELSE value END) \
         FROM json_each(payload) WHERE key IN ({kept})))"
    )
});

fn json_column<T: serde::de::DeserializeOwned>(row: &rusqlite::Row, at: usize) -> rusqlite::Result<Option<T>> {
    let Some(text) = row.get::<_, Option<String>>(at)? else { return Ok(None) };
    serde_json::from_str(&text).map(Some).map_err(|e| rusqlite::Error::FromSqlConversionFailure(at, rusqlite::types::Type::Text, Box::new(e)))
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let done: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let done = usize::try_from(done).unwrap_or(usize::MAX);
    if done > STEPS.len() {
        return Err(Error::NewerStore(done));
    }
    let tx = conn.transaction()?;
    for step in &STEPS[done..] {
        tx.execute_batch(step)?;
    }
    tx.pragma_update(None, "user_version", STEPS.len() as i64)?;
    tx.commit()?;
    Ok(())
}

pub fn now_ms() -> i64 {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("the clock is after 1970");
    i64::try_from(since.as_millis()).expect("milliseconds fit in an i64")
}

/// The data folder: `$HARNESS_DATA`, else the platform's place for application data.
pub fn default_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("HARNESS_DATA").filter(|dir| !dir.is_empty()) {
        return Some(dir.into());
    }
    let home = PathBuf::from(std::env::var_os("HOME").filter(|home| !home.is_empty())?);
    Some(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/gossamr-harness")
    } else if let Some(data) = std::env::var_os("XDG_DATA_HOME").filter(|data| !data.is_empty()) {
        PathBuf::from(data).join("gossamr-harness")
    } else {
        home.join(".local/share/gossamr-harness")
    })
}
