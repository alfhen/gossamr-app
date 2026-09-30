import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { ALL, itemKey } from "../lib/filter";
import type { WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { CapNotice, MapSvg, type MapSvgProps } from "./MapView";
import { FIT, labelRects, layoutMap, MAP_CAP, neighbour, placeKeyLabels, rectsOverlap, shownKey, textWidth, zoomAt, type MapLayout } from "./mapLayout";

const s = () => useWorkspace.getState();

beforeEach(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await s().init(new MockBackend());
});

const layout = (items: readonly WorkItem[] = itemsByFilter(s(), ALL), cap?: number) => layoutMap(items, s().items, s().containers, cap);

const fake = (n: number, over: (i: number) => Partial<WorkItem> = () => ({})): WorkItem[] => {
  const base = s().items["mock:DEVOPS-473"];
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    item: { connectionId: "mock", externalId: `x${i}`, key: `X-${i}` },
    parent: null,
    links: [],
    ...over(i),
  }));
};

describe("layoutMap", () => {
  it("is deterministic and independent of input order", () => {
    const items = itemsByFilter(s(), ALL);
    const a = layout(items);
    const b = layout([...items].reverse());
    expect(a.clusters.map((c) => [c.key, c.x, c.y])).toEqual(b.clusters.map((c) => [c.key, c.x, c.y]));
    expect(layout(items)).toEqual(a);
    const pos = (l: typeof a) => Object.fromEntries(l.nodes.map((n) => [n.key, [n.x, n.y]]));
    expect(pos(a)).toEqual(pos(b));
  });

  it("groups children under their epic and parentless items under their project", () => {
    const l = layout();
    const epic = l.clusters.find((c) => c.sub === "DEVOPS-470")!;
    expect(epic.label).toBe("Checkout resilience");
    const kids = l.nodes.filter((n) => n.cluster === epic.key);
    expect(kids.length).toBe(epic.shown);
    expect(kids.every((n) => n.item.parent && itemKey(n.item.parent) === "mock:DEVOPS-470")).toBe(true);
    expect(l.clusters.some((c) => c.key.startsWith("project:"))).toBe(true);
    expect(l.nodes.find((n) => n.key === "mock:DEVOPS-470")).toBeUndefined();
  });

  it("counts progress across the cluster", () => {
    const l = layout();
    const everything = itemsByFilter(s(), ALL);
    const parents = new Set(everything.flatMap((i) => (i.parent ? [itemKey(i.parent)] : [])));
    const tickets = everything.filter((i) => !parents.has(itemKey(i.item)));
    for (const c of l.clusters) {
      const members = tickets.filter((i) => (i.parent ? `parent:${itemKey(i.parent)}` : `project:${i.container.connectionId}:${i.container.externalId}`) === c.key);
      expect(c.total).toBe(members.length);
      expect(c.done).toBe(members.filter((i) => i.status.category === "done").length);
    }
  });

  it("keeps nodes inside their cluster and clusters apart", () => {
    const l = layout();
    const of = new Map(l.clusters.map((c) => [c.key, c]));
    for (const n of l.nodes) {
      const c = of.get(n.cluster)!;
      expect(Math.hypot(n.x - c.x, n.y - c.y) + n.r).toBeLessThanOrEqual(c.r);
    }
    for (const a of l.clusters) for (const b of l.clusters) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
  });

  it("routes each link between the shown tickets it joins, once", () => {
    const l = layout();
    const blocks = l.edges.filter((e) => e.kind === "blocks");
    expect(blocks.some((e) => e.from === "mock:DEVOPS-472" && e.to === "mock:DEVOPS-471")).toBe(true);
    const keys = l.edges.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const nodes = new Set(l.nodes.map((n) => n.key));
    expect(l.edges.every((e) => nodes.has(e.from) && nodes.has(e.to) && e.d.startsWith("M"))).toBe(true);
  });

  it("drops links whose other end is not shown", () => {
    const items = itemsByFilter(s(), ALL).filter((i) => i.item.key !== "DEVOPS-471");
    expect(layout(items).edges.some((e) => e.to === "mock:DEVOPS-471" || e.from === "mock:DEVOPS-471")).toBe(false);
  });

  it("caps the placed tickets and reports the total", () => {
    const items = fake(MAP_CAP + 40);
    const l = layout(items);
    expect(l.shown).toBe(MAP_CAP);
    expect(l.total).toBe(MAP_CAP + 40);
    expect(layout(items, 5).nodes.map((n) => n.item.item.key).sort()).toEqual(items.slice(0, 5).map((i) => i.item.key).sort());
  });

  it("handles nothing", () => {
    const l = layout([]);
    expect(l).toMatchObject({ nodes: [], clusters: [], edges: [], total: 0 });
  });

  it("lays out 500 tickets quickly", () => {
    const items = fake(500, (i) => ({
      parent: i % 3 ? { connectionId: "mock", externalId: `p${i % 17}`, key: `P-${i % 17}` } : null,
      links: i > 0 ? [{ from: { connectionId: "mock", externalId: `x${i}`, key: "" }, to: { connectionId: "mock", externalId: `x${i - 1}`, key: "" }, kind: "blocks" as const }] : [],
    }));
    const start = performance.now();
    const l = layoutMap(items, {}, {}, 500);
    expect(performance.now() - start).toBeLessThan(500);
    expect(l.nodes).toHaveLength(500);
    expect(l.edges.length).toBeGreaterThan(400);
  });
});

