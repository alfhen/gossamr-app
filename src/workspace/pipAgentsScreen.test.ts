import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { scriptPip } from "../backend/mockPip";
import type { Run, RunState, ScreenContext } from "../types";
import { NO_FILTERS, type AgentFilters } from "./agentsLogic";
import { agentsSuggestionScene } from "./pipRuns";
import { buildScreenContext, contextLabel, contextLines, screenLine, type Screen } from "./screenContext";
import { placeholderFor, suggestionsFor, type SuggestionScene } from "./suggestions";
import { activeTab, loadTabs, useTabs } from "./tabsStore";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const seed = new MockBackend().runs.list();
const run = (id: string, state: RunState, over: Partial<Run> = {}): Run => ({ ...seed[0], id, state, needs: null, lastDetail: null, endedAt: null, lastProgressAt: new Date(NOW - 60_000).toISOString(), queuedAt: new Date(NOW - 600_000).toISOString(), ...over });
const RUNS = [run("a", "needsAnswer"), run("b", "working"), run("c", "done"), run("d", "stopped")];

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
    activity: { chip: "all", container: null },
    agents: { openRun, waiting: 1, runs, filters, earlierOpen: false, now: NOW },
    ...over,
  };
};

describe("the Agents screen", () => {
  it("is named with its filter and the runs shown, leaving the folded Earlier lane out", () => {
    expect(screenLine(screen())).toBe("Agents · All · 3 runs");
    expect(screenLine(screen({}, { ...NO_FILTERS, lane: "needs" }))).toBe("Agents · Needs you · 1 run");
    expect(screenLine(screen({}, { lane: "earlier", repo: "all", ticket: "all" }))).toBe("Agents · Earlier · 1 run");
    expect(screenLine(screen({}, { ...NO_FILTERS, ticket: "NOPE-1" }))).toBe("Agents · NOPE-1 · 0 runs");
    expect(screenLine(screen({ agents: undefined }))).toBe("Agents");
  });

  it("sends no board data, but the open run, the waiting count and the runs by state", () => {
    const board = { ...screen().tab, filter: { type: "mine" } as const };
    const ctx = buildScreenContext(screen({ tab: board, shown: [], items: {} }, NO_FILTERS, "c"));
    expect(ctx).toEqual({ view: "Agents · All · 3 runs", item: null, filter: null, selection: [], run: "c", runsWaiting: 1, runsSummary: "1 needs you · 1 running · 1 ready to review" });
    expect(buildScreenContext(screen()).run).toBeNull();
  });

  it("leaves the board, activity and settings output alone", () => {
    const board = buildScreenContext(screen({ route: "workspace", agents: undefined }));
    expect(board.view).toMatch(/ · All projects · 0 items$/);
    expect("runsSummary" in board).toBe(false);
    const withRuns = buildScreenContext(screen({ route: "workspace" }));
    expect("runsSummary" in withRuns).toBe(false);
    expect(buildScreenContext(screen({ route: "activity" })).view).toBe("Activity · All · All projects");
    expect(buildScreenContext(screen({ route: "settings" })).view).toBe("Settings");
  });

  it("lists what Pip can see: the view, the runs by state and the open run, never a board filter", () => {
    const ctx = buildScreenContext(screen({}, NO_FILTERS, "c"));
    const words = { titleOf: () => null, describeFilter: () => "", runOf: (id: string) => (id === "c" ? "Investigate CA-1 · Ready to review" : null) };
    expect(contextLines(ctx, null, words)).toEqual([
      "Screen: Agents · All · 3 runs",
      "Open agent run: Investigate CA-1 · Ready to review",
      "Runs shown: 1 needs you · 1 running · 1 ready to review",
      "Agents waiting on you: 1",
    ]);
  });

  it("labels the chip by the run when a run is open, by the ticket when one is, else by the screen", () => {
    const words = { titleOf: () => "Checkout", runOf: () => "Investigate CA-1 · Working" };
    const ctx = buildScreenContext(screen({}, NO_FILTERS, "b"));
    expect(contextLabel(ctx, null, words.titleOf, words.runOf)).toEqual({ kind: "Agent run", label: "Investigate CA-1 · Working" });
    expect(contextLabel({ ...ctx, item: { connectionId: "m", externalId: "CA-1", key: "CA-1" } }, null, words.titleOf, words.runOf).kind).toBe("Ticket");
    expect(contextLabel(buildScreenContext(screen()), null, words.titleOf, words.runOf)).toEqual({ kind: "Screen", label: "Agents · All · 3 runs" });
  });
});

