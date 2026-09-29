import { isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";
import { readStored, writeStored } from "./storage";

export const THEMES = ["auto", "light", "dark"] as const;
export type ThemeMode = (typeof THEMES)[number];
export const THEME_LABEL: Record<ThemeMode, string> = { auto: "Match system", light: "Light", dark: "Dark" };

export type UiMode = "classic" | "workspace";

interface Prefs {
  ui: UiMode;
  theme: ThemeMode;
  pipOpen: boolean;
  paletteOpen: boolean;
  setUi(ui: UiMode): void;
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;
}

const KEY = "gossamr-prefs";

function load(): Pick<Prefs, "ui" | "theme" | "pipOpen"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    ui: raw?.ui === "workspace" ? "workspace" : "classic",
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: raw?.pipOpen === true,
  };
}

export const usePrefs = create<Prefs>((set) => ({
  ...load(),
  paletteOpen: false,
  setUi: (ui) => set({ ui }),
  setTheme: (theme) => set({ theme }),
  setPipOpen: (pipOpen) => set({ pipOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

usePrefs.subscribe(({ ui, theme, pipOpen }) => writeStored(KEY, { ui, theme, pipOpen }));

/** The browser build has no classic inbox to fall back to, so it always shows the workspace. */
export const useWorkspaceUi = () => usePrefs((s) => !isTauri() || s.ui === "workspace");

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