describe("cluster labels and packing", () => {
  const clear = (l: MapLayout) => {
    const rects = labelRects(l);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);
  };

  it("reserves label rectangles that never intersect each other or another cluster's circle", () => {
    for (const l of [layout(), stress()]) {
      clear(l);
      l.clusters.forEach((_c, i) => {
        l.clusters.forEach((o, j) => {
          if (i === j) return;
          const circle = { x: o.x - o.r, y: o.y - o.r, w: 2 * o.r, h: 2 * o.r };
          expect(rectsOverlap(labelRects(l)[i], circle)).toBe(false);
        });
      });
    }
  });

  it("keeps every label inside the layout bounds and its text inside the label width", () => {
    const l = stress();
    for (const c of l.clusters) {
      expect(c.box.x).toBeGreaterThanOrEqual(-0.001);
      expect(c.box.x + c.box.w).toBeLessThanOrEqual(l.width + 0.001);
      expect(c.box.y).toBeGreaterThanOrEqual(-0.001);
      expect(c.box.lines.length).toBeLessThanOrEqual(2);
      for (const line of c.box.lines) expect(textWidth(line, 13)).toBeLessThanOrEqual(c.box.w);
      expect(textWidth(c.box.sub, 10)).toBeLessThanOrEqual(c.box.w);
    }
  });

  it("cuts long titles with an ellipsis and leaves short ones whole", () => {
    const l = stress();
    const longOne = l.clusters.find((c) => c.label === long)!;
    expect(longOne.box.truncated).toBe(true);
    expect(longOne.box.lines[longOne.box.lines.length - 1].endsWith("…")).toBe(true);
    const short = l.clusters.find((c) => c.label === "Epic 1")!;
    expect(short.box).toMatchObject({ lines: ["Epic 1"], truncated: false });
    expect(short.box.sub).toMatch(/^E-1 · 0\/12 done$/);
  });

  it("sizes circles by content between sane bounds", () => {
    const l = stress();
    const r = (n: number) => l.clusters.find((c) => c.sub === `E-${n}`)!.r;
    expect(r(0)).toBeLessThan(45);
    expect(r(1)).toBeGreaterThan(r(2));
    expect(r(2)).toBeGreaterThan(r(0));
  });

  it("packs with consistent gutters and uses the space evenly", () => {
    const l = stress();
    const cells = l.clusters.map((c) => ({ cy: c.y, x: c.x - Math.max(c.r, c.box.w / 2), w: 2 * Math.max(c.r, c.box.w / 2) }));
    const rows = new Map<number, typeof cells>();
    for (const c of cells) rows.set(c.cy, [...(rows.get(c.cy) ?? []), c]);
    for (const row of rows.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)).toBeGreaterThanOrEqual(26 - 0.001);
    }
    const area = l.clusters.reduce((sum, c) => sum + Math.PI * c.r * c.r, 0);
    expect(area / (l.width * l.height)).toBeGreaterThan(0.25);
  });

  it("shapes the layout toward the requested aspect ratio", () => {
    const items = fake(120, (i) => ({ parent: { connectionId: "mock", externalId: `p${i % 24}`, key: `P-${i % 24}` } }));
    const wide = layoutMap(items, {}, {}, 300, 3);
    const square = layoutMap(items, {}, {}, 300, 1);
    expect(wide.width / wide.height).toBeGreaterThan(square.width / square.height);
  });

  it("is deterministic for the same input and stays clear with 500 tickets", () => {
    const items = fake(500, (i) => ({ title: `Ticket ${i} ${long}`, parent: { connectionId: "mock", externalId: `p${i % 40}`, key: `P-${i % 40}` } }));
    const a = layoutMap(items, {}, {}, 500);
    expect(layoutMap(items, {}, {}, 500)).toEqual(a);
    clear(a);
  });
});

