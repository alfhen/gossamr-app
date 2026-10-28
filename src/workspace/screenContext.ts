import type { ContainerRef, ItemRef, Run, ScreenContext, WorkContainer, WorkItem, WorkstreamView } from "../types";
import { projectOf } from "./filters";
import { containerKey, withoutCode } from "../lib/filter";
import { FILTER_LABEL, type InboxFilter } from "./activityLogic";
import { applyFilters, isFiltered, summaryLine, type AgentFilters, type NeedsScope } from "./agentsLogic";
import { VIEW_LABEL, type Route, type Tab } from "./tabsStore";

export interface Screen {
  route: Route;
  tab: Tab;
  /** What the tab's filter shows, in the order the canvas shows it. */
  shown: readonly WorkItem[];
  items: Record<string, WorkItem>;
  /** The ticket open in a read-only peek that isn't in `items`. */
  peeked?: Record<string, WorkItem>;
  containers: Record<string, WorkContainer>;
  selected: string | null;
  marked: readonly string[];
  /** The Inbox's filter. */
  activity: { filter: InboxFilter };
  /** The Work screen's runs and filters, the run open in the run sheet and how many agents wait on the person. */
  agents?: AgentsScene;
  /** The workstream whose detail is open on the Work screen, as `openWorkstreamLine` names it. */
  workstream?: string;
}

/** "Workstream: " and the title of the open workstream whose detail is shown on Work; undefined while none is. */
export function openWorkstreamLine(selected: string | null, list: readonly WorkstreamView[]): string | undefined {
  const ws = selected ? list.find((v) => v.workstream.id === selected && v.workstream.closedAt === null)?.workstream : undefined;
  return ws ? `Workstream: ${ws.title}` : undefined;
}

export interface AgentsScene {
  openRun: string | null;
  /** The agents waiting on the person: the run needs among Needs you. */
  waiting: number;
  /** Everything that needs the person, as Needs you counts it. */
  needsYou: number;
  runs: readonly Run[];
  filters: AgentFilters;
  /** Which runs hold a need, for the Needs you filter. */
  needed?: NeedsScope;
  now: number;
}

/** The runs the Work screen lists, after its filter. */
export const runsShown = (a: AgentsScene): Run[] => applyFilters(a.runs, a.filters, a.needed);

const agentsFilterText = (f: AgentFilters) => (isFiltered(f) ? "Needs you" : "All");

const plural = (n: number, noun = "item") => `${n} ${noun}${n === 1 ? "" : "s"}`;

const projectName = (containers: Screen["containers"], project: ContainerRef | null) => (project ? (containers[containerKey(project)]?.key ?? "Project") : "All projects");

/**
 * What the person is looking at, as a line: "Board · DEVOPS · 12 items", "Inbox · Mentions", "Work · Needs
 * you · 3 runs", "Work · All · 3 runs · Workstream: CA-401 Fix the cart" or "Settings".
 */
export function screenLine(s: Pick<Screen, "route" | "tab" | "shown" | "containers" | "activity" | "agents" | "workstream">): string {
  if (s.route === "settings") return "Settings";
  if (s.route === "agents") return [s.agents ? `Work · ${agentsFilterText(s.agents.filters)} · ${plural(runsShown(s.agents).length, "run")}` : "Work", s.workstream].filter(Boolean).join(" · ");
  if (s.route === "activity") return `Inbox · ${FILTER_LABEL[s.activity.filter]}`;
  return `${VIEW_LABEL[s.tab.view]} · ${projectName(s.containers, projectOf(s.tab.filter))} · ${plural(s.shown.length)}`;
}

/** The context Pip is asked with. The open item is included only if it is still in the cache; on Settings there is no open item, and Inbox and Work have no view filter or ticked cards. */
export function buildScreenContext(s: Screen): ScreenContext {
  const open = s.route !== "settings" && s.selected ? (s.items[s.selected] ?? s.peeked?.[s.selected]) : undefined;
  const onBoard = s.route === "workspace";
  // Filters over linked code exist only in the page, and the backend rejects a filter it can't parse.
  const filter = withoutCode(s.tab.filter);
  const shown = s.route === "agents" && s.agents ? runsShown(s.agents) : [];
  const filtered = onBoard && (filter.type !== "and" || filter.filters.length > 0);
  return {
    view: screenLine(s),
    item: open?.item ?? null,
    filter: filtered ? filter : null,
    selection: onBoard ? s.marked.flatMap((k) => (s.items[k] ? [s.items[k].item] : [])) : [],
    ...(s.agents ? { run: s.agents.openRun, runsWaiting: s.agents.waiting } : {}),
    ...(s.route === "agents" && s.agents && (shown.length || s.agents.needsYou) ? { runsSummary: summaryLine(shown, s.agents.now, s.agents.needsYou) } : {}),
  };
}

export interface ContextWords {
  titleOf(ref: ItemRef): string | null;
  describeFilter(filter: NonNullable<ScreenContext["filter"]>): string;
  /** A line about the pull requests linked to an item, when it has any. */
  developmentOf?(ref: ItemRef): string | null;
  /** What the open run is, such as "Investigate CA-1 · Working". */
  runOf?(id: string): string | null;
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** What Pip can see, one line per thing sent: built from the very context that goes with the question, plus the selected text if any. */
export function contextLines(ctx: ScreenContext, quote: string | null, words: ContextWords): string[] {
  const title = ctx.item ? words.titleOf(ctx.item) : null;
  const development = ctx.item ? words.developmentOf?.(ctx.item) : null;
  const run = ctx.run ? words.runOf?.(ctx.run) : null;
  return [
    `Screen: ${ctx.view ?? "unknown"}`,
    ...(ctx.item ? [`Open ticket: ${ctx.item.key}${title ? ` · ${title}` : ""}`] : []),
    ...(development ? [development] : []),
    ...(run ? [`Open agent run: ${run}`] : []),
    ...(ctx.runsSummary ? [`Runs shown: ${ctx.runsSummary}`] : []),
    ...(ctx.runsWaiting ? [`Agents waiting on you: ${ctx.runsWaiting}`] : []),
    ...(ctx.filter ? [`Filter: ${words.describeFilter(ctx.filter)}`] : []),
    ...(ctx.selection.length ? [`Ticked tickets: ${ctx.selection.map((r) => r.key).join(", ")}`] : []),
    ...(quote ? [`Selected text: “${clip(quote.replace(/\s+/g, " "), 90)}”`] : []),
  ];
}

/** The chip's two parts: what kind of thing Pip is looking at, and its name. */
export function contextLabel(ctx: ScreenContext, quote: string | null, titleOf: ContextWords["titleOf"], runOf?: ContextWords["runOf"]): { kind: string; label: string } {
  const plus = quote ? " + selection" : "";
  if (ctx.item) {
    const title = titleOf(ctx.item);
    return { kind: "Ticket", label: `${ctx.item.key}${title ? ` · ${title}` : ""}${plus}` };
  }
  const run = ctx.run ? runOf?.(ctx.run) : null;
  if (run) return { kind: "Agent run", label: `${run}${plus}` };
  return { kind: "Screen", label: `${ctx.view ?? "Workspace"}${plus}` };
}
