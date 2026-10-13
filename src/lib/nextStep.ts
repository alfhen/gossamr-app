import { decideAutostart, ruleOn, type AutostartInput, type ReviewFinding } from "../backend/mockSupervisor";
import { slotPosition, slotQueue, ordinal } from "../workspace/agentsLogic";
import { ALLOW_MORE_STEPS, AUTOSTART_DEFAULTS, HELD_BUDGET, type AutoStartSwitches, type Proposal, type Run, type RunKind, type WorkstreamEvent, type WorkstreamRule, type WorkstreamView } from "../types";
import { byRank, type Need } from "./needs";
import { waitingOnReporterText } from "./reporterWait";
import { shortHeld, stepsLeftText, ruleText } from "./workstreamHold";
import { byQueue, reviewPosted, STAGE_LABEL } from "./workstreamStage";

/**
 * What happens next in a workstream, and why, as one line for its header ("Next: when R5 (Build) finishes, a review
 * starts automatically."). It decides nothing and invents no rule: what the rules would start is asked of
 * `decideAutostart`, the TypeScript mirror of src-tauri/src/agent/autostart.rs (both run src/backend/supervisor.fixtures.json),
 * with the switches the workstream and Settings give. Where the answer hangs on what a run has yet to say (a review's
 * verdict, whether a triage recommends a plan) the line says so rather than guess.
 */

export type NextStepKind =
  /** Something needs the person; `need` is the top one. */
  | "waiting"
  /** The workstream is held. */
  | "held"
  /** The person asked the reporter and the comment was posted: nothing starts until they answer or the person chooses. */
  | "reporter"
  /** An approved run waits for a free slot. */
  | "slot"
  /** Advise: nothing starts on its own. */
  | "advise"
  /** The automatic budget is spent. */
  | "spent"
  /** A rule starts the next step on its own. */
  | "auto"
  /** A rule may start the next step, depending on what the running step reports. */
  | "depends"
  /** The rules start nothing after the step in hand: the person's click does. */
  | "manual"
  /** The chain is finished. */
  | "done"
  /** Nothing runs and nothing is queued. */
  | "idle";

export interface NextStep {
  kind: NextStepKind;
  /** One sentence, starting "Next: ". */
  text: string;
  /** The need the line links to: the top one, for "waiting"; the budget's question, for a workstream held for its automatic steps; null for every other line. */
  need: Need | null;
}

/** The step a rule's run is, with its article: "a review starts automatically". */
const A_STEP: Record<RunKind, string> = { investigate: "an investigation", triage: "a triage", plan: "a plan", build: "a build", review: "a review", verify: "a verification" };

/** The rule or rules whose switch decides what follows a finished run of `kind`; none for Verify, which ends the chain. */
const RULES_AFTER: Record<RunKind, readonly WorkstreamRule[]> = {
  investigate: ["investigate_triage"],
  triage: ["triage_plan"],
  plan: ["plan_build"],
  build: ["build_review"],
  review: ["fix_round", "review_verify"],
  verify: [],
};

/** Findings that would make a fix round possible, for asking `decideAutostart` what a blocking review leads to. */
const SOME_FINDING: ReviewFinding[] = [{ severity: "blocking", text: "src/a.ts:1 a defect" }];

/** "R5 (Build)": the run as the header names it, by its short name in the workstream and its step. */
function nameOf(run: Run, view: WorkstreamView): string {
  const label = view.labels.find(([id]) => id === run.id)?.[1];
  return label ? `${label} (${STAGE_LABEL[run.spec.kind]})` : `The ${STAGE_LABEL[run.spec.kind].toLowerCase()} agent`;
}

/** Just the short name, "R5", for a sentence that already says the step. */
const shortOf = (run: Run, view: WorkstreamView): string => view.labels.find(([id]) => id === run.id)?.[1] ?? `The ${STAGE_LABEL[run.spec.kind].toLowerCase()} agent`;

const inProgress = (run: Run) => run.state !== "done" && run.state !== "failed" && run.state !== "stopped";

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What the rules would start after `run` finishes, asked of the rule mirror. `known` is what is already known of how it
 * ended; what isn't is passed as the answer that lets a rule start, so a non-null result means "it may".
 */
function probe(run: Run, view: WorkstreamView, globals: Partial<AutoStartSwitches>, known: Partial<AutostartInput>): ReturnType<typeof decideAutostart> {
  const ws = view.workstream;
  const input: AutostartInput = {
    source: { id: run.id, kind: run.spec.kind, state: "done", ticket: !!run.item, allowPush: !!run.spec.allowPush, buildFromRun: run.spec.buildFromRun ?? null },
    report: {},
    workstream: { mode: ws.mode, held: ws.heldReason, closed: !!ws.closedAt, spent: ws.spent, rules: ws.rules, budget: ws.budget },
    global: globals,
    ...known,
  };
  return decideAutostart(input);
}

