import { itemKey } from "../lib/filter";
import type { PersonRef, WorkItem } from "../types";
import { linkRows } from "./peekLogic";

export const STALE_DAYS = 5;
const DAY = 86_400_000;

/** What Pip can tell about the open ticket without asking anyone: the facts nudges and suggestion chips are chosen from. */
export interface ItemScene {
  key: string;
  open: boolean;
  staleDays: number | null;
  /** Key of the first unfinished ticket holding this one up. */
  blockedBy: string | null;
  /** Who commented last, when the ticket is waiting on the user; "Someone" if that is unknown. */
  waitingOn: string | null;
  unassigned: boolean;
  linked: boolean;
}

interface World {
  items: Record<string, WorkItem>;
  needsMe: ReadonlySet<string>;
  names: Record<string, string>;
  me: readonly PersonRef[];
  now: number;
}

const isMe = (me: readonly PersonRef[], p: PersonRef) => me.some((m) => m.connectionId === p.connectionId && m.accountId === p.accountId);

export function itemScene(item: WorkItem, w: World): ItemScene {
  const open = item.status.category !== "done";
  const quiet = Math.floor((w.now - Date.parse(item.updated)) / DAY);
  const links = linkRows(item, w.items);
  const blocker = links.find((l) => l.kind === "blockedBy" && (w.items[itemKey(l.ref)]?.status.category ?? "todo") !== "done");
  const waiting = w.needsMe.has(itemKey(item.item));
  const last = item.lastCommenter;
  return {
    key: item.item.key,
    open,
    staleDays: open && quiet >= STALE_DAYS ? quiet : null,
    blockedBy: open && blocker ? blocker.ref.key : null,
    waitingOn: open && waiting ? (last && !isMe(w.me, last) ? (w.names[last.accountId] ?? last.accountId) : "Someone") : null,
    unassigned: open && item.assignee === null && item.status.category === "todo",
    linked: links.length > 0,
  };
}
