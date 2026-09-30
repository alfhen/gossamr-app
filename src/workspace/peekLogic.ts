import { itemKey } from "../lib/filter";
import type { ItemRef, WorkDoc, WorkEvent, WorkItem } from "../types";

export type LinkKind = "blocks" | "blockedBy" | "relates" | "duplicates" | "duplicatedBy";

export interface LinkRow {
  kind: LinkKind;
  label: string;
  ref: ItemRef;
  /** The linked item's title when it is cached. */
  title: string | null;
}

const LABEL: Record<LinkKind, string> = {
  blocks: "Blocks",
  blockedBy: "Blocked by",
  relates: "Relates to",
  duplicates: "Duplicates",
  duplicatedBy: "Duplicated by",
};

/** Links as seen from `item`: its own, plus those other items hold that point at it. */
export function linkRows(item: WorkItem, all: Record<string, WorkItem>): LinkRow[] {
  const me = itemKey(item.item);
  const rows = new Map<string, LinkRow>();
  const add = (kind: LinkKind, other: ItemRef) => {
    const id = `${kind}:${itemKey(other)}`;
    if (!rows.has(id)) rows.set(id, { kind, label: LABEL[kind], ref: other, title: all[itemKey(other)]?.title ?? null });
  };
  const seen = (l: WorkItem["links"][number]) => {
    const outgoing = itemKey(l.from) === me;
    if (!outgoing && itemKey(l.to) !== me) return;
    const other = outgoing ? l.to : l.from;
    if (l.kind === "relates") add("relates", other);
    else if (l.kind === "blocks") add(outgoing ? "blocks" : "blockedBy", other);
    else add(outgoing ? "duplicates" : "duplicatedBy", other);
  };
  item.links.forEach(seen);
  for (const other of Object.values(all)) if (other !== item) other.links.forEach(seen);
  const order: LinkKind[] = ["blockedBy", "blocks", "relates", "duplicates", "duplicatedBy"];
  return [...rows.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export interface Note {
  id: string;
  at: string;
  who: string;
  text: string;
  /** The structured body, when there is one; `text` is its plain reading. */
  doc?: WorkDoc;
}

const textOf = (payload: unknown): string => {
  const t = (payload as { text?: unknown } | null)?.text;
  return typeof t === "string" ? t : "";
};

/** Comments recorded as events, oldest first. */
export function commentNotes(events: readonly WorkEvent[], nameOf: (accountId: string | null) => string): Note[] {
  return events
    .filter((e) => e.kind === "commentAdded" && textOf(e.payload))
    .map((e) => ({ id: e.id, at: e.at, who: nameOf(e.actor?.accountId ?? null), text: textOf(e.payload) }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

const changeText = (payload: unknown): string => {
  const p = payload as { from?: unknown; to?: unknown } | null;
  return typeof p?.from === "string" && typeof p?.to === "string" ? `${p.from} → ${p.to}` : "";
};

/** Everything but comments, newest first, as one line each. */
export function historyNotes(events: readonly WorkEvent[], nameOf: (accountId: string | null) => string): Note[] {
  const line = (e: WorkEvent): string => {
    switch (e.kind) {
      case "statusChanged":
        return `moved it ${changeText(e.payload) || "to another status"}`;
      case "assigned":
        return "changed the assignee";
      case "itemCreated":
        return "created it";
      case "prOpened":
        return "opened a pull request";
      case "prMerged":
        return "merged a pull request";
      case "checkFailed":
        return "had a check fail";
      case "reviewRequested":
        return "asked for a review";
      case "commentAdded":
        return "";
    }
  };
  return events
    .flatMap((e) => (line(e) ? [{ id: e.id, at: e.at, who: nameOf(e.actor?.accountId ?? null), text: line(e) }] : []))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export interface Crumb {
  ref: ItemRef;
  title: string | null;
}

/** The parent (an epic, or a story above a subtask) with its title when it is cached. */
export function parentCrumb(item: WorkItem, all: Record<string, WorkItem>): Crumb | null {
  if (!item.parent) return null;
  return { ref: item.parent, title: all[itemKey(item.parent)]?.title ?? null };
}

export interface SubtaskRow {
  ref: ItemRef;
  title: string;
  status: WorkItem["status"];
  done: boolean;
}

export interface Subtasks {
  rows: SubtaskRow[];
  done: number;
}

/** Children in key order, with how many are finished. */
export function subtasksOf(children: readonly WorkItem[]): Subtasks {
  const rows = children
    .map((c): SubtaskRow => ({ ref: c.item, title: c.title, status: c.status, done: c.status.category === "done" }))
    .sort((a, b) => a.ref.key.localeCompare(b.ref.key, undefined, { numeric: true }));
  return { rows, done: rows.filter((r) => r.done).length };
}

/** The key `step` places from `current` in `order`, stopping at the ends. Starts at the first (or last) key when nothing is selected. */
export function stepKey(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (!order.length) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return order[step > 0 ? 0 : order.length - 1];
  return order[Math.max(0, Math.min(order.length - 1, at + step))];
}
