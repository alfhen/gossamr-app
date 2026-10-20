import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Collapsed, PeekSectionId } from "./peekLogic";
import { PEEK_DEFAULT, PIP_DEFAULT, storedWidth } from "./paneSizes";
import { parseColumnOrders, type ColumnOrders } from "./columnOrder";
import { readStored, writeStored } from "./storage";
import { AGENTS_GROUPS, type AgentsGroup } from "./agentsLogic";
import { dismissed, forget, parseLearning, type ClarityLearning } from "../lib/clarityLearning";
import type { ClarityGap } from "../lib/ticketClarity";
import { keepPlan, parseWeekPlans, reopenItem, type PlanItem, type WeekPlans } from "../lib/planMyWeek";

export const THEMES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEMES)[number];
export const THEME_LABEL: Record<ThemeMode, string> = { auto: "Match system", light: "Light", dark: "Dark" };

export type UiMode = "classic" | "workspace";

export const AGENTS_VIEWS = ["cards", "list"] as const;
export type AgentsViewMode = (typeof AGENTS_VIEWS)[number];

interface Prefs {
  ui: UiMode;
  /** Whether the person picked `ui` themselves, as opposed to it being the default. */
  uiChosen: boolean;
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
  /** The person dismissed the explainer on the Agents view. */
  agentsIntroSeen: boolean;
  /** The person dismissed the orientation card in the Pip drawer. */
  pipOrientationSeen: boolean;
  /** The person dismissed the one-time explainer of Allow once and Deny on a permission prompt. */
  permissionExplainerSeen: boolean;
  /** What "Looks fine" has taught the clarity notice: how often each gap was dismissed, per Jira project (`src/lib/clarityLearning.ts`). */
  clarityLearning: ClarityLearning;
  /** The plans the person kept in Plan my week, by ISO week (`src/lib/planMyWeek.ts`). Local to this app; nothing of it goes to Jira. */
  weekPlans: WeekPlans;
  /** Open on Agents rather than the workspace, while Agents are on. On until the person turns it off. */
  startOnAgents: boolean;
  setUi(ui: UiMode): void;
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
  setAgentsIntroSeen(seen: boolean): void;
  setPipOrientationSeen(seen: boolean): void;
  setPermissionExplainerSeen(seen: boolean): void;
  setStartOnAgents(on: boolean): void;
  /** Keeps `items` as the plan for the week `now` is in, replacing the one kept before. */
  keepWeekPlan(items: readonly PlanItem[], now?: Date): void;
  /** Takes a ticked item of week `week`'s kept plan back: open again, kept. */
  reopenWeekPlanItem(week: string, id: string): void;
  /** Counts one "Looks fine" on a ticket of `project` whose notice named `gaps`; returns the gaps that are no longer flagged there from now on. */
  recordClarityDismissal(project: string, gaps: readonly ClarityGap[]): ClarityGap[];
  /** Forgets what "Looks fine" taught, for one project or (with none) all of them. */
  resetClarityLearning(project?: string, gaps?: readonly ClarityGap[]): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "ui" | "uiChosen" | "theme" | "pipOpen" | "peekWidth" | "pipWidth" | "columnOrder" | "agentsView" | "agentsGroup" | "agentsIntroSeen" | "pipOrientationSeen" | "permissionExplainerSeen" | "startOnAgents" | "clarityLearning" | "weekPlans"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    // Installs from before the workspace was the default stored "classic" without anyone choosing it.
    ui: raw?.uiChosen === true && raw.ui === "classic" ? "classic" : "workspace",
    uiChosen: raw?.uiChosen === true,
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: false,
    peekWidth: storedWidth(raw?.peekWidth, PEEK_DEFAULT),
    pipWidth: storedWidth(raw?.pipWidth, PIP_DEFAULT),
    columnOrder: parseColumnOrders(raw?.columnOrder),
    agentsView: AGENTS_VIEWS.find((v) => v === raw?.agentsView) ?? "cards",
    // Stored as `agentsGroupBy`, so that everyone starts on Workstream once; `agentsGroup` held the old default.
    agentsGroup: AGENTS_GROUPS.find((g) => g === (raw as Record<string, unknown> | null)?.agentsGroupBy) ?? "workstream",
    agentsIntroSeen: raw?.agentsIntroSeen === true,
    pipOrientationSeen: raw?.pipOrientationSeen === true,
    permissionExplainerSeen: raw?.permissionExplainerSeen === true,
    // Agents is where everyone with Agents on lands; only a person who turned it off stays on the workspace. It was stored as `startOnPipHome`.
    startOnAgents: (raw?.startOnAgents ?? (raw as Record<string, unknown> | null)?.startOnPipHome) !== false,
    clarityLearning: parseLearning(raw?.clarityLearning),
    weekPlans: parseWeekPlans(raw?.weekPlans),
  };
}

export const usePrefs = create<Prefs>((set, get) => ({
  ...loadPrefs(),
  paletteOpen: false,
  paletteSeed: "",
  peekCollapsed: {},
  setUi: (ui) => set({ ui, uiChosen: true }),
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
  setAgentsIntroSeen: (agentsIntroSeen) => set({ agentsIntroSeen }),
  setPipOrientationSeen: (pipOrientationSeen) => set({ pipOrientationSeen }),
  setPermissionExplainerSeen: (permissionExplainerSeen) => set({ permissionExplainerSeen }),
  setStartOnAgents: (startOnAgents) => set({ startOnAgents }),
  keepWeekPlan: (items, now = new Date()) => set((s) => ({ weekPlans: keepPlan(s.weekPlans, items, now) })),
  reopenWeekPlanItem: (week, id) => set((s) => ({ weekPlans: reopenItem(s.weekPlans, week, id) })),
  recordClarityDismissal: (project, gaps) => {
    const next = dismissed(get().clarityLearning, project, gaps);
    set({ clarityLearning: next.learning });
    return next.learned;
  },
  resetClarityLearning: (project, gaps) => set((s) => ({ clarityLearning: forget(s.clarityLearning, project, gaps) })),
}));

usePrefs.subscribe(({ ui, uiChosen, theme, peekWidth, pipWidth, columnOrder, agentsView, agentsGroup, agentsIntroSeen, pipOrientationSeen, permissionExplainerSeen, startOnAgents, clarityLearning, weekPlans }) =>
  writeStored(KEY, { ui, uiChosen, theme, peekWidth, pipWidth, columnOrder, agentsView, agentsGroupBy: agentsGroup, agentsIntroSeen, pipOrientationSeen, permissionExplainerSeen, startOnAgents, clarityLearning, weekPlans }),
);

/** The browser build has no classic inbox to fall back to, so it always shows the workspace. */
export const isWorkspaceUi = () => !isTauri() || usePrefs.getState().ui === "workspace";

export const useWorkspaceUi = () => usePrefs((s) => !isTauri() || s.ui === "workspace");

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
