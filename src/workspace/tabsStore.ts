import { create } from "zustand";
import { ALL, and, filterChips } from "../lib/filter";
import type { ContainerRef, WorkFilter } from "../types";
import { BUILT_IN_VIEWS, projectOf, sameProject, scopeTo, showsEntry, withProject, type SavedView } from "./filters";
import { readStored, writeStored } from "./storage";

export const VIEW_MODES = ["board", "list", "map", "age"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const VIEW_LABEL: Record<ViewMode, string> = { board: "Board", list: "List", map: "Map", age: "Age" };

export type Route = "workspace" | "activity" | "settings";

/** A part of Settings that something else can open directly. */
export type SettingsSection = "watching";

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
  /** Keys of the cards ticked for a bulk action; when it is not empty it includes `selected`. */
  marked: string[];
  savedViews: SavedView[];
  /** The section Settings should scroll to when it shows, until it has. */
  settingsSection: SettingsSection | null;
  openTab(init?: Partial<Omit<Tab, "id">>): string;
  closeTab(id: string): void;
  activate(id: string): void;
  setFilter(filter: WorkFilter): void;
  addFilter(filter: WorkFilter): void;
  setView(view: ViewMode): void;
  setProject(project: ContainerRef | null): void;
  openSavedView(view: SavedView): void;
  /** Saves the active tab's filter under `name`; returns the new view's id, or null when the name is blank. */
  saveView(name: string): string | null;
  renameSavedView(id: string, name: string): void;
  /** Moves a saved view one place up (-1) or down (1) among the saved views. */
  moveSavedView(id: string, step: -1 | 1): void;
  pinSavedView(id: string, pinned: boolean): void;
  removeSavedView(id: string): void;
  /** Shows a preset or pinned view: switches to a tab already showing it, otherwise re-filters the active tab, always keeping the project. */
  showView(filter: WorkFilter): void;
  setRoute(route: Route): void;
  openSettings(section?: SettingsSection): void;
  select(key: string | null): void;
  /** Ticks a card without losing the others: `toggle` adds or removes it, `range` ticks everything from the selected card to it in `order`. */
  mark(key: string, how: "toggle" | "range", order: readonly string[]): void;
  clearMarks(): void;
  /** Back to one blank tab and no saved views, for when another account is shown. */
  reset(): void;
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

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const nameTaken = (views: readonly SavedView[], name: string, except: string | null = null) => views.some((v) => v.id !== except && sameName(v.name, name));

/** Keeps the first of views sharing an id, or a name and filter, and pins the survivor if any of them was pinned. */
export function dedupeViews(views: readonly SavedView[]): SavedView[] {
  const out: SavedView[] = [];
  for (const v of views) {
    const at = out.findIndex((o) => o.id === v.id || (sameName(o.name, v.name) && JSON.stringify(o.filter) === JSON.stringify(v.filter)));
    if (at < 0) out.push(v);
    else if (v.pinned && !out[at].pinned) out[at] = { ...out[at], pinned: true };
  }
  return out;
}

function parseView(v: unknown): SavedView | null {
  const raw = v as Partial<SavedView> | null;
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || !isFilter(raw.filter)) return null;
  return { id: raw.id, name: raw.name, filter: raw.filter, ...(raw.pinned === true ? { pinned: true } : {}) };
}

export function loadTabs(): Pick<TabsState, "tabs" | "activeId" | "savedViews"> {
  const raw = readStored(KEY) as { tabs?: unknown; activeId?: unknown; savedViews?: unknown } | null;
  const tabs = (Array.isArray(raw?.tabs) ? raw.tabs : []).map(parseTab).filter((t): t is Tab => t !== null);
  const savedViews = dedupeViews((Array.isArray(raw?.savedViews) ? raw.savedViews : []).map(parseView).filter((v): v is SavedView => v !== null));
  if (!tabs.length) tabs.push(blankTab());
  return { tabs, activeId: tabs.find((t) => t.id === raw?.activeId)?.id ?? tabs[0].id, savedViews };
}

/** The ticks after a shift or cmd click on `key`. The selected card counts as ticked once a second one is. */
export function nextMarked(marked: readonly string[], selected: string | null, key: string, how: "toggle" | "range", order: readonly string[]): string[] {
  const base = marked.length ? [...marked] : selected ? [selected] : [];
  if (how === "range") {
    const [from, to] = [order.indexOf(selected ?? key), order.indexOf(key)];
    if (from < 0 || to < 0) return base.includes(key) ? base : [...base, key];
    const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return [...base, ...span.filter((k) => !base.includes(k))];
  }
  const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
  return next.length === 1 && next[0] === selected ? [] : next;
}

/** Leaving a route closes the peek: its item belongs to the screen it was opened on. */
const routeTo = (s: Pick<TabsState, "route">, route: Route) => (route === s.route ? {} : { route, selected: null, marked: [] });

