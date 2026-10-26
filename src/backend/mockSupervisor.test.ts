import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemRef, Run, RunKind, RunSpec } from "../types";
import { MockBackend } from "./mock";
import type { MockOptions } from "./mockWatch";
import { itemRef } from "./mockConnector";
import { basisOfItem, driftOf, type BasisTicket } from "./mockWorkstreams";
import { docFromText } from "../lib/docs";
import fixtures from "./supervisor.fixtures.json";
import readinessFixtures from "./readiness.fixtures.json";
import { MockSupervisor, eventLine, keysIn, planRecommended, readiness, triageReadiness } from "./mockSupervisor";
import type { WakeFact } from "./mockSupervisor";

describe("the supervisor fixtures the Rust side runs too", () => {
  it.each(fixtures.lines.map((c) => [c.name, c] as const))("event line: %s", (_, c) => {
    const line = eventLine([c.fact as WakeFact]);
    expect(line).toBe(c.line);
    expect(keysIn(line)).toEqual([]);
  });

  it.each(fixtures.planRecommended.map((c) => [c.note, c.expect] as const))("plan recommended in %j", (note, expected) => {
    expect(planRecommended(note)).toBe(expected);
  });

  it.each(readinessFixtures.report.map((c) => [c.note, c.expect] as const))("readiness in %j (readiness.fixtures.json)", (note, expected) => {
    expect(readiness(note)).toEqual(expected);
  });

  it.each(fixtures.basisDrift.map((c) => [c.name, c] as const))("basis drift: %s", (_, c) => {
    const { basis: b, now: n } = c as typeof c & { basis: { summary?: string; changing?: string[] } };
    const then: BasisTicket = { title: b.summary ?? "", body: docFromText(b.description), status: { id: b.statusId, name: b.statusId, category: "active" }, assignee: null };
    const basis = { ...basisOfItem(then), summaryDigest: b.summary === undefined ? undefined : basisOfItem(then).summaryDigest, changing: b.changing ?? [] };
    const ticket: BasisTicket = { title: n.summary, body: docFromText(n.description), status: { id: n.statusId, name: n.statusId, category: n.statusCategory as "todo" | "active" | "done" }, assignee: { connectionId: "c", accountId: n.assignee } };
    expect(driftOf(basis, ticket)).toEqual(c.expect);
  });
});

describe("the wake prompt", () => {
  it("gives merged facts one line each", () => {
    const facts: WakeFact[] = [
      { run: "r1", kind: "investigate", state: "done" },
      { run: "r2", kind: "review", state: "done", verdict: "blocking", blocking: 1, drafts: 2 },
    ];
    expect(eventLine(facts)).toBe("[Event] run r1 (investigate) Done\n[Event] run r2 (review) Done; verdict: blocking; 1 blocking finding; 2 drafts");
  });

  it("finds ticket keys as keys_in does", () => {
    expect(keysIn("CA-12 and eng-9, not 12-3 or CA-x or CA-")).toEqual(["CA-12", "ENG-9"]);
    expect(keysIn("abc12345")).toEqual([]);
  });
});

// The sample backend's supervisor, waking a recorder on the sample runs.

/** A browser's storage for this file, kept across new backends as across reloads of one page. */
const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
});
afterAll(() => vi.unstubAllGlobals());

const CA401 = itemRef("CA-401");
/** The sample's deliberately vague ticket: one line of description. */
const CA408 = itemRef("CA-408");

/** A sample backend with its supervisor waking a recorder instead of the scripted Pip. GitHub is signed in with every repository watched, unless `options` says otherwise. */
function world(options: MockOptions = { githubRepos: 12 }) {
  const b = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, ...options });
  b.supervisor.dispose();
  const wakes: { ws: string; facts: WakeFact[] }[] = [];
  const supervisor = new MockSupervisor({ runs: b.runs, workstreams: b.workstreams, proposals: b.proposals, wake: (ws, facts) => wakes.push({ ws, facts }) });
  return { b, supervisor, wakes };
}

/** The person starts a `kind` run on `item` in workstream `ws`, as the setup sheet does. */
async function start(b: MockBackend, ws: string, kind: RunKind, item: ItemRef | null = CA401): Promise<Run> {
  const spec: RunSpec = { kind, repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `${(item?.key ?? "none").toLowerCase()}-${Math.random().toString(16).slice(2, 8)}`, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws };
  const draft = await b.runsDraft(spec, item);
  const { digest } = await b.runsReview(draft.id);
  return b.runsApprove(draft.id, digest);
}

