//! A workstream: one piece of work (usually a ticket) that a person, Pip and the agent runs it links carry from intake
//! to done. Its stage is derived from the linked runs every time it is read, never stored, so it can't drift.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{PersonRef, Run, RunKind, RunState};

/// How much Pip may do on its own in a workstream. In `Advise` Pip answers the person and drafts; nothing wakes it and
/// nothing starts on its own. In `Manage` the supervisor wakes Pip when a linked run finishes and starts the routine
/// handoffs its rules allow, while the workstream isn't held and is within its budget. Pip itself starts nothing in
/// either.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Advise,
    Manage,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Advise => "advise",
            Mode::Manage => "manage",
        }
    }
}

/// Pip turns the supervisor may start in a workstream since the person last wrote in it, unless its budget says otherwise.
pub const AUTO_TURNS_DEFAULT: u32 = 6;
/// Wakes a workstream may have in all, unless its budget says otherwise.
pub const WAKES_DEFAULT: u32 = 12;

/// Why a workstream is held, as `held_reason` stores it. A tripwire is `tripwire:<kind>`, the kind one of `TRIPWIRES`.
pub const HELD_RESTART: &str = "restart";
pub const HELD_PERSON: &str = "person";
pub const HELD_ALL: &str = "hold_all";
pub const HELD_BUDGET: &str = "budget";
pub const HELD_DAILY: &str = "daily_cap";
pub const HELD_QUOTA: &str = "quota";
pub const TRIPWIRE: &str = "tripwire:";
pub const TRIPWIRES: [&str; 4] = ["marker", "basis_drift", "repeated_failure", "chain_refused"];

/// The hold reason of tripwire `kind`.
pub fn tripwire(kind: &str) -> String {
    format!("{TRIPWIRE}{kind}")
}

/// Whether `reason` is one a workstream may be held with.
pub fn valid_hold_reason(reason: &str) -> bool {
    [HELD_RESTART, HELD_PERSON, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_QUOTA].contains(&reason)
        || reason.strip_prefix(TRIPWIRE).is_some_and(|kind| TRIPWIRES.contains(&kind))
}

/// Limits for the supervisor in one workstream. `None` is the default (`AUTO_TURNS_DEFAULT`, `WAKES_DEFAULT`; no token
/// limit).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Budget {
    pub auto_turns: Option<u32>,
    pub wakes: Option<u32>,
    pub tokens: Option<u64>,
}

/// What the workstream has used of its budget. `auto_turns` counts Pip turns the supervisor started since the person
/// last wrote; only resuming from a budget hold or the person's own message resets it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Spend {
    pub auto_turns: u32,
    pub wakes: u32,
    pub tokens: u64,
}

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
    #[serde(default)]
    pub mode: Mode,
    /// Why the workstream is held, while it is.
    #[serde(default)]
    pub held_reason: Option<String>,
    /// Pip's own notes, at most 2 KB of scrubbed text, only ever shown back to Pip as data.
    #[serde(default)]
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub closed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub budget: Budget,
    #[serde(default)]
    pub spent: Spend,
    /// This workstream's own switches for the auto-start rules; a rule it doesn't name follows the global switch.
    #[serde(default)]
    pub rules: RuleSwitches,
    /// The ticket as it was when the workstream opened, to notice it drifting; none for a ticketless one.
    #[serde(default)]
    pub basis: Option<WorkstreamBasis>,
    /// The basis fields (`BASIS_SUMMARY`, `BASIS_DESCRIPTION`, `BASIS_STATUS`) whose drift held it, kept while it is
    /// held for `tripwire:basis_drift`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drifted: Vec<String>,
}

/// An auto-start rule: which finished run may start which successor on its own (`agent/autostart.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    InvestigateTriage,
    TriagePlan,
    PlanBuild,
    BuildReview,
    FixRound,
    ReviewVerify,
}

impl Rule {
    pub const ALL: [Rule; 6] = [Rule::InvestigateTriage, Rule::TriagePlan, Rule::PlanBuild, Rule::BuildReview, Rule::FixRound, Rule::ReviewVerify];

