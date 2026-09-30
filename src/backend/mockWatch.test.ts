import { describe, expect, it, vi } from "vitest";
import type { WorkFilter } from "../types";
import { MockBackend } from "./mock";
import { containerRef, itemRef, MockConnector } from "./mockConnector";

const keys = (items: { item: { key: string } }[]) => items.map((i) => i.item.key);
const ALL: WorkFilter = { type: "and", filters: [] };
const CONNECTION = "mock";
const projectsOf = (items: { container: { externalId: string } }[]) => [...new Set(items.map((i) => i.container.externalId))].sort();

async function selected(b: MockBackend, watched: string[]) {
  await b.watchSetMode(CONNECTION, "selected");
  await b.watchSetContainers(CONNECTION, watched.map((containerId) => ({ containerId, watched: true })));
}

describe("the mock catalog", () => {
  it("defaults to the four sample projects, watched whole without asking", async () => {
    const b = new MockBackend();
    expect((await b.cacheContainers()).map((c) => c.key)).toEqual(["DEVOPS", "CA", "WEB", "SUP"]);
    const [state] = await b.watchGet();
    expect([state.mode, state.needsChoice]).toEqual(["everything", false]);
  });

  it("grows to any size with quiet projects, and a catalog over 12 waits for a choice", async () => {
    const b = new MockBackend({ catalogSize: 14 });
    const containers = await b.cacheContainers();
    expect(containers).toHaveLength(14);
    expect(containers[13].key).toBe("P14");
    expect(containers[13].workflow.statuses.length).toBeGreaterThan(1);
    const [state] = await b.watchGet();
    expect([state.mode, state.needsChoice, state.catalogSize]).toEqual(["unset", true, 13]);
    expect(projectsOf(await b.cacheSearch(ALL))).toEqual(["CA", "DEVOPS", "SUP", "WEB"]);

    const twelve = await new MockBackend({ catalogSize: 12 }).watchGet();
    expect([twelve[0].mode, twelve[0].needsChoice]).toEqual(["everything", false]);
    const thirteen = await new MockBackend({ catalogSize: 13 }).watchGet();
    expect([thirteen[0].mode, thirteen[0].needsChoice]).toEqual(["unset", true]);
  });

  it("never lists fewer projects than hold sample items", async () => {
    expect(await new MockBackend({ catalogSize: 1 }).cacheContainers()).toHaveLength(4);
  });

  it("pages and searches the catalog", async () => {
    const b = new MockBackend({ catalogSize: 120 });
    const first = await b.watchCatalog(CONNECTION, "");
    expect([first.containers.length, first.next]).toEqual([50, "50"]);
    const last = await b.watchCatalog(CONNECTION, "", "100");
    expect([last.containers.length, last.next]).toEqual([20, null]);
    const found = await b.watchCatalog(CONNECTION, "p10");
    expect(found.containers.map((c) => c.key)).toEqual(["P10", "P100", "P101", "P102", "P103", "P104", "P105", "P106", "P107", "P108", "P109"]);
    expect((await b.watchCatalog(CONNECTION, "devops")).containers[0].watched, "unset still follows everything").toBe(true);
    await selected(b, ["CA"]);
    expect((await b.watchCatalog(CONNECTION, "devops")).containers[0].watched).toBe(false);
    expect((await b.watchCatalog(CONNECTION, "campaigns")).containers[0].watched).toBe(true);
  });
});

describe("scoping the mock's reads to what is watched", () => {
  it("shows everything until the person chooses, and only watched projects after", async () => {
    const b = new MockBackend({ catalogSize: 14 });
    const before = await b.cacheSearch(ALL);
    expect(before.length).toBeGreaterThanOrEqual(40);
    await selected(b, ["CA"]);
    const scoped = await b.cacheSearch(ALL);
    expect(projectsOf(scoped)).toEqual(["CA"]);
    expect((await b.cacheContainers()).map((c) => c.key)).toEqual(["CA"]);
    expect(projectsOf(await b.cacheSearch(ALL, { includeUnwatched: true }))).toEqual(["CA", "DEVOPS", "SUP", "WEB"]);
    expect((await b.cacheContainers({ includeUnwatched: true })).length).toBe(14);
  });

  it("limits needs-me, the feed and its unread count", async () => {
    const b = new MockBackend();
    const everything = keys(await b.cacheSearch({ type: "needsMe" }));
    expect(everything.some((k) => k.startsWith("WEB"))).toBe(true);
    const feedAll = (await b.cacheFeed({ limit: 200 })).entries;
    await selected(b, ["CA"]);
    expect(keys(await b.cacheSearch({ type: "needsMe" })).every((k) => k.startsWith("CA-"))).toBe(true);
    const feed = (await b.cacheFeed({ limit: 200 })).entries;
    expect(feed.length).toBeLessThan(feedAll.length);
    expect(feed.every((e) => e.item.key.startsWith("CA-"))).toBe(true);
    expect((await b.cacheFeed({ limit: 200, includeUnwatched: true })).entries).toHaveLength(feedAll.length);
    expect(await b.cacheFeedUnread()).toBe((await b.cacheFeed({ unreadOnly: true, limit: 200 })).entries.length);
  });

  it("reads an unwatched item live, flagged, and a watched one from the cache", async () => {
    const b = new MockBackend();
    await selected(b, ["CA"]);
    const peeked = await b.peekItem(itemRef("WEB-101"));
    expect(peeked?.unwatched).toBe(true);
    expect((await b.cacheItem(itemRef("WEB-101")))?.unwatched).toBe(true);
    expect((await b.cacheItem(itemRef("CA-402")))?.unwatched).toBeUndefined();
    expect((await b.peekItem(itemRef("CA-402")))?.unwatched).toBe(false);
    expect(await b.peekItem(itemRef("NOPE-1"))).toBeNull();
  });
});

