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
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc::{self, Sender};
use tokio::task::{AbortHandle, JoinSet};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::{CloseFrame, coding::CloseCode};
use tokio_tungstenite::{WebSocketStream, accept_async_with_config};

use crate::api::{BEFORE_PROOF_MAX, Call, DESCRIPTOR, Descriptor, Hello, MAX_MESSAGE, Op, PAGE_BYTES, PROTOCOL, Proof, Reply, socket_path};
use crate::auth::{Token, decode, encode, verify};
use crate::driver::Driver;
use crate::error::{Error, Result};
use crate::event::{Body, Event};
use crate::session::{Feed, Harness, Open, Settings};
use crate::store::Store;

/// How often the sweep runs while the harness serves.
pub const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);
/// Events waiting to be written to one client. Past it its watches wait, and their live events wait on channels that
/// drop none, because a locked session's events cannot be read back from the store.
const PUSH_QUEUE: usize = 256;
/// How long a connection being ended has to take its close frame before its socket is dropped.
const CLOSE_WITHIN: Duration = Duration::from_secs(1);

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
    sweep_every: Duration,
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
        Ok(Server { harness, listener, dir: dir.to_owned(), stops, limits: Limits::default(), sweep_every: SWEEP_EVERY })
    }

    pub fn limits(mut self, limits: Limits) -> Server {
        self.limits = limits;
        self
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
        let Server { harness, listener, dir, stops: (mut term, mut int), limits, sweep_every } = self;
        // Aborted with `run` too, so a server dropped mid-run holds no harness, and no data folder, through it.
        let _sweeper = AbortOnDrop(harness.sweep_on_timer(sweep_every).0);
        let (asks, mut asked) = mpsc::unbounded_channel::<ShutdownAsk>();
        let mut shutting = None;
        let mut connections = JoinSet::new();
        let (proving, proven) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) if same_user(&stream) => {
                        match Counted::take(&proving, limits.proving) {
                            Some(slot) => {
                                connections.spawn(connection(harness.clone(), stream, limits, slot, proven.clone(), asks.clone()));
                            }
                            None => {
                                tokio::spawn(turn_away(stream, limits.proving));
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => eprintln!("harness: accept failed: {e}"),
                },
                Some(ask) = asked.recv() => {
                    shutting = Some(ask);
                    break;
                }
                _ = term.recv() => break,
                _ = int.recv() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }
        drop(listener);
        // Both before the store goes, so neither can be a next harness's.
        let _ = std::fs::remove_file(dir.join(crate::api::SOCKET));
        let _ = std::fs::remove_file(dir.join(DESCRIPTOR));
        let left = harness.shutdown().await;
        if !left.is_empty() {
            eprintln!("harness: shut down without waiting longer for the stuck agents of sessions {}", left.join(", "));
        }
        // A client that asked for this gets its answer, if it takes it within a second, before its connection ends.
        if let Some(ShutdownAsk { left: answer, sent }) = shutting {
            let _ = answer.send(left);
            let _ = tokio::time::timeout(CLOSE_WITHIN, sent).await;
        }
        connections.shutdown().await;
        Ok(())
    }
}

/// A client's `shutdown`, which `run` carries out: it gives the client the sessions it left, and waits for `sent`.
struct ShutdownAsk {
    left: tokio::sync::oneshot::Sender<Vec<String>>,
    sent: tokio::sync::oneshot::Receiver<()>,
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn same_user(stream: &UnixStream) -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    stream.peer_cred().is_ok_and(|cred| cred.uid() == unsafe { libc::geteuid() })
}

/// Tells a connection past the cap of those proving why it is closed, within a second.
async fn turn_away(stream: UnixStream, proving: usize) {
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        let mut ws = accept_async_with_config(stream, Some(config())).await.ok()?;
        let error = format!("the harness has {proving} connections still proving a token: try again");
        let _ = send(&mut ws, &Reply { error: Some(error), ..Reply::default() }).await;
        ws.close(None).await.ok()
    })
    .await;
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

