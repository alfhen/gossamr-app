//! `harness serve`: the client API on a Unix socket in the data folder, which only the user can open. Each connection
//! proves a client token first (see `auth`), then sends calls and gets the events of the sessions it opened or
//! watches.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{WebSocketStream, accept_async};

use crate::api::{Call, DESCRIPTOR, Descriptor, Hello, Op, PROTOCOL, Proof, Reply, SOCKET};
use crate::auth::{Token, decode, encode, verify};
use crate::driver::Driver;
use crate::error::{Error, Result};
use crate::event::{Body, Event};
use crate::session::{Harness, Open, Settings};
use crate::store::Store;

/// How long a new connection has to prove its token.
const PROOF_WITHIN: Duration = Duration::from_secs(10);

pub struct Server {
    harness: Harness,
    listener: UnixListener,
    dir: PathBuf,
    /// Taken at bind, so a stop that comes once the socket is there is never missed.
    stops: (Signal, Signal),
}

impl Server {
    /// Takes the data folder and listens on its socket. A store with no client token yet takes `first_token`'s, the
    /// one the client that starts the harness hands over; with none, the harness does not start.
    pub fn bind(dir: &Path, first_token: impl FnOnce() -> Option<Token>, drivers: Vec<(String, Arc<dyn Driver>)>, settings: Settings) -> Result<Server> {
        let store = Store::open(dir)?;
        if store.client_tokens()?.is_empty() {
            let token = first_token().ok_or_else(|| Error::Refused("no client token yet: give the first one on stdin".into()))?;
            store.add_client_token(&token.stored_key())?;
        }
        let harness = Harness::new(store, drivers, settings);
        let socket = dir.join(SOCKET);
        // The store's lock is ours, so a socket left here is a dead harness's.
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let descriptor = Descriptor { protocol: PROTOCOL, build: crate::BUILD_ID.into(), pid: std::process::id() };
        let mut file = OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(dir.join(DESCRIPTOR))?;
        file.write_all(serde_json::to_string(&descriptor)?.as_bytes())?;
        let stops = (signal(SignalKind::terminate())?, signal(SignalKind::interrupt())?);
        Ok(Server { harness, listener, dir: dir.to_owned(), stops })
    }

    pub fn harness(&self) -> &Harness {
        &self.harness
    }

    /// Serves until the process is told to stop; then the socket and the descriptor are gone.
    pub async fn run(self) -> Result<()> {
        let Server { harness, listener, dir, stops: (mut term, mut int) } = self;
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) if same_user(&stream) => {
                        connections.spawn(connection(harness.clone(), stream));
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("harness: accept failed: {e}"),
                },
                _ = term.recv() => break,
                _ = int.recv() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        let _ = std::fs::remove_file(dir.join(SOCKET));
        let _ = std::fs::remove_file(dir.join(DESCRIPTOR));
        Ok(())
    }
}

fn same_user(stream: &UnixStream) -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    stream.peer_cred().is_ok_and(|cred| cred.uid() == unsafe { libc::geteuid() })
}

type Ws = WebSocketStream<UnixStream>;

async fn send(ws: &mut Ws, reply: &impl serde::Serialize) -> Result<()> {
    let text = serde_json::to_string(reply)?;
    ws.send(Message::text(text)).await.map_err(|e| Error::Protocol(e.to_string()))
}

