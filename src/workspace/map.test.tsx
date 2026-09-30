import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { ALL, itemKey } from "../lib/filter";
import type { WorkItem } from "../types";
import { itemsByFilter, useWorkspace } from "../workspaceStore";
import { CapNotice, MapSvg, type MapSvgProps } from "./MapView";
import { FIT, layoutMap, MAP_CAP, neighbour, shownKey, zoomAt } from "./mapLayout";

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
