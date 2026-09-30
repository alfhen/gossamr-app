import { compileFilter, containerKey, itemKey } from "../lib/filter";
import { targetOf } from "../lib/proposals";
import { nextStatuses } from "../lib/workflow";
import { WITHER_DAYS, witherLevel, type WitherLevel } from "../lib/views";
import type { ContainerRef, Intent, Proposal, StatusDef, WorkCategory, WorkContainer, WorkItem, Workflow } from "../types";

export interface BoardColumn {
  status: StatusDef;
  items: WorkItem[];
}

export interface BoardSection {
  key: string;
  name: string;
  /** The project's key, for the section header. */
  code: string;
  workflow: Workflow;
  columns: BoardColumn[];
  count: number;
}

const CATEGORY_ORDER: Record<WorkCategory, number> = { todo: 0, active: 1, done: 2 };

/**
 * One section per project that has items, each with its own workflow's columns. A status the workflow doesn't list
 * (a tracker that reveals workflows lazily) still gets a column so no card is hidden. `include` keeps a project the
 * filter names even when it has nothing in it yet.
 */
export function boardSections(items: readonly WorkItem[], containers: Record<string, WorkContainer>, include: ContainerRef | null = null): BoardSection[] {
  const byContainer = new Map<string, WorkItem[]>();
  for (const i of items) byContainer.set(containerKey(i.container), [...(byContainer.get(containerKey(i.container)) ?? []), i]);
  if (include && !byContainer.has(containerKey(include))) byContainer.set(containerKey(include), []);

  return [...byContainer.entries()]
    .map(([key, list]): BoardSection => {
      const container = containers[key];
      const workflow: Workflow = container?.workflow ?? { statuses: [], transitions: { kind: "any" } };
      const known = new Set(workflow.statuses.map((s) => s.id));
      const extra = new Map<string, StatusDef>();
      for (const i of list) if (!known.has(i.status.id)) extra.set(i.status.id, i.status);
      const statuses = [
        ...workflow.statuses,
        ...[...extra.values()].sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.name.localeCompare(b.name)),
      ];
      const columns = statuses.map((status) => ({ status, items: list.filter((i) => i.status.id === status.id) }));
      return { key, name: container?.name ?? key, code: container?.key ?? key, workflow: { ...workflow, statuses }, columns, count: list.length };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** A tracker that reveals moves per item leaves the graph empty; there the backend is the one to refuse a move. */
export const movesAreOpaque = (wf: Workflow) => wf.transitions.kind === "graph" && wf.transitions.moves.length === 0;

/**
 * The statuses an item may be dropped on. Where moves are opaque, `known` (what the tracker said for this item) is
 * the answer; until it arrives every other status is offered and the tracker refuses a move it can't make.
 */
export function targetsFor(wf: Workflow, item: WorkItem, known: readonly StatusDef[] | null = null): StatusDef[] {
  if (!movesAreOpaque(wf)) return nextStatuses(wf, item.status.id);
  return known ? [...known] : wf.statuses.filter((s) => s.id !== item.status.id);
}

export type DropVerdict = "same" | "ok" | "invalid";

/** Whether `item` may be dropped on the column for `statusId` in `section`. A card never leaves its own project. */
export function dropVerdict(item: WorkItem, section: BoardSection, statusId: string, known: readonly StatusDef[] | null = null): DropVerdict {
  if (containerKey(item.container) !== section.key) return "invalid";
  if (item.status.id === statusId) return "same";
  return targetsFor(section.workflow, item, known).some((s) => s.id === statusId) ? "ok" : "invalid";
}

export type DropPlan = { ok: true; to: StatusDef; intent: Intent } | { ok: false; reason: string | null };

export function planDrop(item: WorkItem, section: BoardSection, statusId: string, known: readonly StatusDef[] | null = null): DropPlan {
  const to = section.workflow.statuses.find((s) => s.id === statusId);
  const verdict = to ? dropVerdict(item, section, statusId, known) : "invalid";
  if (!to || verdict === "invalid") {
    const name = to?.name ?? "that column";
    return { ok: false, reason: `${section.name} doesn't allow ${item.status.name} → ${name}` };
  }
  if (verdict === "same") return { ok: false, reason: null };
  return { ok: true, to, intent: { type: "transition", item: item.item, to: to.id } };
}

export interface BulkMove {
  item: WorkItem;
  to: StatusDef;
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;

/** Where each item can go when everything should end up in the status called `name`; the rest can't get there. */
export function bulkMoves(items: readonly WorkItem[], workflowOf: (i: WorkItem) => Workflow | null, name: string): { moves: BulkMove[]; skipped: WorkItem[] } {
  const moves: BulkMove[] = [];
  const skipped: WorkItem[] = [];
  for (const item of items) {
    const wf = workflowOf(item);
    const to = wf && targetsFor(wf, item).find((s) => sameName(s.name, name));
    if (to) moves.push({ item, to });
    else skipped.push(item);
  }
  return { moves, skipped };
}

/** Status names at least one of the items can move to, with how many can, most reachable first. */
export function bulkTargets(items: readonly WorkItem[], workflowOf: (i: WorkItem) => Workflow | null): { name: string; count: number }[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const item of items) {
    const wf = workflowOf(item);
    if (!wf) continue;
    for (const s of targetsFor(wf, item)) {
      const seen = counts.get(s.name.toLowerCase());
      counts.set(s.name.toLowerCase(), { name: seen?.name ?? s.name, count: (seen?.count ?? 0) + 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The newest pending transition draft for each item, by `itemKey`. */
export function pendingMoves(proposals: Record<string, Proposal>): Map<string, Proposal> {
  const moves = new Map<string, Proposal>();
  const pending = Object.values(proposals)
    .filter((p) => p.state.type === "pending" && p.intent.type === "transition")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const p of pending) {
    const key = itemKey(targetOf(p.intent)!);
    if (!moves.has(key)) moves.set(key, p);
  }
  return moves;
}

/** The status a transition draft moves to, matched by id and then by name for trackers that name it. */
export function draftStatus(p: Proposal, wf: Workflow | null): StatusDef | null {
  if (p.intent.type !== "transition") return null;
  const to = p.intent.to;
  return wf?.statuses.find((s) => s.id === to) ?? wf?.statuses.find((s) => sameName(s.name, to)) ?? null;
}

/** Drafts a bulk approval may apply: pending transitions on the ticked items, never comments or anything else. */
export function approvableTransitions(pending: Map<string, Proposal>, marked: readonly string[]): Proposal[] {
  return marked.flatMap((k) => pending.get(k) ?? []);
}

/** Items that are blocked by an open item, judged against everything cached so a blocker outside the filter counts. */
export function blockedKeys(all: readonly WorkItem[]): Set<string> {
  const test = compileFilter({ type: "blocked" }, all, { me: [], now: 0, needsMe: new Set() });
  return new Set(all.filter(test).map((i) => itemKey(i.item)));
}

export interface AgeBucket {
  id: string;
  label: string;
  hint: string;
  /** Days without an update from which an item belongs here. */
  from: number;
}

export const AGE_BUCKETS: readonly AgeBucket[] = [
  { id: "fresh", label: "Fresh", hint: "Updated in the last 2 days", from: 0 },
  { id: "week", label: "This week", hint: "2 to 6 days quiet", from: 2 },
  { id: "stale", label: "Stale", hint: "7 to 13 days quiet", from: 7 },
  { id: "forgotten", label: "Forgotten", hint: "2 weeks or more", from: 14 },
];

export const daysQuiet = (item: WorkItem, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(item.updated).getTime()) / 86_400_000));

/** Finished work doesn't dry out. */
export const witherOf = (item: WorkItem, now: Date): WitherLevel => (item.status.category === "done" ? 0 : witherLevel(item.updated, now, WITHER_DAYS.ticket));

/** Open items in columns by how long they have been quiet, the quietest first within each. */
export function ageColumns(items: readonly WorkItem[], now: Date): { bucket: AgeBucket; items: WorkItem[] }[] {
  const open = items.filter((i) => i.status.category !== "done");
  return AGE_BUCKETS.map((bucket, at) => {
    const upTo = AGE_BUCKETS[at + 1]?.from ?? Infinity;
    const inside = open.filter((i) => daysQuiet(i, now) >= bucket.from && daysQuiet(i, now) < upTo);
    return { bucket, items: inside.sort((a, b) => a.updated.localeCompare(b.updated)) };
  });
}
