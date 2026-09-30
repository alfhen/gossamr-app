import { itemKey } from "../lib/filter";
import type { ContainerRef, Intent, WorkContainer, WorkFilter, WorkItem } from "../types";
import type { SavedView } from "./filters";
import { THEMES, THEME_LABEL, type ThemeMode } from "./prefs";
import { VIEW_LABEL, VIEW_MODES, type ViewMode } from "./tabsStore";

export type CommandGroup = "Create" | "Projects" | "Views" | "Layout" | "Go to" | "Filters" | "Theme" | "App" | "Tickets" | "Ask Pip";

export interface Command {
  id: string;
  group: CommandGroup;
  label: string;
  icon?: string;
  hint?: string;
  /** Runs without closing the palette, for commands that ask a follow-up question. */
  stay?: boolean;
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
  openDrafts(): void;
  newTab(): void;
  newTicket(): void;
  togglePip(): void;
  jumpToItem(item: WorkItem): void;
  askPip(query: string): void;
}

/** What the screen shows right now, for the hints beside entries. */
export interface CommandContext {
  project: ContainerRef | null;
  view: ViewMode | null;
  unreadActivity: number;
  pendingDrafts: number;
}

const NO_CONTEXT: CommandContext = { project: null, view: null, unreadActivity: 0, pendingDrafts: 0 };

const sameProject = (a: ContainerRef | null, b: ContainerRef) => !!a && a.connectionId === b.connectionId && a.externalId === b.externalId;

const FILTERS: { id: string; label: string; keywords: string; filter: WorkFilter }[] = [
  { id: "mine", label: "Assigned to me", keywords: "mine my tickets", filter: { type: "mine" } },
  { id: "needs-me", label: "Needs me", keywords: "waiting reply mention", filter: { type: "needsMe" } },
  { id: "stale", label: "Stale", keywords: "old quiet no update", filter: { type: "stale", days: 5 } },
  { id: "blocked", label: "Blocked", keywords: "stuck blocker", filter: { type: "blocked" } },
  { id: "unassigned", label: "Unassigned", keywords: "nobody free", filter: { type: "unassigned" } },
  { id: "open", label: "Not done", keywords: "open", filter: { type: "open" } },
];

export function buildCommands(containers: readonly WorkContainer[], savedViews: readonly SavedView[], a: CommandActions, ctx: CommandContext = NO_CONTEXT): Command[] {
  return [
    { id: "create:ticket", group: "Create", icon: "＋", label: "New ticket (Pip drafts it)", keywords: "create new ticket bug task file", stay: true, run: a.newTicket },
    { id: "project:all", group: "Projects", icon: "◧", label: "All projects", hint: ctx.project ? undefined : "current", keywords: "everything clear project", run: () => a.goToProject(null) },
    ...containers.map(
      (c): Command => ({
        id: `project:${c.key}`,
        group: "Projects",
        icon: "◧",
        label: c.name,
        hint: sameProject(ctx.project, c.ref) ? "current" : c.key,
        keywords: `project ${c.key}`,
        run: () => a.goToProject(c.ref),
      }),
    ),
    ...savedViews.map((v): Command => ({ id: `view:${v.id}`, group: "Views", icon: "◎", label: v.name, keywords: "saved view show", run: () => a.openSavedView(v) })),
    ...VIEW_MODES.map(
      (v): Command => ({ id: `mode:${v}`, group: "Layout", icon: "▦", label: `Show ${VIEW_LABEL[v]}`, hint: ctx.view === v ? "current" : undefined, keywords: "switch view layout", run: () => a.setView(v) }),
    ),
    { id: "app:activity", group: "Go to", icon: "→", label: "Open activity", hint: ctx.unreadActivity ? `${ctx.unreadActivity} new` : undefined, keywords: "feed events", run: a.openActivity },
    { id: "app:drafts", group: "Go to", icon: "→", label: "Open drafts", hint: ctx.pendingDrafts ? `${ctx.pendingDrafts} pending` : undefined, keywords: "pip proposals review waiting", run: a.openDrafts },
    { id: "app:settings", group: "Go to", icon: "⚙", label: "Open settings", keywords: "preferences autopilot", run: a.openSettings },
    ...FILTERS.map(
      (f): Command => ({ id: `filter:${f.id}`, group: "Filters", icon: "⏷", label: `Filter: ${f.label}`, keywords: f.keywords, run: () => a.addFilter(f.filter) }),
    ),
    { id: "filter:clear", group: "Filters", icon: "⏷", label: "Clear filters", keywords: "reset remove", run: a.clearFilters },
    ...THEMES.map((t): Command => ({ id: `theme:${t}`, group: "Theme", icon: "◐", label: `Theme: ${THEME_LABEL[t]}`, keywords: "appearance colours", run: () => a.setTheme(t) })),
    { id: "app:tab", group: "App", icon: "▫", label: "New tab", hint: "Workspace", run: a.newTab },
    { id: "app:pip", group: "App", icon: "✦", label: "Toggle Pip", hint: "⌘J", keywords: "assistant chat claude", run: a.togglePip },
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
    .map(({ item }): Command => ({ id: `ticket:${itemKey(item.item)}`, group: "Tickets", icon: "·", label: item.title, hint: item.item.key, run: () => jump(item) }));
}

/** The command that hands the typed words to Pip; last, for any non-empty query. */
export function withAskPip(results: readonly Command[], query: string, ask: (query: string) => void): Command[] {
  const q = query.trim();
  if (!q) return [...results];
  return [...results, { id: "ask:pip", group: "Ask Pip", icon: "✦", label: `Ask Pip: “${q}”`, hint: "↵", run: () => ask(q) }];
}

/** One entry per project for the new-ticket prompt, the one on screen first. */
export function projectChoices(containers: readonly WorkContainer[], query: string, current: ContainerRef | null, pick: (c: WorkContainer) => void): Command[] {
  const all = containers.map(
    (c): Command => ({ id: `new:${c.key}`, group: "Projects", icon: "◧", label: c.name, hint: c.key, keywords: c.key, stay: true, run: () => pick(c) }),
  );
  const first = containers.findIndex((c) => sameProject(current, c.ref));
  if (first > 0) all.unshift(...all.splice(first, 1));
  return rankCommands(all, query);
}

export function newTicketIntent(container: ContainerRef, title: string): Intent {
  return {
    type: "create",
    container,
    fields: { title: title.trim(), body: { blocks: [] }, kind: "task", assignee: null, parent: null, priority: null, labels: [] },
    link: null,
  };
}
