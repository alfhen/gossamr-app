//! Sending a finished agent back for another pass, with a message the person read and approved.
//!
//! The continuation rules are the answer's (`claude --bg --resume <session id> -- <message>` with no other flag, on a
//! session that is no longer running, checking that the id that comes back is the run's), except that a finished
//! session is listed as `done` and needs no stop.

use chrono::Utc;

use super::cli::is_uuid;
use super::limits;
use super::service::{belongs_to, RunService};
use crate::domain::{CreatedBy, Intent, ProposalState, Run, RunEvent, RunState};
use crate::error::{Error, Result};
use crate::proposals;

fn refuse(message: impl Into<String>) -> Error {
    Error::Proposal(message.into())
}

impl RunService {
    /// Approves a pending follow-up: resumes its run with the message and marks the draft applied. A failure keeps the
    /// draft pending with the reason, and a session that was stopped on the way keeps the message on the run, so
    /// approving again sends it.
    pub async fn send_follow_up(&self, proposal_id: &str, read: &str) -> Result<Run> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        let p = self.core.proposal(proposal_id).await?.ok_or_else(|| refuse("that draft no longer exists"))?;
        let Intent::FollowUp { connection_id, run_id, message, reason, .. } = &p.intent else { return Err(refuse("that draft isn't a follow-up")) };
        if p.state != ProposalState::Pending {
            return Err(refuse("that follow-up has already been decided"));
        }
        if read.trim() != message.trim() {
            return Err(refuse("The message changed after you read it. Read it again."));
        }
        let mut run = self.load(run_id).await?;
        if run.connection_id != *connection_id {
            return Err(refuse("that run belongs to another connection"));
        }
        let kept = |r: &crate::domain::Revision| r.note == proposals::SEND_FAILED_NOTE && matches!(&r.intent, Intent::FollowUp { message: m, .. } if Some(m.as_str()) == run.unsent_answer.as_deref());
        let again = run.state == RunState::Stopped && p.revisions.iter().any(kept);
        if !again {
            if let Some(why) = run.follow_up_blocker() {
                return Err(refuse(format!("This run can't be sent back: {why}.")));
            }
        }
        let id = run.short_id.clone().ok_or_else(|| refuse("This run has no session to resume."))?;
        let session = run.session_id.clone().filter(|s| is_uuid(s)).ok_or_else(|| refuse("This run has no session to resume."))?;
        let tc = self.toolchain().await?;

        if !again {
            let listed = tc.cli.agents(true).await?;
            let alive = listed.iter().find(|e| belongs_to(e, &run)).is_some_and(|e| !matches!(e.state.as_deref(), Some("stopped" | "done")));
            if alive {
                tc.cli.stop(&id).await?;
                Self::stopped(&mut run);
                if let Err(e) = self.index.mark_terminal(&run.id) {
                    eprintln!("couldn't update the run index: {e}");
                }
                self.reset_counts(&run.id);
                run.unsent_answer = Some(message.clone());
                self.store(&run).await?;
            }
        }

        match self.wake_from(&tc, &mut run, &id, &session, message, true, &["stopped", "done"]).await {
            None => {
                let now = Utc::now();
                run.state = RunState::Working;
                run.needs = None;
                run.suggested_reply = None;
                run.unsent_answer = None;
                run.error = None;
                run.failure = None;
                run.ended_at = None;
                run.last_progress_at = now;
                run.stopped_by_limit = false;
                run.continued_at = Some(now);
                run.passes = run.passes.saturating_add(1);
                limits::tick(&mut run, now);
                self.remember(&run);
                self.store(&run).await?;
                if let Err(e) = self.core.report_stale(&run.id).await {
                    eprintln!("couldn't mark the report of run {} as older than the follow-up: {e}", run.id);
                }
                let by = match p.created_by {
                    CreatedBy::Pip => "Pip",
                    CreatedBy::Agent => "An agent run",
                    CreatedBy::User | CreatedBy::Autopilot => "You",
                };
                let event = RunEvent {
                    run_id: run.id.clone(),
                    seq: 0,
                    at: now,
                    kind: "follow_up".into(),
                    text: format!("{by} asked for another pass: {reason}"),
                    detail: Some(format!("Pass {}. Approved by you.", run.passes)),
                };
                if let Err(e) = self.core.append_run_events(&run.id, &[event]).await {
                    eprintln!("couldn't record the follow-up: {e}");
                }
                self.core.follow_up_sent(proposal_id, &run.id).await?;
                Ok(run)
            }
            Some(why) => {
                let stopped = run.state == RunState::Stopped;
                if stopped {
                    run.error = Some(why.clone());
                    run.unsent_answer = Some(message.clone());
                }
                self.store(&run).await?;
                if let Err(e) = self.core.follow_up_failed(proposal_id, &why, stopped.then_some(message.as_str())).await {
                    eprintln!("couldn't note why the follow-up failed: {e}");
                }
                Err(Error::Claude(format!("{why} The follow-up is kept.")))
            }
        }
    }
}

#[cfg(test)]
mod tests;
