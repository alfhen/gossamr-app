import { useEffect } from "react";
import { isTypingTarget } from "../lib/keys";
import { usePrefs } from "./prefs";
import { useTabs } from "./tabsStore";

/** Whether Esc is for something else: a field, a control that takes Esc itself, an open dialog or the palette. */
export function escIsElsewhere(ev: Pick<KeyboardEvent, "key" | "defaultPrevented" | "target">): boolean {
  if (ev.key !== "Escape" || ev.defaultPrevented || usePrefs.getState().paletteOpen) return true;
  const el = ev.target as { closest?: (s: string) => unknown } | null;
  return isTypingTarget(ev.target) || (typeof el?.closest === "function" && !!el.closest("[data-esc-local], [role=dialog], [role=menu], [role=listbox]"));
}

/** Esc on Settings goes back to Agents, wherever the keyboard is on the page (including <body>). */
export function useEscBack() {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (escIsElsewhere(ev)) return;
      ev.preventDefault();
      useTabs.getState().setRoute("agents");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
