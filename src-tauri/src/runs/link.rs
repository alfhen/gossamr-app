//! The app's line to the harness for runs: one connection that watches every followed session and answers its client
//! tool calls, and a short-lived connection for each call that may take a while (an open clones, a clean-up fetches),
//! so no run's events wait behind another's call.
//!
//! The watching connection reads each session from the last event the app applied, so after a dropped connection or a
//! harness restart it gets what it missed, in pages, and nothing twice. A watch that ends with "events were lost" adds
//! one row to the run and reads on from the first event the harness still holds; the same loss twice at one place
//! stops the watch rather than ask again.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use harness::api::Op;
use harness::client::{Client, Push};
use harness::event::{Body, Event};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use super::consumer;
use super::tracker::{Attention, RunNotifier};
use crate::domain::{Run, RunState};
use crate::inbox::Core;

/// How the link gets a connection the harness has proven. The token stays with whoever implements it.
#[async_trait]
pub trait Connect: Send + Sync {
    async fn connect(&self) -> Result<Client, String>;
}

/// Answers a run's call of a tool the app declared: the output, and whether it is an error.
#[async_trait]
pub trait ClientTools: Send + Sync {
    async fn call(&self, run: &Run, name: &str, input: &Value) -> (Value, bool);
}

/// Declares no tools: every call is an error.
pub struct NoTools;

#[async_trait]
impl ClientTools for NoTools {
    async fn call(&self, _run: &Run, name: &str, _input: &Value) -> (Value, bool) {
        (Value::String(format!("Gossamr has no tool called {name}.")), true)
    }
}

const RETRY_FIRST: Duration = Duration::from_millis(100);
const RETRY_MOST: Duration = Duration::from_secs(5);

enum Command {
    /// Watch the session from after `after`; answered once the harness took the watch.
    Follow { session: String, after: u64, done: oneshot::Sender<Result<(), String>> },
    /// Posts a client tool's result on the watching connection.
    Answer { session: String, call: String, output: Value, error: bool },
}

#[derive(Clone)]
pub struct Link {
    inner: Arc<Inner>,
}

struct Inner {
    core: Arc<Core>,
    connect: Arc<dyn Connect>,
    tools: Arc<dyn ClientTools>,
    notifier: Arc<dyn RunNotifier>,
    changed: Arc<dyn Fn(&str) + Send + Sync>,
    commands: mpsc::UnboundedSender<Command>,
    /// Counts the events applied, for whoever waits on a run's state.
    applied: watch::Sender<u64>,
    /// Event types this build could not read, each logged once.
    unread: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Calls of the app's tools whose answer is on its way, so a reconnect does not answer them again.
    answering: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

impl Link {
    /// Starts the watching task, which follows every session the app's runs still follow.
    pub fn start(core: Arc<Core>, connect: Arc<dyn Connect>, tools: Arc<dyn ClientTools>, notifier: Arc<dyn RunNotifier>, changed: Arc<dyn Fn(&str) + Send + Sync>) -> Link {
        let (commands, received) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner { core, connect, tools, notifier, changed, commands, applied: watch::channel(0).0, unread: Default::default(), answering: Default::default() });
        tokio::spawn(watching(Arc::downgrade(&inner), received));
        Link { inner }
    }

    /// Makes a call on a connection of its own and waits for its answer.
    pub async fn call(&self, op: Op) -> Result<Value, String> {
        let mut client = self.inner.connect.connect().await?;
        client.call(op).await.map_err(|e| e.to_string())
    }

    /// Opens a session for `run_id`, makes it the run's, and watches it, in that order: the run follows the session
    /// before any of its events is applied, and the app listens for its tool calls before it is sent a prompt.
    pub async fn open(&self, run_id: &str, op: Op) -> Result<String, String> {
        let opened = self.call(op).await?;
        let session = opened["session"].as_str().ok_or("the harness answered an open with no session")?.to_owned();
        self.inner.core.bind_run_session(run_id, &session).await.map_err(|e| e.to_string())?;
        self.follow(&session, 0).await?;
        Ok(session)
    }

    /// Asks the harness to stop the session. The run reads stopped once the harness says it closed, never before.
    pub async fn stop(&self, session: &str) -> Result<(), String> {
        let asked = self.inner.core.apply_session(session, |_, follow| {
            follow.stop_asked = true;
            Vec::new()
        });
        asked.await.map_err(|e| e.to_string())?;
        let closed = self.call(Op::Close { session: session.to_owned() }).await.map(drop);
        if closed.is_err() {
            // Not stopped, so a later end of the agent is its own, not this stop's.
            let _ = self.inner.core.apply_session(session, |_, follow| {
                follow.stop_asked = false;
                Vec::new()
            }).await;
        }
        closed
    }

