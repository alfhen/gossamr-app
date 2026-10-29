import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef } from "../backend/mockConnector";
import { ALL, and, YOUR_TURN_WHY } from "../lib/filter";
import { useWorkspace } from "../workspaceStore";
import { BUILT_IN_VIEWS, PRESETS, showsEntry, visibleChips, withProject } from "./filters";
import { Header, ProjectMenu, ViewSegment } from "./Header";
import { Rail, RailButton, RailTip } from "./Rail";
import { ToastHost, toastPlacement } from "./ToastHost";
import { useToasts, LIFETIME_MS, MAX_QUEUED, STALE_MS } from "./toasts";
import { canvasRoom, regionTarget } from "./Workspace";
import { RowBadges } from "./ListView";
import { SavedViewsPanel, type SavedViewsPanelProps } from "./SavedViews";
import { buildTabItems } from "./tabItems";
import { loadTabs, useTabs, type Tab } from "./tabsStore";

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
    expect(names(items)).toEqual(["Your turn", "Mine", "Blocked", "Going stale", "Everything", "Mine soon", "custom t2"]);
    expect(items.map((i) => i.kind)).toEqual(["preset", "preset", "preset", "preset", "preset", "view", "custom"]);
  });

  it("marks the preset the active tab shows, whichever project it is in", () => {
    const items = buildTabItems([tab("t", and({ type: "container", container: containerRef("WEB") }, { type: "needsMe" }))], "t", [], label);
    expect(items.filter((i) => i.active).map((i) => i.label)).toEqual(["Your turn"]);
  });

  it("shows the active tab as its own closable tab when it is titled or filtered in a way no preset is", () => {
    const items = buildTabItems([tab("t1"), tab("t2", ALL, "New tab")], "t2", [], label);
    const custom = items.filter((i) => i.kind === "custom");
    expect(custom).toMatchObject([{ label: "New tab", active: true, tabId: "t2" }]);
    expect(items.find((i) => i.label === "Everything")?.active).toBe(false);
  });

  it("does not show an unpinned saved view twice when it has the same name as a preset", () => {
    const items = buildTabItems([tab("t", { type: "needsMe" }, "Your turn")], "t", [], label);
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
    expect(out).toContain("Your turn");
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

  it("puts Board and List in the segmented control and marks the current one", () => {
    const out = renderToStaticMarkup(<ViewSegment view="board" onChange={vi.fn()} />);
    expect(out.match(/<button[^>]*>(\w+)<\/button>/g)?.map((b) => b.replace(/<[^>]*>/g, ""))).toEqual(["Board", "List"]);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Board</);
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
    for (const name of ["Your turn", "Mine", "Blocked", "Going stale", "Everything"]) expect(out).toContain(`title="${name}"`);
    expect(out).toContain(" of ");
    expect(out).toContain("data-tauri-drag-region");
  });

  it("shows Inbox as a bell, not a lightning bolt", () => {
    const out = renderToStaticMarkup(<Rail />);
    const activity = /<button[^>]*aria-label="Inbox"[^>]*>(.*?)<\/button>/s.exec(out)![1];
    expect(activity).toContain("<svg");
    expect(activity).not.toContain("⚡");
  });

  it("renders a 58px icon rail with labelled buttons and the inbox, settings and Pip cluster", () => {
    const out = renderToStaticMarkup(<Rail />);
    for (const label of ["Search and jump", "All projects", "Views", "Inbox", "Settings", "Pip"]) expect(out).toContain(`aria-label="${label}"`);
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
    expect(out.indexOf('aria-label="Inbox"')).toBeGreaterThan(out.indexOf('aria-label="Project 7"'));
    expect(out).toMatch(/<div class="flex shrink-0[^"]*border-t[^"]*"><span class="[^"]*\brelative\b[^"]*"><button[^>]*aria-label="Inbox"/);
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
      // The text keeps a floor and the buttons wrap under it, so Undo and "+1 more" never squeeze it into a narrow column (G10).
      expect(out).toMatch(/data-toast="true"[^>]*class="[^"]*\bflex-wrap\b/);
      expect(out).toMatch(/data-toast-text="true" class="[^"]*\bflex-1\b[^"]*\bbasis-56\b/);
    } finally {
      useToasts.getState().clear();
      Object.assign(useToasts.getInitialState(), { toasts: [] });
      vi.useRealTimers();
    }
  });

  it("puts toasts bottom right of the canvas, above the launcher and left of the peek", () => {
    const canvas = toastPlacement(520);
    expect(canvas.right).toBe("calc(520px + 1.25rem)");
    expect(canvas.bottom).toContain("var(--ws-launcher-clear, 0px)");
    expect(canvas.bottom).toContain("var(--ws-footer-h, 2rem)");
    expect(canvas).not.toHaveProperty("top");
    expect(toastPlacement(0).right).toBe("calc(0px + 1.25rem)");
  });

  it("gives a narrow row's badges as named icons with tooltips, none of them dropped", () => {
    const all = { needsMe: true, blocked: true, draft: { id: "d1", to: "Done" }, moreDrafts: 2 } as const;
    const full = renderToStaticMarkup(<RowBadges {...all} compact={false} />);
    for (const words of [">Your turn<", "⛓ blocked", "✦ draft → ", "Done"]) expect(full).toContain(words);
    const compact = renderToStaticMarkup(<RowBadges {...all} compact />);
    const icons = [...compact.matchAll(/<span role="img" aria-label="([^"]+)" title="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(icons).toEqual([
      ["Your turn", YOUR_TURN_WHY],
      ["Blocked", "Blocked"],
      ["A draft waits for approval: Done", "A draft waits for approval: Done"],
      ["2 more drafts waiting", "2 more drafts waiting"],
    ]);
    expect(renderToStaticMarkup(<RowBadges needsMe={false} blocked={false} draft={null} moreDrafts={0} compact />)).toBe("");
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
});