    pub fn as_str(self) -> &'static str {
        match self {
            Rule::InvestigateTriage => "investigate_triage",
            Rule::TriagePlan => "triage_plan",
            Rule::PlanBuild => "plan_build",
            Rule::BuildReview => "build_review",
            Rule::FixRound => "fix_round",
            Rule::ReviewVerify => "review_verify",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Rule::ALL.into_iter().find(|r| r.as_str() == name)
    }
}

/// A workstream's overrides of the global auto-start switches, by rule. A rule that isn't here inherits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RuleSwitches(BTreeMap<Rule, bool>);

impl RuleSwitches {
    /// The override for `rule`; `None` inherits the global switch.
    pub fn get(&self, rule: Rule) -> Option<bool> {
        self.0.get(&rule).copied()
    }

    /// Sets the override for `rule`, or with `None` goes back to inheriting.
    pub fn set(&mut self, rule: Rule, on: Option<bool>) {
        match on {
            Some(on) => self.0.insert(rule, on),
            None => self.0.remove(&rule),
        };
    }
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

/// How much of its budget a workstream has used: `Amber` from 80% of either limit, `Spent` at 100%.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetLevel {
    Ok,
    Amber,
    Spent,
}

/// The limits a workstream's budget gives, defaults filled in: (automatic turns, wakes).
pub fn budget_limits(ws: &Workstream) -> (u32, u32) {
    (ws.budget.auto_turns.unwrap_or(AUTO_TURNS_DEFAULT), ws.budget.wakes.unwrap_or(WAKES_DEFAULT))
}

/// The budget level of `ws`, from whichever of its automatic turns and wakes is nearer its limit. A limit of 0 allows
/// none, so it is spent from the start.
pub fn budget_level(ws: &Workstream) -> BudgetLevel {
    let (turns, wakes) = budget_limits(ws);
    let level = |used: u32, limit: u32| {
        let (used, limit) = (u64::from(used), u64::from(limit));
        if used >= limit {
            BudgetLevel::Spent
        } else if used * 5 >= limit * 4 {
            BudgetLevel::Amber
        } else {
            BudgetLevel::Ok
        }
    };
    let rank = |l: BudgetLevel| l as u8;
    [level(ws.spent.auto_turns, turns), level(ws.spent.wakes, wakes)].into_iter().max_by_key(|l| rank(*l)).unwrap_or(BudgetLevel::Ok)
}

/// Whether routine steps in `ws` may start on their own now: it is open, not held, in Manage mode and within its budget.
/// Whether a given rule is switched on is `config::rule_on`; both together are `config::rule_runs`.
pub fn starts_steps(ws: &Workstream) -> bool {
    ws.closed_at.is_none() && ws.held_reason.is_none() && ws.mode == Mode::Manage && budget_level(ws) != BudgetLevel::Spent
}

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

