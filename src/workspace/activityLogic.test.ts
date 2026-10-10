import { describe, expect, it } from "vitest";
import type { FeedEntry, Proposal, WorkItem, WorkstreamEvent, WorkstreamView } from "../types";
import { CHIPS, CHIP_LABEL, buildRows, chipsFor, toWorkstreamEntries, dayLabel, draftsFor, groupByDay, initials, queryFor, stepIndex, verb, withRead } from "./activityLogic";

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

describe("the Pip & agents chip", () => {
  const ws = { workstream: { id: "w1", connectionId: "c", itemKey: "A-1", title: "A-1 Title", closedAt: null }, stage: "plan", runs: ["r1", "r2", "r3"], labels: [["r1", "R1"], ["r2", "R2"], ["r3", "R3"]] } as unknown as WorkstreamView;
  let seq = 0;
  const ev = (minute: number, actor: WorkstreamEvent["actor"], action: string, runId: string | null = null, detail: string | null = null): WorkstreamEvent => ({ workstreamId: "w1", seq: ++seq, at: `2026-09-30T10:${String(minute).padStart(2, "0")}:00Z`, actor, action, runId, proposalId: null, digest: null, detail });
  const events = {
    w1: [
      ev(0, "person", "opened"),
      ev(1, "person", "run_approved", "r1"),
      ev(2, "supervisor", "wake", "r1", "r1|done"),
      ev(3, "supervisor", "autostart", "r2", "investigate_triage after r1"),
      ev(4, "person", "held", null, "person"),
      ev(5, "person", "resumed", null, "person"),
      ev(6, "supervisor", "autostart", "r3", "fix_round after r2"),
      ev(7, "supervisor", "fix_round_sent", "r3", "120"),
      ev(8, "supervisor", "budget", null, "amber"),
    ],
  };

  it("is offered only while Agents are on, after the usual chips", () => {
    expect(chipsFor({ agents: false })).toEqual(CHIPS);
    expect(chipsFor({ agents: true })).toEqual([...CHIPS, "pip"]);
    expect(CHIP_LABEL.pip).toBe("Pip & agents");
  });

  it("words each audit line, newest first, with the workstream's ticket as its item", () => {
    const ref = { connectionId: "c", externalId: "A-1", key: "A-1" };
    const entries = toWorkstreamEntries(events, [ws], () => ref);
    expect(entries.map((e) => e.text)).toEqual([
      "Fix round 1 sent to R3",
      "You resumed the workstream",
      "You held the workstream",
      "Triage R2 started automatically after R1",
      "Pip picked up R1",
      "You started R1",
      "You opened the workstream",
    ]);
    expect(entries[0]).toMatchObject({ source: "pip", workstreamId: "w1", itemKey: "A-1", item: ref, runId: "r3", action: "fix_round_sent", unread: false });
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(toWorkstreamEntries({}, [ws])).toEqual([]);
  });

  it("is the workstreams' audit alone, newest first, and nothing of it shows under the other chips", () => {
    const entries = toWorkstreamEntries(events, [ws], () => ({ connectionId: "c", externalId: "A-1", key: "A-1" }));
    const input = { source: "all" as const, container: null, jira: [entry("j1", "2026-09-30T10:30:00Z")], more: false, code: [], agents: [], workstream: entries, containerOf: () => null };
    const pip = buildRows({ ...input, chip: "pip" });
    expect(pip.every((r) => r.source === "pip")).toBe(true);
    expect(pip.map((r) => r.entry.at)).toEqual([...pip.map((r) => r.entry.at)].sort().reverse());
    expect(pip).toHaveLength(entries.length);
    expect(buildRows({ ...input, chip: "all" }).map((r) => r.source)).toEqual(["jira"]);
    // Narrowed to a project through the workstream's ticket.
    expect(buildRows({ ...input, chip: "pip", container: { connectionId: "c", externalId: "OTHER" }, containerOf: () => ({ connectionId: "c", externalId: "P" }) })).toEqual([]);
  });
});
