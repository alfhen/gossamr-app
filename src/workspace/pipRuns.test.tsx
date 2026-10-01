import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { agentSummary, mockAsk, mockPipEvents, scriptPip } from "../backend/mockPip";
import type { AskRequest, ClaudeEvent } from "../backend/claude";
import type { Run, RunState, ScreenContext } from "../types";
import { useWorkspace } from "../workspaceStore";
import { NUDGE_GAP_MS, nudgeCandidates, pickNudge, type NudgeScene } from "./nudges";
import { useAgentsFlag } from "./agentsFlag";
import { PipRunCard, PipRunStripView } from "./PipRunCard";
import { STRIP_SHOWN, describeRun, runNudgeId, runNudges, runStatesNow, runSummaryPrompt, stripRuns } from "./pipRuns";
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
  useAgentsFlag.setState({ enabled: true });
  useRuns.setState({ runs: [], sheet: null, status: "ready" });
});

describe("run nudges", () => {
  it("speak up for a run that needs the person, finished or failed, and for nothing else", () => {
    const states: RunState[] = ["queued", "launching", "working", "stopped", "unknown"];
    expect(runNudges(states.map((s) => run(s)), new Set())).toEqual([]);
    const loud = runNudges([run("needsAnswer"), run("needsPermission"), run("systemBlocked"), run("done"), run("failed")], new Set());
    expect(loud.map((n) => n.kind).sort()).toEqual(["run-done", "run-failed", "run-needs", "run-needs", "run-needs"]);
    expect(loud.every((n) => n.id.startsWith("run:r-"))).toBe(true);
  });

  it("never nudge for the quiet chip: a working run quiet for an hour stays silent", () => {
    expect(runNudges([run("working", { lastProgressAt: iso(60) })], new Set())).toEqual([]);
  });

  it("name the run and offer to open it, or to ask Pip for a summary when it finished", () => {
    const [needs] = runNudges([run("needsAnswer")], new Set(), () => "Aurora checkout totals");
    expect(needs.text).toBe("Aurora checkout totals needs you. Want to look at what it asks?");
    expect(needs.action).toEqual({ type: "open-run", id: "r-needsAnswer" });
    const [done] = runNudges([run("done")], new Set(), () => "Aurora investigation");
    expect(done.text).toBe("Aurora investigation finished. Want me to sum up what it found?");
    expect(done.action).toEqual({ type: "ask", prompt: "What did the agent find in run r-done?" });
    const [failed] = runNudges([run("failed")], new Set());
    expect(failed.action).toEqual({ type: "open-run", id: "r-failed" });
  });

  it("come once per state change: the id carries the state, and what was announced stays quiet", () => {
    const r = run("needsPermission");
    expect(runNudgeId(r)).toBe("run:r-needsPermission:needsPermission");
    const first = runNudges([r], new Set());
    expect(first).toHaveLength(1);
    expect(runNudges([r], new Set(first.map((n) => n.id)))).toEqual([]);
    const moved = { ...r, state: "done" as const };
    expect(runNudges([moved], new Set(first.map((n) => n.id)))).toHaveLength(1);
    expect(runStatesNow([r, run("working"), moved])).toEqual(["run:r-needsPermission:needsPermission", "run:r-needsPermission:done"]);
  });

  it("respect a dismissal and the session's memory of what was shown", () => {
    const [n] = runNudges([run("done")], new Set());
    expect(pickNudge([n], [n.id], [])).toBeNull();
    expect(pickNudge([n], [], [n.id])).toBeNull();
    expect(pickNudge([n], [], [])).toBe(n);
    expect(NUDGE_GAP_MS).toBeGreaterThan(0);
  });

  it("come first on any screen but Settings, newest first", () => {
    const older = run("done", { id: "old", endedAt: iso(50) });
    const newer = run("failed", { id: "new", endedAt: iso(5) });
    const nudges = runNudges([older, newer], new Set());
    expect(nudges.map((n) => n.id)).toEqual(["run:new:failed", "run:old:done"]);
    const scene = (route: NudgeScene["route"]): NudgeScene => ({ route, filter: { type: "and", filters: [] }, count: 30, chips: 0, item: null, unassignedInView: 0, runs: nudges });
    expect(nudgeCandidates(scene("workspace")).map((n) => n.id).slice(0, 2)).toEqual(["run:new:failed", "run:old:done"]);
    expect(nudgeCandidates(scene("workspace")).some((n) => n.kind === "large-list")).toBe(true);
    expect(nudgeCandidates(scene("agents")).map((n) => n.kind)).toEqual(["run-failed", "run-done"]);
    expect(nudgeCandidates(scene("settings"))).toEqual([]);
  });
});

