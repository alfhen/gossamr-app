//! A client of the harness's API, for the command line and later for the app.

use std::collections::VecDeque;
use std::path::Path;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{WebSocketStream, client_async_with_config};

use crate::api::{Call, Hello, MAX_MESSAGE, Op, PROTOCOL, Proof, Reply, socket_path};
use crate::auth::{Token, encode};
use crate::error::{Error, Result};
use crate::event::{Body, Event};

/// What the harness pushes: an event of a session, the end of a watch, or the end of one that lost events, with why.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    Event { session: String, event: Event },
    End { session: String },
    Lost { session: String, reason: String },
}

pub struct Client {
    ws: WebSocketStream<UnixStream>,
    next_id: u64,
    pushes: VecDeque<Push>,
    pub hello: Hello,
}

impl Client {
    /// Connects to the harness serving the data folder `dir` and proves `token` by answering its hello, giving up after
    /// the harness's own limit for that.
    pub async fn connect(dir: &Path, token: &Token) -> Result<Client> {
        Client::connect_within(dir, token, crate::server::Limits::default().proof_within).await
    }

    pub async fn connect_within(dir: &Path, token: &Token, limit: Duration) -> Result<Client> {
        let silent = || Error::Protocol(format!("the harness did not answer within {} s", limit.as_secs_f32()));
        tokio::time::timeout(limit, Client::prove(dir, token, false)).await.map_err(|_| silent())?
    }

    /// Like `connect_within`, but proves `token` to a harness of any protocol, so that one of another protocol can be
    /// told to shut down: `hello.protocol` says which it speaks, and to one that is not `PROTOCOL` only `shutdown` is
    /// sent (see `api::PROTOCOL`).
    pub async fn connect_any_protocol(dir: &Path, token: &Token, limit: Duration) -> Result<Client> {
        let silent = || Error::Protocol(format!("the harness did not answer within {} s", limit.as_secs_f32()));
        tokio::time::timeout(limit, Client::prove(dir, token, true)).await.map_err(|_| silent())?
    }

    async fn prove(dir: &Path, token: &Token, any_protocol: bool) -> Result<Client> {
        let stream = UnixStream::connect(socket_path(dir)?).await?;
        let config = crate::server::config();
        let (ws, _) = client_async_with_config("ws://harness/", stream, Some(config)).await.map_err(|e| Error::Protocol(e.to_string()))?;
        let mut client = Client { ws, next_id: 0, pushes: VecDeque::new(), hello: Hello { protocol: 0, build: String::new(), challenge: String::new() } };
        let hello = client.read_text().await?;
        // A harness that turns the connection away says why instead of hello.
        if let Ok(Reply { error: Some(error), .. }) = serde_json::from_str::<Reply>(&hello) {
            return Err(Error::Said(error));
        }
        client.hello = serde_json::from_str(&hello)?;
        if client.hello.protocol != PROTOCOL && !any_protocol {
            return Err(Error::Protocol(format!("the harness speaks protocol {}, this client {PROTOCOL}", client.hello.protocol)));
        }
        client.write(&Proof { proof: encode(&token.answer(hello.as_bytes())) }).await?;
        let reply: Reply = client.read().await?;
        match reply.error {
            None => Ok(client),
            Some(error) => Err(Error::Said(error)),
        }
    }

    /// Every stored event of `session` after `after`, page by page, each handed to `each` in order.
    pub async fn events(&mut self, session: &str, after: u64, mut each: impl FnMut(Event)) -> Result<()> {
        let mut after = after;
        loop {
            let page = self.call(Op::Events { session: session.to_owned(), after }).await?;
            let events: Vec<Event> = serde_json::from_value(page["events"].clone())?;
            after = events.last().map_or(after, |event| event.seq);
            events.into_iter().for_each(&mut each);
            if page["more"] != Value::Bool(true) {
                return Ok(());
            }
        }
    }

    /// Makes a call and waits for its answer. Pushes that come meanwhile are kept for `push`.
    pub async fn call(&mut self, op: Op) -> Result<Value> {
        if self.hello.protocol != PROTOCOL && !matches!(op, Op::Shutdown) {
            return Err(Error::Protocol(format!("the harness speaks protocol {}, this client {PROTOCOL}: only `shutdown` is sent to it", self.hello.protocol)));
        }
        self.next_id += 1;
        let id = self.next_id;
        self.write(&Call { id, op }).await?;
        loop {
            let reply = decode_reply(&self.read_text().await?)?;
            if reply.id == Some(id) {
                return match reply.error {
                    Some(error) => Err(Error::Said(error)),
                    None => Ok(reply.ok.unwrap_or(Value::Null)),
                };
            }
            if let Some(push) = into_push(reply) {
                self.pushes.push_back(push);
            }
        }
    }

    /// The next push, waiting for it. None when the harness has closed the connection.
    pub async fn push(&mut self) -> Result<Option<Push>> {
        loop {
            if let Some(push) = self.pushes.pop_front() {
                return Ok(Some(push));
            }
            match self.read_text().await {
                Ok(text) => self.pushes.extend(into_push(decode_reply(&text)?)),
                Err(Error::Protocol(why)) if why == CLOSED => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }

    /// Sends a message, unless it is over the limit, which leaves the connection as it was.
    async fn write(&mut self, message: &impl serde::Serialize) -> Result<()> {
        let text = serde_json::to_string(message)?;
        if text.len() > MAX_MESSAGE {
            return Err(Error::TooLarge { len: text.len(), max: MAX_MESSAGE });
        }
        self.ws.send(Message::text(text)).await.map_err(|e| Error::Protocol(e.to_string()))
    }

    async fn read<T: DeserializeOwned>(&mut self) -> Result<T> {
        Ok(serde_json::from_str(&self.read_text().await?)?)
    }

    async fn read_text(&mut self) -> Result<String> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(text))) => return Ok(text.as_str().to_owned()),
                Some(Ok(Message::Close(_))) | None => return Err(Error::Protocol(CLOSED.into())),
                Some(Err(e)) => return Err(Error::Protocol(e.to_string())),
                Some(Ok(_)) => {}
            }
        }
    }
}

