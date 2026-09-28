import type { InboxEvent, Snapshot, Status, Ticket, ViewId } from "../types";

export interface ListItem {
  id: string;
  ticketKey: string;
  event?: InboxEvent;
}

export const VIEWS: { id: ViewId; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "mentions", label: "Mentions" },
  { id: "mine", label: "My tickets" },
  { id: "watching", label: "Watching" },
  { id: "snoozed", label: "Snoozed" },
  { id: "done", label: "Archive" },
];

export function isSnoozed(e: InboxEvent, now: Date): boolean {
  return e.snoozedUntil !== null && new Date(e.snoozedUntil) > now;
}

function isActive(e: InboxEvent, now: Date): boolean {
  return e.doneAt === null && !isSnoozed(e, now);
}

const MINE_ORDER = ["indeterminate", "new", "done"] as const;

export function itemsForView(
  snap: Snapshot,
  view: ViewId,
  project: string | null,
  now: Date,
): ListItem[] {
  const inProject = (key: string) => !project || key.startsWith(`${project}-`);
  const events = (keep: (e: InboxEvent) => boolean): ListItem[] =>
    snap.events
      .filter((e) => keep(e) && inProject(e.ticketKey) && snap.tickets[e.ticketKey])
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((e) => ({ id: `e:${e.id}`, ticketKey: e.ticketKey, event: e }));
  const tickets = (keys: string[]): ListItem[] =>
    keys.filter((k) => inProject(k) && snap.tickets[k]).map((k) => ({ id: `t:${k}`, ticketKey: k }));

  switch (view) {
    case "inbox":
      return events((e) => isActive(e, now));
    case "mentions":
      return events((e) => e.kind === "mention" && e.doneAt === null);
    case "snoozed":
      return events((e) => e.doneAt === null && isSnoozed(e, now));
    case "done":
      return events((e) => e.doneAt !== null);
    case "mine":
      return tickets(
        Object.values(snap.tickets)
          .filter((t) => t.assignee?.accountId === snap.me.accountId)
          .sort(
            (a, b) =>
              MINE_ORDER.indexOf(a.status.category) - MINE_ORDER.indexOf(b.status.category) ||
              b.updated.localeCompare(a.updated),
          )
          .map((t) => t.key),
      );
    case "watching":
      return tickets(snap.watching);
  }
}

export function viewCounts(snap: Snapshot, now: Date): Record<ViewId, number> {
  const unread = (keep: (e: InboxEvent) => boolean) => snap.events.filter((e) => e.unread && keep(e)).length;
  return {
    inbox: unread((e) => isActive(e, now)),
    mentions: unread((e) => e.kind === "mention" && e.doneAt === null),
    mine: Object.values(snap.tickets).filter(
      (t) => t.assignee?.accountId === snap.me.accountId && t.status.category !== "done",
    ).length,
    watching: snap.watching.length,
    snoozed: snap.events.filter((e) => e.doneAt === null && isSnoozed(e, now)).length,
    done: snap.events.filter((e) => e.doneAt !== null).length,
  };
}

export function projectsOf(snap: Snapshot): string[] {
  return [...new Set(Object.keys(snap.tickets).map((k) => k.split("-")[0]))].sort();
}

export type StatusTone = "todo" | "progress" | "review" | "blocked" | "done";

/** Jira only exposes three status categories, so review and blocked states are recognised by name. */
export function statusTone(status: Status): StatusTone {
  if (status.category === "done") return "done";
  const name = status.name.toLowerCase();
  if (/block|hold|waiting/.test(name)) return "blocked";
  if (/review|qa|test/.test(name)) return "review";
  return status.category === "new" ? "todo" : "progress";
}

export function relativeTime(iso: string, now: Date): string {
  const s = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yday";
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export interface SnoozeOption {
  label: string;
  hint: string;
  until: Date;
}

export function snoozeOptions(now: Date): SnoozeOption[] {
  const at9 = (daysAhead: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysAhead);
    d.setHours(9, 0, 0, 0);
    return d;
  };
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    { label: "Later today", hint: "in 3h", until: new Date(now.getTime() + 3 * 3600_000) },
    { label: "Tomorrow", hint: "09:00", until: at9(1) },
    { label: "Monday", hint: "09:00", until: at9(daysToMonday) },
  ];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function ticketMatches(t: Ticket, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q);
}
