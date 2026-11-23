//! The client API: JSON text messages on a WebSocket, over a Unix socket in the data folder. The harness speaks
//! first with a [`Hello`]; the client answers its challenge ([`Proof`]) and then sends [`Call`]s. The harness answers
//! each call by its id, and pushes the events of the sessions the client opened or watches.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::{Decision, Event};

/// Changes when a client of the last protocol could no longer talk to this harness.
pub const PROTOCOL: u32 = 1;
pub const SOCKET: &str = "harness.sock";
/// The descriptor file beside the socket, while the harness serves.
pub const DESCRIPTOR: &str = "harness.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub build: String,
    /// 32 random bytes in hex, new for each connection.
    pub challenge: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    pub proof: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Descriptor {
    pub protocol: u32,
    pub build: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub id: u64,
    #[serde(flatten)]
    pub op: Op,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Answers `{"session": id}`. The client gets the session's events from the first.
    Open {
        provider: String,
        cwd: PathBuf,
        #[serde(default)]
        locked: bool,
        #[serde(default)]
        model: Option<String>,
    },
    Send { session: String, text: String },
    Cancel { session: String },
    Answer {
        session: String,
        request: String,
        decision: Decision,
        #[serde(default)]
        message: Option<String>,
    },
    ToolResult {
        session: String,
        call: String,
        output: Value,
        #[serde(default)]
        error: bool,
    },
    Close { session: String },
    CleanUp { session: String },
    Sessions,
    Providers,
    /// Answers the stored events after `after`.
    Events { session: String, #[serde(default)] after: u64 },
    /// Pushes the stored events after `after`, then every live one until the session closes, then an end.
    Watch { session: String, #[serde(default)] after: u64 },
    /// Adds a token by its stored key, in hex. The client keeps the token; it never crosses the socket.
    TokenNew { stored_key: String },
}

/// What the harness sends after the hello: an answer to a call (`id` with `ok` or `error`), an event of a session
/// (`session` with `event`), or the end of a watch (`session` with `end`). The answer to a proof has no id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<Event>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub end: bool,
}
