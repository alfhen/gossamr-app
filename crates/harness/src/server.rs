//! `harness serve`: the client API on a Unix socket in the data folder, which only the user can open. Each connection
//! proves a client token first (see `auth`), then sends calls and gets the events of the sessions it opened or
//! watches.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::sync::mpsc::{self, Sender};
use tokio::task::{AbortHandle, JoinSet};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{WebSocketStream, accept_async_with_config};

use crate::api::{BEFORE_PROOF_MAX, Call, DESCRIPTOR, Descriptor, Hello, MAX_MESSAGE, Op, PAGE_BYTES, PROTOCOL, Proof, Reply, socket_path};
use crate::auth::{Token, decode, encode, verify};
use crate::driver::Driver;
use crate::error::{Error, Result};
use crate::event::{Body, Event};
use crate::session::{Harness, Open, Settings};
use crate::store::Store;

/// How often the sweep runs while the harness serves.
pub const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);
/// Events waiting to be written to one client. Past it the client falls behind its live events, and what it missed is
/// read back from the store.
const PUSH_QUEUE: usize = 256;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How long a new connection has for the WebSocket handshake and its proof, together.
    pub proof_within: Duration,
    /// Connections that have not proven a token yet. One past it is closed at once.
    pub proving: usize,
    /// Proven connections. One past it is told so and closed.
    pub proven: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { proof_within: Duration::from_secs(10), proving: 8, proven: 64 }
    }
}

/// Counts a connection in one of the two caps while it holds this.
struct Counted(Arc<AtomicUsize>);

impl Counted {
    /// Counts one more unless `cap` are counted; one step, so two at once cannot pass it.
    fn take(count: &Arc<AtomicUsize>, cap: usize) -> Option<Counted> {
        let mut now = count.load(Ordering::Acquire);
        while now < cap {
            match count.compare_exchange_weak(now, now + 1, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Some(Counted(count.clone())),
                Err(seen) => now = seen,
            }
        }
        None
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Server {
    harness: Harness,
    listener: UnixListener,
    dir: PathBuf,
    /// Taken at bind, so a stop that comes once the socket is there is never missed.
    stops: (Signal, Signal),
    limits: Limits,
}

impl Server {
    /// Takes the data folder and listens on its socket. A store with no client token yet takes `first_token`'s, the
    /// one the client that starts the harness hands over; with none, the harness does not start.
    pub fn bind(dir: &Path, first_token: impl FnOnce() -> Option<Token>, drivers: Vec<(String, Arc<dyn Driver>)>, settings: Settings) -> Result<Server> {
        let socket = socket_path(dir)?;
        let store = Store::open(dir)?;
        if store.client_tokens()?.is_empty() {
            let token = first_token().ok_or_else(|| Error::Refused("no client token yet: give the first one on stdin".into()))?;
            store.add_client_token(&token.stored_key())?;
        }
        let harness = Harness::new(store, drivers, settings);
        // The store's lock is ours, so a socket or a descriptor left here is a dead harness's.
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let descriptor = Descriptor { protocol: PROTOCOL, build: crate::BUILD_ID.into(), pid: std::process::id() };
        let path = dir.join(DESCRIPTOR);
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)?;
        file.write_all(serde_json::to_string(&descriptor)?.as_bytes())?;
        let stops = (signal(SignalKind::terminate())?, signal(SignalKind::interrupt())?);
        Ok(Server { harness, listener, dir: dir.to_owned(), stops, limits: Limits::default() })
    }

    pub fn limits(mut self, limits: Limits) -> Server {
        self.limits = limits;
        self
    }

    pub fn harness(&self) -> &Harness {
        &self.harness
    }

    /// Serves until the process is told to stop; then the socket and the descriptor are gone.
    pub async fn run(self) -> Result<()> {
        let Server { harness, listener, dir, stops: (mut term, mut int), limits } = self;
        let (sweeper, _) = harness.sweep_on_timer(SWEEP_EVERY);
        let mut connections = JoinSet::new();
        let (proving, proven) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) if same_user(&stream) => {
                        if let Some(slot) = Counted::take(&proving, limits.proving) {
                            connections.spawn(connection(harness.clone(), stream, limits, slot, proven.clone()));
                        }
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("harness: accept failed: {e}"),
                },
                _ = term.recv() => break,
                _ = int.recv() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        sweeper.abort();
        let _ = std::fs::remove_file(dir.join(crate::api::SOCKET));
        let _ = std::fs::remove_file(dir.join(DESCRIPTOR));
        Ok(())
    }
}

