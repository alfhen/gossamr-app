import type { Run, WorkstreamView } from "../types";
import { needsIn, type Need } from "./needs";
import { STAGE_LABEL } from "./workstreamStage";

/**
 * One status word per workstream, the first of these that applies. The order is the one docs/needs-you.md gives its
 * questions, most to least urgent, so the word is always the thing to do or know first:
 *
 * 1. `needs-you`: something in this workstream waits on the person. It outranks everything because Needs you is the one
 *    place decisions are made, and a person who has one thing to do must not be told the workstream is merely "Running".
 * 2. `paused`: the pause is the only thing waiting; the person resumes it.
 * 3. `running`: a run is active (or queued for a slot).
 * 4. `done`: closed, or its stage is done.
 * 5. `idle`: none of the above.
 *
 * Pure: the runs and the needs are given.
 */
export type StatusState = "needs-you" | "paused" | "running" | "done" | "idle";

/** Colour tokens a state is drawn with (`ws-*` in theme.css); `ink` is the quiet grey. */
export type StatusTone = "pip" | "warn" | "accent" | "ink" | "done";

export const STATUS_TONE: Record<StatusState, StatusTone> = { "needs-you": "pip", paused: "warn", running: "accent", done: "done", idle: "ink" };

/** The words a state is shown with. */
export const STATUS_WORD: Record<StatusState, string> = { "needs-you": "Needs you", paused: "Paused", running: "Running", done: "Done", idle: "Idle" };

/** What each word means, for the pill's tooltip: what is going on, and what ends it. */
export const STATUS_HINT: Record<StatusState, string> = {
  "needs-you": "Something in this workstream waits on a decision from you. Open it in Needs you.",
  paused: "Pip isn't woken in this workstream until you resume it; its agents carry on.",
  running: "A Claude Code run is working on a step, or is queued for a slot.",
  done: "The workstream is closed, or its work is finished.",
  idle: "Nothing is running and nothing waits on you.",
};

export interface WorkstreamStatus {
  state: StatusState;
  /** The one word: "Needs you", "Running". */
  word: string;
  tone: StatusTone;
  /** At most one short detail after the word: "2 waiting", "Build", "Plan failed"; null when the word says it all. */
  detail: string | null;
}

export interface StatusMore {
  /** Every run; those of the workstream are read from `view.runs`. */
  runs?: readonly Run[];
}

/** The pill's hint: the state's own. */
export const hintFor = (status: Pick<WorkstreamStatus, "state">): string => STATUS_HINT[status.state];

const RUNNING = new Set<Run["state"]>(["launching", "working"]);

export function workstreamStatus(view: WorkstreamView, needs: readonly Pick<Need, "workstreamId">[], more: StatusMore = {}): WorkstreamStatus {
  const { runs = [] } = more;
  const ws = view.workstream;
  const make = (state: StatusState, detail: string | null = null): WorkstreamStatus => ({ state, word: STATUS_WORD[state], tone: STATUS_TONE[state], detail });
  const own = runs.filter((r) => view.runs.includes(r.id));
  const waiting = needsIn(needs, ws.id);

  // A pause is one of the needs; when it is the only one, it is the word.
  if (waiting > 0) {
    if (waiting === 1 && ws.pausedReason) return make("paused", ws.pausedReason === "ceiling" ? "Pip was woken too often today" : null);
    return make("needs-you", `${waiting} waiting`);
  }
  const furthest = (pick: (r: Run) => boolean) => own.filter(pick).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop();
  const going = furthest((r) => RUNNING.has(r.state)) ?? furthest((r) => r.state === "queued");
  if (going) return make("running", `${STAGE_LABEL[going.spec.kind]}${going.state === "queued" ? " queued" : ""}`);
  if (ws.closedAt || view.stage === "done") return make("done");
  const failed = [...own].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop();
  return make("idle", failed?.state === "failed" ? `${STAGE_LABEL[failed.spec.kind]} failed` : null);
}
