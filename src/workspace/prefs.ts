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
  setUi(ui: UiMode): void;
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPeekWidth(width: number): void;
  setPipWidth(width: number): void;
  setPaletteOpen(open: boolean): void;
  setPeekSection(id: PeekSectionId, collapsed: boolean): void;
  /** Saves the order of a project's columns; `null` goes back to the default. */
  setColumnOrder(container: string, ids: string[] | null): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "ui" | "uiChosen" | "theme" | "pipOpen" | "peekWidth" | "pipWidth" | "columnOrder"> {
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
}));

usePrefs.subscribe(({ ui, uiChosen, theme, pipOpen, peekWidth, pipWidth, columnOrder }) => writeStored(KEY, { ui, uiChosen, theme, pipOpen, peekWidth, pipWidth, columnOrder }));

/** The browser build has no classic inbox to fall back to, so it always shows the workspace. */
export const isWorkspaceUi = () => !isTauri() || usePrefs.getState().ui === "workspace";

export const useWorkspaceUi = () => usePrefs((s) => !isTauri() || s.ui === "workspace");

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
