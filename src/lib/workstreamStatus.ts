import type { Run, WorkstreamView } from "../types";
import { hasFailed } from "../workspace/agentsLogic";
import { latestRuns, needsIn, type Need } from "./needs";
import { roleLabel } from "./roles";

/**
 * One status word per workstream, the first of these that applies. The order is the one docs/needs-you.md gives its
 * questions, most to least urgent, so the word is always the thing to do or know first:
 *
 * 1. `needs-you`: something in this workstream waits on the person. It outranks everything because Needs you is the one
 *    place decisions are made, and a person who has one thing to do must not be told the workstream is merely "Running".
 * 2. `failed`: an agent failed (or lost its session) and no newer run of its role has followed. A failure the person dismissed from Needs you does not count, so a closed workstream with an old failure reads "Done".
 * 3. `running`: a run is active (or queued for a slot).
 * 4. `done`: closed, or its stage is done.
 * 5. `idle`: none of the above.
 *
 * Pure: the runs and the needs are given.
 */
export type StatusState = "needs-you" | "failed" | "running" | "done" | "idle";

/** Colour tokens a state is drawn with (`ws-*` in theme.css); `ink` is the quiet grey. */
export type StatusTone = "pip" | "warn" | "accent" | "ink" | "done";

export const STATUS_TONE: Record<StatusState, StatusTone> = { "needs-you": "pip", failed: "warn", running: "accent", done: "done", idle: "ink" };

/** The words a state is shown with. */
export const STATUS_WORD: Record<StatusState, string> = { "needs-you": "Needs you", failed: "Failed", running: "Running", done: "Done", idle: "Idle" };

/** What each word means, for the pill's tooltip: what is going on, and what ends it. */
export const STATUS_HINT: Record<StatusState, string> = {
  "needs-you": "Something in this workstream waits on a decision from you. Open it in Needs you.",
  failed: "An agent failed in this workstream.",
  running: "A Claude Code run is working on a step, or is queued for a slot.",
  done: "The workstream is closed, or its work is finished.",
  idle: "Nothing is running and nothing waits on you.",
};

export interface WorkstreamStatus {
  state: StatusState;
  /** The one word: "Needs you", "Running". */
  word: string;
  tone: StatusTone;
  /** At most one short detail after the word: "2 waiting" or "Build"; null when the word says it all. */
  detail: string | null;
}

export interface StatusMore {
  /** Every run; those of the workstream are read from `view.runs`. */
  runs?: readonly Run[];
  /** The runs whose failure the person dismissed from Needs you. */
  dismissed?: ReadonlySet<string>;
}

/** The pill's hint: the state's own. */
export const hintFor = (status: Pick<WorkstreamStatus, "state">): string => STATUS_HINT[status.state];

const RUNNING = new Set<Run["state"]>(["launching", "working"]);

export function workstreamStatus(view: WorkstreamView, needs: readonly Pick<Need, "workstreamId">[], more: StatusMore = {}): WorkstreamStatus {
  const { runs = [], dismissed = new Set<string>() } = more;
  const ws = view.workstream;
  const make = (state: StatusState, detail: string | null = null): WorkstreamStatus => ({ state, word: STATUS_WORD[state], tone: STATUS_TONE[state], detail });
  const own = runs.filter((r) => view.runs.includes(r.id));
  const waiting = needsIn(needs, ws.id);

  if (waiting > 0) return make("needs-you", `${waiting} waiting`);
  const furthest = (pick: (r: Run) => boolean) => own.filter(pick).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)).pop();
  const last = latestRuns(runs);
  const failed = furthest((r) => hasFailed(r) && !dismissed.has(r.id) && !r.archivedAt && last.has(r.id));
  if (failed) return make("failed", roleLabel(failed.spec.role));
  const going = furthest((r) => RUNNING.has(r.state)) ?? furthest((r) => r.state === "queued");
  if (going) return make("running", `${roleLabel(going.spec.role)}${going.state === "queued" ? " queued" : ""}`);
  if (ws.closedAt || view.stage === "done") return make("done");
  return make("idle");
}