const patchActive = (s: TabsState, patch: Partial<Tab>) => ({ tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, ...patch } : t)) });

export const useTabs = create<TabsState>((set, get) => ({
  ...loadTabs(),
  route: "workspace",
  settingsSection: null,
  selected: null,
  marked: [],

  openTab(init = {}) {
    const tab = { ...blankTab(), ...init };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, ...routeTo(s, "workspace") }));
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

  activate: (id) => set((s) => (s.tabs.some((t) => t.id === id) ? { activeId: id, ...routeTo(s, "workspace") } : s)),
  // Any hand-made filter change drops the name a saved view or project gave the tab.
  setFilter: (filter) => set((s) => patchActive(s, { filter, title: null })),
  addFilter(filter) {
    const tab = activeTab(get());
    const have = new Set(filterChips(tab.filter).map((c) => JSON.stringify(c)));
    if (!have.has(JSON.stringify(filter))) get().setFilter(and(tab.filter, filter));
  },
  setView: (view) => set((s) => ({ ...patchActive(s, { view }), ...routeTo(s, "workspace") })),

  setProject(project) {
    const tab = get().tabs.find((t) => t.id === get().activeId)!;
    set((s) => ({ ...patchActive(s, { filter: withProject(tab.filter, project), title: null }), ...routeTo(s, "workspace") }));
  },

  openSavedView(view) {
    const active = get().tabs.find((t) => t.id === get().activeId)!;
    if (active.filter.type === "and" && !active.filter.filters.length && active.title === null) {
      set((s) => ({ ...patchActive(s, { filter: view.filter, title: view.name }), ...routeTo(s, "workspace") }));
    } else {
      get().openTab({ filter: view.filter, title: view.name, view: active.view });
    }
  },

  saveView(name) {
    const title = name.trim();
    if (!title) return null;
    const tab = activeTab(get());
    const view = { id: newId(), name: title, filter: tab.filter };
    set((s) => ({ savedViews: [...s.savedViews, view], ...patchActive(s, { title }) }));
    return view.id;
  },

  renameSavedView(id, name) {
    const title = name.trim();
    const view = get().savedViews.find((v) => v.id === id);
    if (!title || !view || nameTaken(get().savedViews, title, id)) return;
    set((s) => ({
      savedViews: s.savedViews.map((v) => (v.id === id ? { ...v, name: title } : v)),
      tabs: s.tabs.map((t) => (t.title === view.name && JSON.stringify(t.filter) === JSON.stringify(view.filter) ? { ...t, title } : t)),
    }));
  },

  moveSavedView(id, step) {
    set((s) => {
      const from = s.savedViews.findIndex((v) => v.id === id);
      const to = from + step;
      if (from < 0 || to < 0 || to >= s.savedViews.length) return s;
      const savedViews = [...s.savedViews];
      [savedViews[from], savedViews[to]] = [savedViews[to], savedViews[from]];
      return { savedViews };
    });
  },

  pinSavedView: (id, pinned) => set((s) => ({ savedViews: s.savedViews.map((v) => (v.id === id ? { ...v, pinned } : v)) })),

  removeSavedView: (id) => set((s) => ({ savedViews: s.savedViews.filter((v) => v.id !== id) })),

  showView(filter) {
    const s = get();
    const project = projectOf(activeTab(s).filter);
    const scoped = scopeTo(filter, project);
    const existing = s.tabs.find((t) => t.title === null && showsEntry(scoped, t.filter) && sameProject(projectOf(t.filter), projectOf(scoped)));
    if (existing) set({ activeId: existing.id, route: "workspace" });
    else set((st) => ({ ...patchActive(st, { filter: scoped, title: null }), route: "workspace" }));
  },
  setRoute: (route) => set((s) => routeTo(s, route)),
  openSettings: (section) => set((s) => ({ ...routeTo(s, "settings"), settingsSection: section ?? null })),
  select: (selected) => set({ selected, marked: [] }),
  mark: (key, how, order) =>
    set((s) => {
      const marked = nextMarked(s.marked, s.selected, key, how, order);
      return { marked, selected: marked.includes(key) ? key : (marked[marked.length - 1] ?? s.selected) };
    }),
  clearMarks: () => set({ marked: [] }),
  reset() {
    const tab = blankTab();
    set({ tabs: [tab], activeId: tab.id, savedViews: [], route: "workspace", selected: null, marked: [] });
  },
}));

useTabs.subscribe(({ tabs, activeId, savedViews }) => writeStored(KEY, { tabs, activeId, savedViews }));

export const activeTab = (s: Pick<TabsState, "tabs" | "activeId">): Tab => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];

export const allSavedViews = (s: Pick<TabsState, "savedViews">): SavedView[] => [...BUILT_IN_VIEWS, ...s.savedViews];
