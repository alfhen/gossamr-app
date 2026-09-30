import type { ContainerRef, FeedEntry, FeedQuery, Proposal } from "../types";
import { targetOf } from "../lib/proposals";
import { itemKey } from "../lib/filter";
import type { WorkItem } from "../types";

export const CHIPS = ["all", "needsMe", "mentions", "comments", "status", "assigned", "drafts"] as const;
export type ActivityChip = (typeof CHIPS)[number];

export const CHIP_LABEL: Record<ActivityChip, string> = {
  all: "All",
  needsMe: "Needs me",
  mentions: "Mentions",
  comments: "Comments",
  status: "Status changes",
  assigned: "Assigned to me",
  drafts: "Drafts",
};

/** Needs me is what is still unread: the inbox marks an event read once it has been dealt with. */
export function queryFor(chip: ActivityChip, container: ContainerRef | null): FeedQuery {
  const base: FeedQuery = { container };
  switch (chip) {
    case "needsMe":
      return { ...base, unreadOnly: true };
    case "mentions":
      return { ...base, mentionsOnly: true };
    case "comments":
      return { ...base, kinds: ["commentAdded"] };
    case "status":
      return { ...base, kinds: ["statusChanged"] };
    case "assigned":
      return { ...base, kinds: ["assigned"] };
    default:
      return base;
  }
}

export interface DayGroup {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  label: string;
  entries: FeedEntry[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function dayLabel(at: Date, now: Date): string {
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "long" });
  return at.toLocaleDateString(undefined, { day: "numeric", month: "long", year: at.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** Entries already in time order, split at local midnight. */
export function groupByDay(entries: readonly FeedEntry[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const at = new Date(entry.at);
    const day = dayKey(at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, label: dayLabel(at, now), entries: [entry] });
  }
  return groups;
}

export function verb(e: Pick<FeedEntry, "kind" | "mention">): string {
  switch (e.kind) {
    case "commentAdded":
      return e.mention ? "mentioned you on" : "commented on";
    case "statusChanged":
      return "moved";
    case "assigned":
      return "assigned you";
    case "itemCreated":
      return "created";
    case "prOpened":
      return "opened a pull request for";
    case "prMerged":
      return "merged a pull request for";
    case "checkFailed":
      return "had a failing check on";
    case "reviewRequested":
      return "asked you to review";
    case "fieldChanged":
      return "updated";
  }
}

export { initials } from "./canvasShared";

/** The entries whose id is in `ids` with `unread` set, the others untouched. */
export function withRead(entries: readonly FeedEntry[], ids: ReadonlySet<string>, unread: boolean): FeedEntry[] {
  return entries.map((e) => (ids.has(e.id) ? { ...e, unread } : e));
}

/** Pending drafts, narrowed to a project when there is one. Drafts about nothing in the cache stay in only when unfiltered. */
export function draftsFor(pending: readonly Proposal[], items: Record<string, WorkItem>, container: ContainerRef | null): Proposal[] {
  if (!container) return [...pending];
  return pending.filter((p) => {
    const target = targetOf(p.intent);
    const item = target ? items[itemKey(target)] : undefined;
    return item?.container.externalId === container.externalId && item.container.connectionId === container.connectionId;
  });
}

/** The index j and k move to, staying inside the list. -1 means nothing is active yet. */
export const stepIndex = (current: number, delta: 1 | -1, length: number): number =>
  length === 0 ? -1 : Math.min(length - 1, Math.max(0, current < 0 ? (delta === 1 ? 0 : length - 1) : current + delta));
