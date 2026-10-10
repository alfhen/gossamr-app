import { beforeEach, describe, expect, it, vi } from "vitest";
import { containerRef } from "../backend/mockConnector";
import { filterChips } from "../lib/filter";
import { activeTab, dedupeViews, loadTabs, nextMarked, useTabs } from "./tabsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const s = () => useTabs.getState();
const reload = () => useTabs.setState(loadTabs());

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  reload();
  s().openTab();
  while (s().tabs.length > 1) s().closeTab(s().tabs[0].id);
  s().setFilter({ type: "and", filters: [] });
  s().setView("list");
});

describe("workspace tabs", () => {
  it("keeps a filter and a view mode per tab", () => {
    s().setFilter({ type: "blocked" });
    s().setView("board");
    const second = s().openTab({ filter: { type: "mine" }, view: "age" });
    expect(activeTab(s()).id).toBe(second);
    s().activate(s().tabs[0].id);
    expect(activeTab(s())).toMatchObject({ filter: { type: "blocked" }, view: "board" });
  });

  it("survives a restart with the same tabs, filters, views and active tab", () => {
    s().setProject(containerRef("WEB"));
    s().setView("map");
    const second = s().openTab({ filter: { type: "stale", days: 5 }, view: "age" });
    const before = { tabs: s().tabs, activeId: s().activeId };

    const saved = localStorage.getItem("gossamr-tabs")!;
    vi.stubGlobal("localStorage", { ...memory(), getItem: () => saved });
    useTabs.setState({ tabs: [], activeId: "" });
    reload();

    expect(s().tabs).toEqual(before.tabs);
    expect(s().activeId).toBe(second);
    expect(filterChips(s().tabs[0].filter)).toEqual([{ type: "container", container: containerRef("WEB") }]);
  });

  it("selects a neighbour when the active tab closes, and never runs out of tabs", () => {
    const a = s().tabs[0].id;
    const b = s().openTab();
    s().closeTab(b);
    expect(s().activeId).toBe(a);
    s().closeTab(a);
    expect(s().tabs).toHaveLength(1);
    expect(s().activeId).toBe(s().tabs[0].id);
  });

  it("ignores stored tabs it can't read", () => {
    localStorage.setItem("gossamr-tabs", JSON.stringify({ tabs: [{ id: 1 }, { id: "x", filter: { type: "blocked" }, view: "nope" }], activeId: "gone" }));
    const loaded = loadTabs();
    expect(loaded.tabs).toEqual([{ id: "x", title: null, filter: { type: "blocked" }, view: "list" }]);
    expect(loaded.activeId).toBe("x");
  });

  it("does not duplicate a chip added twice", () => {
    s().addFilter({ type: "blocked" });
    s().addFilter({ type: "blocked" });
    expect(filterChips(activeTab(s()).filter)).toHaveLength(1);
  });

  it("opens a saved view in an empty tab and in a new one when the tab is in use", () => {
    const view = { id: "v", name: "Mine", filter: { type: "mine" } as const };
    s().openSavedView(view);
    expect(s().tabs).toHaveLength(1);
    expect(activeTab(s()).title).toBe("Mine");
    s().openSavedView({ ...view, name: "Again" });
    expect(s().tabs).toHaveLength(2);
  });
});

describe("saved views", () => {
  const saveMine = (name: string) => {
    s().setFilter({ type: "mine" });
    return s().saveView(name)!;
  };

  it("saves whatever filter the tab holds under a trimmed name and names the tab", () => {
    s().setFilter({ type: "blocked" });
    const id = s().saveView("  Waiting on others ")!;
    expect(s().savedViews).toEqual([{ id, name: "Waiting on others", filter: { type: "blocked" } }]);
    expect(activeTab(s()).title).toBe("Waiting on others");
    expect(s().saveView("   ")).toBeNull();
    expect(s().savedViews).toHaveLength(1);
  });

  it("renames, reorders, pins and removes, and keeps the tabs that show the view in step", () => {
    const a = saveMine("A");
    s().setFilter({ type: "blocked" });
    const b = s().saveView("B")!;
    s().renameSavedView(b, "  Blocked lately ");
    expect(s().savedViews.map((v) => v.name)).toEqual(["A", "Blocked lately"]);
    expect(activeTab(s()).title).toBe("Blocked lately");
    s().renameSavedView(b, "  ");
    expect(s().savedViews[1].name).toBe("Blocked lately");

    s().moveSavedView(b, -1);
    expect(s().savedViews.map((v) => v.id)).toEqual([b, a]);
    s().moveSavedView(b, -1);
    s().moveSavedView(a, 1);
    expect(s().savedViews.map((v) => v.id)).toEqual([b, a]);

    s().pinSavedView(a, true);
    expect(s().savedViews.find((v) => v.id === a)?.pinned).toBe(true);
    s().removeSavedView(b);
    expect(s().savedViews.map((v) => v.id)).toEqual([a]);
  });

  it("refuses a rename to a name another saved view already has, ignoring case and spaces", () => {
    const a = saveMine("Mine");
    s().setFilter({ type: "blocked" });
    const b = s().saveView("Blocked")!;
    s().renameSavedView(b, "  mine ");
    expect(s().savedViews.find((v) => v.id === b)?.name).toBe("Blocked");
    s().renameSavedView(a, "MINE");
    expect(s().savedViews.find((v) => v.id === a)?.name).toBe("MINE");
  });

  it("drops duplicate views when loading, keeping order and any pin", () => {
    const mine = { type: "mine" } as const;
    const out = dedupeViews([
      { id: "1", name: "Mine", filter: mine },
      { id: "2", name: "Other", filter: { type: "blocked" } },
      { id: "3", name: " mine", filter: mine, pinned: true },
      { id: "1", name: "Again", filter: { type: "stale", days: 3 } },
    ]);
    expect(out).toEqual([
      { id: "1", name: "Mine", filter: mine, pinned: true },
      { id: "2", name: "Other", filter: { type: "blocked" } },
    ]);
  });

  it("survives a restart in order, with its pinned state", () => {
    const a = saveMine("A");
    s().setFilter({ type: "blocked" });
    const b = s().saveView("B")!;
    s().pinSavedView(b, true);
    const saved = localStorage.getItem("gossamr-tabs")!;
    vi.stubGlobal("localStorage", { ...memory(), getItem: () => saved });
    useTabs.setState({ savedViews: [] });
    reload();
    expect(s().savedViews.map((v) => [v.id, v.name, v.pinned ?? false])).toEqual([
      [a, "A", false],
      [b, "B", true],
    ]);
  });

  it("drops stored views it can't read", () => {
    localStorage.setItem("gossamr-tabs", JSON.stringify({ tabs: [], savedViews: [{ id: 1 }, { id: "v", name: "Ok", filter: { type: "mine" }, pinned: "yes" }] }));
    expect(loadTabs().savedViews).toEqual([{ id: "v", name: "Ok", filter: { type: "mine" } }]);
  });
});

