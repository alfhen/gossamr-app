//! A workstream: one piece of work (usually a ticket) that a person, Pip and the agent runs it links carry from intake
//! to done. Its stage is derived from the linked runs every time it is read, never stored, so it can't drift.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{PersonRef, Run, RunKind, RunState};
use crate::runs::report::ReviewVerdict;

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

fn rank(kind: RunKind) -> u8 {
    match kind {
        RunKind::Investigate => 0,
        RunKind::Triage => 1,
        RunKind::Plan => 2,
        RunKind::Build => 3,
        RunKind::Review => 4,
        RunKind::Verify => 5,
    }
}

fn of_kind(kind: RunKind) -> Stage {
    match kind {
        RunKind::Investigate => Stage::Investigate,
        RunKind::Triage => Stage::Triage,
        RunKind::Plan => Stage::Plan,
        RunKind::Build => Stage::Build,
        RunKind::Review => Stage::Review,
        RunKind::Verify => Stage::Verify,
    }
}

fn in_progress(state: RunState) -> bool {
    !matches!(state, RunState::Done | RunState::Failed | RunState::Stopped)
}

/// The stage of a workstream whose linked runs are `runs`, in any order, `verdict` giving a finished review's verdict.
/// Kinds are ordered Investigate < Triage < Plan < Build < Review < Verify, and the first rule that applies decides:
///
/// 1. No runs: `Intake`.
/// 2. Any run in progress (queued, launching, working, waiting on the person, blocked, or unknown): the furthest kind
///    among those.
/// 3. Else any run done: the furthest kind that finished, except that a finished Verify is `Done`, and when that kind
///    is Review the newest finished review decides: `Done` when it passed, else (blocking, or no verdict) `Review`.
/// 4. Else (every run failed or was stopped): the kind of the run queued last.
///
/// Mirrored by `src/lib/workstreamStage.ts`; both run `src/lib/workstreamStage.fixtures.json`.
pub fn stage(runs: &[Run], verdict: impl Fn(&Run) -> Option<ReviewVerdict>) -> Stage {
    let furthest = |pick: fn(RunState) -> bool| runs.iter().filter(|r| pick(r.state)).map(|r| r.spec.kind).max_by_key(|k| rank(*k));
    if let Some(kind) = furthest(in_progress) {
        return of_kind(kind);
    }
    match furthest(|s| s == RunState::Done) {
        Some(RunKind::Verify) => Stage::Done,
        Some(RunKind::Review) => match newest_review(runs).and_then(verdict) {
            Some(ReviewVerdict::Pass) => Stage::Done,
            _ => Stage::Review,
        },
        Some(kind) => of_kind(kind),
        None => runs.iter().max_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id))).map_or(Stage::Intake, |r| of_kind(r.spec.kind)),
    }
}

/// The finished review among `runs` queued last.
fn newest_review(runs: &[Run]) -> Option<&Run> {
    runs.iter().filter(|r| r.spec.kind == RunKind::Review && r.state == RunState::Done).max_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id)))
}

