import type { StatusDef, WorkCategory } from "../types";

const RANK: Record<WorkCategory, number> = { todo: 0, active: 1, done: 2 };

/** To do, then in progress, then done, each keeping the workflow's own order. */
export function defaultOrder(statuses: readonly StatusDef[]): StatusDef[] {
  return statuses
    .map((s, at) => ({ s, at }))
    .sort((a, b) => RANK[a.s.category] - RANK[b.s.category] || a.at - b.at)
    .map((x) => x.s);
}
