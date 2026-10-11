import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { ALL, and } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, PRESETS, showsEntry, visibleChips, withProject } from "./filters";
import { Header, ProjectMenu, ViewSegment } from "./Header";
import { HOLD_ALL_NOTE, Rail, RailButton, RailTip } from "./Rail";
import { COMPOSER_CLEAR, ToastHost, toastPlacement } from "./ToastHost";
import { useToasts } from "./toasts";
import { MORE_BUTTON, tabWindow } from "./TabBar";
import { canvasRoom } from "./Workspace";
import { useAgentsFlag } from "./agentsFlag";
import { useWorkstreams } from "./workstreamsStore";
import type { WorkstreamView } from "../types";
import { SavedViewsPanel, type SavedViewsPanelProps } from "./SavedViews";
import { buildTabItems } from "./tabItems";
import { useTabs, type Tab } from "./tabsStore";

const tab = (id: string, filter = ALL, title: string | null = null): Tab => ({ id, title, filter, view: "list" });
const names = (items: ReturnType<typeof buildTabItems>) => items.map((i) => i.label);

describe("tab items", () => {
  const label = (t: Tab) => t.title ?? `custom ${t.id}`;

  it("lists the presets, then pinned views, then tabs nothing else stands for", () => {
    const views = [
      { id: "a", name: "Mine soon", filter: { type: "blocked" } as const, pinned: true },
      { id: "b", name: "Not pinned", filter: { type: "mine" } as const },
    ];
    const items = buildTabItems([tab("t1"), tab("t2", { type: "stale", days: 9 })], "t1", views, label);
    expect(names(items)).toEqual(["Needs me", "Mine", "Blocked", "Going stale", "Everything", "Mine soon", "custom t2"]);
    expect(items.map((i) => i.kind)).toEqual(["preset", "preset", "preset", "preset", "preset", "view", "custom"]);
  });

  it("marks the preset the active tab shows, whichever project it is in", () => {
    const items = buildTabItems([tab("t", and({ type: "container", container: containerRef("WEB") }, { type: "needsMe" }))], "t", [], label);
    expect(items.filter((i) => i.active).map((i) => i.label)).toEqual(["Needs me"]);
  });

  it("shows the active tab as its own closable tab when it is titled or filtered in a way no preset is", () => {
    const items = buildTabItems([tab("t1"), tab("t2", ALL, "New tab")], "t2", [], label);
    const custom = items.filter((i) => i.kind === "custom");
    expect(custom).toMatchObject([{ label: "New tab", active: true, tabId: "t2" }]);
    expect(items.find((i) => i.label === "Everything")?.active).toBe(false);
  });

  it("does not show an unpinned saved view twice when it has the same name as a preset", () => {
    const items = buildTabItems([tab("t", { type: "needsMe" }, "Needs me")], "t", [], label);
    expect(items.filter((i) => i.kind === "custom")).toHaveLength(0);
  });

  it("keeps a tab in another project reachable instead of folding it into the preset", () => {
    const web = withProject({ type: "blocked" }, containerRef("WEB"));
    const ca = withProject({ type: "blocked" }, containerRef("CA"));
    const items = buildTabItems([tab("a", web), tab("b", ca)], "a", [], (t) => `tab ${t.id}`);
    expect(items.find((i) => i.label === "Blocked")?.active).toBe(true);
    expect(items.filter((i) => i.kind === "custom")).toMatchObject([{ label: "tab b", tabId: "b", active: false }]);
  });

  it("tells a view that names its own project from the same filter in another project", () => {
    const view = and({ type: "container", container: containerRef("CA") }, { type: "blocked" });
    expect(showsEntry(view, withProject({ type: "blocked" }, containerRef("CA")))).toBe(true);
    expect(showsEntry(view, withProject({ type: "blocked" }, containerRef("WEB")))).toBe(false);
  });

  it("hides the chips the active preset already explains", () => {
    const f = withProject({ type: "blocked" }, containerRef("WEB"));
    expect(visibleChips(f, PRESETS[2].filter)).toEqual([]);
    expect(visibleChips(and(f, { type: "mine" }), PRESETS[2].filter)).toMatchObject([{ chip: { type: "blocked" }, index: 0 }, { chip: { type: "mine" }, index: 2 }]);
  });
});

