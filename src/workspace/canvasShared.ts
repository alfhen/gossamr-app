import { itemKey } from "../lib/filter";
import type { FeedEntry, StatusDef, WorkItem } from "../types";

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join("") || "?";

export type AgeLevel = 0 | 1 | 2 | 3;

/** Days quiet that turn the age chip amber, orange and red; the map webs and spiders start at the last two. */
export const AGE_FROM = [3, 5, 7] as const;

export const ageLevel = (days: number): AgeLevel => AGE_FROM.filter((d) => days >= d).length as AgeLevel;

export const AGE_TEXT: Record<AgeLevel, string> = { 0: "text-ws-ink3", 1: "text-ws-warn", 2: "text-[#d2701f]", 3: "text-ws-blocked" };
export const AGE_FILL: Record<AgeLevel, string> = { 0: "bg-ws-ink3", 1: "bg-ws-warn", 2: "bg-[#d2701f]", 3: "bg-ws-blocked" };

/** Whether an age chip is worth showing: open work that has been quiet for at least two days. */
export const showsAge = (item: WorkItem, days: number) => item.status.category !== "done" && days >= 2;

export type StatusTone = "todo" | "active" | "done" | "review" | "blocked";

export function statusTone(status: StatusDef): StatusTone {
  if (status.category === "done") return "done";
  if (/^blocked$/i.test(status.name)) return "blocked";
  if (status.category === "active" && /review|qa|testing/i.test(status.name)) return "review";
  return status.category;
}

/** Items with an unread feed entry, by `itemKey`. */
export const unreadItems = (entries: readonly FeedEntry[]): Set<string> => new Set(entries.filter((e) => e.unread).map((e) => itemKey(e.item)));

export interface Progress {
  done: number;
  total: number;
  /** 0 to 100. */
  percent: number;
}

export const progressOf = (items: readonly WorkItem[]): Progress => {
  const done = items.filter((i) => i.status.category === "done").length;
  return { done, total: items.length, percent: items.length ? Math.round((done / items.length) * 100) : 0 };
};

/** How a click or Enter on a card or row changes the selection. */
export const selectHow = (ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): "one" | "toggle" | "range" => (ev.shiftKey ? "range" : ev.metaKey || ev.ctrlKey ? "toggle" : "one");
