import type { InboxEvent, MyAction, Person, Snapshot, Status, Ticket, ViewId } from "../types";

export interface ListItem {
  id: string;
  ticketKey: string;
  event?: InboxEvent;
  /** Every update to the ticket in this view, newest first, when there is more than one. */
  stack?: InboxEvent[];
  /** An update listed inside an expanded stack. */
  inStack?: boolean;
  /** Why the ticket is in Waiting on me. */
  waiting?: Waiting;
  /** Where the ticket sits in My work, and what the user did on it in the range, newest first. */
  work?: { section: WorkSection; actions: MyAction[]; latest: string };
}

export interface Waiting {
  reason: "question" | "review" | "unstarted";
  who: Person | null;
  since: string;
}

export const INBOX_TABS: { id: ViewId; label: string }[] = [
  { id: "inbox", label: "All" },
  { id: "waiting", label: "Waiting on me" },
  { id: "watching", label: "Watching" },
  { id: "snoozed", label: "Snoozed" },
  { id: "done", label: "Archive" },
];

/** Every view with its full name, for headers and the command palette. */
export const VIEWS: { id: ViewId; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  ...INBOX_TABS.slice(1),
  { id: "work", label: "My work" },
];

export const isInboxView = (view: ViewId) => view !== "work";

export const WORK_RANGES: { days: number; label: string }[] = [
  { days: 1, label: "Today" },
  { days: 7, label: "Last 7 days" },
  { days: 14, label: "Last 14 days" },
  { days: 30, label: "Last 30 days" },
];

export function isSnoozed(e: InboxEvent, now: Date): boolean {
  return e.snoozedUntil !== null && new Date(e.snoozedUntil) > now;
}

function isActive(e: InboxEvent, now: Date): boolean {
  return e.doneAt === null && !isSnoozed(e, now);
}

export function itemsForView(
  snap: Snapshot,
  view: ViewId,
  project: string | null,
  now: Date,
  workDays = 7,
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
    case "snoozed":
      return events((e) => e.doneAt === null && isSnoozed(e, now));
    case "done":
      return events((e) => e.doneAt !== null);
    case "watching":
      return tickets(snap.watching);
    case "waiting":
      return waitingOnMe(snap, now).filter((i) => inProject(i.ticketKey));
    case "work":
      return myWork(snap, now, workDays).filter((i) => inProject(i.ticketKey));
  }
}

/**
 * Open tickets where someone needs something from the user, longest wait first: a mention with no reply from them
 * since (even if the notification was cleared), a ticket assigned to them that hasn't started, or a ticket they
 * reported that someone else has sent to review. A mention that is snoozed doesn't count until the snooze ends.
 */
export function waitingOnMe(snap: Snapshot, now = new Date()): ListItem[] {
  const me = snap.me.accountId;
  const found = new Map<string, Waiting>();
  const lastReply = (t: Ticket) =>
    t.comments.reduce((last, c) => (c.author.accountId === me && c.created > last ? c.created : last), "");
  for (const e of snap.events) {
    const t = snap.tickets[e.ticketKey];
    if (e.kind !== "mention" || !t || t.status.category === "done" || lastReply(t) > e.at) continue;
    if (e.doneAt === null && isSnoozed(e, now)) continue;
    const seen = found.get(t.key);
    if (!seen || e.at < seen.since) found.set(t.key, { reason: "question", who: e.actor, since: e.at });
  }
  const other = (p: Person | null | undefined) => (p && p.accountId !== me ? p : null);
  for (const t of Object.values(snap.tickets)) {
    if (found.has(t.key) || t.status.category === "done") continue;
    if (t.assignee?.accountId === me && t.status.category === "new") {
      const c = t.changes.find((c) => c.field === "Assignee");
      found.set(t.key, { reason: "unstarted", who: other(c?.author ?? t.reporter), since: c?.at ?? t.updated });
    } else if (t.reporter?.accountId === me && t.assignee?.accountId !== me && statusTone(t.status) === "review") {
      const c = t.changes.find((c) => c.field === "Status");
      found.set(t.key, { reason: "review", who: other(t.assignee), since: c?.at ?? t.updated });
    }
  }
  return [...found]
    .sort(([, a], [, b]) => a.since.localeCompare(b.since))
    .map(([key, waiting]) => ({ id: `t:${key}`, ticketKey: key, waiting }));
}

