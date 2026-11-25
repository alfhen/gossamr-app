//! What a session says. A client reads these in the order of their sequence number.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The most an event's body may hold, as JSON, after redaction. A larger one is cut before it is stored or sent.
pub const EVENT_MAX: usize = 1 << 20;

/// One event of a session. `seq` starts at 1 for each session and never repeats. An event numbered 0 was not stored:
/// what the session says when its store fails.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub ms: i64,
    #[serde(flatten)]
    pub body: Body,
    /// The event was over `EVENT_MAX`: this many bytes were cut from the end of its private fields, which then hold
    /// text where they held JSON. Kept for a locked session too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Body {
    /// The provider's session began, or began again on a resume. A resume names `provider_session`.
    Started { provider_session: String, resumed: bool },
    Prompted { text: String },
    /// The prompt waits because the limit of sessions in a turn is reached.
    Waiting,
    /// Prompts the agent never got were dropped: a cancel dropped those that waited for a slot, or the session stopped
    /// with prompts still queued.
    PromptsDropped,
    /// A turn began, prompted or not. A driver sends it once per turn, before anything the turn says, and ends every
    /// turn it starts with exactly one `turn_ended` or `failed`.
    TurnStarted,
    /// A whole block of the agent's text, masked before anyone sees it. A driver that reads text in pieces joins them
    /// and sends the block once it ends; streamed pieces come with H15.
    Text { text: String },
    ToolCall { id: String, name: String, input: Value },
    /// A call to a tool the client declared. The client posts its result.
    ClientToolCall { id: String, name: String, input: Value },
    ToolResult { id: String, output: Value, error: bool },
    /// The id is the harness's own, unique in the session across restarts and resumes, not the provider's.
    Permission { id: String, kind: PermissionKind, tool: String, input: Value },
    /// The agent withdrew a permission request before it was answered; an answer to it is refused from now on.
    PermissionClosed { id: String },
    Answered {
        id: String,
        decision: Decision,
        #[serde(default)]
        message: Option<String>,
    },
    Question { id: String, text: String },
    /// An open question was closed: answered, or ended with the session, a hand-over or a turn a deny ended. After
    /// anything but an answer, its answer is refused.
    QuestionClosed { id: String, how: QuestionEnd },
    /// What the agent gave as its work's result, through the endpoint's `result` tool, after it fit the session's
    /// result schema.
    Result { data: Value },
    /// What a turn used, by the provider's own count: tokens in and out, those read from and written to its prompt
    /// cache, and the cost in US dollars when the provider gives one. Sent before the turn's end.
    Usage { input_tokens: u64, output_tokens: u64, cache_read_tokens: u64, cache_creation_tokens: u64, cost_usd: Option<f64> },
    TurnEnded { how: TurnEnd },
    /// The turn failed, or the session could not start or go on. Either way no turn is running after it.
    Failed { kind: FailKind, reason: String },
    /// A word from the harness about the session, for the person: say, that it starts from what was fetched before.
    Notice { text: String },
    /// The session was handed over to Terminal; `closed` follows. Its provider id is kept, to resume it there.
    HandedOver,
    /// The session's last event of this start. `by` says why it ended.
    Closed {
        #[serde(default)]
        by: ClosedBy,
    },
    /// What the store gives back for an event whose private fields it does not keep: a locked session's, one dropped
    /// at clean-up or by age, one too large to keep even when cut, or one of a type this build does not know (so a later step can add an event without a
    /// migration). `of` is the event's type, and `kept` its fields that are not private (ids, kinds, decisions, how
    /// a turn ended).
    Withheld {
        of: String,
        #[serde(default, skip_serializing_if = "Map::is_empty")]
        kept: Map<String, Value>,
    },
}

