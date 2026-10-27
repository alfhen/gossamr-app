//! Pip's messages to an agent. What happens to one depends on what the agent is doing: a question it waits on in `ask`
//! is answered at once, a session that has stopped or finished is resumed, and an agent that is still working gets the
//! message when it next asks or when its turn ends. The resume is `claude --bg --resume <session id> -- <message>` with
//! no other flag, on a session that is no longer running, checking that the id that comes back is the run's.

use chrono::Utc;

use super::answer::checked;
use super::cli::{is_uuid, AgentEntry};
use super::service::{belongs_to, RunService};
use crate::domain::{Actor, Run, RunEvent, RunState};
use crate::error::{Error, Result};

/// What became of a message to an agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// It answered a question the agent was waiting on.
    Answered,
    /// The agent's session was woken with it.
    Resumed,
    /// The agent is working; it gets the message at its next `ask` or when its turn ends.
    Queued,
}

/// What a resume says when every slot is taken, so the queued message waits instead of being dropped.
const NO_SLOT: &str = "Every agent slot is taken; try again when one finishes.";

/// How many times a queued message's wake may fail before the message is dropped.
const WAKE_TRIES: u8 = 3;

const IN_TERMINAL: &str = "A session is open on it in Terminal, so the person is in it.";
const NOT_WAITING: &str = "It isn't waiting for an answer any more. Look again in a moment.";

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

fn at_rest(state: RunState) -> bool {
    matches!(state, RunState::Done | RunState::Failed | RunState::Stopped)
}

impl RunService {
    /// Why Pip may not wake `run` now: its workstream is closed or paused, as `start_agent` words it.
    async fn workstream_hold(&self, run: &Run) -> Option<String> {
        let ws = run.spec.workstream.as_deref()?;
        let scope = self.core.scope().await.ok()?;
        let view = self.core.workstream(&scope, ws).await.ok()??.workstream;
        if view.closed_at.is_some() {
            return Some(format!("The workstream “{}” is closed.", view.title));
        }
        view.paused_reason.is_some().then(|| format!("The workstream “{}” is paused; only the person resumes it.", view.title))
    }

    /// Sends `text` to run `run_id` as `by`. Refused for a run that hasn't started, failed, waits at a permission prompt
    /// or for a sign-in, or has a session open in Terminal.
    pub async fn message_agent(&self, run_id: &str, text: &str, by: Actor) -> Result<(Run, Delivery)> {
        let text = checked(text)?;
        let run = self.load(run_id).await?;
        let asking = !at_rest(run.state) && self.core.asks().question(run_id).is_some();
        let wakes = asking || matches!(run.state, RunState::NeedsAnswer | RunState::Done | RunState::Stopped);
        if let Some(why) = self.workstream_hold(&run).await.filter(|_| by == Actor::Pip && wakes) {
            return Err(refuse(why));
        }
        match run.state {
            _ if asking => self.answer_as(run_id, text, by).await.map(|r| (r, Delivery::Answered)),
            RunState::Queued | RunState::Launching => Err(refuse("It hasn't started working yet; message it once it is working.")),
            RunState::Failed => Err(refuse("It failed, so there is nothing to message.")),
            RunState::Unknown => Err(refuse("Gossamr can't find its session right now.")),
            RunState::NeedsPermission => Err(refuse("It is waiting at a permission prompt; the person answers it in Terminal.")),
            RunState::SystemBlocked => Err(refuse("Claude needs the person to sign in, in Terminal.")),
            RunState::NeedsAnswer => self.answer_as(run_id, text, by).await.map(|r| (r, Delivery::Answered)),
            RunState::Working => {
                self.core.queue_run_message(run_id, text).await?;
                self.note_by(&run, by, "agent_message_queued", Some(text.chars().count().to_string())).await;
                Ok((run, Delivery::Queued))
            }
            RunState::Stopped if run.unsent_answer.is_some() => Err(refuse("A message is still waiting to be sent to it; the person sends it again from the run.")),
            RunState::Done | RunState::Stopped => self.resume_with(run_id, text, by).await.map(|r| (r, Delivery::Resumed)),
        }
    }

    /// Wakes the finished or stopped session of `run_id` with `text`, unless a session is open on it in Terminal:
    /// stopping that would end what the person is doing there.
    async fn resume_with(&self, run_id: &str, text: &str, by: Actor) -> Result<Run> {
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        if !matches!(run.state, RunState::Done | RunState::Stopped) {
            return Err(refuse(format!("This run is {}, so it can't be resumed.", run.state.as_str())));
        }
        if run.short_id.is_none() || !run.session_id.as_deref().is_some_and(is_uuid) {
            return Err(refuse("It has no session to resume."));
        }
        if by == Actor::Pip {
            if let Some(why) = self.workstream_hold(&run).await {
                return Err(refuse(why));
            }
            if self.live_elsewhere(&run) >= self.cap() {
                return Err(refuse(NO_SLOT));
            }
        }
        let tc = self.toolchain().await?;
        let listed = tc.cli.agents(true).await?;
        let attached = |e: &AgentEntry| match e.state.as_deref() {
            Some("stopped") => false,
            Some("done") => e.pid.is_some(),
            _ => true,
        };
        if listed.iter().find(|e| belongs_to(e, &run)).is_some_and(attached) {
            return Err(refuse(IN_TERMINAL));
        }
        if let Some(why) = self.another_pass(&mut run, text).await? {
            return Err(Error::Claude(why));
        }
        let event = RunEvent {
            run_id: run.id.clone(),
            seq: 0,
            at: run.last_progress_at,
            kind: "follow_up".into(),
            text: if by == Actor::Pip { "Pip sent a message".into() } else { "You sent a message".into() },
            detail: Some(format!("Pass {}.", run.passes)),
        };
        if let Err(e) = self.core.append_run_events(&run.id, &[event]).await {
            eprintln!("couldn't record the message to run {}: {e}", run.id);
        }
        self.note_by(&run, by, "run_resumed", Some(text.chars().count().to_string())).await;
        Ok(run)
    }

