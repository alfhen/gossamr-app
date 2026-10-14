import { useEffect } from "react";
import { isTypingTarget } from "./pipHomeKeys";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";

/** Whether Esc is for something else: a field, a control that takes Esc itself, an open dialog or the palette. */
export function escIsElsewhere(ev: Pick<KeyboardEvent, "key" | "defaultPrevented" | "target">): boolean {
  if (ev.key !== "Escape" || ev.defaultPrevented || usePrefs.getState().paletteOpen) return true;
  const el = ev.target as { closest?: (s: string) => unknown } | null;
  return isTypingTarget(ev.target) || (typeof el?.closest === "function" && !!el.closest("[data-esc-local], [role=dialog], [role=menu], [role=listbox]"));
}

/** Esc on a full page (Sent, Settings) goes back to Pip home, as Ctrl+0 does, wherever the keyboard is on the page (including <body>). */
export function useEscToPipHome(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (ev: KeyboardEvent) => {
      if (escIsElsewhere(ev)) return;
      ev.preventDefault();
      useTabs.getState().setRoute("pip");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
