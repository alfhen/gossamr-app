import { create } from "zustand";
import type { Collapsed, PeekSectionId } from "./peekLogic";
import { PEEK_DEFAULT, PIP_DEFAULT, storedWidth } from "./paneSizes";
import { parseColumnOrders, type ColumnOrders } from "./columnOrder";
import { readStored, writeStored } from "./storage";
import { AGENTS_GROUPS, type AgentsGroup } from "./agentsLogic";

export const THEMES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEMES)[number];
export const THEME_LABEL: Record<ThemeMode, string> = { auto: "Match system", light: "Light", dark: "Dark" };

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
  /** Kept until step 7b replaces the grouping used by run keyboard order and the workstream sheet. */
  agentsGroup: AgentsGroup;
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPeekWidth(width: number): void;
  setPipWidth(width: number): void;
  /** Opens or closes the palette; opened with `seed`, its search starts with those words. */
  setPaletteOpen(open: boolean, seed?: string): void;
  setPeekSection(id: PeekSectionId, collapsed: boolean): void;
  /** Saves the order of a project's columns; `null` goes back to the default. */
  setColumnOrder(container: string, ids: string[] | null): void;
  setAgentsGroup(group: AgentsGroup): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "theme" | "pipOpen" | "peekWidth" | "pipWidth" | "columnOrder" | "agentsGroup"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: false,
    peekWidth: storedWidth(raw?.peekWidth, PEEK_DEFAULT),
    pipWidth: storedWidth(raw?.pipWidth, PIP_DEFAULT),
    columnOrder: parseColumnOrders(raw?.columnOrder),
    // Stored as `agentsGroupBy`, so that everyone starts on Workstream once; `agentsGroup` held the old default.
    agentsGroup: AGENTS_GROUPS.find((g) => g === (raw as Record<string, unknown> | null)?.agentsGroupBy) ?? "workstream",
  };
}

export const usePrefs = create<Prefs>((set) => ({
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
  setAgentsGroup: (agentsGroup) => set({ agentsGroup }),
}));

usePrefs.subscribe(({ theme, peekWidth, pipWidth, columnOrder, agentsGroup }) => writeStored(KEY, { theme, peekWidth, pipWidth, columnOrder, agentsGroupBy: agentsGroup }));

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
