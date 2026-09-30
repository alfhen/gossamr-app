import type { WorkFilter } from "../types";
import { PRESETS, showsEntry, type SavedView } from "./filters";
import type { Tab } from "./tabsStore";

export interface TabItem {
  id: string;
  label: string;
  filter: WorkFilter;
  kind: "preset" | "view" | "custom";
  active: boolean;
  /** Set for a tab the person opened that no preset or pinned view stands for; it can be closed. */
  tabId: string | null;
}

const stands = (v: SavedView, t: Tab) => showsEntry(v.filter, t.filter) && (t.title === null || t.title === v.name);

/**
 * The row above the canvas: the presets, then pinned saved views, then every open tab that none of those stands for
 * (a tab from a palette search, Pip, or a saved view that isn't pinned).
 */
export function buildTabItems(tabs: readonly Tab[], activeId: string, savedViews: readonly SavedView[], labelOf: (tab: Tab) => string): TabItem[] {
  const fixed = [...PRESETS, ...savedViews.filter((v) => v.pinned)];
  const active = tabs.find((t) => t.id === activeId);
  const activeAt = active ? fixed.findIndex((v) => stands(v, active)) : -1;
  const items = fixed.map((v, i): TabItem => ({ id: v.id, label: v.name, filter: v.filter, kind: i < PRESETS.length ? "preset" : "view", active: i === activeAt, tabId: null }));
  for (const t of tabs) {
    if (fixed.some((v) => stands(v, t))) continue;
    items.push({ id: `tab:${t.id}`, label: labelOf(t), filter: t.filter, kind: "custom", active: t.id === activeId, tabId: t.id });
  }
  return items;
}