    /// Watches a session from after `after`, once the watching connection is up.
    pub async fn follow(&self, session: &str, after: u64) -> Result<(), String> {
        let (done, answered) = oneshot::channel();
        self.inner.commands.send(Command::Follow { session: session.to_owned(), after, done }).map_err(|_| "the link to the harness has stopped".to_owned())?;
        answered.await.map_err(|_| "the link to the harness has stopped".to_owned())?
    }

    /// Changes each time events are applied.
    pub fn applied(&self) -> watch::Receiver<u64> {
        self.inner.applied.subscribe()
    }
}

/// Where a watch stood when its events were lost, so the same loss at the same place is not asked for again.
type LostAt = HashMap<String, u64>;

async fn watching(inner: std::sync::Weak<Inner>, mut commands: mpsc::UnboundedReceiver<Command>) {
    let mut wait = RETRY_FIRST;
    let mut lost_at = LostAt::new();
    // No strong hold on the link while waiting, so the task ends once the last `Link` is dropped.
    let connect = |inner: &std::sync::Weak<Inner>| inner.upgrade().map(|link| link.connect.clone());
    loop {
        let Some(connector) = connect(&inner) else { return };
        let mut client = match connector.connect().await {
            Ok(client) => client,
            Err(e) => {
                eprintln!("couldn't reach the harness: {e}");
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(RETRY_MOST);
                continue;
            }
        };
        let Some(link) = inner.upgrade() else { return };
        let followed = follow_all(&link, &mut client).await;
        drop(link);
        if let Err(e) = followed {
            eprintln!("couldn't watch the harness's sessions: {e}");
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(RETRY_MOST);
            continue;
        }
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    None => return,
                    Some(Command::Follow { session, after, done }) => {
                        let watched = match client.call(Op::Watch { session, after }).await {
                            Ok(_) => Ok(()),
                            // Watched already, as every followed session is after a reconnect.
                            Err(e) if e.to_string().contains("already watches") => Ok(()),
                            Err(e) => Err(e.to_string()),
                        };
                        let _ = done.send(watched);
                    }
                    Some(Command::Answer { session, call, output, error }) => {
                        if let Err(e) = client.call(Op::ToolResult { session, call: call.clone(), output, error }).await {
                            eprintln!("couldn't answer a tool call: {e}");
                        }
                        // Posted or not, it is no longer on its way: a call still without a result is answered again.
                        if let Some(link) = inner.upgrade() {
                            link.answering.lock().unwrap_or_else(|e| e.into_inner()).remove(&call);
                        }
                    }
                },
                // `push` keeps what it has read, so a command that wins the race loses no event.
                push = client.push() => {
                    let Some(link) = inner.upgrade() else { return };
                    match push {
                        Ok(Some(Push::Event { session, event })) => {
                            // Not stored, so not passed: the watch starts again from the last event that was.
                            if link.take(&session, event).await.is_err() {
                                tokio::time::sleep(wait).await;
                                wait = (wait * 2).min(RETRY_MOST);
                                break;
                            }
                            wait = RETRY_FIRST;
                        }
                        Ok(Some(Push::Lost { session, reason })) => {
                            if link.lost(&mut client, &session, &reason, &mut lost_at).await.is_err() {
                                tokio::time::sleep(wait).await;
                                wait = (wait * 2).min(RETRY_MOST);
                                break;
                            }
                        }
                        Ok(Some(Push::End { .. })) => {}
                        // The harness went away or restarted: watch again from what was applied, after a wait, so a
                        // connection that keeps failing is not tried again at once.
                        Ok(None) | Err(_) => {
                            tokio::time::sleep(wait).await;
                            wait = (wait * 2).min(RETRY_MOST);
                            break;
                        }
                    }
                }
            }
        }
    }
}

/// Watches every session the app still follows, from after the last event it applied, and answers the calls of its
/// tools that a quit left with no result.
async fn follow_all(link: &Inner, client: &mut Client) -> Result<(), String> {
    let followed = link.core.followed_sessions().await.map_err(|e| e.to_string())?;
    for (session, follow) in followed {
        if let Err(e) = client.call(Op::Watch { session: session.clone(), after: follow.seq }).await {
            eprintln!("couldn't watch session {session}: {e}");
            continue;
        }
        if follow.calls.is_empty() {
            continue;
        }
        let Ok(Some((run_id, _))) = link.core.session_run(&session).await else { continue };
        if let Ok(Some(run)) = link.core.run(&run_id).await {
            for (id, name, input) in follow.calls {
                if !link.answering.lock().unwrap_or_else(|e| e.into_inner()).contains(&id) {
                    link.answer_tool(&session, run.clone(), id, name, input);
                }
            }
        }
    }
    Ok(())
}

