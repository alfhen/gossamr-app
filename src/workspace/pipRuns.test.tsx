import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { agentSummary, mockAsk, mockPipEvents, scriptPip } from "../backend/mockPip";
import type { AskRequest, ClaudeEvent } from "../backend/claude";
import type { Run, RunState, ScreenContext } from "../types";
import { useWorkspace } from "../workspaceStore";
import { NO_FILTERS } from "./agentsLogic";
import { PipRunCard, PipRunStripView } from "./PipRunCard";
import { STRIP_SHOWN, describeRun, stripRuns } from "./pipRuns";
import { buildScreenContext, contextLines, type Screen } from "./screenContext";
import { loadTabs, activeTab, useTabs } from "./tabsStore";
import { useRuns } from "./runsStore";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();
const base = new MockBackend().runs.list()[0];
const run = (state: RunState, over: Partial<Run> = {}): Run => ({ ...base, id: `r-${state}`, state, needs: null, lastDetail: null, tokens: null, lastProgressAt: iso(1), queuedAt: iso(10), endedAt: null, ...over });

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memory());
  useRuns.setState({ runs: [], sheet: null, status: "ready" });
});

describe("the strip of live runs", () => {
  it("lists the runs waiting on the person first, unseen failures among them as in the Needs you tray, then working ones", () => {
    const runs = [run("working", { id: "w1", lastProgressAt: iso(1) }), run("done", { id: "d" }), run("needsAnswer", { id: "n1" }), run("working", { id: "w2", lastProgressAt: iso(3) }), run("needsPermission", { id: "n2" }), run("failed", { id: "f" })];
    expect(stripRuns(runs).map((r) => r.id)).toEqual(["f", "n1", "n2", "w1", "w2"]);
    // A failed run the person dismissed leaves it, as it leaves Needs you.
    expect(stripRuns(runs, new Set(["f"])).map((r) => r.id)).toEqual(["n1", "n2", "w1", "w2"]);
    expect(stripRuns([run("done"), run("failed", { id: "f" }), run("stopped")], new Set(["f"]))).toEqual([]);
  });

  it("is absent when nothing is going, and lists live runs otherwise", () => {
    const view = (runs: Run[]) => renderToStaticMarkup(<PipRunStripView runs={runs} now={NOW} dismissed={new Set(["f"])} titleOf={() => null} onOpen={() => {}} />);
    const waiting = [run("needsAnswer", { id: "n1", needs: "Keep the old rounding?" })];
    expect(view(waiting)).toContain('aria-label="Your agents"');
    expect(view([run("done"), run("failed", { id: "f" })])).toBe("");
    expect(view([])).toBe("");
  });

  it("lists a failed run the person hasn't seen, and says how many of the runs it lists it shows, with a way to the rest", () => {
    const runs = [run("failed", { id: "f" }), run("needsAnswer", { id: "n1" }), run("working", { id: "w1" }), run("working", { id: "w2" }), run("done", { id: "d1" }), run("done", { id: "d2" }), run("stopped", { id: "s1" }), run("queued", { id: "q1" })];
    const seeAll = vi.fn();
    const html = renderToStaticMarkup(<PipRunStripView runs={runs} now={NOW} titleOf={() => null} onOpen={() => {}} onSeeAll={seeAll} />);
    expect(html.match(/data-run-id=/g)).toHaveLength(STRIP_SHOWN);
    expect(html).toContain('data-run-id="f"');
    // Five it would list (the done and stopped ones it never lists don't count): it shows three of them.
    expect(html).toMatch(/data-strip-count[^>]*>3 of 5</);
    expect(html).toContain("See all in Agents</button>");
    // When it shows them all, it says only how many, however many finished runs there are besides.
    const few = renderToStaticMarkup(<PipRunStripView runs={[...runs.slice(1, 3), ...runs.slice(4, 7)]} now={NOW} titleOf={() => null} onOpen={() => {}} onSeeAll={seeAll} />);
    expect(few).toMatch(/data-strip-count[^>]*>2</);
    expect(few).not.toContain("See all in Agents");
    expect(few).not.toMatch(/data-strip-count[^>]*>[^<]* of /);
  });

  it("in a workstream's conversation lists only its runs, each with its short name there", () => {
    const view = (runs: Run[], workstream: string | null) => renderToStaticMarkup(<PipRunStripView runs={runs} now={NOW} workstream={workstream} titleOf={() => null} onOpen={() => {}} />);
    const mine = run("working", { id: "w1", spec: { ...base.spec, workstream: "ws-1" } });
    const theirs = run("working", { id: "w2", spec: { ...base.spec, workstream: "ws-2" } });
    const loose = run("needsAnswer", { id: "n1", spec: { ...base.spec, workstream: null } });
    const scoped = view([mine, theirs, loose], "ws-1");
    expect(scoped).toContain('data-run-id="w1"');
    expect(scoped).not.toContain('data-run-id="w2"');
    expect(scoped).not.toContain('data-run-id="n1"');
    expect(scoped).toContain('data-run-label="R1"');
    const general = view([mine, theirs, loose], null);
    expect(general.match(/data-run-id=/g)).toHaveLength(3);
    expect(general.match(/data-run-label="R1"/g)).toHaveLength(2);
    expect(view([theirs, loose], "ws-1")).toBe("");
  });

  it("gives each card its state, the ticket and what the run is doing, with an Open button", () => {
    const html = (r: Run) => renderToStaticMarkup(<PipRunCard run={r} now={NOW} ticketTitle="Checkout totals" onOpen={() => {}} />);
    const needs = html(run("needsAnswer", { needs: "Keep the old rounding?" }));
    expect(needs).toContain("Needs an answer");
    expect(needs).toContain("Keep the old rounding?");
    expect(needs).toContain("Checkout totals");
    expect(needs).toContain("Open");
    const working = html(run("working", { lastDetail: "Reading the cart code" }));
    expect(working).toContain("Working");
    expect(working).toContain("Reading the cart code");
    expect(html(run("needsPermission", { needs: "approve Bash: git push" }))).toContain("git push");
    // Just answered, with nothing reported since: a detail of its own, never "Working · Working" (N9).
    const answered = html(run("working", { lastDetail: null }));
    expect(answered).toContain("No update from it yet");
    expect(answered).not.toMatch(/Working<\/span> · Working/);
  });
});

