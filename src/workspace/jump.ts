import { itemKey } from "../lib/filter";
import type { TicketLinks } from "../components/ticketLinks";
import type { ItemRef } from "../types";
import { useWorkspace } from "../workspaceStore";
import { useRuns } from "./runsStore";
import { workConnections, workWatch } from "./domains";
import { cardId } from "./ItemCard";
import { commentDomId, showComment } from "./PeekParts";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { jumpToItem } from "./Palette";

const PULSE_MS = 1400;

/** The element that stands for an item on whichever canvas is showing: a board or age card, or a list row. */
export const canvasElement = (ref: ItemRef) => document.getElementById(cardId(ref.key)) ?? document.getElementById(`row-${itemKey(ref)}`);

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

/** Hands the keyboard to comment `id` in the peek, so the next Tab is the peek's own; false when it isn't shown. */
export function focusComment(id: string): boolean {
  const el = document.getElementById(commentDomId(id));
  if (!el) return false;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  return true;
}

/**
 * Opens the ticket in the peek and brings comment `id` of it into view, outlined (`showComment`): the reporter's reply the
 * timeline quotes. The sheet may still be reading the comments when it opens, so it looks for a moment; a comment that
 * never shows (deleted since) leaves the ticket open at its top.
 */
export async function openComment(ticketKey: string, id: string) {
  if (!(await openTicketByKey(ticketKey))) return;
  for (let tries = 0; tries < 20; tries++) {
    if (document.getElementById(commentDomId(id))) {
      showComment(id);
      return focusComment(id);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
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

/**
 * The title of a ticket key Gossamr knows: the cached title, or '' for a key it knows without one (the ticket of an
 * agent run, or a key in a project it has). Null for any other, which stays text.
 */
export function knownTicketTitle(key: string): string | null {
  const cached = cachedByKey(key);
  if (cached) return cached.title;
  const lower = key.toLowerCase();
  if (useRuns.getState().runs.some((r) => r.item?.key.toLowerCase() === lower)) return "";
  const project = lower.slice(0, lower.lastIndexOf("-"));
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
    const item = cachedByKey(key);
    if (item) showMe(item.item);
    else void openTicketByKey(key);
  },
};
