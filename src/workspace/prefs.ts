import { create } from "zustand";
import type { Collapsed, PeekSectionId } from "./peekLogic";
import { PEEK_DEFAULT, PIP_DEFAULT, storedWidth } from "./paneSizes";
import { parseColumnOrders, type ColumnOrders } from "./columnOrder";
import { readStored, writeStored } from "./storage";
import { AGENTS_GROUPS, type AgentsGroup } from "./agentsLogic";
import { dismissed, forget, parseLearning, type ClarityLearning } from "../lib/clarityLearning";
import type { ClarityGap } from "../lib/ticketClarity";

export const THEMES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEMES)[number];
export const THEME_LABEL: Record<ThemeMode, string> = { auto: "Match system", light: "Light", dark: "Dark" };

export const AGENTS_VIEWS = ["cards", "list"] as const;
export type AgentsViewMode = (typeof AGENTS_VIEWS)[number];

interface Prefs {
  theme: ThemeMode;
  pipOpen: boolean;
  peekWidth: number;
  pipWidth: number;
  paletteOpen: boolean;
  /** What the palette's search starts with when it opens; kept for the session only. */
  paletteSeed: string;
  /** Peek sections the person folded. Kept for the session only. */
  peekCollapsed: Collapsed;
  /** Board column order the person chose, per project. */
  columnOrder: ColumnOrders;
  agentsView: AgentsViewMode;
  /** Whether the Agents view groups runs by state (its lanes) or by workstream. */
  agentsGroup: AgentsGroup;
  /** What "Looks fine" has taught the clarity notice: how often each gap was dismissed, per Jira project (`src/lib/clarityLearning.ts`). */
  clarityLearning: ClarityLearning;
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPeekWidth(width: number): void;
  setPipWidth(width: number): void;
  /** Opens or closes the palette; opened with `seed`, its search starts with those words. */
  setPaletteOpen(open: boolean, seed?: string): void;
  setPeekSection(id: PeekSectionId, collapsed: boolean): void;
  /** Saves the order of a project's columns; `null` goes back to the default. */
  setColumnOrder(container: string, ids: string[] | null): void;
  setAgentsView(view: AgentsViewMode): void;
  setAgentsGroup(group: AgentsGroup): void;
  /** Counts one "Looks fine" on a ticket of `project` whose notice named `gaps`; returns the gaps that are no longer flagged there from now on. */
  recordClarityDismissal(project: string, gaps: readonly ClarityGap[]): ClarityGap[];
  /** Forgets what "Looks fine" taught, for one project or (with none) all of them. */
  resetClarityLearning(project?: string, gaps?: readonly ClarityGap[]): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "theme" | "pipOpen" | "peekWidth" | "pipWidth" | "columnOrder" | "agentsView" | "agentsGroup" | "clarityLearning"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: false,
    peekWidth: storedWidth(raw?.peekWidth, PEEK_DEFAULT),
    pipWidth: storedWidth(raw?.pipWidth, PIP_DEFAULT),
    columnOrder: parseColumnOrders(raw?.columnOrder),
    agentsView: AGENTS_VIEWS.find((v) => v === raw?.agentsView) ?? "cards",
    // Stored as `agentsGroupBy`, so that everyone starts on Workstream once; `agentsGroup` held the old default.
    agentsGroup: AGENTS_GROUPS.find((g) => g === (raw as Record<string, unknown> | null)?.agentsGroupBy) ?? "workstream",
    clarityLearning: parseLearning(raw?.clarityLearning),
  };
}

export const usePrefs = create<Prefs>((set, get) => ({
  ...loadPrefs(),
  paletteOpen: false,
  paletteSeed: "",
  peekCollapsed: {},
  setTheme: (theme) => set({ theme }),
  setPipOpen: (pipOpen) => set({ pipOpen }),
  setPeekWidth: (peekWidth) => set({ peekWidth }),
  setPipWidth: (pipWidth) => set({ pipWidth }),
  setPaletteOpen: (paletteOpen, seed = "") => set({ paletteOpen, paletteSeed: paletteOpen ? seed : "" }),
  setPeekSection: (id, collapsed) => set((s) => ({ peekCollapsed: { ...s.peekCollapsed, [id]: collapsed } })),
  setColumnOrder: (container, ids) =>
    set((s) => {
      const { [container]: _dropped, ...rest } = s.columnOrder;
      return { columnOrder: ids ? { ...rest, [container]: ids } : rest };
    }),
  setAgentsView: (agentsView) => set({ agentsView }),
  setAgentsGroup: (agentsGroup) => set({ agentsGroup }),
  recordClarityDismissal: (project, gaps) => {
    const next = dismissed(get().clarityLearning, project, gaps);
    set({ clarityLearning: next.learning });
    return next.learned;
  },
  resetClarityLearning: (project, gaps) => set((s) => ({ clarityLearning: forget(s.clarityLearning, project, gaps) })),
}));

usePrefs.subscribe(({ theme, peekWidth, pipWidth, columnOrder, agentsView, agentsGroup, clarityLearning }) =>
  writeStored(KEY, { theme, peekWidth, pipWidth, columnOrder, agentsView, agentsGroupBy: agentsGroup, clarityLearning }),
);

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
