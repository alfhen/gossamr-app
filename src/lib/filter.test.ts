import { describe, expect, it } from "vitest";
import type { ItemRef, WorkContainer, WorkFilter, WorkItem } from "../types";
import fixtures from "./filter.fixtures.json";
import {
  ALL,
  and,
  describeFilter,
  filterChips,
  itemKey,
  matchesFilter,
  parseQuery,
  plainText,
  selectItems,
  type FilterContext,
  type QueryLookup,
} from "./filter";

const items = fixtures.items as unknown as WorkItem[];
const ctx: FilterContext = {
  me: fixtures.me,
  now: Date.parse(fixtures.now),
  needsMe: new Set((fixtures.needsMe as ItemRef[]).map(itemKey)),
};
const ids = (list: WorkItem[]) => list.map((i) => i.item.externalId);

describe("filter engine, on the fixtures the Rust side also runs", () => {
  it.each(fixtures.cases)("$name", ({ filter, expect: want }) => {
    expect(ids(selectItems(filter as WorkFilter, items, ctx))).toEqual(want);
  });

  it("matchesFilter agrees with selectItems", () => {
    for (const c of fixtures.cases) {
      const f = c.filter as WorkFilter;
      const hits = items.filter((i) => matchesFilter(f, i, items, ctx));
      expect(ids(hits)).toEqual(c.expect);
    }
  });

  it("flattens documents to plain text without a trailing newline", () => {
    expect(plainText(items[7].body)).toBe("Notes\nping @Ada\nmake deploy");
  });
});

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function randomItems(seed: number, n: number): WorkItem[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const statuses = [
    { id: "a", name: "Todo", category: "todo" },
    { id: "b", name: "Doing", category: "active" },
    { id: "c", name: "Done", category: "done" },
  ] as const;
  const ref = (i: number): ItemRef => ({ connectionId: "c", externalId: String(i), key: `K-${i}` });
  return Array.from({ length: n }, (_, i) => ({
    ...items[0],
    item: ref(i),
    title: pick(["alpha", "Beta", "gamma"]),
    body: { blocks: [] },
    status: pick([...statuses]),
    assignee: pick([null, { connectionId: "c", accountId: "me" }, { connectionId: "c", accountId: "x" }]),
    labels: pick([[], ["Api"], ["api", "ui"]]),
    parent: r() < 0.3 ? ref(Math.floor(r() * n)) : null,
    updated: new Date(ctx.now - Math.floor(r() * 20) * 86_400_000).toISOString(),
    links: r() < 0.3 ? [{ from: ref(i), to: ref(Math.floor(r() * n)), kind: "blocks" as const }] : [],
  }));
}

describe("filter engine properties", () => {
  const filters: WorkFilter[] = [
    { type: "mine" },
    { type: "open" },
    { type: "unassigned" },
    { type: "blocked" },
    { type: "stale", days: 5 },
    { type: "label", label: "API" },
    { type: "text", text: "ALPHA" },
    { type: "category", category: "active" },
  ];

  for (const seed of [1, 2, 3, 4, 5]) {
    const data = randomItems(seed, 40);
    const run = (f: WorkFilter) => new Set(ids(selectItems(f, data, ctx)));

    it(`and is the intersection, and the empty and is everything (seed ${seed})`, () => {
      expect(run(ALL).size).toBe(data.length);
      for (const a of filters) {
        for (const b of filters) {
          const want = [...run(a)].filter((k) => run(b).has(k));
          expect([...run({ type: "and", filters: [a, b] })].sort()).toEqual(want.sort());
        }
      }
    });

    it(`open and done partition the items, and stale, blocked and mine only narrow (seed ${seed})`, () => {
      const done = run({ type: "category", category: "done" });
      const open = run({ type: "open" });
      expect(open.size + done.size).toBe(data.length);
      expect([...open].some((k) => done.has(k))).toBe(false);
      for (const f of [{ type: "stale", days: 3 }, { type: "blocked" }] as WorkFilter[]) {
        expect([...run(f)].every((k) => open.has(k))).toBe(true);
      }
      expect([...run({ type: "stale", days: 10 })].every((k) => run({ type: "stale", days: 5 }).has(k))).toBe(true);
    });

    it(`item-local filters give the same answer on a subset, and a missing blocker keeps blocking (seed ${seed})`, () => {
      const half = data.slice(0, 20);
      for (const f of filters.filter((f) => f.type !== "blocked")) {
        const inHalf = ids(selectItems(f, half, ctx));
        expect(inHalf).toEqual(ids(selectItems(f, data, ctx)).filter((k) => Number(k) < 20));
      }
      const open = half.find((i) => i.status.category !== "done");
      if (!open) return;
      const gone = { connectionId: "c", externalId: "gone", key: "K-gone" };
      const linked = { ...open, links: [...open.links, { from: gone, to: open.item, kind: "blocks" as const }] };
      expect(ids(selectItems({ type: "blocked" }, [linked], ctx))).toEqual([open.item.externalId]);
    });
  }
});