/// Why a session's start ended, in its `closed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClosedBy {
    /// The harness shut down, and stopped it.
    Shutdown,
    /// A client's Stop (`close`).
    Stop,
    /// It was handed over to Terminal.
    HandOver,
    /// The agent exited by itself, or crashed (a fault signal, or a SIGKILL from outside), or its driver failed, or
    /// it went and its driver did not say how. A turn it cut says the signal in its `failed`.
    Agent,
    /// It ended with its client, which left.
    ClientLeft,
    /// Its agent's process was ended by a signal the harness did not send of those a logout or a restart sends first:
    /// SIGTERM, SIGHUP or SIGINT. A fault signal (SIGABRT, SIGSEGV and the like) or a SIGKILL from outside is the
    /// agent's own end, `agent`. Only a driver that says how its agent ended tells this from `agent`.
    Signal,
    /// The harness could not go on with it: its store failed, or it stopped an agent whose session id looks like a
    /// secret, or it went without a shutdown and the next one stopped the agent it left, or found it gone.
    Harness,
    /// A value this build does not know, or a `closed` from a harness that did not say.
    #[default]
    #[serde(other)]
    Unknown,
}

/// The fields a withheld event keeps, because they hold no text the agent or the person wrote. A field not on this
/// list is dropped, so a new one stays private until someone adds it here; `PRIVATE_FIELDS` lists those that must be.
/// `name` and `tool` are tool identifiers (`Bash`, `run_command`, `mcp__x__ask`), never a title or a command line: a
/// driver puts those in `input`.
pub const KEPT_FIELDS: &[&str] = &[
    "provider_session", "resumed", "id", "name", "kind", "tool", "decision", "how", "error", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_creation_tokens", "cost_usd", "by",
];

/// Fields that can hold what the agent or the person wrote. Every field of every event is on one of the two lists.
pub const PRIVATE_FIELDS: &[&str] = &["text", "input", "output", "reason", "message", "data"];

/// The body within `max` bytes of JSON, and how many bytes were cut to get there, if any. Only private fields are cut,
/// the largest first, from their end; a field that held JSON then holds the start of its text. A body that is still
/// over `max` with its private fields empty, because its kept fields are, becomes `withheld` with nothing kept, and
/// says its whole size was cut.
pub fn fit(body: Body, max: usize) -> (Body, Option<u64>) {
    let (cut, dropped) = cut(body, max);
    let size = serde_json::to_string(&cut).map_or(usize::MAX, |text| text.len());
    match (size > max, dropped) {
        (true, _) => (Body::Withheld { of: cut.type_name(), kept: Map::new() }, Some((size as u64).saturating_add(dropped))),
        (false, 0) => (cut, None),
        (false, dropped) => (cut, Some(dropped)),
    }
}