/// Whether the workstream of `runs` stands at Review because its newest finished review asked for changes: nothing is
/// in progress and no verification finished. Its chip then reads "Review · changes needed".
pub fn review_blocking(runs: &[Run], verdict: impl Fn(&Run) -> Option<ReviewVerdict>) -> bool {
    stage(runs, &verdict) == Stage::Review && !runs.iter().any(|r| in_progress(r.state)) && newest_review(runs).and_then(verdict) == Some(ReviewVerdict::Blocking)
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
    use crate::domain::RunSpec;

    fn at(mins: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 0).unwrap() + Duration::minutes(mins)
    }

    /// The stage with no review's verdict known.
    fn unjudged(runs: &[Run]) -> Stage {
        stage(runs, |_| None)
    }

    fn run(id: &str, kind: RunKind, state: RunState, mins: i64) -> Run {
        let mut r = Run::queued(id.into(), format!("p-{id}"), "c".into(), None, RunSpec { kind, ..run_spec() }, "f".into(), at(mins));
        r.state = state;
        r
    }

    #[test]
    fn matches_the_fixtures_the_frontend_mirror_also_runs() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../../src/lib/workstreamStage.fixtures.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 9);
        for case in cases {
            let verdicts: HashMap<String, ReviewVerdict> = case["runs"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .filter_map(|(n, r)| serde_json::from_value(r["verdict"].clone()).ok().map(|v| (format!("r{n}"), v)))
                .collect();
            let runs: Vec<Run> = case["runs"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(n, r)| {
                    let kind: RunKind = serde_json::from_value(r["kind"].clone()).unwrap();
                    let state: RunState = serde_json::from_value(r["state"].clone()).unwrap();
                    let queued: DateTime<Utc> = serde_json::from_value(r["queuedAt"].clone()).unwrap();
                    let mut run = run(&format!("r{n}"), kind, state, 0);
                    run.queued_at = queued;
                    run
                })
                .collect();
            let expected: Stage = serde_json::from_value(case["stage"].clone()).unwrap();
            assert_eq!(stage(&runs, |r| verdicts.get(&r.id).copied()), expected, "{}", case["name"]);
            let blocking: bool = case["reviewBlocking"].as_bool().unwrap_or(false);
            assert_eq!(review_blocking(&runs, |r| verdicts.get(&r.id).copied()), blocking, "{}", case["name"]);
            // Where a case gives labels, they are the label of each run in the order listed.
            if let Some(labels) = case["labels"].as_array() {
                let given = run_labels(&runs);
                let named: Vec<&str> = runs.iter().map(|r| given.iter().find(|(id, _)| *id == r.id).unwrap().1.as_str()).collect();
                assert_eq!(named, labels.iter().map(|l| l.as_str().unwrap()).collect::<Vec<_>>(), "{}", case["name"]);
            }
        }
    }

    #[test]
    fn intake_with_no_runs() {
        assert_eq!(unjudged(&[]), Stage::Intake);
    }

    #[test]
    fn queued_investigate_is_investigate() {
        assert_eq!(unjudged(&[run("a", RunKind::Investigate, RunState::Queued, 0)]), Stage::Investigate);
    }

    #[test]
    fn done_investigate_then_working_triage_is_triage() {
        let runs = [run("a", RunKind::Investigate, RunState::Done, 0), run("b", RunKind::Triage, RunState::Working, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
        assert_eq!(unjudged(&runs[..1]), Stage::Investigate, "a finished investigation alone is not done");
    }

    #[test]
    fn failed_runs_do_not_hold_the_stage_back() {
        let runs = [run("a", RunKind::Investigate, RunState::Failed, 0), run("b", RunKind::Plan, RunState::Working, 1)];
        assert_eq!(unjudged(&runs), Stage::Plan);
        let runs = [run("a", RunKind::Triage, RunState::Done, 0), run("b", RunKind::Investigate, RunState::Failed, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
    }

    #[test]
    fn a_build_waiting_on_the_person_is_build() {
        let runs = [run("a", RunKind::Plan, RunState::Done, 0), run("b", RunKind::Build, RunState::NeedsAnswer, 1)];
        assert_eq!(unjudged(&runs), Stage::Build);
    }

    #[test]
    fn a_finished_review_is_done_only_when_its_newest_one_passed() {
        let verdicts = |pass: &'static [&'static str]| move |r: &Run| Some(if pass.contains(&r.id.as_str()) { ReviewVerdict::Pass } else { ReviewVerdict::Blocking });
        let runs = [run("a", RunKind::Build, RunState::Done, 0), run("b", RunKind::Review, RunState::Done, 1)];
        assert_eq!(stage(&runs, verdicts(&["b"])), Stage::Done);
        assert_eq!(stage(&runs, verdicts(&[])), Stage::Review);
        assert!(review_blocking(&runs, verdicts(&[])) && !review_blocking(&runs, verdicts(&["b"])));
        assert_eq!(unjudged(&runs), Stage::Review, "a review with no verdict is not done");
        assert!(!review_blocking(&runs, |_| None));
        let rounds = [run("b", RunKind::Review, RunState::Done, 1), run("c", RunKind::Review, RunState::Done, 2)];
        assert_eq!(stage(&rounds, verdicts(&["c"])), Stage::Done, "blocking, then a newer pass");
        assert_eq!(stage(&rounds, verdicts(&["b"])), Stage::Review, "a pass, then a newer blocking one");
        let again = [run("b", RunKind::Review, RunState::Done, 1), run("c", RunKind::Review, RunState::Working, 2)];
        assert_eq!(stage(&again, verdicts(&[])), Stage::Review);
        assert!(!review_blocking(&again, verdicts(&[])), "a review in progress is not blocking yet");
        assert_eq!(unjudged(&[run("a", RunKind::Review, RunState::Working, 0)]), Stage::Review);
        let verified = [run("b", RunKind::Review, RunState::Done, 1), run("c", RunKind::Verify, RunState::Done, 2)];
        assert_eq!(stage(&verified, verdicts(&[])), Stage::Done, "a finished verification is done whatever the review said");
        assert!(!review_blocking(&verified, verdicts(&[])));
    }

    #[test]
    fn verify_done_is_done() {
        assert_eq!(unjudged(&[run("a", RunKind::Verify, RunState::Done, 0)]), Stage::Done);
        assert_eq!(unjudged(&[run("a", RunKind::Verify, RunState::Queued, 0)]), Stage::Verify);
    }

    #[test]
    fn all_stopped_falls_back_to_last_kind() {
        let runs = [run("a", RunKind::Plan, RunState::Stopped, 0), run("b", RunKind::Triage, RunState::Failed, 2), run("c", RunKind::Investigate, RunState::Stopped, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
        let tied = [run("b", RunKind::Plan, RunState::Stopped, 0), run("a", RunKind::Triage, RunState::Stopped, 0)];
        assert_eq!(unjudged(&tied), Stage::Plan, "ties go to the larger id");
    }

    #[test]
    fn unknown_counts_as_in_progress() {
        let runs = [run("a", RunKind::Review, RunState::Done, 0), run("b", RunKind::Triage, RunState::Unknown, 1)];
        assert_eq!(unjudged(&runs), Stage::Triage);
    }

    #[test]
    fn run_labels_number_by_queue_time_then_id() {
        let runs = [run("z", RunKind::Plan, RunState::Done, 5), run("b", RunKind::Triage, RunState::Done, 1), run("a", RunKind::Investigate, RunState::Done, 1)];
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
