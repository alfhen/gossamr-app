import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { ALL, and } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, PRESETS, showsEntry, visibleChips, withProject } from "./filters";
import { Header, ProjectMenu, ViewSegment } from "./Header";
import { Rail } from "./Rail";
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

  it("renders a 58px icon rail with labelled buttons and the activity, settings and Pip cluster", () => {
    const out = renderToStaticMarkup(<Rail />);
    for (const label of ["Search and jump", "All projects", "Views", "Activity", "Settings", "Pip"]) expect(out).toContain(`aria-label="${label}"`);
    expect(out).toContain('role="tooltip"');
    expect(out).toContain('aria-label="DevOps"');
    expect(out).toContain("DE</button>");
    expect(out).toContain("data-tauri-drag-region");
  });
});
