//! A client of the harness's API, for the command line and later for the app.

use std::collections::VecDeque;
use std::path::Path;

use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{WebSocketStream, client_async};

use crate::api::{Call, Hello, Op, PROTOCOL, Proof, Reply, SOCKET};
use crate::auth::{Token, decode, encode};
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
    /// Connects to the harness serving the data folder `dir` and proves `token` by answering its challenge.
    pub async fn connect(dir: &Path, token: &Token) -> Result<Client> {
        let stream = UnixStream::connect(dir.join(SOCKET)).await?;
        let (ws, _) = client_async("ws://harness/", stream).await.map_err(|e| Error::Protocol(e.to_string()))?;
        let mut client = Client { ws, next_id: 0, pushes: VecDeque::new(), hello: Hello { protocol: 0, build: String::new(), challenge: String::new() } };
        client.hello = client.read().await?;
        if client.hello.protocol != PROTOCOL {
            return Err(Error::Protocol(format!("the harness speaks protocol {}, this client {PROTOCOL}", client.hello.protocol)));
        }
        let challenge = decode(&client.hello.challenge).ok_or_else(|| Error::Protocol("the challenge is not 32 bytes in hex".into()))?;
        client.write(&Proof { proof: encode(&token.answer(&challenge)) }).await?;
        let reply: Reply = client.read().await?;
        match reply.error {
            None => Ok(client),
            Some(error) => Err(Error::Refused(error)),
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
                    Some(error) => Err(Error::Refused(error)),
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

    async fn write(&mut self, message: &impl serde::Serialize) -> Result<()> {
        let text = serde_json::to_string(message)?;
        self.ws.send(Message::text(text)).await.map_err(|e| Error::Protocol(e.to_string()))
    }

    async fn read<T: DeserializeOwned>(&mut self) -> Result<T> {
        loop {
            match self.ws.next().await {
                Some(Ok(Message::Text(text))) => return Ok(serde_json::from_str(text.as_str())?),
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
