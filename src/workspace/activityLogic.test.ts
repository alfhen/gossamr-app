import { describe, expect, it } from "vitest";
import type { FeedEntry, Proposal, WorkItem } from "../types";
import { CHIPS, dayLabel, draftsFor, groupByDay, initials, queryFor, stepIndex, verb, withRead } from "./activityLogic";

const entry = (id: string, at: string, over: Partial<FeedEntry> = {}): FeedEntry => ({
  id,
  connectionId: "c",
  at,
  kind: "commentAdded",
  item: { connectionId: "c", externalId: "A-1", key: "A-1" },
  itemTitle: "Title",
  actor: null,
  actorName: "Sam Holt",
  text: "",
  mention: false,
  unread: false,
  done: false,
  ...over,
});

const NOW = new Date(2026, 8, 30, 15, 0, 0);
const local = (day: number, h: number) => new Date(2026, 8, day, h, 30).toISOString();

describe("grouping the feed by day", () => {
  it("splits at local midnight and keeps order inside each day", () => {
    const groups = groupByDay([entry("a", local(30, 14)), entry("b", local(30, 1)), entry("c", local(29, 23)), entry("d", local(22, 9)), entry("e", local(22, 8))], NOW);
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [expect.stringMatching(/22/), ["d", "e"]],
    ]);
  });

  it("names days within the week and older ones by date, adding the year only when it differs", () => {
    expect(dayLabel(new Date(2026, 8, 27, 10), NOW)).toBe(new Date(2026, 8, 27).toLocaleDateString(undefined, { weekday: "long" }));
    expect(dayLabel(new Date(2026, 7, 1, 10), NOW)).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 7, 1, 10), NOW)).toMatch(/2025/);
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("chips", () => {
  it("turn into feed queries that keep the project", () => {
    const p = { connectionId: "c", externalId: "P" };
    expect(queryFor("all", p)).toEqual({ container: p });
    expect(queryFor("needsMe", null)).toEqual({ container: null, unreadOnly: true });
    expect(queryFor("mentions", null).mentionsOnly).toBe(true);
    expect(queryFor("comments", null).kinds).toEqual(["commentAdded"]);
    expect(queryFor("status", null).kinds).toEqual(["statusChanged"]);
    expect(queryFor("assigned", null).kinds).toEqual(["assigned"]);
    expect(CHIPS).toContain("drafts");
  });
});

describe("row wording and read state", () => {
  it("says what happened", () => {
    expect(verb({ kind: "commentAdded", mention: true })).toBe("mentioned you on");
    expect(verb({ kind: "commentAdded", mention: false })).toBe("commented on");
    expect(verb({ kind: "assigned", mention: false })).toBe("assigned you");
  });

  it("makes initials from up to two words", () => {
    expect(initials("Sam Holt")).toBe("SH");
    expect(initials("cher")).toBe("C");
    expect(initials("")).toBe("?");
  });

  it("marks only the named entries", () => {
    const list = [entry("a", "2026-09-30T10:00:00Z", { unread: true }), entry("b", "2026-09-30T09:00:00Z", { unread: true })];
    expect(withRead(list, new Set(["a"]), false).map((e) => e.unread)).toEqual([false, true]);
  });
});

describe("keyboard steps", () => {
  it("start at the ends and stay inside the list", () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe("drafts in the feed", () => {
  const proposal = (id: string, key: string): Proposal =>
    ({ id, intent: { type: "transition", item: { connectionId: "c", externalId: key, key }, to: "x" } }) as unknown as Proposal;
  const item = (key: string, project: string) => ({ item: { connectionId: "c", externalId: key, key }, container: { connectionId: "c", externalId: project } }) as WorkItem;
  const items = { "c:A-1": item("A-1", "A"), "c:B-1": item("B-1", "B") };

  it("narrow to the project of the item they are about", () => {
    const pending = [proposal("1", "A-1"), proposal("2", "B-1"), proposal("3", "GONE-1")];
    expect(draftsFor(pending, items, null).map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(draftsFor(pending, items, { connectionId: "c", externalId: "B" }).map((p) => p.id)).toEqual(["2"]);
  });
});