export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Midnight at the start of the range, so 7 days is today and the six days before it. */
export function rangeStart(days: number, now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

/** The user's comments and other actions since the start of the range, newest first. */
export function myActions(snap: Snapshot, now: Date, days: number): MyAction[] {
  const me = snap.me.accountId;
  const comments = Object.values(snap.tickets).flatMap((t) =>
    t.comments
      .filter((c) => c.author.accountId === me)
      .map<MyAction>((c) => ({ ticketKey: t.key, at: c.created, kind: "comment", text: c.body })),
  );
  const since = rangeStart(days, now).toISOString();
  return [...(snap.activity ?? []), ...comments]
    .filter((a) => snap.tickets[a.ticketKey] && new Date(a.at).toISOString() >= since)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Days after which something reaches each withering stage: it starts to dry out, gathers a cobweb, then one, two and
 * three spiders. For open tickets with no updates, and requests with no reply.
 */
export const WITHER_DAYS = { ticket: [2, 3, 5, 7, 10], waiting: [1, 3, 5, 7, 10] } as const;

export type WitherLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** A wait as its largest whole unit, such as "40m", "5h" or "12d". */
export function age(since: string, now: Date): string {
  const m = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

export function witherLevel(since: string, now: Date, stages: readonly number[]): WitherLevel {
  const days = (now.getTime() - new Date(since).getTime()) / 86_400_000;
  return stages.filter((d) => days >= d).length as WitherLevel;
}

export type WorkSection = "In progress" | "To do" | "Done" | "Also worked on";
const SECTIONS: WorkSection[] = ["In progress", "To do", "Done", "Also worked on"];

/**
 * The user's open tickets, the ones they resolved in the range, and any other ticket they worked on in it, by
 * section and then most recent first.
 */
export function myWork(snap: Snapshot, now: Date, days: number): ListItem[] {
  const since = rangeStart(days, now).toISOString();
  const actions = new Map<string, MyAction[]>();
  for (const a of myActions(snap, now, days)) actions.set(a.ticketKey, [...(actions.get(a.ticketKey) ?? []), a]);
  const items: ListItem[] = [];
  for (const t of Object.values(snap.tickets)) {
    const did = actions.get(t.key) ?? [];
    const resolved = t.status.category === "done" ? (t.resolved ?? t.updated) : null;
    let section: WorkSection | null = null;
    if (t.assignee?.accountId === snap.me.accountId) {
      if (t.status.category === "indeterminate") section = "In progress";
      else if (t.status.category === "new") section = "To do";
      else if ((resolved && resolved >= since) || did.length) section = "Done";
    } else if (did.length) section = "Also worked on";
    if (!section) continue;
    // Tickets that aren't the user's are placed by what they did, not by other people's later changes.
    const latest = section === "Also worked on" ? did[0].at : [did[0]?.at, resolved, t.updated].filter((x): x is string => !!x).sort().pop()!;
    items.push({ id: `t:${t.key}`, ticketKey: t.key, work: { section, actions: did, latest } });
  }
  return items.sort(
    (a, b) =>
      SECTIONS.indexOf(a.work!.section) - SECTIONS.indexOf(b.work!.section) || b.work!.latest.localeCompare(a.work!.latest),
  );
}

export function dayLabel(day: string, now: Date): string {
  if (day === localDay(now.toISOString())) return "Today";
  if (day === localDay(new Date(now.getTime() - 86_400_000).toISOString())) return "Yesterday";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

/** A short phrase for a day's actions on one ticket, such as "moved to In Review, commented twice". */
export function describeActions(actions: MyAction[]): string {
  const moves = actions.filter((a) => a.kind === "transition").reverse();
  const comments = actions.filter((a) => a.kind === "comment").length;
  return [
    actions.some((a) => a.kind === "created") ? "created it" : null,
    moves.length ? `moved to ${moves[moves.length - 1].text.split("→").pop()!.trim()}` : null,
    comments ? `commented${comments === 2 ? " twice" : comments > 2 ? ` ${comments} times` : ""}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/** The range's actions as plain text grouped by day, for pasting into a standup or 1:1. */
export function standupNotes(snap: Snapshot, now: Date, days: number): string {
  const byDay = new Map<string, Map<string, MyAction[]>>();
  for (const a of myActions(snap, now, days)) {
    const day = byDay.get(localDay(a.at)) ?? new Map<string, MyAction[]>();
    day.set(a.ticketKey, [...(day.get(a.ticketKey) ?? []), a]);
    byDay.set(localDay(a.at), day);
  }
  return [...byDay]
    .map(([day, tickets]) =>
      [dayLabel(day, now), ...[...tickets].map(([key, acts]) => `- ${key} ${snap.tickets[key].summary}: ${describeActions(acts)}`)].join("\n"),
    )
    .join("\n\n");
}

/**
 * Folds several updates to one ticket into a single `s:<key>` item placed at the newest update. Stacks whose ticket
 * is in `expanded` are followed by their updates.
 */
export function stackByTicket(items: ListItem[], expanded: ReadonlySet<string>): ListItem[] {
  const byTicket = new Map<string, InboxEvent[]>();
  for (const it of items) if (it.event) byTicket.set(it.ticketKey, [...(byTicket.get(it.ticketKey) ?? []), it.event]);
  const placed = new Set<string>();
  return items.flatMap((it) => {
    const stack = byTicket.get(it.ticketKey);
    if (!stack || stack.length < 2) return [it];
    if (placed.has(it.ticketKey)) return [];
    placed.add(it.ticketKey);
    const head: ListItem = { id: `s:${it.ticketKey}`, ticketKey: it.ticketKey, event: stack[0], stack };
    if (!expanded.has(it.ticketKey)) return [head];
    return [head, ...stack.map((e) => ({ id: `e:${e.id}`, ticketKey: it.ticketKey, event: e, inStack: true }))];
  });
}

/** Event views count tickets rather than updates, matching the list once updates are stacked. */
export function viewCounts(snap: Snapshot, now: Date): Record<ViewId, number> {
  const tickets = (keep: (e: InboxEvent) => boolean) => new Set(snap.events.filter(keep).map((e) => e.ticketKey)).size;
  const unread = (keep: (e: InboxEvent) => boolean) => tickets((e) => e.unread && keep(e));
  return {
    inbox: unread((e) => isActive(e, now)),
    waiting: waitingOnMe(snap, now).length,
    watching: snap.watching.length,
    work: Object.values(snap.tickets).filter(
      (t) => t.assignee?.accountId === snap.me.accountId && t.status.category !== "done",
    ).length,
    snoozed: tickets((e) => e.doneAt === null && isSnoozed(e, now)),
    done: tickets((e) => e.doneAt !== null),
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
