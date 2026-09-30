import { itemKey } from "../lib/filter";
import type { TicketLinks } from "../components/ticketLinks";
import type { ItemRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { workConnections, workWatch } from "./domains";
import { cardId } from "./ItemCard";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
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

/**
 * Opens a ticket by key in whichever project it is: the synced one if there is one, otherwise a live read-only
 * peek that is never stored.
 */
export async function openTicketByKey(key: string): Promise<boolean> {
  const ws = useWorkspace.getState();
  const cached = Object.values(ws.items).find((i) => i.item.key.toLowerCase() === key.toLowerCase());
  if (cached) return showMe(cached.item);
  const connectionId = workConnections(ws.connections)[0]?.id ?? workWatch(ws.watch)[0]?.connectionId;
  if (!connectionId) {
    useToasts.getState().push("Not connected yet.");
    return false;
  }
  try {
    const item = await ws.peekItem({ connectionId, externalId: key, key });
    if (!item) {
      useToasts.getState().push(`Couldn't find ${key}. It may not exist, or you may not have access to it.`);
      return false;
    }
    const known = item.unwatched ? (await ws.backend?.cacheContainers({ includeUnwatched: true }))?.find((c) => c.ref.externalId === item.container.externalId) : undefined;
    useWorkspace.getState().showPeeked({ item, containerName: known?.name ?? null });
    const tabs = useTabs.getState();
    tabs.setRoute("workspace");
    tabs.select(itemKey(item.item));
    return true;
  } catch (e) {
    useToasts.getState().push(`Couldn't open ${key}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Ticket keys in Pip's replies and other rendered text open the cached item here. */
export const workspaceTicketLinks: TicketLinks = {
  titleOf: (key) => cachedByKey(key)?.title ?? null,
  open(key) {
    const item = cachedByKey(key);
    if (item) showMe(item.item);
    else void openTicketByKey(key);
  },
};
