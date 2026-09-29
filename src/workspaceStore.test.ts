import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./backend/mock";
import { itemRef, statusId } from "./backend/mockConnector";
import { parseQuery, describeFilter } from "./lib/filter";
import {
  allContainers,
  childrenOf,
  containerWorkflow,
  draftCounts,
  draftsForItem,
  eventsFor,
  itemByRef,
  itemsByFilter,
  itemsInContainer,
  nameOf,
  needsMeItems,
  pendingDrafts,
  queryLookup,
  useWorkspace,
  workflowOfItem,
} from "./workspaceStore";

const s = () => useWorkspace.getState();
const keys = (items: { item: { key: string } }[]) => items.map((i) => i.item.key);
let backend: MockBackend;

beforeEach(async () => {
  backend = new MockBackend();
  backend.seedSampleDrafts();
  await s().init(backend);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("workspace store loading", () => {
  it("holds items, containers with workflows, drafts and identity by key", () => {
    expect(s().status).toBe("ready");
    expect(Object.keys(s().items).length).toBeGreaterThanOrEqual(40);
    expect(s().items["mock:DEVOPS-471"].title).toMatch(/Retry failed payment/);
    expect(allContainers(s()).map((c) => c.key)).toEqual(["CA", "DEVOPS", "SUP", "WEB"]);
    expect(pendingDrafts(s()).length).toBeGreaterThanOrEqual(4);
    expect(s().me).toEqual([{ connectionId: "mock", accountId: "me" }]);
    expect(nameOf(s(), { connectionId: "mock", accountId: "klara" })).toBe("Klara Nyberg");
    expect(nameOf(s(), { connectionId: "mock", accountId: "me" })).toBe("Alf Henderson");
    expect(nameOf(s(), null)).toBe("Unassigned");
  });

  it("reports a failed load and rethrows it", async () => {
    const broken = new MockBackend();
    broken.cacheContainers = () => Promise.reject(new Error("offline"));
    await expect(s().init(broken)).rejects.toThrow("offline");
    expect(s().status).toBe("error");
    expect(s().error).toMatch(/offline/);
  });

  it("empties out on dispose and stops listening", async () => {
    s().dispose();
    expect(Object.keys(s().items)).toEqual([]);
    backend.connector.comment(itemRef("WEB-108"), "late");
    await flush();
    expect(Object.keys(s().items)).toEqual([]);
  });
});

describe("workspace selectors", () => {
  it("filters on the client with the same semantics as the backend", async () => {
    const filters = [
      { type: "mine" as const },
      { type: "and" as const, filters: [{ type: "open" as const }, { type: "stale" as const, days: 7 }] },
      { type: "blocked" as const },
      { type: "text" as const, text: "swatch" },
      { type: "label" as const, label: "BUG" },
    ];
    for (const f of filters) expect(keys(itemsByFilter(s(), f))).toEqual(keys(await backend.cacheSearch(f)));
  });

  it("finds what needs me, and children and items per project", () => {
    expect(keys(needsMeItems(s())).sort()).toEqual(["CA-409", "DEVOPS-471", "SUP-12", "WEB-101"]);
    expect(keys(childrenOf(s(), itemRef("CA-400"))).sort()).toEqual(["CA-401", "CA-402", "CA-403", "CA-404", "CA-406"]);
    const web = itemsInContainer(s(), { connectionId: "mock", externalId: "WEB" });
    expect(web.every((i) => i.container.externalId === "WEB")).toBe(true);
    expect(web.length).toBe(9);
  });

  it("gives each item its own project's workflow", () => {
    const cards = itemByRef(s(), itemRef("CA-402"))!;
    expect(workflowOfItem(s(), cards)?.statuses.map((x) => x.name)).toContain("Scheduled");
    expect(containerWorkflow(s(), { connectionId: "mock", externalId: "SUP" })?.transitions.kind).toBe("any");
    expect(containerWorkflow(s(), { connectionId: "mock", externalId: "NOPE" })).toBeNull();
  });

  it("lists the drafts about an item and counts them per item", () => {
    const drafts = draftsForItem(s(), itemRef("DEVOPS-471"));
    expect(drafts.map((p) => p.intent.type).sort()).toEqual(["comment", "transition"]);
    expect(draftsForItem(s(), itemRef("DEVOPS-490"))).toEqual([]);
    expect(draftCounts(s())["mock:DEVOPS-471"]).toBe(2);
    expect(draftsForItem(s(), itemRef("DEVOPS-471"), ["applied"])).toEqual([]);
  });

  it("resolves a typed query against its own names and describes it as chips", () => {
    const lookup = queryLookup(s());
    const f = parseQuery("assignee:jonas project:devops stale:7 label:bug", lookup);
    expect(keys(itemsByFilter(s(), f))).toEqual(["DEVOPS-473"]);
    const mine = parseQuery("assignee:me status:\"in review\"", lookup);
    expect(keys(itemsByFilter(s(), mine))).toEqual(["DEVOPS-471"]);
    expect(describeFilter(f, lookup)).toBe("Assignee: Jonas Berg, Project: DevOps, No update for 7d+, Label: bug");
  });
});

describe("workspace store refresh", () => {
  it("re-reads items when the cache changes", async () => {
    const before = s().items["mock:CA-405"].status.name;
    expect(before).toBe("Backlog");
    backend.connector.transition(itemRef("CA-405"), statusId("CA", "Copy"));
    await flush();
    expect(s().items["mock:CA-405"].status.name).toBe("Copy");
  });

  it("re-reads drafts when they change, and approving moves the item through the connector", async () => {
    const move = draftsForItem(s(), itemRef("CA-409"))[0];
    await s().approve(move.id);
    await flush();
    expect(s().proposals[move.id].state.type).toBe("applied");
    expect(draftsForItem(s(), itemRef("CA-409"))).toEqual([]);
    expect(s().items["mock:CA-409"].status.name).toBe("Design");
    const skip = draftsForItem(s(), itemRef("SUP-12"))[0];
    await s().skip(skip.id);
    expect(pendingDrafts(s()).some((p) => p.id === skip.id)).toBe(false);
  });

  it("loads events on demand and keeps them current afterwards", async () => {
    expect(eventsFor(s(), itemRef("WEB-108"))).toEqual([]);
    await s().loadEvents(itemRef("WEB-108"));
    const before = eventsFor(s(), itemRef("WEB-108")).length;
    backend.connector.comment(itemRef("WEB-108"), "one more");
    await flush();
    expect(eventsFor(s(), itemRef("WEB-108")).length).toBe(before + 1);
    expect(eventsFor(s(), itemRef("DEVOPS-471"))).toEqual([]);
  });

  it("derives me from the current containers on every refresh", async () => {
    const wider = new MockBackend();
    const listContainers = wider.connector.listContainers.bind(wider.connector);
    await s().init(wider);
    expect(s().me).toHaveLength(1);
    wider.connector.listContainers = () => [
      ...listContainers(),
      { ...listContainers()[0], ref: { connectionId: "other", externalId: "X" } },
    ];
    await s().refresh();
    expect(s().me.map((m) => m.connectionId).sort()).toEqual(["mock", "other"]);
  });

  it("drops a decision that lands after the workspace moved to another backend", async () => {
    const draft = draftsForItem(s(), itemRef("SUP-12"))[0];
    const pending = s().approve(draft.id);
    await s().init(new MockBackend());
    await pending;
    expect(s().proposals[draft.id]).toBeUndefined();
  });

  it("ignores a refresh that lands after the backend was replaced", async () => {
    const other = new MockBackend();
    other.connector.comment(itemRef("WEB-108"), "x");
    const slow = s().refresh();
    await s().init(other);
    await slow;
    expect(s().backend).toBe(other);
  });
});
