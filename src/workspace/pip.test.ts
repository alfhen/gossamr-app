import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { mockAsk, mockPipEvents, scriptPip } from "../backend/mockPip";
import type { AskRequest, ClaudeEvent } from "../backend/claude";
import { ALL } from "../lib/filter";
import type { ScreenContext, WorkEvent } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useClaude } from "../claudeStore";
import { handlePipView } from "./PipExtras";
import { commentNotes, historyNotes, linkRows } from "./peekLogic";
import { LARGE_LIST, isStillFiltered, nudgeFor, usePip } from "./pipStore";
import { buildScreenContext, screenLine } from "./screenContext";
import { activeTab, loadTabs, useTabs, type Tab } from "./tabsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const ws = () => useWorkspace.getState();
const blank: ScreenContext = { view: null, item: null, filter: null, selection: [] };

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useTabs.setState(loadTabs());
  useTabs.getState().setFilter(ALL);
  useTabs.getState().select(null);
  usePip.setState({ filtered: null, dismissed: [] });
  await ws().init(new MockBackend());
});

const screen = (tab: Tab, selected: string | null = null, marked: string[] = []) => ({
  tab,
  shown: Object.values(ws().items).slice(0, 12),
  items: ws().items,
  containers: ws().containers,
  selected,
  marked,
});

describe("screen context", () => {
  it("names the view, the project and the count", () => {
    const devops = Object.values(ws().containers).find((c) => c.key === "DEVOPS")!;
    const tab: Tab = { id: "t", title: null, filter: { type: "container", container: devops.ref }, view: "board" };
    expect(screenLine(screen(tab))).toBe("Board · DEVOPS · 12 items");
    expect(screenLine({ ...screen({ ...tab, filter: ALL, view: "list" }), shown: [Object.values(ws().items)[0]] })).toBe("List · All projects · 1 item");
  });

  it("carries the open item, the filter and the ticked cards, with their real connection", () => {
    const filter = { type: "mine" } as const;
    const tab: Tab = { id: "t", title: null, filter, view: "list" };
    const ctx = buildScreenContext(screen(tab, "mock:DEVOPS-471", ["mock:DEVOPS-471", "mock:DEVOPS-473", "mock:GONE-1"]));
    expect(ctx.item).toEqual(ws().items["mock:DEVOPS-471"].item);
    expect(ctx.item?.connectionId).toBe("mock");
    expect(ctx.filter).toEqual(filter);
    expect(ctx.selection.map((r) => r.key)).toEqual(["DEVOPS-471", "DEVOPS-473"]);
  });

  it("leaves the filter out when nothing narrows the view, and the item out when it is gone", () => {
    const ctx = buildScreenContext(screen({ id: "t", title: null, filter: ALL, view: "list" }, "mock:NOPE-1"));
    expect(ctx).toMatchObject({ filter: null, item: null, selection: [] });
  });
});

describe("Claude-driven filters", () => {
  it("applies the filter to the active tab and undoes it, restoring the name the tab had", () => {
    const tabs = useTabs.getState();
    tabs.saveView("Mine");
    const before = activeTab(useTabs.getState());
    usePip.getState().applyFilter({ type: "stale", days: 5 }, "Stale tickets");
    const during = activeTab(useTabs.getState());
    expect(during.filter).toEqual({ type: "stale", days: 5 });
    expect(during.title).toBeNull();
    expect(isStillFiltered(usePip.getState().filtered, during)).toBe(true);

    usePip.getState().undoFilter();
    expect(activeTab(useTabs.getState())).toMatchObject({ filter: before.filter, title: "Mine" });
    expect(usePip.getState().filtered).toBeNull();
  });

  it("stops describing the tab once the person changes the filter by hand", () => {
    usePip.getState().applyFilter({ type: "blocked" }, "Blocked");
    useTabs.getState().addFilter({ type: "mine" });
    expect(isStillFiltered(usePip.getState().filtered, activeTab(useTabs.getState()))).toBe(false);
  });

  it("ignores a filter from a run this pane didn't ask for", () => {
    const turn = { requestId: "mine", prompt: "", steps: [], text: "", status: "running" as const, error: null };
    useClaude.setState({ byTicket: { workspace: { turns: [turn], sessionId: null, cwd: null } } });
    handlePipView({ requestId: "drawer", filter: { type: "blocked" }, note: "x" });
    expect(activeTab(useTabs.getState()).filter).toEqual(ALL);
    handlePipView({ requestId: "mine", filter: { type: "blocked" }, note: "x" });
    expect(activeTab(useTabs.getState()).filter).toEqual({ type: "blocked" });
    useClaude.setState({ byTicket: {} });
  });

  it("undoes on the tab it filtered even after another tab became active", () => {
    const first = activeTab(useTabs.getState()).id;
    usePip.getState().applyFilter({ type: "blocked" }, "Blocked");
    useTabs.getState().openTab();
    usePip.getState().undoFilter();
    expect(useTabs.getState().tabs.find((t) => t.id === first)!.filter).toEqual(ALL);
    expect(activeTab(useTabs.getState()).filter).toEqual(ALL);
  });
});