const investigate = (b: MockBackend, ws: string, item: ItemRef | null = CA401) => start(b, ws, "investigate", item);

/** Moves run `id` on until it is done: queued, launching, working, done. */
function finish(b: MockBackend, id: string) {
  for (let i = 0; i < 3 && b.runs.get(id)?.state !== "done"; i++) b.runs.advance(id);
  expect(b.runs.get(id)?.state).toBe("done");
}

const last = <T>(list: T[]): T => list[list.length - 1];
const supervisorLines = (b: MockBackend, ws: string) => b.workstreams.events(ws).filter((e) => e.actor === "supervisor").map((e) => `${e.action}${e.detail ? ` ${e.detail}` : ""}`);
/** How many times Pip was woken for each run and state. */
const wakeCount = (wakes: { facts: WakeFact[] }[]) => {
  const n = new Map<string, number>();
  for (const w of wakes) for (const f of w.facts) n.set(`${f.run}:${f.state}`, (n.get(`${f.run}:${f.state}`) ?? 0) + 1);
  return n;
};

describe("the sample supervisor", () => {
  beforeEach(() => saved.clear());

  it("wakes Pip once for each run that finishes and starts nothing itself, writing nothing to Jira", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    const r1 = await investigate(b, ws);
    expect(wakes).toEqual([]);
    finish(b, r1.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].ws).toBe(ws);
    expect(eventLine(wakes[0].facts)).toBe(`[Event] run ${r1.id} (investigate) Done; 1 draft`);
    expect(b.runs.list({ workstream: ws })).toHaveLength(1);

    const triage = await start(b, ws, "triage");
    finish(b, triage.id);
    expect(wakes).toHaveLength(2);
    expect(wakes[1].facts[0]).toMatchObject({ run: triage.id, kind: "triage", state: "done", planRecommended: true });
    expect(b.runs.list({ workstream: ws })).toHaveLength(2);

    expect(Object.fromEntries(wakeCount(wakes))).toEqual({ [`${r1.id}:done`]: 1, [`${triage.id}:done`]: 1 });
    b.supervisor.check();
    expect(wakes).toHaveLength(2);
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("autostart"))).toEqual([]);
    expect(b.proposals.writes).toEqual([]);
  });

  it("wakes again when a run that was woken for needs something else, and for a run the person carried on", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    const run = await investigate(b, ws);
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    b.runs.ask(run.id, "Which cache?");
    expect(last(wakes).facts[0]).toMatchObject({ run: run.id, state: "needsAnswer" });
    b.supervisor.check();
    expect(wakes.filter((w) => w.facts[0].state === "needsAnswer")).toHaveLength(1);
  });

  it("wakes in every workstream that isn't paused or closed, on a ticket or not", async () => {
    const { b, wakes } = world();
    const a = b.workstreams.open(CA401).id;
    const none = b.workstreams.open(null, "Ticketless").id;
    const paused = b.workstreams.open(CA408).id;
    b.workstreams.pause(paused);
    const closed = b.workstreams.open(itemRef("CA-402")).id;
    finish(b, (await investigate(b, a)).id);
    finish(b, (await start(b, none, "investigate", null)).id);
    finish(b, (await investigate(b, paused, CA408)).id);
    const doomed = await investigate(b, closed, itemRef("CA-402"));
    b.workstreams.close(closed);
    finish(b, doomed.id);
    expect(wakes.map((w) => w.ws).sort()).toEqual([a, none].sort());
  });

  it("wakes nothing in a paused workstream, and once per finished run when it is resumed", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.pause(ws);
    const first = await investigate(b, ws);
    finish(b, first.id);
    const second = await start(b, ws, "triage");
    finish(b, second.id);
    expect(wakes).toEqual([]);
    expect(supervisorLines(b, ws)).toEqual([]);
    b.workstreams.resume(ws);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].facts.map((f) => f.run).sort()).toEqual([first.id, second.id].sort());
    b.supervisor.check();
    expect(wakes).toHaveLength(1);
  });

  it("pauses a workstream that reaches its wakes for the day, once, and wakes it no more until the person resumes it", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    const now = Date.now();
    for (let n = 0; n < 24; n++) b.workstreams.seedEvent(ws, "supervisor", "wake", new Date(now - 1000 - n * 1000).toISOString(), { runId: `old${n}`, detail: "done" });
    finish(b, (await investigate(b, ws)).id);
    expect(wakes).toEqual([]);
    expect(b.workstreams.get(ws)?.workstream.pausedReason).toBe("ceiling");
    expect(b.workstreams.events(ws).filter((e) => e.action === "paused")).toMatchObject([{ actor: "supervisor", detail: "ceiling" }]);
    finish(b, (await start(b, ws, "triage")).id);
    expect(wakes).toEqual([]);
    expect(b.workstreams.events(ws).filter((e) => e.action === "paused")).toHaveLength(1);
    b.workstreams.resume(ws);
    expect(wakes).toHaveLength(1);
    expect(b.workstreams.get(ws)?.workstream.pausedReason).toBeNull();
  });

  it("notes a ticket that changed since the workstream opened once, and wakes Pip all the same", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.supervisor.check();
    b.editTicket("CA-401", { description: "Rounding is off by a cent in the cart total, and in the invoice." });
    const run = await investigate(b, ws);
    finish(b, run.id);
    expect(b.workstreams.get(ws)?.workstream.pausedReason).toBeNull();
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("basis_drifted"))).toEqual(["basis_drifted description"]);
    expect(wakes).toHaveLength(1);
    b.supervisor.check();
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("basis_drifted"))).toHaveLength(1);
  });

  describe("a triage that finds the ticket not ready to plan", () => {
    /** A workstream on the vague CA-408, its investigation and its triage, finished: not ready, though it recommends a plan. */
    async function triaged() {
      const w = world();
      const ws = w.b.workstreams.open(CA408).id;
      finish(w.b, (await investigate(w.b, ws, CA408)).id);
      const triage = await start(w.b, ws, "triage", CA408);
      finish(w.b, triage.id);
      return { ...w, ws, triage };
    }

    it("says Ready to plan: no with its open questions, and tells Pip how many are open", async () => {
      const { b, ws, triage, wakes } = await triaged();
      expect(b.runs.get(triage.id)?.result).toContain("Ready to plan: no\nOpen questions:");
      expect(b.runs.list({ workstream: ws }).some((r) => r.spec.kind === "plan")).toBe(false);
      expect(triageReadiness(b.runs.get(triage.id)!)?.questions).toHaveLength(4);
      expect(last(wakes).facts[0]).toMatchObject({ run: triage.id, planRecommended: true, openQuestions: 4 });
      expect(eventLine(last(wakes).facts)).toBe(`[Event] run ${triage.id} (triage) Done; plan recommended: yes; not ready to plan, 4 open questions; 1 draft`);
    });

    it("is not what the usual sample tickets do: their triage says nothing of readiness, which reads as ready", async () => {
      const { b } = world();
      const ws = b.workstreams.open(CA401).id;
      const triage = await start(b, ws, "triage");
      finish(b, triage.id);
      expect(b.runs.get(triage.id)?.result).not.toContain("Ready to plan");
      expect(triageReadiness(b.runs.get(triage.id)!)).toBeNull();
    });

    it("leaves its note as one description update, and no comment of its own", async () => {
      const { b, triage } = await triaged();
      const pending = b.proposals.list({ states: ["pending"] }).filter((p) => p.origin.type === "run" && p.origin.runId === triage.id);
      expect(pending.map((p) => p.intent.type)).toEqual(["rewrite"]);
    });

    it("is replaced by a later triage's verdict, ready or not", async () => {
      const { b, ws } = await triaged();
      const again = await start(b, ws, "triage", CA408);
      b.runs.scriptNext("triage", { ready: false, questions: ["Which segment?"] });
      finish(b, again.id);
      expect(triageReadiness(b.runs.get(again.id)!)).toEqual({ ready: false, questions: ["Which segment?"] });
      const third = await start(b, ws, "triage", CA408);
      b.runs.scriptNext("triage", { ready: true });
      finish(b, third.id);
      expect(triageReadiness(b.runs.get(third.id)!)).toEqual({ ready: true, questions: [] });
      expect(b.runs.get(third.id)?.result).toContain("Ready to plan: yes");
    });
  });
});
