import type { StatusDef, Workflow } from "../types";

export function statusOf(wf: Workflow, id: string): StatusDef | undefined {
  return wf.statuses.find((s) => s.id === id);
}

/** Statuses an item can move to from `fromId`. A graph lists moves explicitly; `any` allows every other status. */
export function nextStatuses(wf: Workflow, fromId: string): StatusDef[] {
  if (wf.transitions.kind === "any") return wf.statuses.filter((s) => s.id !== fromId);
  const reachable = new Set(wf.transitions.moves.filter((m) => m.from === fromId).map((m) => m.to));
  return wf.statuses.filter((s) => reachable.has(s.id));
}

export const canMove = (wf: Workflow, fromId: string, toId: string) => nextStatuses(wf, fromId).some((s) => s.id === toId);

/** The fewest moves from one status to another, excluding the start; null when unreachable. */
export function shortestPath(wf: Workflow, fromId: string, toId: string): StatusDef[] | null {
  if (fromId === toId) return [];
  const prev = new Map<string, string>();
  const queue = [fromId];
  for (let head = 0; head < queue.length; head++) {
    for (const next of nextStatuses(wf, queue[head])) {
      if (next.id === fromId || prev.has(next.id)) continue;
      prev.set(next.id, queue[head]);
      if (next.id === toId) {
        const path: StatusDef[] = [];
        for (let at: string | undefined = toId; at && at !== fromId; at = prev.get(at)) path.unshift(statusOf(wf, at)!);
        return path;
      }
      queue.push(next.id);
    }
  }
  return null;
}