fn cut(body: Body, max: usize) -> (Body, u64) {
    let size = |value: &Value| serde_json::to_string(value).map_or(0, |text| text.len());
    let mut value = serde_json::to_value(&body).expect("a body always serializes");
    let mut dropped = 0;
    while size(&value) > max {
        let over = size(&value) - max;
        let Value::Object(fields) = &mut value else { unreachable!("a body is an object") };
        let largest = PRIVATE_FIELDS.iter().filter(|name| fields.contains_key(**name)).max_by_key(|name| size(&fields[**name]));
        // Nothing left to cut when the largest private field is empty: the kept fields are over by themselves.
        let Some(field) = largest.and_then(|name| fields.get_mut(*name)).filter(|field| size(field) > 2) else { break };
        let text = match field.take() {
            Value::String(text) => text,
            other => other.to_string(),
        };
        // Escapes make the JSON longer than the text, so cut at least what is over and loop until it fits.
        let mut keep = text.len().saturating_sub(over.max(text.len() / 8));
        while !text.is_char_boundary(keep) {
            keep -= 1;
        }
        dropped += (text.len() - keep) as u64;
        *field = Value::String(text[..keep].to_owned());
    }
    match dropped {
        0 => (body, 0),
        _ => (serde_json::from_value(value).expect("a cut body is the same body"), dropped),
    }
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

/// What closed a question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionEnd {
    Answered,
    /// The session was stopped. A harness that shuts down closes none: they are answered after it starts again.
    Stopped,
    HandedOver,
    /// A deny ended the turn whose `ask` call held it.
    Denied,
    /// The session was cleaned up with it open.
    CleanedUp,
    /// The session can never be resumed (it ended with its client, or cannot be), so no answer can reach it.
    NotResumable,
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
            Body::Text { .. } => 5,
            Body::ToolCall { .. } => 6,
            Body::ClientToolCall { .. } => 7,
            Body::ToolResult { .. } => 8,
            Body::Permission { .. } => 9,
            Body::PermissionClosed { .. } => 10,
            Body::Answered { .. } => 11,
            Body::Question { .. } => 12,
            Body::QuestionClosed { .. } => 13,
            Body::Result { .. } => 14,
            Body::Usage { .. } => 15,
            Body::TurnEnded { .. } => 16,
            Body::Failed { .. } => 17,
            Body::Notice { .. } => 18,
            Body::HandedOver => 19,
            Body::Closed { .. } => 20,
            Body::Withheld { .. } => 21,
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
            Body::Text { text: "t".into() },
            Body::ToolCall { id: "i".into(), name: "n".into(), input: json!({}) },
            Body::ClientToolCall { id: "i".into(), name: "n".into(), input: json!({}) },
            Body::ToolResult { id: "i".into(), output: json!("o"), error: false },
            Body::Permission { id: "i".into(), kind: PermissionKind::Tool, tool: "t".into(), input: json!({}) },
            Body::PermissionClosed { id: "i".into() },
            Body::Answered { id: "i".into(), decision: Decision::Deny, message: None },
            Body::Question { id: "i".into(), text: "t".into() },
            Body::QuestionClosed { id: "i".into(), how: QuestionEnd::Stopped },
            Body::Result { data: json!({}) },
            Body::Usage { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4, cost_usd: None },
            Body::TurnEnded { how: TurnEnd::Done },
            Body::Failed { kind: FailKind::Provider, reason: "r".into() },
            Body::Notice { text: "t".into() },
            Body::HandedOver,
            Body::Closed { by: ClosedBy::Stop },
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

    #[test]
    fn limits_a_body_over_the_cap_is_cut_in_its_private_fields_and_says_by_how_much() {
        let small = Body::Text { text: "short".into() };
        assert_eq!(fit(small.clone(), 100), (small, None), "under the cap, nothing changes");

        let (text, dropped) = fit(Body::Text { text: "a".repeat(1000) }, 100);
        let Body::Text { text } = text else { unreachable!() };
        assert!(serde_json::to_string(&Body::Text { text: text.clone() }).unwrap().len() <= 100);
        assert_eq!(dropped, Some((1000 - text.len()) as u64));

        // Control characters take six bytes each as JSON.
        let (escaped, _) = fit(Body::Text { text: "\u{1}".repeat(1000) }, 100);
        assert!(serde_json::to_string(&escaped).unwrap().len() <= 100, "escapes are counted");

        let input = json!({ "file": "b".repeat(1000) });
        let (call, dropped) = fit(Body::ToolCall { id: "t1".into(), name: "Read".into(), input }, 200);
        let Body::ToolCall { id, name, input } = call else { unreachable!() };
        assert_eq!((id.as_str(), name.as_str()), ("t1", "Read"), "kept fields stay whole");
        assert!(input.as_str().is_some_and(|text| text.starts_with("{\"file\":\"bbb")), "JSON becomes the start of its text");
        assert!(dropped.is_some_and(|dropped| dropped > 0));

        // Kept fields over the cap by themselves: nothing to cut, so the event is kept as `withheld`, and ends.
        let call = Body::ToolCall { id: "t1".into(), name: "n".repeat(1000), input: json!("") };
        let (call, dropped) = fit(call, 100);
        assert_eq!(call, Body::Withheld { of: "tool_call".into(), kept: Map::new() });
        assert!(dropped.is_some_and(|dropped| dropped > 1000), "it says its whole size was cut");
        let started = Body::Started { provider_session: "p".repeat(1000), resumed: false };
        let (started, dropped) = fit(started, 100);
        assert!(matches!(started, Body::Withheld { ref of, .. } if of == "started") && dropped.is_some(), "no private field to cut");
    }
}
