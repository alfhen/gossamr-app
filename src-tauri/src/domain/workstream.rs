//! A workstream: one piece of work (usually a ticket) that a person, Pip and the agent runs it links carry from intake
//! to done. Its stage is derived from the linked runs every time it is read, never stored, so it can't drift.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{PersonRef, Run, RunState};

/// Why a workstream is paused. A workstream stored with any other reason reads as paused by the person.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", from = "String")]
pub enum PauseReason {
    Person,
    /// Gossamr paused it for waking Pip too often (`WAKES_PER_WORKSTREAM_PER_DAY`, `WAKE_TURNS_PER_DAY`).
    Ceiling,
}

impl PauseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PauseReason::Person => "person",
            PauseReason::Ceiling => "ceiling",
        }
    }
}

impl From<String> for PauseReason {
    fn from(reason: String) -> Self {
        if reason == PauseReason::Ceiling.as_str() {
            PauseReason::Ceiling
        } else {
            PauseReason::Person
        }
    }
}

/// The hold an earlier release put on every open workstream each time the app opened, which no one asked for.
const RESTART_HOLD: &str = "restart";

fn stored_pause<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<PauseReason>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.filter(|r| r != RESTART_HOLD).map(PauseReason::from))
}

/// Wakes of Pip one workstream may have in a day, counted from UTC midnight or the person's last resume of it.
pub const WAKES_PER_WORKSTREAM_PER_DAY: u32 = 24;
/// Wake turns Pip may have in a day across every workstream, counted from UTC midnight or the person's last resume of
/// the workstream being woken.
pub const WAKE_TURNS_PER_DAY: u32 = 120;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workstream {
    pub id: String,
    pub connection_id: String,
    /// The ticket it is about; a ticketless workstream has none.
    #[serde(default)]
    pub item_key: Option<String>,
    /// `owner/name`, once one is settled on.
    #[serde(default)]
    pub repo: Option<String>,
    pub title: String,
    /// The Pip session its conversation resumes.
    #[serde(default)]
    pub pip_session: Option<String>,
    /// Why the workstream is paused, while it is. A paused workstream gets no wakes.
    #[serde(default, alias = "heldReason", deserialize_with = "stored_pause")]
    pub paused_reason: Option<PauseReason>,
    /// Pip's own notes, at most 2 KB of scrubbed text, only ever shown back to Pip as data.
    #[serde(default)]
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub closed_at: Option<DateTime<Utc>>,
    /// The ticket as it was when the workstream opened, to notice it changing; none for a ticketless one.
    #[serde(default)]
    pub basis: Option<WorkstreamBasis>,
}

/// What a ticket looked like when its workstream opened: its status, assignee and digests of its summary and
/// description.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamBasis {
    pub status_id: String,
    pub assignee: Option<PersonRef>,
    /// A basis recorded before summaries were kept has none, and isn't compared on its summary until taken again.
    #[serde(default)]
    pub summary_digest: Option<String>,
    pub description_digest: String,
    /// The fields (`BASIS_STATUS`, `BASIS_ASSIGNEE`, `BASIS_SUMMARY`, `BASIS_DESCRIPTION`) a draft the person approved has just written:
    /// not compared until they are taken again from the ticket as the write left it. Every other field still is.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changing: Vec<String>,
}

pub const BASIS_STATUS: &str = "status";
pub const BASIS_ASSIGNEE: &str = "assignee";
pub const BASIS_SUMMARY: &str = "summary";
pub const BASIS_DESCRIPTION: &str = "description";

/// Where a workstream is, from the runs linked to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Intake,
    Investigate,
    Triage,
    Plan,
    Build,
    Review,
    Verify,
    Done,
}

fn rank(role: &str) -> u8 {
    match role {
        "investigate" => 0,
        "triage" => 1,
        "plan" => 2,
        "review" => 4,
        "verify" => 5,
        _ => 3,
    }
}

fn of_role(role: &str) -> Stage {
    match role {
        "investigate" => Stage::Investigate,
        "triage" => Stage::Triage,
        "plan" => Stage::Plan,
        "review" => Stage::Review,
        "verify" => Stage::Verify,
        _ => Stage::Build,
    }
}

fn in_progress(state: RunState) -> bool {
    !matches!(state, RunState::Done | RunState::Failed | RunState::Stopped)
}

pub fn stage(runs: &[Run]) -> Stage {
    let furthest = |pick: fn(RunState) -> bool| runs.iter().filter(|run| pick(run.state)).map(|run| run.spec.role.work()).max_by_key(|role| rank(role));
    if let Some(role) = furthest(in_progress) {
        return of_role(role);
    }
    match furthest(|state| state == RunState::Done) {
        Some("verify") => Stage::Done,
        Some(role) => of_role(role),
        None => runs.iter().max_by(|left, right| (left.queued_at, &left.id).cmp(&(right.queued_at, &right.id))).map_or(Stage::Intake, |run| of_role(run.spec.role.work())),
    }
}

