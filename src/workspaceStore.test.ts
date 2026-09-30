import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "./backend/mock";
import { itemRef, statusId } from "./backend/mockConnector";
import { parseQuery, describeFilter } from "./lib/filter";
import { useToasts } from "./workspace/toasts";
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
  knownMoves,
  nameOf,
  needsMeItems,
  needsWatchChoice,
  pendingDrafts,
  queryLookup,
  useWorkspace,
  watchOf,
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
    expect(keys(needsMeItems(s()))).toEqual(expect.arrayContaining(["CA-400", "CA-402", "CA-409", "DEVOPS-471", "DEVOPS-490", "SUP-12", "WEB-101", "WEB-108"]));
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
  it("re-reads what needs me when the cache changes", async () => {
    expect(s().needsMe.has("mock:CA-409")).toBe(true);
    backend.connector.comment(itemRef("CA-409"), "Looks fine");
    for (const e of backend.connector.eventsFor(itemRef("CA-409"))) backend.connector.setRead(e.id, true);
    await flush();
    expect(s().needsMe.has("mock:CA-409")).toBe(false);
  });

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

  it("takes the signed-in person from the backend, not from a snapshot", async () => {
    const other = new MockBackend();
    other.load = () => Promise.reject(new Error("the legacy snapshot must not be needed"));
    other.cacheMe = async () => ({ displayName: "Kim", accounts: [{ connectionId: "jira:site:kim", accountId: "kim" }] });
    await s().init(other);
    expect(s().me).toEqual([{ connectionId: "jira:site:kim", accountId: "kim" }]);
    expect(nameOf(s(), s().me[0])).toBe("Kim");
  });

  it("loads comments from the cache first and keeps them current when the count changes", async () => {
    const ref = itemRef("CA-409");
    expect(s().comments["mock:CA-409"]).toBeUndefined();
    await s().loadComments(ref);
    const before = s().comments["mock:CA-409"].length;
    expect(before).toBeGreaterThan(0);
    backend.connector.comment(ref, "one more");
    await flush();
    await flush();
    expect(s().comments["mock:CA-409"].length).toBe(before + 1);
  });

  it("asks where an item can move once per status and again after it moves", async () => {
    const item = s().items["mock:CA-402"];
    let asked = 0;
    const ask = backend.cacheTransitions.bind(backend);
    backend.cacheTransitions = (ref) => (asked++, ask(ref));
    const first = await s().loadMoves(item);
    expect(first?.length).toBeGreaterThan(0);
    await s().loadMoves(item);
    expect(asked).toBe(1);
    expect(knownMoves(s(), item)).toEqual(first);
    const moved = { ...item, status: first![0] };
    expect(knownMoves(s(), moved)).toBeNull();
    await s().loadMoves(moved);
    expect(asked).toBe(2);
  });

  it("answers null and shows a toast when the tracker can't say where an item can move", async () => {
    useToasts.getState().clear();
    backend.cacheTransitions = () => Promise.reject(new Error("offline"));
    expect(await s().loadMoves(s().items["mock:CA-402"])).toBeNull();
    expect(useToasts.getState().toasts[0].text).toMatch(/CA-402.*offline/);
  });

  it("refuses to draft a move to a status the tracker didn't offer, but drafts when it can't be asked", async () => {
    const item = s().items["mock:CA-402"];
    const wf = s().containers["mock:CA"].workflow;
    s().containers["mock:CA"].workflow = { ...wf, transitions: { kind: "graph", moves: [] } };
    const [offered, refused] = wf.statuses.filter((x) => x.id !== item.status.id);
    backend.cacheTransitions = async () => [{ name: offered.name, to: offered }];
    await expect(s().draftTransition(item.item, refused)).rejects.toThrow(/can't move to/);
    expect((await s().draftTransition(item.item, offered)).intent).toMatchObject({ type: "transition", to: offered.id });
    useWorkspace.setState({ moves: {} });
    backend.cacheTransitions = () => Promise.reject(new Error("offline"));
    expect((await s().draftTransition(item.item, refused)).intent).toMatchObject({ to: refused.id });
  });

  it("does not draft a move for an account that was replaced while the tracker was being asked", async () => {
    const item = s().items["mock:CA-402"];
    const wf = s().containers["mock:CA"].workflow;
    s().containers["mock:CA"].workflow = { ...wf, transitions: { kind: "graph", moves: [] } };
    const [offered] = wf.statuses.filter((x) => x.id !== item.status.id);
    let created = 0;
    const create = backend.proposalsCreate.bind(backend);
    backend.proposalsCreate = (...args) => ((created += 1), create(...args));
    backend.cacheTransitions = async () => {
      s().dispose();
      return [{ name: offered.name, to: offered }];
    };
    await expect(s().draftTransition(item.item, offered)).rejects.toThrow(/changed/);
    expect(created).toBe(0);
  });

  it("gives a request from the replaced workspace no answer, even when the new one asks the same question", async () => {
    const item = s().items["mock:CA-402"];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    backend.cacheTransitions = async () => (await gate, []);
    const old = s().loadMoves(item);
    const other = new MockBackend();
    await s().init(other);
    const fresh = s().loadMoves(s().items["mock:CA-402"]);
    release();
    expect(await old).toBeNull();
    expect(await fresh).not.toBeNull();
  });

  it("clears the syncing flag when a sync can't be started", async () => {
    useWorkspace.setState({ connections: [{ ...(await backend.connectionsList())[0], syncing: false }] });
    backend.syncNow = () => Promise.reject(new Error("offline"));
    await s().syncNow();
    expect(s().connections.every((c) => !c.syncing)).toBe(true);
  });

  it("holds the connection rows and reports a new sync failure once", async () => {
    useToasts.getState().clear();
    await flush();
    expect(s().connections[0].workspace).toBe("Sample data");
    const failing = { ...s().connections[0], error: "HTTP 503" };
    backend.connectionsList = async () => [failing];
    await s().refreshConnections();
    await s().refreshConnections();
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Couldn't sync: HTTP 503"]);
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

describe("the store and what is watched", () => {
  it("loads the watch settings with everything else", () => {
    expect(s().watch).toHaveLength(1);
    expect(s().watch[0]).toMatchObject({ connectionId: "mock", mode: "everything" });
    expect(needsWatchChoice(s())).toBe(false);
    expect(watchOf(s(), "mock")?.mode).toBe("everything");
    expect(watchOf(s(), "other")).toBeUndefined();
  });

  it("asks for a choice when the catalog is too big, and shows everything meanwhile", async () => {
    await s().init(new MockBackend({ catalogSize: 14 }));
    expect(needsWatchChoice(s())).toBe(true);
    expect(Object.keys(s().containers)).toHaveLength(14);
  });

  it("holds only watched items, containers and waiting-on-me after the person chooses, and follows later changes", async () => {
    const b = new MockBackend({ catalogSize: 14 });
    await s().init(b);
    const all = Object.keys(s().items).length;
    await b.watchSetMode("mock", "selected");
    await b.watchSetContainers("mock", [{ containerId: "CA", watched: true }]);
    await flush();
    expect(Object.keys(s().items).length).toBeLessThan(all);
    expect(allContainers(s()).map((c) => c.key)).toEqual(["CA"]);
    expect([...s().needsMe].every((k) => k.includes("CA-"))).toBe(true);
    expect(s().watch[0]).toMatchObject({ mode: "selected", needsChoice: false });
    expect(s().watch[0].watches.map((w) => w.key)).toEqual(["CA"]);

    await b.watchSetContainers("mock", [{ containerId: "WEB", watched: true }]);
    await flush();
    expect(allContainers(s()).map((c) => c.key)).toEqual(["CA", "WEB"]);
  });

  it("peeks at an item in an unwatched project without adding it to the store", async () => {
    const b = new MockBackend();
    await s().init(b);
    await b.watchSetMode("mock", "selected");
    await b.watchSetContainers("mock", [{ containerId: "CA", watched: true }]);
    await flush();
    const peeked = await s().peekItem(itemRef("WEB-101"));
    expect(peeked).toMatchObject({ unwatched: true, title: "Lazy-load swatch images" });
    expect(itemByRef(s(), itemRef("WEB-101"))).toBeUndefined();
    expect(await s().peekItem(itemRef("NOPE-1"))).toBeNull();
  });
});