describe("SavedViewsPanel", () => {
  const props = (over: Partial<SavedViewsPanelProps> = {}): SavedViewsPanelProps => ({
    builtIn: BUILT_IN_VIEWS,
    saved: [
      { id: "a", name: "First", filter: { type: "mine" }, pinned: true },
      { id: "b", name: "Second", filter: { type: "blocked" } },
    ],
    counts: { "needs-me": 5 },
    suggested: "Blocked",
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onRename: vi.fn(),
    onMove: vi.fn(),
    onPin: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  });
  const render = (p = props()) => renderToStaticMarkup(<SavedViewsPanel {...p} />);

  it("lists built-in and saved views with rename, reorder, pin and remove for each saved one", () => {
    const out = render();
    expect(out).toContain("Needs me");
    expect(out).toContain(">5<");
    for (const what of ["Rename First", "Remove saved view First", "Move First down", "Unpin First from the tabs", "Pin Second as a tab", "Move Second up"]) expect(out).toContain(`aria-label="${what}"`);
    expect(out).toMatch(/aria-label="Move First up"[^>]*disabled/);
    expect(out).toMatch(/aria-label="Move Second down"[^>]*disabled/);
    expect(out).toMatch(/aria-pressed="true"[^>]*aria-label="Unpin First from the tabs"/);
  });

  it("offers to save the current filter only when there is one", () => {
    expect(render()).not.toMatch(/disabled=""[^>]*>Save current filter/);
    expect(render(props({ suggested: null }))).toMatch(/disabled=""[^>]*>Save current filter as a view/);
  });

  it("says how to get a first saved view", () => {
    expect(render(props({ saved: [] }))).toContain("Filter the board, then save the filter here");
  });
});

describe("header and rail", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    await useWorkspace.getState().init(new MockBackend());
    Object.assign(useWorkspace.getInitialState(), useWorkspace.getState());
    Object.assign(useTabs.getInitialState(), useTabs.getState());
  });

  it("puts Board, Map, List and Age in the segmented control and marks the current one", () => {
    const out = renderToStaticMarkup(<ViewSegment view="map" onChange={vi.fn()} />);
    expect(out.match(/<button[^>]*>(\w+)<\/button>/g)?.map((b) => b.replace(/<[^>]*>/g, ""))).toEqual(["Board", "Map", "List", "Age"]);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Map</);
  });

  it("shows the project as a title with a switcher instead of a select", () => {
    const containers = Object.values(useWorkspace.getState().containers);
    const out = renderToStaticMarkup(<ProjectMenu containers={containers} value={containerRef("WEB")} onChange={vi.fn()} />);
    expect(out).toContain('aria-haspopup="listbox"');
    expect(out).toContain("Webshop");
    expect(out).not.toContain("<select");
  });

  it("renders the workspace header with presets carrying live counts", () => {
    const out = renderToStaticMarkup(<Header />);
    expect(out).toContain('role="tablist"');
    for (const name of ["Needs me", "Mine", "Blocked", "Going stale", "Everything"]) expect(out).toContain(`title="${name}"`);
    expect(out).toContain(" of ");
    expect(out).toContain("data-tauri-drag-region");
  });

  it("shows Activity as a bell, not a lightning bolt", () => {
    const out = renderToStaticMarkup(<Rail />);
    const activity = /<button[^>]*aria-label="Activity"[^>]*>(.*?)<\/button>/s.exec(out)![1];
    expect(activity).toContain("<svg");
    expect(activity).not.toContain("⚡");
  });

  it("renders a 58px icon rail with labelled buttons and the activity, settings and Pip cluster", () => {
    const out = renderToStaticMarkup(<Rail />);
    for (const label of ["Search and jump", "All projects", "Views", "Activity", "Settings", "Pip"]) expect(out).toContain(`aria-label="${label}"`);
    expect(out).toContain('aria-label="DevOps"');
    expect(out).toContain("DE</button>");
    expect(out).toContain("data-tauri-drag-region");
  });

  it("keeps the bottom cluster outside the scrolling badge list however many projects there are", () => {
    const base = Object.values(useWorkspace.getState().containers)[0];
    const many = Object.fromEntries(Array.from({ length: 46 }, (_, i) => [`mock:P${i}`, { ...base, key: `P${i}`, name: `Project ${i}`, ref: { connectionId: "mock", externalId: `P${i}` } }]));
    useWorkspace.getInitialState().containers = many;
    const out = renderToStaticMarkup(<Rail />);
    expect(out.match(/aria-label="Project \d+"/g)).toHaveLength(8);
    expect(out).toContain('aria-label="More projects"');
    const list = out.indexOf('aria-label="Projects"');
    expect(out.slice(out.lastIndexOf("<div", list), list)).toContain("overflow-y-auto");
    expect(out.indexOf('aria-label="Activity"')).toBeGreaterThan(out.indexOf('aria-label="Project 7"'));
    expect(out).toMatch(/<div class="flex shrink-0[^"]*border-t[^"]*"><span class="relative"><button[^>]*aria-label="Activity"/);
  });

  it("shows a tooltip only where it was asked for", () => {
    expect(renderToStaticMarkup(<RailTip label="Views" at={null} />)).toBe("");
    const out = renderToStaticMarkup(<RailTip label="Search" hint="⌘K" at={{ x: 66, y: 20 }} />);
    expect(out).toContain('role="tooltip"');
    expect(out).toContain("⌘K");
  });
});

