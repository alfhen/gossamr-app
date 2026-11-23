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
    "CREATE TABLE client_tokens (stored_key BLOB PRIMARY KEY, created_ms INTEGER NOT NULL);"];

pub const KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;

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
    /// Set by the harness: the session's agent runs.
    #[serde(default)]
    pub running: bool,
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
        self.conn.execute(
            "INSERT INTO sessions (id, provider, locked, cwd, model, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            // The folder's bytes, as they are: a path need not be UTF-8.
            params![id, provider, locked, cwd.as_os_str().as_bytes(), model, now_ms()],
        )?;
        Ok(())
    }

    pub fn session(&self, id: &str) -> Result<SessionRow> {
        self.conn
            .query_row(
                "SELECT provider, locked, cwd, model, provider_session, cleaned_ms IS NOT NULL FROM sessions WHERE id = ?1",
                [id],
                |row| {
                    Ok(SessionRow {
                        provider: row.get(0)?,
                        locked: row.get(1)?,
                        cwd: PathBuf::from(OsString::from_vec(row.get(2)?)),
                        model: row.get(3)?,
                        provider_session: row.get(4)?,
                        cleaned: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::NoSuchSession(id.to_owned()))
    }

    pub fn sessions(&self) -> Result<Vec<Listed>> {
        let mut stmt = self.conn.prepare("SELECT id, provider, locked, model, created_ms, cleaned_ms IS NOT NULL FROM sessions ORDER BY created_ms, id")?;
        let rows = stmt.query_map([], |row| {
            let (id, provider, locked, model, created_ms, cleaned) = (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?);
            Ok(Listed { id, provider, locked, model, created_ms, cleaned, running: false })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn add_client_token(&self, stored_key: &[u8; 32]) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO client_tokens (stored_key, created_ms) VALUES (?1, ?2)", params![&stored_key[..], now_ms()])?;
        Ok(())
    }

    /// The stored keys of the client tokens.
    pub fn client_tokens(&self) -> Result<Vec<[u8; 32]>> {
        let mut stmt = self.conn.prepare("SELECT stored_key FROM client_tokens")?;
        let keys = stmt.query_map([], |row| row.get::<_, Vec<u8>>(0))?;
        Ok(keys.filter_map(|key| key.ok().and_then(|key| key.try_into().ok())).collect())
    }

    /// None clears the id, so the session cannot be resumed.
    pub fn set_provider_session(&self, id: &str, provider_session: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE sessions SET provider_session = ?2 WHERE id = ?1", params![id, provider_session])?;
        Ok(())
    }

    /// Stores `body` as the session's next event, without its private fields for a locked or cleaned-up session.
    /// Redaction is the caller's: this stores what it is given.
    pub fn append(&self, session: &str, body: &Body, ms: i64) -> Result<Event> {
        let row = self.session(session)?;
        let withheld = row.locked || row.cleaned;
        let payload = serde_json::to_string(&if withheld { body.withheld() } else { body.clone() })?;
        let seq = self.conn.query_row(
            "INSERT INTO events (session, seq, ms, type, payload, withheld)
             VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session = ?1), ?2, ?3, ?4, ?5)
             RETURNING seq",
            params![session, ms, body.type_name(), payload, withheld],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(Event { seq: seq as u64, ms, body: body.clone() })
    }

    /// The session's events after `after`, in order. An event of a type this build does not know reads as withheld.
    pub fn events(&self, session: &str, after: u64) -> Result<Vec<Event>> {
        let mut stmt =
            self.conn.prepare("SELECT seq, ms, type, payload FROM events WHERE session = ?1 AND seq > ?2 ORDER BY seq")?;
        let after = i64::try_from(after).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![session, after], |row| {
            Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        })?;
        rows.map(|row| {
            let (seq, ms, of, payload) = row?;
            let body = serde_json::from_str(&payload).unwrap_or_else(|_| Body::Withheld { of, kept: Default::default() });
            Ok(Event { seq: seq as u64, ms, body })
        })
        .collect()
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

    /// Drops the private fields of every event older than 30 days at `now`.
    pub fn sweep(&self, now: i64) -> Result<usize> {
        Ok(self.conn.execute(&format!("UPDATE events SET {} WHERE withheld = 0 AND ms < ?1", WITHHOLD.as_str()), [now - KEEP_MS])?)
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
