import type { ClearFilter, ClearPreview, Proposal, Run, RunState } from "../types";

/** A run that is over: only these can be archived. Anything still going, or waiting on the person, is stopped first. */
export const ARCHIVABLE: readonly RunState[] = ["done", "failed", "stopped", "unknown"];

export const isArchivable = (run: Pick<Run, "state">) => ARCHIVABLE.includes(run.state);

export const archiveControl = (run: Pick<Run, "state">): { enabled: boolean; title: string } =>
  isArchivable(run) ? { enabled: true, title: "Takes it out of Agents and Needs you. It stays under Archived until you delete it." } : { enabled: false, title: "Stop it first, then archive it." };

export const CLEAR_AGES: readonly (number | null)[] = [1, 7, 30, null];

export const CLEAR_STATES: readonly { state: RunState; label: string }[] = [
  { state: "done", label: "Done" },
  { state: "failed", label: "Failed" },
  { state: "stopped", label: "Stopped" },
  { state: "unknown", label: "Unknown" },
];

export const DEFAULT_CLEAR: ClearFilter = { olderThanDays: 7, states: ["done", "failed", "stopped"], keep: [] };

const DAY = 86_400_000;

/** When the run's age counts from: the moment it ended, otherwise the moment it was queued. */
const since = (run: Pick<Run, "endedAt" | "queuedAt">) => Date.parse(run.endedAt ?? run.queuedAt);

/** The ids of runs with a draft still waiting for the person (a comment, a plan's description update). */
export function runsWithPendingDrafts(proposals: readonly Proposal[]): Set<string> {
  const ids = new Set<string>();
  for (const p of proposals) if (p.state.type === "pending" && p.origin.type === "run") ids.add(p.origin.runId);
  return ids;
}

/**
 * The runs `filter` would archive, and how many it leaves out for a draft still to approve or for being in Needs you
 * (`filter.keep`). A run that is archived, still going or waiting on the person is never chosen, whatever the filter says.
 */
export function selectClearable(runs: readonly Run[], drafts: ReadonlySet<string>, filter: ClearFilter, now: number): ClearPreview {
  const keep = new Set(filter.keep);
  const out: ClearPreview = { ids: [], byState: {}, kept: { draft: 0, needsYou: 0 } };
  for (const run of runs) {
    const old = filter.olderThanDays === null || now - since(run) > filter.olderThanDays * DAY;
    if (run.archivedAt || !isArchivable(run) || !filter.states.includes(run.state) || !old) continue;
    if (drafts.has(run.id)) out.kept.draft++;
    else if (keep.has(run.id)) out.kept.needsYou++;
    else {
      out.ids.push(run.id);
      out.byState[run.state] = (out.byState[run.state] ?? 0) + 1;
    }
  }
  return out;
}

/** "Archive 12 runs older than 7 days: done, failed, stopped", or "Nothing to archive with these choices." */
export function clearSentence(preview: Pick<ClearPreview, "ids">, filter: Pick<ClearFilter, "olderThanDays" | "states">): string {
  const n = preview.ids.length;
  if (n === 0) return "Nothing to archive with these choices.";
  const age = filter.olderThanDays === null ? "" : ` older than ${filter.olderThanDays} ${filter.olderThanDays === 1 ? "day" : "days"}`;
  return `Archive ${n} ${n === 1 ? "run" : "runs"}${age}: ${filter.states.join(", ")}`;
}

/** What the preview left out, in a line; null when it left nothing out. */
export function keptText(kept: ClearPreview["kept"]): string | null {
  const parts = [kept.draft && `${kept.draft} with a draft to approve`, kept.needsYou && `${kept.needsYou} in Needs you`].filter(Boolean);
  return parts.length ? `Kept: ${parts.join(", ")}.` : null;
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}
