import { describe, expect, it } from "vitest";
import type { InboxEvent, Snapshot, Ticket } from "../types";
import { itemsForView, relativeTime, snoozeOptions, stackByTicket, statusTone, viewCounts } from "./views";

const now = new Date("2026-09-28T12:00:00Z");
const me = { accountId: "me", name: "Me" };
const other = { accountId: "o", name: "Other Person" };

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key,
  summary: key,
  type: "Story",
  status: { name: "To Do", category: "new" },
  priority: null,
  assignee: null,
  reporter: null,
  parent: null,
  description: "",
  comments: [],
  changes: [],
  subtasks: [],
  children: [],
  dueDate: null,
  sprint: null,
  url: "",
  updated: "2026-09-28T10:00:00Z",
  ...over,
});

const event = (id: string, over: Partial<InboxEvent> = {}): InboxEvent => ({
  id,
  kind: "comment",
  ticketKey: "A-1",
  actor: other,
  at: "2026-09-28T11:00:00Z",
  text: "",
  unread: true,
  doneAt: null,
  snoozedUntil: null,
  ...over,
});

const snap = (events: InboxEvent[], tickets: Ticket[] = [ticket("A-1"), ticket("B-1")]): Snapshot => ({
  me,
  site: "x",
  tickets: Object.fromEntries(tickets.map((t) => [t.key, t])),
  events,
  watching: ["B-1"],
  lastSyncAt: null,
});

describe("stackByTicket", () => {
  const s = snap([
    event("a1", { at: "2026-09-28T11:50:00Z" }),
    event("b1", { ticketKey: "B-1", at: "2026-09-28T11:40:00Z" }),
    event("a2", { at: "2026-09-28T11:30:00Z" }),
  ]);
  const items = itemsForView(s, "inbox", null, now);

  it("folds a ticket's updates into one item at the newest, leaving single updates alone", () => {
    const stacked = stackByTicket(items, new Set());
    expect(stacked.map((i) => i.id)).toEqual(["s:A-1", "e:b1"]);
    expect(stacked[0].stack?.map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("lists an expanded stack's updates after it", () => {
    expect(stackByTicket(items, new Set(["A-1"])).map((i) => i.id)).toEqual(["s:A-1", "e:a1", "e:a2", "e:b1"]);
  });
});

describe("itemsForView", () => {
  it("keeps done and currently snoozed events out of the inbox, newest first", () => {
    const s = snap([
      event("old", { at: "2026-09-28T09:00:00Z" }),
      event("new", { at: "2026-09-28T11:30:00Z" }),
      event("done", { doneAt: "2026-09-28T11:00:00Z" }),
      event("snoozed", { snoozedUntil: "2026-09-28T15:00:00Z" }),
      event("woke", { snoozedUntil: "2026-09-28T11:59:00Z" }),
    ]);
    expect(itemsForView(s, "inbox", null, now).map((i) => i.event?.id)).toEqual(["new", "woke", "old"]);
    expect(itemsForView(s, "snoozed", null, now).map((i) => i.event?.id)).toEqual(["snoozed"]);
    expect(itemsForView(s, "done", null, now).map((i) => i.event?.id)).toEqual(["done"]);
  });

  it("filters by project prefix without matching longer keys", () => {
    const s = snap([event("a"), event("ab", { ticketKey: "AB-1" })], [ticket("A-1"), ticket("AB-1")]);
    expect(itemsForView(s, "inbox", "A", now).map((i) => i.ticketKey)).toEqual(["A-1"]);
  });

  it("drops events whose ticket is not in the snapshot", () => {
    expect(itemsForView(snap([event("x", { ticketKey: "GONE-1" })]), "inbox", null, now)).toEqual([]);
  });

  it("lists my tickets with in-progress work first", () => {
    const s = snap([], [
      ticket("A-1", { assignee: me, status: { name: "To Do", category: "new" } }),
      ticket("A-2", { assignee: me, status: { name: "In Progress", category: "indeterminate" } }),
      ticket("A-3", { assignee: other }),
    ]);
    expect(itemsForView(s, "mine", null, now).map((i) => i.ticketKey)).toEqual(["A-2", "A-1"]);
  });
});

describe("viewCounts", () => {
  it("counts tickets with unread updates per view and open tickets assigned to me", () => {
    const s = snap(
      [
        event("1"),
        event("2", { kind: "mention" }),
        event("3", { unread: false }),
        event("4", { doneAt: "2026-09-28T11:00:00Z", unread: false }),
        event("5", { ticketKey: "B-1" }),
      ],
      [ticket("A-1", { assignee: me }), ticket("B-1", { assignee: me, status: { name: "Done", category: "done" } })],
    );
    expect(viewCounts(s, now)).toMatchObject({ inbox: 2, mentions: 1, mine: 1, done: 1, snoozed: 0 });
  });
});

describe("statusTone", () => {
  it.each([
    ["To Do", "new", "todo"],
    ["In Progress", "indeterminate", "progress"],
    ["Code Review", "indeterminate", "review"],
    ["Blocked", "indeterminate", "blocked"],
    ["Closed", "done", "done"],
  ] as const)("%s is %s", (name, category, tone) => {
    expect(statusTone({ name, category })).toBe(tone);
  });
});

describe("relativeTime", () => {
  it.each([
    ["2026-09-28T11:59:50Z", "now"],
    ["2026-09-28T11:40:00Z", "20m"],
    ["2026-09-28T09:00:00Z", "3h"],
    ["2026-09-27T12:00:00Z", "Yday"],
    ["2026-09-25T12:00:00Z", "3d"],
  ])("%s → %s", (iso, out) => {
    expect(relativeTime(iso, now)).toBe(out);
  });
});

describe("snoozeOptions", () => {
  it("offers Monday morning of next week even when today is Monday", () => {
    const monday = new Date(2026, 8, 28, 10, 0);
    const opts = snoozeOptions(monday);
    expect(opts.map((o) => o.label)).toEqual(["Later today", "Tomorrow", "Monday"]);
    expect(opts[2].until).toEqual(new Date(2026, 9, 5, 9, 0));
    expect(opts[1].until).toEqual(new Date(2026, 8, 29, 9, 0));
  });
});