describe("the toast queue", () => {
  const texts = () => useToasts.getState().toasts.map((t) => t.text);
  const shown = () => useToasts.getState().toasts[0]?.text;

  describe("toasts", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      useToasts.getState().clear();
    });
    afterEach(() => {
      useToasts.getState().clear();
      vi.useRealTimers();
    });

    it("queues in order and shows only the head", () => {
      useToasts.getState().push("Agent started", "info");
      useToasts.getState().push("Watching 4 repositories", "info");
      expect(texts()).toEqual(["Agent started", "Watching 4 repositories"]);
      expect(shown()).toBe("Agent started");
      expect(useToasts.getState().toasts.slice(-1)[0].text).toBe("Watching 4 repositories");
    });

    it("starts a toast's clock only once it is the one on screen", () => {
      useToasts.getState().push("first", "info");
      vi.advanceTimersByTime(LIFETIME_MS.info - STALE_MS + 100);
      useToasts.getState().push("second", "info");
      vi.advanceTimersByTime(STALE_MS - 101);
      expect(texts()).toEqual(["first", "second"]);
      vi.advanceTimersByTime(1);
      expect(texts()).toEqual(["second"]);
      // The second waited less than STALE_MS, so it shows, for its own whole lifetime from when it came up.
      vi.advanceTimersByTime(LIFETIME_MS.info - 100);
      expect(shown()).toBe("second");
      vi.advanceTimersByTime(100);
      expect(texts()).toEqual([]);
    });

    it("keeps the toast on screen while the pointer or keyboard is on it, and gives it a whole lifetime after", () => {
      const id = useToasts.getState().push("Noted for short description", "info")!;
      vi.advanceTimersByTime(LIFETIME_MS.info - 100);
      useToasts.getState().hold(id);
      vi.advanceTimersByTime(LIFETIME_MS.info * 3);
      expect(shown()).toBe("Noted for short description");
      useToasts.getState().release(id);
      vi.advanceTimersByTime(LIFETIME_MS.info - 1);
      expect(shown()).toBe("Noted for short description");
      vi.advanceTimersByTime(1);
      expect(texts()).toEqual([]);
    });

    it("keeps the toast held until both the pointer and the keyboard have left it, in either order", () => {
      for (const [first, second] of [["pointer", "focus"], ["focus", "pointer"]] as const) {
        useToasts.getState().clear();
        const id = useToasts.getState().push(`read by ${first} then ${second}`, "info")!;
        useToasts.getState().hold(id, "focus");
        useToasts.getState().hold(id, "pointer");
        useToasts.getState().release(id, first);
        vi.advanceTimersByTime(LIFETIME_MS.info * 3);
        expect(shown()).toBe(`read by ${first} then ${second}`);
        useToasts.getState().release(id, second);
        vi.advanceTimersByTime(LIFETIME_MS.info - 1);
        expect(shown()).toBe(`read by ${first} then ${second}`);
        vi.advanceTimersByTime(1);
        expect(texts()).toEqual([]);
      }
    });

    it("lets the next note come up on its clock once the held one is dismissed", () => {
      const first = useToasts.getState().push("first", "info")!;
      useToasts.getState().push("second", "info");
      useToasts.getState().hold(first);
      useToasts.getState().dismiss(first);
      useToasts.getState().release(first);
      expect(shown()).toBe("second");
      vi.advanceTimersByTime(LIFETIME_MS.info);
      expect(texts()).toEqual([]);
    });

    it("drops a note that waited too long behind another rather than show it late, but never an error", () => {
      useToasts.getState().push("Watching 4 repositories", "info");
      useToasts.getState().push("Agent started on CA-402", "info");
      useToasts.getState().push("Couldn't reach Jira");
      vi.advanceTimersByTime(LIFETIME_MS.info);
      // The error went ahead of the note and comes up next; the note, older than STALE_MS by then, is gone.
      expect(texts()).toEqual(["Couldn't reach Jira"]);
      expect(STALE_MS).toBeLessThan(LIFETIME_MS.info);
    });

    it("puts an error ahead of the notes waiting, behind the one on screen and earlier errors", () => {
      useToasts.getState().push("on screen", "info");
      useToasts.getState().push("note 1", "info");
      useToasts.getState().push("error 1");
      useToasts.getState().push("note 2", "info");
      useToasts.getState().push("error 2");
      expect(texts()).toEqual(["on screen", "error 1", "error 2", "note 1", "note 2"]);
    });

    it("keeps an error on screen longer than a note", () => {
      useToasts.getState().push("Couldn't post it");
      expect(useToasts.getState().toasts[0].tone).toBe("error");
      vi.advanceTimersByTime(LIFETIME_MS.info + 1);
      expect(shown()).toBe("Couldn't post it");
      vi.advanceTimersByTime(LIFETIME_MS.error - LIFETIME_MS.info);
      expect(texts()).toEqual([]);
      expect(LIFETIME_MS.error).toBeGreaterThan(LIFETIME_MS.info);
    });

    it("shows the next one when the head is dismissed, with a fresh clock", () => {
      useToasts.getState().push("first", "info");
      vi.advanceTimersByTime(LIFETIME_MS.info - 10);
      useToasts.getState().push("second", "info");
      useToasts.getState().dismiss(useToasts.getState().toasts[0].id);
      expect(shown()).toBe("second");
      vi.advanceTimersByTime(LIFETIME_MS.info - 1);
      expect(shown()).toBe("second");
      vi.advanceTimersByTime(1);
      expect(texts()).toEqual([]);
    });

    it("drops a repeat of a toast that is on screen or waiting", () => {
      useToasts.getState().push("same", "info");
      useToasts.getState().push("other", "info");
      useToasts.getState().push("other", "info");
      useToasts.getState().push("same", "info");
      expect(texts()).toEqual(["same", "other"]);
    });

    it("keeps the action a toast carries", () => {
      const run = vi.fn();
      useToasts.getState().push("Stopped", "info", { label: "Undo", run });
      useToasts.getState().toasts[0].action!.run();
      expect(run).toHaveBeenCalled();
    });

    it("lets the oldest waiting toast give way past the cap, never the one on screen", () => {
      for (let i = 0; i < MAX_QUEUED + 3; i++) useToasts.getState().push(`t${i}`, "info");
      expect(texts()).toHaveLength(MAX_QUEUED);
      expect(shown()).toBe("t0");
      expect(texts().slice(-1)[0]).toBe(`t${MAX_QUEUED + 2}`);
      // An error waiting outlasts the notes when the queue is full.
      useToasts.getState().clear();
      useToasts.getState().push("on screen", "info");
      useToasts.getState().push("an error");
      for (let i = 0; i < MAX_QUEUED + 3; i++) useToasts.getState().push(`n${i}`, "info");
      expect(texts()).toHaveLength(MAX_QUEUED);
      expect(texts().slice(0, 2)).toEqual(["on screen", "an error"]);
    });

    it("drops a waiting note whose subject has moved on, however short its wait, but shows one still news", () => {
      let running = true;
      useToasts.getState().push("Watching 4 repositories", "info");
      useToasts.getState().push("Agent started on CA-402", "info", undefined, { current: () => running });
      useToasts.getState().push("Created CA-500.", "info", undefined, { current: () => true });
      // The run finishes before the first note has gone; its note never comes up, the next one does.
      running = false;
      useToasts.getState().dismiss(useToasts.getState().toasts[0].id);
      expect(texts()).toEqual(["Created CA-500."]);
      // A check that throws counts as moved on; an error is never dropped for it.
      useToasts.getState().push("Agent started on CA-401", "info", undefined, { current: () => { throw new Error("gone"); } });
      useToasts.getState().push("Couldn't reach Jira", "error", undefined, { current: () => false });
      useToasts.getState().dismiss(useToasts.getState().toasts[0].id);
      expect(texts()).toEqual(["Couldn't reach Jira"]);
    });
  });
});