/// Short names for the runs of a workstream, `R1` for the first queued: by when each was queued, ties by id. Pip's
/// block and the composer's verbs both name runs this way.
pub fn run_labels(runs: &[Run]) -> Vec<(String, String)> {
    let mut ordered: Vec<&Run> = runs.iter().collect();
    ordered.sort_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id)));
    ordered.iter().enumerate().map(|(n, r)| (r.id.clone(), format!("R{}", n + 1))).collect()
}

/// Who did something recorded in a workstream's audit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Actor {
    Person,
    Pip,
    Supervisor,
    Run,
}

impl Actor {
    pub fn as_str(self) -> &'static str {
        match self {
            Actor::Person => "person",
            Actor::Pip => "pip",
            Actor::Supervisor => "supervisor",
            Actor::Run => "run",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        [Actor::Person, Actor::Pip, Actor::Supervisor, Actor::Run].into_iter().find(|a| a.as_str() == name)
    }
}

/// The audit lines that open and close a question Pip asked the person (`ask_person`): Pip's `pip_asked` carries the
/// question, and the person's next message in the workstream's conversation, or dismissing it, is a `pip_ask_cleared`.
pub const PIP_ASKED: &str = "pip_asked";
pub const PIP_ASK_CLEARED: &str = "pip_ask_cleared";

/// The most of a question Pip asks that is kept.
pub const PIP_ASK_LIMIT: usize = 500;

/// A question Pip asked the person that they haven't answered or dismissed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipAsk {
    pub question: String,
    pub at: DateTime<Utc>,
}

/// The question still open in `events` (oldest first): the newest `pip_asked` line, unless a `pip_ask_cleared` follows it.
pub fn open_pip_ask(events: &[WorkstreamEvent]) -> Option<PipAsk> {
    let mut open = None;
    for e in events {
        match e.action.as_str() {
            PIP_ASKED => open = Some(PipAsk { question: e.detail.clone().unwrap_or_default(), at: e.at }),
            PIP_ASK_CLEARED => open = None,
            _ => {}
        }
    }
    open
}

/// One line of a workstream's append-only audit. `seq` is given when it is stored. Text a person or Pip wrote is never
/// kept here, only its digest or length; the one exception is the sanitised question of a `pip_asked` line.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkstreamEvent {
    pub workstream_id: String,
    pub seq: u32,
    pub at: DateTime<Utc>,
    pub actor: Actor,
    pub action: String,
    pub run_id: Option<String>,
    pub proposal_id: Option<String>,
    pub digest: Option<String>,
    pub detail: Option<String>,
}

impl WorkstreamEvent {
    pub fn new(workstream_id: &str, actor: Actor, action: &str, at: DateTime<Utc>) -> Self {
        WorkstreamEvent { workstream_id: workstream_id.into(), seq: 0, at, actor, action: action.into(), run_id: None, proposal_id: None, digest: None, detail: None }
    }

    pub fn run(mut self, id: &str) -> Self {
        self.run_id = Some(id.into());
        self
    }

    pub fn proposal(mut self, id: &str) -> Self {
        self.proposal_id = Some(id.into());
        self
    }