describe("placeKeyLabels", () => {
  const dots = [
    { key: "a", x: 0, y: 0, r: 10 },
    { key: "b", x: 30, y: 0, r: 10 },
    { key: "c", x: 400, y: 0, r: 10 },
  ].map((d) => ({ ...d, cluster: "k", item: { ...s().items["mock:DEVOPS-473"], item: { connectionId: "mock", externalId: d.key, key: `KEY-${d.key}` } } }));

  it("never overlaps labels, and drops a colliding one unless forced", () => {
    const packed = [
      { ...dots[0] },
      { ...dots[1], x: 4, y: 26 },
    ];
    const out = placeKeyLabels(packed, ["a", "b"], new Set());
    const rects = [...out.values()];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i], rects[j])).toBe(false);
    const forced = placeKeyLabels(packed, ["a", "b"], new Set(["b"]));
    expect(forced.has("b")).toBe(true);
  });

  it("places by priority order", () => {
    const out = placeKeyLabels(dots, ["c", "a"], new Set());
    expect([...out.keys()]).toEqual(["c", "a"]);
  });
});

describe("viewport and keyboard", () => {
  it("zooms around a point so it stays fixed", () => {
    const vp = zoomAt({ x: 10, y: 20, k: 1 }, 100, 50, 2);
    expect(vp.k).toBe(2);
    expect((100 - vp.x) / vp.k).toBe(90);
    expect((50 - vp.y) / vp.k).toBe(30);
    expect(zoomAt(FIT, 0, 0, 1000).k).toBe(4);
    expect(zoomAt(FIT, 0, 0, 0.0001).k).toBe(0.4);
  });

  it("moves to the nearest node in a direction", () => {
    const nodes = layout().nodes;
    const from = nodes[0];
    for (const dir of ["left", "right", "up", "down"] as const) {
      const to = neighbour(nodes, from.key, dir);
      if (!to) continue;
      const n = nodes.find((x) => x.key === to)!;
      const moved = dir === "left" ? from.x - n.x : dir === "right" ? n.x - from.x : dir === "up" ? from.y - n.y : n.y - from.y;
      expect(moved).toBeGreaterThan(0);
    }
    expect(neighbour(nodes, "nope", "left")).toBe(nodes[0].key);
    expect(neighbour([], "a", "left")).toBeNull();
  });
});

  const long = "Harden the incognito-app against reload-storm traffic bursts (2026-09-21 incident follow-up)";
const stress = () => {
  const base = s().items["mock:DEVOPS-473"];
  const sizes = [1, 12, 2, 1, 7, 3, 1, 9, 2, 5, 1, 4, 1, 1, 6, 2];
  const all: Record<string, WorkItem> = {};
  const items: WorkItem[] = [];
  let n = 0;
  sizes.forEach((size, c) => {
    const parent = { connectionId: "mock", externalId: `E-${c}`, key: `E-${c}` };
    all[`mock:E-${c}`] = { ...base, item: parent, kind: "epic", title: c % 3 === 0 ? long : c % 3 === 1 ? `Epic ${c}` : "Customer Experience", parent: null, links: [] };
    for (let k = 0; k < size; k++) {
      const item = { connectionId: "mock", externalId: `T-${n}`, key: `T-${n}` };
      items.push({ ...base, item, parent, links: [], title: `Ticket ${n}` });
      n++;
    }
  });
  return layoutMap(items, all, {});
};