/// The stage of a workstream whose linked runs are `runs`, in any order. Kinds are ordered Investigate < Triage < Plan
/// < Build < Review < Verify, and the first rule that applies decides:
///
/// 1. No runs: `Intake`.
/// 2. Any run in progress (queued, launching, working, waiting on the person, blocked, or unknown): the furthest kind
///    among those.
/// 3. Else any run done: the furthest kind that finished, except that a finished Review or Verify is `Done`.
/// 4. Else (every run failed or was stopped): the kind of the run queued last.
///
/// Mirrored by `src/lib/workstreamStage.ts`; both run `src/lib/workstreamStage.fixtures.json`.
pub fn stage(runs: &[Run]) -> Stage {
    let furthest = |pick: fn(RunState) -> bool| runs.iter().filter(|r| pick(r.state)).map(|r| r.spec.kind).max_by_key(|k| rank(*k));
    if let Some(kind) = furthest(in_progress) {
        return of_kind(kind);
    }
    match furthest(|s| s == RunState::Done) {
        Some(RunKind::Review | RunKind::Verify) => Stage::Done,
        Some(kind) => of_kind(kind),
        None => runs.iter().max_by(|a, b| (a.queued_at, &a.id).cmp(&(b.queued_at, &b.id))).map_or(Stage::Intake, |r| of_kind(r.spec.kind)),
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

/// One line of a workstream's append-only audit. `seq` is given when it is stored. Text a person or Pip wrote is never
/// kept here, only its digest or length.
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
    use chrono::{Duration, TimeZone};

    use super::*;
    use crate::domain::fixtures::run_spec;
    use crate::domain::RunSpec;

    fn at(mins: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 0).unwrap() + Duration::minutes(mins)
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
            assert_eq!(stage(&runs), expected, "{}", case["name"]);
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
        assert_eq!(stage(&[]), Stage::Intake);
    }

    #[test]
    fn queued_investigate_is_investigate() {
        assert_eq!(stage(&[run("a", RunKind::Investigate, RunState::Queued, 0)]), Stage::Investigate);
    }

    #[test]
    fn done_investigate_then_working_triage_is_triage() {
        let runs = [run("a", RunKind::Investigate, RunState::Done, 0), run("b", RunKind::Triage, RunState::Working, 1)];
        assert_eq!(stage(&runs), Stage::Triage);
        assert_eq!(stage(&runs[..1]), Stage::Investigate, "a finished investigation alone is not done");
    }

    #[test]
    fn failed_runs_do_not_hold_the_stage_back() {
        let runs = [run("a", RunKind::Investigate, RunState::Failed, 0), run("b", RunKind::Plan, RunState::Working, 1)];
        assert_eq!(stage(&runs), Stage::Plan);
        let runs = [run("a", RunKind::Triage, RunState::Done, 0), run("b", RunKind::Investigate, RunState::Failed, 1)];
        assert_eq!(stage(&runs), Stage::Triage);
    }

    #[test]
    fn a_build_waiting_on_the_person_is_build() {
        let runs = [run("a", RunKind::Plan, RunState::Done, 0), run("b", RunKind::Build, RunState::NeedsAnswer, 1)];
        assert_eq!(stage(&runs), Stage::Build);
    }

    #[test]
    fn review_done_is_done() {
        let runs = [run("a", RunKind::Build, RunState::Done, 0), run("b", RunKind::Review, RunState::Done, 1)];
        assert_eq!(stage(&runs), Stage::Done);
        assert_eq!(stage(&[run("a", RunKind::Review, RunState::Working, 0)]), Stage::Review);
    }

    #[test]
    fn verify_done_is_done() {
        assert_eq!(stage(&[run("a", RunKind::Verify, RunState::Done, 0)]), Stage::Done);
        assert_eq!(stage(&[run("a", RunKind::Verify, RunState::Queued, 0)]), Stage::Verify);
    }

    #[test]
    fn all_stopped_falls_back_to_last_kind() {
        let runs = [run("a", RunKind::Plan, RunState::Stopped, 0), run("b", RunKind::Triage, RunState::Failed, 2), run("c", RunKind::Investigate, RunState::Stopped, 1)];
        assert_eq!(stage(&runs), Stage::Triage);
        let tied = [run("b", RunKind::Plan, RunState::Stopped, 0), run("a", RunKind::Triage, RunState::Stopped, 0)];
        assert_eq!(stage(&tied), Stage::Plan, "ties go to the larger id");
    }

    #[test]
    fn unknown_counts_as_in_progress() {
        let runs = [run("a", RunKind::Review, RunState::Done, 0), run("b", RunKind::Triage, RunState::Unknown, 1)];
        assert_eq!(stage(&runs), Stage::Triage);
    }

    #[test]
    fn run_labels_number_by_queue_time_then_id() {
        let runs = [run("z", RunKind::Plan, RunState::Done, 5), run("b", RunKind::Triage, RunState::Done, 1), run("a", RunKind::Investigate, RunState::Done, 1)];
        let labels = run_labels(&runs);
        assert_eq!(labels, [("a".to_string(), "R1".to_string()), ("b".into(), "R2".into()), ("z".into(), "R3".into())]);
        assert!(run_labels(&[]).is_empty());
    }

    #[test]
    fn a_workstream_stored_without_the_reserved_fields_reads_with_defaults() {
        let json = serde_json::json!({ "id": "w1", "connectionId": "c", "itemKey": "CA-1", "title": "CA-1 Cart", "createdAt": "2026-09-29T10:00:00Z" });
        let ws: Workstream = serde_json::from_value(json).unwrap();
        assert_eq!(budget_level(&ws), BudgetLevel::Ok);
        let back: Workstream = serde_json::from_value(serde_json::to_value(&ws).unwrap()).unwrap();
        assert_eq!(back, ws);
        assert!(ws.drifted.is_empty() && serde_json::to_value(&ws).unwrap().get("drifted").is_none());
        assert_eq!((ws.mode, ws.notes, ws.closed_at, ws.repo, ws.pip_session), (Mode::Advise, None, None, None, None));
        assert_eq!((ws.budget, ws.spent), (Budget::default(), Spend::default()));
        assert_eq!(serde_json::to_value(Stage::Investigate).unwrap(), "investigate");
        assert_eq!(serde_json::to_value(Mode::Manage).unwrap(), "manage");
        assert_eq!(Actor::parse("supervisor"), Some(Actor::Supervisor));
        assert_eq!((ws.rules, ws.basis), (RuleSwitches::default(), None));
    }

    fn workstream() -> Workstream {
        serde_json::from_value(serde_json::json!({ "id": "w1", "connectionId": "c", "title": "t", "createdAt": "2026-09-29T10:00:00Z" })).unwrap()
    }

    #[test]
    fn rules_parse_their_names_and_switches_store_only_overrides() {
        for rule in Rule::ALL {
            assert_eq!(Rule::parse(rule.as_str()), Some(rule));
            assert_eq!(serde_json::to_value(rule).unwrap(), rule.as_str());
        }
        assert_eq!(Rule::parse("build"), None);
        let mut ws = workstream();
        ws.rules.set(Rule::TriagePlan, Some(false));
        ws.rules.set(Rule::FixRound, Some(true));
        ws.rules.set(Rule::FixRound, None);
        assert_eq!(serde_json::to_value(&ws).unwrap()["rules"], serde_json::json!({ "triage_plan": false }));
        let back: Workstream = serde_json::from_value(serde_json::to_value(&ws).unwrap()).unwrap();
        assert_eq!((back.rules.get(Rule::TriagePlan), back.rules.get(Rule::FixRound)), (Some(false), None));
    }

    #[test]
    fn hold_reasons_are_the_known_ones_and_the_four_tripwires() {
        for reason in [HELD_RESTART, HELD_PERSON, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_QUOTA] {
            assert!(valid_hold_reason(reason), "{reason}");
        }
        for kind in TRIPWIRES {
            assert!(valid_hold_reason(&tripwire(kind)), "{kind}");
        }
        for bad in ["", "tripwire:", "tripwire:other", "because", "Person"] {
            assert!(!valid_hold_reason(bad), "{bad}");
        }
    }

    #[test]
    fn the_budget_is_amber_from_80_percent_of_either_limit_and_spent_at_100() {
        let mut ws = workstream();
        assert_eq!(budget_limits(&ws), (AUTO_TURNS_DEFAULT, WAKES_DEFAULT));
        ws.budget.auto_turns = Some(100);
        ws.budget.wakes = Some(100);
        let at = |turns: u32, wakes: u32| {
            let mut ws = ws.clone();
            ws.spent.auto_turns = turns;
            ws.spent.wakes = wakes;
            budget_level(&ws)
        };
        assert_eq!(at(79, 0), BudgetLevel::Ok);
        assert_eq!(at(80, 0), BudgetLevel::Amber);
        assert_eq!(at(0, 80), BudgetLevel::Amber);
        assert_eq!(at(99, 79), BudgetLevel::Amber);
        assert_eq!(at(100, 0), BudgetLevel::Spent);
        assert_eq!(at(0, 100), BudgetLevel::Spent);
        assert_eq!(at(80, 120), BudgetLevel::Spent);

        let mut fresh = workstream();
        fresh.spent.auto_turns = 4;
        assert_eq!(budget_level(&fresh), BudgetLevel::Ok, "4 of the default 6");
        fresh.spent.auto_turns = 5;
        assert_eq!(budget_level(&fresh), BudgetLevel::Amber);
        fresh.spent.auto_turns = 6;
        assert_eq!(budget_level(&fresh), BudgetLevel::Spent);
        fresh.spent.auto_turns = 0;
        fresh.spent.wakes = 10;
        assert_eq!(budget_level(&fresh), BudgetLevel::Amber, "10 of the default 12");
        fresh.budget.wakes = Some(0);
        assert_eq!(budget_level(&fresh), BudgetLevel::Spent, "a limit of 0 allows none");
        assert_eq!(serde_json::to_value(BudgetLevel::Amber).unwrap(), "amber");
    }
}
