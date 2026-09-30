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
  /** Shown as a tab next to the presets. */
  pinned?: boolean;
}

export const BUILT_IN_VIEWS: SavedView[] = [
  { id: "needs-me", name: "Needs me", filter: { type: "needsMe" } },
  { id: "mine", name: "Assigned to me", filter: and({ type: "mine" }, { type: "open" }) },
  { id: "stale", name: "Stale", filter: { type: "stale", days: 5 } },
  { id: "blocked", name: "Blocked", filter: { type: "blocked" } },
];

/** The fixed tabs above the canvas, in the prototype's order. */
export const PRESETS: SavedView[] = [
  { ...BUILT_IN_VIEWS[0], name: "Needs me" },
  { ...BUILT_IN_VIEWS[1], name: "Mine" },
  { ...BUILT_IN_VIEWS[3] },
  { ...BUILT_IN_VIEWS[2], name: "Going stale" },
  { id: "everything", name: "Everything", filter: and() },
];

const chipKey = (c: WorkFilter) => JSON.stringify(c);

/** Whether two filters select the same things apart from the project they are scoped to. */
export function sameFilterIgnoringProject(a: WorkFilter, b: WorkFilter): boolean {
  const keys = (f: WorkFilter) => filterChips(f).filter((c) => c.type !== "container").map(chipKey).sort();
  const [x, y] = [keys(a), keys(b)];
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** The filter an entry (preset or saved view) selects inside `project`; an entry that names its own project keeps it. */
export const scopeTo = (entry: WorkFilter, project: ContainerRef | null): WorkFilter => (projectOf(entry) ? entry : withProject(entry, project));

/** Whether a tab filtered by `tab` is showing `entry`: presets ignore the project, a view that names one needs the same. */
export function showsEntry(entry: WorkFilter, tab: WorkFilter): boolean {
  const own = projectOf(entry);
  return sameFilterIgnoringProject(entry, tab) && (!own || sameProject(own, projectOf(tab)));
}

/** The chips the person added on top of the project, as `{ chip, index }` with the index `withoutChip` expects. */
export function visibleChips(filter: WorkFilter, hide: WorkFilter | null): { chip: WorkFilter; index: number }[] {
  if (hide && sameFilterIgnoringProject(filter, hide)) return [];
  return filterChips(filter).flatMap((chip, index) => (chip.type === "container" ? [] : [{ chip, index }]));
}