    pub fn digest(mut self, digest: &str) -> Self {
        self.digest = Some(digest.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use chrono::{Duration, TimeZone};

    use super::*;
    use crate::domain::fixtures::run_spec;
    use crate::domain::{Role, RunSpec};

    fn at(mins: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 0).unwrap() + Duration::minutes(mins)
    }

    /// The stage with no review's verdict known.
    fn unjudged(runs: &[Run]) -> Stage {
        stage(runs)
    }

    fn run(id: &str, kind: &str, state: RunState, mins: i64) -> Run {
        let mut r = Run::queued(id.into(), format!("p-{id}"), "c".into(), None, RunSpec { role: Role::parse(kind).unwrap(), ..run_spec() }, at(mins));
        r.state = state;
        r
    }

    #[test]
    fn intake_with_no_runs() {
        assert_eq!(unjudged(&[]), Stage::Intake);
    }

    #[test]
    fn queued_investigate_is_investigate() {
        assert_eq!(unjudged(&[run("a", "investigate", RunState::Queued, 0)]), Stage::Investigate);
    }

    #[test]
    fn done_investigate_then_working_triage_is_triage() {
        let runs = [run("a", "investigate", RunState::Done, 0), run("b", "triage", RunState::Working, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
        assert_eq!(unjudged(&runs[..1]), Stage::Investigate, "a finished investigation alone is not done");
    }

    #[test]
    fn failed_runs_do_not_hold_the_stage_back() {
        let runs = [run("a", "investigate", RunState::Failed, 0), run("b", "plan", RunState::Working, 1)];
        assert_eq!(unjudged(&runs), Stage::Plan);
        let runs = [run("a", "triage", RunState::Done, 0), run("b", "investigate", RunState::Failed, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
    }

    #[test]
    fn a_build_waiting_on_the_person_is_build() {
        let runs = [run("a", "plan", RunState::Done, 0), run("b", "build", RunState::NeedsAnswer, 1)];
        assert_eq!(unjudged(&runs), Stage::Build);
    }

    #[test]
    fn a_review_report_is_not_parsed_to_decide_the_workstreams_stage() {
        let mut review = run("review", "reviewer", RunState::Done, 0);
        review.result = Some("Verdict: pass".into());
        review.result_complete = true;
        assert_eq!(stage(&[review]), Stage::Review);
    }

    #[test]
    fn verify_done_is_done() {
        assert_eq!(unjudged(&[run("a", "verify", RunState::Done, 0)]), Stage::Done);
        assert_eq!(unjudged(&[run("a", "verify", RunState::Queued, 0)]), Stage::Verify);
    }

    #[test]
    fn all_stopped_falls_back_to_last_kind() {
        let runs = [run("a", "plan", RunState::Stopped, 0), run("b", "triage", RunState::Failed, 2), run("c", "investigate", RunState::Stopped, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
        let tied = [run("b", "plan", RunState::Stopped, 0), run("a", "triage", RunState::Stopped, 0)];
        assert_eq!(unjudged(&tied), Stage::Plan, "ties go to the larger id");
    }

    #[test]
    fn unknown_counts_as_in_progress() {
        let runs = [run("a", "review", RunState::Done, 0), run("b", "triage", RunState::Unknown, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
    }

    #[test]
    fn run_labels_number_by_queue_time_then_id() {
        let runs = [run("z", "plan", RunState::Done, 5), run("b", "triage", RunState::Done, 1), run("a", "investigate", RunState::Done, 1)];
        let labels = run_labels(&runs);
        assert_eq!(labels, [("a".to_string(), "R1".to_string()), ("b".into(), "R2".into()), ("z".into(), "R3".into())]);
        assert!(run_labels(&[]).is_empty());
    }

    #[test]
    fn a_workstream_stored_without_the_optional_fields_reads_with_defaults() {
        let json = serde_json::json!({ "id": "w1", "connectionId": "c", "itemKey": "CA-1", "title": "CA-1 Cart", "createdAt": "2026-09-29T10:00:00Z" });
        let ws: Workstream = serde_json::from_value(json).unwrap();
        let back: Workstream = serde_json::from_value(serde_json::to_value(&ws).unwrap()).unwrap();
        assert_eq!(back, ws);
        assert_eq!((ws.paused_reason, ws.notes, ws.closed_at, ws.repo, ws.pip_session, ws.basis), (None, None, None, None, None, None));
        assert_eq!(serde_json::to_value(Stage::Investigate).unwrap(), "investigate");
        assert_eq!(Actor::parse("supervisor"), Some(Actor::Supervisor));
    }

    #[test]
    fn a_workstream_stored_with_the_removed_fields_still_reads_and_any_old_hold_but_the_restart_one_reads_as_paused_by_the_person() {
        let stored = |reason: serde_json::Value| {
            serde_json::json!({
                "id": "w1", "connectionId": "c", "title": "t", "createdAt": "2026-09-29T10:00:00Z", "mode": "manage", "heldReason": reason,
                "budget": { "autoTurns": 6 }, "spent": { "autoTurns": 2, "wakes": 3, "tokens": 0 }, "rules": { "triage_plan": false },
                "drifted": ["description"], "resumeMode": "manage"
            })
        };
        for old in ["budget", "daily_cap", "quota", "hold_all", "tripwire:marker", "person"] {
            let ws: Workstream = serde_json::from_value(stored(old.into())).unwrap();
            assert_eq!(ws.paused_reason, Some(PauseReason::Person), "{old}");
        }
        let restarted: Workstream = serde_json::from_value(stored("restart".into())).unwrap();
        assert_eq!(restarted.paused_reason, None, "the hold every open workstream got at each launch, which nobody asked for");
        let ceiling: Workstream = serde_json::from_value(stored("ceiling".into())).unwrap();
        assert_eq!(ceiling.paused_reason, Some(PauseReason::Ceiling));
        assert_eq!(serde_json::to_value(&ceiling).unwrap()["pausedReason"], "ceiling");
        let free: Workstream = serde_json::from_value(stored(serde_json::Value::Null)).unwrap();
        assert_eq!(free.paused_reason, None);
        let json = serde_json::to_value(&free).unwrap();
        for gone in ["mode", "heldReason", "budget", "spent", "rules", "drifted", "resumeMode"] {
            assert!(json.get(gone).is_none(), "{gone}");
        }
    }
}