async fn connection(harness: Harness, stream: UnixStream, limits: Limits, proving: Counted, proven: Arc<AtomicUsize>, asks: mpsc::UnboundedSender<ShutdownAsk>) {
    // Before the proof, so a revoke during it is heard too.
    let mut revoked = harness.revocations();
    let checked = tokio::time::timeout(limits.proof_within, async {
        let mut ws = accept_async_with_config(stream, Some(config())).await.ok()?;
        let proof = prove(&harness, &mut ws).await;
        Some((ws, proof))
    });
    let checked = checked.await;
    drop(proving);
    let (mut ws, slot, key) = match checked {
        Ok(Some((mut ws, proof))) => match proof.and_then(|key| Ok((key, Counted::take(&proven, limits.proven).ok_or(Error::Refused(format!("the harness has {} clients already", limits.proven)))?))) {
            Ok((key, slot)) => (ws, slot, key),
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
    let mut client = Client { harness: harness.clone(), key, out, watches: JoinSet::new(), watching: HashMap::new(), ends_with_it: vec![], asks, sent: None };
    loop {
        // A revoke is heard before anything else, and during every write: nothing reaches this client after its
        // token's revoke has answered, even one that stopped reading.
        let reply = tokio::select! {
            biased;
            heard = revoked.recv() => match revoked_for(&harness, &key, heard) {
                true => break,
                false => continue,
            },
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => client.call(text.as_str()).await,
                Some(Ok(Message::Binary(_))) => Reply { error: Some("a call is a JSON text message".into()), ..Reply::default() },
                Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(_))) => {
                    let reason = format!("a message over the {MAX_MESSAGE}-byte limit");
                    let _ = tokio::time::timeout(CLOSE_WITHIN, ws.close(Some(CloseFrame { code: CloseCode::Size, reason: reason.into() }))).await;
                    return;
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => continue,
            },
            Some(push) = pushes.recv() => push,
            Some(_) = client.watches.join_next(), if !client.watches.is_empty() => continue,
        };
        let sending = send(&mut ws, &reply);
        tokio::pin!(sending);
        let sent = loop {
            tokio::select! {
                sent = &mut sending => break sent.is_ok(),
                heard = revoked.recv() => if revoked_for(&harness, &key, heard) {
                    break false;
                },
            }
        };
        // `run` waits for the answer to a shutdown before it ends the connections.
        if let Some(done) = client.sent.take() {
            let _ = done.send(());
        }
        if !sent {
            break;
        }
    }
    // Only a revoke ends the loop: it closes the connection with the reason, if the client will take it in time.
    let reason = "this connection's token was revoked";
    let _ = tokio::time::timeout(CLOSE_WITHIN, ws.close(Some(CloseFrame { code: CloseCode::Policy, reason: reason.into() }))).await;
}

/// Whether what the revocations said ends the connection that proved `key`.
fn revoked_for(harness: &Harness, key: &[u8; 32], heard: std::result::Result<[u8; 32], RecvError>) -> bool {
    match heard {
        Ok(gone) => gone == *key,
        Err(RecvError::Lagged(_)) => !harness.client_tokens().is_ok_and(|tokens| tokens.iter().any(|token| token.stored_key == *key)),
        Err(RecvError::Closed) => false,
    }
}

/// The client's answer to a fresh challenge, over the whole hello, must prove a stored token. Nothing else is read
/// before it. The hello lives only in this call, so an answer is good for this connection once.
async fn prove(harness: &Harness, ws: &mut Ws) -> Result<[u8; 32]> {
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
    let keys: Vec<[u8; 32]> = harness.client_tokens()?.into_iter().map(|token| token.stored_key).collect();
    verify(&keys, hello.as_bytes(), &answer).map(|at| keys[at]).ok_or_else(refused)
}