const container = (key: string, name: string): WorkContainer => ({
  ref: { connectionId: "c", externalId: key },
  key,
  name,
  workflow: { statuses: [], transitions: { kind: "any" } },
});

const lookup: QueryLookup = {
  containers: [container("WEB", "Webshop"), container("OPS", "Operations")],
  people: [
    { ref: { connectionId: "c", accountId: "sam" }, name: "Sam Holt" },
    { ref: { connectionId: "c", accountId: "maya" }, name: "Maya Lindqvist" },
  ],
  me: [{ connectionId: "c", accountId: "me" }],
  items: [items[0]],
};

describe("parseQuery", () => {
  it("reads prefixed and plain words", () => {
    expect(parseQuery("assignee:me status:\"In Review\" project:web label:api stale blocked", lookup)).toEqual({
      type: "and",
      filters: [
        { type: "mine" },
        { type: "status", name: "In Review" },
        { type: "container", container: { connectionId: "c", externalId: "WEB" } },
        { type: "label", label: "api" },
        { type: "stale", days: 5 },
        { type: "blocked" },
      ],
    });
  });

  it("resolves people by account or any part of the name, and projects by key or name", () => {
    expect(parseQuery("assignee:sam", lookup)).toEqual({ type: "assignee", person: { connectionId: "c", accountId: "sam" } });
    expect(parseQuery("assignee:Lindqvist", lookup)).toEqual({ type: "assignee", person: { connectionId: "c", accountId: "maya" } });
    expect(parseQuery("project:Operations", lookup)).toEqual({ type: "container", container: { connectionId: "c", externalId: "OPS" } });
  });

  it("takes a day count for stale and a category, and resolves an epic by key", () => {
    expect(parseQuery("stale:9", lookup)).toEqual({ type: "stale", days: 9 });
    expect(parseQuery("category:active", lookup)).toEqual({ type: "category", category: "active" });
    expect(parseQuery("epic:eng-1", lookup)).toEqual({ type: "parent", item: items[0].item });
  });

  it("keeps a word it does not know as a text search instead of dropping it", () => {
    expect(parseQuery("assignee:nobody project:none checkout \"slow page\"", lookup)).toEqual({
      type: "and",
      filters: [
        { type: "text", text: "assignee:nobody" },
        { type: "text", text: "project:none" },
        { type: "text", text: "checkout" },
        { type: "text", text: "slow page" },
      ],
    });
  });

  it("gives everything for an empty box and a single filter for one word", () => {
    expect(parseQuery("  ", lookup)).toEqual(ALL);
    expect(parseQuery("unassigned", lookup)).toEqual({ type: "unassigned" });
    expect(parseQuery("needs:me", lookup)).toEqual({ type: "needsMe" });
  });
});

describe("chips", () => {
  it("flattens nested filters into one chip each, and and() flattens the other way", () => {
    const f = and({ type: "open" }, and({ type: "mine" }, { type: "blocked" }));
    expect(filterChips(f)).toEqual([{ type: "open" }, { type: "mine" }, { type: "blocked" }]);
    expect(filterChips(ALL)).toEqual([]);
  });

  it("describes each filter in words", () => {
    const d = (f: WorkFilter) => describeFilter(f, lookup);
    expect(d({ type: "assignee", person: { connectionId: "c", accountId: "sam" } })).toBe("Assignee: Sam Holt");
    expect(d({ type: "container", container: { connectionId: "c", externalId: "WEB" } })).toBe("Project: Webshop");
    expect(d({ type: "stale", days: 5 })).toBe("No update for 5d+");
    expect(d({ type: "category", category: "active" })).toBe("Status: in progress");
    expect(d(parseQuery("mine blocked", lookup))).toBe("Assigned to me, Blocked");
    expect(d(ALL)).toBe("Everything");
  });
});