impl Inner {
    /// Applies a pushed event. An error means it was not stored, and nothing after it may be.
    async fn take(&self, session: &str, event: Event) -> Result<(), ()> {
        if let Some(of) = consumer::unreadable(&event.body) {
            if self.unread.lock().unwrap_or_else(|e| e.into_inner()).insert(of.to_owned()) {
                eprintln!("the harness sent an event this build cannot read ({of}); its number is passed over");
            }
        }
        let call = match &event.body {
            Body::ClientToolCall { id, name, input } => Some((id.clone(), name.clone(), input.clone())),
            _ => None,
        };
        let now = Utc::now();
        let mut fresh = false;
        let applied = self
            .core
            .apply_session(session, |run, follow| {
                fresh = event.seq == 0 || event.seq > follow.seq;
                consumer::fold(run, follow, &event, now)
            })
            .await;
        let applied = match applied {
            Ok(Some(applied)) => applied,
            Ok(None) => return Ok(()),
            Err(e) => {
                eprintln!("couldn't apply an event of session {session}: {e}");
                return Err(());
            }
        };
        self.after(&applied.before, &applied.run);
        // A call read again after a reconnect was answered the first time.
        if let (Some((id, name, input)), true) = (call, fresh) {
            self.answer_tool(session, applied.run, id, name, input);
        }
        Ok(())
    }

    fn answer_tool(&self, session: &str, run: Run, call: String, name: String, input: Value) {
        self.answering.lock().unwrap_or_else(|e| e.into_inner()).insert(call.clone());
        let (tools, commands, session) = (self.tools.clone(), self.commands.clone(), session.to_owned());
        tokio::spawn(async move {
            let (output, error) = tools.call(&run, &name, &input).await;
            let _ = commands.send(Command::Answer { session, call, output, error });
        });
    }

    /// Records the loss once and reads on from the first event the harness still holds.
    async fn lost(&self, client: &mut Client, session: &str, reason: &str, lost_at: &mut LostAt) -> Result<(), ()> {
        let follow = match self.core.session_run(session).await {
            Ok(Some((_, follow))) => follow,
            Ok(None) => return Ok(()),
            Err(e) => {
                eprintln!("couldn't read how far session {session} is followed: {e}");
                return Err(());
            }
        };
        if lost_at.get(session) == Some(&follow.seq) {
            eprintln!("events of session {session} were lost again at {}; it is no longer watched", follow.seq);
            return Ok(());
        }
        lost_at.insert(session.to_owned(), follow.seq);
        let page = client.call(Op::Events { session: session.to_owned(), after: follow.seq }).await;
        let first = page.ok().and_then(|page| page["events"].get(0).and_then(|event| event["seq"].as_u64()));
        let last = match first {
            Some(first) => first.saturating_sub(1),
            None => self.last_seq(client, session).await.unwrap_or(follow.seq),
        };
        let (now, reason) = (Utc::now(), reason.to_owned());
        let applied = self
            .core
            .apply_session(session, move |run, follow| {
                consumer::lost(run, follow, &reason, last, now)
            })
            .await;
        match applied {
            Ok(Some(applied)) => {
                self.after(&applied.before, &applied.run);
                if let Err(e) = client.call(Op::Watch { session: session.to_owned(), after: applied.follow.seq }).await {
                    eprintln!("couldn't watch session {session} again: {e}");
                }
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("couldn't record the lost events of session {session}: {e}");
                return Err(());
            }
        }
        Ok(())
    }

    async fn last_seq(&self, client: &mut Client, session: &str) -> Option<u64> {
        let listed = client.call(Op::Sessions).await.ok()?;
        listed.as_array()?.iter().find(|s| s["id"] == session).and_then(|s| s["last_seq"].as_u64())
    }

    /// Tells the notifier, and so Pip, of a run that came to need the person, finished or failed; and the page.
    fn after(&self, before: &Run, run: &Run) {
        if run.state != before.state {
            match run.state {
                RunState::NeedsAnswer | RunState::NeedsPermission => self.notifier.notify(run, Attention::Needs),
                RunState::Done => self.notifier.notify(run, Attention::Done),
                RunState::Failed => self.notifier.notify(run, Attention::Failed),
                _ => {}
            }
        }
        if run != before {
            (self.changed)(&run.connection_id);
        }
        self.applied.send_modify(|n| *n += 1);
    }
}

#[cfg(test)]
mod tests;
