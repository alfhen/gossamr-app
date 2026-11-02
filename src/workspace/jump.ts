import { itemKey } from "../lib/filter";
import type { TicketLinks } from "../components/ticketLinks";
import type { ItemRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useRuns } from "./runsStore";
import { cardId } from "./ItemCard";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { jumpToItem } from "./Palette";
import { useKeyChooser } from "./keyChooserStore";
import { cachedWithKey, projectOfKey, refsForKey } from "./keyLookup";

const PULSE_MS = 1400;

/** The element that stands for an item on whichever canvas is showing: a board or age card, or a list row. */
export const canvasElement = (ref: ItemRef) => document.getElementById(cardId(ref)) ?? document.getElementById(`row-${itemKey(ref)}`);

const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Brings the open details to its drafts, or to its top when it has none, for a ticket that was already open and so didn't change. */
export function revealInPeek() {
  const peek = document.getElementById("peek-sheet");
  if (!peek) return;
  const behavior = reducedMotion() ? "auto" : "smooth";
  const drafts = peek.querySelector<HTMLElement>("#peek-drafts");
  if (!drafts) return void peek.querySelector<HTMLElement>(".overflow-auto")?.scrollTo({ top: 0, behavior });
  drafts.scrollIntoView({ block: "start", behavior });
  drafts.classList.add("ws-pulse");
  setTimeout(() => drafts.classList.remove("ws-pulse"), PULSE_MS);
}

/** Selects the item, switching the tab's filter if it isn't shown, then brings its card into view and pulses it. With `peek`, the open details scroll to the item's drafts too. */
export function showMe(ref: ItemRef, opts: { peek?: boolean } = {}) {
  const item = useWorkspace.getState().items[itemKey(ref)];
  if (!item) return false;
  jumpToItem(item);
  if (opts.peek) requestAnimationFrame(() => requestAnimationFrame(revealInPeek));
  // The canvas re-renders after the selection changes.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const el = canvasElement(ref);
      if (!el) return;
      el.scrollIntoView({ block: "center", inline: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      el.classList.add("ws-pulse");
      setTimeout(() => el.classList.remove("ws-pulse"), PULSE_MS);
    }),
  );
  return true;
}

/** The ticket a reference names, from the cache when it is synced, else a live read-only peek that is never stored. */
export async function openTicket(ref: ItemRef): Promise<boolean> {
  const ws = useWorkspace.getState();
  const cached = ws.items[itemKey(ref)];
  if (cached) return showMe(cached.item);
  try {
    const item = await ws.peekItem(ref);
    if (!item) {
      useToasts.getState().push(`Couldn't find ${ref.key}. It may not exist, or you may not have access to it.`);
      return false;
    }
    const known = item.unwatched ? (await ws.backend?.cacheContainers({ includeUnwatched: true }))?.find((c) => c.ref.externalId === item.container.externalId && c.ref.connectionId === item.container.connectionId) : undefined;
    useWorkspace.getState().showPeeked({ item, containerName: known?.name ?? null });
    const tabs = useTabs.getState();
    tabs.setRoute("workspace");
    tabs.select(itemKey(item.item));
    return true;
  } catch (e) {
    useToasts.getState().push(`Couldn't open ${ref.key}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Opens one of `refs`, asking which when there are several. Returns the one shown, or null. */
export async function openOneOf(key: string, refs: ItemRef[]): Promise<ItemRef | null> {
  const picked = refs.length > 1 ? await useKeyChooser.getState().choose(key, refs) : (refs[0] ?? null);
  return picked && (await openTicket(picked)) ? picked : null;
}

/**
 * Opens a ticket typed by key, in whichever site and project it is: the synced one if there is one, otherwise a live
 * read-only peek. A key more than one site has opens a chooser. Returns the ticket shown, or null.
 */
export async function openTicketByKey(key: string): Promise<ItemRef | null> {
  const refs = refsForKey(useWorkspace.getState(), key);
  if (!refs.length) {
    useToasts.getState().push("Not connected yet.");
    return null;
  }
  return openOneOf(key, refs);
}

/**
 * The title of a ticket key Gossamr knows: the cached title, or '' for a key it knows without one (the ticket of an
 * agent run, or a key in a project it has). Null for any other, which stays text.
 */
export function knownTicketTitle(key: string): string | null {
  const cached = cachedWithKey(useWorkspace.getState().items, key);
  if (cached.length) return cached.length === 1 ? cached[0].title : "";
  const lower = key.toLowerCase();
  if (useRuns.getState().runs.some((r) => r.item?.key.toLowerCase() === lower)) return "";
  const project = projectOfKey(key).toLowerCase();
  return Object.values(useWorkspace.getState().containers).some((c) => c.key.toLowerCase() === project) ? "" : null;
}

/** Ticket keys in Pip's replies and other rendered text open the item here: the cached one, else a live peek. */
export const workspaceTicketLinks: TicketLinks = {
  titleOf: knownTicketTitle,
  // What knownTicketTitle reads: an answer rendered before the tickets, runs or projects load links its keys once they do.
  useKnown() {
    useWorkspace((s) => s.items);
    useWorkspace((s) => s.containers);
    useRuns((s) => s.runs);
  },
  open(key) {
    void openTicketByKey(key);
  },
};
