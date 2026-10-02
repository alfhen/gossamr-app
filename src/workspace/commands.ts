import { itemKey } from "../lib/filter";
import type { ContainerRef, Intent, RunKind, WorkContainer, WorkFilter, WorkItem } from "../types";
import type { SavedView } from "./filters";
import { THEMES, THEME_LABEL, type ThemeMode } from "./prefs";
import { CODE_FILTERS, CODE_FILTER_LABEL } from "../lib/devLinks";
import { parsePullRef, pullLabel, type PullRef } from "../lib/githubUrl";
import { isWorkConnection } from "./domains";
import { ticketKeyOf } from "./watchLogic";
import { VIEW_LABEL, VIEW_MODES, type ViewMode } from "./tabsStore";

export type CommandGroup = "Create" | "Projects" | "Views" | "Layout" | "Go to" | "Filters" | "Theme" | "App" | "Tickets" | "GitHub" | "Agents" | "Ask Pip";

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
  manageProjects(): void;
  watch(target: { ref: ContainerRef; name: string }, watched: boolean): void;
  /** Opens a ticket by key in any project, reading it live when it isn't synced. */
  openTicket(key: string): void;
  openActivity(): void;
  openDrafts(): void;
  connectGithub(): void;
  manageRepositories(): void;
  /** Opens the pull request's ticket when one is known, else its page on GitHub. */
  openPull(ref: PullRef): void;
  newTab(): void;
  newTicket(): void;
  togglePip(): void;
  startAgent(): void;
  startAgentOn(item: WorkItem, kind: RunKind): void;
  showAgentsNeedingMe(): void;
  openAgentSafety(): void;
  jumpToItem(item: WorkItem): void;
  askPip(query: string): void;
}

/** What the screen shows right now, for the hints beside entries. */
export interface CommandContext {
  project: ContainerRef | null;
  view: ViewMode | null;
  unreadActivity: number;
  pendingDrafts: number;
  /** A GitHub account is connected. */
  github?: boolean;
  agents?: boolean;
  /** Agents waiting on the person, for the hint beside "Show agents that need me". */
  agentsNeedingMe?: number;
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
    { id: "project:manage", group: "Projects", icon: "⚙", label: "Manage projects", keywords: "watch unwatch watching choose which projects sync pin", run: a.manageProjects },
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
    ...(ctx.github
      ? CODE_FILTERS.map(
          (k): Command => ({ id: `filter:code-${k}`, group: "Filters", icon: "⏷", label: `Filter: ${CODE_FILTER_LABEL[k]}`, keywords: "github pull request pr checks ci code", run: () => a.addFilter({ type: "code", check: k }) }),
        )
      : []),
    { id: "filter:clear", group: "Filters", icon: "⏷", label: "Clear filters", keywords: "reset remove", run: a.clearFilters },
    { id: "github:connect", group: "GitHub", icon: "↗", label: ctx.github ? "Connect another GitHub account" : "Connect GitHub", keywords: "sign in token pull requests code", run: a.connectGithub },
    ...(ctx.github ? [{ id: "github:repos", group: "GitHub" as const, icon: "⚙", label: "Manage repositories", keywords: "github watch unwatch repos code", run: a.manageRepositories }] : []),
    ...THEMES.map((t): Command => ({ id: `theme:${t}`, group: "Theme", icon: "◐", label: `Theme: ${THEME_LABEL[t]}`, keywords: "appearance colours", run: () => a.setTheme(t) })),
    ...(ctx.agents
      ? [
          { id: "agents:start", group: "Agents" as const, icon: ">_", label: "Start an agent…", hint: "n", keywords: "run claude investigate background task", run: a.startAgent },
          { id: "agents:needs", group: "Agents" as const, icon: "✋", label: "Show agents that need me", hint: ctx.agentsNeedingMe ? `${ctx.agentsNeedingMe} waiting` : undefined, keywords: "agents waiting permission question blocked", run: a.showAgentsNeedingMe },
          { id: "agents:stop", group: "Agents" as const, icon: "■", label: "Stop all agents…", keywords: "agents halt kill end everything", run: a.openAgentSafety },
          { id: "agents:safety", group: "Agents" as const, icon: "⛨", label: "Agent safety and settings", keywords: "agents touch permissions", run: a.openAgentSafety },
        ]
      : []),
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

const AGENT_VERBS: { kind: RunKind; words: RegExp; label: string }[] = [
  { kind: "investigate", words: /\b(?:investigate|investigation)\b/i, label: "Investigate" },
  { kind: "triage", words: /^\s*triage\b/i, label: "Triage" },
  { kind: "build", words: /^\s*build\b/i, label: "Build" },
  { kind: "review", words: /^\s*review\b/i, label: "Review the PR on" },
  { kind: "verify", words: /^\s*(?:verify|check)\b/i, label: "Verify" },
];
const AGENT_WORDS = /\b(?:investigate|investigation|triage|build|review|verify|check|agent|start)\b/gi;

/**
 * "Investigate <ticket>" entries for a query that asks for one: it names the action, and the rest of the words find
 * the ticket. Without such a word the tickets stay plain jumps. The other kinds are offered only when the query
 * starts with their word, since "review" and "build" are also ordinary words in a ticket title. A bare "agent"
 * means investigate.
 */
export function agentCommands(items: readonly WorkItem[], query: string, run: (item: WorkItem, kind: RunKind) => void, limit = 5): Command[] {
  const verb = AGENT_VERBS.find((v) => v.words.test(query)) ?? (/\bagent/i.test(query) ? AGENT_VERBS[0] : null);
  if (!verb) return [];
  const rest = query.replace(AGENT_WORDS, " ").trim();
  const found = rest ? ticketCommands(items, rest, () => {}, limit).map((c) => c.id.slice("ticket:".length)) : [...items].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit).map((i) => itemKey(i.item));
  const byKey = new Map(items.map((i) => [itemKey(i.item), i]));
  return found.flatMap((id) => {
    const item = byKey.get(id);
    return item ? [{ id: `${verb.kind}:${id}`, group: "Agents" as const, icon: ">_", label: `${verb.label} ${item.item.key}  ${item.title}`, hint: "agent", keywords: "start an agent", run: () => run(item, verb.kind) }] : [];
  });
}

