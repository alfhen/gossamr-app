import { containerKey, itemKey } from "../lib/filter";
import type { WorkContainer, WorkItem } from "../types";
import { progressOf, type Progress } from "./canvasShared";

export interface ListGroup {
  key: string;
  label: string;
  /** The epic's key, or the project code for the items that have no epic. */
  sub: string;
  /** Set when the group is an epic or parent, so its header can open it. */
  parentKey: string | null;
  /** The matching items, in the order given. */
  items: WorkItem[];
  /** Counts every child the cache holds for an epic, so a filter narrows the rows but not the progress. */
  progress: Progress;
}

/**
 * Rows grouped by epic, then by project for what has no epic. A parent that is matched and has matched children is the
 * group header, not a row. Epics come first, by name.
 */
export function listGroups(items: readonly WorkItem[], all: Record<string, WorkItem>, containers: Record<string, WorkContainer>): ListGroup[] {
  const headers = new Set(items.flatMap((i) => (i.parent ? [itemKey(i.parent)] : [])));
  const childrenOf = new Map<string, WorkItem[]>();
  for (const i of Object.values(all)) {
    if (!i.parent) continue;
    const pk = itemKey(i.parent);
    childrenOf.set(pk, [...(childrenOf.get(pk) ?? []), i]);
  }

  const groups = new Map<string, ListGroup>();
  for (const i of items) {
    if (headers.has(itemKey(i.item))) continue;
    let key: string;
    let make: () => Omit<ListGroup, "items" | "progress">;
    if (i.parent) {
      const pk = itemKey(i.parent);
      key = `parent:${pk}`;
      make = () => ({ key, label: all[pk]?.title ?? i.parent!.key, sub: i.parent!.key, parentKey: pk });
    } else {
      const ck = containerKey(i.container);
      key = `project:${ck}`;
      make = () => ({ key, label: "No epic", sub: containers[ck]?.key ?? ck, parentKey: null });
    }
    const g = groups.get(key) ?? { ...make(), items: [], progress: progressOf([]) };
    g.items.push(i);
    groups.set(key, g);
  }

  for (const g of groups.values()) g.progress = progressOf(g.parentKey ? (childrenOf.get(g.parentKey) ?? g.items) : g.items);

  const rank = (g: ListGroup) => (g.parentKey ? 0 : 1);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label) || a.sub.localeCompare(b.sub));
}

/** The item keys as the list shows them top to bottom, leaving out the rows of collapsed groups. */
export const visibleOrder = (groups: readonly ListGroup[], collapsed: ReadonlySet<string>): string[] =>
  groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.items.map((i) => itemKey(i.item))));

/**
 * Where the selection goes when a group collapses over it: the next visible row, else the previous one. Null when it is
 * still shown, was not in the list, or nothing is left to show.
 */
export function selectionAfterCollapse(groups: readonly ListGroup[], collapsed: ReadonlySet<string>, selected: string | null): string | null {
  const all = visibleOrder(groups, new Set());
  const at = selected === null ? -1 : all.indexOf(selected);
  if (at < 0) return null;
  const shown = new Set(visibleOrder(groups, collapsed));
  if (shown.has(selected!)) return null;
  return all.slice(at + 1).find((k) => shown.has(k)) ?? all.slice(0, at).reverse().find((k) => shown.has(k)) ?? null;
}
