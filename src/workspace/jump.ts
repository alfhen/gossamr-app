import { itemKey } from "../lib/filter";
import type { TicketLinks } from "../components/ticketLinks";
import type { ItemRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { cardId } from "./ItemCard";
import { jumpToItem } from "./Palette";

const PULSE_MS = 1400;

/** The element that stands for an item on whichever canvas is showing: a board or age card, or a list row. */
export const canvasElement = (ref: ItemRef) => document.getElementById(cardId(ref.key)) ?? document.getElementById(`row-${itemKey(ref)}`);

/** Selects the item, switching the tab's filter if it isn't shown, then brings its card into view and pulses it. */
export function showMe(ref: ItemRef) {
  const item = useWorkspace.getState().items[itemKey(ref)];
  if (!item) return false;
  jumpToItem(item);
  // The canvas re-renders after the selection changes.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = canvasElement(ref);
      if (!el) return;
      el.scrollIntoView({ block: "center", inline: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      el.classList.add("ws-pulse");
      setTimeout(() => el.classList.remove("ws-pulse"), PULSE_MS);
    }),
  );
  return true;
}

const cachedByKey = (key: string) => Object.values(useWorkspace.getState().items).find((i) => i.item.key === key);

/** Ticket keys in Pip's replies and other rendered text open the cached item here. */
export const workspaceTicketLinks: TicketLinks = {
  titleOf: (key) => cachedByKey(key)?.title ?? null,
  open(key) {
    const item = cachedByKey(key);
    if (item) showMe(item.item);
  },
};
