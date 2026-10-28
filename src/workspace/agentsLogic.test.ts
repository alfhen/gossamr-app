import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Proposal, Run, RunState, WorkstreamView } from "../types";
import {
  APPROVE_PLAN,
  planOpenQuestions,
  NO_FILTERS,
  QUIET_MINUTES,
  agentGroups,
  applyFilters,
  needsScope,
  needsAttention,
  yourAgents,
  formatTokens,
  groupRunsByWorkstream,
  NO_WORKSTREAM_TITLE,
  ordinal,
  slotPosition,
  slotQueue,
  slotText,
  stoppedText,
  permissionRequest,
  progressText,
  quietMinutes,
  quietText,
  resultHeadline,
  runTitle,
  sortRuns,
  stateView,
  runApproved,
  stepRun,
  slotWaiters,
  stopAllText,
  stoppable,
  summaryLine,
} from "./agentsLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

const sample = (): Run[] => new MockBackend().runs.list();

const base = sample()[0];
const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...base, id: `r-${state}`, state, needs: null, lastDetail: null, tokens: null, lastProgressAt: iso(1), queuedAt: iso(10), endedAt: null, ...over });

describe("quiet runs", () => {
  it("calls a working run quiet at 30 minutes without progress, not at 29", () => {
    expect(QUIET_MINUTES).toBe(30);
    expect(quietMinutes(run("working", { lastProgressAt: iso(29.9) }), NOW)).toBeNull();
    expect(quietMinutes(run("working", { lastProgressAt: iso(30) }), NOW)).toBe(30);
  });

  it("only ever calls a working run quiet", () => {
    for (const state of ["queued", "launching", "needsAnswer", "needsPermission", "done", "failed", "stopped"] as const) {
      expect(quietMinutes(run(state, { lastProgressAt: iso(600) }), NOW)).toBeNull();
    }
  });

  it("says quiet in minutes, then in hours, then in days, and never stuck", () => {
    expect(quietText(40)).toBe("Quiet for 40 min");
    expect(quietText(180)).toBe("Quiet for 3 h");
    expect(quietText(247 * 60)).toBe("Quiet for 10 days");
    expect(quietText(40)).not.toMatch(/stuck/i);
  });
});

describe("how a state looks", () => {
  it("gives every state a word, an icon and a colour, with pip for the ones that need the person", () => {
    const states: RunState[] = ["queued", "launching", "working", "needsAnswer", "needsPermission", "systemBlocked", "done", "failed", "stopped", "unknown"];
    for (const s of states) {
      const v = stateView(run(s), NOW);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.icon).toBeTruthy();
    }
    expect(["needsAnswer", "needsPermission", "systemBlocked"].map((s) => stateView(run(s as RunState), NOW).tone)).toEqual(["pip", "pip", "pip"]);
    expect(stateView(run("working"), NOW)).toMatchObject({ tone: "accent", live: true });
    expect(stateView(run("done"), NOW).tone).toBe("done");
    expect(stateView(run("failed"), NOW).tone).toBe("blocked");
    expect(stateView(run("stopped"), NOW).tone).toBe("muted");
  });

  it("reads Approved for a done run whose main draft was applied, and Ready to review otherwise (G17)", () => {
    const done = run("done", { id: "r1" });
    const draft = (intent: string, state: string, at: number, runId = "r1") => ({ id: `${intent}${at}`, createdAt: iso(at), origin: { type: "run", runId, shortId: null }, intent: { type: intent }, state: { type: state } }) as unknown as Proposal;
    expect(stateView(done, NOW).label).toBe("Ready to review");
    expect(stateView(done, NOW, true)).toMatchObject({ label: "Approved", tone: "done", icon: "check" });
    expect(stateView(run("working"), NOW, true).label).toBe("Working");
    expect(runApproved(done, [draft("rewrite", "applied", 5)])).toBe(true);
    expect(runApproved(done, [draft("rewrite", "pending", 5)])).toBe(false);
    expect(runApproved(done, [draft("rewrite", "skipped", 5)])).toBe(false);
    // Only the first draft is the main one; a later applied comment does not make it so, and a replaced draft does not count.
    expect(runApproved(done, [draft("rewrite", "pending", 9), draft("comment", "applied", 5)])).toBe(false);
    expect(runApproved(done, [draft("rewrite", "retired", 9), draft("comment", "applied", 5)])).toBe(true);
    expect(runApproved(done, [draft("startRun", "pending", 9), draft("comment", "applied", 5)])).toBe(true);
    expect(runApproved(done, [draft("rewrite", "applied", 5, "other")])).toBe(false);
    // A plan's main draft is its description update, whatever else it drafted first.
    const plan = run("done", { id: "r1", spec: { ...base.spec, role: "plan" } });
    expect(runApproved(plan, [draft("comment", "pending", 9), draft("rewrite", "applied", 5)])).toBe(true);
    expect(runApproved(plan, [draft("comment", "applied", 9), draft("rewrite", "pending", 5)])).toBe(false);
    expect(runApproved(plan, [draft("comment", "applied", 9)])).toBe(false);
    expect(runApproved(run("working", { id: "r1" }), [draft("rewrite", "applied", 5)])).toBe(false);
  });

  it("swaps the working colour for the quiet one and stops pulsing", () => {
    expect(stateView(run("working", { lastProgressAt: iso(45) }), NOW)).toMatchObject({ label: "Working", tone: "warn", live: false });
  });
});

