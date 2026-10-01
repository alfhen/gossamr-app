import type { CodeChange, Run } from "../types";
import { formatBytes } from "./runSheetLogic";

export const STALE_DAYS = 14;
export const BIG_BYTES = 1024 ** 3;
const DAY = 86_400_000;

/** A run that is over, still has a session to remove, and whose worktree is still there. */
export const cleanable = (run: Pick<Run, "state" | "shortId" | "worktreeRemovedAt">) => ["done", "failed", "stopped"].includes(run.state) && !!run.shortId && !run.worktreeRemovedAt;

const endedAt = (run: Pick<Run, "endedAt" | "lastProgressAt">) => Date.parse(run.endedAt ?? run.lastProgressAt);

/** Why cleaning this run up is worth offering, or null when it is not: its pull request is settled, it is old, or it takes a lot of disk. */
export function cleanupReason(run: Pick<Run, "state" | "shortId" | "worktreeRemovedAt" | "endedAt" | "lastProgressAt">, now: number, known: { disk: number | null; change: Pick<CodeChange, "state"> | null }): string | null {
  if (!cleanable(run)) return null;
  if (known.change?.state === "merged" || known.change?.state === "closed") return `Its pull request is ${known.change.state}.`;
  if (now - endedAt(run) > STALE_DAYS * DAY) return `It ended more than ${STALE_DAYS} days ago.`;
  if (known.disk !== null && known.disk > BIG_BYTES) return `Its session files take ${formatBytes(known.disk)}.`;
  return null;
}

export interface BulkCleanup {
  runs: Run[];
  reason: string;
}

/** The finished runs to offer cleaning up together: when any is old, or all of them together are large. */
export function bulkCleanup(runs: readonly Run[], now: number, totalDisk: number | null): BulkCleanup | null {
  const finished = runs.filter(cleanable);
  if (!finished.length) return null;
  const old = finished.some((r) => now - endedAt(r) > STALE_DAYS * DAY);
  if (old) return { runs: finished, reason: `Some ended more than ${STALE_DAYS} days ago.` };
  return totalDisk !== null && totalDisk > BIG_BYTES ? { runs: finished, reason: "Their session files take a lot of space." } : null;
}

/** What "Clean up finished runs" did, in a sentence. */
export function cleanupReport(removed: number, refused: readonly string[]): string {
  const done = `Removed ${removed} ${removed === 1 ? "worktree" : "worktrees"}.`;
  if (!refused.length) return done;
  return `${done} ${refused.length} kept: ${refused[0]}`;
}
