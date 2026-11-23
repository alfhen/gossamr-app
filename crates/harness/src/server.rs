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
use tokio::sync::Notify;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
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

/// How often the sweep runs while the harness serves.
pub const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);
/// How long a new connection has to prove its token.
const PROOF_WITHIN: Duration = Duration::from_secs(10);

pub struct Server {
    harness: Harness,
    listener: UnixListener,
    dir: PathBuf,
    /// Taken at bind, so a stop that comes once the socket is there is never missed.
    stops: (Signal, Signal),
    sweep_every: Duration,
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
        Ok(Server { harness, listener, dir: dir.to_owned(), stops, sweep_every: SWEEP_EVERY })
    }

    pub fn sweep_every(mut self, every: Duration) -> Server {
        self.sweep_every = every;
        self
    }

    pub fn harness(&self) -> &Harness {
        &self.harness
    }

    /// Serves until a client asks for `shutdown` or the process is told to stop; then every session has stopped, the
    /// data folder is free, and the socket and the descriptor are gone.
    pub async fn run(self) -> Result<()> {
        let Server { harness, listener, dir, stops: (mut term, mut int), sweep_every } = self;
        let (sweeper, _) = harness.sweep_on_timer(sweep_every);
        let stop = Arc::new(Notify::new());
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) if same_user(&stream) => {
                        connections.spawn(connection(harness.clone(), stream, stop.clone()));
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("harness: accept failed: {e}"),
                },
                _ = stop.notified() => break,
                _ = term.recv() => break,
                _ = int.recv() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        drop(listener);
        let _ = std::fs::remove_file(dir.join(SOCKET));
        harness.shutdown().await;
        connections.shutdown().await;
        sweeper.abort();
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

async fn connection(harness: Harness, stream: UnixStream, stop: Arc<Notify>) {
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
    let mut client = Client { harness: harness.clone(), out, watches: JoinSet::new(), ends_with_it: vec![] };
    loop {
        tokio::select! {
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let (reply, shut) = client.call(text.as_str()).await;
                    if send(&mut ws, &reply).await.is_err() {
                        break;
                    }
                    if shut {
                        stop.notify_one();
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
    for id in &client.ends_with_it {
        let _ = harness.close(id);
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
    /// Sessions this client opened as ending with it.
    ends_with_it: Vec<String>,
}

impl Client {
    /// The reply to one call, and whether the harness shut down.
    async fn call(&mut self, text: &str) -> (Reply, bool) {
        let call: Call = match serde_json::from_str(text) {
            Ok(call) => call,
            Err(e) => {
                let id = serde_json::from_str::<Value>(text).ok().and_then(|value| value["id"].as_u64());
                return (Reply { id, error: Some(format!("not a call: {e}")), ..Reply::default() }, false);
            }
        };
        let shut = call.op == Op::Shutdown;
        let reply = match self.dispatch(call.op).await {
            Ok(value) => Reply { id: Some(call.id), ok: Some(value), ..Reply::default() },
            Err(e) => Reply { id: Some(call.id), error: Some(e.to_string()), ..Reply::default() },
        };
        (reply, shut)
    }

    async fn dispatch(&mut self, op: Op) -> Result<Value> {
        let harness = &self.harness;
        let done = |result: Result<()>| result.map(|()| Value::Null);
        match op {
            Op::Open { provider, cwd, locked, model, ends_with_client } => {
                let (watcher, events) = mpsc::unbounded_channel();
                let (id, _) = harness.open_watched(Open { provider, cwd, locked, model, ends_with_client }, Some(watcher))?;
                if ends_with_client {
                    self.ends_with_it.push(id.clone());
                }
                self.watches.spawn(forward(id.clone(), vec![], Some(events), self.out.clone()));
                Ok(json!({ "session": id }))
            }
            Op::Send { session, text } => done(harness.send(&session, text)),
            Op::Cancel { session } => done(harness.cancel(&session)),
            Op::Answer { session, request, decision, message } => done(harness.answer(&session, &request, decision, message)),
            Op::ToolResult { session, call, output, error } => done(harness.tool_result(&session, &call, output, error)),
            Op::AnswerQuestion { session, question, text } => done(harness.answer_question(&session, &question, text)),
            Op::Close { session } => done(harness.close(&session)),
            Op::HandOver { session } => done(harness.hand_over(&session)),
            Op::CleanUp { session } => done(harness.clean_up(&session)),
            Op::Sessions => Ok(serde_json::to_value(harness.sessions()?)?),
            Op::Providers => {
                let providers = harness.providers().into_iter().map(|(name, capabilities)| json!({ "name": name, "capabilities": capabilities }));
                Ok(Value::Array(providers.collect()))
            }
            Op::Events { session, after } => Ok(serde_json::to_value(harness.events(&session, after)?)?),
            Op::Watch { session, after } => {
                let (stored, live) = harness.watch(&session, after)?;
                self.watches.spawn(forward(session, stored, live, self.out.clone()));
                Ok(Value::Null)
            }
            Op::TokenNew { stored_key } => {
                let key = decode(&stored_key).ok_or_else(|| Error::Refused("a stored key is 64 hex digits".into()))?;
                done(harness.add_client_token(&key))
            }
            Op::Shutdown => {
                harness.shutdown().await;
                Ok(Value::Null)
            }
        }
    }
}

/// Pushes `stored`, then each live event not already pushed, until the session closes; then the end of the watch.
/// The live events come on a channel that never drops one, so a client that falls behind misses nothing.
async fn forward(session: String, stored: Vec<Event>, live: Option<UnboundedReceiver<Event>>, out: UnboundedSender<Reply>) {
    let push = |event: Event| out.send(Reply { session: Some(session.clone()), event: Some(event), ..Reply::default() }).is_ok();
    let mut last = 0;
    for event in stored {
        last = event.seq;
        if !push(event) {
            return finish(&out, session);
        }
    }
    if let Some(mut live) = live {
        while let Some(event) = live.recv().await {
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

    #[tokio::test]
    async fn events_an_event_both_read_and_live_is_pushed_once_and_the_watch_ends_at_closed() {
        let all: Vec<Event> = (1..=4).map(text).chain([Event { seq: 5, ms: 0, body: Body::Closed }]).collect();
        let (live, receiver) = mpsc::unbounded_channel();
        // The read got 1 to 3; the receiver, registered before it, has 2 onwards.
        for event in &all[1..] {
            live.send(event.clone()).unwrap();
        }
        let (out, mut pushes) = mpsc::unbounded_channel();
        forward("s".into(), all[..3].to_vec(), Some(receiver), out).await;
        let mut got = vec![];
        while let Ok(push) = pushes.try_recv() {
            got.push(push);
        }
        let events: Vec<Event> = got.iter().filter_map(|push| push.event.clone()).collect();
        assert_eq!(events, all, "each once, in order");
        assert!(got.last().unwrap().end, "then the end");
    }
}
