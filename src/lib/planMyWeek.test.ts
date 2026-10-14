import { describe, expect, it } from "vitest";
import { HELD_PERSON } from "../types";
import type { PersonRef, WorkItem, WorkstreamView } from "../types";
import type { Need } from "./needs";
import { docFromText } from "./docs";
import { WEEKS_KEPT, WEEK_PICKS, weekLabel, isoWeek, itemDone, itemOutcome, keepPlan, movePick, parseWeekPlans, planMyWeek, rankWeek, liveWorkstreamOf, reopenItem, reopenedWithoutWorkstream, ticketPick, type PlanInput, type PlanItem } from "./planMyWeek";

const NOW = new Date("2026-10-13T09:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ME: PersonRef = { connectionId: "c", accountId: "me" };
const OTHER: PersonRef = { connectionId: "c", accountId: "other" };
const FINE = "The checkout total must show the discount, only for codes that are valid today. The customer asked for it, and the support team is waiting. Done when the total and the order e-mail agree.";

const need = (workstreamId: string, over: Partial<Need> = {}): Need => ({ key: `n-${workstreamId}-${over.title ?? "x"}`, group: "unblock", kind: "draft", workstreamId, head: null, title: "R1 asks a question", why: "", ifYouWait: "", at: ago(1), primary: { id: "open", label: "Open" }, secondary: [], target: { type: "run", id: "r1" }, batchable: false, ...over }) as Need;

const ws = (id: string, key: string | null, over: Partial<WorkstreamView> = {}, w: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
  ({ workstream: { id, connectionId: "c", itemKey: key, title: key ? `${key} Work on ${id}` : id, heldReason: null, closedAt: null, createdAt: ago(2), ...w }, stage: "intake", runs: [], labels: [], budget: {}, ...over }) as unknown as WorkstreamView;

const ticket = (key: string, over: Partial<WorkItem> = {}, body = FINE): WorkItem =>
  ({ item: { connectionId: "c", externalId: key, key }, title: `Title of ${key}`, body: docFromText(body), status: { id: "1", name: "To do", category: "todo" }, assignee: ME, priority: null, created: ago(2), updated: ago(1), ...over }) as unknown as WorkItem;

const input = (over: Partial<PlanInput> = {}): PlanInput => ({ workstreams: [], items: [], me: [ME], needs: [], runs: [], now: NOW, ...over });
const ids = (i: PlanInput) => planMyWeek(i).map((p) => p.id);

describe("planMyWeek: the ranking", () => {
  it("proposes three by default, and as many as asked", () => {
    const items = ["CA-1", "CA-2", "CA-3", "CA-4", "CA-5"].map((k) => ticket(k));
    expect(WEEK_PICKS).toBe(3);
    expect(planMyWeek(input({ items }))).toHaveLength(3);
    expect(planMyWeek(input({ items, count: 5 }))).toHaveLength(5);
    expect(planMyWeek(input({ items, count: 9 }))).toHaveLength(5);
    expect(planMyWeek(input({ items, count: 0 }))).toEqual([]);
  });

  it("is deterministic: the same page gives the same list, whatever order it holds things in", () => {
    const items = [ticket("CA-1"), ticket("CA-2"), ticket("CA-3", { priority: "high" })];
    const a = ids(input({ items }));
    expect(ids(input({ items: [...items].reverse() }))).toEqual(a);
    expect(ids(input({ items }))).toEqual(a);
  });

  it("puts a workstream with a need in it first, however old or pressing the others are, decide before unblock before approve", () => {
    const i = input({
      workstreams: [ws("w1", "CA-1", {}, { createdAt: ago(1) }), ws("w2", "CA-2"), ws("w3", "CA-3")],
      items: [ticket("CA-9", { priority: "highest", created: ago(60) })],
      needs: [need("w1", { group: "approve" }), need("w3", { group: "decide", title: "Approve the plan" })],
    });
    expect(ids(i).slice(0, 2)).toEqual(["ws:w3", "ws:w1"]);
    const first = planMyWeek(i)[0];
    expect(first.because).toBe("1 thing needs you here: Approve the plan.");
  });

  it("says how many things need you, and takes the older need first within a group", () => {
    const i = input({ workstreams: [ws("w1", "CA-1"), ws("w2", "CA-2")], needs: [need("w1", { at: ago(1) }), need("w1", { title: "Draft comment", at: ago(2) }), need("w2", { at: ago(3) })] });
    expect(ids(i)).toEqual(["ws:w2", "ws:w1"]);
    expect(planMyWeek(i)[1].because).toMatch(/^2 things need you here: Draft comment\./);
  });

  it("leaves out what is waiting on the reporter, held (by you or the system), and closed", () => {
    const i = input({
      workstreams: [ws("w1", "CA-1", { waitingOnReporter: { since: ago(3) } }), ws("w2", "CA-2", {}, { heldReason: HELD_PERSON }), ws("w3", "CA-3", {}, { heldReason: "restart" }), ws("w4", "CA-4", {}, { closedAt: ago(1) }), ws("w5", "CA-5", { stage: "done" }), ws("w6", "CA-6")],
    });
    expect(ids(i)).toEqual(["ws:w6"]);
  });

  it("keeps a held workstream in when it has a need, since the need is asked of you", () => {
    expect(ids(input({ workstreams: [ws("w1", "CA-1", {}, { heldReason: "restart" })], needs: [need("w1")] }))).toEqual(["ws:w1"]);
  });

  it("ranks by priority and age, and says which", () => {
    const items = [ticket("CA-1", { created: ago(2) }), ticket("CA-2", { priority: "highest", created: ago(2) }), ticket("CA-3", { created: ago(40) })];
    const picks = planMyWeek(input({ items }));
    expect(picks.map((p) => p.ticketKey)).toEqual(["CA-3", "CA-2", "CA-1"]);
    expect(picks.find((p) => p.ticketKey === "CA-2")!.because).toBe("highest priority, assigned to you, no workstream yet.");
    expect(picks.find((p) => p.ticketKey === "CA-3")!.because).toBe("assigned to you for 40 days, no workstream yet.");
  });

  it("ranks a ticket that reads thin below a clear one, and says to clear it up first", () => {
    const items = [ticket("CA-1", { created: ago(10) }, "Fix it."), ticket("CA-2", { created: ago(10) })];
    const picks = planMyWeek(input({ items }));
    expect(picks.map((p) => p.ticketKey)).toEqual(["CA-2", "CA-1"]);
    expect(picks[1].because).toMatch(/^assigned to you for 10 days, but it .*; ask the reporter \d questions? before anyone builds on it\.$/);
  });

  it("stops flagging a gap the person taught away, as the clarity notice does", () => {
    const thin = ticket("CA-1", { created: ago(10) }, "Fix it.");
    const flagged = planMyWeek(input({ items: [thin] }))[0].because;
    const learning = { CA: { empty: 3, short: 3, done: 3, scope: 3, who: 3 } };
    expect(flagged).toMatch(/ask the reporter/);
    expect(planMyWeek(input({ items: [thin], learning }))[0].because).not.toMatch(/ask the reporter/);
    expect(planMyWeek(input({ items: [thin], learning }))[0].work).toBeUndefined();
  });

  it("only takes the person's own open tickets, and none that already has an open workstream", () => {
    const items = [ticket("CA-1", { assignee: OTHER }), ticket("CA-2", { assignee: null }), ticket("CA-3", { status: { id: "9", name: "Done", category: "done" } }), ticket("CA-4"), ticket("CA-5")];
    expect(ids(input({ items, workstreams: [ws("w5", "CA-5")] })).sort()).toEqual(["ticket:c:CA-4", "ws:w5"]);
  });

  it("puts a workstream whose cobweb grew, or that has a run going, ahead of a bare one, and says so", () => {
    const quiet = ws("w1", "CA-1");
    const running = ws("w2", "CA-2", { runs: ["r1"] });
    const bare = ws("w3", "CA-3");
    const withers = { w1: { level: 3 as const, days: 6, since: ago(6), runs: 2, turns: 0, text: "" } };
    const runs = [{ id: "r1", state: "working", spec: { kind: "build", workstream: "w2" }, queuedAt: ago(0.1), launchedAt: ago(0.1), endedAt: null }] as never;
    const picks = planMyWeek(input({ workstreams: [bare, running, quiet], withers, runs, count: 3 }));
    expect(picks.map((p) => p.id)).toEqual(["ws:w1", "ws:w2", "ws:w3"]);
    expect(picks[0].because).toBe("no Jira update for 6 days; Jira has not heard from it.");
    expect(picks[1].because).toBe("work is already going; keep it moving.");
  });

  it("gives every pick a one-line because, and links it to its workstream or ticket", () => {
    const picks = planMyWeek(input({ workstreams: [ws("w1", "CA-1")], items: [ticket("CA-2")] }));
    for (const p of picks) expect(p.because).toMatch(/^[^\n]+\.$/);
    expect(picks[0]).toMatchObject({ kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", title: "CA-1 Work on w1" });
    expect(picks[1]).toMatchObject({ kind: "ticket", workstreamId: null, ticketKey: "CA-2", id: "ticket:c:CA-2" });
  });

  it("is empty when there is nothing free, and rankWeek lists every candidate", () => {
    expect(planMyWeek(input())).toEqual([]);
    expect(rankWeek(input({ items: [ticket("CA-1"), ticket("CA-2")] }))).toHaveLength(2);
  });
});

describe("planMyWeek: needs in General that name a ticket", () => {
  const loose = (key: string, over: Partial<Need> = {}) => need(null as unknown as string, { ticketKey: key, key: `g-${key}`, title: "Draft comment", ...over });

  it("ranks an assigned ticket with such a need first, and its line names the need instead of a clarity gap", () => {
    const thin = ticket("CA-1", {}, "Fix it.");
    const plain = ticket("CA-2", { priority: "highest" });
    const out = planMyWeek(input({ items: [plain, thin], needs: [loose("CA-1")] }));
    expect(out.map((p) => p.id)).toEqual(["ticket:c:CA-1", "ticket:c:CA-2"]);
    expect(out[0].because).toBe("1 thing needs you here: Draft comment. The ticket is 2 days old.");
    expect(out[0].because).not.toContain("ask the reporter");
  });

  it("still proposes an unassigned ticket that has one, and counts several", () => {
    const out = planMyWeek(input({ items: [ticket("CA-3", { assignee: OTHER })], needs: [loose("CA-3"), loose("CA-3", { key: "g2", title: "Move to Done" })] }));
    expect(out).toHaveLength(1);
    expect(out[0].because).toMatch(/^2 things need you here: /);
  });

  it("puts an open workstream on that ticket in the first tier too, and leaves out a need with no ticket", () => {
    const out = rankWeek(input({ workstreams: [ws("w1", "CA-4"), ws("w2", "CA-5")], items: [ticket("CA-6")], needs: [loose("CA-5"), loose("CA-9", { ticketKey: undefined })] }));
    expect(out.map((p) => p.id)).toEqual(["ws:w2", "ws:w1", "ticket:c:CA-6"]);
    expect(out[0].because).toContain("thing needs you here");
  });

  it("keeps the same key on two connections apart: a need placed through its run promotes only that connection's ticket", () => {
    const run = { id: "r1", connectionId: "c2", item: { connectionId: "c2", externalId: "CA-1", key: "CA-1" } } as unknown as PlanInput["runs"][number];
    const out = planMyWeek(input({ items: [ticket("CA-1"), ticket("CA-1", { item: { connectionId: "c2", externalId: "CA-1", key: "CA-1" } } as Partial<WorkItem>)], me: [ME, { connectionId: "c2", accountId: "me" }], runs: [run], needs: [loose("CA-1", { runId: "r1" })] }));
    const promoted = out.filter((p) => p.because.includes("needs you here"));
    expect(promoted.map((p) => p.id)).toEqual(["ticket:c2:CA-1"]);
    expect(out.map((p) => p.id)).toContain("ticket:c:CA-1");
  });

  it("matches a need with no run only where the key is on one connection", () => {
    const two = [ticket("CA-1"), ticket("CA-1", { item: { connectionId: "c2", externalId: "CA-1", key: "CA-1" } } as Partial<WorkItem>)];
    const me = [ME, { connectionId: "c2", accountId: "me" }];
    expect(planMyWeek(input({ items: two, me, needs: [loose("CA-1")] })).some((p) => p.because.includes("needs you here"))).toBe(false);
    expect(planMyWeek(input({ items: [two[0]], needs: [loose("CA-1")] }))[0].because).toContain("thing needs you here");
    // A Done ticket with the key on the other connection is never picked, so it leaves the open one unambiguous.
    const doneElsewhere = ticket("CA-1", { item: { connectionId: "c2", externalId: "CA-1", key: "CA-1" }, status: { id: "9", name: "Done", category: "done" } } as Partial<WorkItem>);
    const out = planMyWeek(input({ items: [two[0], doneElsewhere], me, needs: [loose("CA-1")] }));
    expect(out[0]).toMatchObject({ id: "ticket:c:CA-1" });
    expect(out[0].because).toContain("thing needs you here");
  });

  it("leaves out a held or waiting workstream even when a need in General names its ticket, and keeps an eligible one", () => {
    const held = ws("w1", "CA-4", {}, { heldReason: HELD_PERSON });
    const waiting = ws("w2", "CA-5", { waitingOnReporter: { since: ago(1) } } as Partial<WorkstreamView>);
    const fine = ws("w3", "CA-6");
    const out = rankWeek(input({ workstreams: [held, waiting, fine], needs: [loose("CA-4"), loose("CA-5"), loose("CA-6")] }));
    expect(out.map((p) => p.id)).toEqual(["ws:w3"]);
    expect(out[0].because).toContain("thing needs you here");
  });

  it("keeps a ticket with gaps and no need on its current line", () => {
    const out = planMyWeek(input({ items: [ticket("CA-7", {}, "Fix it.")] }));
    expect(out[0]).toMatchObject({ work: "clarify", title: "Clarify CA-7 with the reporter" });
    expect(out[0].because).toContain("ask the reporter");
  });
});

describe("planMyWeek: unclear tickets are asking work, and at most one of them", () => {
  const thin = (key: string, over: Partial<WorkItem> = {}) => ticket(key, over, "Fix it.");

  it("proposes an unclear ticket as clarify work, titled for the reporter, not as building", () => {
    const [p] = planMyWeek(input({ items: [thin("CA-1", { created: ago(12), priority: "high" })] }));
    expect(p).toMatchObject({ kind: "ticket", ticketKey: "CA-1", work: "clarify", title: "Clarify CA-1 with the reporter", id: "ticket:c:CA-1" });
    expect(p.because).toBe("high priority, assigned to you for 12 days, but it has a very short description, doesn't say what done looks like, doesn't say what's in or out of scope, and doesn't say who is waiting on it; ask the reporter 4 questions before anyone builds on it.");
  });

  it("takes only one unclear pick while anything else is there, and the best ranked of them", () => {
    const items = [thin("CA-1", { created: ago(5) }), thin("CA-2", { created: ago(30) }), thin("CA-3", { created: ago(9) }), ticket("CA-4", { created: ago(1) }), ticket("CA-5", { created: ago(2) })];
    const picks = planMyWeek(input({ items }));
    expect(picks.map((p) => p.ticketKey)).toEqual(["CA-5", "CA-4", "CA-2"]);
    expect(picks.filter((p) => p.work === "clarify")).toHaveLength(1);
    expect(planMyWeek(input({ items, count: 9 })).filter((p) => p.work === "clarify").length).toBe(3);
  });

  it("fills the week with more unclear ones only when nothing else exists", () => {
    const items = [thin("CA-1", { created: ago(5) }), thin("CA-2", { created: ago(30) }), thin("CA-3", { created: ago(9) })];
    expect(planMyWeek(input({ items })).map((p) => p.ticketKey)).toEqual(["CA-2", "CA-3", "CA-1"]);
    expect(planMyWeek(input({ items, count: 2 })).filter((p) => p.work === "clarify")).toHaveLength(1 + 1);
    const one = [...items, ticket("CA-4")];
    expect(planMyWeek(input({ items: one, count: 3 })).map((p) => p.ticketKey)).toEqual(["CA-4", "CA-2", "CA-3"]);
  });

  it("gives every pick its own because line, saying what sets this ticket apart", () => {
    const items = [thin("CA-1", { created: ago(5) }), ticket("CA-2", { created: ago(30) }), ticket("CA-3", { created: ago(9), priority: "highest" }), ticket("CA-4", { created: ago(3) })];
    const lines = planMyWeek(input({ items, count: 4 })).map((p) => p.because);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("proposes an idle workstream whose ticket reads thin as clarify work too, until a Triage or Looks fine", () => {
    const w = ws("w1", "CA-8", { clarity: { gaps: ["done", "who"] } }, { createdAt: ago(4) });
    const [p] = planMyWeek(input({ workstreams: [w] }));
    expect(p).toMatchObject({ kind: "workstream", workstreamId: "w1", work: "clarify", title: "Clarify CA-8 with the reporter" });
    expect(p.because).toBe("open for 4 days, but it doesn't say what done looks like and doesn't say who is waiting on it; ask the reporter 2 questions before anyone builds on it.");
    expect(planMyWeek(input({ workstreams: [ws("w1", "CA-8", {}, { createdAt: ago(4) })] }))[0].work).toBeUndefined();
    expect(planMyWeek(input({ workstreams: [w], learning: { CA: { done: 3, who: 3 } } }))[0].work).toBeUndefined();
    // A need in it still comes first, and says so.
    expect(planMyWeek(input({ workstreams: [w], needs: [need("w1")] }))[0].work).toBeUndefined();
  });

  it("tells a need's line which ticket it is: its priority and age, when the ticket is known", () => {
    const i = input({ workstreams: [ws("w1", "CA-1")], items: [ticket("CA-1", { priority: "highest", created: ago(9) })], needs: [need("w1", { title: "Approve the plan" })] });
    expect(planMyWeek(i)[0].because).toBe("1 thing needs you here: Approve the plan. The ticket is highest priority, 9 days old.");
    expect(planMyWeek(input({ workstreams: [ws("w1", "CA-1")], items: [ticket("CA-1", { priority: "highest" })], needs: [] }))[0].because).toBe("highest priority, open for 2 days, nothing is moving it.");
  });
});

describe("reordering and adding", () => {
  const list = ["a", "b", "c"];
  it("moves an item, clamps, and leaves the list itself alone", () => {
    expect(movePick(list, 0, 2)).toEqual(["b", "c", "a"]);
    expect(movePick(list, 2, 0)).toEqual(["c", "a", "b"]);
    expect(movePick(list, 1, 9)).toEqual(["a", "c", "b"]);
    expect(movePick(list, 5, 0)).toEqual(list);
    expect(list).toEqual(["a", "b", "c"]);
  });
  it("makes a pick of a ticket added by hand", () => {
    expect(ticketPick(ticket("CA-7"))).toEqual({ id: "ticket:c:CA-7", kind: "ticket", workstreamId: null, ticketKey: "CA-7", connectionId: "c", title: "CA-7 Title of CA-7", because: "you added it." });
  });
});

describe("ISO weeks", () => {
  it("numbers weeks the ISO way, across a year's turn", () => {
    expect(isoWeek(new Date(2026, 9, 13))).toBe("2026-W42");
    expect(isoWeek(new Date(2026, 9, 11))).toBe("2026-W41");
    expect(isoWeek(new Date(2026, 9, 12))).toBe("2026-W42");
    expect(isoWeek(new Date(2021, 0, 3))).toBe("2020-W53");
    expect(isoWeek(new Date(2021, 0, 4))).toBe("2021-W01");
    expect(isoWeek(new Date(2024, 11, 30))).toBe("2025-W01");
  });
});

describe("the kept plan", () => {
  const item = (id: string): PlanItem => ({ id, kind: "ticket", workstreamId: null, ticketKey: id.slice(7), title: id, because: "x." });
  it("is kept per ISO week, and keeping again replaces that week's", () => {
    const one = keepPlan({}, [item("ticket:CA-1")], NOW);
    expect(Object.keys(one)).toEqual(["2026-W42"]);
    expect(one["2026-W42"]).toMatchObject({ week: "2026-W42", keptAt: NOW.toISOString(), items: [item("ticket:CA-1")] });
    const two = keepPlan(one, [item("ticket:CA-2"), item("ticket:CA-3")], new Date("2026-10-14T09:00:00Z"));
    expect(two["2026-W42"].items.map((p) => p.id)).toEqual(["ticket:CA-2", "ticket:CA-3"]);
    const next = keepPlan(two, [item("ticket:CA-4")], new Date("2026-10-20T09:00:00Z"));
    expect(Object.keys(next)).toEqual(["2026-W42", "2026-W43"]);
  });
  it("remembers only the newest weeks", () => {
    let plans = {};
    for (let n = 0; n < WEEKS_KEPT + 3; n++) plans = keepPlan(plans, [item("ticket:CA-1")], new Date(NOW.getTime() + n * 7 * 86_400_000));
    expect(Object.keys(plans)).toHaveLength(WEEKS_KEPT);
    expect(Object.keys(plans)).not.toContain("2026-W42");
  });
  it("reads stored plans back, dropping what is malformed", () => {
    const stored = JSON.parse(JSON.stringify(keepPlan({}, [item("ticket:CA-1")], NOW)));
    expect(parseWeekPlans(stored)).toEqual(keepPlan({}, [item("ticket:CA-1")], NOW));
    expect(parseWeekPlans(null)).toEqual({});
    expect(parseWeekPlans("x")).toEqual({});
    expect(parseWeekPlans({ nonsense: stored["2026-W42"], "2026-W42": { keptAt: NOW.toISOString(), items: [item("ticket:CA-1"), { id: 4 }] }, "2026-W43": { items: [] } })).toEqual({
      "2026-W42": { week: "2026-W42", keptAt: NOW.toISOString(), items: [item("ticket:CA-1")] },
    });
  });
  const DONE = { id: "9", name: "Done", category: "done" } as WorkItem["status"];
  it("ticks an item when its workstream closes on a ticket that is Done, not before", () => {
    const pick: PlanItem = { id: "ws:w1", kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", title: "CA-1 Thing", because: "x." };
    const closed = ws("w1", "CA-1", {}, { closedAt: ago(1) });
    expect(itemDone(pick, [ws("w1", "CA-1")], [])).toBe(false);
    expect(itemDone(pick, [closed], [ticket("CA-1", { status: DONE })])).toBe(true);
    // The workstream is gone from the lists: not ticked by absence.
    expect(itemDone(pick, [], [])).toBe(false);
    // A closed one and a newer open one for the same ticket: still going.
    expect(itemDone(pick, [closed, ws("w2", "CA-1")], [ticket("CA-1")])).toBe(false);
  });
  it("ticks a ticket item when a workstream opened on it closes with the ticket Done, or the ticket is Done in Jira", () => {
    const pick: PlanItem = ticketPick(ticket("CA-2"));
    expect(itemDone(pick, [], [ticket("CA-2")])).toBe(false);
    expect(itemDone(pick, [ws("w2", "CA-2")], [])).toBe(false);
    expect(itemDone(pick, [ws("w2", "CA-2", {}, { closedAt: ago(1) })], [ticket("CA-2", { status: DONE })])).toBe(true);
    expect(itemDone(pick, [], [ticket("CA-2", { status: DONE })])).toBe(true);
  });
  it("ticks an item whose ticket is Done while its workstream is still open, unless the person reopened it", () => {
    const pick: PlanItem = { id: "ws:w1", kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", title: "CA-1 Thing", because: "x." };
    expect(itemOutcome(pick, [ws("w1", "CA-1")], [ticket("CA-1", { status: DONE })])).toBe("done");
    expect(itemOutcome(pick, [ws("w1", "CA-1")], [ticket("CA-1")])).toBe("open");
    expect(itemOutcome({ ...pick, reopened: true }, [ws("w1", "CA-1")], [ticket("CA-1", { status: DONE })])).toBe("open");
  });
  it("calls a workstream closed on a ticket that is not Done closed, not done: dropped work isn't finished work", () => {
    const pick: PlanItem = { id: "ws:w1", kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", title: "CA-1 Thing", because: "x." };
    const closed = ws("w1", "CA-1", {}, { closedAt: ago(1) });
    expect(itemOutcome(pick, [closed], [ticket("CA-1")])).toBe("closed");
    // A ticket the cache doesn't hold can't be told Done.
    expect(itemOutcome(pick, [closed], [])).toBe("closed");
    expect(itemDone(pick, [closed], [ticket("CA-1")])).toBe(false);
    expect(itemOutcome(pick, [closed], [ticket("CA-1", { status: DONE })])).toBe("done");
    expect(itemOutcome(pick, [ws("w1", "CA-1")], [ticket("CA-1")])).toBe("open");
    expect(itemOutcome(ticketPick(ticket("CA-2")), [ws("w2", "CA-2", {}, { closedAt: ago(1) })], [ticket("CA-2")])).toBe("closed");
  });
  it("keeps a reopened item open, and reopening changes only that item of that week", () => {
    const pick: PlanItem = { id: "ws:w1", kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", title: "CA-1 Thing", because: "x." };
    const other: PlanItem = ticketPick(ticket("CA-3"));
    const closed = ws("w1", "CA-1", {}, { closedAt: ago(1) });
    const plans = keepPlan({}, [pick, other], NOW);
    const after = reopenItem(plans, "2026-W42", "ws:w1");
    expect(after["2026-W42"].items[0]).toEqual({ ...pick, reopened: true });
    expect(after["2026-W42"].items[1]).toEqual(other);
    expect(plans["2026-W42"].items[0]).toEqual(pick);
    expect(itemOutcome(after["2026-W42"].items[0], [closed], [ticket("CA-1", { status: DONE })])).toBe("open");
    expect(reopenItem(plans, "2026-W42", "nope")).toBe(plans);
    expect(reopenItem(plans, "2026-W10", "ws:w1")).toBe(plans);
    // It is stored with the plan, and read back with it.
    expect(parseWeekPlans(JSON.parse(JSON.stringify(after)))).toEqual(after);
  });
  it("tells a reopened item whose workstream is closed: reopening does not reopen the workstream (G16)", () => {
    const pick: PlanItem = { id: "ws:w1", kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", title: "CA-1 Thing", because: "x.", reopened: true };
    const closed = ws("w1", "CA-1", {}, { closedAt: ago(1) });
    expect(reopenedWithoutWorkstream(pick, [closed])).toBe(true);
    // Not reopened: that is the closed mark's business. A live workstream on the ticket, or none known at all, leaves nothing to say.
    expect(reopenedWithoutWorkstream({ ...pick, reopened: false }, [closed])).toBe(false);
    expect(reopenedWithoutWorkstream(pick, [closed, ws("w9", "CA-1")])).toBe(false);
    expect(reopenedWithoutWorkstream(pick, [])).toBe(false);
  });
  it("leads an item to the open workstream on its ticket once its own closed, so Open goes where the work is", () => {
    const pick: PlanItem = { id: "ws:w1", kind: "workstream", workstreamId: "w1", ticketKey: "CA-1", connectionId: "c", title: "CA-1 Thing", because: "x." };
    expect(liveWorkstreamOf(pick, [ws("w1", "CA-1")])).toBe("w1");
    // Its own is preferred while open, even with another on the ticket.
    expect(liveWorkstreamOf(pick, [ws("w9", "CA-1"), ws("w1", "CA-1")])).toBe("w1");
    expect(liveWorkstreamOf(pick, [ws("w1", "CA-1", {}, { closedAt: ago(1) }), ws("w9", "CA-1")])).toBe("w9");
    expect(liveWorkstreamOf(pick, [ws("w1", "CA-1", {}, { closedAt: ago(1) })])).toBeNull();
    // The same key on another connection is another ticket.
    expect(liveWorkstreamOf(pick, [ws("w1", "CA-1", {}, { closedAt: ago(1) }), ws("w9", "CA-1", {}, { connectionId: "d" })])).toBeNull();
  });
  it("ticks only for the item's own connection: the same key on another connection is another ticket", () => {
    const done = { status: { id: "9", name: "Done", category: "done" } } as const;
    const elsewhere = (key: string, over: Partial<WorkItem> = {}) => ticket(key, { item: { connectionId: "d", externalId: key, key }, ...over } as Partial<WorkItem>);
    const mine = ticketPick(ticket("CA-2"));
    expect(mine.connectionId).toBe("c");
    expect(itemDone(mine, [], [elsewhere("CA-2", done)])).toBe(false);
    expect(itemDone(mine, [ws("w9", "CA-2", {}, { connectionId: "d", closedAt: ago(1) })], [])).toBe(false);
    // Its own connection's workstream closing counts (closed, not done, until the ticket is Done); the other connection's does not.
    expect(itemOutcome(mine, [ws("w2", "CA-2", {}, { closedAt: ago(1) })], [])).toBe("closed");
    expect(itemOutcome(mine, [ws("w9", "CA-2", {}, { connectionId: "d", closedAt: ago(1) })], [])).toBe("open");
    expect(itemDone(mine, [ws("w2", "CA-2", {}, { closedAt: ago(1) })], [ticket("CA-2", done)])).toBe(true);
    expect(itemDone(mine, [], [ticket("CA-2", done)])).toBe(true);
    // A workstream pick carries its connection too; the other one's closing leaves it, and a workstream is found by id.
    const picked = planMyWeek(input({ workstreams: [ws("w1", "CA-1")] }))[0];
    expect(picked.connectionId).toBe("c");
    expect(itemDone(picked, [ws("w1", "CA-1")], [])).toBe(false);
    // A stored item from before connections were kept still matches by key alone.
    const { connectionId: _, ...old } = mine;
    // Picks are told apart by connection too, so removing or reordering one never touches the other.
    expect(ticketPick(elsewhere("CA-2")).id).not.toBe(mine.id);
    expect(itemDone(old, [], [elsewhere("CA-2", done)])).toBe(true);
    // An old workstream pick knows its ticket's connection through its workstream: the same key Done elsewhere is not its ticket.
    const { connectionId: __, ...oldPick } = picked;
    expect(itemDone(oldPick, [ws("w1", "CA-1")], [elsewhere("CA-1", done)])).toBe(false);
    expect(itemDone(oldPick, [ws("w1", "CA-1")], [ticket("CA-1", done)])).toBe(true);
  });
  it("keeps the connection through storage, and drops an item whose connection is not text", () => {
    const withConn: PlanItem = { ...ticketPick(ticket("CA-1")) };
    const kept = JSON.parse(JSON.stringify(keepPlan({}, [withConn], NOW)));
    expect(parseWeekPlans(kept)["2026-W42"].items[0].connectionId).toBe("c");
    kept["2026-W42"].items.push({ ...withConn, id: "ticket:CA-9", connectionId: 4 });
    expect(parseWeekPlans(kept)["2026-W42"].items.map((p) => p.id)).toEqual(["ticket:c:CA-1"]);
  });
});

describe("planMyWeek: the because line and the week label", () => {
  it("says what the top need is about, and how many more wait", () => {
    const i = input({ workstreams: [ws("w1", "CA-1")], items: [ticket("CA-1", { created: ago(37) })], needs: [need("w1", { title: "R2 triage · comment", why: "R2 triage drafted a comment on CA-1; it is posted only when you approve it.", at: ago(3) }), need("w1", { title: "Draft move" })] });
    expect(planMyWeek(i)[0].because).toBe("2 things need you here: R2 triage · comment. R2 triage drafted a comment on CA-1; it is posted only when you approve it. (+1 more) The ticket is 37 days old.");
  });

  it("names a week by the Monday it starts on", () => {
    expect(weekLabel("2026-W42")).toBe("week of 12 Oct");
    expect(weekLabel("2026-W01")).toBe("week of 29 Dec");
    expect(weekLabel("nonsense")).toBe("nonsense");
  });
});

describe("planMyWeek: one ask among many needs", () => {
  it("gives a week of three needs and an unclear assigned ticket two needs and one clarify", () => {
    const thin = ticket("CA-9", {}, "Fix it.");
    const i = input({ workstreams: [ws("w1", "CA-1"), ws("w2", "CA-2"), ws("w3", "CA-3")], items: [thin], needs: [need("w1"), need("w2"), need("w3")] });
    const out = planMyWeek(i);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.id)).toEqual(["ws:w1", "ws:w2", "ticket:c:CA-9"]);
    expect(out[2].work).toBe("clarify");
  });

  it("keeps a one-pick week's need rather than giving its only place to an ask", () => {
    const thin = ticket("CA-9", {}, "Fix it.");
    const i = input({ workstreams: [ws("w1", "CA-1")], items: [thin], needs: [need("w1")], count: 1 });
    expect(ids(i)).toEqual(["ws:w1"]);
  });

  it("changes nothing when no unclear work exists", () => {
    const i = input({ workstreams: [ws("w1", "CA-1"), ws("w2", "CA-2"), ws("w3", "CA-3")], needs: [need("w1"), need("w2"), need("w3")] });
    expect(ids(i)).toEqual(["ws:w1", "ws:w2", "ws:w3"]);
  });
});