/** Why the rules start nothing after `run`, in a clause: the switch that is off, a build that may not push, a run with no ticket. */
function whyNothing(run: Run, view: WorkstreamView, globals: Partial<AutoStartSwitches>): string {
  const kind = run.spec.kind;
  if (kind === "verify") return "nothing follows a verification on its own";
  if (!run.item) return "it is not on a ticket";
  if (kind === "build" && !run.spec.allowPush) return "it may not push, so there is no pull request to review";
  const off = RULES_AFTER[kind].filter((r) => !ruleOn(globals, view.workstream.rules, r));
  if (off.length > 0) return `${off.map((r) => `“${ruleText(r)}”`).join(" and ")} ${off.length > 1 ? "are" : "is"} off`;
  return kind === "triage" ? "it did not call for a plan" : kind === "plan" ? "its plan is not approved yet" : "no rule applies";
}

/**
 * The line a workstream's header shows about what comes next. `runs` are the runs (the workstream's are told by
 * `view.runs`), `proposals` the drafts, `needs` the person's needs across the workstreams (`needs` in src/lib/needs.ts)
 * and `globals` the switches in Settings that a rule follows when the workstream has none of its own. Null for a
 * workstream that is closed.
 *
 * The first that applies decides: held; something that blocks waiting on the person (the top need); a run waiting for a
 * slot; the chain finished; Advise; the automatic budget spent; then what the rules start after the running step, or after
 * the last one that finished.
 */
export function nextStep(view: WorkstreamView, runs: readonly Run[], proposals: readonly Proposal[], needs: readonly Need[], globals: Partial<AutoStartSwitches> = AUTOSTART_DEFAULTS, events: readonly AuditLine[] = [], now: Date = new Date()): NextStep | null {
  const ws = view.workstream;
  if (ws.closedAt) return null;
  const step = (kind: NextStepKind, text: string, need: Need | null = null): NextStep => ({ kind, text: `Next: ${text}`, need });
  const mine = runs.filter((r) => view.runs.includes(r.id)).sort(byQueue);
  const going = mine.filter(inProgress);

  const held = shortHeld(ws.heldReason, ws.drifted) ?? (ws.heldReason ? "Held" : null);
  if (held) {
    // Running out of automatic steps is a question in Needs you; the line points at it rather than only saying "held".
    const budget = ws.heldReason === HELD_BUDGET ? needs.find((n) => n.key === `budget:${ws.id}`) : undefined;
    if (budget) return step("held", `the automatic steps are used up. Choose in Needs you: allow ${ALLOW_MORE_STEPS} more, or switch to Advise.`, budget);
    return step("held", `${lower(held)}. Resume to continue.`);
  }

  const own = needs.filter((n) => n.workstreamId === ws.id && n.kind !== "hold").sort(byRank);
  // Anything that decides or unblocks stops the line at once. A draft to approve does not: a step in hand or about to
  // start (queued, or one a rule is about to start) comes first, and the draft is what the person waits on only once
  // nothing is going to happen on its own.
  const blocking = own.find((n) => n.group !== "approve");
  if (blocking) return step("waiting", `waiting on you. ${blocking.why}`, blocking);
  // Asked and posted: nothing starts on its own until the reporter answers, the ticket changes or the person chooses. A step in hand carries on first.
  if (view.waitingOnReporter && going.length === 0) return step("reporter", waitingOnReporterText(view.waitingOnReporter.since, now));
  const approve = own[0];
  const line = chain(view, runs, proposals, globals, mine, going, step, events);
  if (approve && line.kind !== "slot" && line.kind !== "auto" && line.kind !== "depends") return step("waiting", `waiting on you. ${approve.why}`, approve);
  return line;
}

/** The line once nothing is waiting on the person: a slot, the chain finished, Advise, the budget, then what the rules start. */
function chain(view: WorkstreamView, runs: readonly Run[], proposals: readonly Proposal[], globals: Partial<AutoStartSwitches>, mine: readonly Run[], going: readonly Run[], step: Step, events: readonly AuditLine[]): NextStep {
  const ws = view.workstream;
  const queue = slotQueue(runs, [view]);
  const waiter = going.find((r) => r.state === "queued" && r.slotWaitSince);
  if (waiter) {
    const place = slotPosition(waiter, queue);
    return step("slot", `${shortOf(waiter, view)} starts when a slot frees${place ? ` (${ordinal(place)} in line)` : ""}.`);
  }

  if (view.stage === "done" && going.length === 0) {
    const verified = mine.some((r) => r.spec.kind === "verify" && r.state === "done");
    return step("done", `nothing left. The PR is ${verified ? "verified" : "reviewed"} and waits for you to merge it.`);
  }

  if (ws.mode !== "manage") return step("advise", "nothing starts on its own in Advise. Pip suggests, you start.");

  if (view.budget.level === "spent") return step("spent", "the automatic steps are used up. Your click starts the next step.");
  const left = view.budget.level === "amber" ? ` (${stepsLeftText(view.budget).replace(/ automatic steps left$/, "")} automatic steps left)` : "";

  const src = going[0];
  if (src) return afterRunning(src, view, globals, left, step);

  const last = mine[mine.length - 1];
  if (!last) return step("idle", "nothing is running. Ask Pip, or start a step yourself.");
  return afterFinished(last, view, mine, proposals, globals, left, step, events);
}

