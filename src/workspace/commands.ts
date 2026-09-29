import { itemKey } from "../lib/filter";
import type { ContainerRef, WorkContainer, WorkFilter, WorkItem } from "../types";
import type { SavedView } from "./filters";
import { THEMES, THEME_LABEL, type ThemeMode } from "./prefs";
import { VIEW_LABEL, VIEW_MODES, type ViewMode } from "./tabsStore";

export interface Command {
  id: string;
  group: "Go to" | "View" | "Filter" | "Theme" | "App" | "Ticket";
  label: string;
  hint?: string;
  /** Extra words that should find the command. */
  keywords?: string;
  run(): void;
}

export interface CommandActions {
  goToProject(project: ContainerRef | null): void;
  openSavedView(view: SavedView): void;
  setView(view: ViewMode): void;
  addFilter(filter: WorkFilter): void;
  clearFilters(): void;
  setTheme(theme: ThemeMode): void;
  openSettings(): void;
  openActivity(): void;
  newTab(): void;
  togglePip(): void;
  jumpToItem(item: WorkItem): void;
}

const FILTERS: { id: string; label: string; keywords: string; filter: WorkFilter }[] = [
  { id: "mine", label: "Assigned to me", keywords: "mine my tickets", filter: { type: "mine" } },
  { id: "needs-me", label: "Needs me", keywords: "waiting reply mention", filter: { type: "needsMe" } },
  { id: "stale", label: "Stale", keywords: "old quiet no update", filter: { type: "stale", days: 5 } },
  { id: "blocked", label: "Blocked", keywords: "stuck blocker", filter: { type: "blocked" } },
  { id: "unassigned", label: "Unassigned", keywords: "nobody free", filter: { type: "unassigned" } },
  { id: "open", label: "Not done", keywords: "open", filter: { type: "open" } },
];

export function buildCommands(containers: readonly WorkContainer[], savedViews: readonly SavedView[], a: CommandActions): Command[] {
  return [
    ...containers.map(
      (c): Command => ({ id: `project:${c.key}`, group: "Go to", label: c.name, hint: c.key, keywords: `project ${c.key}`, run: () => a.goToProject(c.ref) }),
    ),
    { id: "project:all", group: "Go to", label: "All projects", keywords: "everything clear project", run: () => a.goToProject(null) },
    ...savedViews.map((v): Command => ({ id: `view:${v.id}`, group: "Go to", label: v.name, hint: "Saved view", keywords: "saved view", run: () => a.openSavedView(v) })),
    ...VIEW_MODES.map((v): Command => ({ id: `mode:${v}`, group: "View", label: `Show ${VIEW_LABEL[v]}`, keywords: "switch view layout", run: () => a.setView(v) })),
    ...FILTERS.map(
      (f): Command => ({ id: `filter:${f.id}`, group: "Filter", label: `Filter: ${f.label}`, keywords: f.keywords, run: () => a.addFilter(f.filter) }),
    ),
    { id: "filter:clear", group: "Filter", label: "Clear filters", keywords: "reset remove", run: a.clearFilters },
    ...THEMES.map((t): Command => ({ id: `theme:${t}`, group: "Theme", label: `Theme: ${THEME_LABEL[t]}`, keywords: "appearance colours", run: () => a.setTheme(t) })),
    { id: "app:settings", group: "App", label: "Open settings", keywords: "preferences", run: a.openSettings },
    { id: "app:activity", group: "App", label: "Open activity", run: a.openActivity },
    { id: "app:tab", group: "App", label: "New tab", hint: "Workspace", run: a.newTab },
    { id: "app:pip", group: "App", label: "Toggle Pip", hint: "⌘J", keywords: "assistant chat claude", run: a.togglePip },
  ];
}

function score(text: string, q: string): number | null {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 0;
  if (t.split(/[\s:/-]+/).some((w) => w.startsWith(q))) return 1;
  return t.includes(q) ? 2 : null;
}

/** Commands that match every word of the query, best matches first. Everything, in order, when the query is empty. */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...commands];
  const ranked: { command: Command; rank: number }[] = [];
  for (const command of commands) {
    const fields = [command.label, command.hint ?? "", command.keywords ?? ""];
    const perWord = words.map((w) => Math.min(...fields.map((f) => score(f, w) ?? Infinity)));
    if (perWord.every(Number.isFinite)) ranked.push({ command, rank: perWord.reduce((a, b) => a + b, 0) });
  }
  return ranked.sort((x, y) => x.rank - y.rank).map((r) => r.command);
}

/** Tickets whose key or title matches, exact keys first. */
export function ticketCommands(items: readonly WorkItem[], query: string, jump: (item: WorkItem) => void, limit = 8): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches: { item: WorkItem; rank: number }[] = [];
  for (const item of items) {
    const key = item.item.key.toLowerCase();
    const rank = key === q ? 0 : key.startsWith(q) ? 1 : item.title.toLowerCase().includes(q) ? 2 : null;
    if (rank !== null) matches.push({ item, rank });
  }
  return matches
    .sort((a, b) => a.rank - b.rank || b.item.updated.localeCompare(a.item.updated))
    .slice(0, limit)
    .map(({ item }): Command => ({ id: `ticket:${itemKey(item.item)}`, group: "Ticket", label: item.title, hint: item.item.key, run: () => jump(item) }));
}
