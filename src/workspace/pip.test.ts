import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { mockAsk, mockPipEvents, scriptPip } from "../backend/mockPip";
import { claude, type AskRequest, type ClaudeEvent } from "../backend/claude";
import { ALL } from "../lib/filter";
import type { ScreenContext, WorkEvent } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useClaude } from "../claudeStore";
import { askPip } from "./askPip";
import { handlePipView } from "./PipExtras";
import { escapeCancelsTurn } from "./PipPane";
import { usePipHome } from "./pipHomeStore";
import { useRuns } from "./runsStore";
import { useToasts } from "./toasts";
import { commentNotes, historyNotes, linkRows } from "./peekLogic";
import { NUDGE_GAP_MS, NUDGE_DWELL_MS, LARGE_LIST, nudgeCandidates, nudgeDelay, pickNudge, type NudgeScene } from "./nudges";
import { isStillFiltered, usePip } from "./pipStore";
import { buildScreenContext, screenLine } from "./screenContext";
import { activeTab, loadTabs, useTabs, type Route, type Tab } from "./tabsStore";

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
  usePip.setState({ filtered: null, applied: {}, dismissed: [], seen: [], nudge: null, lastNudgeAt: 0, pinned: null, quote: null, prefill: null });
  await ws().init(new MockBackend());
});

