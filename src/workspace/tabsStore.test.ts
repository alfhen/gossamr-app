import { beforeEach, describe, expect, it, vi } from "vitest";
import { containerRef } from "../backend/mockConnector";
import { filterChips } from "../lib/filter";
import { activeTab, loadTabs, useTabs } from "./tabsStore";

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
