import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
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
  paletteOpen: boolean;
  setUi(ui: UiMode): void;
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "ui" | "uiChosen" | "theme" | "pipOpen"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    // Installs from before the workspace was the default stored "classic" without anyone choosing it.
    ui: raw?.uiChosen === true && raw.ui === "classic" ? "classic" : "workspace",
    uiChosen: raw?.uiChosen === true,
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: raw?.pipOpen === true,
  };
}

export const usePrefs = create<Prefs>((set) => ({
  ...loadPrefs(),
  paletteOpen: false,
  setUi: (ui) => set({ ui, uiChosen: true }),
  setTheme: (theme) => set({ theme }),
  setPipOpen: (pipOpen) => set({ pipOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

usePrefs.subscribe(({ ui, uiChosen, theme, pipOpen }) => writeStored(KEY, { ui, uiChosen, theme, pipOpen }));

/** The browser build has no classic inbox to fall back to, so it always shows the workspace. */
export const isWorkspaceUi = () => !isTauri() || usePrefs.getState().ui === "workspace";

export const useWorkspaceUi = () => usePrefs((s) => !isTauri() || s.ui === "workspace");

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
