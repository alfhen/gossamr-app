//! The harness's own SQLite file, in a data folder it locks for as long as it runs. Sessions, and their events with a
//! sequence number. A locked session's events keep their number and type but no payload; any session's payload is
//! dropped at clean-up or once it is 30 days old.

use std::fs::{DirBuilder, File, OpenOptions, TryLockError};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Error, Result};
use crate::event::{Body, Event};

/// The migration steps, in order. `PRAGMA user_version` counts the steps applied, so a step that has shipped is never
/// edited: a change is a new step at the end.
const STEPS: &[&str] = &["CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        locked INTEGER NOT NULL,
        cwd TEXT NOT NULL,
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
        payload TEXT,
        PRIMARY KEY (session, seq)
    );"];

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

impl Store {
    /// Opens the store in `dir`, making the folder (only you can open it) and the file (only you can read it).
    pub fn open(dir: &Path) -> Result<Store> {
        DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        if std::fs::metadata(dir)?.permissions().mode() & 0o077 != 0 {
            return Err(Error::NotPrivate(dir.to_owned()));
        }
        let lock = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(dir.join("lock"))?;
        lock.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => Error::InUse(dir.to_owned()),
            TryLockError::Error(e) => Error::Io(e),
        })?;
        let path = dir.join("harness.sqlite");
        OpenOptions::new().create(true).append(true).mode(0o600).open(&path)?;
        let mut conn = Connection::open(&path)?;
        // Dropped payload is overwritten in the file, not only unlinked from it.
        conn.execute_batch("PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;")?;
        migrate(&mut conn)?;
        let store = Store { conn, _lock: lock };
        store.sweep(now_ms())?;
        Ok(store)
    }

    pub fn create_session(&self, id: &str, provider: &str, locked: bool, cwd: &Path, model: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (id, provider, locked, cwd, model, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, provider, locked, cwd.to_string_lossy(), model, now_ms()],
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
                        cwd: PathBuf::from(row.get::<_, String>(2)?),
                        model: row.get(3)?,
                        provider_session: row.get(4)?,
                        cleaned: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::NoSuchSession(id.to_owned()))
    }

    pub fn set_provider_session(&self, id: &str, provider_session: &str) -> Result<()> {
        self.conn.execute("UPDATE sessions SET provider_session = ?2 WHERE id = ?1", params![id, provider_session])?;
        Ok(())
    }

    /// Stores `body` as the session's next event. Redaction is the caller's: this stores what it is given.
    pub fn append(&self, session: &str, body: &Body, ms: i64) -> Result<Event> {
        let row = self.session(session)?;
        let payload = (!row.locked && !row.cleaned).then(|| serde_json::to_string(body)).transpose()?;
        let seq = self.conn.query_row(
            "INSERT INTO events (session, seq, ms, type, payload)
             VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session = ?1), ?2, ?3, ?4)
             RETURNING seq",
            params![session, ms, body.type_name(), payload],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(Event { seq: seq as u64, ms, body: body.clone() })
    }

    /// The session's events after `after`, in order.
    pub fn events(&self, session: &str, after: u64) -> Result<Vec<Event>> {
        let mut stmt =
            self.conn.prepare("SELECT seq, ms, type, payload FROM events WHERE session = ?1 AND seq > ?2 ORDER BY seq")?;
        let after = i64::try_from(after).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![session, after], |row| {
            Ok((row.get::<_, i64>(0)?, row.get(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?))
        })?;
        rows.map(|row| {
            let (seq, ms, of, payload) = row?;
            let body = match payload {
                Some(json) => serde_json::from_str(&json)?,
                None => Body::Withheld { of },
            };
            Ok(Event { seq: seq as u64, ms, body })
        })
        .collect()
    }

    /// Drops the session's payload, now and for any event it has later.
    pub fn clean_up(&self, session: &str) -> Result<()> {
        self.session(session)?;
        self.conn.execute("UPDATE sessions SET cleaned_ms = ?2 WHERE id = ?1", params![session, now_ms()])?;
        self.conn.execute("UPDATE events SET payload = NULL WHERE session = ?1", [session])?;
        Ok(())
    }

    /// Drops the payload of every event older than 30 days at `now`.
    pub fn sweep(&self, now: i64) -> Result<usize> {
        Ok(self.conn.execute("UPDATE events SET payload = NULL WHERE payload IS NOT NULL AND ms < ?1", [now - KEEP_MS])?)
    }
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
