import { create } from "zustand";
import type { Backend } from "../backend/types";
import type { Collapsed, PeekSectionId } from "./peekLogic";
import { PEEK_DEFAULT, PIP_DEFAULT, storedWidth } from "./paneSizes";
import { readStored, writeStored } from "./storage";

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
  setTheme(theme: ThemeMode): void;
  setPipOpen(open: boolean): void;
  setPeekWidth(width: number): void;
  setPipWidth(width: number): void;
  /** Opens or closes the palette; opened with `seed`, its search starts with those words. */
  setPaletteOpen(open: boolean, seed?: string): void;
  setPeekSection(id: PeekSectionId, collapsed: boolean): void;
}

const KEY = "gossamr-prefs";

export function loadPrefs(): Pick<Prefs, "theme" | "pipOpen" | "peekWidth" | "pipWidth"> {
  const raw = readStored(KEY) as Partial<Record<keyof Prefs, unknown>> | null;
  return {
    theme: THEMES.find((t) => t === raw?.theme) ?? "auto",
    pipOpen: false,
    peekWidth: storedWidth(raw?.peekWidth, PEEK_DEFAULT),
    pipWidth: storedWidth(raw?.pipWidth, PIP_DEFAULT),
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
}));

usePrefs.subscribe(({ theme, peekWidth, pipWidth }) => writeStored(KEY, { theme, peekWidth, pipWidth }));

export function applyTheme(theme: ThemeMode, root: HTMLElement = document.documentElement) {
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}

export function applyTransparency(reduce: boolean, root: HTMLElement = document.documentElement) {
  if (reduce) root.dataset.transparency = "reduce";
  else root.removeAttribute("data-transparency");
}

/** Keeps `data-transparency` in step with the system's Reduce transparency. Returns a function that stops and clears it. */
export function followTransparency(backend: Pick<Backend, "reduceTransparency" | "onDisplayChanged">, root: HTMLElement = document.documentElement) {
  const read = () => void backend.reduceTransparency().then((reduce) => applyTransparency(reduce, root), () => {});
  read();
  const off = backend.onDisplayChanged(read);
  return () => {
    off();
    applyTransparency(false, root);
  };
}
