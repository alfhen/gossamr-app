import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Run, RunState } from "../types";
import {
  ALL,
  NO_FILTERS,
  QUIET_MINUTES,
  applyFilters,
  attentionCount,
  filterOptions,
  formatTokens,
  groupRuns,
  laneIsFolded,
  laneOf,
  navOrder,
  permissionRequest,
  progressText,
  quietMinutes,
  quietText,
  resultHeadline,
  runTitle,
  sortRuns,
  stateView,
  stepRun,
  stoppable,
  summaryLine,
  type LaneId,
} from "./agentsLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

const sample = (): Run[] => new MockBackend().runs.list();

const base = sample()[0];
const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...base, id: `r-${state}`, state, needs: null, lastDetail: null, tokens: null, lastProgressAt: iso(1), queuedAt: iso(10), endedAt: null, ...over });

describe("lanes", () => {
  const expected: Record<RunState, LaneId> = {
    queued: "running",
    launching: "running",
    working: "running",
    needsAnswer: "needs",
    needsPermission: "needs",
    systemBlocked: "needs",
    done: "done",
    failed: "bad",
    unknown: "bad",
    stopped: "earlier",
  };

  it.each(Object.entries(expected))("puts %s in %s", (state, lane) => {
    expect(laneOf(run(state as RunState), NOW)).toBe(lane);
  });

  it("moves a working run to Failed or stuck at 30 minutes of quiet, not at 29", () => {
    expect(QUIET_MINUTES).toBe(30);
    expect(laneOf(run("working", { lastProgressAt: iso(29) }), NOW)).toBe("running");
    expect(laneOf(run("working", { lastProgressAt: iso(30) }), NOW)).toBe("bad");
    expect(quietMinutes(run("working", { lastProgressAt: iso(29.9) }), NOW)).toBeNull();
    expect(quietMinutes(run("working", { lastProgressAt: iso(30) }), NOW)).toBe(30);
  });

  it("only ever calls a working run quiet", () => {
    for (const state of ["queued", "launching", "needsAnswer", "needsPermission", "done", "failed", "stopped"] as const) {
      expect(quietMinutes(run(state, { lastProgressAt: iso(600) }), NOW)).toBeNull();
    }
    expect(laneOf(run("needsAnswer", { lastProgressAt: iso(600) }), NOW)).toBe("needs");
  });

  it("says quiet in minutes, then in hours, and never stuck", () => {
    expect(quietText(40)).toBe("Quiet for 40 min");
    expect(quietText(180)).toBe("Quiet for 3 h");
    expect(quietText(40)).not.toMatch(/stuck/i);
  });

  it("puts the eight scripted runs in the lanes the prototype shows", () => {
    const groups = groupRuns(sample(), NO_FILTERS, NOW);
    expect(groups.map((g) => [g.lane, g.runs.length])).toEqual([
      ["needs", 2],
      ["running", 2],
      ["done", 2],
      ["bad", 2],
    ]);
    expect(groups.find((g) => g.lane === "bad")!.runs.map((r) => r.state).sort()).toEqual(["failed", "working"]);
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

  it("swaps the working colour for the quiet one and stops pulsing", () => {
    expect(stateView(run("working", { lastProgressAt: iso(45) }), NOW)).toMatchObject({ label: "Working", tone: "warn", live: false });
  });
});

describe("the badge", () => {
  const seen = new Set<string>();

  it("counts what needs the person and failed runs not yet seen", () => {
    const runs = [run("needsAnswer", { id: "a" }), run("needsPermission", { id: "b" }), run("systemBlocked", { id: "c" }), run("failed", { id: "d" })];
    expect(attentionCount(runs, seen)).toBe(4);
    expect(attentionCount(runs, new Set(["d"]))).toBe(3);
  });

  it("leaves out working, quiet, queued, done, stopped and unknown runs", () => {
    const runs = [
      run("working", { id: "a" }),
      run("working", { id: "b", lastProgressAt: iso(120) }),
      run("queued", { id: "c" }),
      run("launching", { id: "d" }),
      run("done", { id: "e" }),
      run("stopped", { id: "f" }),
      run("unknown", { id: "g" }),
    ];
    expect(attentionCount(runs, seen)).toBe(0);
  });

  it("is two for the scripted runs once the failed one has been seen", () => {
    const runs = sample();
    const failed = runs.find((r) => r.state === "failed")!;
    expect(attentionCount(runs, seen)).toBe(3);
    expect(attentionCount(runs, new Set([failed.id]))).toBe(2);
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

describe("filters", () => {
  it("narrows by lane, repo and ticket, all of which must match", () => {
    const runs = sample();
    expect(applyFilters(runs, { ...NO_FILTERS, lane: "needs" }, NOW)).toHaveLength(2);
    expect(applyFilters(runs, { ...NO_FILTERS, repo: "acme/payments" }, NOW).map((r) => r.item?.key)).toEqual(["SUP-12"]);
    expect(applyFilters(runs, { ...NO_FILTERS, ticket: "WEB-108" }, NOW)).toHaveLength(1);
    expect(applyFilters(runs, { lane: "needs", repo: "acme/payments", ticket: ALL }, NOW)).toHaveLength(0);
  });

  it("filters by the lane a run is in now, so a quiet one is under Failed or stuck", () => {
    const quiet = applyFilters(sample(), { ...NO_FILTERS, lane: "bad" }, NOW).filter((r) => r.state === "working");
    expect(quiet.map((r) => r.item?.key)).toEqual(["CA-377"]);
  });

  it("offers the repos and tickets of every run, sorted, whatever is filtered", () => {
    const { repos, tickets } = filterOptions(sample());
    expect(repos).toEqual(["acme/payments", "acme/storefront"]);
    expect(tickets).toEqual(["CA-377", "CA-409", "DEVOPS-455", "DEVOPS-471", "SUP-9", "SUP-12", "WEB-97", "WEB-108"]);
  });
});

describe("folding and walking", () => {
  const stopped = [run("stopped", { id: "s1" }), run("working", { id: "w1" }), run("needsAnswer", { id: "n1" })];

  it("folds Earlier until it is opened or a filter is on", () => {
    expect(laneIsFolded("earlier", false, NO_FILTERS)).toBe(true);
    expect(laneIsFolded("earlier", true, NO_FILTERS)).toBe(false);
    expect(laneIsFolded("earlier", false, { ...NO_FILTERS, lane: "earlier" })).toBe(false);
    expect(laneIsFolded("needs", false, NO_FILTERS)).toBe(false);
  });

  it("walks the lanes in order and skips a folded one", () => {
    const groups = groupRuns(stopped, NO_FILTERS, NOW);
    expect(navOrder(groups, false, NO_FILTERS)).toEqual(["n1", "w1"]);
    expect(navOrder(groups, true, NO_FILTERS)).toEqual(["n1", "w1", "s1"]);
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
    expect(runTitle(r, "  ")).toBe(`Investigate ${r.item!.key}`);
    expect(runTitle({ ...r, item: null }, null)).toBe("Investigate payments");
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
    expect(progressText(run("working"))).toBe("Working");
  });
});

describe("the header", () => {
  it("sums up the runs", () => {
    expect(summaryLine(sample(), NOW)).toBe("2 need you · 2 running · 2 ready to review · 1 quiet · 1 failed");
    expect(summaryLine([], NOW)).toBe("Nothing running");
    expect(summaryLine([run("stopped")], NOW)).toBe("Nothing running");
    expect(summaryLine([run("needsAnswer"), run("unknown")], NOW)).toBe("1 needs you · 1 unclear");
  });

  it("offers Stop all only for runs it could stop", () => {
    const runs = [run("working", { id: "a" }), run("needsPermission", { id: "b" }), run("launching", { id: "c" }), run("queued", { id: "d" }), run("done", { id: "e" }), run("failed", { id: "f" })];
    expect(stoppable(runs).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
