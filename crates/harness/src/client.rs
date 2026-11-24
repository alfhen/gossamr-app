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
use crate::event::Event;

/// What the harness pushes: an event of a session, or the end of a watch.
#[derive(Debug, Clone, PartialEq)]
pub enum Push {
    Event { session: String, event: Event },
    End { session: String },
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
        tokio::time::timeout(limit, Client::prove(dir, token)).await.map_err(|_| silent())?
    }

    async fn prove(dir: &Path, token: &Token) -> Result<Client> {
        let stream = UnixStream::connect(socket_path(dir)?).await?;
        let config = crate::server::config();
        let (ws, _) = client_async_with_config("ws://harness/", stream, Some(config)).await.map_err(|e| Error::Protocol(e.to_string()))?;
        let mut client = Client { ws, next_id: 0, pushes: VecDeque::new(), hello: Hello { protocol: 0, build: String::new(), challenge: String::new() } };
        let hello = client.read_text().await?;
        client.hello = serde_json::from_str(&hello)?;
        if client.hello.protocol != PROTOCOL {
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
        self.next_id += 1;
        let id = self.next_id;
        self.write(&Call { id, op }).await?;
        loop {
            let reply: Reply = self.read().await?;
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
            match self.read::<Reply>().await {
                Ok(reply) => self.pushes.extend(into_push(reply)),
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

fn into_push(reply: Reply) -> Option<Push> {
    let session = reply.session?;
    match reply.event {
        Some(event) => Some(Push::Event { session, event }),
        None => reply.end.then_some(Push::End { session }),
    }
}