struct Client {
    harness: Harness,
    /// The stored key of the token this connection proved.
    key: [u8; 32],
    out: Sender<Reply>,
    /// Ends every watch when the connection ends.
    watches: JoinSet<()>,
    /// The session each watch is of: one at a time per session.
    watching: HashMap<String, AbortHandle>,
    /// Sessions this client opened as ending with it: closed when it is dropped, however the connection ends.
    ends_with_it: Vec<String>,
    asks: mpsc::UnboundedSender<ShutdownAsk>,
    /// Told once the answer to this client's `shutdown` has gone.
    sent: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for Client {
    fn drop(&mut self) {
        for id in &self.ends_with_it {
            let _ = self.harness.close(id);
        }
    }
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
            Op::Open { provider, cwd, locked, model, ends_with_client } => {
                let (id, _, events) = harness.open_watched(Open { provider, cwd, locked, model, ends_with_client })?;
                if ends_with_client {
                    self.ends_with_it.push(id.clone());
                }
                self.watch(id.clone(), (vec![], false, 0), Some(events), 0);
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
            Op::Events { session, after } => {
                let (events, more) = harness.events_page(&session, after, u64::MAX, PAGE_BYTES)?;
                Ok(json!({ "events": events, "more": more }))
            }
            Op::Watch { session, after } => {
                if self.watching.get(&session).is_some_and(|watch| !watch.is_finished()) {
                    return Err(Error::Refused(format!("this connection already watches session {session}")));
                }
                let (stored, more, upto, live) = harness.watch(&session, after)?;
                self.watch(session, (stored, more, upto), live, after);
                Ok(Value::Null)
            }
            Op::TokenNew { stored_key } => {
                let key = decode(&stored_key).ok_or_else(|| Error::Refused("a stored key is 64 hex digits".into()))?;
                done(harness.add_client_token(&key))
            }
            Op::TokenList => {
                let tokens = harness.client_tokens()?.into_iter();
                let listed = tokens.map(|token| json!({ "id": token.id, "created_ms": token.created_ms, "yours": token.stored_key == self.key }));
                Ok(Value::Array(listed.collect()))
            }
            Op::TokenRevoke { token } => done(harness.revoke_client_token(token)),
            Op::Shutdown => {
                // `run` removes the socket and the descriptor before the store goes, then shuts the harness down.
                let (left, answer) = tokio::sync::oneshot::channel();
                let (sent, done) = tokio::sync::oneshot::channel();
                let left = match self.asks.send(ShutdownAsk { left, sent: done }) {
                    Ok(()) => answer.await.unwrap_or_default(),
                    Err(_) => harness.shutdown().await,
                };
                self.sent = Some(sent);
                Ok(json!({ "left": left }))
            }
        }
    }

    /// `stored` is the first page of the backlog, whether more follow, and the last number it reaches.
    fn watch(&mut self, session: String, stored: (Vec<Event>, bool, u64), live: Option<Feed>, after: u64) {
        let task = forward(self.harness.clone(), session.clone(), stored, live, after, self.out.clone());
        self.watching.insert(session, self.watches.spawn(task));
    }
}

async fn push(out: &Sender<Reply>, session: &str, event: Event) -> bool {
    out.send(Reply { session: Some(session.to_owned()), event: Some(event), ..Reply::default() }).await.is_ok()
}

