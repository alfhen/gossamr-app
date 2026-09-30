import { containerKey, itemKey } from "../lib/filter";
import type { WorkCategory, WorkContainer, WorkItem, WorkLink } from "../types";

export const MAP_CAP = 300;

const SPACING = 32;
const GAP_X = 26;
const GAP_Y = 18;
const PAD = 22;
const MIN_R = 38;
const LABEL_H = 56;
const LABEL_MIN_W = 150;
const LABEL_MAX_W = 230;
const TITLE_SIZE = 13;
const SUB_SIZE = 10;
const TITLE_LINES = 2;
const DEFAULT_ASPECT = 1.7;
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

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClusterLabel extends Rect {
  /** The title wrapped to at most two lines and cut with an ellipsis, each line fitting `w`. */
  lines: string[];
  /** The key and progress line, cut to fit `w`. */
  sub: string;
  truncated: boolean;
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
  /** Where the title and progress line go, and the space the layout reserved for them. */
  box: ClusterLabel;
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
  const radius = SPACING * Math.sqrt(index);
  const angle = index * GOLDEN;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

const NARROW = new Set([..." .,:;'|!iljtfI1()[]/"]);
const WIDE = new Set([..."MWmw@%"]);

/** Approximate rendered width of bold sans text; the layout has no DOM to measure with. */
export function textWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += NARROW.has(ch) ? 0.32 : WIDE.has(ch) ? 0.92 : ch >= "A" && ch <= "Z" ? 0.72 : ch.charCodeAt(0) > 0x2e80 ? 1 : 0.58;
  return em * size;
}

function cut(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text;
  const chars = [...text];
  let n = chars.length;
  while (n > 0 && textWidth(`${chars.slice(0, n).join("").trimEnd()}…`, size) > width) n--;
  return `${chars.slice(0, n).join("").trimEnd()}…`;
}