async fn connection(harness: Harness, stream: UnixStream) {
    let Ok(mut ws) = accept_async(stream).await else { return };
    if let Err(e) = prove(&harness, &mut ws).await {
        let _ = send(&mut ws, &Reply { error: Some(e.to_string()), ..Reply::default() }).await;
        let _ = ws.close(None).await;
        return;
    }
    if send(&mut ws, &Reply { ok: Some(json!(true)), ..Reply::default() }).await.is_err() {
        return;
    }
    let (out, mut pushes) = mpsc::unbounded_channel();
    let mut client = Client { harness, out, watches: JoinSet::new() };
    loop {
        tokio::select! {
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let reply = client.call(text.as_str()).await;
                    if send(&mut ws, &reply).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            Some(push) = pushes.recv() => {
                if send(&mut ws, &push).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// The client's answer to a fresh challenge must prove a stored token. Nothing else is read before it. The challenge
/// lives only in this call, so an answer is good for this connection once.
async fn prove(harness: &Harness, ws: &mut Ws) -> Result<()> {
    let mut challenge = [0u8; 32];
    getrandom::fill(&mut challenge).expect("the operating system has a secure random source");
    send(ws, &Hello { protocol: PROTOCOL, build: crate::BUILD_ID.into(), challenge: encode(&challenge) }).await?;
    let refused = || Error::Refused("the client did not prove a token".into());
    let first = tokio::time::timeout(PROOF_WITHIN, ws.next()).await.map_err(|_| refused())?;
    let Some(Ok(Message::Text(text))) = first else { return Err(refused()) };
    let proof: Proof = serde_json::from_str(text.as_str()).map_err(|_| refused())?;
    let answer = decode(&proof.proof).ok_or_else(refused)?;
    if verify(&harness.client_tokens()?, &challenge, &answer) { Ok(()) } else { Err(refused()) }
}

struct Client {
    harness: Harness,
    out: UnboundedSender<Reply>,
    /// Ends every watch when the connection ends.
    watches: JoinSet<()>,
}

impl Client {
    async fn call(&mut self, text: &str) -> Reply {
        let call: Call = match serde_json::from_str(text) {
            Ok(call) => call,
            Err(e) => {
                let id = serde_json::from_str::<Value>(text).ok().and_then(|value| value["id"].as_u64());
                return Reply { id, error: Some(format!("not a call: {e}")), ..Reply::default() };
            }
        };
        match self.dispatch(call.op).await {
            Ok(value) => Reply { id: Some(call.id), ok: Some(value), ..Reply::default() },
            Err(e) => Reply { id: Some(call.id), error: Some(e.to_string()), ..Reply::default() },
        }
    }

    async fn dispatch(&mut self, op: Op) -> Result<Value> {
        let harness = &self.harness;
        let done = |result: Result<()>| result.map(|()| Value::Null);
        match op {
            Op::Open { provider, cwd, locked, model } => {
                let (id, events) = harness.open(Open { provider, cwd, locked, model }).await?;
                self.watches.spawn(forward(harness.clone(), id.clone(), vec![], Some(events), self.out.clone()));
                Ok(json!({ "session": id }))
            }
            Op::Send { session, text } => done(harness.send(&session, text)),
            Op::Cancel { session } => done(harness.cancel(&session)),
            Op::Answer { session, request, decision, message } => done(harness.answer(&session, &request, decision, message)),
            Op::ToolResult { session, call, output, error } => done(harness.tool_result(&session, &call, output, error)),
            Op::Close { session } => done(harness.close(&session)),
            Op::CleanUp { session } => done(harness.clean_up(&session)),
            Op::Sessions => Ok(serde_json::to_value(harness.sessions()?)?),
            Op::Providers => {
                let providers = harness.providers().into_iter().map(|(name, capabilities)| json!({ "name": name, "capabilities": capabilities }));
                Ok(Value::Array(providers.collect()))
            }
            Op::Events { session, after } => Ok(serde_json::to_value(harness.events(&session, after)?)?),
            Op::Watch { session, after } => {
                let (stored, live) = harness.watch(&session, after)?;
                self.watches.spawn(forward(harness.clone(), session, stored, live, self.out.clone()));
                Ok(Value::Null)
            }
            Op::TokenNew { stored_key } => {
                let key = decode(&stored_key).ok_or_else(|| Error::Refused("a stored key is 64 hex digits".into()))?;
                done(harness.add_client_token(&key))
            }
        }
    }
}

/// Pushes `stored`, then each live event not already pushed, until the session closes; then the end of the watch.
/// A client that falls behind the live events reads what it missed back from the store.
async fn forward(harness: Harness, session: String, stored: Vec<Event>, live: Option<broadcast::Receiver<Event>>, out: UnboundedSender<Reply>) {
    let push = |event: Event| out.send(Reply { session: Some(session.clone()), event: Some(event), ..Reply::default() }).is_ok();
    let mut last = 0;
    for event in stored {
        last = event.seq;
        if !push(event) {
            return finish(&out, session);
        }
    }
    if let Some(mut live) = live {
        loop {
            let event = match live.recv().await {
                Ok(event) => event,
                Err(RecvError::Lagged(_)) => match harness.events(&session, last) {
                    Ok(missed) => {
                        for event in missed {
                            last = event.seq;
                            let closed = event.body == Body::Closed;
                            if !push(event) || closed {
                                return finish(&out, session);
                            }
                        }
                        continue;
                    }
                    Err(_) => break,
                },
                Err(RecvError::Closed) => break,
            };
            // An event numbered 0 was not stored, so it cannot have been pushed before.
            if event.seq != 0 && event.seq <= last {
                continue;
            }
            last = last.max(event.seq);
            let closed = event.body == Body::Closed;
            if !push(event) || closed {
                break;
            }
        }
    }
    finish(&out, session);
}

fn finish(out: &UnboundedSender<Reply>, session: String) {
    let _ = out.send(Reply { session: Some(session), end: true, ..Reply::default() });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Body;

    fn text(seq: u64) -> Event {
        Event { seq, ms: 0, body: Body::Text { text: format!("t{seq}") } }
    }

    /// A harness whose store holds session `s` with events 1 to `n`, as `text` makes them, then `closed`.
    fn stored(dir: &Path, n: u64) -> (Harness, Vec<Event>) {
        let store = Store::open(dir).unwrap();
        store.create_session("s", "mock", false, Path::new("/"), None).unwrap();
        let mut events: Vec<Event> = (1..=n).map(|seq| store.append("s", &text(seq).body, 0).unwrap()).collect();
        events.push(store.append("s", &Body::Closed, 0).unwrap());
        (Harness::new(store, vec![], Settings::default()), events)
    }

    async fn pushed(harness: Harness, stored: Vec<Event>, live: broadcast::Receiver<Event>) -> Vec<Reply> {
        let (out, mut pushes) = mpsc::unbounded_channel();
        forward(harness, "s".into(), stored, Some(live), out).await;
        let mut all = vec![];
        while let Ok(push) = pushes.try_recv() {
            all.push(push);
        }
        all
    }

    fn events(pushes: &[Reply]) -> Vec<Event> {
        pushes.iter().filter_map(|push| push.event.clone()).collect()
    }

    #[tokio::test]
    async fn events_an_event_both_read_and_live_is_pushed_once_and_the_watch_ends_at_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let (harness, all) = stored(&tmp.path().join("d"), 4);
        let (live, receiver) = broadcast::channel(16);
        // The read got 1 to 3; the receiver, subscribed before it, has 2 onwards.
        for event in &all[1..] {
            live.send(event.clone()).unwrap();
        }
        let pushes = pushed(harness, all[..3].to_vec(), receiver).await;
        assert_eq!(events(&pushes), all, "each once, in order");
        assert!(pushes.last().unwrap().end, "then the end");
    }

    #[tokio::test]
    async fn events_a_client_that_falls_behind_the_live_events_reads_what_it_missed_from_the_store() {
        let tmp = tempfile::tempdir().unwrap();
        let (harness, all) = stored(&tmp.path().join("d"), 6);
        let (live, receiver) = broadcast::channel(2);
        for event in &all {
            let _ = live.send(event.clone());
        }
        let pushes = pushed(harness, vec![], receiver).await;
        assert_eq!(events(&pushes), all, "none lost, none twice");
    }
}