describe("nudges", () => {
  it("suggests a filter for an empty filtered view or a large list, and stays quiet once dismissed", () => {
    expect(nudgeFor(0, 1, [])?.kind).toBe("empty-filter");
    expect(nudgeFor(0, 0, [])).toBeNull();
    expect(nudgeFor(LARGE_LIST, 0, [])?.text).toContain("filter tasks in this view");
    expect(nudgeFor(LARGE_LIST - 1, 0, [])).toBeNull();
    expect(nudgeFor(LARGE_LIST, 0, ["large-list"])).toBeNull();
  });

  it("remembers what was dismissed", () => {
    usePip.getState().dismiss("large-list");
    usePip.getState().dismiss("large-list");
    expect(usePip.getState().dismissed).toEqual(["large-list"]);
    expect(JSON.parse(localStorage.getItem("gossamr-pip")!)).toEqual({ dismissed: ["large-list"] });
  });
});

describe("scripted Pip", () => {
  it("filters for stale, blocked and mine, refining the current filter", () => {
    expect(scriptPip("show stale", blank).filter?.filter).toEqual({ type: "stale", days: 5 });
    expect(scriptPip("what is blocked?", blank).filter?.filter).toEqual({ type: "blocked" });
    expect(scriptPip("show mine", blank).filter?.filter).toEqual({ type: "mine" });
    const refined = scriptPip("show stale", { ...blank, filter: { type: "mine" } }).filter?.filter;
    expect(refined).toEqual({ type: "and", filters: [{ type: "mine" }, { type: "stale", days: 5 }] });
  });

  it("drafts a comment on the open item and nothing without one", () => {
    const item = { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" };
    const s = scriptPip("draft a comment", { ...blank, item });
    expect(s.draft?.intent).toMatchObject({ type: "comment", item });
    expect(scriptPip("draft a comment", blank).draft).toBeNull();
  });

  it("streams the answer, proposes the draft as Pip and emits the filter", async () => {
    const backend = new MockBackend();
    const item = { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" };
    const events: ClaudeEvent[] = [];
    const views: unknown[] = [];
    const off = [mockPipEvents.on((_, e) => events.push(e)), mockPipEvents.onView((_, f, n) => views.push([f, n]))];
    const req = (prompt: string): AskRequest => ({ requestId: prompt, prompt, sessionId: null, cwd: null, context: { ...blank, item } });

    await mockAsk(req("draft a comment"), backend, 0);
    const drafts = await backend.proposalsList();
    expect(drafts.filter((p) => p.origin.type === "chat" && p.origin.requestId === "draft a comment")).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["started", "tool", "text", "done"]));
    expect(events[events.length - 1]).toMatchObject({ type: "done", ok: true });

    await mockAsk(req("show stale"), backend, 0);
    expect(views).toEqual([[{ type: "stale", days: 5 }, "Tickets untouched for 5 days or more"]]);
    off.forEach((f) => f());
  });
});

describe("peek logic", () => {
  it("shows links from both sides of a link", () => {
    const all = ws().items;
    const blocker = linkRows(all["mock:DEVOPS-473"], all);
    expect(blocker.map((r) => [r.kind, r.ref.key])).toContainEqual(["blockedBy", "DEVOPS-490"]);
    const blocked = linkRows(all["mock:DEVOPS-490"], all);
    expect(blocked.map((r) => [r.kind, r.ref.key])).toContainEqual(["blocks", "DEVOPS-473"]);
    expect(blocker.find((r) => r.ref.key === "DEVOPS-490")?.title).toBe(all["mock:DEVOPS-490"].title);
  });

  it("splits events into comments oldest first and history newest first", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 1, 0, m)).toISOString();
    const ev = (id: string, kind: WorkEvent["kind"], m: number, payload: unknown): WorkEvent => ({
      id,
      connectionId: "mock",
      at: at(m),
      kind,
      subject: { type: "item", item: { connectionId: "mock", externalId: "X-1", key: "X-1" } },
      actor: { connectionId: "mock", accountId: "sam" },
      payload,
    });
    const events = [ev("c2", "commentAdded", 5, { text: "later" }), ev("s", "statusChanged", 3, { from: "To Do", to: "Done" }), ev("c1", "commentAdded", 1, { text: "first" }), ev("empty", "commentAdded", 2, {})];
    const name = (a: string | null) => (a === "sam" ? "Sam" : "Nobody");
    expect(commentNotes(events, name).map((n) => [n.who, n.text])).toEqual([["Sam", "first"], ["Sam", "later"]]);
    expect(historyNotes(events, name).map((n) => n.text)).toEqual(["moved it To Do → Done"]);
  });
});
