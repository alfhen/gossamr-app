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
 * What a basis-drift hold says when the ticket changed while the workstream waited on the reporter: the hold is the same,
 * but what to do after it is the plan decision, which Resume leads to, e.g. "Held: CA-408's description changed while
 * waiting on the reporter. Resume, then decide whether to plan now."
 */
export function driftWhileWaitingText(key: string | null | undefined, drifted: readonly BasisField[] | null | undefined): string {
  const changed = (["summary", "description"] as const).filter((f) => drifted?.includes(f));
  const done = drifted?.includes("status") ?? false;
  const owner = key ? `${key}'s` : "the ticket's";
  const what = changed.length ? `${owner} ${changed.join(" and ")} changed${done ? " and it was moved to Done" : ""}` : done ? `${key ?? "the ticket"} was moved to Done` : `${key ?? "the ticket"} changed`;
  return `Held: ${what} while waiting on the reporter. Resume, then decide whether to plan now.`;
}

/**
 * The one count of the budget the person reads, in automatic steps: what is left of whichever of the backend's two counters
 * (automatic turns and wakes) is nearer its limit, out of the smaller of the two limits, so the total stays put when the
 * other counter takes over (a message from the person zeroes the turns, not the wakes). Nothing on the page names the other.
 */
export function stepsOf(budget: BudgetView): { used: number; limit: number } {
  const limit = Math.min(budget.autoTurns.limit, budget.wakes.limit);
  const left = Math.max(0, Math.min(limit, budget.autoTurns.limit - budget.autoTurns.used, budget.wakes.limit - budget.wakes.used));
  return { used: limit - left, limit };
}

/** Whether `reason` is a hold the person chose (Hold, Stop or Hold all), which is no need: only the holds the system makes ask them anything. */
export function isHeldByYou(reason: string | null | undefined): boolean {
  return reason === HELD_PERSON || reason === HELD_ALL;
}

/**
 * What the page says about a workstream held for `reason` (`heldReason`); null when it isn't held. A basis-drift hold
 * says what changed when `drifted` names it. A budget hold says no more than that the steps are used up: what to do
 * is Allow 5 more or Advise (the banner's buttons), never Resume: lifting the hold grants nothing, and Manage with the steps spent is held again.
 */
export function heldText(reason: string | null | undefined, drifted?: readonly BasisField[] | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case HELD_RESTART:
      return "Held after a restart";
    case HELD_PERSON:
      return "Held by you";
    case HELD_ALL:
      return "Held by you (Hold all)";
    case HELD_BUDGET:
      return "Held: automatic steps used up";
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

/**
 * The whole held banner of `ws`: why it is held, then for a tripwire what Resume does. A basis-drift hold of a workstream
 * whose ticket changed while it waited on the reporter (`changedWhileWaiting`) says so, and that Resume leads to the plan decision.
 */
export function heldBanner(ws: Pick<Workstream, "heldReason" | "drifted" | "resumeMode"> & { mode?: WorkstreamMode; itemKey?: string | null }, changedWhileWaiting = false): string | null {
  const waited = changedWhileWaiting && ws.heldReason === `${TRIPWIRE}basis_drift`;
  const held = waited ? driftWhileWaitingText(ws.itemKey, ws.drifted) : heldText(ws.heldReason, ws.drifted);
  const resume = tripwireResumeText(ws.heldReason, ws.resumeMode, ws.mode);
  return held && resume ? `${waited ? held : `${held}.`} ${resume}` : held;
}

/** What one automatic step is, for the budget's meter and banner. */
export const STEP_HELP = "An automatic step is each time Pip acts without you asking, such as reading a finished run. Automatic fix rounds don't count. When they run out you can allow 5 more, or switch to Advise.";

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

/** The budget level of `ws`, as `budget_level` in src-tauri/src/domain/workstream.rs works it out: `amber` from 80% of either limit, `spent` at 100%. Both run `budget` in src/lib/workstreamHold.fixtures.json. */
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

/** The budget as the person reads it up front: "11 of 11 automatic steps left". Never below none left. */
export function stepsLeftText(budget: BudgetView): string {
  const { used, limit } = stepsOf(budget);
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

/** The line the workstream's header shows about its budget: amber from 80% of either limit ("5 of 6 automatic steps used"), spent at 100%; null while there is plenty left. */
export function budgetNote(budget: BudgetView): { level: "amber" | "spent"; text: string } | null {
  if (budget.level === "ok") return null;
  const { used, limit } = stepsOf(budget);
  return { level: budget.level, text: `${used} of ${limit} automatic steps used` };
}

/** Whether the held banner of `ws` asks the budget question (Allow 5 more, Switch to Advise) instead of offering Resume: a budget hold in Manage. In Advise nothing starts on its own, so only the hold is left to lift. */
export function asksBudget(ws: Pick<Workstream, "heldReason" | "mode">): boolean {
  return ws.heldReason === HELD_BUDGET && ws.mode === "manage";
}

/**
 * What a workstream's held banner says, shortened for a row or the list: "Held: budget", "Held by you", "Held: the
 * ticket's description changed in Jira". A safety hold reads as the banner does, in plain words.
 */
export function shortHeld(reason: string | null | undefined, drifted?: readonly BasisField[] | null): string | null {
  const text = heldText(reason, drifted);
  if (!text || !reason) return null;
  if (reason === HELD_BUDGET) return "Held: budget";
  if (reason === HELD_DAILY) return "Held: daily turns";
  return text;
}