fn same_user(stream: &UnixStream) -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    stream.peer_cred().is_ok_and(|cred| cred.uid() == unsafe { libc::geteuid() })
}

/// The limits of a connection, both ways, from its start.
pub(crate) fn config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE))
}

type Ws = WebSocketStream<UnixStream>;

async fn send(ws: &mut Ws, reply: &Reply) -> Result<()> {
    let mut text = serde_json::to_string(reply)?;
    if text.len() > MAX_MESSAGE {
        let error = format!("the answer is over the {MAX_MESSAGE}-byte limit of a message");
        text = serde_json::to_string(&Reply { id: reply.id, session: reply.session.clone(), error: Some(error), ..Reply::default() })?;
    }
    ws.send(Message::text(text)).await.map_err(|e| Error::Protocol(e.to_string()))
}

async fn connection(harness: Harness, stream: UnixStream, limits: Limits, proving: Counted, proven: Arc<AtomicUsize>) {
    let checked = tokio::time::timeout(limits.proof_within, async {
        let mut ws = accept_async_with_config(stream, Some(config())).await.ok()?;
        let proof = prove(&harness, &mut ws).await;
        Some((ws, proof))
    });
    let checked = checked.await;
    drop(proving);
    let (mut ws, slot) = match checked {
        Ok(Some((mut ws, proof))) => match proof.and_then(|()| Counted::take(&proven, limits.proven).ok_or(Error::Refused(format!("the harness has {} clients already", limits.proven)))) {
            Ok(slot) => (ws, slot),
            Err(e) => {
                let _ = send(&mut ws, &Reply { error: Some(e.to_string()), ..Reply::default() }).await;
                let _ = ws.close(None).await;
                return;
            }
        },
        Ok(None) | Err(_) => return,
    };
    let _slot = slot;
    if send(&mut ws, &Reply { ok: Some(json!(true)), ..Reply::default() }).await.is_err() {
        return;
    }
    let (out, mut pushes) = mpsc::channel(PUSH_QUEUE);
    let mut client = Client { harness, out, watches: JoinSet::new(), watching: HashMap::new() };
    loop {
        tokio::select! {
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let reply = client.call(text.as_str()).await;
                    if send(&mut ws, &reply).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Binary(_))) => {
                    if send(&mut ws, &Reply { error: Some("a call is a JSON text message".into()), ..Reply::default() }).await.is_err() {
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
            Some(_) = client.watches.join_next(), if !client.watches.is_empty() => {}
        }
    }
}

/// The client's answer to a fresh challenge, over the whole hello, must prove a stored token. Nothing else is read
/// before it. The hello lives only in this call, so an answer is good for this connection once.
async fn prove(harness: &Harness, ws: &mut Ws) -> Result<()> {
    let mut challenge = [0u8; 32];
    getrandom::fill(&mut challenge).expect("the operating system has a secure random source");
    let hello = serde_json::to_string(&Hello { protocol: PROTOCOL, build: crate::BUILD_ID.into(), challenge: encode(&challenge) })?;
    ws.send(Message::text(hello.clone())).await.map_err(|e| Error::Protocol(e.to_string()))?;
    let refused = || Error::Refused("the client did not prove a token".into());
    let Some(Ok(Message::Text(text))) = ws.next().await else { return Err(refused()) };
    if text.len() > BEFORE_PROOF_MAX {
        return Err(refused());
    }
    let proof: Proof = serde_json::from_str(text.as_str()).map_err(|_| refused())?;
    let answer = decode(&proof.proof).ok_or_else(refused)?;
    if verify(&harness.client_tokens()?, hello.as_bytes(), &answer) { Ok(()) } else { Err(refused()) }
}

