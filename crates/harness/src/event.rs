//! What a session says. A client reads these in the order of their sequence number.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One event of a session. `seq` starts at 1 for each session and never repeats. An event numbered 0 was not stored:
/// a `text_delta`, or what the session says when its store fails.
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
    /// A turn began, prompted or not. A driver sends it once per turn, before anything the turn says.
    TurnStarted,
    /// A piece of text as it streams, for live output only: it is never stored. A driver that streams sends the whole
    /// block as one `Text` after its pieces, and redaction holds back the end of the stream until a secret cut between
    /// two pieces can be masked whole.
    TextDelta { text: String },
    /// A whole block of the agent's text. This is what is stored: a driver joins its pieces before it sends one.
    Text { text: String },
    ToolCall { id: String, name: String, input: Value },
    /// A call to a tool the client declared. The client posts its result.
    ClientToolCall { id: String, name: String, input: Value },
    ToolResult { id: String, output: Value, error: bool },
    /// The id is the harness's own, unique in the session across restarts and resumes, not the provider's.
    Permission { id: String, kind: PermissionKind, tool: String, input: Value },
    Answered {
        id: String,
        decision: Decision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Question { id: String, text: String },
    TurnEnded { how: TurnEnd },
    /// The turn failed, or the session could not start or go on. Either way no turn is running after it.
    Failed { kind: FailKind, reason: String },
    Closed,
    /// What the store gives back for an event whose private fields it does not keep: a locked session's, a text delta,
    /// one dropped at clean-up or by age, or one of a type this build does not know. `of` is the event's type, and
    /// `kept` its fields that are not private (ids, kinds, decisions, how a turn ended).
    Withheld {
        of: String,
        #[serde(default, skip_serializing_if = "Map::is_empty")]
        kept: Map<String, Value>,
    },
}

/// Fields that can hold what the agent or the person wrote. A withheld event keeps every other field.
pub const PRIVATE_FIELDS: &[&str] = &["text", "input", "output", "reason", "message"];

impl Body {
    pub fn type_name(&self) -> String {
        let value = serde_json::to_value(self).expect("a body always serializes");
        value["type"].as_str().expect("every body has a type").to_owned()
    }

    /// No turn is running after this event.
    pub fn ends_turn(&self) -> bool {
        matches!(self, Body::TurnEnded { .. } | Body::Failed { .. })
    }

    /// The event without its private fields.
    pub fn withheld(&self) -> Body {
        if let Body::Withheld { .. } = self {
            return self.clone();
        }
        let Value::Object(mut kept) = serde_json::to_value(self).expect("a body always serializes") else {
            unreachable!("a body is an object")
        };
        let of = kept.remove("type").and_then(|of| of.as_str().map(str::to_owned)).unwrap_or_default();
        for field in PRIVATE_FIELDS {
            kept.remove(*field);
        }
        Body::Withheld { of, kept }
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

/// Why a turn or a session failed, so a client can say what to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailKind {
    SignedOut,
    VersionNotSupported,
    /// The provider reported an error.
    Provider,
    /// The agent went away, or would not stop.
    AgentStopped,
    /// The harness itself could not go on, for example its store.
    Harness,
}