/** The parts of an audit line the line reads: fix rounds sent and reviews posted. */
type AuditLine = Pick<WorkstreamEvent, "action" | "actor" | "runId" | "detail" | "at">;

type Step = (kind: NextStepKind, text: string, need?: Need | null) => NextStep;

/** The line while `src` runs: what the rules start when it finishes, from what is known now. */
function afterRunning(src: Run, view: WorkstreamView, globals: Partial<AutoStartSwitches>, left: string, step: Step): NextStep {
  const name = nameOf(src, view);
  const kind = src.spec.kind;
  let result: ReturnType<typeof probe> = null;
  let unknown: string | null = null;
  switch (kind) {
    case "triage":
      // A plan follows only if the finished triage recommends one.
      result = probe(src, view, globals, { report: { planRecommended: true } });
      unknown = `${shortOf(src, view)}'s triage: a plan starts automatically only if it recommends one and finds the ticket ready to plan`;
      break;
    case "plan":
      // A build follows only once the person approves the plan.
      result = probe(src, view, globals, { planApproved: true });
      if (result) return step("depends", `when ${name} finishes and you approve its plan, a build starts automatically${left}.`);
      break;
    case "build":
      result = probe(src, view, globals, { pr: { number: 0, sha: null } });
      break;
    case "review": {
      const pass = probe(src, view, globals, { report: { verdict: "pass" } });
      const blocking = probe(src, view, globals, { report: { verdict: "blocking", findings: SOME_FINDING }, fixRounds: 0 });
      result = pass ?? blocking;
      unknown = `${shortOf(src, view)}'s review verdict`;
      break;
    }
    default:
      result = probe(src, view, globals, {});
  }
  if (result && unknown) return step("depends", `depends on ${unknown}${left}.`);
  if (result && result.decision === "start") return step("auto", `when ${name} finishes, ${A_STEP[result.kind]} starts automatically${left}.`);
  return step("manual", `when ${name} finishes, nothing starts on its own: ${whyNothing(src, view, globals)}. Your click starts the next step.`);
}

/** The line with nothing running: what the rules are about to start after the newest run, or why nothing is. */
function afterFinished(last: Run, view: WorkstreamView, mine: readonly Run[], proposals: readonly Proposal[], globals: Partial<AutoStartSwitches>, left: string, step: Step, events: readonly AuditLine[]): NextStep {
  const name = nameOf(last, view);
  if (last.state !== "done") return step("manual", `nothing starts on its own after ${name} ${last.state === "failed" ? "failed" : "stopped"}. Your click starts the next step.`);
  const kind = last.spec.kind;
  if (kind === "build" && view.waitingForPr === last.id && probe(last, view, globals, { pr: null })?.decision === "waitingForPr") {
    return step("auto", `waiting for ${shortOf(last, view)}'s pull request to show up; then a review starts automatically${left}.`);
  }
  const known: Partial<AutostartInput> = {};
  if (kind === "build") known.pr = { number: 0, sha: null };
  if (kind === "plan") known.planApproved = proposals.some((p) => p.origin.type === "run" && p.origin.runId === last.id && p.intent.type === "rewrite" && p.state.type === "applied");
  if (kind === "review") {
    known.report = view.reviewBlocking ? { verdict: "blocking", findings: SOME_FINDING } : { verdict: "pass" };
    // The rounds the supervisor already sent for this review's build, counted as it counts them.
    const build = last.spec.buildFromRun ?? null;
    known.fixRounds = build ? events.filter((e) => e.action === "autostart" && e.runId === build && !!e.detail?.startsWith("fix_round after ")).length : 0;
    // A review the person posted to GitHub: nothing follows it on its own, whatever it said.
    if (view.reviewBlocking && reviewPosted(events, last)) return step("manual", `the review is posted; nothing starts on its own. Your click starts the next step.`);
    known.reviewed = mine.filter((r) => r.spec.kind === "review").map((r) => r.spec.prSha ?? null);
  }
  const result = probe(last, view, globals, known);
  if (result?.decision === "start") return step("auto", `${A_STEP[result.kind]} starts automatically after ${name}${left}.`);
  if (result?.decision === "exhausted") return step("manual", `${shortOf(last, view)}'s review still blocks after ${known.fixRounds} fix rounds and no fix round starts on its own. Your click starts the next step.`);
  if (result?.decision === "fixRound") return step("auto", `a fix round starts automatically after ${name}${left}.`);
  if (kind === "review" && view.reviewBlocking) return step("manual", `${shortOf(last, view)}'s review blocks and no fix round starts on its own: ${whyNothing(last, view, globals)}. Your click starts the next step.`);
  return step("manual", `nothing starts on its own after ${name}: ${whyNothing(last, view, globals)}. Your click starts the next step.`);
}