function wrap(text: string, width: number, size: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let i = 0;
  for (; i < words.length && lines.length < maxLines; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (textWidth(next, size) <= width) line = next;
    else if (line) {
      lines.push(line);
      line = "";
      i--;
    } else {
      lines.push(cut(words[i], width, size));
    }
  }
  if (line && lines.length < maxLines) {
    lines.push(line);
    line = "";
  }
  const rest = [line, ...words.slice(i)].filter(Boolean).join(" ");
  if (rest && lines.length) lines[lines.length - 1] = cut(`${lines[lines.length - 1]} ${rest}`, width, size);
  return lines.length ? lines : [""];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface Cell {
  cellW: number;
  above: number;
  below: number;
}

interface Row<T extends Cell> {
  cells: T[];
  width: number;
  above: number;
  y: number;
}

function shelves<T extends Cell>(cells: readonly T[], limit: number) {
  const rows: Row<T>[] = [];
  let row: Row<T> | null = null;
  for (const c of cells) {
    if (!row || row.width + GAP_X + c.cellW > limit) {
      row = { cells: [], width: -GAP_X, above: 0, y: 0 };
      rows.push(row);
    }
    row.cells.push(c);
    row.width += GAP_X + c.cellW;
    row.above = Math.max(row.above, c.above);
  }
  let y = 0;
  let width = 0;
  for (const r of rows) {
    r.y = y;
    y += r.above + Math.max(...r.cells.map((c) => c.below)) + GAP_Y;
    width = Math.max(width, r.width);
  }
  return { rows, width, height: Math.max(0, y - GAP_Y) };
}

/** Shelf packing in the order given, trying a spread of row widths and keeping the one closest to `aspect` with the least dead space. */
function pack<T extends Cell>(cells: readonly T[], aspect: number) {
  if (!cells.length) return { rows: [] as Row<T>[], width: 0, height: 0 };
  const widest = Math.max(...cells.map((c) => c.cellW));
  const total = cells.reduce((sum, c) => sum + c.cellW + GAP_X, 0);
  const used = cells.reduce((sum, c) => sum + c.cellW * (c.above + c.below), 0);
  let best: { score: number; packed: ReturnType<typeof shelves<T>> } | null = null;
  for (let i = 0; i <= 32; i++) {
    const packed = shelves(cells, widest + ((total - widest) * i) / 32);
    const fill = used / Math.max(1, packed.width * packed.height);
    const score = Math.abs(Math.log(packed.width / Math.max(1, packed.height) / aspect)) + (1 - fill);
    if (!best || score < best.score - 1e-9) best = { score, packed };
  }
  return best!.packed;
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
 * inside it, clusters packed in centred rows with room reserved for their labels, links drawn between tickets that are both shown. `all` supplies parent titles.
 * A parent that is itself matched and has matched children is the cluster, not a node. At most `cap` tickets are
 * placed, taken in the order given.
 */
export function layoutMap(items: readonly WorkItem[], all: Record<string, WorkItem>, containers: Record<string, WorkContainer>, cap = MAP_CAP, aspect = DEFAULT_ASPECT): MapLayout {
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
    const r = Math.max(MIN_R, Math.ceil(reach + PAD));
    const labelW = clamp(2 * r + 24, LABEL_MIN_W, LABEL_MAX_W);
    const cellW = Math.max(2 * r, labelW);
    return { g, local, r, labelW, cellW, above: LABEL_H + r, below: r };
  });

  const { rows, width, height } = pack(
    [...built].sort((a, b) => b.above + b.below - (a.above + a.below) || byLabel(a.g, b.g)),
    aspect,
  );

  const clusters: MapCluster[] = [];
  const nodes: MapNode[] = [];
  for (const row of rows) {
    let x = (width - row.width) / 2;
    for (const b of row.cells) {
      const cx = x + b.cellW / 2;
      const cy = row.y + row.above;
      x += b.cellW + GAP_X;
      const done = b.g.items.filter((i) => i.status.category === "done").length;
      const total = b.g.items.length;
      const lines = wrap(b.g.label, b.labelW, TITLE_SIZE, TITLE_LINES);
      const sub = cut(`${b.g.sub} · ${done}/${total} done${b.local.length < total ? ` · ${b.local.length} shown` : ""}`, b.labelW, SUB_SIZE);
      clusters.push({
        key: b.g.key,
        label: b.g.label,
        box: { x: cx - b.labelW / 2, y: cy - b.r - LABEL_H, w: b.labelW, h: LABEL_H - 4, lines, sub, truncated: lines.join(" ") !== b.g.label.replace(/\s+/g, " ").trim() },
        sub: b.g.sub,
        parentKey: b.g.parentKey,
        x: cx,
        y: cy,
        r: b.r,
        done,
        total,
        shown: b.local.length,
      });
      for (const n of b.local) nodes.push({ key: itemKey(n.item.item), item: n.item, cluster: b.g.key, x: cx + n.x, y: cy + n.y, r: nodeRadius(n.item) });
    }
  }

  const at = new Map(nodes.map((n) => [n.key, n]));
  const seen = new Set<string>();
  const edges: MapEdge[] = [];
  for (const n of nodes) {
    for (const l of n.item.links) {
      const from = at.get(itemKey(l.from));
      const to = at.get(itemKey(l.to));
      if (!from || !to || from === to || Math.hypot(to.x - from.x, to.y - from.y) < from.r + to.r + 8) continue;
      const key = `${from.key}>${to.key}:${l.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ key, from: from.key, to: to.key, kind: l.kind, d: curve(from, to) });
    }
  }
  edges.sort((a, b) => a.key.localeCompare(b.key));

  return { clusters, nodes, edges, width: Math.max(width, 1), height: Math.max(height, 1), shown: nodes.length, total: tickets.length };
}

export const rectsOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The reserved label rectangle of every cluster, which never intersect. */
export const labelRects = (layout: MapLayout): Rect[] => layout.clusters.map((c) => ({ x: c.box.x, y: c.box.y, w: c.box.w, h: c.box.h }));

export const keyLabelRect = (n: MapNode, below: boolean): Rect => {
  const w = n.item.item.key.length * 6.2 + 6;
  return { x: n.x - w / 2, y: below ? n.y + n.r + 2 : n.y - n.r - 14, w, h: 12 };
};

/**
 * Where each ticket key is written: below its dot, else above it, else nowhere. `order` lists the keys by priority;
 * `forced` keys are always written, below their dot. A label never covers a dot or another label unless forced.
 */
export function placeKeyLabels(nodes: readonly MapNode[], order: readonly string[], forced: ReadonlySet<string>): Map<string, Rect> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const placed = new Map<string, Rect>();
  const taken: Rect[] = [];
  const hitsDot = (r: Rect, self: MapNode) => nodes.some((o) => o !== self && r.x < o.x + o.r + 2 && o.x - o.r - 2 < r.x + r.w && r.y < o.y + o.r + 2 && o.y - o.r - 2 < r.y + r.h);
  for (const key of order) {
    const n = byKey.get(key);
    if (!n || placed.has(key)) continue;
    const options = [keyLabelRect(n, true), keyLabelRect(n, false)];
    const free = options.find((r) => !hitsDot(r, n) && !taken.some((t) => rectsOverlap(r, t)));
    const pick = free ?? (forced.has(key) ? options[0] : null);
    if (!pick) continue;
    placed.set(key, pick);
    taken.push(pick);
  }
  return placed;
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

export function shownKey(nodes: readonly { key: string }[], key: string | null): string | null {
  return key !== null && nodes.some((n) => n.key === key) ? key : null;
}