/** The ticket picker for "Start an agent…": no ticket first, then the ones that match, or the latest when nothing is typed. */
export function agentTicketChoices(items: readonly WorkItem[], query: string, pick: (item: WorkItem | null) => void, limit = 8): Command[] {
  const none: Command = { id: "agent:none", group: "Agents", icon: "·", label: "Investigate something (no ticket)", hint: "↵", keywords: "without none free form question prompt", run: () => pick(null) };
  const q = query.trim();
  const tickets = q
    ? ticketCommands(items, q, pick, limit)
    : [...items]
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, limit)
        .map((item): Command => ({ id: `ticket:${itemKey(item.item)}`, group: "Tickets", icon: "·", label: item.title, hint: item.item.key, run: () => pick(item) }));
  return [...tickets, ...(q && !/^\s*(no|investigate)\b/i.test(q) ? [] : [none])];
}

/** Projects the person doesn't watch that match the search, each a way to start watching it. */
export function watchCommands(unwatched: readonly { ref: ContainerRef; key: string; name: string }[], a: Pick<CommandActions, "watch">, limit = 5): Command[] {
  return unwatched.slice(0, limit).map((c): Command => {
    const code = !isWorkConnection(c.ref.connectionId);
    return {
      id: `watch:${c.ref.connectionId}:${c.ref.externalId}`,
      group: code ? "GitHub" : "Projects",
      icon: "＋",
      label: code ? `Watch repository ${c.key}` : `Watch ${c.name}`,
      hint: code ? "not watched" : `${c.key} · not watched`,
      keywords: `watch ${c.key} ${c.name}`,
      run: () => a.watch(c, true),
    };
  });
}

/** One "Unwatch" per watched project, for a query that asks to stop watching. */
export function unwatchCommands(containers: readonly WorkContainer[], query: string, a: Pick<CommandActions, "watch">): Command[] {
  if (!/^\s*(unwatch|stop watching)/i.test(query)) return [];
  return containers.map(
    (c): Command => ({ id: `unwatch:${c.key}`, group: "Projects", icon: "－", label: `Unwatch ${c.name}`, hint: c.key, keywords: `${c.key} stop watching remove`, run: () => a.watch(c, false) }),
  );
}

/** For a query that is a ticket key not in the synced items: opens it in any project, read live. */
export function keyCommand(query: string, items: readonly WorkItem[], open: (key: string) => void): Command[] {
  const key = ticketKeyOf(query);
  if (!key || items.some((i) => i.item.key.toUpperCase() === key)) return [];
  return [{ id: `key:${key}`, group: "Tickets", icon: "↗", label: `Open ${key}`, hint: "look up live", keywords: key, run: () => open(key) }];
}

/** For a query that names a pull request, as `owner/repo#123` or by its address: opens its ticket, else its page on GitHub. */
export function pullCommand(query: string, open: (ref: PullRef) => void): Command[] {
  const ref = parsePullRef(query);
  if (!ref) return [];
  return [{ id: `pull:${pullLabel(ref)}`, group: "GitHub", icon: "↗", label: `Open PR ${pullLabel(ref)}`, hint: "ticket or GitHub", keywords: `${ref.repo} pull request`, run: () => open(ref) }];
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
