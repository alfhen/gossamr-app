import { AUTO_TURNS_DEFAULT, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES, WAKES_DEFAULT } from "../types";
import type { AutoStartSwitches, BasisField, BudgetLevel, BudgetView, Tripwire, Workstream, WorkstreamMode, WorkstreamRule } from "../types";

const TRIPWIRE_TEXT: Record<Tripwire, string> = {
  marker: "a run's output held one of Gossamr's data markers",
  basis_drift: "the ticket changed since the workstream opened",
  repeated_failure: "the same step failed twice",
  chain_refused: "Pip kept asking for a step Gossamr refused",
};

/**
 * What changed in Jira for a basis-drift hold, from the fields that drifted (`Workstream.drifted`): "the ticket's
 * summary and description changed in Jira", "the ticket was moved to Done"; as `trip_reason` in
 * src-tauri/src/agent/workstream.rs words it for Pip. With none known, the general wording.
 */
export function driftText(drifted: readonly BasisField[] | null | undefined): string {
  const changed = (["summary", "description"] as const).filter((f) => drifted?.includes(f));
  const done = drifted?.includes("status") ?? false;
  if (changed.length === 0) return done ? "the ticket was moved to Done" : TRIPWIRE_TEXT.basis_drift;
  const what = `the ticket's ${changed.join(" and ")} changed`;
  return done ? `${what} and it was moved to Done` : `${what} in Jira`;
}

/**
 * What a budget hold says: which limit ran out and what lifts it. Resume starts both counts again; a message to Pip
 * starts only the automatic turns again, so it is offered only while the wakes are not what ran out. Without `budget`,
 * the default limits and Resume alone.
 */
function budgetHeldText(budget: BudgetView | undefined): string {
  const turns = budget?.autoTurns.limit ?? AUTO_TURNS_DEFAULT;
  if (budget && budget.wakes.used >= budget.wakes.limit) return `Held: wakes used up. Resume to give it ${budget.wakes.limit} more`;
  return budget ? `Held: automatic turns used up. Resume, or write to Pip, to give it ${turns} more` : `Held: automatic turns used up. Resume to give it ${turns} more`;
}

/**
 * What the page says about a workstream held for `reason` (`heldReason`); null when it isn't held. A basis-drift hold
 * says what changed when `drifted` names it, and a budget hold which limit ran out and what resuming gives (`budget`,
 * the workstream's budget view).
 */
export function heldText(reason: string | null | undefined, drifted?: readonly BasisField[] | null, budget?: BudgetView): string | null {
  if (!reason) return null;
  switch (reason) {
    case HELD_RESTART:
      return "Held after a restart";
    case HELD_PERSON:
      return "Held by you";
    case HELD_ALL:
      return "Held: Hold all";
    case HELD_BUDGET:
      return budgetHeldText(budget);
    case HELD_DAILY:
      return "Held: today's Pip turns are used up";
    case HELD_QUOTA:
      return "Paused: quota";
  }
  if (reason.startsWith(TRIPWIRE)) {
    const kind = reason.slice(TRIPWIRE.length) as Tripwire;
    if (kind === "basis_drift") return `Held: ${driftText(drifted)}`;
    if ((TRIPWIRES as readonly string[]).includes(kind)) return `Held: ${TRIPWIRE_TEXT[kind]}`;
  }
  return "Held";
}

/**
 * What Resume does about Manage, said after why it is held, so the banner agrees with the Manage switch: a tripwire takes
 * Manage away, so with `resumeMode` set (a trip can land on any hold), or Manage switched back on during a tripwire's
 * hold (`mode`), the automatic steps are paused and Resume turns them back on; after a trip from Advise, Resume only
 * lifts the hold. Null for any other hold, which leaves the mode alone.
 */
export function tripwireResumeText(reason: string | null | undefined, resumeMode: WorkstreamMode | null | undefined, mode?: WorkstreamMode): string | null {
  if (!reason) return null;
  if (resumeMode === "manage") return "Automatic steps are paused. Resume turns them back on.";
  if (!reason.startsWith(TRIPWIRE)) return null;
  return mode === "manage" ? "Automatic steps are paused. Resume turns them back on." : "Resume only lifts the hold; Manage stays off.";
}