describe("nothing covers anything", () => {
  it("shows one toast at a time, with how many wait behind it", () => {
    vi.useFakeTimers();
    try {
      useToasts.getState().push("Agent started", "info");
      useToasts.getState().push("Watching 4 repositories", "info");
      Object.assign(useToasts.getInitialState(), { toasts: useToasts.getState().toasts });
      const out = renderToStaticMarkup(<ToastHost />);
      expect(out.match(/data-toast="true"/g)).toHaveLength(1);
      expect(out).toContain("Agent started");
      expect(out).not.toContain("Watching 4 repositories");
      expect(out).toContain("+1 more");
    } finally {
      useToasts.getState().clear();
      Object.assign(useToasts.getInitialState(), { toasts: [] });
      vi.useRealTimers();
    }
  });

  it("puts toasts bottom right of the canvas, above the launcher and left of the peek, and in Pip home's Steps column", () => {
    const canvas = toastPlacement("workspace", 520);
    expect(canvas.right).toBe("calc(520px + 1.25rem)");
    expect(canvas.bottom).toContain("var(--ws-launcher-clear, 0px)");
    expect(canvas.bottom).toContain("var(--ws-footer-h, 2rem)");
    expect(canvas).not.toHaveProperty("top");
    expect(toastPlacement("agents", 0).right).toBe("calc(0px + 1.25rem)");
    // Pip home: inside the Steps column, which is at least 240px wide, or above the composer when a peek covers it.
    const home = toastPlacement("pip", 0);
    expect(home.right).toBe(16);
    expect(Number(home.maxWidth)).toBeLessThanOrEqual(240 + 2 * 16 + 16);
    expect(toastPlacement("pip", 520).bottom).toContain(`${COMPOSER_CLEAR}px`);
    expect(toastPlacement("pip", 520).right).toBe("calc(520px + 1.25rem)");
  });

  it("shows a run of whole tabs that always holds the active one, and ends where the last whole tab does", () => {
    // Five 100px tabs, 2px apart: 0..100, 102..202, 204..304, 306..406, 408..508.
    const spans = [0, 1, 2, 3, 4].map((i) => ({ left: i * 102, size: 100 }));
    expect(tabWindow(spans, 600, 0, 4)).toEqual({ start: 0, end: 4, offset: 0 });
    // Room for two whole tabs once the 'more' buttons are in: never a third cut short.
    const room = 2 * MORE_BUTTON + 250;
    expect(tabWindow(spans, room, 0, 0)).toEqual({ start: 0, end: 1, offset: 0, width: 202 });
    // The strip narrowing (the peek and the Pip pane opening) with the last tab active brings it in, not the first two.
    expect(tabWindow(spans, room, 0, 4)).toEqual({ start: 3, end: 4, offset: 306, width: 202 });
    expect(tabWindow(spans, room, 3, 1)).toEqual({ start: 1, end: 2, offset: 102, width: 202 });
    // Paging on with no tab to follow keeps the start the person chose, filling back from the last tab.
    expect(tabWindow(spans, room, 2, -1)).toEqual({ start: 2, end: 3, offset: 204, width: 202 });
    expect(tabWindow(spans, room, 9, -1)).toEqual({ start: 3, end: 4, offset: 306, width: 202 });
    expect(tabWindow([], 100, 0, -1)).toEqual({ start: 0, end: 0, offset: 0 });
  });

  it("makes room for the peek beside the workspace canvas only", () => {
    expect(canvasRoom("workspace", true, 520)).toBe(520);
    expect(canvasRoom("workspace", false, 520)).toBe(0);
    expect(canvasRoom("agents", true, 520)).toBe(0);
  });

  it("names every rail button", () => {
    expect(renderToStaticMarkup(<RailButton label="Pip" onClick={vi.fn()}>x</RailButton>)).toContain('aria-label="Pip"');
    const out = renderToStaticMarkup(<Rail />);
    const buttons = out.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) expect(b).toMatch(/aria-label="[^"]+"/);
    expect(out).not.toContain("⌕");
  });

  it("draws Hold all as a pause icon with a note on what it does", () => {
    const flag = useAgentsFlag.getInitialState();
    const ws = useWorkstreams.getInitialState();
    const before = { enabled: flag.enabled, list: ws.list };
    const view = { workstream: { id: "ws-1", closedAt: null, mode: "manage", heldReason: null } } as unknown as WorkstreamView;
    Object.assign(flag, { enabled: true });
    Object.assign(ws, { list: [view] });
    try {
      const out = renderToStaticMarkup(<Rail />);
      const hold = /<button[^>]*aria-label="Hold all workstreams"[^>]*>(.*?)<\/button>/s.exec(out)![1];
      expect(hold).toContain("<svg");
      expect(hold).not.toContain("⏸");
      expect(HOLD_ALL_NOTE).toMatch(/agents carry on/);
      for (const b of out.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/aria-label="[^"]+"/);
    } finally {
      Object.assign(flag, { enabled: before.enabled });
      Object.assign(ws, { list: before.list });
    }
  });
});
