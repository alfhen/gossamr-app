import type { Run, RunKind, RunState, WorkstreamStage } from "../types";

/** Mirrors `stage` and `run_labels` in src-tauri/src/domain/workstream.rs; src/lib/workstreamStage.fixtures.json holds cases both sides run. */

/** What `stage` reads of a run. */
export type StagedRun = Pick<Run, "id" | "state" | "queuedAt"> & { spec: Pick<Run["spec"], "kind"> };

const RANK: Record<RunKind, number> = { investigate: 0, triage: 1, plan: 2, build: 3, review: 4, verify: 5 };

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

/** The kind furthest along among `runs` whose state `pick` accepts. */
function furthest(runs: readonly StagedRun[], pick: (s: RunState) => boolean): RunKind | null {
  let found: RunKind | null = null;
  for (const r of runs) if (pick(r.state) && (found === null || RANK[r.spec.kind] >= RANK[found])) found = r.spec.kind;
  return found;
}

/**
 * The stage of a workstream whose linked runs are `runs`, in any order. The first rule that applies decides: no runs is
 * intake; any run in progress gives the furthest kind among those; else the furthest kind that finished, a finished
 * review or verify being done; else (every run failed or stopped) the kind of the run queued last.
 */
export function stage(runs: readonly StagedRun[]): WorkstreamStage {
  const going = furthest(runs, inProgress);
  if (going) return going;
  const done = furthest(runs, (s) => s === "done");
  if (done) return done === "review" || done === "verify" ? "done" : done;
  const last = [...runs].sort(byQueue).pop();
  return last ? last.spec.kind : "intake";
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