describe("the mock's watch settings", () => {
  it("unwatching is soft, so watching again restores depth and pin", async () => {
    const b = new MockBackend({ catalogSize: 14 });
    await b.watchSetMode(CONNECTION, "selected");
    await b.watchSetContainers(CONNECTION, [{ containerId: "WEB", watched: true, depth: "whole", pinned: true, source: "footprint" }]);
    let [state] = await b.watchGet();
    expect(state.watches[0]).toMatchObject({ key: "WEB", name: "Webshop", depth: "whole", pinned: true, source: "footprint", unwatchedAt: null });
    expect(state.watches[0].cachedItems).toBeGreaterThan(5);

    await b.watchSetContainers(CONNECTION, [{ containerId: "WEB", watched: false }]);
    [state] = await b.watchGet();
    expect(state.watches[0].unwatchedAt).not.toBeNull();
    expect(await b.cacheContainers()).toEqual([]);

    await b.watchSetContainers(CONNECTION, [{ containerId: "WEB", watched: true }]);
    [state] = await b.watchGet();
    expect(state.watches[0]).toMatchObject({ unwatchedAt: null, depth: "whole", pinned: true });
  });

  it("only watches a project when asked to, not when pinning one it doesn't watch", async () => {
    const b = new MockBackend({ catalogSize: 14 });
    await b.watchSetMode(CONNECTION, "selected");
    await b.watchSetContainers(CONNECTION, [{ containerId: "WEB", pinned: true }]);
    expect((await b.watchGet())[0].watches).toEqual([]);
  });

  it("announces a change", async () => {
    const b = new MockBackend();
    const seen = vi.fn();
    const off = b.onWatchChanged(seen);
    await b.watchSetMode(CONNECTION, "selected");
    expect(seen).toHaveBeenCalledWith({ connectionId: CONNECTION });
    off();
    await b.watchSetContainers(CONNECTION, [{ containerId: "CA", watched: true }]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("suggests from where the person is involved, and finds work assigned outside what they watch", async () => {
    const b = new MockBackend();
    const suggestions = await b.watchSuggestions();
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
    expect(suggestions[0].assigned).toBeGreaterThan(0);
    expect(suggestions.map((f) => f.assigned)).toEqual([...suggestions.map((f) => f.assigned)].sort((a, c) => c - a));
    expect(await b.watchUnwatchedAssigned()).toEqual([]);

    await selected(b, ["CA"]);
    const strays = await b.watchUnwatchedAssigned();
    expect(strays.map((s) => s.container.externalId).sort()).toEqual(["DEVOPS", "SUP", "WEB"]);
    expect(strays.find((s) => s.container.externalId === "SUP")?.keys).toEqual(["SUP-12"]);
    await b.watchDismissAssigned(CONNECTION, "SUP");
    expect((await b.watchUnwatchedAssigned()).map((s) => s.container.externalId)).not.toContain("SUP");
    expect((await b.watchGet())[0].watches.map((w) => w.key), "a suggestion never watches anything").toEqual(["CA"]);
  });
});

describe("the connector on its own", () => {
  it("keeps its old behaviour when nothing asks for a scope", () => {
    const c = new MockConnector(Date.parse("2026-06-30T12:00:00Z"));
    expect(c.listContainers().map((x) => x.key)).toEqual(["DEVOPS", "CA", "WEB", "SUP"]);
    expect(c.has(itemRef("CA-402"))).toBe(true);
    expect(c.workflow(containerRef("CA"))).not.toBeNull();
  });
});