describe("tabs kept from before Your turn", () => {
  it("renames a tab opened from the old Needs me view to Your turn, and nothing else of that name", () => {
    const tabs = [
      { id: "a", title: "Needs me", filter: { type: "needsMe" }, view: "list" },
      { id: "b", title: "Needs me", filter: { type: "blocked" }, view: "list" },
    ];
    const saved = JSON.stringify({ tabs, activeId: "a" });
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "gossamr-tabs" ? saved : null), setItem: () => {}, removeItem: () => {} });
    try {
      expect(loadTabs().tabs.map((t) => t.title)).toEqual(["Your turn", "Needs me"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("where F6 puts the keyboard", () => {
  const el = (id: string) => ({ id }) as unknown as HTMLElement;
  const doc = (title: boolean) => ({ querySelector: () => (title ? el("title") : null), getElementById: (id: string) => el(id) }) as unknown as Pick<Document, "querySelector" | "getElementById">;

  it("is the peek's title, or the peek itself when a draft's peek has no title heading", () => {
    expect(regionTarget("peek", doc(true))?.id).toBe("title");
    expect(regionTarget("peek", doc(false))?.id).toBe("peek-sheet");
    expect(regionTarget("pip", doc(false))?.id).toBe("pip-input");
    expect(regionTarget("main", doc(false))?.id).toBe("workspace-main");
  });
});
