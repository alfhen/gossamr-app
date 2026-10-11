//! Sending a finished agent back for another pass, with a message the person read and approved.
//!
//! The continuation rules are the answer's (`claude --bg --resume <session id> -- <message>` with no other flag, on a
//! session that is no longer running, checking that the id that comes back is the run's), except that a finished
//! session is listed as `done` and needs no stop.

use chrono::Utc;

use super::cli::is_uuid;
use super::limits;
use super::service::{belongs_to, RunService};
use sha2::Digest;

use crate::config::rule_runs;
use crate::domain::workstream::Rule;
use crate::domain::{Actor, CreatedBy, Intent, ProposalState, Run, RunEvent, RunKind, RunState, WorkstreamEvent};
use crate::inbox::NOT_ON_ITS_OWN;
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
        match self.another_pass(&mut run, message, again).await? {
            None => {
                let now = run.last_progress_at;
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

    /// Sends `run` back for another pass with `message`: stops its session if it is still alive, resumes it with the
    /// message, and on success stores it working on its next pass. `again` resends to a session that was already stopped
    /// on the way. `Ok(Some(why))` when the session couldn't be woken; the run is then left for the caller to store.
    async fn another_pass(&self, run: &mut Run, message: &str, again: bool) -> Result<Option<String>> {
        let id = run.short_id.clone().ok_or_else(|| refuse("This run has no session to resume."))?;
        let session = run.session_id.clone().filter(|s| is_uuid(s)).ok_or_else(|| refuse("This run has no session to resume."))?;
        let tc = self.toolchain().await?;

        if !again {
            let listed = tc.cli.agents(true).await?;
            let alive = listed.iter().find(|e| belongs_to(e, run)).is_some_and(|e| !matches!(e.state.as_deref(), Some("stopped" | "done")));
            if alive {
                tc.cli.stop(&id).await?;
                Self::stopped(run);
                if let Err(e) = self.index.mark_terminal(&run.id) {
                    eprintln!("couldn't update the run index: {e}");
                }
                self.reset_counts(&run.id);
                run.unsent_answer = Some(message.to_string());
                self.store(run).await?;
            }
        }

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
        run.stopped_by_limit = false;
        run.continued_at = Some(now);
        run.passes = run.passes.saturating_add(1);
        limits::tick(run, now);
        self.remember(run);
        self.store(run).await?;
        if let Err(e) = self.core.report_stale(&run.id).await {
            eprintln!("couldn't mark the report of run {} as older than the follow-up: {e}", run.id);
        }
        Ok(None)
    }

    /// Sends a workstream's build back to fix what the blocking review `review` found, by auto-start rule `fix_round`:
    /// the same resume as a follow-up, with no draft for the person to read. Only a finished build that pushes to a
    /// draft pull request in a workstream can be sent, and only while that workstream starts steps on its own with the
    /// rule on, checked under the launch lock so a Hold, Hold all, Stop, Advise or switch made while the supervisor was
    /// deciding wins; that refusal is `NOT_ON_ITS_OWN`. The round is counted before the session is woken: the Supervisor
    /// `autostart` line `fix_round after <review>`, which the rules count and which says the review was dealt with, is
    /// written first, and a send whose line can't be written doesn't go. A round whose resume then fails stays counted,
    /// so the cap of rounds is never passed. After the resume the audit also gets a `fix_round_sent` line with the
    /// message's digest and length, never its text.
    pub async fn send_fix_round(&self, run_id: &str, review: &str, message: &str) -> Result<Run> {
        self.ensure_enabled()?;
        let _turn = self.launching.lock().await;
        let mut run = self.load(run_id).await?;
        let Some(ws) = run.spec.workstream.clone() else { return Err(refuse("a fix round goes only to a workstream's build")) };
        if run.spec.kind != RunKind::Build || !run.spec.allow_push {
            return Err(refuse("a fix round goes only to a workstream's build that pushes to a draft pull request"));
        }
        if run.state != RunState::Done {
            return Err(refuse(format!("This build is {}, so it can't be sent a fix round.", run.state.as_str())));
        }
        if let Some(why) = run.follow_up_blocker() {
            return Err(refuse(format!("This build can't be sent back: {why}.")));
        }
        let scope = self.core.scope().await?;
        let settings = self.settings();
        if !matches!(self.core.workstream(&scope, &ws).await?, Some(v) if rule_runs(&settings, &v.workstream, Rule::FixRound)) {
            return Err(refuse(NOT_ON_ITS_OWN));
        }
        let digest = format!("{:x}", sha2::Sha256::digest(message.as_bytes()));
        let counted = WorkstreamEvent::new(&ws, Actor::Supervisor, "autostart", Utc::now()).run(&run.id).digest(&digest).detail(format!("{} after {review}", Rule::FixRound.as_str()));
        self.core.record_workstream_event(&scope, counted).await?;
        match self.another_pass(&mut run, message, false).await? {
            None => {
                let event = RunEvent {
                    run_id: run.id.clone(),
                    seq: 0,
                    at: run.last_progress_at,
                    kind: "follow_up".into(),
                    text: "Gossamr asked for another pass: fix what the review found blocking".into(),
                    detail: Some(format!("Pass {}. Started automatically.", run.passes)),
                };
                if let Err(e) = self.core.append_run_events(&run.id, &[event]).await {
                    eprintln!("couldn't record the fix round: {e}");
                }
                let line = WorkstreamEvent::new(&ws, Actor::Supervisor, "fix_round_sent", run.last_progress_at).run(&run.id).digest(&digest).detail(message.chars().count().to_string());
                if let Err(e) = self.core.record_workstream_event(&scope, line).await {
                    eprintln!("couldn't record the fix round of run {} in workstream {ws}: {e}", run.id);
                }
                Ok(run)
            }
            Some(why) => {
                if run.state == RunState::Stopped {
                    run.error = Some(why.clone());
                }
                self.store(&run).await?;
                Err(Error::Claude(why))
            }
        }
    }
}

#[cfg(test)]
mod tests;
