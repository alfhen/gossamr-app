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
use harness::event::{Body, Decision, Event};
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

/// An answer to a permission request the run's session does not hold open.
pub const NOT_OPEN: &str = "That request isn't open any more: it was answered or withdrawn, or it isn't this run's.";
/// An answer to a permission request of a session the harness no longer runs.
pub const NOT_RUNNING_TO_ANSWER: &str = "Its agent isn't running any more, so the request can't be answered.";

const RETRY_FIRST: Duration = Duration::from_millis(100);
const RETRY_MOST: Duration = Duration::from_secs(5);
/// How long `caught_up` waits for an event before it asks the harness again.
const CAUGHT_UP_TICK: Duration = Duration::from_millis(500);

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
    /// How many of the next follows fail, for a test of what a failed follow leaves.
    #[cfg(test)]
    failing_follows: std::sync::atomic::AtomicUsize,
}

impl Link {
    /// Starts the watching task, which follows every session the app's runs still follow.
    pub fn start(core: Arc<Core>, connect: Arc<dyn Connect>, tools: Arc<dyn ClientTools>, notifier: Arc<dyn RunNotifier>, changed: Arc<dyn Fn(&str) + Send + Sync>) -> Link {
        let (commands, received) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner { core, connect, tools, notifier, changed, commands, applied: watch::channel(0).0, unread: Default::default(), answering: Default::default(), #[cfg(test)] failing_follows: Default::default() });
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
        let answered = self.ask(op).await?;
        if let Some(session) = resumes {
            let applied = self.inner.core.session_run(&session).await.map_err(|e| e.to_string())?;
            if let Some((_, follow)) = applied.filter(|(_, follow)| !follow.ended) {
                self.follow(&session, follow.seq).await?;
            }
        }
        Ok(answered)
    }

    /// The harness's answer to `op`, and nothing more: `call` without its follow.
    async fn ask(&self, op: Op) -> Result<Value, String> {
        let mut client = self.inner.connect.connect().await?;
        client.call(op).await.map_err(|e| e.to_string())
    }

    /// Makes the next `n` follows fail, as a watch the harness refused would.
    #[cfg(test)]
    pub fn fail_follows(&self, n: usize) {
        self.inner.failing_follows.store(n, std::sync::atomic::Ordering::SeqCst);
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

    /// Resumes a session that is not running with `carry_on` as its prompt, counting it, and follows it again. The harness
    /// refuses one a deny, a cancel, a stop or an open request forbids, or a shutdown gave up on, and says why.
    pub async fn carry_on(&self, session: &str, carry_on: &str) -> Result<(), String> {
        self.resume(session, carry_on, true).await
    }

    /// Resumes a session that is not running and sends it the person's or Pip's message as its next prompt. Not as a
    /// carry on: the harness refuses one after a stop, a deny, a cancel or a request left open, which the person's own
    /// choice to go on must not meet. A message starts the count of carry-ons again.
    pub async fn resume_with(&self, session: &str, text: &str) -> Result<(), String> {
        self.resume(session, text, false).await
    }

    async fn resume(&self, session: &str, prompt: &str, counted: bool) -> Result<(), String> {
        // While the harness keeps the session no resume is sent: its row says why, and what to do.
        if let Some(why) = self.kept(session).await {
            return Err(why);
        }
        // Counted, the cut taken and the session marked as starting, before the call, as a take back marks itself: the
        // call's watch may apply the new start's cut before it returns, which must read the new count, and a message or
        // a carry on that reads the follow meanwhile finds nothing to resume, and a message goes to the new start. A
        // refusal puts them back.
        let (carry_ons, cut) = match self.inner.core.session_run(session).await.map_err(|e| e.to_string())? {
            Some((_, follow)) => (follow.carry_ons, follow.cut),
            None => (0, None),
        };
        let mark = |carry_ons: u32, cut: Option<String>, resuming: bool| {
            self.inner.core.apply_session(session, move |_, follow| {
                (follow.carry_ons, follow.cut, follow.resuming) = (carry_ons, cut, resuming);
                Vec::new()
            })
        };
        mark(if counted { carry_ons + 1 } else { 0 }, None, true).await.map_err(|e| e.to_string())?;
        let carry_on = counted.then(|| prompt.to_owned());
        // Asked apart from its follow, so only a refusal puts the marks back.
        if let Err(why) = self.ask(Op::Resume { session: session.to_owned(), carry_on }).await {
            if let Err(e) = mark(carry_ons, cut, false).await {
                eprintln!("couldn't put back the count of carry-ons of session {session}: {e}");
            }
            return Err(why);
        }
        // Taken: the session starts again whether or not this watch is set up, and the next connect follows it, so a
        // failed follow leaves it marked as starting and the message is sent all the same.
        let follow = self.inner.core.session_run(session).await.map_err(|e| e.to_string())?.map(|(_, follow)| follow).unwrap_or_default();
        if let Err(e) = self.follow(session, follow.seq).await {
            eprintln!("couldn't follow session {session} after its resume; the next connect follows it: {e}");
        }
        if !counted {
            self.send(session, prompt).await?;
        }
        Ok(())
    }

    /// Waits up to `limit` until the app has applied every event the harness holds for each session it follows, and
    /// marked lost each turn the harness no longer runs: after a harness start, once the watch has reconnected and
    /// caught up. False if that did not happen within `limit`.
    pub async fn caught_up(&self, limit: Duration) -> bool {
        let mut applied = self.applied();
        let caught_up = async {
            while !self.is_caught_up().await {
                // An event applied, or a moment for a harness still starting, before asking again.
                let _ = tokio::time::timeout(CAUGHT_UP_TICK, applied.changed()).await;
            }
        };
        tokio::time::timeout(limit, caught_up).await.is_ok()
    }

    async fn is_caught_up(&self) -> bool {
        let (Ok(listed), Ok(followed)) = (self.ask(Op::Sessions).await, self.inner.core.followed_sessions().await) else { return false };
        let rows: HashMap<&str, &Value> = listed.as_array().into_iter().flatten().filter_map(|row| Some((row["id"].as_str()?, row))).collect();
        followed.iter().all(|(session, follow)| match rows.get(session.as_str()) {
            Some(row) => row["last_seq"].as_u64().unwrap_or(0) <= follow.seq && !(follow.in_turn && !follow.closed && row["running"] != true),
            None => true,
        })
    }

    /// Takes a session handed over to Terminal back and follows it again. The harness watches the new start on the
    /// connection that asked, which is this call's own, so the watching connection reads it from what was applied.
    pub async fn take_back(&self, session: &str) -> Result<(), String> {
        // Marked before the call, whose watch may apply the new start's end before the call returns: a mark set after
        // it would undo the `failed` or `closed` that cleared it.
        let marked = self.inner.core.apply_session(session, |_, follow| {
            follow.taken_back = true;
            Vec::new()
        });
        marked.await.map_err(|e| e.to_string())?;
        if let Err(why) = self.ask(Op::TakeBack { session: session.to_owned() }).await {
            let _ = self.inner.core.apply_session(session, |_, follow| {
                follow.taken_back = false;
                Vec::new()
            }).await;
            return Err(why);
        }
        // Taken back: the harness's mark is gone and the session starts again, so the app reads it so before it
        // follows, and a follow that fails leaves a session the next connect follows, not one handed over for good.
        let taken = self.inner.core.apply_session(session, |run, follow| {
            run.handed_over = false;
            follow.closed = false;
            Vec::new()
        });
        let follow = taken.await.map_err(|e| e.to_string())?.map(|applied| applied.follow).unwrap_or_default();
        self.follow(session, follow.seq).await
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

    /// Answers the open permission request `request` of `session`, once, for that request alone: never "always", never
    /// for the session. The run waits on it no more once the harness took it.
    pub async fn permit(&self, session: &str, request: &str, decision: Decision) -> Result<(), String> {
        match self.call(Op::Answer { session: session.to_owned(), request: request.to_owned(), decision, message: None }).await {
            Ok(_) => {}
            Err(why) if why.starts_with("no open permission request") => return Err(NOT_OPEN.into()),
            Err(why) if not_running(&why) => return Err(NOT_RUNNING_TO_ANSWER.into()),
            Err(why) => return Err(why),
        }
        // The harness took it, so it is taken: a run that can't note it now reads it from the `answered` event.
        let noted = self.inner.core.apply_session(session, |run, follow| {
            consumer::permission_answered(run, follow, request);
            Vec::new()
        });
        match noted.await {
            Ok(Some(applied)) => self.inner.after(&applied.before, &applied.run),
            Ok(None) => {}
            Err(e) => eprintln!("the harness took an answer to a request of session {session}, but Gossamr couldn't note it: {e}"),
        }
        Ok(())
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

    /// Why the harness resumes `session` for no one now, from its row: `held` while it could not check for agents an
    /// earlier harness left running, or `given_up` while an agent or process this session left may still run.
    pub async fn kept(&self, session: &str) -> Option<String> {
        kept_by(&self.listed(session).await?)
    }

    async fn open_question(&self, session: &str) -> Option<String> {
        let listed = self.call(Op::Sessions).await.ok()?;
        let row = listed.as_array()?.iter().find(|row| row["id"] == session)?;
        row["open_question"].as_str().map(str::to_owned)
    }

    /// Watches a session from after `after`, once the watching connection is up.
    pub async fn follow(&self, session: &str, after: u64) -> Result<(), String> {
        #[cfg(test)]
        {
            use std::sync::atomic::Ordering::SeqCst;
            let left = self.inner.failing_follows.load(SeqCst);
            if left > 0 {
                self.inner.failing_follows.store(left - 1, SeqCst);
                return Err("the watch failed, for a test".into());
            }
        }
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
    // Any session the listing names a branch for, followed or not: one that closed, or was cut, before its open kept
    // the branch still has it filled in.
    for (session, row) in &rows {
        link.keep_branch(session, row).await;
    }
    for (session, follow) in followed {
        let lost = rows.get(&session).is_some_and(|row| row["running"] != true && row["last_seq"].as_u64().unwrap_or(0) <= follow.seq);
        if follow.in_turn && lost {
            link.agent_lost(&session).await?;
            continue;
        }
        link.recover_permissions(client, &session, &follow).await;
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

/// The `permission` events the harness stored for `session` up to `upto` whose id is in `ids`, read page by page.
async fn asked_up_to(client: &mut Client, session: &str, upto: u64, ids: &[&str]) -> Option<Vec<Event>> {
    let (mut asked, mut after) = (Vec::new(), 0);
    loop {
        let page = client.call(Op::Events { session: session.to_owned(), after }).await.ok()?;
        let events = page["events"].as_array().cloned().unwrap_or_default();
        after = events.last().and_then(|e| e["seq"].as_u64()).unwrap_or(after);
        // One event of a type this build can't read is passed over, as the watch does.
        let read = events.into_iter().filter_map(|e| serde_json::from_value::<Event>(e).ok());
        let wanted = |body: &Body| match body {
            Body::Permission { id, .. } => ids.contains(&id.as_str()),
            Body::Withheld { of, kept } => of == "permission" && kept.get("id").and_then(Value::as_str).is_some_and(|id| ids.contains(&id)),
            _ => false,
        };
        asked.extend(read.filter(|e| e.seq <= upto && wanted(&e.body)));
        if page["more"] != true || after >= upto || after == 0 {
            return Some(asked);
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
        // Read first, so a run that has its branch, or a session no run follows, costs no write.
        let Ok(Some((run_id, _))) = self.core.session_run(session).await else { return };
        if !matches!(self.core.run(&run_id).await, Ok(Some(run)) if run.branch.is_none()) {
            return;
        }
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

    /// A run saved before runs kept their open permission requests has them only in its follow: read them again from
    /// the harness. A list it cannot read now is left for the next connect.
    async fn recover_permissions(&self, client: &mut Client, session: &str, follow: &crate::domain::SessionFollow) {
        let Ok(Some((run_id, _))) = self.core.session_run(session).await else { return };
        let Ok(Some(run)) = self.core.run(&run_id).await else { return };
        let missing: Vec<&str> = follow.permissions.iter().map(|(id, ..)| id.as_str()).filter(|id| !run.permissions.iter().any(|open| open.id == *id)).collect();
        if missing.is_empty() {
            return;
        }
        let Some(asked) = asked_up_to(client, session, follow.seq, &missing).await else { return };
        match self.core.apply_session(session, |run, follow| {
            consumer::recover_permissions(run, follow, &asked);
            Vec::new()
        }).await {
            Ok(Some(applied)) => self.after(&applied.before, &applied.run),
            Ok(None) => {}
            Err(e) => eprintln!("couldn't keep the permission requests of session {session}: {e}"),
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

/// Why the harness keeps the session of listed `row` from any resume, as its row says.
fn kept_by(row: &Value) -> Option<String> {
    row["held"].as_str().or_else(|| row["given_up"].as_str()).map(str::to_owned)
}

#[cfg(test)]
pub(crate) mod served;
#[cfg(test)]
mod tests;