describe("chips and placeholder on the Agents screen", () => {
  const scene = (over: Partial<SuggestionScene> = {}): SuggestionScene => ({
    route: "agents", quote: false, marked: 0, item: null, pendingDrafts: 0, itemDrafts: 0, unassignedInView: 5, shown: 132, filtered: true, agents: agentsSuggestionScene(RUNS, null), ...over,
  });

  it("offers questions about the agents and none of the board's", () => {
    const chips = suggestionsFor(scene());
    expect(chips).toEqual(["Which agents need me?", "What are my agents doing?", "What did the finished runs find?"]);
    expect(suggestionsFor(scene({ agents: agentsSuggestionScene([run("w", "working")], null) }))).toEqual(["What are my agents doing?"]);
    expect(suggestionsFor(scene({ agents: agentsSuggestionScene([], null) }))).toEqual(["Which tickets would an agent help with?"]);
    expect(suggestionsFor(scene({ agents: agentsSuggestionScene([run("z", "working")], null), pendingDrafts: 1 }))).toEqual(["What are my agents doing?", "Which drafts are safe to approve?"]);
    for (const c of [...chips, ...suggestionsFor(scene({ agents: agentsSuggestionScene(RUNS, "c") }))]) expect(c).not.toMatch(/stale|blocked|unassigned|Catch me up/i);
  });

  it("asks about the open run by how it stands", () => {
    const chips = (id: string) => suggestionsFor(scene({ agents: agentsSuggestionScene(RUNS, id) }));
    expect(chips("c")).toEqual(["What did this run find?", "Draft a comment from this run", "Send it back for another pass", "Create a follow-up ticket"]);
    expect(chips("a")[0]).toBe("What is this run asking me?");
    expect(chips("b")).toEqual(["What is this run doing?"]);
    expect(chips("d")).toEqual(["What happened in this run?"]);
    expect(suggestionsFor(scene({ agents: agentsSuggestionScene([run("t", "done", { item: null })], "t") }))).not.toContain("Draft a comment from this run");
  });

  it("keeps selected text and Settings first, and the board's chips on the board", () => {
    expect(suggestionsFor(scene({ quote: true }))[0]).toBe("Explain this");
    expect(suggestionsFor(scene({ route: "settings" }))).toEqual(["What can you do for me?"]);
    expect(suggestionsFor(scene({ route: "workspace", agents: undefined }))).toContain("Show stale tickets");
    expect(suggestionsFor(scene({ route: "activity", agents: undefined }))).toEqual(["What happened today?", "What needs my reply?"]);
  });

  it("words the placeholder for what the next question is about", () => {
    const p = { images: false, quote: false, itemKey: null, route: "agents" as const, runOpen: false };
    expect(placeholderFor(p)).toBe("Ask about the agents…");
    expect(placeholderFor({ ...p, runOpen: true })).toBe("Ask about this run…");
    expect(placeholderFor({ ...p, itemKey: "CA-1" })).toBe("Ask about CA-1…");
    expect(placeholderFor({ ...p, quote: true })).toBe("Ask about the selected text…");
    expect(placeholderFor({ ...p, images: true })).toBe("Say what to look at, or just ask…");
    expect(placeholderFor({ ...p, route: "workspace" })).toBe("Ask about what you're looking at…");
  });
});

describe("the sample Pip on the Agents screen", () => {
  const ctx = (over: Partial<ScreenContext>): ScreenContext => ({ view: "Agents · All · 3 runs", item: null, filter: null, selection: [], ...over });

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
