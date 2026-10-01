import type { Run } from "../types";
import { needsPerson, runTitle, stateView } from "./agentsLogic";
import type { Nudge } from "./nudges";

/** What the "What are my agents doing?" chip asks. Pip answers from its list_runs tool. */
export const runSummaryPrompt = () => "What are my agents doing?";

/** The runs worth a suggestion: waiting on the person, finished or failed. Working and quiet runs never are. */
const NUDGED = new Set<Run["state"]>(["needsAnswer", "needsPermission", "systemBlocked", "done", "failed"]);

/** Names a run's state for the nudge's identity: a new state is a new suggestion, the same one never repeats. */
export const runNudgeId = (run: Pick<Run, "id" | "state">) => `run:${run.id}:${run.state}`;

/** Every nudge-worthy run state at this moment, as the ids `runNudges` would use. */
export const runStatesNow = (runs: readonly Run[]): string[] => runs.filter((r) => NUDGED.has(r.state)).map(runNudgeId);

/**
 * One suggestion for each run that entered a state the person should hear about and isn't in `announced`, newest first.
 * `titleOf` gives a ticket's own title when it is cached.
 */
export function runNudges(runs: readonly Run[], announced: ReadonlySet<string>, titleOf: (run: Run) => string | null | undefined = () => null): Nudge[] {
  return [...runs]
    .filter((r) => NUDGED.has(r.state) && !announced.has(runNudgeId(r)))
    .sort((a, b) => (b.endedAt ?? b.lastProgressAt).localeCompare(a.endedAt ?? a.lastProgressAt))
    .map((run): Nudge => {
      const id = runNudgeId(run);
      const title = runTitle(run, titleOf(run));
      if (needsPerson(run)) return { id, kind: "run-needs", text: `${title} needs you. Want to look at what it asks?`, action: { type: "open-run", id: run.id } };
      if (run.state === "failed") return { id, kind: "run-failed", text: `${title} failed. Want to see why?`, action: { type: "open-run", id: run.id } };
      return { id, kind: "run-done", text: `${title} finished. Want me to sum up what it found?`, action: { type: "ask", prompt: `What did the agent find in run ${run.id}?` } };
    });
}

export const STRIP_SHOWN = 3;

const GOING = new Set<Run["state"]>(["queued", "launching", "working"]);

/** The runs Pip's pane keeps in view: the ones waiting on the person first, then the ones still working. */
export function stripRuns(runs: readonly Run[]): Run[] {
  const newest = (a: Run, b: Run) => b.lastProgressAt.localeCompare(a.lastProgressAt) || a.id.localeCompare(b.id);
  const needs = runs.filter(needsPerson).sort(newest);
  const going = runs.filter((r) => GOING.has(r.state)).sort(newest);
  return [...needs, ...going].slice(0, STRIP_SHOWN);
}

/** The open run in words for "What I can see right now", such as "Investigate CA-1 · Working". */
export const describeRun = (run: Run, ticketTitle: string | null | undefined, now: number) => `${runTitle(run, ticketTitle)} · ${stateView(run, now).label}`;