const props = (over: Partial<MapSvgProps> = {}): MapSvgProps => ({
  layout: layout(),
  viewport: FIT,
  selected: null,
  marked: [],
  focused: null,
  hovered: null,
  blocked: new Set(),
  needsMe: new Set(),
  now: new Date(),
  drafts: {},
  onNode: vi.fn(),
  onHover: vi.fn(),
  onCluster: vi.fn(),
  ...over,
});

const render = (p: MapSvgProps) => renderToStaticMarkup(<MapSvg {...p} />);

describe("MapSvg", () => {
  it("draws a labelled node per ticket, cluster labels with progress and the arrow marker", () => {
    const p = props();
    const out = render(p);
    expect((out.match(/data-node=/g) ?? []).length).toBe(p.layout.nodes.length);
    expect(out).toContain("Checkout resilience");
    expect(out).toMatch(/\d+\/\d+ done/);
    expect(out).toContain('aria-label="DEVOPS-473 ');
    expect(out).toContain('marker-end="url(#map-arrow)"');
  });

  it("colours by status category", () => {
    const out = render(props());
    expect(out).toContain("fill-ws-accent");
    expect(out).toContain("fill-ws-done");
    expect(out).toContain("fill-ws-ink3");
  });

  it("marks blocked tickets, draft tickets, the selection and marks", () => {
    const out = render(props({ blocked: new Set(["mock:DEVOPS-471"]), drafts: { "mock:DEVOPS-473": 1 }, selected: "mock:DEVOPS-473", marked: ["mock:DEVOPS-472"] }));
    expect(out).toContain("data-blocked");
    expect(out).toContain("data-draft");
    expect(out).toContain("blocked");
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("stroke-ws-pip");
    expect(out).toContain("stroke-ws-accent");
  });

  it("highlights the links of the hovered node and dims the rest", () => {
    const quiet = render(props());
    expect(quiet).not.toContain("data-lit");
    const out = render(props({ hovered: "mock:DEVOPS-472" }));
    expect((out.match(/data-lit/g) ?? []).length).toBeGreaterThan(0);
    expect(out).toContain('opacity="0.12"');
    expect(out).toContain("DEVOPS-472 ");
  });

  it("shows a focus ring and applies the viewport transform", () => {
    const out = render(props({ focused: "mock:DEVOPS-473", viewport: { x: 5, y: 6, k: 2 } }));
    expect(out).toContain("data-focus");
    expect(out).toContain("translate(5 6) scale(2)");
  });

  it("draws each cluster title in its reserved box with the full text as a tooltip", () => {
    const p = props();
    const out = render(p);
    expect((out.match(/data-cluster-label/g) ?? []).length).toBe(p.layout.clusters.length);
    expect(out).toContain("<title>Checkout resilience (DEVOPS-470)</title>");
  });

  it("writes ticket keys only once zoom makes them readable, always for the selection", () => {
    const far = render(props({ scale: 0.3 }));
    expect(far).not.toContain("data-key-label");
    expect(render(props({ scale: 0.3, selected: "mock:DEVOPS-473" }))).toContain(">DEVOPS-473</text>");
    const near = render(props({ scale: 1 }));
    expect((near.match(/data-key-label/g) ?? []).length).toBeGreaterThan(5);
    expect(near).not.toMatch(/>\d{3}<\/text>/);
  });

  it("shows the full title of a hovered ticket and of a hovered truncated cluster", () => {
    expect(render(props({ hovered: "mock:DEVOPS-473" }))).toContain("data-tip");
    const l = stress();
    const cut = l.clusters.find((c) => c.box.truncated);
    expect(cut).toBeDefined();
    expect(render(props({ layout: l, hoveredCluster: cut!.key }))).toContain("data-cluster-tip");
  });

  it("says when the cap hides tickets", () => {
    expect(renderToStaticMarkup(<CapNotice shown={300} total={412} />)).toContain("Showing 300 of 412 tickets. Narrow the filter");
    expect(renderToStaticMarkup(<CapNotice shown={4} total={4} />)).toBe("");
  });
});

describe("shownKey", () => {
  it("drops a focus key that is no longer displayed", () => {
    const nodes = [{ key: "a" }, { key: "b" }];
    expect(shownKey(nodes, "b")).toBe("b");
    expect(shownKey(nodes, "gone")).toBeNull();
    expect(shownKey(nodes, null)).toBeNull();
  });
});
