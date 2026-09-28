import { describe, expect, it } from "vitest";
import type { InboxEvent, Snapshot, Ticket } from "../types";
import { age, describeActions, itemsForView, myWork, standupNotes, witherLevel, WITHER_DAYS, relativeTime, snoozeOptions, stackByTicket, statusTone, viewCounts, waitingOnMe } from "./views";

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

describe("waitingOnMe", () => {
  const reply = (at: string) => ({ id: at, author: me, created: at, body: "" });

  it("lists unanswered mentions, even cleared ones, longest wait first", () => {
    const s = snap(
      [
        event("new", { kind: "mention", at: "2026-09-28T11:00:00Z" }),
        event("cleared", { kind: "mention", ticketKey: "B-1", at: "2026-09-27T09:00:00Z", doneAt: "2026-09-27T10:00:00Z" }),
      ],
      [ticket("A-1"), ticket("B-1")],
    );
    expect(waitingOnMe(s).map((i) => [i.ticketKey, i.waiting?.reason])).toEqual([
      ["B-1", "question"],
      ["A-1", "question"],
    ]);
  });

  it("drops a mention once I've replied after it", () => {
    const s = snap([event("m", { kind: "mention", at: "2026-09-28T09:00:00Z" })], [ticket("A-1", { comments: [reply("2026-09-28T10:00:00Z")] })]);
    expect(waitingOnMe(s)).toEqual([]);
  });

  it("lists my unstarted tickets and tickets I reported that are in review", () => {
    const s = snap(
      [],
      [
        ticket("A-1", { assignee: me }),
        ticket("B-1", { reporter: me, assignee: other, status: { name: "In Review", category: "indeterminate" } }),
        ticket("C-1", { assignee: me, status: { name: "Done", category: "done" } }),
      ],
    );
    expect(waitingOnMe(s).map((i) => i.waiting?.reason).sort()).toEqual(["review", "unstarted"]);
  });
});

describe("myWork", () => {
  const done = { name: "Done", category: "done" } as const;
  const action = (ticketKey: string, at: string, kind: "comment" | "transition" = "transition", text = "To Do → In Progress") => ({
    ticketKey,
    at,
    kind,
    text,
  });

  it("sections my open tickets, those resolved in range and others I worked on", () => {
    const s = {
      ...snap(
        [],
        [
          ticket("A-1", { assignee: me, status: { name: "In Progress", category: "indeterminate" } }),
          ticket("A-2", { assignee: me }),
          ticket("A-3", { assignee: me, status: done, resolved: "2026-09-27T10:00:00Z" }),
          ticket("A-4", { assignee: me, status: done, resolved: "2026-08-01T10:00:00Z", updated: "2026-08-01T10:00:00Z" }),
          ticket("B-1", { assignee: other }),
          ticket("B-2", { assignee: other }),
        ],
      ),
      activity: [action("B-1", "2026-09-28T09:00:00Z", "comment", "")],
    };
    expect(myWork(s, now, 7).map((i) => [i.ticketKey, i.work?.section])).toEqual([
      ["A-1", "In progress"],
      ["A-2", "To do"],
      ["A-3", "Done"],
      ["B-1", "Also worked on"],
    ]);
  });

  it("counts only actions inside the range and groups the standup by day", () => {
    const s = {
      ...snap([], [ticket("A-1", { comments: [{ id: "c", author: me, created: "2026-09-28T10:00:00Z", body: "" }] })]),
      activity: [action("A-1", "2026-09-28T09:00:00Z"), action("A-1", "2026-09-01T09:00:00Z")],
    };
    const [item] = myWork(s, now, 7);
    expect(describeActions(item.work!.actions)).toBe("moved to In Progress, commented");
    expect(standupNotes(s, now, 7)).toBe("Today\n- A-1 A-1: moved to In Progress, commented");
    expect(myWork(s, new Date("2026-10-20T12:00:00Z"), 7)).toEqual([]);
  });
});

describe("witherLevel", () => {
  it.each([
    ["2026-09-27T12:00:00Z", 0],
    ["2026-09-26T12:00:00Z", 1],
    ["2026-09-25T12:00:00Z", 2],
    ["2026-09-23T12:00:00Z", 3],
    ["2026-09-21T12:00:00Z", 4],
    ["2026-09-10T12:00:00Z", 5],
  ] as const)("an open ticket last updated %s has withered to level %i", (updated, level) => {
    expect(witherLevel(updated, now, WITHER_DAYS.ticket)).toBe(level);
  });

  it("shows ages in their largest whole unit", () => {
    expect([age("2026-09-28T11:20:00Z", now), age("2026-09-28T07:00:00Z", now), age("2026-09-16T12:00:00Z", now)]).toEqual(["40m", "5h", "12d"]);
  });
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
    expect(itemsForView(s, "work", null, now).map((i) => i.ticketKey)).toEqual(["A-2", "A-1"]);
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
    expect(viewCounts(s, now)).toMatchObject({ inbox: 2, work: 1, done: 1, snoozed: 0 });
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
