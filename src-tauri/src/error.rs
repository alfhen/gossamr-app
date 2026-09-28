use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Keychain error: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Unexpected response: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Add your Atlassian OAuth app's client ID and secret first")]
    NotConfigured,
    #[error("Not signed in to Jira")]
    NotSignedIn,
    #[error("The signed-in Jira site changed; the result was discarded")]
    SiteChanged,
    #[error("Sign-in failed: {0}")]
    Auth(String),
    #[error("{0}")]
    Claude(String),
    #[error("Jira returned {status}: {message}")]
    Api { status: u16, message: String },
}

// Commands return errors to the frontend as plain messages.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
