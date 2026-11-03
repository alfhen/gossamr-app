import type { CodeChange, ConnectionInfo, Run } from "../types";
import { DEFAULT_INSTANCE, instanceOf } from "./providerLogic";
import { formatBytes } from "./runSheetLogic";

export const STALE_DAYS = 14;
export const BIG_BYTES = 1024 ** 3;
const DAY = 86_400_000;

/** How many earlier sessions of the run `claude rm` has not removed yet. */
export const leftoverSessions = (run: Pick<Run, "earlierSessions">) => (run.earlierSessions ?? []).filter((s) => !s.removed).length;

/** A run that is over, has a session to remove, and still has its worktree or an earlier session that was kept. */
export const cleanable = (run: Pick<Run, "state" | "shortId" | "worktreeRemovedAt" | "earlierSessions">) => ["done", "failed", "stopped"].includes(run.state) && !!run.shortId && (!run.worktreeRemovedAt || leftoverSessions(run) > 0);

const endedAt = (run: Pick<Run, "endedAt" | "lastProgressAt">) => Date.parse(run.endedAt ?? run.lastProgressAt);

/** Why cleaning this run up is worth offering, or null when it is not: its pull request is settled, it is old, or it takes a lot of disk. */
export function cleanupReason(run: Pick<Run, "state" | "shortId" | "worktreeRemovedAt" | "earlierSessions" | "endedAt" | "lastProgressAt">, now: number, known: { disk: number | null; change: Pick<CodeChange, "state"> | null }): string | null {
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

/** What removes a run's worktree: `claude rm`, git (Codex, or a login that was removed), or unknown while the logins haven't loaded. */
export type Remover = "claude" | "git" | "unknown";

/** Follows `RunService::instance_removed`: git only for a run that records its login, once the logins have loaded and none has that id. */
export function removerOf(run: Pick<Run, "runsOn">, connections: readonly ConnectionInfo[], loaded: boolean): { remover: Remover; login: string | null } {
  const instanceId = run.runsOn?.instanceId ?? DEFAULT_INSTANCE;
  const known = connections.some((c) => c.kind === "provider" && c.instanceId === instanceId);
  if (!known && run.runsOn) return { remover: loaded ? "git" : "unknown", login: null };
  const instance = instanceOf(connections, instanceId);
  return { remover: instance.driver === "claude" ? "claude" : "git", login: instance.name };
}