describe("showing a preset", () => {
  it("re-filters the active tab and keeps its project", () => {
    s().setProject(containerRef("WEB"));
    s().showView({ type: "blocked" });
    expect(s().tabs).toHaveLength(1);
    expect(filterChips(activeTab(s()).filter)).toEqual([{ type: "blocked" }, { type: "container", container: containerRef("WEB") }]);
  });

  it("switches to a tab already showing it instead of making another", () => {
    const first = s().tabs[0].id;
    s().setFilter({ type: "blocked" });
    s().openTab({ filter: { type: "mine" } });
    s().showView({ type: "blocked" });
    expect(s().activeId).toBe(first);
    expect(s().tabs).toHaveLength(2);
  });

  it("leaves a view that names its own project in that project", () => {
    s().setProject(containerRef("WEB"));
    s().showView({ type: "and", filters: [{ type: "container", container: containerRef("CA") }, { type: "blocked" }] });
    expect(filterChips(activeTab(s()).filter)).toContainEqual({ type: "container", container: containerRef("CA") });
    expect(filterChips(activeTab(s()).filter)).not.toContainEqual({ type: "container", container: containerRef("WEB") });
  });
});

describe("the peek and the route", () => {
  it("closes when the route changes, and only then", () => {
    s().select("mock:CA-402");
    s().setRoute("workspace");
    expect(s().selected).toBe("mock:CA-402");
    s().setRoute("activity");
    expect(s().selected).toBeNull();
    s().select("mock:CA-402");
    s().setRoute("settings");
    expect(s().selected).toBeNull();
  });

  it("closes when a view or project brings the person back from another route", () => {
    s().setRoute("activity");
    s().select("mock:CA-402");
    s().setView("board");
    expect(s()).toMatchObject({ route: "workspace", selected: null });
  });

  it("closes the peek and drops the ticks on the way to Pip home, as on the way to any other route, and never stores the route", () => {
    s().select("mock:CA-402");
    s().mark("mock:CA-403", "toggle", ["mock:CA-402", "mock:CA-403"]);
    expect(s().marked).toHaveLength(2);
    s().setRoute("pip");
    expect(s()).toMatchObject({ route: "pip", selected: null, marked: [] });
    s().select("mock:CA-402");
    s().setRoute("pip");
    expect(s().selected).toBe("mock:CA-402");
    expect(globalThis.localStorage.getItem("gossamr-tabs")).not.toContain('"route"');
  });

  it("lets a jump select after switching route", () => {
    s().setRoute("activity");
    s().setRoute("workspace");
    s().select("mock:CA-402");
    expect(s().selected).toBe("mock:CA-402");
  });
});

describe("ticking cards", () => {
  const order = ["a", "b", "c", "d"];

  it("starts from the selected card and toggles from there", () => {
    expect(nextMarked([], "a", "c", "toggle", order)).toEqual(["a", "c"]);
    expect(nextMarked(["a", "c"], "c", "b", "toggle", order)).toEqual(["a", "c", "b"]);
    expect(nextMarked(["a", "c"], "c", "c", "toggle", order)).toEqual(["a"]);
  });

  it("ticks nothing when the only card left is the selected one", () => {
    expect(nextMarked(["a", "c"], "c", "c", "toggle", order)).toEqual(["a"]);
    expect(nextMarked(["a"], "a", "a", "toggle", order)).toEqual([]);
  });

  it("ticks the span between the selected card and the clicked one, in either direction", () => {
    expect(nextMarked([], "b", "d", "range", order)).toEqual(["b", "c", "d"]);
    expect(nextMarked([], "d", "b", "range", order)).toEqual(["d", "b", "c"]);
    expect(nextMarked([], null, "c", "range", order)).toEqual(["c"]);
  });

  it("keeps the selection among the ticks, and a plain select clears them", () => {
    s().select("a");
    s().mark("c", "toggle", order);
    expect(s().marked).toEqual(["a", "c"]);
    expect(s().selected).toBe("c");
    s().mark("c", "toggle", order);
    expect(s().selected).toBe("a");
    s().mark("b", "toggle", order);
    s().select("d");
    expect(s().marked).toEqual([]);
    s().mark("b", "range", order);
    s().clearMarks();
    expect(s().marked).toEqual([]);
  });
});

