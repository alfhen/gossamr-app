use std::fmt;
use std::path::PathBuf;

#[derive(Debug)]
pub enum Error {
    /// Another harness holds the data folder.
    InUse(PathBuf),
    /// The data folder can be opened by other users.
    NotPrivate(PathBuf),
    /// The store was written by a newer harness, with this many migration steps.
    NewerStore(usize),
    NoSuchSession(String),
    NoSuchProvider(String),
    /// The session already runs, so it cannot be resumed.
    Running(String),
    /// The session does not run, so it cannot take a request.
    NotRunning(String),
    Driver(String),
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InUse(dir) => write!(f, "another harness is using the data folder {}", dir.display()),
            Error::NotPrivate(dir) => write!(f, "the data folder {} can be opened by other users", dir.display()),
            Error::NewerStore(steps) => write!(f, "the store has {steps} migration steps; this harness is older and knows fewer"),
            Error::NoSuchSession(id) => write!(f, "no session {id}"),
            Error::NoSuchProvider(name) => write!(f, "no provider {name}"),
            Error::Running(id) => write!(f, "session {id} is running"),
            Error::NotRunning(id) => write!(f, "session {id} is not running"),
            Error::Driver(message) => write!(f, "the driver failed: {message}"),
            Error::Sqlite(e) => write!(f, "the store failed: {e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Json(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Error {
        Error::Sqlite(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Error {
        Error::Io(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Error {
        Error::Json(e)
    }
}
