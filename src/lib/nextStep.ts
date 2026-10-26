import { slotPosition, slotQueue, ordinal } from "../workspace/agentsLogic";
import type { Proposal, Run, WorkstreamView } from "../types";
import { byRank, type Need } from "./needs";
import { agoText, nudgeOffered, nudgeText, waitedDays, waitingOnReporterText } from "./reporterWait";
import { pausedText } from "./workstreamPause";
import { byQueue, STAGE_LABEL } from "./workstreamStage";

/**
 * What happens next in a workstream, and why, as one line for its header ("Next: when R5 (Build) finishes, Pip is woken to
 * decide what comes next."). It decides nothing: Pip is woken whenever a run finishes, and what it does then is its own.
 */

export type NextStepKind =
  /** Something needs the person; `need` is the top one. */
  | "waiting"
  /** The workstream is paused. */
  | "paused"
  /** The person asked the reporter and the comment was posted: nothing starts until they answer or the person chooses. */
  | "reporter"
  /** An approved run waits for a free slot. */
  | "slot"
  /** A run is working: Pip is woken when it finishes. */
  | "running"
  /** The chain is finished. */
  | "done"
  /** Nothing runs and nothing is queued. */
  | "idle";

export interface NextStep {
  kind: NextStepKind;
  /** One sentence, starting "Next: ". */
  text: string;
  /** The need the line links to: the top one, for "waiting"; null for every other line. */
  need: Need | null;
  /** The reporter has been silent long enough that "Draft a nudge" is offered beside the line (`kind` "reporter" only). */
  nudge?: boolean;
}

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
 * The line a workstream's header shows about what comes next. `runs` are the runs (the workstream's are told by
 * `view.runs`), `proposals` the drafts and `needs` the person's needs across the workstreams (`needs` in
 * src/lib/needs.ts). Null for a workstream that is closed.
 *
 * The first that applies decides: paused; something that blocks waiting on the person (the top need); a run waiting for a
 * slot; the chain finished; a run at work; then nothing running.
 */
export function nextStep(view: WorkstreamView, runs: readonly Run[], proposals: readonly Proposal[], needs: readonly Need[], now: Date = new Date()): NextStep | null {
  const ws = view.workstream;
  if (ws.closedAt) return null;
  const step = (kind: NextStepKind, text: string, need: Need | null = null): NextStep => ({ kind, text: `Next: ${text}`, need });
  const mine = runs.filter((r) => view.runs.includes(r.id)).sort(byQueue);
  const going = mine.filter(inProgress);

  const paused = pausedText(ws.pausedReason);
  if (paused) return step("paused", `${lower(paused)}. Resume to continue.`);

  const own = needs.filter((n) => n.workstreamId === ws.id).sort(byRank);
  // Anything that decides or unblocks stops the line at once. A draft to approve does not: a step in hand or queued
  // comes first, and the draft is what the person waits on only once nothing is going to happen on its own.
  // The plan's approval is named before any other need, then the order of Needs you.
  const blocking = own.find((n) => n.kind === "plan") ?? own.find((n) => n.group !== "approve");
  const more = own.length > 1 ? ` (+${own.length - 1} more waiting)` : "";
  if (blocking) return step("waiting", `waiting on you. ${blocking.why}${more}`, blocking);
  // Asked and posted: nothing starts on its own until the reporter answers, the ticket changes or the person chooses. A step in hand carries on first.
  if (view.waitingOnReporter && going.length === 0) {
    const nudge = nudgeOffered(view.waitingOnReporter, now, proposals, ws.id);
    const said = waitingOnReporterText(view.waitingOnReporter.since, now);
    return { ...step("reporter", nudge ? `${said} ${nudgeText(waitedDays(view.waitingOnReporter.since, now))}` : said), ...(nudge ? { nudge } : {}) };
  }
  // The reporter answered and the person has not chosen since: the answer is what the line says.
  if (view.reporterReplied && going.length === 0) return step("reporter", `the reporter replied${view.reporterRepliedAt ? ` ${agoText(view.reporterRepliedAt, now)}` : ""}; read it, then Looks fine or ask again.`);
  const approve = own[0];
  const line = chain(view, runs, mine, going, step);
  if (approve && line.kind !== "slot" && line.kind !== "running") return step("waiting", `waiting on you. ${approve.why}${more}`, approve);
  return line;
}

/** The line once nothing is waiting on the person: a slot, the chain finished, a run at work, then nothing running. */
function chain(view: WorkstreamView, runs: readonly Run[], mine: readonly Run[], going: readonly Run[], step: Step): NextStep {
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

  const src = going[0];
  if (src) return step("running", `when ${nameOf(src, view)} finishes, Pip is woken to decide what comes next.`);

  const last = mine[mine.length - 1];
  if (!last) return step("idle", "nothing is running. Ask Pip, or start a step yourself.");
  return step("idle", `nothing is running after ${nameOf(last, view)} ${last.state === "done" ? "finished" : last.state === "failed" ? "failed" : "stopped"}. Ask Pip or use ⌘K to start the next step.`);
}

type Step = (kind: NextStepKind, text: string, need?: Need | null) => NextStep;