const screen = (tab: Tab, selected: string | null = null, marked: string[] = [], route: Route = "workspace") => ({
  route,
  activity: { chip: "all" as const, container: null },
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

describe("screen context by route", () => {
  const tab: Tab = { id: "t", title: null, filter: { type: "mine" }, view: "board" };

  it("says Settings on Settings, with no open item, filter or ticked cards", () => {
    const s = screen(tab, "mock:DEVOPS-471", ["mock:DEVOPS-471", "mock:DEVOPS-473"], "settings");
    expect(screenLine(s)).toBe("Settings");
    expect(buildScreenContext(s)).toEqual({ view: "Settings", item: null, filter: null, selection: [] });
  });

  it("says Pip home on Pip home, never the workspace tab's view, and sends no board filter or ticked cards", () => {
    const s = screen(tab, null, ["mock:DEVOPS-471"], "pip");
    expect(screenLine(s)).toBe("Pip home");
    expect(buildScreenContext(s)).toEqual({ view: "Pip home", item: null, filter: null, selection: [] });
  });

  it("names the runs on Agents, sends no board filter or ticked cards, and keeps a ticket peeked over it", () => {
    const agents = { openRun: null, waiting: 0, runs: [], filters: { lane: "all", repo: "all", ticket: "all" } as const, earlierOpen: false, now: 0 };
    const s = { ...screen(tab, "mock:DEVOPS-471", ["mock:DEVOPS-471", "mock:DEVOPS-473"], "agents"), agents };
    const ctx = buildScreenContext(s);
    expect(ctx.view).toBe("Agents · All · 0 runs");
    expect(ctx.item?.key).toBe("DEVOPS-471");
    expect(ctx).toMatchObject({ filter: null, selection: [] });
  });

  it("names the feed filter and project on Activity and keeps the open item", () => {
    const devops = Object.values(ws().containers).find((c) => c.key === "DEVOPS")!;
    const s = { ...screen(tab, "mock:DEVOPS-471", ["mock:DEVOPS-473"], "activity"), activity: { chip: "mentions" as const, container: devops.ref } };
    expect(screenLine(s)).toBe("Activity · Mentions · DEVOPS");
    const ctx = buildScreenContext(s);
    expect(ctx.view).toBe("Activity · Mentions · DEVOPS");
    expect(ctx.item?.key).toBe("DEVOPS-471");
    expect(ctx).toMatchObject({ filter: null, selection: [] });
    expect(screenLine({ ...s, activity: { chip: "drafts", container: null } })).toBe("Activity · Drafts · All projects");
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
    useClaude.setState({ byTicket: { general: { turns: [turn], sessionId: null } } });
    handlePipView({ requestId: "drawer", filter: { type: "blocked" }, note: "x" });
    expect(activeTab(useTabs.getState()).filter).toEqual(ALL);
    handlePipView({ requestId: "mine", filter: { type: "blocked" }, note: "x" });
    expect(activeTab(useTabs.getState()).filter).toEqual({ type: "blocked" });
    useClaude.setState({ byTicket: {} });
  });

  it("on Pip home, applies a filter asked in the selected workstream's conversation to the workspace tab only, and ignores the rest", () => {
    const turn = (requestId: string) => ({ requestId, prompt: "", steps: [], text: "", status: "running" as const, error: null });
    useClaude.setState({ byTicket: { "ws:ws-1": { turns: [turn("home")], sessionId: null }, general: { turns: [turn("general")], sessionId: null }, "ws:ws-2": { turns: [turn("other")], sessionId: null } } });
    useTabs.getState().setRoute("pip");
    usePipHome.getState().openWorkstream("ws-1");
    const backend = ws().backend!;
    const calls = Object.getOwnPropertyNames(Object.getPrototypeOf(backend))
      .filter((name) => name !== "constructor" && typeof (backend as unknown as Record<string, unknown>)[name] === "function")
      .map((name) => vi.spyOn(backend as unknown as Record<string, () => unknown>, name));
    const proposals = ws().proposals;
    const runs = useRuns.getState().runs;
    const tabs = useTabs.getState().tabs.length;
    try {
      handlePipView({ requestId: "general", filter: { type: "blocked" }, note: "x" });
      handlePipView({ requestId: "other", filter: { type: "blocked" }, note: "x" });
      expect(activeTab(useTabs.getState()).filter).toEqual(ALL);
      expect(usePip.getState().filtered).toBeNull();
      handlePipView({ requestId: "home", filter: { type: "blocked" }, note: "Blocked" });
      expect(activeTab(useTabs.getState()).filter).toEqual({ type: "blocked" });
      expect(usePip.getState().applied.home).toMatchObject({ note: "Blocked", undone: false });
      expect(useTabs.getState()).toMatchObject({ route: "pip", selected: null, marked: [] });
      expect(useTabs.getState().tabs).toHaveLength(tabs);
      expect(usePipHome.getState().selected).toBe("ws-1");
      expect(ws().proposals).toBe(proposals);
      expect(useRuns.getState().runs).toBe(runs);
      for (const call of calls) expect(call).not.toHaveBeenCalled();
    } finally {
      calls.forEach((c) => c.mockRestore());
      useTabs.getState().setRoute("workspace");
      usePipHome.getState().reset();
      useClaude.setState({ byTicket: {} });
    }
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
  const scene = (over: Partial<NudgeScene> = {}): NudgeScene => ({ route: "workspace", filter: ALL, count: 3, chips: 0, item: null, unassignedInView: 0, ...over });
  const item = (over: Partial<NonNullable<NudgeScene["item"]>> = {}) => ({ key: "DEVOPS-9", open: true, staleDays: null, blockedBy: null, waitingOn: null, unassigned: false, linked: false, ...over });
  const ids = (s: NudgeScene) => nudgeCandidates(s).map((n) => n.id);

  it("suggests a filter for an empty filtered view, many unassigned tickets or a large list", () => {
    expect(ids(scene({ count: 0, chips: 1 }))).toEqual(["empty-filter"]);
    expect(ids(scene({ count: 0, chips: 0 }))).toEqual([]);
    expect(ids(scene({ unassignedInView: 3 }))).toEqual(["unassigned-view"]);
    expect(ids(scene({ unassignedInView: 2 }))).toEqual([]);
    expect(ids(scene({ count: LARGE_LIST }))).toEqual(["large-list"]);
    expect(ids(scene({ count: LARGE_LIST - 1 }))).toEqual([]);
    expect(ids(scene({ count: LARGE_LIST, unassignedInView: 5 }))).toEqual(["unassigned-view", "large-list"]);
  });

  it("offers to show unassigned tickets by narrowing the current filter", () => {
    const [n] = nudgeCandidates(scene({ filter: { type: "stale", days: 5 }, unassignedInView: 4 }));
    expect(n.text).toBe("4 tickets here have no owner. Want me to show them?");
    expect(n.action).toEqual({ type: "filter", filter: { type: "and", filters: [{ type: "stale", days: 5 }, { type: "unassigned" }] }, note: "Tickets with no owner" });
  });

  it("speaks about the open ticket, most pressing first, each with a prompt for Pip", () => {
    const all = nudgeCandidates(scene({ item: item({ waitingOn: "Byron", blockedBy: "DEVOPS-2", staleDays: 9, unassigned: true }) }));
    expect(all.map((n) => n.kind)).toEqual(["waiting", "blocked", "stale", "unowned"]);
    expect(all.map((n) => n.id)).toEqual(["waiting:DEVOPS-9", "blocked:DEVOPS-9", "stale:DEVOPS-9", "unowned:DEVOPS-9"]);
    expect(all[0]).toMatchObject({ text: "Byron is waiting on you in DEVOPS-9. Want a reply drafted?", action: { type: "ask", prompt: "Draft a reply on DEVOPS-9" } });
    expect(all[2].text).toBe("DEVOPS-9 has been quiet for 9 days. Want a nudge drafted?");
  });

  it("says nothing about a finished ticket or on a screen without a board, and view nudges give way to an open ticket", () => {
    expect(nudgeCandidates(scene({ item: item({ open: false, staleDays: 20 }) }))).toEqual([]);
    expect(ids(scene({ route: "settings", count: LARGE_LIST }))).toEqual([]);
    expect(ids(scene({ route: "activity", count: LARGE_LIST }))).toEqual([]);
    expect(ids(scene({ count: LARGE_LIST, item: item() }))).toEqual([]);
    expect(ids(scene({ route: "activity", item: item({ staleDays: 6 }) }))).toEqual(["stale:DEVOPS-9"]);
  });

  it("skips what was closed or already shown and takes the next", () => {
    const cands = nudgeCandidates(scene({ item: item({ waitingOn: "Byron", staleDays: 9 }) }));
    expect(pickNudge(cands, [], [])?.kind).toBe("waiting");
    expect(pickNudge(cands, ["waiting:DEVOPS-9"], [])?.kind).toBe("stale");
    expect(pickNudge(cands, [], ["waiting:DEVOPS-9"])?.kind).toBe("stale");
    expect(pickNudge(cands, ["waiting:DEVOPS-9"], ["stale:DEVOPS-9"])).toBeNull();
  });

  it("waits out the dwell, and the gap since the last one", () => {
    expect(nudgeDelay(1_000_000, 0)).toBe(NUDGE_DWELL_MS);
    expect(nudgeDelay(1_000_000, 1_000_000 - NUDGE_GAP_MS - 1)).toBe(NUDGE_DWELL_MS);
    expect(nudgeDelay(1_000_000, 1_000_000 - 10_000)).toBe(NUDGE_GAP_MS - 10_000);
  });

  it("remembers what was dismissed, closes the shown one, and forgets it only on reset", () => {
    const n = nudgeCandidates(scene({ count: LARGE_LIST }))[0];
    usePip.getState().showNudge(n, 5);
    expect(usePip.getState()).toMatchObject({ nudge: n, lastNudgeAt: 5, seen: ["large-list"] });
    usePip.getState().dismiss("large-list");
    usePip.getState().dismiss("large-list");
    expect(usePip.getState().dismissed).toEqual(["large-list"]);
    expect(usePip.getState().nudge).toBeNull();
    expect(JSON.parse(localStorage.getItem("gossamr-pip")!)).toEqual({ dismissed: ["large-list"] });
  });

  it("keeps only the most recent dismissals", () => {
    for (let i = 0; i < 230; i++) usePip.getState().dismiss(`stale:T-${i}`);
    const { dismissed } = usePip.getState();
    expect(dismissed).toHaveLength(200);
    expect(dismissed[199]).toBe("stale:T-229");
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

  it("acknowledges screenshots without pretending to see them, after the keyword answers", () => {
    const png = { mediaType: "image/png", data: "AAAA" };
    const one = scriptPip("what is this?", blank, [png]);
    expect(one.text).toContain("your screenshot (PNG)");
    expect(one.text).toContain("can't look at it");
    expect(scriptPip("what is this?", blank, [png, { mediaType: "image/jpeg", data: "AAAA" }]).text).toContain("2 screenshots (PNG, JPEG)");
    expect(scriptPip("show stale", blank, [png]).filter).not.toBeNull();
    expect(scriptPip("what is this?", blank).text).toContain("You're looking at");
  });

  it("streams the answer, proposes the draft as Pip and emits the filter", async () => {
    const backend = new MockBackend();
    const item = { connectionId: "mock", externalId: "DEVOPS-471", key: "DEVOPS-471" };
    const events: ClaudeEvent[] = [];
    const views: unknown[] = [];
    const off = [mockPipEvents.on((_, e) => events.push(e)), mockPipEvents.onView((_, f, n) => views.push([f, n]))];
    const req = (prompt: string): AskRequest => ({ requestId: prompt, prompt, sessionId: null, context: { ...blank, item } });

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
    expect(historyNotes(events, name).map((n) => n.text)).toEqual(["moved from To Do to Done"]);
  });
});

describe("askPip", () => {
  it("queues a question while Pip is answering instead of refusing it", async () => {
    useClaude.setState({ byTicket: { general: { sessionId: "s1", turns: [{ requestId: "r1", prompt: "first", steps: [], text: "", status: "running", error: null }] } } });
    const toasts = useToasts.getState().toasts.length;
    const sent: AskRequest[] = [];
    const ask = vi.spyOn(claude, "ask").mockImplementation(async (req) => (sent.push(req), { queued: true, ahead: 1 }));
    try {
      askPip("and then?");
      await vi.waitFor(() => expect(useClaude.getState().byTicket.general.turns).toHaveLength(2));
      await vi.waitFor(() => expect(useClaude.getState().byTicket.general.turns[1].status).toBe("queued"));
    } finally {
      ask.mockRestore();
    }
    expect(useToasts.getState().toasts).toHaveLength(toasts);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ prompt: "and then?", sessionId: "s1", conversation: "general" });
  });
});

describe("Esc on Pip home", () => {
  const none = { sheetOpen: false, peekOpen: false, paletteOpen: false, popoverOpen: false, lightbox: false, handled: false, running: true };

  it("leaves Esc to an open sheet, the peek, the palette, a popover, the lightbox or a confirmation first", () => {
    for (const open of ["sheetOpen", "peekOpen", "paletteOpen", "popoverOpen", "lightbox", "handled"] as const) expect(escapeCancelsTurn({ ...none, [open]: true })).toBe(false);
  });

  it("then cancels Pip's turn, and does nothing with no turn to cancel", () => {
    expect(escapeCancelsTurn(none)).toBe(true);
    expect(escapeCancelsTurn({ ...none, running: false })).toBe(false);
  });
});