/// Pushes `stored`, the pages of the store that follow it while `more`, then each live event numbered past `after` and
/// not already pushed, until the session closes; then the end of the watch. The live events come on a channel that
/// drops none, so a client that falls behind misses nothing.
async fn forward(harness: Harness, session: String, stored: (Vec<Event>, bool, u64), mut live: Option<Feed>, after: u64, out: Sender<Reply>) {
    let mut last = after;
    // The store is read only up to where the feed begins: an event stored after that comes on the feed.
    let (page, more, upto) = stored;
    match pages(&harness, &session, page, more, upto, &mut last, &out).await {
        Some(false) => {}
        Some(true) => return finish(&out, session).await,
        None => return,
    }
    let mut lost = None;
    loop {
        let event = match &mut live {
            None => break,
            Some(Feed::Locked { events, lost: behind, bytes }) => match events.recv().await {
                Some((event, size)) => {
                    bytes.fetch_sub(size, Ordering::Relaxed);
                    event
                }
                None => {
                    if behind.load(Ordering::Relaxed) {
                        let (count, size) = harness.locked_backlog();
                        lost = Some(format!("events were lost: this client fell more than {count} events or {size} bytes behind a locked session, whose events are not stored"));
                    }
                    break;
                }
            },
            Some(Feed::Stored(events)) => match events.recv().await {
                Ok(event) => event,
                // What it missed is in the store.
                Err(RecvError::Lagged(_)) => match pages(&harness, &session, vec![], true, u64::MAX, &mut last, &out).await {
                    Some(false) => continue,
                    Some(true) => break,
                    None => return,
                },
                Err(RecvError::Closed) => break,
            },
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
    let _ = out.send(Reply { session: Some(session), end: true, error: lost, ..Reply::default() }).await;
}

/// Pushes `page`, then, while `more`, the store's next pages after `last` and up to `upto`. Some(true) once it has
/// pushed `closed`, Some(false) when the store has no more, None when the client has gone.
async fn pages(harness: &Harness, session: &str, mut page: Vec<Event>, mut more: bool, upto: u64, last: &mut u64, out: &Sender<Reply>) -> Option<bool> {
    loop {
        for event in page {
            *last = event.seq;
            let closed = event.body == Body::Closed;
            if !push(out, session, event).await {
                return None;
            }
            if closed {
                return Some(true);
            }
        }
        if !more {
            return Some(false);
        }
        (page, more) = harness.events_page(session, *last, upto, PAGE_BYTES).ok()?;
    }
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

    #[tokio::test]
    async fn events_an_event_both_read_and_live_is_pushed_once_and_the_watch_ends_at_closed() {
        let tmp = tempfile::tempdir().unwrap();
        let harness = Harness::new(Store::open(&tmp.path().join("d")).unwrap(), vec![], Settings::default());
        let all: Vec<Event> = (1..=4).map(text).chain([Event { seq: 5, ms: 0, body: Body::Closed, cut: None }]).collect();
        let (live, receiver) = mpsc::channel(64);
        let receiver = Feed::Locked { events: receiver, lost: Arc::new(std::sync::atomic::AtomicBool::new(false)), bytes: Arc::new(AtomicUsize::new(0)) };
        // The read got 1 to 3; the receiver has 2 onwards.
        for event in &all[1..] {
            live.try_send((event.clone(), 0)).unwrap();
        }
        let (out, mut pushes) = mpsc::channel(64);
        forward(harness, "s".into(), (all[..3].to_vec(), false, 3), Some(receiver), 0, out).await;
        let mut got = vec![];
        while let Ok(push) = pushes.try_recv() {
            got.push(push);
        }
        let events: Vec<Event> = got.iter().filter_map(|push| push.event.clone()).collect();
        assert_eq!(events, all, "each once, in order");
        assert!(got.last().unwrap().end, "then the end");
    }

    #[tokio::test]
    async fn locked_a_catch_up_reads_the_store_only_up_to_where_the_live_events_begin() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(&tmp.path().join("d")).unwrap();
        store.create_session("s", "mock", true, Path::new("/"), None).unwrap();
        // Events 1 to 8 and `closed` are stored, withheld as a locked session's are. The watch began after 5, so 6 on
        // also came to its receiver, whole, while it read the store.
        let whole: Vec<Event> = (1..=8).map(text).chain([Event { seq: 9, ms: 0, body: Body::Closed, cut: None }]).collect();
        for event in &whole {
            store.append("s", &event.body, 0).unwrap();
        }
        let harness = Harness::new(store, vec![], Settings::default());
        let stored = harness.events("s", 0).unwrap();
        let (live, receiver) = mpsc::channel(64);
        let receiver = Feed::Locked { events: receiver, lost: Arc::new(std::sync::atomic::AtomicBool::new(false)), bytes: Arc::new(AtomicUsize::new(0)) };
        for event in &whole[5..] {
            live.try_send((event.clone(), 0)).unwrap();
        }
        let (out, mut pushes) = mpsc::channel(64);
        // The first page held 1 and 2, more follow, and the store is read up to 5.
        forward(harness, "s".into(), (stored[..2].to_vec(), true, 5), Some(receiver), 0, out).await;
        let mut got = vec![];
        while let Ok(push) = pushes.try_recv() {
            got.extend(push.event);
        }
        let expected: Vec<Event> = stored[..5].iter().cloned().chain(whole[5..].iter().cloned()).collect();
        assert!(got == expected, "1 to 5 from the store, withheld; 6 on from the receiver, whole");
    }
}
