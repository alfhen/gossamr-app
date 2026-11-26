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

/// Why a second answer or a message waits: the harness took the person's answer, and the agent has not had it yet.
pub const ANSWER_ON_ITS_WAY: &str = "Your answer is on its way to the agent. Send more once it has arrived.";
/// A message to a run whose session the harness no longer runs, with no turn it could have lost.
pub const NOT_RUNNING: &str = "Its agent isn't running any more, so it takes no message. Ask Pip to start it again.";

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

    /// Makes a call on a connection of its own and waits for its answer. A call that can start a session again has the
    /// harness watch it on that connection, which goes with this call, so the watching connection follows the session
    /// from what was applied: none of the new start's events is missed, and none applied twice.
    pub async fn call(&self, op: Op) -> Result<Value, String> {
        let resumes = match &op {
            Op::AnswerQuestion { session, .. } | Op::Resume { session, .. } | Op::TakeBack { session } | Op::Send { session, .. } => Some(session.clone()),
            _ => None,
        };
        let mut client = self.inner.connect.connect().await?;
        let answered = client.call(op).await.map_err(|e| e.to_string())?;
        if let Some(session) = resumes {
            let applied = self.inner.core.session_run(&session).await.map_err(|e| e.to_string())?;
            if let Some((_, follow)) = applied.filter(|(_, follow)| !follow.ended) {
                self.follow(&session, follow.seq).await?;
            }
        }
        Ok(answered)
    }

    /// Opens a session for `run_id`, makes it the run's, and watches it, in that order: the run follows the session
    /// before any of its events is applied, and the app listens for its tool calls before it is sent a prompt.
    /// Its error is in the app's words, for the run to show.
    pub async fn open(&self, run_id: &str, op: Op) -> Result<String, String> {
        let opened = self.call(op).await.map_err(|e| format!("it didn't open a session: {e}"))?;
        let session = opened["session"].as_str().ok_or("it answered an open with no session")?.to_owned();
        let bound = self.inner.core.bind_run_session(run_id, &session).await.map_err(|e| {
            eprintln!("couldn't bind session {session} to run {run_id}: {e}");
            "it opened a session but Gossamr couldn't keep it with its run".to_owned()
        });
        let followed = match bound {
            Ok(()) => self.follow(&session, 0).await.map_err(|e| format!("it opened a session but Gossamr couldn't follow it: {e}")),
            Err(e) => Err(e),
        };
        if let Err(why) = followed {
            // A session no run follows is one nothing would stop or clean up.
            let _ = self.call(Op::Close { session }).await;
            return Err(why);
        }
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
        if closed.as_ref().is_err_and(|why| not_running(why)) && self.lost_mid_turn(session).await {
            return self.inner.agent_lost(session).await;
        }
        if closed.is_err() {
            // Not stopped, so a later end of the agent is its own, not this stop's.
            let _ = self.inner.core.apply_session(session, |_, follow| {
                follow.stop_asked = false;
                Vec::new()
            }).await;
        }
        closed
    }

    /// The person's one way to reach the agent: the answer to its open question, else a message. Returns whether it
    /// answered a question. The run waits on its answer no more once the harness took it, though the agent may get it
    /// only when its turn ends.
    pub async fn send(&self, session: &str, text: &str) -> Result<bool, String> {
        let follow = self.inner.core.session_run(session).await.map_err(|e| e.to_string())?.map(|(_, follow)| follow).unwrap_or_default();
        if follow.answered.is_some() && follow.answered == follow.question {
            return Err(ANSWER_ON_ITS_WAY.into());
        }
        // The harness's own copy, for a question the app has not read yet.
        let question = match follow.question {
            Some(question) => Some(question),
            None => self.open_question(session).await,
        };
        let Some(question) = question else {
            return match self.call(Op::Send { session: session.to_owned(), text: text.to_owned() }).await {
                Ok(_) => Ok(false),
                Err(why) if not_running(&why) && self.lost_mid_turn(session).await => {
                    self.inner.agent_lost(session).await?;
                    Err(super::consumer::AGENT_LOST.into())
                }
                Err(why) if not_running(&why) => Err(NOT_RUNNING.into()),
                Err(why) => Err(why),
            };
        };
        self.call(Op::AnswerQuestion { session: session.to_owned(), question: question.clone(), text: text.to_owned() }).await?;
        let noted = self.inner.core.apply_session(session, |run, follow| {
            super::consumer::answered(run, follow, &question);
            Vec::new()
        });
        if let Some(applied) = noted.await.map_err(|e| e.to_string())? {
            self.inner.after(&applied.before, &applied.run);
        }
        Ok(true)
    }

    /// Whether the app follows `session` as not closed though the harness does not run it and stored nothing past what
    /// the app applied: its harness went with no shutdown.
    async fn lost_mid_turn(&self, session: &str) -> bool {
        let Ok(Some((_, follow))) = self.inner.core.session_run(session).await else { return false };
        // Only a turn the app reads as running can have been lost: a finished run stays finished.
        if follow.closed || !follow.in_turn {
            return false;
        }
        self.listed(session).await.is_some_and(|row| row["running"] != true && row["last_seq"].as_u64().unwrap_or(0) <= follow.seq)
    }

    /// The harness's row for `session` in its listing.
    pub async fn listed(&self, session: &str) -> Option<Value> {
        let listed = self.call(Op::Sessions).await.ok()?;
        listed.as_array()?.iter().find(|row| row["id"] == session).cloned()
    }

    async fn open_question(&self, session: &str) -> Option<String> {
        let listed = self.call(Op::Sessions).await.ok()?;
        let row = listed.as_array()?.iter().find(|row| row["id"] == session)?;
        row["open_question"].as_str().map(str::to_owned)
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
    let mut said: Option<String> = None;
    let mut lost_at = LostAt::new();
    // No strong hold on the link while waiting, so the task ends once the last `Link` is dropped.
    let connect = |inner: &std::sync::Weak<Inner>| inner.upgrade().map(|link| link.connect.clone());
    loop {
        let Some(connector) = connect(&inner) else { return };
        let mut client = match connector.connect().await {
            Ok(client) => client,
            Err(e) => {
                // At start the manager has not made its key or started the harness yet, so only a failure that
                // outlasts the backoff is a fault worth a line, and the same one is said once.
                if wait == RETRY_MOST && said.as_deref() != Some(e.as_str()) {
                    eprintln!("couldn't reach the harness: {e}");
                    said = Some(e);
                }
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
        said = None;
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
                        // A watch ends for a session the harness does not run once every stored event was sent. One
                        // the app still reads as mid-turn lost its agent with a harness that went with no shutdown,
                        // after it stored events the app had not read yet.
                        Ok(Some(Push::End { session })) => {
                            if link.ended_mid_turn(&session).await {
                                if let Err(e) = link.agent_lost(&session).await {
                                    eprintln!("couldn't end the lost turn of session {session}: {e}");
                                }
                            }
                        }
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
    // A harness that went with no shutdown recorded no end for a turn it was running: its listing says which. A session
    // with stored events past what was applied is watched, and its watch's end says whether they held its end. A
    // listing that fails cuts nothing, and every session is watched all the same.
    let listed = client.call(Op::Sessions).await.unwrap_or_else(|e| {
        eprintln!("couldn't list the harness's sessions: {e}");
        Value::Null
    });
    let rows: std::collections::HashMap<String, &Value> = listed.as_array().into_iter().flatten().filter_map(|row| Some((row["id"].as_str()?.to_owned(), row))).collect();
    for (session, follow) in followed {
        let lost = rows.get(&session).is_some_and(|row| row["running"] != true && row["last_seq"].as_u64().unwrap_or(0) <= follow.seq);
        if follow.in_turn && lost {
            link.agent_lost(&session).await?;
            continue;
        }
        if let Some(row) = rows.get(&session) {
            link.keep_branch(&session, row).await;
        }
        if let Err(e) = client.call(Op::Watch { session: session.clone(), after: follow.seq }).await {
            eprintln!("couldn't watch session {session}: {e}");
            continue;
        }
        if follow.calls.is_empty() {
            continue;
        }
        // A call whose result the harness took while the app was away has it among the events not applied yet, on any
        // page of them. A page that can't be read answers none of its calls.
        let Some(answered) = results_after(client, &session, follow.seq).await else { continue };
        let Ok(Some((run_id, _))) = link.core.session_run(&session).await else { continue };
        if let Ok(Some(run)) = link.core.run(&run_id).await {
            for (id, name, input) in follow.calls.into_iter().filter(|(id, ..)| !answered.contains(id.as_str())) {
                if !link.answering.lock().unwrap_or_else(|e| e.into_inner()).contains(&id) {
                    link.answer_tool(&session, run.clone(), id, name, input);
                }
            }
        }
    }
    Ok(())
}

/// The ids of the tool results the harness stored for `session` after `after`, read page by page.
async fn results_after(client: &mut Client, session: &str, after: u64) -> Option<std::collections::HashSet<String>> {
    let (mut answered, mut after) = (std::collections::HashSet::new(), after);
    loop {
        let page = client.call(Op::Events { session: session.to_owned(), after }).await.ok()?;
        let events = page["events"].as_array().cloned().unwrap_or_default();
        answered.extend(events.iter().filter(|e| e["type"] == "tool_result").filter_map(|e| e["id"].as_str().map(str::to_owned)));
        after = events.last().and_then(|e| e["seq"].as_u64()).unwrap_or(after);
        if page["more"] != true || events.is_empty() {
            return Some(answered);
        }
    }
}

/// What the harness says of a session it does not run: one a harness that went with no shutdown left as it was.
fn not_running(why: &str) -> bool {
    why.contains("is not running")
}

impl Inner {
    /// Whether the app reads `session` as in a turn that nothing closed, now that its watch ended.
    async fn ended_mid_turn(&self, session: &str) -> bool {
        matches!(self.core.session_run(session).await, Ok(Some((_, follow))) if follow.in_turn && !follow.closed)
    }

    /// Gives a run with no branch yet the branch and worktree the harness made for its session, as its open keeps
    /// them: an open whose listing failed, or that the app quit after, is filled in at the next connect.
    async fn keep_branch(&self, session: &str, row: &Value) {
        let (Some(branch), Some(worktree)) = (row["branch"].as_str(), row["cwd"].as_str()) else { return };
        let (branch, worktree) = (branch.to_owned(), std::path::PathBuf::from(worktree));
        let kept = self.core.apply_session(session, move |run, _| {
            if run.branch.is_none() {
                run.branch = Some(branch);
                run.expected_worktree = worktree;
            }
            Vec::new()
        });
        if let Err(e) = kept.await {
            eprintln!("couldn't keep the branch of session {session}: {e}");
        }
    }

    /// Ends, in the app only, the turn of a session the harness does not run though the app follows it as running: the
    /// harness that ran it went with no shutdown, so nothing recorded its end. Pip is not woken.
    async fn agent_lost(&self, session: &str) -> Result<(), String> {
        let now = Utc::now();
        let lost = self.core.apply_session(session, |run, follow| consumer::agent_lost(run, follow, now));
        if let Some(applied) = lost.await.map_err(|e| e.to_string())? {
            self.after(&applied.before, &applied.run);
        }
        Ok(())
    }

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
            .apply_session_reporting(session, |run, follow| {
                fresh = event.seq == 0 || event.seq > follow.seq;
                let report = fresh.then(|| consumer::report_of(&event.body)).flatten();
                (consumer::fold(run, follow, &event, now), report)
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
        // A failed read is not an empty page: what it could not read may still be there, so nothing is passed over.
        let page = match client.call(Op::Events { session: session.to_owned(), after: follow.seq }).await {
            Ok(page) => page,
            Err(e) => {
                eprintln!("couldn't read what session {session} still holds after a loss: {e}");
                return Err(());
            }
        };
        let first = page["events"].get(0).and_then(|event| event["seq"].as_u64());
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
                // Only a loss that was recorded is one not to record again at the same place.
                lost_at.insert(session.to_owned(), follow.seq);
                self.after(&applied.before, &applied.run);
                if let Err(e) = client.call(Op::Watch { session: session.to_owned(), after: applied.follow.seq }).await {
                    eprintln!("couldn't watch session {session} again: {e}");
                    return Err(());
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
        // A new request while the run already waits on one is a new need too.
        let new_need = run.state == before.state && run.needs.is_some() && run.needs != before.needs;
        if run.state != before.state || new_need {
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
pub(crate) mod served;
#[cfg(test)]
mod tests;
