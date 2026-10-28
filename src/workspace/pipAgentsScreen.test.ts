import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { scriptPip } from "../backend/mockPip";
import type { Run, RunState, ScreenContext } from "../types";
import { NO_FILTERS, needsScope, type AgentFilters } from "./agentsLogic";
import { placeholderFor } from "./PipConversation";
import { pipAsks } from "./runSheetLogic";
import { buildScreenContext, contextLabel, contextLines, screenLine, type Screen } from "./screenContext";
import { activeTab, loadTabs, useTabs } from "./tabsStore";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const seed = new MockBackend().runs.list();
const run = (id: string, state: RunState, over: Partial<Run> = {}): Run => ({ ...seed[0], id, state, needs: null, lastDetail: null, endedAt: null, lastProgressAt: new Date(NOW - 60_000).toISOString(), queuedAt: new Date(NOW - 600_000).toISOString(), ...over });
const RUNS = [run("a", "needsAnswer"), run("b", "working"), run("c", "done"), run("d", "stopped")];

const needed = needsScope([{ runId: "a", workstreamId: null }]);

const screen = (over: Partial<Screen> = {}, filters: AgentFilters = NO_FILTERS, openRun: string | null = null, runs: readonly Run[] = RUNS): Screen => {
  useTabs.setState(loadTabs());
  return {
    route: "agents",
    tab: activeTab(useTabs.getState()),
    shown: [],
    items: {},
    containers: {},
    selected: null,
    marked: ["mock:X-1"],
    activity: { filter: "all" },
    agents: { openRun, waiting: 1, needsYou: 2, runs, filters, needed, now: NOW },
    ...over,
  };
};

describe("the Agents screen", () => {
  it("is named with its filter and the runs shown", () => {
    expect(screenLine(screen())).toBe("Work · All · 4 runs");
    expect(screenLine(screen({}, { needs: true }))).toBe("Work · Needs you · 1 run");
    expect(screenLine(screen({ agents: undefined }))).toBe("Work");
  });

  it("sends no board data, but the open run, the waiting count and the runs by state", () => {
    const board = { ...screen().tab, filter: { type: "mine" } as const };
    const ctx = buildScreenContext(screen({ tab: board, shown: [], items: {} }, NO_FILTERS, "c"));
    expect(ctx).toEqual({ view: "Work · All · 4 runs", item: null, filter: null, selection: [], run: "c", runsWaiting: 1, runsSummary: "2 need you · 1 running" });
    expect(buildScreenContext(screen()).run).toBeNull();
  });

  it("sends the Needs you count when the filter shows no runs", () => {
    const ctx = buildScreenContext(screen({}, { needs: true }, null, [run("b", "working")]));
    expect(ctx.runsSummary).toBe("2 need you");
    expect(contextLines(ctx, null, { titleOf: () => null, describeFilter: () => "" })).toContain("Runs shown: 2 need you");
  });

  it("leaves the board, activity and settings output alone", () => {
    const board = buildScreenContext(screen({ route: "workspace", agents: undefined }));
    expect(board.view).toMatch(/ · All projects · 0 items$/);
    expect("runsSummary" in board).toBe(false);
    const withRuns = buildScreenContext(screen({ route: "workspace" }));
    expect("runsSummary" in withRuns).toBe(false);
    expect(buildScreenContext(screen({ route: "activity" })).view).toBe("Inbox · All");
    expect(buildScreenContext(screen({ route: "settings" })).view).toBe("Settings");
  });

  it("lists what Pip can see: the view, the runs by state and the open run, never a board filter", () => {
    const ctx = buildScreenContext(screen({}, NO_FILTERS, "c"));
    const words = { titleOf: () => null, describeFilter: () => "", runOf: (id: string) => (id === "c" ? "Investigate CA-1 · Ready to review" : null) };
    expect(contextLines(ctx, null, words)).toEqual([
      "Screen: Work · All · 4 runs",
      "Open agent run: Investigate CA-1 · Ready to review",
      "Runs shown: 2 need you · 1 running",
      "Agents waiting on you: 1",
    ]);
  });

  it("labels the chip by the run when a run is open, by the ticket when one is, else by the screen", () => {
    const words = { titleOf: () => "Checkout", runOf: () => "Investigate CA-1 · Working" };
    const ctx = buildScreenContext(screen({}, NO_FILTERS, "b"));
    expect(contextLabel(ctx, null, words.titleOf, words.runOf)).toEqual({ kind: "Agent run", label: "Investigate CA-1 · Working" });
    expect(contextLabel({ ...ctx, item: { connectionId: "m", externalId: "CA-1", key: "CA-1" } }, null, words.titleOf, words.runOf).kind).toBe("Ticket");
    expect(contextLabel(buildScreenContext(screen()), null, words.titleOf, words.runOf)).toEqual({ kind: "Screen", label: "Work · All · 4 runs" });
  });
});

