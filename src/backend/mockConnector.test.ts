import { describe, expect, it } from "vitest";
import { itemKey } from "../lib/filter";
import { canMove, nextStatuses, shortestPath } from "../lib/workflow";
import { MockBackend } from "./mock";
import { MockConnector, containerRef, itemRef, statusId } from "./mockConnector";

const NOW = Date.parse("2026-06-30T12:00:00Z");
const keys = (items: { item: { key: string } }[]) => items.map((i) => i.item.key);

describe("the mock connector's data", () => {
  const c = new MockConnector(NOW);
  const all = c.search({ type: "and", filters: [] });

  it("has several projects with a spread of items", () => {
    expect(c.listContainers().map((x) => x.key)).toEqual(["DEVOPS", "CA", "WEB", "SUP"]);
    expect(all.length).toBeGreaterThanOrEqual(40);
    expect(new Set(all.map((i) => i.kind))).toEqual(new Set(["epic", "story", "task", "bug"]));
    expect(all.some((i) => i.labels.length)).toBe(true);
    expect(all.some((i) => i.assignee === null)).toBe(true);
  });

  it("keeps every parent, link end and status inside the data", () => {
    const known = new Set(all.map((i) => itemKey(i.item)));
    for (const i of all) {
      if (i.parent) expect(known.has(itemKey(i.parent)), `${i.item.key} parent`).toBe(true);
      for (const l of i.links) expect(known.has(itemKey(l.to)) && known.has(itemKey(l.from))).toBe(true);
      const wf = c.workflow(i.container)!;
      expect(wf.statuses.map((s) => s.id)).toContain(i.status.id);
    }
  });

  it("mixes fresh, ageing, stale, blocked and waiting-on-me items", () => {
    expect(c.search({ type: "stale", days: 7 }).length).toBeGreaterThan(3);
    expect(c.search({ type: "stale", days: 3 }).length).toBeGreaterThan(c.search({ type: "stale", days: 7 }).length);
    expect(keys(c.search({ type: "blocked" }))).toEqual(expect.arrayContaining(["DEVOPS-471", "DEVOPS-473", "CA-404"]));
    expect(keys(c.search({ type: "needsMe" }))).toEqual(expect.arrayContaining(["CA-400", "CA-402", "CA-409", "DEVOPS-471", "DEVOPS-490", "SUP-12", "WEB-101", "WEB-108"]));
  });

  it("stops needing me once I reply", () => {
    expect(keys(c.search({ type: "needsMe" }))).toContain("CA-409");
    c.comment(itemRef("CA-409"), "Looks fine");
    for (const e of c.eventsFor(itemRef("CA-409"))) c.setRead(e.id, true);
    expect(keys(c.search({ type: "needsMe" }))).not.toContain("CA-409");
  });

  it("needs me while an event from someone else is unread, and stops once it is read", () => {
    const events = c.eventsFor(itemRef("DEVOPS-493")).filter((e) => e.actor && e.actor.accountId !== c.me.accountId);
    expect(keys(c.search({ type: "needsMe" }))).toContain("DEVOPS-493");
    for (const e of events) c.setRead(e.id, true);
    expect(keys(c.search({ type: "needsMe" }))).not.toContain("DEVOPS-493");
    c.setRead(events[0].id, false);
    expect(keys(c.search({ type: "needsMe" }))).toContain("DEVOPS-493");
  });

  it("records events and comments per item, newest first", () => {
    const events = c.eventsFor(itemRef("DEVOPS-471"));
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["itemCreated", "statusChanged", "commentAdded"]));
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort().reverse());
    expect(c.item(itemRef("DEVOPS-471"))?.commentCount).toBe(7);
    expect(c.eventsFor(itemRef("NOPE-1"))).toEqual([]);
  });
});

