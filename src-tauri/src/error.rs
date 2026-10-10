use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Keychain error: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("Couldn't read the Keychain ({0}). Gossamr won't ask again until it is restarted")]
    KeychainUnavailable(String),
    #[error("Network error: {}", describe(.0))]
    Http(#[from] reqwest::Error),
    #[error("Unexpected response: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Add your Atlassian OAuth app's client ID and secret first")]
    NotConfigured,
    #[error("Not signed in to Jira")]
    NotSignedIn,
    #[error("You're now signed in to a different Jira site or account, so this was cancelled")]
    SiteChanged,
    #[error("Sign-in failed: {0}")]
    Auth(String),
    #[error("{0}")]
    Claude(String),
    #[error("{0}")]
    Proposal(String),
    /// A code host refused or failed a request; `message` is already written for the person.
    #[error("{message}")]
    CodeHost { status: u16, message: String },
    #[error("{message}")]
    RateLimited { message: String, retry_after_secs: u64 },
    /// GitHub refused a review because its commit or lines no longer match the pull request; already worded for the person.
    #[error("{0}")]
    ReviewOutdated(String),
    #[error("Jira returned {status}: {message}")]
    Api { status: u16, message: String },
}

/// The request's message with its causes appended ("connection reset", "dns error", "timed out"). Query strings are
/// dropped from the URL, and headers are never read.
fn describe(e: &reqwest::Error) -> String {
    let mut text = e.to_string();
    if let Some(url) = e.url().filter(|u| u.query().is_some()) {
        let mut bare = url.clone();
        bare.set_query(None);
        text = text.replace(url.as_str(), bare.as_str());
    }
    let mut cause = std::error::Error::source(e);
    while let Some(c) = cause {
        let part = c.to_string();
        if !text.contains(&part) {
            text.push_str(": ");
            text.push_str(&part);
        }
        cause = c.source();
    }
    text
}

/// Failures of the connection itself, which a later attempt may not see.
pub fn is_transport_failure(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout() || e.is_request() || e.is_body()
}

impl Error {
    /// A failure of the network or of the server's availability, which says nothing a person can act on.
    pub fn is_transient(&self) -> bool {
        match self {
            Error::Http(e) => is_transport_failure(e),
            Error::CodeHost { status, .. } => (500..600).contains(status),
            _ => false,
        }
    }
}

// Commands return errors to the frontend as plain messages.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_network_and_availability_failures_are_transient() {
        let host = |status| Error::CodeHost { status, message: String::new() };
        assert!(host(502).is_transient() && host(503).is_transient());
        assert!(!host(401).is_transient() && !host(403).is_transient() && !host(404).is_transient());
        assert!(!Error::RateLimited { message: String::new(), retry_after_secs: 5 }.is_transient());
        assert!(!Error::NotSignedIn.is_transient() && !Error::Auth("no".into()).is_transient());
    }
}
