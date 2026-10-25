import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { agentSummary, mockAsk, mockPipEvents, scriptPip } from "../backend/mockPip";
import type { AskRequest, ClaudeEvent } from "../backend/claude";
import type { Run, RunState, ScreenContext, WorkstreamView } from "../types";
import { useWorkspace } from "../workspaceStore";
import { runPhrase } from "../lib/runNames";
import { NUDGE_GAP_MS, nudgeCandidates, pickNudge, type NudgeScene } from "./nudges";
import { NO_FILTERS } from "./agentsLogic";
import { PipRunCard, PipRunStripView } from "./PipRunCard";
import { STRIP_SHOWN, describeRun, nudgedOutside, runNudgeId, runNudges, runStatesNow, runSummaryPrompt, stripRuns } from "./pipRuns";
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

describe("run nudges", () => {
  it("leaves out the runs of a workstream Pip manages, whose wake turns tell the person", () => {
    const view = (id: string, mode: "advise" | "manage") => ({ workstream: { id, mode } }) as WorkstreamView;
    const runs = [run("done", { id: "managed", spec: { ...base.spec, workstream: "ws-m" } }), run("failed", { id: "advised", spec: { ...base.spec, workstream: "ws-a" } }), run("needsAnswer", { id: "loose" })];
    const ids = runNudges(runs, new Set(), () => null, nudgedOutside([view("ws-m", "manage"), view("ws-a", "advise")])).map((n) => n.id);
    expect(ids.sort()).toEqual(["run:advised:failed", "run:loose:needsAnswer"]);
    expect(runNudges(runs, new Set())).toHaveLength(3);
  });

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
    // A ticket title isn't something that finds things, so the question names the run by ticket and step instead.
    expect(done.action).toEqual({ type: "ask", prompt: "What did the agent find in run r-done?", shown: `What did ${runPhrase(run("done"))} find?` });
    const [failed] = runNudges([run("failed")], new Set());
    expect(failed.action).toEqual({ type: "open-run", id: "r-failed" });
  });

  it("get an answer about the one run the run-done nudge asks about, named as the person knows it", () => {
    const done = run("done", { result: "Found the cause: the cache key ignores the locale.\n\nFor Jira: The cache key ignores the locale; a fix is a one-line change." });
    const [nudge] = runNudges([done, run("needsAnswer")], new Set());
    if (nudge.action.type !== "ask") throw new Error("the run-done nudge asks Pip");
    const blank: ScreenContext = { view: null, item: null, filter: null, selection: [] };
    const answer = scriptPip(nudge.action.prompt, blank, [], [done, run("needsAnswer")], NOW);
    expect(answer.text).toContain(`I read the whole result of ${done.item ? `the ${done.item.key}` : "the"}`);
    expect(answer.text).toContain("The cache key ignores the locale");
    expect(answer.text).not.toContain("agent runs");
    expect(answer.text).not.toContain(done.id);
    expect(scriptPip("What did the agent find in run gone?", blank, [], [done], NOW).text).toContain("can't find that run");
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
    expect(s.runDraft).toEqual({ item, kind: "investigate", fromRun: null, focus: "the retry loop" });
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

describe("a run a rule started", () => {
  it("says on its card which run it started automatically after, by the workstream's label, else its id", () => {
    const first = run("done", { id: "run-1", queuedAt: iso(30), spec: { ...base.spec, workstream: "ws-1" } });
    const auto = run("queued", { id: "run-2", queuedAt: iso(20), spec: { ...base.spec, workstream: "ws-1" }, autoStart: { rule: "investigate_triage", afterRun: "run-1" } });
    useRuns.getInitialState().runs = [first, auto];
    const card = renderToStaticMarkup(<PipRunCard run={auto} now={NOW} ticketTitle={null} onOpen={() => {}} />);
    useRuns.getInitialState().runs = [];
    expect(card).toContain("Queued automatically after R1");
    const launched = renderToStaticMarkup(<PipRunCard run={{ ...auto, state: "working" }} now={NOW} ticketTitle={null} onOpen={() => {}} />);
    expect(launched).toContain("Started automatically after");
    expect(card).toContain('data-auto-start="investigate_triage"');
    const alone = renderToStaticMarkup(<PipRunCard run={{ ...auto, autoStart: { rule: "build_review", afterRun: "3f9a12bc-0000-4000-8000-000000000000" } }} now={NOW} ticketTitle={null} onOpen={() => {}} />);
    expect(alone).toContain("Queued automatically after 3f9a12bc");
    expect(renderToStaticMarkup(<PipRunCard run={first} now={NOW} ticketTitle={null} onOpen={() => {}} />)).not.toMatch(/(Started|Queued) automatically/);
  });
});
