//! The client API: JSON text messages on a WebSocket, over a Unix socket in the data folder. The harness speaks
//! first with a [`Hello`]; the client answers it ([`Proof`]) and then sends [`Call`]s. The harness answers each call
//! by its id, and pushes the events of the sessions the client opened or watches.
//!
//! Limits: a message is at most [`MAX_MESSAGE`] each way, and at most [`BEFORE_PROOF_MAX`] until the proof holds. The
//! client module refuses to send a larger call and the connection goes on; a larger message from another client closes
//! its connection with code 1009. An
//! event's body is at most `event::EVENT_MAX`; a larger one is cut and says by how much. `events` answers in pages of
//! about [`PAGE_BYTES`].
//!
//! No call resumes a session yet: H10 adds resuming after a restart, and H14 adds taking a handed-over session back.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::event::{Decision, Event};

/// The largest message either side sends or takes. A client's call over it is refused before it is sent.
pub const MAX_MESSAGE: usize = 8 << 20;
/// The largest message a connection may send before its proof holds. A proof is about 80 bytes.
pub const BEFORE_PROOF_MAX: usize = 4096;
/// About how much one `events` answer holds: the stored payload of its events.
pub const PAGE_BYTES: usize = 4 << 20;

/// Changes when a client of the last protocol could no longer talk to this harness. The hello, the proof, the answer to
/// the proof (`client::not_proven` reads its refusal) and `shutdown`, still behind the proof, keep their shape in every
/// protocol, so an app of one protocol can stop a harness of another without killing a process it cannot prove is that
/// harness.
pub const PROTOCOL: u32 = 1;
pub const SOCKET: &str = "harness.sock";
/// The descriptor file beside the socket, while the harness serves.
pub const DESCRIPTOR: &str = "harness.json";
/// The bytes a Unix socket path may have, with its closing zero: `sun_path` is 104 bytes on macOS and 108 on Linux.
pub const SOCKET_PATH_MAX: usize = if cfg!(target_os = "macos") { 104 } else { 108 };

/// The socket's path in the data folder `dir`, or why the platform cannot take it.
pub fn socket_path(dir: &Path) -> Result<PathBuf> {
    let path = dir.join(SOCKET);
    let len = path.as_os_str().len();
    if len >= SOCKET_PATH_MAX {
        return Err(Error::SocketPathTooLong { path, len, max: SOCKET_PATH_MAX - 1 });
    }
    Ok(path)
}

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
    /// Answers `{"session": id}` once the agent has opened. The client gets the session's events from the first.
    /// Every field but `provider` may be left out. Before any agent starts, and before anything is cloned, the
    /// harness refuses with the reason: a provider it has no driver for; both `cwd` and `repo`, or neither; `base` or
    /// `branch` without `repo`; a `repo` that is not `owner/name` of letters, digits, `.`, `_` and `-` (`valid_repo`);
    /// a `base` or `branch` that is not one plain folder name (`work::valid_ref`: no slash, no `..`, not starting with
    /// `-` or `.`); a `login` its provider has no folder for, that breaks the folder rules of `provider_folder`, or
    /// that is not there; an `effort` that is not a lowercase word of at most 16 letters.
    Open {
        provider: String,
        /// The folder the agent works in, used as it is. Give this or `repo`.
        #[serde(default)]
        cwd: Option<PathBuf>,
        /// `owner/name` on GitHub. The harness clones it into its work root (`~/Gossamr/agents`), or fetches the clone
        /// there, and the agent works in a new worktree beside it. Give this or `cwd`.
        #[serde(default)]
        repo: Option<String>,
        /// With `repo`: the remote branch the worktree starts from. Left out, the remote's default branch.
        #[serde(default)]
        base: Option<String>,
        /// With `repo`: the new branch of the worktree. Left out, `harness-` and 8 hex digits. A branch or folder that
        /// is already there is refused. Clean-up removes both, never forcing: unpushed work stays, and so does the session.
        #[serde(default)]
        branch: Option<String>,
        #[serde(default)]
        locked: bool,
        #[serde(default)]
        model: Option<String>,
        /// The login folder, as typed (`~` allowed). Left out, the provider's usual setup, as the person's shell has it.
        #[serde(default)]
        login: Option<String>,
        /// Left out, the provider's own.
        #[serde(default)]
        effort: Option<String>,
        /// The session is closed when this connection ends, and is never resumed.
        #[serde(default)]
        ends_with_client: bool,
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
    /// Answers an open question. Until `ask` holds the agent's call (H5b), the answer reaches the agent as its next
    /// prompt.
    AnswerQuestion { session: String, question: String, text: String },
    Close { session: String },
    /// Closes the session as handed over to Terminal, keeping its provider id for a later resume.
    HandOver { session: String },
    CleanUp { session: String },
    Sessions,
    /// Answers `{"drivers": [...], "logins": [...]}`: each driver's name and capabilities, and how each login stands
    /// (`providers::Standing`): the usual setup of every provider of the table, then each of `logins`. A login is
    /// checked with its CLI's own status command and the shell this connection captured.
    Providers {
        #[serde(default)]
        logins: Vec<crate::providers::Asked>,
    },
    /// Answers `{"events": [...], "more": bool}`: the stored events after `after`, about `PAGE_BYTES` of them. With
    /// `more`, ask again after the last one.
    Events { session: String, #[serde(default)] after: u64 },
    /// Pushes the stored events after `after`, then every live one until the session closes, then an end.
    Watch { session: String, #[serde(default)] after: u64 },
    /// Adds a token by its stored key, in hex. The client keeps the token; it never crosses the socket.
    TokenNew { stored_key: String },
    /// Answers each token's id and when it was made, and which one this connection proved: never a key.
    TokenList,
    /// Revokes a token; its connections are closed at their next call. The last token cannot be revoked.
    TokenRevoke { token: i64 },
    /// Stops every session and the harness, and frees the data folder; answers once that is done.
    Shutdown,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_a_call_keeps_its_own_id_whatever_its_op_holds() {
        // An op's field named `id` would collide with the call's own once flattened into it.
        for op in [Op::TokenRevoke { token: 5 }, Op::Answer { session: "s".into(), request: "p1".into(), decision: Decision::Allow, message: None }, Op::Sessions] {
            let call = Call { id: 7, op };
            let text = serde_json::to_string(&call).unwrap();
            assert_eq!(text.matches("\"id\"").count(), 1, "{text}");
            assert_eq!(serde_json::from_str::<Call>(&text).unwrap(), call);
        }
    }
}
