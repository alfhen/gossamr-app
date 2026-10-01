import type { StatusDef, WorkCategory } from "../types";

/** Saved column order per project, as status ids keyed by `containerKey`. */
export type ColumnOrders = Record<string, string[]>;

const RANK: Record<WorkCategory, number> = { todo: 0, active: 1, done: 2 };

/** To do, then in progress, then done, each keeping the workflow's own order. */
export function defaultOrder(statuses: readonly StatusDef[]): StatusDef[] {
  return statuses
    .map((s, at) => ({ s, at }))
    .sort((a, b) => RANK[a.s.category] - RANK[b.s.category] || a.at - b.at)
    .map((x) => x.s);
}

/**
 * The statuses in the order `saved` asks for. A status the saved order doesn't know sits right after the status
 * before it in the default order, and a saved id with no status any more is dropped.
 */
export function applyOrder(statuses: readonly StatusDef[], saved: readonly string[] | undefined): StatusDef[] {
  const base = defaultOrder(statuses);
  if (!saved?.length) return base;
  const byId = new Map(base.map((s) => [s.id, s]));
  const out = [...new Set(saved)].flatMap((id) => byId.get(id) ?? []);
  const placed = new Set(out.map((s) => s.id));
  base.forEach((s, at) => {
    if (placed.has(s.id)) return;
    const before = base
      .slice(0, at)
      .reverse()
      .find((b) => placed.has(b.id));
    out.splice(before ? out.findIndex((o) => o.id === before.id) + 1 : 0, 0, s);
    placed.add(s.id);
  });
  return out;
}

/** `items` with the one at `from` moved so it ends up at index `to`. */
export function moveTo<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.min(Math.max(to, 0), next.length), 0, moved);
  return next;
}

/** Where a column dragged from `from` lands when dropped in the gap before index `gap` (`count` is the end). */
export const landingIndex = (from: number, gap: number) => (gap > from ? gap - 1 : gap);

/** The gap, 0 to `edges.length`, that a pointer at `x` is closest to, given each column's left and right edge. */
export function gapAt(x: number, edges: readonly { left: number; right: number }[]): number {
  const at = edges.findIndex((e) => x < (e.left + e.right) / 2);
  return at < 0 ? edges.length : at;
}

export const movedMessage = (name: string, at: number, count: number) => `${name} moved to position ${at + 1} of ${count}`;

/** The saved orders in a stored value, ignoring anything that isn't a list of strings. */
export function parseColumnOrders(raw: unknown): ColumnOrders {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([key, ids]) => (Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string") ? [[key, ids as string[]]] : [])),
  );
}