struct Client {
    harness: Harness,
    out: Sender<Reply>,
    /// Ends every watch when the connection ends.
    watches: JoinSet<()>,
    /// The session each watch is of: one at a time per session.
    watching: HashMap<String, AbortHandle>,
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
        let harness = self.harness.clone();
        let done = |result: Result<()>| result.map(|()| Value::Null);
        match op {
            Op::Open { provider, cwd, locked, model } => {
                let (id, events) = harness.open(Open { provider, cwd, locked, model }).await?;
                self.watch(id.clone(), vec![], Some(events), 0);
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
            Op::Events { session, after } => {
                let (events, more) = harness.events_page(&session, after, PAGE_BYTES)?;
                Ok(json!({ "events": events, "more": more }))
            }
            Op::Watch { session, after } => {
                if self.watching.get(&session).is_some_and(|watch| !watch.is_finished()) {
                    return Err(Error::Refused(format!("this connection already watches session {session}")));
                }
                let (stored, live) = harness.watch(&session, after)?;
                self.watch(session, stored, live, after);
                Ok(Value::Null)
            }
            Op::TokenNew { stored_key } => {
                let key = decode(&stored_key).ok_or_else(|| Error::Refused("a stored key is 64 hex digits".into()))?;
                done(harness.add_client_token(&key))
            }
        }
    }

    fn watch(&mut self, session: String, stored: Vec<Event>, live: Option<broadcast::Receiver<Event>>, after: u64) {
        let task = forward(self.harness.clone(), session.clone(), stored, live, after, self.out.clone());
        self.watching.insert(session, self.watches.spawn(task));
    }
}

async fn push(out: &Sender<Reply>, session: &str, event: Event) -> bool {
    out.send(Reply { session: Some(session.to_owned()), event: Some(event), ..Reply::default() }).await.is_ok()
}

/// Pushes `stored`, then each live event numbered past `after` and not already pushed, until the session closes; then
/// the end of the watch. A client that falls behind its live events reads what it missed back from the store.
async fn forward(harness: Harness, session: String, stored: Vec<Event>, live: Option<broadcast::Receiver<Event>>, after: u64, out: Sender<Reply>) {
    let mut last = after;
    for event in stored {
        last = event.seq;
        if !push(&out, &session, event).await {
            return;
        }
    }
    if let Some(mut live) = live {
        loop {
            let event = match live.recv().await {
                Ok(event) => event,
                Err(RecvError::Lagged(_)) => {
                    let Ok(missed) = harness.events(&session, last) else { break };
                    for event in missed {
                        last = event.seq;
                        let closed = event.body == Body::Closed;
                        if !push(&out, &session, event).await || closed {
                            return finish(&out, session).await;
                        }
                    }
                    continue;
                }
                Err(RecvError::Closed) => break,
            };
            let closed = event.body == Body::Closed;
            // An event numbered 0 was not stored, so it cannot have been pushed before.
            if event.seq == 0 || event.seq > last {
                last = last.max(event.seq);
                if !push(&out, &session, event).await {
                    return;
                }
            }
            if closed {
                break;
            }
        }
    }
    finish(&out, session).await;
}

async fn finish(out: &Sender<Reply>, session: String) {
    let _ = out.send(Reply { session: Some(session), end: true, ..Reply::default() }).await;
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Body;

    fn text(seq: u64) -> Event {
        Event { seq, ms: 0, body: Body::Text { text: format!("t{seq}") }, cut: None }
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
        let (out, mut pushes) = mpsc::channel(64);
        forward(harness, "s".into(), stored, Some(live), 0, out).await;
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
