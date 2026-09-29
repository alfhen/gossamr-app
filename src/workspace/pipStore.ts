import { create } from "zustand";
import type { WorkFilter } from "../types";
import { readStored, writeStored } from "./storage";
import { activeTab, useTabs } from "./tabsStore";

/** The last filter Pip put on a tab, with what it replaced, so the person can take it back. */
export interface PipFiltered {
  tabId: string;
  before: WorkFilter;
  beforeTitle: string | null;
  filter: WorkFilter;
  note: string;
}

interface PipState {
  filtered: PipFiltered | null;
  /** Nudges the person has closed, by kind; they stay closed. */
  dismissed: string[];
  applyFilter(filter: WorkFilter, note: string): void;
  undoFilter(): void;
  clearFiltered(): void;
  dismiss(kind: string): void;
}

const KEY = "gossamr-pip";

const loadDismissed = (): string[] => {
  const raw = readStored(KEY) as { dismissed?: unknown } | null;
  return Array.isArray(raw?.dismissed) ? raw.dismissed.filter((d): d is string => typeof d === "string") : [];
};

export const usePip = create<PipState>((set, get) => ({
  filtered: null,
  dismissed: loadDismissed(),

  applyFilter(filter, note) {
    const tabs = useTabs.getState();
    const tab = activeTab(tabs);
    set({ filtered: { tabId: tab.id, before: tab.filter, beforeTitle: tab.title, filter, note } });
    tabs.setFilter(filter);
    tabs.setRoute("workspace");
  },

  undoFilter() {
    const f = get().filtered;
    if (!f) return;
    useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === f.tabId ? { ...t, filter: f.before, title: f.beforeTitle } : t)) }));
    set({ filtered: null });
  },

  clearFiltered: () => set({ filtered: null }),
  dismiss: (kind) => set((s) => (s.dismissed.includes(kind) ? s : { dismissed: [...s.dismissed, kind] })),
}));

usePip.subscribe(({ dismissed }) => writeStored(KEY, { dismissed }));

/** Whether the chip still describes the tab: the person may have changed the filter by hand since. */
export const isStillFiltered = (f: PipFiltered | null, tab: { id: string; filter: WorkFilter }): f is PipFiltered =>
  !!f && f.tabId === tab.id && JSON.stringify(f.filter) === JSON.stringify(tab.filter);

export type NudgeKind = "empty-filter" | "large-list";
export const LARGE_LIST = 25;

/** A nudge worth showing for a canvas of `count` items under a filter with `chips` conditions, if the person hasn't closed it. */
export function nudgeFor(count: number, chips: number, dismissed: readonly string[]): { kind: NudgeKind; text: string } | null {
  const pick = (kind: NudgeKind, text: string) => (dismissed.includes(kind) ? null : { kind, text });
  if (count === 0 && chips > 0) return pick("empty-filter", "Nothing matches this filter. Want me to find what you meant?");
  if (count >= LARGE_LIST) return pick("large-list", "I can help you filter tasks in this view. Just tell me what to show.");
  return null;
}
