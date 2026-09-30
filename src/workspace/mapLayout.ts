import { containerKey, itemKey } from "../lib/filter";
import type { WorkCategory, WorkContainer, WorkItem, WorkLink } from "../types";

export const MAP_CAP = 300;

const SPACING = 34;
const GAP = 56;
const PAD = 40;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const CATEGORY_ORDER: Record<WorkCategory, number> = { active: 0, todo: 1, done: 2 };

export interface MapNode {
  key: string;
  item: WorkItem;
  cluster: string;
  x: number;
  y: number;
  r: number;
}

export interface MapCluster {
  key: string;
  label: string;
  /** The parent's ticket key, or the project code when the cluster is a project. */
  sub: string;
  /** Key of the parent item when the cluster is an epic or parent, so its label can open it. */
  parentKey: string | null;
  x: number;
  y: number;
  r: number;
  /** Counts cover every matching item, including those the cap hides. */
  done: number;
  total: number;
  shown: number;
}

export interface MapEdge {
  key: string;
  from: string;
  to: string;
  kind: WorkLink["kind"];
  d: string;
}

export interface MapLayout {
  clusters: MapCluster[];
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  shown: number;
  total: number;
}

const nodeRadius = (i: WorkItem) => 9 + Math.min(4, i.commentCount) * 1.5;

const byLabel = (a: { label: string; key: string }, b: { label: string; key: string }) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key);

interface Group {
  key: string;
  label: string;
  sub: string;
  parentKey: string | null;
  items: WorkItem[];
}

function groupItems(items: readonly WorkItem[], all: Record<string, WorkItem>, containers: Record<string, WorkContainer>): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, make: () => Omit<Group, "key" | "items">, item: WorkItem) => {
    const g = groups.get(key) ?? { key, ...make(), items: [] };
    g.items.push(item);
    groups.set(key, g);
  };
  for (const i of items) {
    if (i.parent) {
      const pk = itemKey(i.parent);
      const parent = all[pk];
      add(`parent:${pk}`, () => ({ label: parent?.title ?? i.parent!.key, sub: i.parent!.key, parentKey: pk }), i);
    } else {
      const ck = containerKey(i.container);
      const c = containers[ck];
      add(`project:${ck}`, () => ({ label: c?.name ?? ck, sub: c?.key ?? ck, parentKey: null }), i);
    }
  }
  return [...groups.values()].sort(byLabel);
}

function ring(index: number): { x: number; y: number } {
  const radius = SPACING * Math.sqrt(index + 0.5);
  const angle = index * GOLDEN;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function curve(a: MapNode, b: MapNode): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const sx = a.x + (dx / len) * a.r;
  const sy = a.y + (dy / len) * a.r;
  const ex = b.x - (dx / len) * (b.r + 3);
  const ey = b.y - (dy / len) * (b.r + 3);
  const mx = (sx + ex) / 2 - (ey - sy) * 0.16;
  const my = (sy + ey) / 2 + (ex - sx) * 0.16;
  const f = (n: number) => Math.round(n * 10) / 10;
  return `M${f(sx)} ${f(sy)} Q${f(mx)} ${f(my)} ${f(ex)} ${f(ey)}`;
}

/**
 * Deterministic map of `items`: one cluster per parent (or per project for parentless items), tickets on a spiral
 * inside it, clusters packed in rows, links drawn between tickets that are both shown. `all` supplies parent titles.
 * A parent that is itself matched and has matched children is the cluster, not a node. At most `cap` tickets are
 * placed, taken in the order given.
 */