describe("the placeholder on the Agents screen", () => {
  it("words the placeholder for what the next question is about", () => {
    const p = { images: false, quote: false, itemKey: null, route: "agents" as const, runOpen: false };
    expect(placeholderFor(p)).toBe("Ask about your workstreams and agents…");
    expect(placeholderFor({ ...p, workstream: true })).toBe("Ask about this workstream…");
    expect(placeholderFor({ ...p, runOpen: true })).toBe("Ask about this run…");
    expect(placeholderFor({ ...p, itemKey: "CA-1" })).toBe("Ask about CA-1…");
    expect(placeholderFor({ ...p, quote: true })).toBe("Ask about the selected text…");
    expect(placeholderFor({ ...p, images: true })).toBe("Say what to look at, or just ask…");
    expect(placeholderFor({ ...p, route: "workspace" })).toBe("Ask about what you're looking at…");
  });
});

describe("the sample Pip on the Agents screen", () => {
  const ctx = (over: Partial<ScreenContext>): ScreenContext => ({ view: "Work · All · 4 runs", item: null, filter: null, selection: [], ...over });

  it("sums up the runs when asked what is going on, instead of talking about tickets", () => {
    const s = scriptPip("what's going on here?", ctx({}), [], RUNS, NOW);
    expect(s.steps).toEqual(["Looked at your agents"]);
    expect(s.text).toContain("You have 4 agent runs");
    expect(s.text).not.toContain("stale");
  });

  it("drafts a comment from the open finished run when no ticket is open", () => {
    const item = { connectionId: "mock", externalId: "CA-1", key: "CA-1" };
    const done = run("c", "done", { item, result: "Long notes.\n\nFor Jira: The rounding bug is in the cart." });
    const s = scriptPip("Draft a comment from this run", ctx({ run: "c" }), [], [done], NOW);
    expect(s.draft?.intent).toMatchObject({ type: "comment", item });
    expect(s.draft?.label).toBe("From an agent run");
    expect(scriptPip("Draft a comment from this run", ctx({ run: "b" }), [], [run("b", "working", { item })], NOW).draft).toBeNull();
  });

  it("says what the finished runs found, not how many there are", () => {
    const item = { connectionId: "mock", externalId: "CA-1", key: "CA-1" };
    const s = scriptPip("What did the finished runs find?", ctx({}), [], [run("c", "done", { item, result: "The rounding bug is in the cart." }), run("b", "working")], NOW);
    expect(s.text).toContain("1 run has finished");
    expect(s.text).toContain("**CA-1** The rounding bug is in the cart.");
    expect(s.text).not.toContain("working");
    expect(scriptPip("What did the finished runs find?", ctx({}), [], [run("b", "working")], NOW).text).toBe("No agent has finished yet.");
  });

  it("describes the open run", () => {
    const s = scriptPip("what's going on here?", ctx({ run: "b" }), [], [run("b", "working", { lastDetail: "Reading the cart code" })], NOW);
    expect(s.text).toContain("Its state: working. Reading the cart code");
  });
});

describe("starting an agent again after a clone is found", () => {
  const blank: ScreenContext = { view: null, item: null, selection: [], filter: null, notes: [] } as unknown as ScreenContext;
  const failed = (kind: Run["spec"]["role"], spec: Partial<Run["spec"]> = {}) => run("f", "failed", { item: { connectionId: "mock", externalId: "CA-1", key: "CA-1" }, spec: { ...seed[0].spec, role: kind, workstream: "w1", ...spec } });
  const ws = { id: "w1", item: { connectionId: "mock", externalId: "CA-1", key: "CA-1" } };

  it("names the run, its role and the pull request it read", () => {
    expect(pipAsks.again(failed("investigator")).prompt).toBe(`Start the investigator agent of run f again. ${seed[0].spec.repo} has a clone now.`);
    expect(pipAsks.again(failed("builder")).prompt).toContain("Start the builder agent of run f again.");
    expect(pipAsks.again(failed("reviewer", { pr: 12 })).prompt).toContain("reviewer agent of run f again, on pull request 12.");
  });

  it("is answered by starting that role again with its brief, not an investigation", () => {
    const build = failed("builder", { brief: "Build it from the plan." });
    const script = scriptPip(pipAsks.again(build).prompt, blank, [], [build], NOW, [], null, ws);
    expect(script.start).toMatchObject({ role: "builder", brief: "Build it from the plan.", item: ws.item, repo: null });
    for (const role of ["code reviewer", "code-auditor"]) {
      const labelled = failed(role, { brief: "Look closely." });
      expect(scriptPip(pipAsks.again(labelled).prompt, blank, [], [labelled], NOW, [], null, ws).start).toMatchObject({ role, brief: "Look closely." });
    }
    const other = scriptPip(pipAsks.again(build).prompt, blank, [], [{ ...build, id: "g" }], NOW, [], null, ws);
    expect(other.start ?? null).toBeNull();
  });
});