describe("workflows differ per project", () => {
  const c = new MockConnector(NOW);
  const wf = (key: string) => c.workflow(containerRef(key))!;

  it("gives each project its own statuses and categories", () => {
    const names = (key: string) => wf(key).statuses.map((s) => s.name);
    expect(names("DEVOPS")).toContain("Blocked");
    expect(names("CA")).toEqual(["Backlog", "Copy", "Design", "QA", "Scheduled", "Sent"]);
    expect(names("WEB")).toContain("Code review");
    expect(names("SUP")).toContain("Waiting on customer");
    for (const k of ["DEVOPS", "CA", "WEB", "SUP"]) {
      expect(wf(k).statuses.filter((s) => s.category === "done")).toHaveLength(1);
      expect(wf(k).statuses[0].category).toBe("todo");
    }
    const ids = c.listContainers().flatMap((x) => x.workflow.statuses.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("restricts moves where the project has a graph and allows any where it does not", () => {
    expect(wf("CA").transitions.kind).toBe("graph");
    expect(wf("SUP").transitions.kind).toBe("any");
    expect(canMove(wf("CA"), statusId("CA", "Backlog"), statusId("CA", "Copy"))).toBe(true);
    expect(canMove(wf("CA"), statusId("CA", "Backlog"), statusId("CA", "QA"))).toBe(false);
    expect(nextStatuses(wf("CA"), statusId("CA", "Sent"))).toEqual([]);
    expect(nextStatuses(wf("SUP"), statusId("SUP", "New")).map((s) => s.name)).toEqual(["Investigating", "Waiting on customer", "Resolved"]);
  });

  it("only uses statuses of its own project in a graph", () => {
    for (const k of ["DEVOPS", "CA", "WEB"]) {
      const w = wf(k);
      const own = new Set(w.statuses.map((s) => s.id));
      if (w.transitions.kind !== "graph") throw new Error("graph expected");
      for (const m of w.transitions.moves) expect(own.has(m.from) && own.has(m.to)).toBe(true);
    }
  });

  it("finds the shortest path through a graph and none where none exists", () => {
    const path = shortestPath(wf("CA"), statusId("CA", "Backlog"), statusId("CA", "Sent"));
    expect(path?.map((s) => s.name)).toEqual(["Copy", "Design", "QA", "Scheduled", "Sent"]);
    expect(shortestPath(wf("CA"), statusId("CA", "Sent"), statusId("CA", "Copy"))).toBeNull();
    expect(shortestPath(wf("SUP"), statusId("SUP", "New"), statusId("SUP", "Resolved"))?.map((s) => s.name)).toEqual(["Resolved"]);
  });

  it("refuses a transition its workflow doesn't allow and applies one it does", () => {
    const local = new MockConnector(NOW);
    const changes: string[] = [];
    const watched = new MockConnector(NOW, (x) => changes.push(x.connectionId));
    expect(() => local.transition(itemRef("CA-405"), statusId("CA", "QA"))).toThrow(/can't move from Backlog to QA/);
    expect(() => local.transition(itemRef("CA-405"), statusId("WEB", "Testing"))).toThrow(/no such status/);
    expect(local.item(itemRef("CA-405"))?.status.name).toBe("Backlog");
    watched.transition(itemRef("CA-405"), statusId("CA", "Copy"));
    expect(watched.item(itemRef("CA-405"))?.status.name).toBe("Copy");
    expect(watched.eventsFor(itemRef("CA-405"))[0].kind).toBe("statusChanged");
    expect(changes).toEqual(["mock"]);
    local.transition(itemRef("SUP-11"), statusId("SUP", "Resolved"));
    expect(local.item(itemRef("SUP-11"))?.status.category).toBe("done");
  });

  it("creates subtasks in the first status of the parent's project", () => {
    const local = new MockConnector(NOW);
    const [a, b] = local.createSubtasks(itemRef("CA-400"), ["one", "two"]);
    expect(a.key).not.toBe(b.key);
    expect(local.item(a)).toMatchObject({ title: "one", parent: itemRef("CA-400"), status: { name: "Backlog" }, assignee: null });
    expect(keys(local.search({ type: "parent", item: itemRef("CA-400") }))).toContain(a.key);
  });
});

describe("through the mock backend", () => {
  it("reads the connector and announces changes", async () => {
    const backend = new MockBackend();
    const seen: string[] = [];
    backend.onCacheChanged((c) => seen.push(c.connectionId));
    expect((await backend.cacheContainers()).map((x) => x.key)).toContain("SUP");
    expect((await backend.cacheItem(itemRef("WEB-108")))?.title).toBe("Size guide modal");
    expect(await backend.cacheItem(itemRef("NOPE-1"))).toBeNull();
    expect((await backend.cacheWorkflow(containerRef("WEB")))?.statuses).toHaveLength(5);
    expect((await backend.cacheEvents(itemRef("SUP-12"))).length).toBeGreaterThan(0);
    expect((await backend.cachePeople()).map((p) => p.accountId)).toContain("klara");
    backend.connector.comment(itemRef("WEB-108"), "hi");
    expect(seen).toEqual(["mock"]);
  });

  it("starts with no drafts and seeds Pip's on request, then applies them through the connector", async () => {
    const backend = new MockBackend();
    expect(await backend.proposalsList()).toEqual([]);
    backend.seedSampleDrafts();
    const drafts = await backend.proposalsList();
    expect(drafts.length).toBeGreaterThanOrEqual(4);
    expect(drafts.every((p) => p.state.type === "pending" && p.createdBy === "pip")).toBe(true);

    const move = drafts.find((p) => p.intent.type === "transition" && p.intent.item.key === "CA-409")!;
    const done = await backend.proposalsApprove(move.id);
    expect(done.state.type).toBe("applied");
    expect((await backend.cacheItem(itemRef("CA-409")))?.status.name).toBe("Design");

    const subtasks = drafts.find((p) => p.intent.type === "subtasks")!;
    const applied = await backend.proposalsApprove(subtasks.id);
    expect(applied.created).toHaveLength(3);
    expect((await backend.cacheItem(applied.created[0]))?.parent?.key).toBe("WEB-108");
  });

  it("keeps the current screens' snapshot untouched", async () => {
    const snap = await new MockBackend().load();
    expect(Object.keys(snap.tickets)).toContain("CA-412");
    expect(Object.keys(snap.tickets)).not.toContain("SUP-10");
  });
});
