import { useEffect } from "react";
import { isTypingTarget } from "./pipHomeKeys";
import { usePrefs } from "./prefs";
import { useTabs, type Route } from "./tabsStore";

/** Whether Esc is for something else: a field, a control that takes Esc itself, an open dialog or the palette. */
export function escIsElsewhere(ev: Pick<KeyboardEvent, "key" | "defaultPrevented" | "target">): boolean {
  if (ev.key !== "Escape" || ev.defaultPrevented || usePrefs.getState().paletteOpen) return true;
  const el = ev.target as { closest?: (s: string) => unknown } | null;
  return isTypingTarget(ev.target) || (typeof el?.closest === "function" && !!el.closest("[data-esc-local], [role=dialog], [role=menu], [role=listbox]"));
}

/** Where Esc on a full page goes: Pip home, as Ctrl+0 does, or the tickets while Agents are off and there is no Pip home. */
export const escTarget = (agentsEnabled: boolean): Route => (agentsEnabled ? "pip" : "workspace");

/** Esc on a full page (Sent, Settings) goes back to `escTarget`, wherever the keyboard is on the page (including <body>). */
export function useEscToPipHome(agentsEnabled: boolean) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (escIsElsewhere(ev)) return;
      ev.preventDefault();
      useTabs.getState().setRoute(escTarget(agentsEnabled));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agentsEnabled]);
}
