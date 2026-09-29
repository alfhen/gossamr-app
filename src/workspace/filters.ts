import { and, containerKey, filterChips, parseQuery, type QueryLookup } from "../lib/filter";
import type { ContainerRef, WorkFilter } from "../types";

/** Adds words typed in the filter box to the filter already in place. */
export const refine = (current: WorkFilter, words: string, lookup: QueryLookup): WorkFilter => and(current, parseQuery(words, lookup));

export const withoutChip = (filter: WorkFilter, index: number): WorkFilter => and(...filterChips(filter).filter((_, i) => i !== index));

/** The project a filter narrows to, if it does. */
export function projectOf(filter: WorkFilter): ContainerRef | null {
  const chip = filterChips(filter).find((c) => c.type === "container");
  return chip?.type === "container" ? chip.container : null;
}

/** Replaces any project in the filter, or drops it when `project` is null. */
export function withProject(filter: WorkFilter, project: ContainerRef | null): WorkFilter {
  const rest = filterChips(filter).filter((c) => c.type !== "container");
  return and(...rest, ...(project ? [{ type: "container" as const, container: project }] : []));
}

export const sameProject = (a: ContainerRef | null, b: ContainerRef | null) => (a && b ? containerKey(a) === containerKey(b) : a === b);

export interface SavedView {
  id: string;
  name: string;
  filter: WorkFilter;
}

export const BUILT_IN_VIEWS: SavedView[] = [
  { id: "needs-me", name: "Needs me", filter: { type: "needsMe" } },
  { id: "mine", name: "Assigned to me", filter: and({ type: "mine" }, { type: "open" }) },
  { id: "stale", name: "Stale", filter: { type: "stale", days: 5 } },
  { id: "blocked", name: "Blocked", filter: { type: "blocked" } },
];
