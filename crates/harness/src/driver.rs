//! The one interface every provider sits behind. A driver starts an agent and turns what the agent says into
//! [`Body`] events; what a provider cannot do is a capability flag, named by what it lets the client do or expect.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::event::{Body, Decision, FailKind};
use crate::tools::Endpoint;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Capabilities {
    /// A deny ends the agent's turn, so the client must not send "carry on" after it.
    pub deny_ends_turn: bool,
    /// How long the agent holds one tool call before it cuts it, if it cuts it at all. A tool that waits longer, such
    /// as `ask`, must return before this.
    pub tool_call_limit_ms: Option<u64>,
    /// Cancelling a turn can leave a command running, so a stop must also kill the agent's process tree.
    pub stop_kills_process_tree: bool,
    /// The provider can run the locked profile: its session advertises exactly the tools endpoint's tools.
    pub runs_locked_profile: bool,
    /// The agent may start a turn by itself after one ended, so events after a turn end still belong to the session.
    pub starts_turns_unprompted: bool,
    /// How long a stopped agent may take to go before the driver is told to kill it; the harness's default when the
    /// driver does not say.
    pub stop_takes_up_to_ms: Option<u64>,
}

/// A value that must never be printed or stored. `Debug` shows nothing of it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// 256 bits from the operating system's secure source, in hex.
    pub fn random() -> Secret {
        Secret(random_hex(32))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// `bytes` bytes from the operating system's secure source, in lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the operating system has a secure random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone)]
pub struct Launch {
    pub cwd: PathBuf,
    pub locked: bool,
    pub model: Option<String>,
    /// The provider's own session id, to resume it.
    pub resume: Option<String>,
    /// The session's tools token. Every start and every resume gets a new one, and the endpoint refuses the old.
    pub tools_token: Secret,
    /// The session's tools endpoint. A real agent reaches it over HTTP at its URL; the mock calls it in-process.
    pub tools: Arc<Endpoint>,
}

/// What the client asks of a running agent. Calls to the session's tools do not come this way: the agent makes them
/// to the tools endpoint.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Prompt(String),
    /// `id` is the driver's own id of the request. A deny can say why.
    Answer { id: String, decision: Decision, message: Option<String> },
    Cancel,
    /// Ends the session. The driver closes `output` once the agent is gone.
    Stop,
    /// Sent when a stopped agent has not gone in time: kill its process tree.
    Kill,
}

/// A running agent. It is gone when `output` closes.
pub struct Link {
    pub commands: UnboundedSender<Command>,
    pub output: UnboundedReceiver<Body>,
}

/// Why a driver could not open, with the kind a client acts on: signed out, a version it does not support, or another
/// provider error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenError {
    pub kind: FailKind,
    pub message: String,
}

/// A driver turns a provider into events. It sends `Started` as soon as it knows the provider's session id, which for
/// some providers is only after the first prompt. For every turn it starts with `TurnStarted`, prompted or not, it
/// sends exactly one `TurnEnded` or `Failed`; a session fails a turn that breaks this. It closes `output` once the
/// agent is gone.
pub trait Driver: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    /// Starts the agent, or resumes it when `launch.resume` names its session.
    fn open(&self, launch: Launch) -> Result<Link, OpenError>;
}
