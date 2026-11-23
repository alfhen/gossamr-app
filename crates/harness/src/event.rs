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
    /// A cancel dropped the prompts that waited for a slot; no turn had started.
    PromptsDropped,
    /// A turn began, prompted or not. A driver sends it once per turn, before anything the turn says, and ends every
    /// turn it starts with exactly one `turn_ended` or `failed`.
    TurnStarted,
    /// A piece of text as it streams, for live output only: it is never stored, and is numbered 0. A driver that
    /// streams sends the whole block as one `Text` after its pieces. Live text fails closed: from anything that could
    /// start a secret it is held until it is decided, and what is undecided when the block ends (a `text`,
    /// `turn_ended`, `failed` or `closed`) is sent as the mask. So live text may trail other events of the turn, by
    /// what it holds from a marker on, up to `redact::HOLD_BACK` bytes, or to the end of a private key.
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
        #[serde(default)]
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

/// The fields a withheld event keeps, because they hold no text the agent or the person wrote. A field not on this
/// list is dropped, so a new one stays private until someone adds it here; `PRIVATE_FIELDS` lists those that must be.
/// `name` and `tool` are tool identifiers (`Bash`, `run_command`, `mcp__x__ask`), never a title or a command line: a
/// driver puts those in `input`.
pub const KEPT_FIELDS: &[&str] = &["provider_session", "resumed", "id", "name", "kind", "tool", "decision", "how", "error"];

/// Fields that can hold what the agent or the person wrote. Every field of every event is on one of the two lists.
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
        kept.retain(|field, _| KEPT_FIELDS.contains(&field.as_str()));
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
    /// The agent has not gone though it was killed; the session stays running until it does.
    Stuck,
    /// The driver broke its contract, for example a turn it ended but never started.
    Driver,
    /// The harness itself could not go on, for example its store.
    Harness,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Where each variant's sample sits. The match is exhaustive, so a new variant needs an arm here, and the test
    /// then fails until `samples` has one at that place.
    fn place(body: &Body) -> usize {
        match body {
            Body::Started { .. } => 0,
            Body::Prompted { .. } => 1,
            Body::Waiting => 2,
            Body::PromptsDropped => 3,
            Body::TurnStarted => 4,
            Body::TextDelta { .. } => 5,
            Body::Text { .. } => 6,
            Body::ToolCall { .. } => 7,
            Body::ClientToolCall { .. } => 8,
            Body::ToolResult { .. } => 9,
            Body::Permission { .. } => 10,
            Body::Answered { .. } => 11,
            Body::Question { .. } => 12,
            Body::TurnEnded { .. } => 13,
            Body::Failed { .. } => 14,
            Body::Closed => 15,
            Body::Withheld { .. } => 16,
        }
    }

    /// One of each event but `withheld`, which the store makes. Every field is set, and an `Option` field
    /// serializes even when it is `None`, so the test sees every field.
    fn samples() -> Vec<Body> {
        vec![
            Body::Started { provider_session: "p".into(), resumed: false },
            Body::Prompted { text: "t".into() },
            Body::Waiting,
            Body::PromptsDropped,
            Body::TurnStarted,
            Body::TextDelta { text: "t".into() },
            Body::Text { text: "t".into() },
            Body::ToolCall { id: "i".into(), name: "n".into(), input: json!({}) },
            Body::ClientToolCall { id: "i".into(), name: "n".into(), input: json!({}) },
            Body::ToolResult { id: "i".into(), output: json!("o"), error: false },
            Body::Permission { id: "i".into(), kind: PermissionKind::Tool, tool: "t".into(), input: json!({}) },
            Body::Answered { id: "i".into(), decision: Decision::Deny, message: None },
            Body::Question { id: "i".into(), text: "t".into() },
            Body::TurnEnded { how: TurnEnd::Done },
            Body::Failed { kind: FailKind::Provider, reason: "r".into() },
            Body::Closed,
        ]
    }

    #[test]
    fn withheld_there_is_a_sample_of_every_event_and_each_serializes_every_field() {
        let places: Vec<usize> = samples().iter().map(place).collect();
        let withheld = place(&Body::Withheld { of: String::new(), kept: Map::new() });
        assert_eq!(places, (0..withheld).collect::<Vec<_>>(), "one sample of each event, in place");
        let answered = serde_json::to_value(Body::Answered { id: "i".into(), decision: Decision::Deny, message: None }).unwrap();
        assert!(answered.get("message").is_some(), "an `Option` field that is `None` is still a field");
    }

    #[test]
    fn withheld_every_field_of_every_event_is_classified_kept_or_private() {
        for body in samples() {
            let Value::Object(fields) = serde_json::to_value(&body).unwrap() else { unreachable!() };
            for field in fields.keys().filter(|field| *field != "type") {
                let kept = KEPT_FIELDS.contains(&field.as_str());
                let private = PRIVATE_FIELDS.contains(&field.as_str());
                assert!(kept ^ private, "`{field}` of `{}` must be on exactly one of KEPT_FIELDS and PRIVATE_FIELDS", body.type_name());
            }
            let Body::Withheld { kept, .. } = body.withheld() else { unreachable!() };
            assert!(kept.keys().all(|field| KEPT_FIELDS.contains(&field.as_str())), "{kept:?}");
        }
    }
}
