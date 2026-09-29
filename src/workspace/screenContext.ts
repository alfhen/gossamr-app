import type { ScreenContext, WorkContainer, WorkItem } from "../types";
import { projectOf } from "./filters";
import { containerKey } from "../lib/filter";
import { VIEW_LABEL, type Tab } from "./tabsStore";

interface Screen {
  tab: Tab;
  /** What the tab's filter shows, in the order the canvas shows it. */
  shown: readonly WorkItem[];
  items: Record<string, WorkItem>;
  containers: Record<string, WorkContainer>;
  selected: string | null;
  marked: readonly string[];
}

const plural = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

/** What the person is looking at, as a line: "Board · DEVOPS · 12 items". */
export function screenLine(s: Pick<Screen, "tab" | "shown" | "containers">): string {
  const project = projectOf(s.tab.filter);
  const where = project ? (s.containers[containerKey(project)]?.key ?? "Project") : "All projects";
  return `${VIEW_LABEL[s.tab.view]} · ${where} · ${plural(s.shown.length)}`;
}

/** The context Pip is asked with. The open item is included only if it is still in the cache. */
export function buildScreenContext(s: Screen): ScreenContext {
  const open = s.selected ? s.items[s.selected] : undefined;
  const filtered = s.tab.filter.type !== "and" || s.tab.filter.filters.length > 0;
  return {
    view: screenLine(s),
    item: open?.item ?? null,
    filter: filtered ? s.tab.filter : null,
    selection: s.marked.flatMap((k) => (s.items[k] ? [s.items[k].item] : [])),
  };
}
