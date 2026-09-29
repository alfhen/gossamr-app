import { create } from "zustand";
import { ALL, and, filterChips } from "../lib/filter";
import type { ContainerRef, WorkFilter } from "../types";
import { BUILT_IN_VIEWS, withProject, type SavedView } from "./filters";
import { readStored, writeStored } from "./storage";

export const VIEW_MODES = ["board", "list", "map", "age"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const VIEW_LABEL: Record<ViewMode, string> = { board: "Board", list: "List", map: "Map", age: "Age" };

export type Route = "workspace" | "activity" | "settings";

export interface Tab {
  id: string;
  /** Set when a saved view or a project named the tab; otherwise the filter describes it. */
  title: string | null;
  filter: WorkFilter;
  view: ViewMode;
}

interface TabsState {
  tabs: Tab[];
  activeId: string;
  route: Route;
  /** Key (see `itemKey`) of the selected item, shared by every canvas and the peek sheet. */
  selected: string | null;
  savedViews: SavedView[];
  openTab(init?: Partial<Omit<Tab, "id">>): string;
  closeTab(id: string): void;
  activate(id: string): void;
  setFilter(filter: WorkFilter): void;
  addFilter(filter: WorkFilter): void;
  setView(view: ViewMode): void;
  setProject(project: ContainerRef | null): void;
  openSavedView(view: SavedView): void;
  saveView(name: string): void;
  removeSavedView(id: string): void;
  setRoute(route: Route): void;
  select(key: string | null): void;
}

const KEY = "gossamr-tabs";

let counter = 0;
const newId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;
const blankTab = (): Tab => ({ id: newId(), title: null, filter: ALL, view: "list" });

const isFilter = (f: unknown): f is WorkFilter => typeof f === "object" && f !== null && typeof (f as { type?: unknown }).type === "string";

function parseTab(t: unknown): Tab | null {
  const raw = t as Partial<Tab> | null;
  if (!raw || typeof raw.id !== "string" || !isFilter(raw.filter)) return null;
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : null,
    filter: raw.filter,
    view: VIEW_MODES.find((v) => v === raw.view) ?? "list",
  };
}

function parseView(v: unknown): SavedView | null {
  const raw = v as Partial<SavedView> | null;
  return raw && typeof raw.id === "string" && typeof raw.name === "string" && isFilter(raw.filter) ? { id: raw.id, name: raw.name, filter: raw.filter } : null;
}

export function loadTabs(): Pick<TabsState, "tabs" | "activeId" | "savedViews"> {
  const raw = readStored(KEY) as { tabs?: unknown; activeId?: unknown; savedViews?: unknown } | null;
  const tabs = (Array.isArray(raw?.tabs) ? raw.tabs : []).map(parseTab).filter((t): t is Tab => t !== null);
  const savedViews = (Array.isArray(raw?.savedViews) ? raw.savedViews : []).map(parseView).filter((v): v is SavedView => v !== null);
  if (!tabs.length) tabs.push(blankTab());
  return { tabs, activeId: tabs.find((t) => t.id === raw?.activeId)?.id ?? tabs[0].id, savedViews };
}

const patchActive = (s: TabsState, patch: Partial<Tab>) => ({ tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, ...patch } : t)) });

export const useTabs = create<TabsState>((set, get) => ({
  ...loadTabs(),
  route: "workspace",
  selected: null,

  openTab(init = {}) {
    const tab = { ...blankTab(), ...init };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, route: "workspace" }));
    return tab.id;
  },

  closeTab(id) {
    set((s) => {
      const at = s.tabs.findIndex((t) => t.id === id);
      if (at < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (!tabs.length) tabs.push(blankTab());
      const activeId = s.activeId === id ? tabs[Math.min(at, tabs.length - 1)].id : s.activeId;
      return { tabs, activeId };
    });
  },

  activate: (id) => set((s) => (s.tabs.some((t) => t.id === id) ? { activeId: id, route: "workspace" } : s)),
  // Any hand-made filter change drops the name a saved view or project gave the tab.
  setFilter: (filter) => set((s) => patchActive(s, { filter, title: null })),
  addFilter(filter) {
    const tab = activeTab(get());
    const have = new Set(filterChips(tab.filter).map((c) => JSON.stringify(c)));
    if (!have.has(JSON.stringify(filter))) get().setFilter(and(tab.filter, filter));
  },
  setView: (view) => set((s) => ({ ...patchActive(s, { view }), route: "workspace" })),

  setProject(project) {
    const tab = get().tabs.find((t) => t.id === get().activeId)!;
    set((s) => ({ ...patchActive(s, { filter: withProject(tab.filter, project), title: null }), route: "workspace" }));
  },

  openSavedView(view) {
    const active = get().tabs.find((t) => t.id === get().activeId)!;
    if (active.filter.type === "and" && !active.filter.filters.length && active.title === null) {
      set((s) => ({ ...patchActive(s, { filter: view.filter, title: view.name }), route: "workspace" }));
    } else {
      get().openTab({ filter: view.filter, title: view.name, view: active.view });
    }
  },

  saveView(name) {
    const tab = get().tabs.find((t) => t.id === get().activeId)!;
    const view = { id: newId(), name, filter: tab.filter };
    set((s) => ({ savedViews: [...s.savedViews, view], ...patchActive(s, { title: name }) }));
  },

  removeSavedView: (id) => set((s) => ({ savedViews: s.savedViews.filter((v) => v.id !== id) })),
  setRoute: (route) => set({ route }),
  select: (selected) => set({ selected }),
}));

useTabs.subscribe(({ tabs, activeId, savedViews }) => writeStored(KEY, { tabs, activeId, savedViews }));

export const activeTab = (s: Pick<TabsState, "tabs" | "activeId">): Tab => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];

export const allSavedViews = (s: Pick<TabsState, "savedViews">): SavedView[] => [...BUILT_IN_VIEWS, ...s.savedViews];
