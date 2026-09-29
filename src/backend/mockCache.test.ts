import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";

const keys = (items: { item: { key: string } }[]) => items.map((i) => i.item.key);

describe("the mock cache", () => {
  const backend = new MockBackend();

  it("holds every ticket as a work item, newest first", async () => {
    const snap = await backend.load();
    const all = await backend.cacheSearch({ type: "and", filters: [] });
    expect(all).toHaveLength(Object.keys(snap.tickets).length);
    const times = all.map((i) => i.updated);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("applies filters the way the real cache does", async () => {
    const mine = await backend.cacheSearch({ type: "mine" });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((i) => i.assignee?.accountId === "me")).toBe(true);

    const blocked = await backend.cacheSearch({ type: "and", filters: [{ type: "open" }, { type: "status", name: "blocked" }] });
    expect(keys(blocked)).toContain("CA-418");

    const parent = await backend.cacheSearch({ type: "parent", item: { connectionId: "mock", externalId: "CA-400", key: "CA-400" } });
    expect(keys(parent)).toContain("CA-412");
  });

  it("reads one item and lists containers with statuses", async () => {
    const ref = { connectionId: "mock", externalId: "CA-412", key: "CA-412" };
    expect((await backend.cacheItem(ref))?.title).toMatch(/parallel workers/);
    expect(await backend.cacheItem({ ...ref, externalId: "NOPE-1" })).toBeNull();
    const containers = await backend.cacheContainers();
    expect(containers.map((c) => c.key)).toContain("CA");
    expect((await backend.cacheWorkflow({ connectionId: "mock", externalId: "CA" }))?.statuses.length).toBeGreaterThan(0);
  });

  it("tells listeners when the cache changes", async () => {
    const seen: string[] = [];
    const off = backend.onCacheChanged((c) => seen.push(c.connectionId));
    await backend.syncNow();
    off();
    await backend.syncNow();
    expect(seen).toEqual(["mock"]);
  });
});