    /// Sends `run` back for another pass with `message`: resumes its finished or stopped session and on success stores
    /// it working on its next pass. `Ok(Some(why))` when the session couldn't be woken; the run is then left for the
    /// caller to store.
    async fn another_pass(&self, run: &mut Run, message: &str) -> Result<Option<String>> {
        let id = run.short_id.clone().ok_or_else(|| refuse("This run has no session to resume."))?;
        let session = run.session_id.clone().filter(|s| is_uuid(s)).ok_or_else(|| refuse("This run has no session to resume."))?;
        let tc = self.toolchain().await?;
        if let Some(why) = self.wake_from(&tc, run, &id, &session, message, true, &["stopped", "done"]).await {
            return Ok(Some(why));
        }
        let now = Utc::now();
        run.state = RunState::Working;
        run.needs = None;
        run.suggested_reply = None;
        run.unsent_answer = None;
        run.error = None;
        run.failure = None;
        run.ended_at = None;
        run.last_progress_at = now;
        run.continued_at = Some(now);
        run.passes = run.passes.saturating_add(1);
        self.remember(run);
        self.store(run).await?;
        if let Err(e) = self.core.report_stale(&run.id).await {
            eprintln!("couldn't mark the report of run {} as older than the message: {e}", run.id);
        }
        Ok(None)
    }

    /// Whether a failed delivery is worth trying again on a later poll: a passing refusal always is, a failed wake only
    /// until it has failed `WAKE_TRIES` times, since each try holds the launch lock for seconds.
    fn worth_retrying(&self, run_id: &str, e: &Error) -> bool {
        match e {
            Error::Proposal(why) => [NO_SLOT, IN_TERMINAL, NOT_WAITING].contains(&why.as_str()),
            Error::Claude(_) => {
                let mut tries = self.delivery_failures.lock().expect("delivery failures lock poisoned");
                let n = tries.entry(run_id.to_owned()).or_default();
                *n += 1;
                *n < WAKE_TRIES
            }
            _ => false,
        }
    }

    /// Hands each run's waiting message to it once it can have it: a run that is done, or ended its turn with a question,
    /// is sent it as an answer or by resume. One that is still working, or waits on a permission prompt or sign-in,
    /// keeps it, as does one whose workstream is closed or paused, or a resume with no free slot. One that failed or was
    /// stopped has no one to take it, so it is dropped and the workstream's audit says so. The message is taken before it
    /// is sent, so one queued meanwhile isn't lost, and put back when the send failed for a reason that passes, or a wake failed fewer than three times.
    pub(super) async fn deliver_queued(&self) {
        let Ok(waiting) = self.core.runs_with_messages().await else { return };
        for id in waiting {
            let Ok(Some(_)) = self.core.run_message(&id).await else { continue };
            let Ok(run) = self.load(&id).await else {
                let _ = self.core.take_run_message(&id).await;
                continue;
            };
            let ready = match run.state {
                RunState::Done | RunState::NeedsAnswer => self.workstream_hold(&run).await.is_none(),
                RunState::Failed => true,
                RunState::Stopped => run.unsent_answer.is_none(),
                _ => false,
            };
            if !ready {
                continue;
            }
            let Ok(Some(text)) = self.core.take_run_message(&id).await else { continue };
            let sent = match run.state {
                RunState::Done => self.resume_with(&id, &text, Actor::Pip).await.map(drop),
                RunState::NeedsAnswer => self.answer_as(&id, &text, Actor::Pip).await.map(drop),
                _ => Err(refuse(format!("the run is {}", run.state.as_str()))),
            };
            let Err(e) = sent else {
                self.delivery_failures.lock().expect("delivery failures lock poisoned").remove(&id);
                continue;
            };
            eprintln!("couldn't deliver the message waiting for run {id}: {e}");
            if self.load(&id).await.is_ok_and(|r| r.unsent_answer.is_some()) {
                continue;
            }
            if self.worth_retrying(&id, &e) {
                if let Err(e) = self.core.restore_run_message(&id, &text).await {
                    eprintln!("couldn't keep the message waiting for run {id}: {e}");
                }
            } else {
                self.delivery_failures.lock().expect("delivery failures lock poisoned").remove(&id);
                self.note_by(&run, Actor::Pip, "agent_message_dropped", Some(e.to_string())).await;
            }
        }
    }
}

/// When a queued message reaches its run at its next `ask`: it is the result of that call, so the run never waits.
/// The question is kept on the run's steps, as nobody else sees it.
pub async fn take_for_ask(core: &crate::inbox::Core, run: &Run, question: &str) -> Option<String> {
    let text = core.take_run_message(&run.id).await.ok().flatten()?;
    let event = RunEvent { run_id: run.id.clone(), seq: 0, at: Utc::now(), kind: "answered".into(), text: "Pip answered".into(), detail: Some(format!("It asked: {question}")) };
    if let Err(e) = core.append_run_events(&run.id, &[event]).await {
        eprintln!("couldn't record the answer: {e}");
    }
    if let Err(e) = core.record_run_action_by(run, Actor::Pip, "run_answered", Some(text.chars().count().to_string())).await {
        eprintln!("couldn't record the answer to run {} in its workstream: {e}", run.id);
    }
    if let Err(e) = core.report_stale(&run.id).await {
        eprintln!("couldn't mark the report of run {} as older than the answer: {e}", run.id);
    }
    Some(text)
}

#[cfg(test)]
mod tests;