const CLOSED: &str = "the harness closed the connection";

/// What a harness of any protocol answers a proof of a token it does not hold.
const NOT_PROVEN: &str = "refused: the client did not prove a token";

/// Whether `connect` failed because the harness does not know the token, rather than being busy or gone.
pub fn not_proven(e: &Error) -> bool {
    matches!(e, Error::Said(said) if said == NOT_PROVEN)
}

/// A reply, with its event read on its own: one this build cannot read, from a newer harness of the same protocol,
/// comes as `withheld` with the fields every event may keep, so a client moves past its number instead of losing the
/// connection. A known event with a value this build does not know reads as that event, with the enum's `Other`.
fn decode_reply(text: &str) -> Result<Reply> {
    let mut value: Value = serde_json::from_str(text)?;
    let event = value.as_object_mut().and_then(|reply| reply.remove("event"));
    let mut reply: Reply = serde_json::from_value(value)?;
    reply.event = event.map(readable_event).transpose()?;
    Ok(reply)
}

fn readable_event(value: Value) -> Result<Event> {
    match serde_json::from_value::<Event>(value.clone()) {
        Ok(event) => Ok(event),
        Err(e) => match (value["seq"].as_u64(), value["type"].as_str()) {
            (Some(seq), Some(of)) => {
                let kept = value.as_object().map(|fields| fields.iter().filter(|(field, _)| crate::event::KEPT_FIELDS.contains(&field.as_str())).map(|(field, v)| (field.clone(), v.clone())).collect()).unwrap_or_default();
                Ok(Event { seq, ms: value["ms"].as_i64().unwrap_or(0), body: Body::Withheld { of: of.to_owned(), kept }, cut: None })
            }
            _ => Err(e.into()),
        },
    }
}

fn into_push(reply: Reply) -> Option<Push> {
    let session = reply.session?;
    match (reply.event, reply.error) {
        (Some(event), _) => Some(Push::Event { session, event }),
        (None, Some(reason)) if reply.end => Some(Push::Lost { session, reason }),
        (None, _) => reply.end.then_some(Push::End { session }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_of_a_type_this_build_does_not_know_comes_as_withheld_with_its_number() {
        let reply = decode_reply(r#"{"session":"s1","event":{"seq":5,"ms":7,"type":"progress","percent":40}}"#).unwrap();
        let Some(Push::Event { session, event }) = into_push(reply) else { panic!("an event") };
        assert_eq!((session.as_str(), event.seq, event.body), ("s1", 5, Body::Withheld { of: "progress".into(), kept: Default::default() }));
        let known = decode_reply(r#"{"session":"s1","event":{"seq":6,"ms":8,"type":"text","text":"hi"}}"#).unwrap();
        assert_eq!(known.event.map(|e| e.body), Some(Body::Text { text: "hi".into() }));
        assert!(decode_reply(r#"{"session":"s1","event":{"type":"progress"}}"#).is_err(), "with no number there is nothing to move past");
    }

    #[test]
    fn a_known_event_with_a_value_this_build_does_not_know_is_still_read_as_that_event() {
        let ended = decode_reply(r#"{"session":"s1","event":{"seq":7,"ms":1,"type":"turn_ended","how":"limit"}}"#).unwrap();
        assert_eq!(ended.event.map(|e| e.body), Some(Body::TurnEnded { how: crate::event::TurnEnd::Other }));
        let closed = decode_reply(r#"{"session":"s1","event":{"seq":8,"ms":1,"type":"question_closed","id":"q1","how":"expired"}}"#).unwrap();
        assert_eq!(closed.event.map(|e| e.body), Some(Body::QuestionClosed { id: "q1".into(), how: crate::event::QuestionEnd::Other }));
        let asked = decode_reply(r#"{"session":"s1","event":{"seq":9,"ms":1,"type":"permission","id":"p1","kind":"network","tool":"Fetch","input":{}}}"#).unwrap();
        assert!(matches!(asked.event.map(|e| e.body), Some(Body::Permission { kind: crate::event::PermissionKind::Other, .. })));
        let failed = decode_reply(r#"{"session":"s1","event":{"seq":10,"ms":1,"type":"failed","kind":"quota","reason":"over"}}"#).unwrap();
        assert_eq!(failed.event.map(|e| e.body), Some(Body::Failed { kind: crate::event::FailKind::Other, reason: "over".into() }));
        let odd = decode_reply(r#"{"session":"s1","event":{"seq":11,"ms":1,"type":"brand_new","id":"x1","how":"soon","text":"private"}}"#).unwrap();
        let Some(Body::Withheld { kept, .. }) = odd.event.map(|e| e.body) else { panic!("withheld") };
        assert_eq!((kept.get("id"), kept.get("how"), kept.get("text")), (Some(&serde_json::json!("x1")), Some(&serde_json::json!("soon")), None), "the kept fields, never a private one");
    }
}
