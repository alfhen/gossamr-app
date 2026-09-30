import { useEffect } from "react";
import { create } from "zustand";
import { stepKey } from "./peekLogic";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";

interface BrowseState {
  order: readonly string[] | null;
  setOrder(order: readonly string[] | null): void;
}

const useBrowse = create<BrowseState>((set) => ({ order: null, setOrder: (order) => set({ order }) }));

/**
 * A canvas calls this with the item keys in the order it shows them (a board reads column by column, a list top to bottom),
 * so j and k step through what the person sees. Canvases that don't call it are stepped in filter order.
 */
export function useCanvasOrder(order: readonly string[]) {
  useEffect(() => {
    useBrowse.getState().setOrder(order);
    return () => {
      if (useBrowse.getState().order === order) useBrowse.getState().setOrder(null);
    };
  }, [order]);
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable], [role=dialog]"));

/** Mounted once under the canvases: j and k select the next or previous item, which opens it in the peek sheet. */
export function useStepKeys(fallback: readonly string[]) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const step = ev.key === "j" ? 1 : ev.key === "k" ? -1 : 0;
      if (!step || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || typing(ev.target) || usePrefs.getState().paletteOpen) return;
      const tabs = useTabs.getState();
      if (tabs.route !== "workspace") return;
      const next = stepKey(useBrowse.getState().order ?? fallback, tabs.selected, step);
      if (!next) return;
      ev.preventDefault();
      tabs.select(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fallback]);
}
