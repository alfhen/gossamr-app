import type { Run, RunState, WorkstreamStage, WorkstreamView } from "../types";
import { stageOf, type Step } from "./roles";

/** Mirrors `stage` and `run_labels` in src-tauri/src/domain/workstream.rs; src/lib/workstreamStage.fixtures.json holds cases both sides run. */

/** What `stage` reads of a run: for a finished review, its verdict when one is known. */
export type StagedRun = Pick<Run, "id" | "state" | "queuedAt"> & { spec: Pick<Run["spec"], "role"> };

const RANK: Record<Step, number> = { investigate: 0, triage: 1, plan: 2, build: 3, review: 4, verify: 5 };

const inProgress = (state: RunState) => state !== "done" && state !== "failed" && state !== "stopped";

/**
 * When a run was queued, as milliseconds and the nanoseconds past them. The backend writes 0, 3, 6 or 9 fractional
 * digits, so the text alone doesn't sort ("…05Z" would come after "…05.500Z"), and Rust compares to the nanosecond.
 */
function instant(at: string): [number, number] {
  const frac = /\.(\d+)/.exec(at)?.[1] ?? "";
  const ms = Date.parse(at.replace(/\.\d+/, `.${frac.slice(0, 3).padEnd(3, "0")}`));
  return [ms, Number(frac.slice(3, 9).padEnd(6, "0"))];
}

/** Queue time, then id: the order runs are numbered in, and the tie-break for the last one queued. */
export function byQueue(a: Pick<StagedRun, "id" | "queuedAt">, b: Pick<StagedRun, "id" | "queuedAt">): number {
  const [x, y] = [instant(a.queuedAt), instant(b.queuedAt)];
  return x[0] - y[0] || x[1] - y[1] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The step furthest along among `runs` whose state `pick` accepts. */
function furthest(runs: readonly StagedRun[], pick: (s: RunState) => boolean): Step | null {
  let found: Step | null = null;
  for (const r of runs) if (pick(r.state) && (found === null || RANK[stageOf(r.spec.role)] >= RANK[found])) found = stageOf(r.spec.role);
  return found;
}

export function stage(runs: readonly StagedRun[]): WorkstreamStage {
  const going = furthest(runs, inProgress);
  if (going) return going;
  const done = furthest(runs, (s) => s === "done");
  if (done === "verify") return "done";
  if (done) return done;
  const last = [...runs].sort(byQueue).pop();
  return last ? stageOf(last.spec.role) : "intake";
}

/** The parts of an audit line `reviewPosted` reads. */
type PostEvent = { action: string; actor?: string; runId: string | null; at?: string };

/**
 * Whether the person posted a GitHub review for `review` (a finished review run) as it stood: a `review_posted` or
 * `escalation_posted` of theirs for that run, or, for a line that names no run, made after it ended. A line that names
 * another run is never this one's. The review still blocks, but it has gone to GitHub.
 */
export function reviewPosted(events: readonly PostEvent[], review: { id: string; launchedAt?: string | null; endedAt?: string | null }): boolean {
  const since = Date.parse(review.endedAt ?? review.launchedAt ?? "");
  return events.some((e) => e.actor === "person" && (e.action === "review_posted" || e.action === "escalation_posted") && (e.runId != null ? e.runId === review.id : e.at !== undefined && Date.parse(e.at) >= since));
}

/** Short names for the runs of a workstream, `R1` for the first queued: by queue time, ties by id. */
export function runLabels(runs: readonly StagedRun[]): [string, string][] {
  return [...runs].sort(byQueue).map((r, n) => [r.id, `R${n + 1}`]);
}

/** Every run's short name in its own workstream, by run id, counted over all of that workstream's runs; a run in none has none. */
export function labelsByRun(runs: readonly (StagedRun & { spec: { workstream?: string | null } })[]): Map<string, string> {
  const byWorkstream = new Map<string, StagedRun[]>();
  for (const r of runs) if (r.spec.workstream) byWorkstream.set(r.spec.workstream, [...(byWorkstream.get(r.spec.workstream) ?? []), r]);
  return new Map([...byWorkstream.values()].flatMap((list) => runLabels(list)));
}

/** Said after the stage while a finished build's pull request hasn't been found yet. */
export const WAITING_FOR_PR = "waiting for PR";

/** Said instead of the blocking verdict once the person posted the review to GitHub. */
export const REVIEW_POSTED = "Review posted";

export const STAGE_LABEL: Record<WorkstreamStage, string> = {
  intake: "Intake",
  investigate: "Investigate",
  triage: "Triage",
  plan: "Plan",
  build: "Build",
  review: "Review",
  verify: "Verify",
  done: "Done",
};

/** The open workstream on ticket `key` (in connection `connectionId` when it is given). */
export const ofItem = (list: readonly WorkstreamView[], key: string, connectionId?: string) =>
  list.find((v) => v.workstream.itemKey === key && v.workstream.closedAt === null && (!connectionId || v.workstream.connectionId === connectionId)) ?? null;

/** The open workstream `run` belongs to, or else the one open on its ticket. */
export function runWorkstream(list: readonly WorkstreamView[], run: Run | null | undefined): WorkstreamView | null {
  if (!run) return null;
  const own = run.spec.workstream ? list.find((v) => v.workstream.id === run.spec.workstream && v.workstream.closedAt === null) : undefined;
  return own ?? (run.item ? ofItem(list, run.item.key, run.item.connectionId) : null);
}