export function layoutMap(items: readonly WorkItem[], all: Record<string, WorkItem>, containers: Record<string, WorkContainer>, cap = MAP_CAP): MapLayout {
  const parents = new Set(items.flatMap((i) => (i.parent ? [itemKey(i.parent)] : [])));
  const tickets = items.filter((i) => !parents.has(itemKey(i.item)));
  const kept = new Set(tickets.slice(0, Math.max(0, cap)).map((i) => itemKey(i.item)));

  const groups = groupItems(tickets, all, containers);
  const built = groups.map((g) => {
    const shown = g.items
      .filter((i) => kept.has(itemKey(i.item)))
      .sort((a, b) => CATEGORY_ORDER[a.status.category] - CATEGORY_ORDER[b.status.category] || a.item.key.localeCompare(b.item.key, undefined, { numeric: true }));
    const local = shown.map((item, idx) => ({ item, ...ring(idx) }));
    const reach = Math.max(0, ...local.map((n) => Math.hypot(n.x, n.y) + nodeRadius(n.item)));
    return { g, local, r: Math.max(56, reach + PAD) };
  });

  const area = built.reduce((sum, b) => sum + (2 * b.r + GAP) ** 2, 0);
  const rowWidth = Math.max(Math.sqrt(area) * 1.15, 2 * Math.max(0, ...built.map((b) => b.r)));
  const ordered = [...built].sort((a, b) => b.r - a.r || byLabel(a.g, b.g));

  const clusters: MapCluster[] = [];
  const nodes: MapNode[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let maxX = 0;
  for (const b of ordered) {
    const size = 2 * b.r;
    if (x > 0 && x + size > rowWidth) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    const cx = x + b.r;
    const cy = y + b.r;
    x += size + GAP;
    rowHeight = Math.max(rowHeight, size);
    maxX = Math.max(maxX, cx + b.r);
    clusters.push({
      key: b.g.key,
      label: b.g.label,
      sub: b.g.sub,
      parentKey: b.g.parentKey,
      x: cx,
      y: cy,
      r: b.r,
      done: b.g.items.filter((i) => i.status.category === "done").length,
      total: b.g.items.length,
      shown: b.local.length,
    });
    for (const n of b.local) nodes.push({ key: itemKey(n.item.item), item: n.item, cluster: b.g.key, x: cx + n.x, y: cy + n.y, r: nodeRadius(n.item) });
  }

  const at = new Map(nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const edges: MapEdge[] = [];
  for (const n of nodes) {
    for (const l of n.item.links) {
      const from = at.get(itemKey(l.from));
      const to = at.get(itemKey(l.to));
      if (!from || !to || from === to) continue;
      const key = `${from.key}>${to.key}:${l.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ key, from: from.key, to: to.key, kind: l.kind, d: curve(from, to) });
    }
  }
  edges.sort((a, b) => a.key.localeCompare(b.key));

  return { clusters, nodes, edges, width: Math.max(maxX, 1), height: Math.max(y + rowHeight, 1), shown: nodes.length, total: tickets.length };
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export const FIT: Viewport = { x: 0, y: 0, k: 1 };
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 4;

/** Scales by `factor` around the point (px, py), given in the same units as the viewport's translation, so that point stays put. */
export function zoomAt(vp: Viewport, px: number, py: number, factor: number): Viewport {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.k * factor));
  const ratio = k / vp.k;
  return { k, x: px - (px - vp.x) * ratio, y: py - (py - vp.y) * ratio };
}

export type Direction = "left" | "right" | "up" | "down";

/** The nearest node in `dir` from `from`, favouring nodes straight ahead over ones off to the side. */
export function neighbour(nodes: readonly MapNode[], from: string, dir: Direction): string | null {
  const origin = nodes.find((n) => n.key === from);
  if (!origin) return nodes[0]?.key ?? null;
  const vertical = dir === "up" || dir === "down";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  let best: { key: string; score: number } | null = null;
  for (const n of nodes) {
    const along = ((vertical ? n.y - origin.y : n.x - origin.x) || 0) * sign;
    if (n === origin || along <= 0) continue;
    const across = Math.abs(vertical ? n.x - origin.x : n.y - origin.y);
    const score = along + across * 2;
    if (!best || score < best.score || (score === best.score && n.key < best.key)) best = { key: n.key, score };
  }
  return best?.key ?? null;
}
