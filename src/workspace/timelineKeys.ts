import { keyIntent } from "./keyMap";

/** An entry of a workstream's timeline, as the keyboard finds it. */
export const TIMELINE_ENTRY = "[data-timeline-entry]";

interface EntryLike {
  getAttribute(name: string): string | null;
  querySelector(selector: string): unknown;
}

/**
 * Where the keyboard stands on an entry: a draft's card (so its own keys, a approve, s skip, work there), a run's row, or
 * the entry itself for a turn or an audit line.
 */
export function timelineStop<T extends EntryLike>(entry: T): T {
  const kind = entry.getAttribute("data-kind");
  const inner = kind === "draft" ? entry.querySelector("article[data-draft]") : kind === "run" ? entry.querySelector("article[data-run-id]") : null;
  return (inner as T | null) ?? entry;
}

export type TimelineKeyAction = { type: "move"; by: 1 | -1 } | { type: "open" };

interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The one key model (`keyMap.ts`) on the timeline, with the keyboard on an entry's stop (`onStop`; a key pressed on a
 * button or a field inside an entry is that one's): j and k (or the arrows) move to the entry after or before, Enter and
 * o open what it is about. `ownOpen` says the stop opens itself on Enter (a draft's card, a run's row), so only o is left
 * for the timeline there, and a draft's card takes o itself too.
 */
export function timelineKeyAction(ev: KeyLike, onStop: boolean, kind: string | null): TimelineKeyAction | null {
  if (!onStop) return null;
  const intent = keyIntent(ev);
  if (intent === "next") return { type: "move", by: 1 };
  if (intent === "prev") return { type: "move", by: -1 };
  if (intent !== "open") return null;
  // A draft's card opens itself on Enter and o; a run's row on Enter.
  if (kind === "draft") return null;
  if (kind === "run" && ev.key === "Enter") return null;
  return { type: "open" };
}

/** The index j or k goes to from `at` among `count` entries: from none, j starts at the top and k at the bottom; at either end it stays. */
export function stepIndex(at: number, count: number, by: 1 | -1): number {
  if (!count) return -1;
  if (at < 0) return by > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, at + by));
}

interface Focusable {
  focus(): void;
  scrollIntoView?(arg?: ScrollIntoViewOptions): void;
}

interface Root {
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

/**
 * ArrowUp from an empty input with no draft waiting goes to the newest entry of the timeline, so the keyboard can walk it
 * back with k. False where there is no timeline (the Pip pane).
 */
export function upToTimeline(ev: KeyLike & { preventDefault(): void }, value: string, root: Root): boolean {
  if (ev.key !== "ArrowUp" || value !== "" || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return false;
  const entries = Array.from(root.querySelectorAll(TIMELINE_ENTRY)) as (EntryLike & Focusable)[];
  const last = entries[entries.length - 1];
  if (!last) return false;
  ev.preventDefault();
  const stop = timelineStop(last);
  stop.focus();
  stop.scrollIntoView?.({ block: "nearest" });
  return true;
}

/** How close to the end, in pixels, still counts as reading the newest entries. */
export const BOTTOM_SLACK = 24;

/** Whether a scroller sits at (or within a few pixels of) its end. */
export const nearBottom = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;

/**
 * Whether the timeline should follow its end after a change: while the person is at the end, and when they just sent
 * something (a new turn of theirs, not one the supervisor woke), wherever they were reading.
 */
export function followsEnd(stuck: boolean, before: number, turns: readonly { kind?: "user" | "wake" }[]): boolean {
  const sent = turns.length > before && turns[turns.length - 1]?.kind !== "wake";
  return stuck || sent;
}