describe("the strip of live runs", () => {
  it("shows the runs waiting on the person first, then working ones, at most three", () => {
    const runs = [run("working", { id: "w1", lastProgressAt: iso(1) }), run("done", { id: "d" }), run("needsAnswer", { id: "n1" }), run("working", { id: "w2", lastProgressAt: iso(3) }), run("needsPermission", { id: "n2" }), run("failed", { id: "f" })];
    expect(stripRuns(runs).map((r) => r.id)).toEqual(["n1", "n2", "w1"]);
    expect(stripRuns(runs)).toHaveLength(STRIP_SHOWN);
    expect(stripRuns([run("done"), run("failed"), run("stopped")])).toEqual([]);
  });

  it("is absent while agents are off or nothing is going, and lists live runs when it is on", () => {
    const view = (runs: Run[], enabled = true) => renderToStaticMarkup(<PipRunStripView runs={runs} enabled={enabled} now={NOW} titleOf={() => null} onOpen={() => {}} />);
    const waiting = [run("needsAnswer", { id: "n1", needs: "Keep the old rounding?" })];
    expect(view(waiting)).toContain('aria-label="Your agents"');
    expect(view(waiting, false)).toBe("");
    expect(view([run("done"), run("failed")])).toBe("");
    expect(view([])).toBe("");
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
  });
});

describe("what Pip is told about agents", () => {
  const screen = (agents?: Screen["agents"]): Screen => {
    useTabs.setState(loadTabs());
    return { route: "workspace", tab: activeTab(useTabs.getState()), shown: [], items: {}, containers: {}, selected: null, marked: [], activity: { chip: "all", container: null }, agents };
  };

  it("includes the open run and how many agents wait while agents are on, and neither when they are off", () => {
    const on = buildScreenContext(screen({ openRun: "r1", waiting: 2 }));
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
    expect(describeRun(run("needsAnswer"), null, NOW)).toMatch(/^Investigate .+ · Needs an answer$/);
  });

  it("asks what the agents are doing with one fixed question", () => {
    expect(runSummaryPrompt()).toBe("What are my agents doing?");
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
    expect(s.runDraft ?? null).toBeNull();
    expect(agentSummary([], NOW)).toContain("no agent runs");
  });

  it("keeps a request to investigate on the investigation path, and takes the ticket the person named over the open one", () => {
    const open = { connectionId: "mock", externalId: "CA-402", key: "CA-402" };
    const mixed = scriptPip("which agents are running, investigate CA-406", { ...blank, item: open }, [], new MockBackend().runs.list());
    expect(mixed.steps).toEqual(["Looked up CA-406", "Drafted an agent run"]);
    expect(mixed.runDraft?.item).toEqual({ connectionId: "mock", externalId: "CA-406", key: "CA-406" });
    expect(scriptPip("investigate CA-402", { ...blank, item: open }).runDraft?.item).toBe(open);
    expect(scriptPip("start an agent", { ...blank, item: open }).runDraft?.item).toBe(open);
    expect(scriptPip("which agents are running?", { ...blank, item: open }).runDraft ?? null).toBeNull();
  });

  it("proposes an investigation as a draft with a focus note and says it has not started", async () => {
    const item = { connectionId: "mock", externalId: "CA-402", key: "CA-402" };
    const s = scriptPip("Start an agent on CA-402 and look at the retry loop", { ...blank, item });
    expect(s.runDraft).toEqual({ item, focus: "the retry loop" });
    expect(s.text).toContain("It has not started");

    const backend = new MockBackend();
    await useWorkspace.getState().init(backend);
    const events: ClaudeEvent[] = [];
    const off = mockPipEvents.on((_, e) => events.push(e));
    const before = backend.runs.list().length;
    const req: AskRequest = { requestId: "req-1", prompt: "investigate CA-402, focus on the retry loop", context: { ...blank, item }, sessionId: null };
    await mockAsk(req, backend, 0);
    off();
    const drafts = backend.proposals.list();
    const draft = drafts.find((p) => p.intent.type === "startRun" && p.origin.type === "chat");
    expect(draft?.createdBy).toBe("pip");
    expect(draft?.state.type).toBe("pending");
    if (draft?.intent.type !== "startRun") throw new Error("no run draft");
    expect(draft.intent.spec.focus).toBe("the retry loop");
    expect(draft.intent.spec.kind).toBe("investigate");
    expect(backend.runs.list().length).toBe(before);
  });
});
