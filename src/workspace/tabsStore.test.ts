import { beforeEach, describe, expect, it, vi } from "vitest";
import { containerRef } from "../backend/mockConnector";
import { filterChips } from "../lib/filter";
import { activeTab, loadTabs, nextMarked, useTabs } from "./tabsStore";

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

