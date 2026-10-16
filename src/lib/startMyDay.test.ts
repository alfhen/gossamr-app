import { describe, expect, it } from "vitest";
import type { Intent, PersonRef, Proposal, WorkItem, WorkstreamView } from "../types";
import type { Need } from "./needs";
import { dayKey } from "../workspace/activityLogic";
import { DAY_ENTRIES, startMyDay, startMyDayShown, type StartMyDayInput } from "./startMyDay";
import { NUDGE_COMMENT_LABEL } from "./proposals";
import type { ClarityLearning } from "./clarityLearning";
import type { WorkstreamWither } from "./workstreamWither";

const NOW = new Date("2026-10-13T09:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ME: PersonRef = { connectionId: "c", accountId: "me" };
const OTHER: PersonRef = { connectionId: "c", accountId: "someone" };

const need = (key: string, group: Need["group"], over: Partial<Need> = {}): Need =>
  ({ key, group, kind: "draft", workstreamId: "w1", ticketKey: "CA-401", head: null, title: "R1 asks a question", why: "", ifYouWait: "", at: "2026-10-12T10:00:00Z", primary: { id: "open", label: "Open" }, secondary: [], target: { type: "run", id: "r1" }, batchable: false, ...over }) as Need;

const view = (id: string, key: string | null, over: Partial<WorkstreamView> = {}, ws: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({ workstream: { id, connectionId: "c", itemKey: key, title: key ?? "Untitled", closedAt: null, createdAt: ago(9), ...ws }, stage: "intake", runs: [], labels: [], budget: {}, ...over }) as unknown as WorkstreamView;

const item = (key: string, body: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ item: { connectionId: "c", externalId: key, key }, title: `Title of ${key}`, body: { blocks: body ? [{ type: "paragraph", content: [{ type: "text", text: body, marks: [] }] }] : [] }, status: { id: "1", name: "To do", category: "new" }, assignee: ME, updated: ago(1), ...over }) as unknown as WorkItem;

const comment = (id: string, key: string, over: Partial<Proposal> = {}): Proposal =>
  ({ id, createdAt: ago(1), updatedAt: ago(1), origin: { type: "board" }, createdBy: "pip", intent: { type: "comment", item: { connectionId: "c", externalId: key, key }, body: { blocks: [] } } as unknown as Intent, label: null, basis: null, state: { type: "pending" }, revisions: [], created: [], error: null, run: null, ...over }) as Proposal;

const wither = (days: number, over: Partial<WorkstreamWither> = {}): WorkstreamWither => ({ level: 3, days, since: ago(days), runs: 2, turns: 0, text: `No Jira update for ${days} days`, ...over });

const input = (over: Partial<StartMyDayInput> = {}): StartMyDayInput => ({ needs: [], workstreams: [], withers: {}, proposals: [], items: [], me: [ME], learning: {}, now: NOW, ...over });
const line = (i: StartMyDayInput, kind: string) => startMyDay(i).lines.find((l) => l.kind === kind);

describe("Start my day", () => {
  it("is empty when nothing waits, and has no line for what is empty", () => {
    expect(startMyDay(input())).toEqual({ lines: [], empty: true });
  });

  it("counts Needs you by kind: Decide, Unblock, Approve, each opening its need, oldest first", () => {
    const needs = [need("a2", "approve", { at: "2026-10-12T12:00:00Z" }), need("d1", "decide", { title: "Approve the plan", at: "2026-10-12T11:00:00Z" }), need("u1", "unblock"), need("a1", "approve", { at: "2026-10-12T09:00:00Z" })];
    const day = startMyDay(input({ needs }));
    expect(day.lines.map((l) => [l.kind, l.title])).toEqual([
      ["decide", "1 to decide"],
      ["unblock", "1 to unblock"],
      ["approve", "2 to approve"],
    ]);
    const approve = day.lines.find((l) => l.kind === "approve")!;
    expect(approve.entries.map((e) => e.key)).toEqual(["a1", "a2"]);
    expect(approve.entries[0]).toMatchObject({ label: "Open", text: "CA-401 · R1 asks a question", action: { type: "need", need: needs[3] } });
    expect(line(input({ needs }), "decide")!.entries[0].text).toBe("CA-401 · Approve the plan");
  });

  it("lists at most a few entries and says how many more", () => {
    const needs = Array.from({ length: 5 }, (_, i) => need(`a${i}`, "approve", { at: `2026-10-12T0${i}:00:00Z` }));
    const l = line(input({ needs }), "approve")!;
    expect([l.count, l.entries.length, l.more, DAY_ENTRIES]).toEqual([5, 3, 2, 3]);
    expect(l.title).toBe("5 to approve");
  });

  describe("unclear tickets", () => {
    const THIN = "Make the winback flow better.";
    it("names every open workstream whose notice stands, whoever the ticket is assigned to, and opens its workstream", () => {
      const v = view("w1", "CA-408", { clarity: { gaps: ["short", "done"] } });
      const l = line(input({ workstreams: [v], items: [item("CA-408", THIN, { assignee: OTHER })] }), "unclear")!;
      expect(l.title).toBe("1 ticket may be unclear");
      expect(l.entries).toEqual([{ key: "unclear:w1", text: "CA-408 may be unclear: it has a very short description and doesn't say what done looks like.", label: "Open workstream", action: { type: "workstream", id: "w1" } }]);
    });

    it("also lists the signed-in person's own tickets with no workstream, and not other people's, done ones, or ones that say it all", () => {
      const clear = "The welcome flow should send three emails. Only the welcome flow is in scope. The CRM team is waiting on it. Done when all three send in the sandbox.";
      const items = [item("CA-1", THIN), item("CA-2", THIN, { assignee: OTHER }), item("CA-3", THIN, { status: { id: "9", name: "Done", category: "done" } }), item("CA-4", clear), item("CA-5", THIN, { assignee: null })];
      const l = line(input({ items }), "unclear")!;
      expect(l.entries.map((e) => [e.key, e.label, e.action])).toEqual([["unclear:CA-1", "Open ticket", { type: "ticket", key: "CA-1" }]]);
    });

    it("lists a ticket once: the one with a workstream is the workstream's, and a closed workstream's is the ticket's", () => {
      const open = view("w1", "CA-1", { clarity: { gaps: ["short"] } });
      const l = line(input({ workstreams: [open], items: [item("CA-1", THIN), item("CA-6", THIN)] }), "unclear")!;
      expect(l.entries.map((e) => e.key)).toEqual(["unclear:w1", "unclear:CA-6"]);
      const closed = view("w2", "CA-7", { clarity: { gaps: ["short"] } }, { closedAt: ago(1) });
      expect(line(input({ workstreams: [closed] }), "unclear")).toBeUndefined();
    });

    it("leaves a ticket out that already has a need: its group lists it, and the need comes first", () => {
      const v = view("w1", "CA-408", { clarity: { gaps: ["short", "done"] } });
      const other = view("w2", "CA-409", { clarity: { gaps: ["short"] } });
      const needs = [need("d1", "decide", { workstreamId: "w1", ticketKey: "CA-408" })];
      expect(line(input({ workstreams: [v, other], needs }), "unclear")!.entries.map((e) => e.key)).toEqual(["unclear:w2"]);
      expect(line(input({ workstreams: [v], needs }), "decide")).toBeDefined();
      expect(line(input({ workstreams: [v], needs }), "unclear")).toBeUndefined();
      // A need in General about the ticket counts too, for a workstream and for a ticket with none.
      const general = [need("g1", "unblock", { workstreamId: null, ticketKey: "CA-1" })];
      expect(line(input({ items: [item("CA-1", THIN), item("CA-2", THIN)], needs: general }), "unclear")!.entries.map((e) => e.key)).toEqual(["unclear:CA-2"]);
      expect(line(input({ workstreams: [v], needs: [need("g2", "unblock", { workstreamId: null, ticketKey: "CA-408" })] }), "unclear")).toBeUndefined();
    });

    it("leaves out the gaps Looks fine taught away for the ticket's project, and a notice with nothing left", () => {
      const learning: ClarityLearning = { CA: { who: 3, done: 3 } };
      const v = view("w1", "CA-408", { clarity: { gaps: ["short", "done", "who"] } });
      expect(line(input({ workstreams: [v], learning }), "unclear")!.entries[0].text).toBe("CA-408 may be unclear: it has a very short description.");
      const only = view("w2", "CA-409", { clarity: { gaps: ["done", "who"] } });
      expect(line(input({ workstreams: [only], learning }), "unclear")).toBeUndefined();
      // Another project is told as before; and a ticket's own thin words are filtered the same way.
      expect(line(input({ workstreams: [view("w3", "CE-1", { clarity: { gaps: ["who"] } })], learning }), "unclear")).toBeDefined();
      expect(line(input({ items: [item("CA-9", "Make it better and the team is waiting. Only this.")], learning: { CA: { short: 3, done: 3 } } }), "unclear")).toBeUndefined();
    });
  });

  describe("waiting on the reporter", () => {
    it("lists each workstream with the days, the longest first; a wait of days offers the nudge", () => {
      const a = view("w1", "CA-408", { waitingOnReporter: { since: ago(3.2) } });
      const b = view("w2", "CA-409", { waitingOnReporter: { since: ago(0.2) } });
      const c = view("w3", "CA-410", { waitingOnReporter: { since: ago(5) } });
      const l = line(input({ workstreams: [a, b, c] }), "reporter")!;
      expect(l.title).toBe("3 waiting on the reporter");
      expect(l.entries.map((e) => [e.text, e.label, e.action.type])).toEqual([
        ["CA-410 · waiting 5 days", "Draft a nudge", "nudge"],
        ["CA-408 · waiting 3 days", "Draft a nudge", "nudge"],
        ["CA-409 · waiting since today", "Open workstream", "workstream"],
      ]);
    });

    it("says a nudge is drafted and offers none while it waits", () => {
      const a = view("w1", "CA-408", { waitingOnReporter: { since: ago(3) } });
      const nudge = comment("n1", "CA-408", { label: NUDGE_COMMENT_LABEL, createdBy: "user", origin: { type: "chat", requestId: "nudge:w1", workstream: "w1" } });
      const e = line(input({ workstreams: [a], proposals: [nudge] }), "reporter")!.entries[0];
      expect(e).toMatchObject({ text: "CA-408 · waiting 3 days · a nudge is drafted", label: "Open workstream", action: { type: "workstream", id: "w1" } });
    });

    it("is not a need: nothing here adds to Needs you", () => {
      const a = view("w1", "CA-408", { waitingOnReporter: { since: ago(9) } });
      const day = startMyDay(input({ workstreams: [a] }));
      expect(day.lines.map((l) => l.kind)).toEqual(["reporter"]);
    });
  });

  it("lists the cobwebbed workstreams with their days, the quietest first, and leaves the reporter's silence to its own line", () => {
    const a = view("w1", "CA-401");
    const b = view("w2", "CA-402");
    const c = view("w3", "CA-408", { waitingOnReporter: { since: ago(4) } });
    const withers = { w1: wither(3), w2: wither(7), w3: wither(4, { reporter: true }) };
    const l = line(input({ workstreams: [a, b, c], withers }), "cobweb")!;
    expect(l.title).toBe("2 workstreams gone quiet in Jira");
    expect(l.entries.map((e) => [e.text, e.action])).toEqual([
      ["CA-402 · no Jira update for 7 days", { type: "workstream", id: "w2" }],
      ["CA-401 · no Jira update for 3 days", { type: "workstream", id: "w1" }],
    ]);
  });

  describe("Jira drafts waiting to be posted", () => {
    it("lists pending Jira writes that Needs you does not list, oldest first, so a draft with a need is on its decide, unblock or approve line only", () => {
      const first = comment("p1", "CA-401", { createdAt: ago(3) });
      const move = comment("p2", "CA-402", { createdAt: ago(1), intent: { type: "transition", item: { connectionId: "c", externalId: "CA-402", key: "CA-402" }, to: "31" } as Intent });
      const run = comment("p3", "CA-403", { intent: { type: "startRun", connectionId: "c", item: null, spec: {} } as unknown as Intent });
      const done = comment("p4", "CA-404", { state: { type: "applied" } });
      const skipped = comment("p5", "CA-405", { state: { type: "skipped" } });
      const needs = [need("draft:p1", "approve", { title: "Draft comment", target: { type: "draft", id: "p1" } })];
      const l = line(input({ proposals: [move, first, run, done, skipped], needs }), "drafts")!;
      expect(l.title).toBe("1 Jira draft waiting to be posted");
      expect(l.entries.map((e) => [e.text, e.label, e.action.type])).toEqual([["CA-402 · Draft move", "Open ticket", "ticket"]]);
      expect(line(input({ proposals: [first], needs }), "drafts")).toBeUndefined();
      expect(line(input({ proposals: [first], needs }), "approve")!.entries).toHaveLength(1);
    });

    it("opens the workstream a draft belongs to when it has no need of its own", () => {
      const v = view("w1", "CA-401");
      const own = comment("p1", "CA-401", { origin: { type: "chat", requestId: "r", workstream: "w1" } });
      expect(line(input({ proposals: [own], workstreams: [v] }), "drafts")!.entries[0]).toMatchObject({ label: "Open workstream", action: { type: "workstream", id: "w1" } });
    });
  });

  it("keeps the lines in the order of the day: needs, unclear (so it is not below the fold), the drafts waiting on you, reporter, cobwebs", () => {
    const v = view("w1", "CA-408", { clarity: { gaps: ["short"] }, waitingOnReporter: { since: ago(3) } });
    const w = view("w2", "CA-401");
    const day = startMyDay(input({ needs: [need("u1", "unblock", { workstreamId: "w9", ticketKey: "CA-900" })], workstreams: [v, w], withers: { w2: wither(4) }, proposals: [comment("p1", "CA-401")] }));
    expect(day.lines.map((l) => l.kind)).toEqual(["unblock", "unclear", "drafts", "reporter", "cobweb"]);
    expect(day.empty).toBe(false);
  });
});

describe("once a day", () => {
  it("shows until the person says Done for now, for the rest of that day only", () => {
    const morning = new Date(2026, 9, 13, 8, 0);
    const evening = new Date(2026, 9, 13, 22, 30);
    const tomorrow = new Date(2026, 9, 14, 7, 0);
    expect(dayKey(morning)).toBe("2026-10-13");
    expect(startMyDayShown(null, morning)).toBe(true);
    expect(startMyDayShown(dayKey(morning), evening)).toBe(false);
    expect(startMyDayShown(dayKey(morning), tomorrow)).toBe(true);
    // A day later than today (a clock turned back) holds it too.
    expect(startMyDayShown("2026-10-20", morning)).toBe(false);
  });
});

describe("the order of the lines", () => {
  it("lists the entries past the first few in `rest`, so the card can show them", () => {
    const needs = Array.from({ length: 5 }, (_, i) => need(`a${i}`, "approve", { at: `2026-10-12T0${i}:00:00Z` }));
    const l = line(input({ needs }), "approve")!;
    expect(l.rest!.map((e) => e.key)).toEqual(["a3", "a4"]);
  });
});