/** The whole held banner of `ws`: why it is held, then for a tripwire what Resume does. `budget` is its budget view. */
export function heldBanner(ws: Pick<Workstream, "heldReason" | "drifted" | "resumeMode"> & { mode?: WorkstreamMode }, budget?: BudgetView): string | null {
  const held = heldText(ws.heldReason, ws.drifted, budget);
  const resume = tripwireResumeText(ws.heldReason, ws.resumeMode, ws.mode);
  return held && resume ? `${held}. ${resume}` : held;
}

/** What one automatic turn is, for the budget's meter and banner. */
export const TURN_HELP = "An automatic turn is each time Pip acts without you asking, such as reading a finished run. Your next message resets the count of turns; only Resume resets the wakes.";

/** The short name of an auto-start rule, as switches show it. */
export function ruleText(rule: WorkstreamRule): string {
  switch (rule) {
    case "investigate_triage":
      return "Investigate → Triage";
    case "triage_plan":
      return "Triage → Plan";
    case "plan_build":
      return "Plan approved → Build";
    case "build_review":
      return "Build's PR → Review";
    case "fix_round":
      return "Blocking review → fix round";
    case "review_verify":
      return "Passing review → Verify";
  }
}

/** The budget level of `ws`, as `budget_level` in src-tauri/src/domain/workstream.rs works it out: `amber` from 80% of either limit, `spent` at 100%. */
export function budgetLevel(ws: Workstream): BudgetLevel {
  const level = (used: number, limit: number): BudgetLevel => (used >= limit ? "spent" : used * 5 >= limit * 4 ? "amber" : "ok");
  const levels = [level(ws.spent.autoTurns, ws.budget.autoTurns ?? AUTO_TURNS_DEFAULT), level(ws.spent.wakes, ws.budget.wakes ?? WAKES_DEFAULT)];
  return levels.includes("spent") ? "spent" : levels.includes("amber") ? "amber" : "ok";
}

/** A workstream's budget as the page shows it, as `BudgetView::of` gives it. */
export function budgetView(ws: Workstream): BudgetView {
  return {
    autoTurns: { used: ws.spent.autoTurns, limit: ws.budget.autoTurns ?? AUTO_TURNS_DEFAULT },
    wakes: { used: ws.spent.wakes, limit: ws.budget.wakes ?? WAKES_DEFAULT },
    level: budgetLevel(ws),
  };
}

/** The budget's automatic turns as the person reads them up front: "11 of 11 automatic steps left". Never below none left. */
export function stepsLeftText(budget: BudgetView): string {
  const { used, limit } = budget.autoTurns;
  return `${Math.max(0, limit - used)} of ${limit} automatic steps left`;
}

/** The global switch in `AgentSettings.autostart` that each rule follows when a workstream has no switch of its own. */
export const RULE_SWITCH: Record<WorkstreamRule, keyof AutoStartSwitches> = {
  investigate_triage: "investigateTriage",
  triage_plan: "triagePlan",
  plan_build: "planBuild",
  build_review: "buildReview",
  fix_round: "fixRound",
  review_verify: "reviewVerify",
};

/**
 * The line the workstream's header shows about its budget: amber from 80% of either limit ("5 of 6 automatic turns
 * used"), spent at 100%; null while there is plenty left. It names the counter nearer its limit.
 */
export function budgetNote(budget: BudgetView): { level: "amber" | "spent"; text: string } | null {
  if (budget.level === "ok") return null;
  const { autoTurns, wakes } = budget;
  const turns = autoTurns.used / Math.max(1, autoTurns.limit) >= wakes.used / Math.max(1, wakes.limit);
  const text = turns ? `${autoTurns.used} of ${autoTurns.limit} automatic turns used` : `${wakes.used} of ${wakes.limit} wakes used`;
  return { level: budget.level, text };
}