describe("the runs that wait on the person", () => {
  const none = new Set<string>();

  it("are the runs asking, blocked or failed and not dismissed, which is how Your agents counts them", () => {
    const runs = [run("needsAnswer", { id: "a" }), run("needsPermission", { id: "b" }), run("systemBlocked", { id: "c" }), run("failed", { id: "d" }), run("working", { id: "e" })];
    expect(runs.filter((r) => needsAttention(r, none)).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(runs.filter((r) => needsAttention(r, new Set(["d"]))).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(yourAgents(runs, none).map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(yourAgents(runs, new Set(["d"])).map((r) => r.id)).toEqual(["a", "b", "c", "e"]);
  });

  it("leave out queued, done and stopped runs", () => {
    const runs = [run("queued", { id: "c" }), run("done", { id: "e" }), run("stopped", { id: "f" }), run("unknown", { id: "g" })];
    expect(runs.filter((r) => needsAttention(r, none))).toEqual([]);
  });

  it("counts nothing that stopped: it is over, or the person's to dismiss", () => {
    const stopped = run("stopped", { id: "s", error: "Stopped before it started" });
    expect(needsAttention(stopped, none)).toBe(false);
    expect(yourAgents([stopped], none)).toEqual([]);
  });
});

describe("tokens", () => {
  it("is written as a count and never as a price", () => {
    expect(formatTokens(578_000)).toBe("578k tokens");
    expect(formatTokens(212_400)).toBe("212k tokens");
    expect(formatTokens(1_000)).toBe("1k tokens");
    expect(formatTokens(950)).toBe("950 tokens");
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(1_200_000)).toBe("1.2M tokens");
    expect(formatTokens(2_000_000)).toBe("2M tokens");
    expect(formatTokens(999_700)).toBe("1M tokens");
    expect(formatTokens(null)).toBeNull();
    expect(formatTokens(578_000)).not.toMatch(/[$€£]|kr/);
  });
});

describe("sorting", () => {
  it("lists the newest activity first, counting a finished run from its end", () => {
    const old = run("done", { id: "old", queuedAt: iso(500), endedAt: iso(5) });
    const fresh = run("done", { id: "fresh", queuedAt: iso(60), endedAt: iso(40) });
    const running = run("working", { id: "running", queuedAt: iso(20) });
    expect(sortRuns([fresh, old, running]).map((r) => r.id)).toEqual(["old", "running", "fresh"]);
  });

  it("breaks ties by id so the order doesn't flicker", () => {
    const a = run("done", { id: "a", queuedAt: iso(5) });
    const b = run("done", { id: "b", queuedAt: iso(5) });
    expect(sortRuns([b, a]).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("the Needs you filter", () => {
  it("lets every run through while it is off, and only the runs that hold a need while it is on", () => {
    const runs = sample();
    const scope = needsScope([{ runId: runs[1].id, workstreamId: null }]);
    expect(applyFilters(runs, NO_FILTERS, scope)).toHaveLength(runs.length);
    expect(applyFilters(runs, { needs: true }, scope).map((r) => r.id)).toEqual([runs[1].id]);
  });

  it("moves with j and k, stays at the ends, and starts at either end from nothing", () => {
    const order = ["a", "b", "c"];
    expect(stepRun(order, "a", 1)).toBe("b");
    expect(stepRun(order, "c", 1)).toBe("c");
    expect(stepRun(order, "a", -1)).toBe("a");
    expect(stepRun(order, null, 1)).toBe("a");
    expect(stepRun(order, null, -1)).toBe("c");
    expect(stepRun(order, "gone", 1)).toBe("a");
    expect(stepRun([], null, 1)).toBeNull();
  });
});

describe("words on a card", () => {
  it("splits a permission prompt into the tool and the exact command", () => {
    expect(permissionRequest("approve Bash: git push origin HEAD")).toEqual({ tool: "Bash", command: "git push origin HEAD" });
    expect(permissionRequest("approve Edit: src/a.ts\nsecond line")).toEqual({ tool: "Edit", command: "src/a.ts\nsecond line" });
    expect(permissionRequest("something else entirely")).toEqual({ tool: null, command: "something else entirely" });
    expect(permissionRequest(null)).toBeNull();
    expect(permissionRequest("   ")).toBeNull();
  });

  it("names a run by its ticket's title, else by what it is for", () => {
    const r = run("working");
    expect(runTitle(r, "Fix the totals")).toBe("Fix the totals");
    expect(runTitle(r, "  ")).toBe(`Investigator ${r.item!.key}`);
    expect(runTitle({ ...r, item: null, spec: { ...r.spec, brief: "Why is checkout\n slow?" } }, null)).toBe("Why is checkout slow?");
    expect(runTitle({ ...r, item: null, spec: { ...r.spec, brief: "  " } }, null)).toBe("Investigator payments");
  });

  it("shows the first sentence of a result", () => {
    expect(resultHeadline("The lag comes from one consumer.\n\nFor Jira: add a backoff.")).toBe("The lag comes from one consumer.");
    expect(resultHeadline("No full stop here")).toBe("No full stop here");
    expect(resultHeadline("x".repeat(400))!.length).toBe(218);
    expect(resultHeadline("")).toBeNull();
    expect(resultHeadline(null)).toBeNull();
  });

  it("says what a run is doing, or that it is starting", () => {
    expect(progressText(run("working", { lastDetail: "Reading the code" }))).toBe("Reading the code");
    expect(progressText(run("queued"))).toBe("Waiting to start");
    expect(progressText(run("launching"))).toBe("Starting up");
    // Never the state's own word again, as "Working · Working" read on a card after an answer (N9).
    expect(progressText(run("working"))).toBe("No update from it yet");
  });
});

describe("the header", () => {
  it("sums up the runs", () => {
    expect(summaryLine(sample(), NOW)).toBe("2 running · 1 quiet");
    expect(summaryLine(sample(), NOW, 5)).toBe("5 need you · 2 running · 1 quiet");
    expect(summaryLine(sample(), NOW, 1)).toMatch(/^1 needs you · /);
    expect(summaryLine([], NOW)).toBe("Nothing running");
    expect(summaryLine([run("stopped")], NOW)).toBe("Nothing running");
    expect(summaryLine([run("needsAnswer"), run("unknown")], NOW, 2)).toBe("2 need you");
  });

  it("offers Stop all only for runs it could stop", () => {
    const runs = [run("working", { id: "a" }), run("needsPermission", { id: "b" }), run("launching", { id: "c" }), run("queued", { id: "d" }), run("done", { id: "e" }), run("failed", { id: "f" })];
    expect(stoppable(runs).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("grouping by workstream", () => {
  const view = (id: string, title: string, stage: WorkstreamView["stage"] = "intake", over: Partial<WorkstreamView> = {}): WorkstreamView => ({
    workstream: { id, connectionId: "mock", itemKey: null, repo: null, title, pipSession: null, pausedReason: null, notes: null, createdAt: iso(600), closedAt: null, basis: null },
    stage,
    runs: [],
    labels: [],
    ...over,
  });
  const inWs = (state: RunState, id: string, workstream: string | null, queued: number, over: Partial<Run> = {}) => run(state, { id, queuedAt: iso(queued), spec: { ...base.spec, workstream }, ...over });
  const runs = [
    inWs("done", "a1", "ws-a", 300, { spec: { ...base.spec, role: "investigate", workstream: "ws-a" }, endedAt: iso(200) }),
    inWs("working", "a2", "ws-a", 100, { spec: { ...base.spec, role: "plan", workstream: "ws-a" } }),
    inWs("working", "b1", "ws-b", 5),
    inWs("needsAnswer", "loose1", null, 50),
    inWs("done", "loose2", null, 400, { endedAt: iso(1) }),
  ];
  const workstreams = [view("ws-a", "CA-401 Retry the payment", "plan"), view("ws-b", "CA-402 Cart totals", "investigate")];

  it("puts each workstream's runs under its title, and the rest under No workstream, last", () => {
    const groups = groupRunsByWorkstream(runs, workstreams, NO_FILTERS);
    expect(groups.map((g) => [g.id, g.title, g.runs.map((r) => r.id)])).toEqual([
      ["ws-b", "CA-402 Cart totals", ["b1"]],
      ["ws-a", "CA-401 Retry the payment", ["a2", "a1"]],
      [null, NO_WORKSTREAM_TITLE, ["loose2", "loose1"]],
    ]);
  });

  it("orders workstreams by their latest activity", () => {
    const later = [...runs, inWs("queued", "a3", "ws-a", 1, { spec: { ...base.spec, role: "build", workstream: "ws-a" } })];
    expect(groupRunsByWorkstream(later, workstreams, NO_FILTERS).map((g) => g.id)).toEqual(["ws-a", "ws-b", null]);
  });

  it("labels runs R1, R2 by queue time over all of the workstream's runs, so a filter never renumbers them", () => {
    const [, a] = groupRunsByWorkstream(runs, workstreams, NO_FILTERS);
    expect(a.labels).toEqual({ a1: "R1", a2: "R2" });
    const only = groupRunsByWorkstream(runs, workstreams, { needs: true }, needsScope([{ runId: "a2", workstreamId: "ws-a" }]));
    const ws = only.find((g) => g.id === "ws-a")!;
    expect(ws.runs.map((r) => r.id)).toEqual(["a2"]);
    expect(ws.labels.a2).toBe("R2");
  });

  it("has no No workstream group when every run is in a workstream", () => {
    expect(groupRunsByWorkstream(runs.slice(0, 3), workstreams, NO_FILTERS).map((g) => g.id)).toEqual(["ws-b", "ws-a"]);
    expect(groupRunsByWorkstream([], [], NO_FILTERS)).toEqual([]);
  });

  it("lists an open workstream with no run yet, only while the filter is off and never a closed one", () => {
    const quiet = view("ws-c", "CA-403 No agents yet", "intake");
    const gone = { ...view("ws-d", "CA-404 Closed", "intake"), workstream: { ...view("ws-d", "CA-404 Closed", "intake").workstream, closedAt: iso(1) } } as WorkstreamView;
    const groups = groupRunsByWorkstream(runs, [...workstreams, quiet, gone], NO_FILTERS);
    expect(groups.map((g) => g.id)).toContain("ws-c");
    expect(groups.map((g) => g.id)).not.toContain("ws-d");
    expect(groups.find((g) => g.id === "ws-c")).toMatchObject({ title: "CA-403 No agents yet", runs: [] });
    expect(groupRunsByWorkstream(runs, [...workstreams, quiet], { needs: true }, needsScope([])).map((g) => g.id)).not.toContain("ws-c");
  });

  it("still groups the runs of a workstream it has no title for, by its id", () => {
    const groups = groupRunsByWorkstream(runs, [workstreams[0]], NO_FILTERS);
    expect(groups.find((g) => g.id === "ws-b")?.title).toBe("Workstream ws-b");
  });

  it("walks runs in group order with j and k, the newest first within each group", () => {
    const stoppedLoose = inWs("stopped", "s1", null, 2);
    const stoppedInWs = inWs("stopped", "s2", "ws-b", 3);
    expect(agentGroups([...runs, stoppedLoose, stoppedInWs], workstreams, NO_FILTERS).order).toEqual(["s2", "b1", "a2", "a1", "loose2", "s1", "loose1"]);
  });
});

describe("the Needs you filter on the Work screen", () => {
  const view = (id: string): WorkstreamView =>
    ({ workstream: { id, connectionId: "mock", itemKey: null, repo: null, title: `WS ${id}`, pipSession: null, pausedReason: null, notes: null, createdAt: iso(600), closedAt: null, basis: null }, stage: "intake", runs: [], labels: [] }) as unknown as WorkstreamView;
  const inWs = (state: RunState, id: string, workstream: string | null) => run(state, { id, queuedAt: iso(50), spec: { ...base.spec, workstream } });
  const runs = [inWs("needsAnswer", "q", "ws-a"), inWs("working", "w", "ws-a"), inWs("done", "d", "ws-b"), inWs("needsPermission", "loose", null)];
  const needs = [
    { runId: "q", workstreamId: "ws-a" },
    { runId: "loose", workstreamId: null },
    { runId: null, workstreamId: "ws-c" },
  ];
  const scope = needsScope(needs);
  const workstreams = [view("ws-a"), view("ws-b"), view("ws-c")];
  const on = { needs: true };

  it("keeps only the runs that hold a need, and every workstream that holds one even with no run of it", () => {
    expect(applyFilters(runs, on, scope).map((r) => r.id)).toEqual(["q", "loose"]);
    const groups = groupRunsByWorkstream(runs, workstreams, on, scope);
    expect(groups.map((g) => [g.id, g.runs.map((r) => r.id)])).toEqual([
      ["ws-a", ["q"]],
      ["ws-c", []],
      [null, ["loose"]],
    ]);
    expect(groups.map((g) => g.id)).not.toContain("ws-b");
  });

  it("shows No workstream for a need that has no run", () => {
    const bare = groupRunsByWorkstream([], workstreams, on, needsScope([{ workstreamId: null }]));
    expect(bare.map((g) => g.id)).toEqual([null]);
  });

  it("walks only the runs the filter shows", () => {
    expect(agentGroups(runs, workstreams, on, scope).order).toEqual(["q", "loose"]);
  });
});

describe("a run waiting for a slot", () => {
  const at = (n: number) => new Date(Date.parse("2026-09-30T11:00:00Z") + n * 60_000).toISOString();
  const waiting = (id: string, queued: number): Run => ({ ...run("queued", { id, queuedAt: at(queued) }), slotWaitSince: at(queued) });

  it("is placed in line by approval order among the queued runs waiting for one", () => {
    const [a, b, c] = [waiting("a", 3), waiting("b", 1), waiting("c", 2)];
    const plain = run("queued", { id: "p", queuedAt: at(0) });
    const started = { ...run("launching", { id: "s", queuedAt: at(0) }), slotWaitSince: at(0) };
    const all = [a, b, c, plain, started];
    expect([b, c, a].map((r) => slotPosition(r, all))).toEqual([1, 2, 3]);
    expect(slotPosition(plain, all)).toBeNull();
    expect(slotPosition(started, all)).toBeNull();
    const tie = [waiting("y", 1), waiting("x", 1)];
    expect(slotPosition(tie[1], tie)).toBe(1);
  });

  it("is placed behind only the runs that can take a slot, not ones in a paused or closed workstream", () => {
    const ws = (id: string, over: { pausedReason?: string; closedAt?: string } = {}) =>
      ({ workstream: { id, pausedReason: over.pausedReason ?? null, closedAt: over.closedAt ?? null } }) as unknown as WorkstreamView;
    const inWs = (r: Run, workstream: string | null): Run => ({ ...r, spec: { ...r.spec, workstream } });
    const held = inWs(waiting("h", 1), "ws-paused");
    const closed = inWs(waiting("c", 2), "ws-closed");
    const open = inWs(waiting("o", 3), "ws-open");
    const loose = waiting("l", 4);
    const unknown = inWs(waiting("u", 5), "ws-unloaded");
    const all = [held, closed, open, loose, unknown];
    const line = slotQueue(all, [ws("ws-paused", { pausedReason: "person" }), ws("ws-closed", { closedAt: at(0) }), ws("ws-open")]);
    expect(line.map((r) => r.id)).toEqual(["o", "l", "u"]);
    expect([open, loose, unknown].map((r) => slotPosition(r, line))).toEqual([1, 2, 3]);
    expect(slotPosition(held, line)).toBeNull();
    expect(slotQueue(all, [])).toBe(all);
  });

  it("is placed by the time it was queued, however many fractional digits the backend wrote", () => {
    // As strings, "…:00.5Z" sorts after "…:00.25Z" though it is earlier... and "…:00Z" after both.
    const first = { ...run("queued", { id: "z", queuedAt: "2026-09-30T11:00:00.2Z" }), slotWaitSince: "x" };
    const second = { ...run("queued", { id: "a", queuedAt: "2026-09-30T11:00:00.25Z" }), slotWaitSince: "x" };
    const third = { ...run("queued", { id: "m", queuedAt: "2026-09-30T11:00:01Z" }), slotWaitSince: "x" };
    const all = [third, second, first];
    expect([first, second, third].map((r) => slotPosition(r, all))).toEqual([1, 2, 3]);
  });

  it("is counted apart from the running ones, and Stop all names it", () => {
    const runs = [run("working", { id: "w1" }), run("working", { id: "w2" }), waiting("q1", 1), waiting("q2", 2)];
    expect(summaryLine(runs, NOW)).toBe("2 running · 2 waiting for a slot");
    expect(slotWaiters(runs).map((r) => r.id)).toEqual(["q1", "q2"]);
    expect(stoppable(runs).map((r) => r.id)).toEqual(["w1", "w2"]);
    expect(stopAllText(3, 2)).toBe("3 agents and 2 waiting to start");
    expect(stopAllText(1, 0)).toBe("1 agent");
    expect(stopAllText(0, 1)).toBe("1 waiting to start");
  });

  it("says where it is in line, on the card and in the state", () => {
    const [first, second] = [waiting("a", 1), waiting("b", 2)];
    expect(progressText(first, [second, first])).toBe("Waiting for a slot · 1st in line");
    expect(progressText(second, [second, first])).toBe("Waiting for a slot · 2nd in line");
    expect(slotText(first)).toBe("Waiting for a slot");
    expect(stateView(first, NOW).label).toBe("Waiting for a slot");
    expect(stateView(run("queued"), NOW).label).toBe("Queued");
    expect(progressText(run("queued"))).toBe("Waiting to start");
  });

  it("counts in ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
  });

  it("says a run stopped before it started so when it never launched", () => {
    expect(stoppedText({ ...run("stopped"), launchedAt: null, error: "Stopped before it started" })).toBe("Stopped before it started");
    expect(stoppedText({ ...run("stopped"), launchedAt: at(0), error: null, lastDetail: null })).toBe("Stopped before it finished");
  });
});

describe("a plan's open questions (N6)", () => {
  it("reads the bullets or numbered lines under an Open questions heading, up to the next heading, at most five", () => {
    const plan = "## Steps\n\n1. Do it\n\n## Open questions for a person\n\n- Do the Klaviyo flows read the subjects?\n2) Keep the delay?\nFor Jira: a note\n\n## Risks\n\n- none";
    expect(planOpenQuestions(plan)).toEqual(["Do the Klaviyo flows read the subjects?", "Keep the delay?"]);
    expect(planOpenQuestions("## Steps\n\n- one")).toEqual([]);
    expect(planOpenQuestions(null)).toEqual([]);
    expect(planOpenQuestions(`## Open questions\n${Array.from({ length: 8 }, (_, i) => `- q${i}`).join("\n")}`)).toHaveLength(5);
    expect(APPROVE_PLAN).toBe("Approve the description update to let Build start.");
  });
});