describe("what Pip is told about agents", () => {
  const screen = (agents?: Screen["agents"]): Screen => {
    useTabs.setState(loadTabs());
    return { route: "workspace", tab: activeTab(useTabs.getState()), shown: [], items: {}, containers: {}, selected: null, marked: [], activity: { chip: "all", container: null }, agents };
  };

  it("includes the open run and how many agents wait while agents are on, and neither when they are off", () => {
    const on = buildScreenContext(screen({ openRun: "r1", waiting: 2, needsYou: 3, runs: [], filters: NO_FILTERS, earlierOpen: false, now: NOW }));
    expect([on.run, on.runsWaiting]).toEqual(["r1", 2]);
    const off = buildScreenContext(screen());
    expect("run" in off || "runsWaiting" in off).toBe(false);
  });

  it("shows the same in what Pip can see", () => {
    const ctx: ScreenContext = { view: "Board", item: null, filter: null, selection: [], run: "r1", runsWaiting: 2 };
    const lines = contextLines(ctx, null, { titleOf: () => null, describeFilter: () => "", runOf: () => "Investigate CA-1 · Working" });
    expect(lines).toContain("Open agent run: Investigate CA-1 · Working");
    expect(lines).toContain("Agents waiting on you: 2");
    expect(contextLines({ ...ctx, run: null, runsWaiting: 0 }, null, { titleOf: () => null, describeFilter: () => "" })).toEqual(["Screen: Board"]);
  });

  it("names the open run for what Pip can see", () => {
    expect(describeRun(run("working", { item: { connectionId: "mock", externalId: "CA-1", key: "CA-1" } }), "Checkout totals", NOW)).toBe("Checkout totals · Working");
    expect(describeRun(run("needsAnswer"), null, NOW)).toMatch(/^Investigator .+ · Needs an answer$/);
  });
});

describe("the sample Pip and agents", () => {
  const blank: ScreenContext = { view: null, item: null, filter: null, selection: [] };

  it("answers what the agents are doing from the runs it can read", () => {
    const backend = new MockBackend();
    const runs = backend.runs.list();
    const s = scriptPip("What are my agents doing?", blank, [], runs, NOW);
    expect(s.steps).toEqual(["Looked at your agents"]);
    expect(s.text).toContain(`You have ${runs.length} agent runs`);
    expect(s.text).toContain("Waiting on you");
    expect(s.text).toContain("DEVOPS-471");
    expect(s.draft).toBeNull();
    expect(s.start ?? null).toBeNull();
    expect(agentSummary([], NOW)).toContain("no agent runs");
  });

  it("keeps a request to investigate on the investigation path, and takes the ticket the person named over the open one", () => {
    const open = { connectionId: "mock", externalId: "CA-402", key: "CA-402" };
    const mixed = scriptPip("which agents are running, investigate CA-406", { ...blank, item: open }, [], new MockBackend().runs.list());
    expect(mixed.steps).toEqual(["Looked up CA-406", "Opened a workstream on CA-406", "Started an agent"]);
    expect(mixed.start?.item).toEqual({ connectionId: "mock", externalId: "CA-406", key: "CA-406" });
    expect(scriptPip("investigate CA-402", { ...blank, item: open }).start?.item).toBe(open);
    expect(scriptPip("start an agent", { ...blank, item: open }).start?.item).toBe(open);
    expect(scriptPip("which agents are running?", { ...blank, item: open }).start ?? null).toBeNull();
  });

  it("starts an investigator whose brief carries the focus, opening the ticket's workstream, and tells the person", async () => {
    const item = { connectionId: "mock", externalId: "CA-402", key: "CA-402" };
    const s = scriptPip("Start an agent on CA-402 and look at the retry loop", { ...blank, item });
    expect(s.start).toMatchObject({ item, role: "investigator", brief: expect.stringContaining("the retry loop"), open: { item } });
    expect(s.text).toContain("It shows under Agents");

    const backend = new MockBackend({ runs: { seed: "empty" } });
    await useWorkspace.getState().init(backend);
    const events: ClaudeEvent[] = [];
    const off = mockPipEvents.on((_, e) => events.push(e));
    const req: AskRequest = { requestId: "req-1", prompt: "investigate CA-402, focus on the retry loop", context: { ...blank, item }, sessionId: null };
    await mockAsk(req, backend, 0);
    off();
    const [run] = backend.runs.list();
    expect(run).toMatchObject({ createdBy: "pip", state: "queued", spec: { role: "investigator", brief: expect.stringContaining("the retry loop"), ticket: "CA-402" }, origin: { type: "chat", requestId: "req-1" } });
    expect(backend.workstreams.forItem("CA-402")?.id).toBe(run.spec.workstream);
    expect(backend.proposals.list().filter((p) => p.intent.type === "startRun")).toEqual([]);
  });
});
