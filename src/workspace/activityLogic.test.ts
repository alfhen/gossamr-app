import { describe, expect, it } from "vitest";
import type { FeedEntry, WorkstreamEvent } from "../types";
import { FILTER_LABEL, dayBreaks, dayLabel, eventText, groupByDay, inInbox, initials, queryFor, stepIndex, verb, withRead } from "./activityLogic";

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

describe("the Inbox filter", () => {
  it("is everything or only mentions, and asks the feed for nothing more", () => {
    expect(queryFor("all")).toEqual({});
    expect(queryFor("mentions")).toEqual({ mentionsOnly: true });
    expect(FILTER_LABEL).toEqual({ all: "All", mentions: "Mentions" });
  });

  it("lists comments, status changes and assignments, and leaves out the rest of the feed", () => {
    const kinds = ["commentAdded", "statusChanged", "assigned", "itemCreated", "prOpened", "checkFailed", "fieldChanged"] as const;
    expect(kinds.filter((kind) => inInbox({ kind }))).toEqual(["commentAdded", "statusChanged", "assigned"]);
  });
});

describe("row wording and read state", () => {
  it("says what happened", () => {
    expect(verb({ kind: "commentAdded", mention: true })).toBe("mentioned you on");
    expect(verb({ kind: "commentAdded", mention: false })).toBe("commented on");
    expect(verb({ kind: "fieldChanged", mention: false })).toBe("updated");
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

describe("what a workstream's audit line says", () => {
  let seq = 0;
  const ev = (actor: WorkstreamEvent["actor"], action: string, runId: string | null = null, detail: string | null = null): WorkstreamEvent => ({ workstreamId: "w1", seq: ++seq, at: "2026-09-30T10:00:00Z", actor, action, runId, proposalId: null, digest: null, detail });
  const label = (id: string | null) => (id ? id.toUpperCase() : "a run");

  it("words each line by who did it", () => {
    expect(eventText(ev("person", "opened"), label)).toBe("You opened the workstream");
    expect(eventText(ev("person", "run_approved", "r1"), label)).toBe("You started R1");
    expect(eventText(ev("supervisor", "wake", "r1", "r1|done"), label)).toBe("Pip picked up R1");
  });

  it("words a pause and a resume by who made them", () => {
    expect(eventText(ev("person", "paused"), label)).toBe("You paused the workstream");
    expect(eventText(ev("supervisor", "paused"), label)).toBe("The workstream was paused");
    expect(eventText(ev("person", "resumed"), label)).toBe("You resumed the workstream");
  });

  it("leaves out what earlier versions recorded", () => {
    const old = ["autostart", "fix_round_sent", "fix_rounds_exhausted", "steps_allowed", "budget_reset", "rule_set", "mode_set", "escalation_taken", "escalation_posted", "readiness_asked", "clarity_asked", "reporter_nudged", "clarity_reset"];
    expect(old.map((a) => eventText(ev("supervisor", a, "r3", "5"), label))).toEqual(old.map(() => null));
  });
});

describe("dayBreaks (G22)", () => {
  const now = new Date(2026, 9, 14, 15, 0);
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();
  const e = (key: string, iso: string) => ({ key, at: iso });

  it("is empty while every entry is from today, where the clock times say enough", () => {
    expect(dayBreaks([e("a", at(14, 9)), e("b", at(14, 11))], now).size).toBe(0);
    expect(dayBreaks([], now).size).toBe(0);
  });

  it("labels the first entry of each day once an earlier day is in the list, today included", () => {
    const out = dayBreaks([e("a", at(13, 9)), e("b", at(13, 17)), e("c", at(14, 8)), e("d", at(14, 9))], now);
    expect([...out]).toEqual([["a", "Yesterday"], ["c", "Today"]]);
    expect([...dayBreaks([e("a", at(2, 9)), e("b", at(14, 9))], now).values()]).toEqual([dayLabel(new Date(at(2, 9)), now), "Today"]);
  });

  it("passes an entry with no readable time by", () => {
    expect([...dayBreaks([e("x", "never"), e("a", at(13, 9))], now)]).toEqual([["a", "Yesterday"]]);
  });
});
