//! The one interface every provider sits behind. A driver starts an agent and turns what the agent says into
//! [`Body`] events; what a provider cannot do is a capability flag, named by what it lets the client do or expect.

use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::event::{Body, Decision};

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
    /// The session's tools token. Every start and every resume gets a new one.
    pub tools_token: Secret,
    /// The session's tools endpoint, when it has one.
    pub tools_url: Option<String>,
}

/// What the client asks of a running agent.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Prompt(String),
    Answer { id: String, decision: Decision },
    ToolResult { id: String, output: Value, error: bool },
    Cancel,
    Stop,
}

/// A running agent. It is gone when `output` closes.
pub struct Link {
    pub commands: UnboundedSender<Command>,
    pub output: UnboundedReceiver<Body>,
}

pub trait Driver: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    /// Starts the agent, or resumes it when `launch.resume` names its session. The first event is `Started`.
    fn open(&self, launch: Launch) -> Result<Link, String>;
}
