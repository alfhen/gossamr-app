use std::fmt;
use std::path::PathBuf;

#[derive(Debug)]
pub enum Error {
    /// Another harness holds the data folder.
    InUse(PathBuf),
    /// The data folder can be opened by other users, or belongs to another user.
    NotPrivate(PathBuf),
    /// The data folder is a link to nothing.
    DanglingLink(PathBuf),
    /// The store was written by a newer harness, with this many migration steps.
    NewerStore(usize),
    NoSuchSession(String),
    NoSuchProvider(String),
    /// The session already runs, so it cannot be resumed.
    Running(String),
    /// The session does not run, so it cannot take a request.
    NotRunning(String),
    /// No open permission request has this id: it was answered, its turn ended, or it never was.
    NotOpen(String),
    /// The session was cleaned up, so it cannot be resumed.
    CleanedUp(String),
    /// The session ended with its client, so it is never resumed.
    EndedWithClient(String),
    /// The session said it cannot be resumed.
    CannotResume(String),
    NoQuestion(String),
    /// The session was handed over to Terminal; only taking it back resumes it.
    HandedOver(String),
    /// The harness has shut down, or is shutting down.
    ShutDown,
    /// A Unix socket path this platform cannot take.
    SocketPathTooLong { path: PathBuf, len: usize, max: usize },
    /// The client's token was not proven, or the request is not one a client may make.
    Refused(String),
    /// What the harness answered when it refused a call or a proof, as it said it.
    Said(String),
    /// A message over the limit of the client API, which the client did not send.
    TooLarge { len: usize, max: usize },
    /// The other side broke the protocol, or the connection failed.
    Protocol(String),
    Driver(String),
    /// A script or recording that cannot be read or replayed: the file and line, and why.
    Script(String),
    /// The driver could not open the agent, and says why.
    Open { kind: crate::event::FailKind, message: String },
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InUse(dir) => write!(f, "another harness is using the data folder {}", dir.display()),
            Error::NotPrivate(dir) => write!(f, "the data folder {} is not yours alone", dir.display()),
            Error::DanglingLink(dir) => write!(f, "the data folder {} is a link to nothing", dir.display()),
            Error::NewerStore(steps) => write!(f, "the store has {steps} migration steps; this harness is older and knows fewer"),
            Error::NoSuchSession(id) => write!(f, "no session {id}"),
            Error::NoSuchProvider(name) => write!(f, "no provider {name}"),
            Error::Running(id) => write!(f, "session {id} is running"),
            Error::NotRunning(id) => write!(f, "session {id} is not running"),
            Error::NotOpen(id) => write!(f, "no open permission request {id}: it was answered, its turn ended, or it never was"),
            Error::CleanedUp(id) => write!(f, "session {id} was cleaned up"),
            Error::EndedWithClient(id) => write!(f, "session {id} ended with its client and is not resumed"),
            Error::CannotResume(id) => write!(f, "session {id} said it cannot be resumed"),
            Error::NoQuestion(id) => write!(f, "no open question {id}"),
            Error::HandedOver(id) => write!(f, "session {id} was handed over to Terminal: resume it only once you have taken it back"),
            Error::ShutDown => write!(f, "the harness has shut down"),
            Error::SocketPathTooLong { path, len, max } => {
                write!(f, "the socket path {} is {len} bytes, and this platform takes at most {max}: use a shorter data folder", path.display())
            }
            Error::Refused(why) => write!(f, "refused: {why}"),
            Error::Said(what) => write!(f, "{what}"),
            Error::TooLarge { len, max } => write!(f, "the message is {len} bytes, over the {max}-byte limit of the client API"),
            Error::Protocol(why) => write!(f, "the connection failed: {why}"),
            Error::Driver(message) => write!(f, "the driver failed: {message}"),
            Error::Script(message) => write!(f, "{message}"),
            Error::Open { kind, message } => write!(f, "the agent could not start ({kind:?}): {message}"),
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
