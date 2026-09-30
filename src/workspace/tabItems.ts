import type { WorkFilter } from "../types";
import { PRESETS, projectOf, sameProject, showsEntry, type SavedView } from "./filters";
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

/** A tab in another project than the active one can't be reached through a preset, which scopes to the active project. */
const stands = (v: SavedView, t: Tab, project: ReturnType<typeof projectOf>) =>
  showsEntry(v.filter, t.filter) && (t.title === null || t.title === v.name) && (projectOf(v.filter) !== null || sameProject(projectOf(t.filter), project));

/**
 * The row above the canvas: the presets, then pinned saved views, then every open tab that none of those stands for
 * (a tab from a palette search, Pip, or a saved view that isn't pinned).
 */
export function buildTabItems(tabs: readonly Tab[], activeId: string, savedViews: readonly SavedView[], labelOf: (tab: Tab) => string): TabItem[] {
  const fixed = [...PRESETS, ...savedViews.filter((v) => v.pinned)];
  const active = tabs.find((t) => t.id === activeId);
  const project = active ? projectOf(active.filter) : null;
  const activeAt = active ? fixed.findIndex((v) => stands(v, active, project)) : -1;
  const items = fixed.map((v, i): TabItem => ({ id: v.id, label: v.name, filter: v.filter, kind: i < PRESETS.length ? "preset" : "view", active: i === activeAt, tabId: null }));
  for (const t of tabs) {
    if (fixed.some((v) => stands(v, t, project))) continue;
    items.push({ id: `tab:${t.id}`, label: labelOf(t), filter: t.filter, kind: "custom", active: t.id === activeId, tabId: t.id });
  }
  return items;
}
