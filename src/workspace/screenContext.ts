import type { ContainerRef, ItemRef, ScreenContext, WorkContainer, WorkItem } from "../types";
import { projectOf } from "./filters";
import { containerKey, withoutCode } from "../lib/filter";
import { CHIP_LABEL, type ActivityChip } from "./activityLogic";
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
  /** The Activity feed's filter chip and project. */
  activity: { chip: ActivityChip; container: ContainerRef | null };
  /** The run open in the run sheet and how many agents wait on the person; absent while agents are off. */
  agents?: { openRun: string | null; waiting: number };
}

const plural = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

const projectName = (containers: Screen["containers"], project: ContainerRef | null) => (project ? (containers[containerKey(project)]?.key ?? "Project") : "All projects");

/** What the person is looking at, as a line: "Board · DEVOPS · 12 items", "Activity · Mentions · DEVOPS" or "Settings". */
export function screenLine(s: Pick<Screen, "route" | "tab" | "shown" | "containers" | "activity">): string {
  if (s.route === "settings") return "Settings";
  if (s.route === "activity") return `Activity · ${CHIP_LABEL[s.activity.chip]} · ${projectName(s.containers, s.activity.container)}`;
  return `${VIEW_LABEL[s.tab.view]} · ${projectName(s.containers, projectOf(s.tab.filter))} · ${plural(s.shown.length)}`;
}

/** The context Pip is asked with. The open item is included only if it is still in the cache; on Settings there is no open item, and Activity has no view filter or ticked cards. */
export function buildScreenContext(s: Screen): ScreenContext {
  const open = s.route !== "settings" && s.selected ? (s.items[s.selected] ?? s.peeked?.[s.selected]) : undefined;
  const onBoard = s.route === "workspace";
  // Filters over linked code exist only in the page, and the backend rejects a filter it can't parse.
  const filter = withoutCode(s.tab.filter);
  const filtered = onBoard && (filter.type !== "and" || filter.filters.length > 0);
  return {
    view: screenLine(s),
    item: open?.item ?? null,
    filter: filtered ? filter : null,
    selection: onBoard ? s.marked.flatMap((k) => (s.items[k] ? [s.items[k].item] : [])) : [],
    ...(s.agents ? { run: s.agents.openRun, runsWaiting: s.agents.waiting } : {}),
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
    ...(ctx.runsWaiting ? [`Agents waiting on you: ${ctx.runsWaiting}`] : []),
    ...(ctx.filter ? [`Filter: ${words.describeFilter(ctx.filter)}`] : []),
    ...(ctx.selection.length ? [`Ticked tickets: ${ctx.selection.map((r) => r.key).join(", ")}`] : []),
    ...(quote ? [`Selected text: “${clip(quote.replace(/\s+/g, " "), 90)}”`] : []),
  ];
}

/** The chip's two parts: what kind of thing Pip is looking at, and its name. */
export function contextLabel(ctx: ScreenContext, quote: string | null, titleOf: ContextWords["titleOf"]): { kind: string; label: string } {
  const plus = quote ? " + selection" : "";
  if (ctx.item) {
    const title = titleOf(ctx.item);
    return { kind: "Ticket", label: `${ctx.item.key}${title ? ` · ${title}` : ""}${plus}` };
  }
  return { kind: "Screen", label: `${ctx.view ?? "Workspace"}${plus}` };
}
