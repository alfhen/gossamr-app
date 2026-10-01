import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Collapsed, PeekSectionId } from "./peekLogic";
import { PEEK_DEFAULT, PIP_DEFAULT, storedWidth } from "./paneSizes";
import { parseColumnOrders, type ColumnOrders } from "./columnOrder";
import { readStored, writeStored } from "./storage";

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
  /** Peek sections the person folded. Kept for the session only. */
  peekCollapsed: Collapsed;
  /** Board column order the person chose, per project. */
  columnOrder: ColumnOrders;
  /** Whether the Agents view is offered in the desktop app. The browser build always offers it. */
  agentsEnabled: boolean;
  agentsView: AgentsViewMode;
  /** The person dismissed the explainer on the Agents view. */
  agentsIntroSeen: boolean;
  setUi(ui: UiMode): void;
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPeekWidth(width: number): void;
  setPipWidth(width: number): void;
  setPaletteOpen(open: boolean): void;
  setPeekSection(id: PeekSectionId, collapsed: boolean): void;
  /** Saves the order of a project's columns; `null` goes back to the default. */
  setColumnOrder(container: string, ids: string[] | null): void;
  setAgentsEnabled(enabled: boolean): void;
  setAgentsView(view: AgentsViewMode): void;
  setAgentsIntroSeen(seen: boolean): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "ui" | "uiChosen" | "theme" | "pipOpen" | "peekWidth" | "pipWidth" | "columnOrder" | "agentsEnabled" | "agentsView" | "agentsIntroSeen"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    // Installs from before the workspace was the default stored "classic" without anyone choosing it.
    ui: raw?.uiChosen === true && raw.ui === "classic" ? "classic" : "workspace",
    uiChosen: raw?.uiChosen === true,
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: raw?.pipOpen === true,
    peekWidth: storedWidth(raw?.peekWidth, PEEK_DEFAULT),
    pipWidth: storedWidth(raw?.pipWidth, PIP_DEFAULT),
    columnOrder: parseColumnOrders(raw?.columnOrder),
    agentsEnabled: raw?.agentsEnabled === true,
    agentsView: AGENTS_VIEWS.find((v) => v === raw?.agentsView) ?? "cards",
    agentsIntroSeen: raw?.agentsIntroSeen === true,
  };
}

export const usePrefs = create<Prefs>((set) => ({
  ...loadPrefs(),
  paletteOpen: false,
  peekCollapsed: {},
  setUi: (ui) => set({ ui, uiChosen: true }),
  setTheme: (theme) => set({ theme }),
  setPipOpen: (pipOpen) => set({ pipOpen }),
  setPeekWidth: (peekWidth) => set({ peekWidth }),
  setPipWidth: (pipWidth) => set({ pipWidth }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setPeekSection: (id, collapsed) => set((s) => ({ peekCollapsed: { ...s.peekCollapsed, [id]: collapsed } })),
  setColumnOrder: (container, ids) =>
    set((s) => {
      const { [container]: _dropped, ...rest } = s.columnOrder;
      return { columnOrder: ids ? { ...rest, [container]: ids } : rest };
    }),
  setAgentsEnabled: (agentsEnabled) => set({ agentsEnabled }),
  setAgentsView: (agentsView) => set({ agentsView }),
  setAgentsIntroSeen: (agentsIntroSeen) => set({ agentsIntroSeen }),
}));

usePrefs.subscribe(({ ui, uiChosen, theme, pipOpen, peekWidth, pipWidth, columnOrder, agentsEnabled, agentsView, agentsIntroSeen }) =>
  writeStored(KEY, { ui, uiChosen, theme, pipOpen, peekWidth, pipWidth, columnOrder, agentsEnabled, agentsView, agentsIntroSeen }),
);

/** The browser build has no classic inbox to fall back to, so it always shows the workspace. */
export const isWorkspaceUi = () => !isTauri() || usePrefs.getState().ui === "workspace";

export const useWorkspaceUi = () => usePrefs((s) => !isTauri() || s.ui === "workspace");

/** The Agents view is a preview in the desktop app until it is switched on in Settings; the browser build has nothing else to show. */
export const useAgentsEnabled = () => usePrefs((s) => !isTauri() || s.agentsEnabled);

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
