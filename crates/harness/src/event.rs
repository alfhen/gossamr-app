//! What a session says. A client reads these in the order of their sequence number.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One event of a session. `seq` starts at 1 for each session and never repeats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub ms: i64,
    #[serde(flatten)]
    pub body: Body,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Body {
    /// The provider's session began, or began again on a resume. A resume names `provider_session`.
    Started { provider_session: String, resumed: bool },
    Prompted { text: String },
    /// The prompt waits because the limit of sessions in a turn is reached.
    Waiting,
    Text { text: String },
    ToolCall { id: String, name: String, input: Value },
    /// A call to a tool the client declared. The client posts its result.
    ClientToolCall { id: String, name: String, input: Value },
    ToolResult { id: String, output: Value, error: bool },
    Permission { id: String, kind: PermissionKind, tool: String, input: Value },
    Answered { id: String, decision: Decision },
    Question { id: String, text: String },
    TurnEnded { how: TurnEnd },
    /// The turn failed, or the session could not start. Either way no turn is running after it.
    Failed { reason: String },
    Closed,
    /// What the store gives back for an event whose payload it does not keep: a locked session's, or one dropped
    /// at clean-up or by age. `of` is the event's type.
    Withheld { of: String },
}

impl Body {
    pub fn type_name(&self) -> String {
        let value = serde_json::to_value(self).expect("a body always serializes");
        value["type"].as_str().expect("every body has a type").to_owned()
    }

    /// No turn is running after this event.
    pub fn ends_turn(&self) -> bool {
        matches!(self, Body::TurnEnded { .. } | Body::Failed { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    Command,
    FileChange,
    /// A wider sandbox or more access for the rest of the turn.
    Permissions,
    /// A call of a named tool, an MCP tool among them.
    Tool,
}

/// An answer to a permission request. It holds for that one request: no answer is ever "always".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEnd {
    Done,
    Cancelled,
    /// A deny ended the turn, so no "carry on" may follow it.
    Denied,
}
