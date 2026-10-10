import { useEffect, useRef, useState } from "react";

/** Set on a popover's root while it is open, so Esc handlers further out leave the keypress to it. */
export const POPOVER_OPEN = "data-popover-open";

/** Whether a popover or menu is open somewhere on the page, which an Esc closes before anything else. */
export function popoverOpen(): boolean {
  return document.querySelector(`[${POPOVER_OPEN}]`) !== null;
}

/**
 * Open state for a popover that closes on an outside click or Escape and hands focus back to its trigger. Escape closes
 * only the popover: the keypress is taken in the capture phase and marked handled, and while it is open its root says
 * so (`POPOVER_OPEN`), so neither the pane nor a peek sheet closes on the same key.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = root.current;
    el?.setAttribute(POPOVER_OPEN, "");
    const down = (ev: MouseEvent) => {
      if (!root.current?.contains(ev.target as Node)) setOpen(false);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLElement>("[data-popover-trigger]")?.focus();
    };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => {
      el?.removeAttribute(POPOVER_OPEN);
      document.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return { open, setOpen, root };
}
