import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoStartSwitches, Run, RunKind, RunSpec, Workstream, WorkstreamRule } from "../types";
import { MockBackend } from "./mock";
import type { MockOptions } from "./mockWatch";
import { itemRef } from "./mockConnector";
import { ESCALATION_GONE, MockWorkstreams, basisOfItem, driftOf, type BasisTicket } from "./mockWorkstreams";
import { docFromText, docText } from "../lib/docs";
import fixtures from "./supervisor.fixtures.json";
import readinessFixtures from "./readiness.fixtures.json";
import { FIX_FINDING_LIMIT, FIX_INSTRUCTION, FIX_PREFACE, MockSupervisor, decideAutostart, decideWake, eventLine, fixRoundMessage, keysIn, planRecommended, readiness, readinessOverridden, tripwireOf } from "./mockSupervisor";
import type { AutostartInput, ReviewFinding, WakeFact } from "./mockSupervisor";

interface Shape {
  mode?: string;
  held?: string | null;
  closed?: boolean;
  spent?: { autoTurns: number; wakes: number };
  budget?: { autoTurns?: number | null; wakes?: number | null };
}

/** A workstream as a fixture case describes it; what a case leaves out is a fresh workstream's. */
function workstream(shape: Shape): Workstream {
  return {
    id: "w1",
    connectionId: "c",
    itemKey: null,
    repo: null,
    title: "t",
    pipSession: null,
    mode: (shape.mode ?? "advise") as Workstream["mode"],
    heldReason: shape.held ?? null,
    notes: null,
    createdAt: "2026-10-01T10:00:00Z",
    closedAt: shape.closed ? "2026-10-01T11:00:00Z" : null,
    budget: { autoTurns: shape.budget?.autoTurns ?? null, wakes: shape.budget?.wakes ?? null, tokens: null },
    spent: { autoTurns: shape.spent?.autoTurns ?? 0, wakes: shape.spent?.wakes ?? 0, tokens: 0 },
    rules: {},
    basis: null,
  };
}

describe("the supervisor fixtures the Rust side runs too", () => {
  it.each(fixtures.wake.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const got = decideWake(workstream(c.workstream), c.woken, c.daily.used, c.daily.cap);
    expect(got).toEqual({ wake: c.expect.wake, hold: c.expect.hold, level: c.expect.level });
    const line = eventLine([c.fact as WakeFact]);
    expect(line).toBe(c.expect.line);
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
    const drifted = driftOf(basis, ticket);
    expect(drifted).toEqual(c.expect);
    // The tripwire fires on any field, and on none it doesn't.
    expect(tripwireOf({ ws: { createdAt: "2026-10-01T09:00:00Z" }, marked: null, drifted, runs: [], events: [] })).toEqual(c.expect.length ? { kind: "basis_drift", run: null } : null);
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

describe("the auto-start rules the Rust side runs too", () => {
  it.each(fixtures.autostart.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const got = decideAutostart(c as unknown as AutostartInput);
    const e = c.expect as Record<string, string> | null;
    if (!e) return expect(got).toBeNull();
    expect(got?.decision).toBe(e.decision);
    if (got?.decision === "start") expect([got.rule, got.kind, got.fromRun]).toEqual([e.rule, e.kind, "src1"]);
    if (got?.decision === "fixRound") {
      expect(got.buildRun).toBe(e.buildRun);
      expect(got.message).toBe(fixRoundMessage((c.report as { findings: ReviewFinding[] }).findings));
    }
    if (got?.decision === "exhausted") expect([got.reviewRun, got.buildRun]).toEqual(["src1", "b1"]);
    if (got?.decision === "waitingForPr") expect(got.buildRun).toBe("src1");
  });

  it.each(fixtures.fixRound.map((c) => [c.name, c] as const))("fix round: %s", (_, c) => {
    const findings = c.findings.map((f) => ({ ...f, text: f.text.repeat((f as { textRepeat?: number }).textRepeat ?? 1) })) as ReviewFinding[];
    const got = fixRoundMessage(findings);
    const e = c.expect as { blocks: number; has?: string[]; lacks?: string[]; message?: string } | null;
    if (!e) return expect(got).toBeNull();
    const message = got ?? "";
    expect([message.split("<<<FINDINGS\n").length - 1, message.split("\nFINDINGS>>>").length - 1]).toEqual([e.blocks, e.blocks]);
    expect(message.startsWith(`${FIX_PREFACE}\n\n<<<FINDINGS\n`) && message.endsWith(`FINDINGS>>>\n\n${FIX_INSTRUCTION}`)).toBe(true);
    for (const block of message.split("<<<FINDINGS\n").slice(1)) {
      const inner = block.split("\nFINDINGS>>>")[0];
      expect(Array.from(inner).length).toBeLessThanOrEqual(FIX_FINDING_LIMIT + 1);
      expect(inner).not.toContain("\n");
    }
    for (const has of e.has ?? []) expect(message).toContain(has);
    for (const lacks of e.lacks ?? []) expect(message).not.toContain(lacks);
    if (e.message !== undefined) expect(message).toBe(e.message);
  });
});

// The sample backend's supervisor, running the rules on the sample runs.

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

/**
 * A sample backend whose new workstreams open in Manage, with its supervisor waking a recorder instead of the scripted
 * Pip, and pull requests that show only when a sync is asked for. GitHub is signed in with every repository watched,
 * unless `options` says otherwise.
 */
function world(options: MockOptions = { githubRepos: 12 }) {
  const b = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, wsManage: true, ...options });
  b.supervisor.dispose();
  const wakes: { ws: string; facts: WakeFact[] }[] = [];
  const supervisor = new MockSupervisor({ runs: b.runs, workstreams: b.workstreams, proposals: b.proposals, wake: (ws, facts) => wakes.push({ ws, facts }), hasWaitingWake: () => false });
  return { b, supervisor, wakes };
}

/** The person starts an investigation of CA-401 in workstream `ws`, as the setup sheet does. */
async function investigate(b: MockBackend, ws: string, item = CA401): Promise<Run> {
  const spec: RunSpec = { kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `${item.key.toLowerCase()}-${Math.random().toString(16).slice(2, 8)}`, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws };
  const draft = await b.runsDraft(spec, item);
  const { digest } = await b.runsReview(draft.id);
  return b.runsApprove(draft.id, digest);
}

/** Moves run `id` on until it is done: queued, launching, working, done. */
function finish(b: MockBackend, id: string) {
  for (let i = 0; i < 3 && b.runs.get(id)?.state !== "done"; i++) b.runs.advance(id);
  expect(b.runs.get(id)?.state).toBe("done");
}

const last = <T>(list: T[]): T => list[list.length - 1];
/** The newest run of `kind` in workstream `ws`. */
const newest = (b: MockBackend, ws: string, kind: RunKind) => b.runs.list({ workstream: ws }).find((r) => r.spec.kind === kind);
const supervisorLines = (b: MockBackend, ws: string) => b.workstreams.events(ws).filter((e) => e.actor === "supervisor").map((e) => `${e.action}${e.detail ? ` ${e.detail}` : ""}`);
/** How many times Pip was woken for each run and state. */
const wakeCount = (wakes: { facts: WakeFact[] }[]) => {
  const n = new Map<string, number>();
  for (const w of wakes) for (const f of w.facts) n.set(`${f.run}:${f.state}`, (n.get(`${f.run}:${f.state}`) ?? 0) + 1);
  return n;
};

describe("the sample supervisor while the workstream waits on the reporter", () => {
  beforeEach(() => saved.clear());

  it("starts no plan after a triage that recommends one, until the person chooses", async () => {
    const { b } = world();
    const ws = b.workstreams.open(CA408).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    // Asked and posted before any triage ran: the comment is the person's, approved like any other.
    const asked = await b.workstreamsClarityAsk(ws);
    await b.proposalsApprove(asked.id);
    expect(b.workstreams.get(ws)?.waitingOnReporter?.since).toBeTruthy();
    b.runs.scriptNext("triage", { planRecommended: true, ready: true });
    finish(b, (await investigate(b, ws, CA408)).id);
    finish(b, newest(b, ws, "triage")!.id);
    expect(newest(b, ws, "plan")).toBeUndefined();
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("autostart") && l.includes("triage_plan"))).toEqual([]);
    expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
    expect(b.workstreams.get(ws)?.waitingOnReporter).toBeTruthy();
  });

  it("brings the readiness question back as a changed one when the ticket changes, and Plan now starts the plan", async () => {
    const { b } = world();
    const ws = b.workstreams.open(CA408).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    finish(b, (await investigate(b, ws, CA408)).id);
    const triage = newest(b, ws, "triage")!;
    finish(b, triage.id);
    const asked = await b.workstreamsReadinessAsk(ws, triage.id);
    await b.proposalsApprove(asked.id);
    expect(b.workstreams.get(ws)).toMatchObject({ waitingOnReporter: { since: expect.any(String) } });
    expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
    // The ticket changes while they wait: the supervisor holds the workstream (the existing drift), the wait is over, and once the
    // person resumes, the question is back, flagged.
    b.editTicket("CA-408", { description: "Win back lapsed customers with three emails over two weeks." });
    expect(b.workstreams.get(ws)?.waitingOnReporter).toBeFalsy();
    b.workstreams.resume(ws);
    expect(b.workstreams.get(ws)?.readiness).toMatchObject({ triageRun: triage.id, changed: true });
    await b.workstreamsReadinessOverride(ws, triage.id);
    expect(newest(b, ws, "plan")?.autoStart?.rule).toBe("triage_plan");
    expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
  });
});

describe("the sample supervisor", () => {
  beforeEach(() => saved.clear());

  it("leaves no GitHub review draft of a pull request in a repository that isn't watched, and reads nothing of it, as Core refuses", async () => {
    // GitHub isn't signed in, so acme/storefront, where the agents work, isn't watched.
    const { b } = world({});
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    finish(b, (await investigate(b, ws)).id);
    finish(b, newest(b, ws, "triage")!.id);
    finish(b, newest(b, ws, "plan")!.id);
    const planDraft = b.proposals.list({ states: ["pending"] }).find((p) => p.intent.type === "rewrite")!;
    await b.proposalsApprove(planDraft.id);
    const build = newest(b, ws, "build")!;
    finish(b, build.id);
    b.runs.surfacePullRequests();
    const review = newest(b, ws, "review")!;
    finish(b, review.id);
    expect(b.proposals.list().filter((p) => p.intent.type === "githubReview")).toEqual([]);
    const pr = review.spec.pr!;
    await expect(b.codePullDiff("github:ada", "acme/storefront", pr)).rejects.toThrow("acme/storefront isn't one of the repositories you watch");
    await expect(b.codePullFiles("github:ada", "acme/storefront", pr)).rejects.toThrow("isn't one of the repositories you watch");
    await expect(b.codeReviewAccess("github:ada", "acme/storefront")).rejects.toThrow("isn't one of the repositories you watch");
  });

  describe("a triage that finds the ticket not ready to plan", () => {
    /** A workstream on the vague CA-408, its investigation and the triage the rule started after it, finished: not ready, though it recommends a plan. */
    async function triaged() {
      const w = world();
      const ws = w.b.workstreams.open(CA408).id;
      w.b.workstreams.setBudget(ws, { autoTurns: 12 });
      finish(w.b, (await investigate(w.b, ws, CA408)).id);
      const triage = newest(w.b, ws, "triage")!;
      finish(w.b, triage.id);
      return { ...w, ws, triage };
    }

    it("says Ready to plan: no with its open questions, starts no plan, and tells Pip how many are open", async () => {
      const { b, ws, triage, wakes } = await triaged();
      expect(b.runs.get(triage.id)?.result).toContain("Ready to plan: no\nOpen questions:");
      expect(newest(b, ws, "plan")).toBeUndefined();
      expect(supervisorLines(b, ws).filter((l) => l.startsWith("autostart") && l.includes("triage_plan"))).toEqual([]);
      expect(b.workstreams.get(ws)?.readiness).toMatchObject({ triageRun: triage.id, triageLabel: "R2" });
      expect(b.workstreams.get(ws)?.readiness?.questions).toHaveLength(4);
      expect(last(wakes).facts[0]).toMatchObject({ run: triage.id, planRecommended: true, openQuestions: 4 });
      expect(eventLine(last(wakes).facts)).toBe(`[Event] run ${triage.id} (triage) Done; plan recommended: yes; not ready to plan, 4 open questions; 1 draft`);
    });

    it("is not what the usual sample tickets do: their triage says nothing of readiness, which reads as ready, and the plan starts", async () => {
      const { b } = world();
      const ws = b.workstreams.open(CA401).id;
      finish(b, (await investigate(b, ws)).id);
      finish(b, newest(b, ws, "triage")!.id);
      expect(b.runs.get(newest(b, ws, "triage")!.id)?.result).not.toContain("Ready to plan");
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
      expect(newest(b, ws, "plan")?.autoStart?.rule).toBe("triage_plan");
    });

    it("starts the plan after Plan anyway, as the rule would have, and audits it as the person's", async () => {
      const { b, ws, triage } = await triaged();
      await b.workstreamsReadinessOverride(ws, triage.id);
      expect(newest(b, ws, "plan")).toMatchObject({ autoStart: { rule: "triage_plan", afterRun: triage.id }, spec: { focus: null, findingsFromRun: triage.spec.findingsFromRun } });
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
      expect(b.workstreams.events(ws).find((e) => e.action === "readiness_overridden")).toMatchObject({ actor: "person", runId: triage.id });
      expect(b.runs.list({ workstream: ws }).filter((r) => r.spec.kind === "plan")).toHaveLength(1);
      await expect(b.workstreamsReadinessOverride(ws, triage.id)).rejects.toThrow("isn't waiting for your choice");
    });

    it("gives the plan Plan anyway starts the open questions to assume answers to, and its description draft lists them", async () => {
      const { b, ws, triage } = await triaged();
      const questions = b.workstreams.get(ws)!.readiness!.questions;
      await b.workstreamsReadinessOverride(ws, triage.id);
      const plan = newest(b, ws, "plan")!;
      expect(plan.spec.assumptions).toEqual(questions);
      finish(b, plan.id);
      const result = b.runs.get(plan.id)!.result!;
      expect(result).toContain("## Open questions the plan assumes answers to");
      for (const q of questions) expect(result).toMatch(new RegExp(`- ${q.replace(/[?.]/g, "\\$&")} Assumed: \\S`));
      // Each is stated as the question and the answer the plan assumed, and the summary says the plan rests on them.
      const line = `Assumes answers to ${questions.length} open questions about the ticket (listed at the end).`;
      expect(result.startsWith(line)).toBe(true);
      // The note for Jira carries the list itself, so the comment is whole without the plan.
      const jiraLine = `Assumes answers to ${questions.length} open questions about the ticket:`;
      const note = result.slice(result.indexOf("For Jira:\n"));
      expect(note).toContain(`For Jira:\n${jiraLine}\n- ${questions[0]} Assumed: `);
      for (const q of questions) expect(note).toContain(`- ${q} Assumed: `);
      expect(note).not.toContain("listed at the end");
      expect(result.indexOf("## Open questions the plan assumes answers to")).toBeGreaterThan(result.indexOf("## Risks"));
      // The plan's description draft is made from that answer, so the person reads the assumptions where they approve it.
      const rewrite = b.proposals.list({ states: ["pending"] }).find((p) => p.intent.type === "rewrite" && p.origin.type === "run" && p.origin.runId === plan.id);
      expect(JSON.stringify(rewrite?.intent)).toContain("the plan assumes answers to");
      expect(JSON.stringify(rewrite?.intent)).toContain(line);
    });

    it("starts a plan with no assumptions after a triage that was ready, and carries none into any other kind", async () => {
      const w = world();
      const ws = w.b.workstreams.open(CA401).id;
      finish(w.b, (await investigate(w.b, ws)).id);
      finish(w.b, newest(w.b, ws, "triage")!.id);
      expect(newest(w.b, ws, "plan")?.spec.assumptions ?? []).toEqual([]);
    });

    it("lets only the person's line for that triage start it: not Pip's, the supervisor's, or one for another run", async () => {
      const { b, ws, triage, supervisor } = await triaged();
      for (const actor of ["pip", "supervisor", "run"] as const) b.workstreams.record(ws, actor, "readiness_overridden", { runId: triage.id });
      b.workstreams.record(ws, "person", "readiness_overridden", { runId: "some-other-run" });
      supervisor.check();
      expect(newest(b, ws, "plan")).toBeUndefined();
      expect(b.workstreams.get(ws)?.readiness).toBeTruthy();
    });

    it("keeps Plan anyway under the workstream's holds and its budget", async () => {
      const held = await triaged();
      held.b.workstreams.hold(held.ws);
      held.b.workstreams.record(held.ws, "person", "readiness_overridden", { runId: held.triage.id });
      expect(newest(held.b, held.ws, "plan")).toBeUndefined();
      held.b.workstreams.resume(held.ws);
      expect(newest(held.b, held.ws, "plan")?.autoStart?.rule).toBe("triage_plan");

      saved.clear();
      const spent = await triaged();
      spent.b.workstreams.setBudget(spent.ws, { autoTurns: 1, wakes: 1 });
      expect(spent.b.workstreams.get(spent.ws)?.budget.level).toBe("spent");
      spent.b.workstreams.record(spent.ws, "person", "readiness_overridden", { runId: spent.triage.id });
      expect(newest(spent.b, spent.ws, "plan")).toBeUndefined();
      // Allowing more steps is its own choice; the override on record then starts the plan.
      spent.b.workstreams.hold(spent.ws, "budget", "supervisor");
      spent.b.workstreams.allowMore(spent.ws);
      expect(newest(spent.b, spent.ws, "plan")?.autoStart?.rule).toBe("triage_plan");
    });

    it("settles with I'll answer and starts nothing", async () => {
      const { b, ws, triage } = await triaged();
      await b.workstreamsReadinessAnswer(ws, triage.id);
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
      expect(newest(b, ws, "plan")).toBeUndefined();
      expect(b.workstreams.events(ws).find((e) => e.action === "readiness_answered")).toMatchObject({ actor: "person", runId: triage.id });
      await expect(b.workstreamsReadinessAnswer(ws, "nope")).rejects.toThrow("isn't waiting for your choice");
    });

    it("drafts a comment to the reporter with Ask the reporter, posts nothing, and settles", async () => {
      const { b, ws, triage } = await triaged();
      const own = b.proposals.list({ states: ["pending"] }).filter((p) => p.intent.type === "comment" && p.origin.type === "run" && p.origin.runId === triage.id);
      expect(own).toHaveLength(1);
      const before = b.proposals.list({ states: ["pending"] }).length;
      const draft = await b.workstreamsReadinessAsk(ws, triage.id);
      // The triage's own note repeated the questions: it is superseded by this draft, so only one of them can be posted.
      expect(b.proposals.list({ states: ["pending"] })).toHaveLength(before);
      expect(b.proposals.get(own[0].id)).toMatchObject({ state: { type: "retired" }, supersededBy: draft.id });
      expect(draft).toMatchObject({ state: { type: "pending" }, createdBy: "agent", label: "Questions for the reporter", origin: { type: "run", runId: triage.id, workstream: ws } });
      if (draft.intent.type !== "comment") throw new Error("a comment");
      expect(draft.intent.item.key).toBe("CA-408");
      const text = docText(draft.intent.body);
      for (const part of ["Hi @Mette Lund,", "A few things about CA-408 need clearing up", "- What does done look like for CA-408?", "- Who asked for this, and who is waiting on it?"]) expect(text).toContain(part);
      expect(JSON.stringify(draft.intent.body)).toContain('"type":"mention"');
      expect(b.proposals.writes).toEqual([]);
      expect(b.workstreams.events(ws).find((e) => e.action === "readiness_asked")).toMatchObject({ actor: "person", runId: triage.id, proposalId: draft.id });
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
      expect(newest(b, ws, "plan")).toBeUndefined();
      await expect(b.workstreamsReadinessAsk(ws, triage.id)).rejects.toThrow("isn't waiting for your choice");
    });

    it("keeps the comment to the reporter out of the triage's status comment slot", async () => {
      const { b, ws, triage } = await triaged();
      const asked = await b.workstreamsReadinessAsk(ws, triage.id);
      // Whatever the triage drafted on its own, the question to the reporter is never what the run's outcome calls its draft.
      expect((await b.runsOutcome(triage.id)).draft?.id).not.toBe(asked.id);
    });

    it("is resolved by a later triage that says ready, and a later one that says not ready replaces it", async () => {
      const { b, ws, triage, supervisor } = await triaged();
      const rerun = async (): Promise<Run> => {
        const spec: RunSpec = { kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `ca-408-again-${Math.random().toString(16).slice(2, 6)}`, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws };
        const draft = await b.runsDraft(spec, CA408);
        return b.runsApprove(draft.id, (await b.runsReview(draft.id)).digest);
      };
      const again = await rerun();
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
      b.runs.scriptNext("triage", { ready: false, questions: ["Which segment?"] });
      finish(b, again.id);
      expect(b.workstreams.get(ws)?.readiness).toMatchObject({ triageRun: again.id, questions: ["Which segment?"] });
      const third = await rerun();
      b.runs.scriptNext("triage", { ready: true });
      finish(b, third.id);
      supervisor.check();
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
      expect(b.runs.get(third.id)?.result).toContain("Ready to plan: yes");
      expect(b.runs.get(third.id)?.result).not.toContain("Ready to plan: no");
      expect(newest(b, ws, "plan")?.autoStart).toEqual({ rule: "triage_plan", afterRun: third.id });
      expect(triage.id).not.toBe(third.id);
    });

    it("is for Manage only: in Advise nothing is stopped and nothing is asked", async () => {
      const { b, ws } = await triaged();
      b.workstreams.setMode(ws, "advise");
      expect(b.workstreams.get(ws)?.readiness).toBeFalsy();
    });
  });

  it("walks a workstream from investigate to a passing review, with one wake per finished run and no Jira write before the person approves", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    // Eight runs finish without the person writing, more than the default six automatic turns allow.
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    const r1 = await investigate(b, ws);
    expect(wakes).toEqual([]);
    finish(b, r1.id);

    const triage = newest(b, ws, "triage")!;
    expect(triage).toMatchObject({ state: "queued", autoStart: { rule: "investigate_triage", afterRun: r1.id }, spec: { focus: null, focusFromRun: null, findingsFromRun: r1.id } });
    expect(wakes).toHaveLength(1);
    expect(eventLine(wakes[0].facts)).toBe(`[Event] run ${r1.id} (investigate) Done; 1 draft; started triage R2 automatically`);
    finish(b, triage.id);

    const plan = newest(b, ws, "plan")!;
    expect(plan.autoStart).toEqual({ rule: "triage_plan", afterRun: triage.id });
    expect(wakes[1].facts[0]).toMatchObject({ run: triage.id, planRecommended: true, started: { kind: "plan", label: "R3" } });
    finish(b, plan.id);

    // The plan waits for the person: nothing builds, nothing was written.
    expect(newest(b, ws, "build")).toBeUndefined();
    expect(b.proposals.writes).toEqual([]);
    const planDraft = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite")!;
    expect(planDraft).toBeDefined();
    await b.proposalsApprove(planDraft.id);
    expect(b.proposals.writes.map((w) => [w.proposalId, w.intent.type])).toEqual([[planDraft.id, "rewrite"]]);

    const build = newest(b, ws, "build")!;
    expect(build).toMatchObject({ state: "queued", autoStart: { rule: "plan_build", afterRun: plan.id }, spec: { allowPush: true, planFromRun: plan.id, planApproved: true, focus: null } });
    finish(b, build.id);
    expect(newest(b, ws, "review")).toBeUndefined();
    expect(supervisorLines(b, ws)).toContain("waiting_for_pr");
    expect(last(wakes).facts[0]).toMatchObject({ run: build.id, waitingForPr: true });

    b.runs.surfacePullRequests();
    const review = newest(b, ws, "review")!;
    const head = b.runs.pullHeadOf(build.id)!;
    expect(review).toMatchObject({ autoStart: { rule: "build_review", afterRun: build.id }, spec: { pr: head.number, prSha: head.sha, buildFromRun: build.id } });
    finish(b, review.id);

    // The default review blocks: fix round 1 sends its blocking finding back to the build, which works again.
    expect(b.runs.get(build.id)).toMatchObject({ state: "working", passes: 2 });
    // Only the message's digest and length are kept.
    expect(b.workstreams.events(ws).find((e) => e.action === "fix_round_sent")).toMatchObject({ actor: "supervisor", runId: build.id, digest: expect.stringMatching(/^mock-/), detail: expect.stringMatching(/^\d+$/) });
    expect(supervisorLines(b, ws)).toContain(`autostart fix_round after ${review.id}`);
    expect(last(wakes).facts[0]).toMatchObject({ run: review.id, verdict: "blocking", blocking: 1, fixRound: { round: 1, build: "R4" } });
    finish(b, build.id);
    expect(newest(b, ws, "review")!.id).toBe(review.id);
    b.runs.surfacePullRequests();
    const second = newest(b, ws, "review")!;
    expect(second.id).not.toBe(review.id);
    expect(second.spec.prSha).not.toBe(head.sha);
    b.runs.scriptNext("review", { verdict: "pass" });
    finish(b, second.id);
    // Each round left a GitHub review draft of the pull request; the second replaced the first, and none was posted.
    const reviewDrafts = b.proposals.list().filter((p) => p.intent.type === "githubReview");
    expect(reviewDrafts.map((p) => [(p.intent as { runId: string }).runId, p.state.type])).toEqual([
      [second.id, "pending"],
      [review.id, "retired"],
    ]);
    expect(reviewDrafts[1].supersededBy).toBe(reviewDrafts[0].id);

    // Pass ends it: Verify is off by default.
    expect(newest(b, ws, "verify")).toBeUndefined();
    expect(last(wakes).facts[0]).toMatchObject({ run: second.id, verdict: "pass" });
    // One wake for each finish: the build finished twice, once per pass.
    const counts = wakeCount(wakes);
    expect(Object.fromEntries(counts)).toEqual({ [`${r1.id}:done`]: 1, [`${triage.id}:done`]: 1, [`${plan.id}:done`]: 1, [`${build.id}:done`]: 2, [`${review.id}:done`]: 1, [`${second.id}:done`]: 1 });
    expect(wakes).toHaveLength(7);
    b.supervisor.check();
    expect(wakes).toHaveLength(7);
    expect(b.proposals.writes).toHaveLength(1);
  });

  it("says once that a build's review couldn't start, and tries again only for a new commit", async () => {
    const { b, supervisor } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    const build = await toBuild(b, ws);
    finish(b, build.id);
    const real = b.runs.autoStart.bind(b.runs);
    const tries = vi.spyOn(b.runs, "autoStart").mockImplementation((kind, from, rule) => {
      if (kind === "review") throw new Error("GitHub said no");
      return real(kind, from, rule);
    });
    b.runs.surfacePullRequests();
    for (let i = 0; i < 3; i++) supervisor.check();
    const reviews = () => tries.mock.calls.filter(([kind]) => kind === "review").length;
    expect(reviews()).toBe(1);
    const head = b.runs.pullHeadOf(build.id)!;
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("autostart_failed"))).toEqual([`autostart_failed build_review after ${build.id}@${head.sha}`]);
    tries.mockRestore();
  });

  it("chains nothing on a run whose output tripped the workstream, even once the person sets it going again", async () => {
    const { b, supervisor, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.runs.scriptNext("investigate", { marker: true });
    const r1 = await investigate(b, ws);
    finish(b, r1.id);
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBe("tripwire:marker");
    b.workstreams.resume(ws);
    b.workstreams.setMode(ws, "manage");
    supervisor.check();
    expect(newest(b, ws, "triage")).toBeUndefined();
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("autostart"))).toEqual([]);
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBeNull();
    // Pip is told about it, and the person decides.
    expect(wakes.flatMap((w) => w.facts.map((f) => f.run))).toEqual([r1.id]);
  });

  it("starts a triage's plan with the investigation the triage carried, never a newer one a tripwire named", async () => {
    const { b, supervisor } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    const r1 = await investigate(b, ws);
    finish(b, r1.id);
    const triage = newest(b, ws, "triage")!;
    expect(triage.spec.findingsFromRun).toBe(r1.id);
    // A second look at the same ticket comes back marked: the workstream trips on it, and the person sets it going.
    b.runs.scriptNext("investigate", { marker: true });
    const r3 = await investigate(b, ws);
    finish(b, r3.id);
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBe("tripwire:marker");
    b.workstreams.resume(ws);
    b.workstreams.setMode(ws, "manage");
    finish(b, triage.id);
    supervisor.check();
    const plan = newest(b, ws, "plan")!;
    expect(plan).toMatchObject({ autoStart: { rule: "triage_plan", afterRun: triage.id }, spec: { findingsFromRun: r1.id } });
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBeNull();
  });

  it("starts no plan after a triage that carried the findings of a run a tripwire named", async () => {
    const { b, supervisor } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    // The person turns the investigate-to-triage rule off, so the triage below is theirs, from a tripped investigation.
    b.workstreams.setRule(ws, "investigate_triage", false);
    b.runs.scriptNext("investigate", { marker: true });
    const r1 = await investigate(b, ws);
    finish(b, r1.id);
    b.workstreams.resume(ws);
    b.workstreams.setMode(ws, "manage");
    const spec: RunSpec = { kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-triage", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws, findingsFromRun: r1.id };
    const draft = await b.runsDraft(spec, CA401);
    const triage = await b.runsApprove(draft.id, (await b.runsReview(draft.id)).digest);
    expect(b.runs.get(triage.id)?.spec.findingsFromRun).toBe(r1.id);
    finish(b, triage.id);
    supervisor.check();
    expect(newest(b, ws, "plan")).toBeUndefined();
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("autostart"))).toEqual([]);
  });

  it("launches a run the person approves in a held workstream, as runs_approve does, while one a rule started waits", async () => {
    const { b } = world();
    const ws = b.workstreams.open(CA401).id;
    const r1 = await investigate(b, ws);
    finish(b, r1.id);
    const triage = newest(b, ws, "triage")!;
    b.workstreams.hold(ws);
    const mine = await investigate(b, ws);
    b.runs.advance(mine.id);
    b.runs.advance(triage.id);
    expect([b.runs.get(mine.id)?.state, b.runs.get(triage.id)?.state]).toEqual(["launching", "queued"]);
  });

  it("gives up after two fix rounds: the third blocking review starts nothing and says the rounds ran out", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    const build = await toBuild(b, ws);
    for (let round = 0; round < 3; round++) {
      finish(b, build.id);
      b.runs.surfacePullRequests();
      finish(b, newest(b, ws, "review")!.id);
    }
    expect(b.workstreams.events(ws).filter((e) => e.action === "fix_round_sent")).toHaveLength(2);
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("fix_rounds_exhausted"))).toEqual(["fix_rounds_exhausted 2"]);
    expect(b.runs.get(build.id)?.state).toBe("done");
    expect(b.runs.list({ workstream: ws }).filter((r) => r.spec.kind === "review")).toHaveLength(3);
    expect(last(wakes).facts[0]).toMatchObject({ exhausted: true });
    expect(eventLine(last(wakes).facts)).toContain("review still blocking after 2 fix rounds");
    b.supervisor.check();
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("fix_rounds_exhausted"))).toHaveLength(1);
  });

  it("counts no automatic step for a fix round or for the build that comes back from one, so a whole chain fits the default budget", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    const build = await toBuild(b, ws);
    for (let round = 0; round < 3; round++) {
      finish(b, build.id);
      b.runs.surfacePullRequests();
      finish(b, newest(b, ws, "review")!.id);
    }
    expect(b.workstreams.events(ws).filter((e) => e.action === "fix_round_sent")).toHaveLength(2);
    // Pip was told of all nine runs finishing, but only five were steps: the investigation, triage, plan, the build's
    // first finish and the review that ran out of rounds. The two reviews that sent a round and the builds that came back are free.
    expect(wakes).toHaveLength(9);
    const view = b.workstreams.get(ws)!;
    expect(view.workstream.spent).toMatchObject({ autoTurns: 5, wakes: 5 });
    expect(view.workstream.heldReason).toBeNull();
    expect(view.budget.level).toBe("ok");
    expect(supervisorLines(b, ws).filter((l) => l.startsWith("budget") || l.startsWith("held"))).toEqual([]);
  });

  it("starts nothing for a rule switched off, for the workstream or for everyone", async () => {
    const off = world();
    const ws = off.b.workstreams.open(CA401).id;
    off.b.workstreams.setRule(ws, "investigate_triage", false);
    finish(off.b, (await investigate(off.b, ws)).id);
    expect(newest(off.b, ws, "triage")).toBeUndefined();
    expect(off.wakes).toHaveLength(1);

    saved.clear();
    const global = world();
    global.b.runs.setSettings({ ...global.b.runs.settings(), autostart: { ...global.b.runs.settings().autostart, triagePlan: false } });
    const ws2 = global.b.workstreams.open(CA401).id;
    finish(global.b, (await investigate(global.b, ws2)).id);
    finish(global.b, newest(global.b, ws2, "triage")!.id);
    expect(newest(global.b, ws2, "plan")).toBeUndefined();
    // The workstream's own switch wins over the global one.
    global.b.workstreams.setRule(ws2, "triage_plan", true);
    expect(newest(global.b, ws2, "plan")?.autoStart?.rule).toBe("triage_plan");
  });

  const SWITCH: Record<string, keyof AutoStartSwitches> = { investigate_triage: "investigateTriage", triage_plan: "triagePlan", plan_build: "planBuild", build_review: "buildReview", fix_round: "fixRound" };
  /** What each rule starts, as the walk below sees it. */
  const STARTS: Record<string, (b: MockBackend, ws: string) => boolean> = {
    investigate_triage: (b, ws) => !!newest(b, ws, "triage"),
    triage_plan: (b, ws) => !!newest(b, ws, "plan"),
    plan_build: (b, ws) => !!newest(b, ws, "build"),
    build_review: (b, ws) => !!newest(b, ws, "review"),
    fix_round: (b, ws) => b.workstreams.events(ws).some((e) => e.action === "fix_round_sent"),
  };

  it.each(Object.keys(SWITCH).flatMap((rule) => [[rule, "workstream"], [rule, "global"]] as const))("starts nothing by %s when it is off for the %s", async (rule, where) => {
    const { b } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 12 });
    if (where === "workstream") b.workstreams.setRule(ws, rule as WorkstreamRule, false);
    else b.runs.setSettings({ ...b.runs.settings(), autostart: { ...b.runs.settings().autostart, [SWITCH[rule]]: false } });
    finish(b, (await investigate(b, ws)).id);
    // Moves everything that started on, approves the plan and shows pull requests, until nothing more happens.
    for (let step = 0; step < 12; step++) {
      for (const run of b.runs.list({ workstream: ws })) if (run.state !== "done") finish(b, run.id);
      const plan = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.intent.type === "rewrite");
      if (plan) await b.proposalsApprove(plan.id);
      b.runs.surfacePullRequests();
      if (STARTS.fix_round(b, ws)) break;
    }
    expect(STARTS[rule](b, ws)).toBe(false);
    const before = Object.keys(STARTS).slice(0, Object.keys(STARTS).indexOf(rule));
    expect(before.filter((r) => !STARTS[r](b, ws))).toEqual([]);
  });

  it("neither wakes nor starts anything in a held workstream, under Hold all, or once the budget is spent", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    const r1 = await investigate(b, ws);
    b.runs.advance(r1.id);
    b.workstreams.hold(ws);
    finish(b, r1.id);
    expect([wakes.length, newest(b, ws, "triage")]).toEqual([0, undefined]);
    // Resuming picks the finish up once.
    b.workstreams.resume(ws);
    expect(wakes).toHaveLength(1);
    expect(newest(b, ws, "triage")).toBeDefined();

    b.workstreams.holdAll();
    const triage = newest(b, ws, "triage")!;
    b.runs.advance(triage.id);
    expect(b.runs.get(triage.id)?.state).toBe("queued");
    b.workstreams.resume(ws);
    finish(b, triage.id);
    expect(wakes).toHaveLength(2);

    saved.clear();
    const spent = world();
    const ws2 = spent.b.workstreams.open(CA401).id;
    spent.b.workstreams.setBudget(ws2, { autoTurns: 5 });
    spent.b.workstreams.setRule(ws2, "investigate_triage", false);
    const late = await investigate(spent.b, ws2);
    spent.b.runs.advance(late.id);
    for (let n = 1; n <= 5; n++) {
      finish(spent.b, (await investigate(spent.b, ws2)).id);
      expect(spent.b.workstreams.get(ws2)?.budget.level).toBe(n < 4 ? "ok" : n === 4 ? "amber" : "spent");
    }
    expect(spent.b.workstreams.get(ws2)?.workstream.heldReason).toBe("budget");
    expect(supervisorLines(spent.b, ws2).filter((l) => !l.startsWith("wake"))).toEqual(["budget amber 4/5 turns 4/12 wakes", "budget spent 5/5 turns 5/12 wakes", "held budget"]);
    finish(spent.b, late.id);
    expect(spent.wakes).toHaveLength(5);
    // Only the person's message counts the turns from zero and lifts the hold; the finish then wakes Pip.
    spent.b.pipPersonWrote(ws2);
    expect(spent.wakes).toHaveLength(6);
    expect(spent.wakes[5].facts[0].run).toBe(late.id);
  });

  it("comes back after a restart held, with no wake, and wakes once per finished run when resumed", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setRule(ws, "investigate_triage", false);
    const woken = await investigate(b, ws);
    finish(b, woken.id);
    expect(wakes).toHaveLength(1);
    const missed = await investigate(b, ws);
    b.runs.advance(missed.id);
    b.workstreams.hold(ws);
    finish(b, missed.id);

    // The app restarts: the same storage, the same runs (the sample's live in memory), a new supervisor.
    const restarted = new MockWorkstreams(() => b.runs.list(), () => "title", undefined, undefined, true);
    b.runs.workstreams = restarted;
    expect(restarted.get(ws)?.workstream.heldReason).toBe("person");
    restarted.resume(ws);
    const again = new MockWorkstreams(() => b.runs.list(), () => "title", undefined, undefined, true);
    b.runs.workstreams = again;
    expect(again.get(ws)?.workstream.heldReason).toBe("restart");
    const after: WakeFact[][] = [];
    const supervisor = new MockSupervisor({ runs: b.runs, workstreams: again, proposals: b.proposals, wake: (_, f) => after.push(f), hasWaitingWake: () => false });
    supervisor.check();
    expect(after).toEqual([]);
    again.resume(ws);
    supervisor.check();
    expect(after.flat().map((f) => f.run)).toEqual([missed.id]);
  });

  it("holds a workstream whose child wrote a data marker and drops it to Advise, starting nothing after it", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.runs.scriptNext("investigate", { marker: true });
    finish(b, (await investigate(b, ws)).id);
    expect(b.workstreams.get(ws)?.workstream).toMatchObject({ mode: "advise", heldReason: "tripwire:marker" });
    expect(supervisorLines(b, ws)).toEqual(["tripwire marker", "mode_set advise", "held tripwire:marker"]);
    expect([wakes.length, newest(b, ws, "triage")]).toEqual([0, undefined]);
  });

  it("holds a managed workstream whose ticket's description is edited in Jira, says why, and takes the ticket again on resume", () => {
    const { b, supervisor, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    supervisor.check();
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBeNull();
    const before = b.workstreams.get(ws)!.workstream.basis!;
    expect(before.summaryDigest).toMatch(/^mock-/);

    b.editTicket("CA-401", { description: "Someone rewrote the welcome flow." });
    expect(b.workstreams.get(ws)?.workstream).toMatchObject({ mode: "advise", heldReason: "tripwire:basis_drift", drifted: ["description"], basis: before });
    expect(supervisorLines(b, ws)).toEqual(["tripwire basis_drift", "basis_drifted description", "mode_set advise", "held tripwire:basis_drift"]);
    expect([wakes.length, b.proposals.writes]).toEqual([0, []]);

    b.workstreams.setMode(ws, "manage");
    const resumed = b.workstreams.resume(ws);
    expect(resumed.drifted).toBeUndefined();
    expect(resumed.basis!.descriptionDigest).not.toBe(before.descriptionDigest);
    expect(last(supervisorLines(b, ws))).toBe("basis_captured");
    supervisor.check();
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBeNull();

    // The new basis counts the next edit once, the summary this time.
    b.editTicket("CA-401", { summary: "Welcome flow, take two" });
    expect(b.workstreams.get(ws)?.workstream).toMatchObject({ heldReason: "tripwire:basis_drift", drifted: ["summary"] });
    expect(b.proposals.writes).toEqual([]);
  });

  it("leaves a workstream be when its ticket moves to another status, and holds it when it moves to Done", () => {
    const { b, supervisor } = world();
    const ws = b.workstreams.open(itemRef("CA-402")).id;
    supervisor.check();
    b.editTicket("CA-402", { statusId: "QA" });
    expect(b.workstreams.get(ws)?.workstream.heldReason).toBeNull();
    b.editTicket("CA-402", { statusId: "Sent" });
    expect(b.workstreams.get(ws)?.workstream).toMatchObject({ heldReason: "tripwire:basis_drift", drifted: ["status"] });
    expect(b.proposals.writes).toEqual([]);
  });

  it("holds a workstream whose step failed twice", () => {
    const run = (id: string, kind: RunKind, state: Run["state"]) => ({ id, state, queuedAt: `2026-10-01T10:0${id}:00Z`, endedAt: `2026-10-01T10:0${id}:30Z`, lastProgressAt: `2026-10-01T10:0${id}:30Z`, spec: { kind } as RunSpec });
    const ws = { createdAt: "2026-10-01T09:00:00Z" };
    expect(tripwireOf({ ws, marked: null, runs: [run("1", "build", "failed"), run("2", "review", "failed")], events: [] })).toBeNull();
    expect(tripwireOf({ ws, marked: null, runs: [run("1", "build", "failed"), run("2", "build", "failed")], events: [] })).toEqual({ kind: "repeated_failure", run: "2" });
    // What the person set going again after they saw it doesn't trip it again.
    expect(tripwireOf({ ws, marked: null, runs: [run("1", "build", "failed"), run("2", "build", "failed")], events: [{ seq: 4, at: "2026-10-01T10:05:00Z", actor: "person", action: "resumed" }] })).toBeNull();
  });
});

describe("a review that still blocks after the automatic fix rounds", () => {
  beforeEach(() => saved.clear());

  /** A managed workstream whose build went through both automatic rounds, each review blocking, up to the third review. */
  async function exhausted() {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 30, wakes: 40 });
    const build = await toBuild(b, ws);
    let review!: Run;
    for (let round = 0; round < 3; round++) {
      finish(b, build.id);
      b.runs.surfacePullRequests();
      review = newest(b, ws, "review")!;
      finish(b, review.id);
      if (round < 2) expect(b.workstreams.get(ws)?.escalation, `after review ${round + 1}`).toBeUndefined();
    }
    return { b, ws, build, review, wakes };
  }
  const ruleRounds = (b: MockBackend, ws: string) => b.workstreams.events(ws).filter((e) => e.action === "autostart" && e.detail?.startsWith("fix_round after ")).length;

  it("waits for the person once the rounds are used up and the newest review blocks, offering its pending review draft", async () => {
    const { b, ws, build, review } = await exhausted();
    const draft = b.proposals.list({ states: ["pending"] }).find((p) => p.intent.type === "githubReview")!;
    expect(b.workstreams.get(ws)?.escalation).toMatchObject({ reviewRun: review.id, buildRun: build.id, rounds: 2, reviewDraft: draft.id });
    expect((await b.workstreamsList()).find((v) => v.workstream.id === ws)?.escalation).toEqual(b.workstreams.get(ws)?.escalation);
    // The supervisor looking again neither sends a round nor changes the mode.
    b.supervisor.check();
    expect([ruleRounds(b, ws), b.workstreams.get(ws)?.workstream.mode, b.runs.get(build.id)?.state]).toEqual([2, "manage", "done"]);
  });

  it("sends the person's fix round past the cap, as theirs and not the rule's, and the next one needs a fresh click", async () => {
    const { b, ws, build, review } = await exhausted();
    const passes = b.runs.get(build.id)!.passes ?? 1;
    const sent = await b.workstreamsFixRound(review.id);
    expect(sent).toMatchObject({ id: build.id, state: "working", passes: passes + 1 });
    const events = b.workstreams.events(ws);
    expect(events.filter((e) => e.action === "fix_round_person").map((e) => [e.actor, e.runId, e.detail])).toEqual([["person", build.id, `after ${review.id}`]]);
    expect(events.filter((e) => e.action === "fix_round_sent").map((e) => e.actor)).toEqual(["supervisor", "supervisor", "person"]);
    expect(ruleRounds(b, ws)).toBe(2);
    expect(b.workstreams.get(ws)?.escalation).toBeUndefined();
    await expect(b.workstreamsFixRound(review.id)).rejects.toThrow(ESCALATION_GONE);

    // The next review blocks too: back to the person, and the rule sends nothing of its own.
    finish(b, build.id);
    b.runs.surfacePullRequests();
    const next = newest(b, ws, "review")!;
    finish(b, next.id);
    b.supervisor.check();
    expect(b.workstreams.get(ws)?.escalation?.reviewRun).toBe(next.id);
    expect(b.workstreams.events(ws).filter((e) => e.action === "fix_round_sent")).toHaveLength(3);
    expect([ruleRounds(b, ws), b.workstreams.get(ws)?.workstream.mode, b.runs.get(build.id)?.state]).toEqual([2, "manage", "done"]);
    await expect(b.workstreamsFixRound(review.id)).rejects.toThrow(ESCALATION_GONE);
  });

  it("a person's fix round whose wake fails records nothing and leaves the escalation offered", async () => {
    const { b, ws, build, review } = await exhausted();
    b.runs.wakeFails = true;
    await expect(b.workstreamsFixRound(review.id)).rejects.toThrow("Couldn't wake");
    expect(b.workstreams.events(ws).filter((e) => e.action === "fix_round_person" || (e.action === "fix_round_sent" && e.actor === "person"))).toEqual([]);
    expect(b.workstreams.get(ws)?.escalation?.reviewRun).toBe(review.id);
    expect(b.runs.get(build.id)?.state).toBe("done");
    b.runs.wakeFails = false;
    expect(await b.workstreamsFixRound(review.id)).toMatchObject({ id: build.id, state: "working" });
  });

  it("is taken over by the person: Advise with escalation_taken, and no run, draft or write changes", async () => {
    const { b, ws, review } = await exhausted();
    const before = { runs: b.runs.list(), drafts: b.proposals.list(), writes: [...b.proposals.writes] };
    const taken = await b.workstreamsTakeOver(ws, review.id);
    expect(taken.mode).toBe("advise");
    expect(b.workstreams.events(ws).slice(-2).map((e) => [e.actor, e.action])).toEqual([
      ["person", "escalation_taken"],
      ["person", "mode_set"],
    ]);
    b.supervisor.check();
    expect({ runs: b.runs.list(), drafts: b.proposals.list(), writes: [...b.proposals.writes] }).toEqual(before);
    expect(b.workstreams.get(ws)?.escalation).toBeUndefined();
    await expect(b.workstreamsTakeOver(ws, review.id)).rejects.toThrow(ESCALATION_GONE);
    await expect(b.workstreamsFixRound(review.id)).rejects.toThrow(ESCALATION_GONE);
  });

  it("isn't raised for a third review that passes", async () => {
    const { b, wakes } = world();
    const ws = b.workstreams.open(CA401).id;
    b.workstreams.setBudget(ws, { autoTurns: 30, wakes: 40 });
    const build = await toBuild(b, ws);
    for (let round = 0; round < 3; round++) {
      finish(b, build.id);
      b.runs.surfacePullRequests();
      if (round === 2) b.runs.scriptNext("review", { verdict: "pass" });
      finish(b, newest(b, ws, "review")!.id);
    }
    expect(b.workstreams.get(ws)?.escalation).toBeUndefined();
    expect(wakes.length).toBeGreaterThan(0);
  });
});

/** Workstream `ws` taken through investigate, triage and plan, with the plan approved: its build, queued. */
async function toBuild(b: MockBackend, ws: string): Promise<Run> {
  finish(b, (await investigate(b, ws)).id);
  finish(b, newest(b, ws, "triage")!.id);
  const plan = newest(b, ws, "plan")!;
  finish(b, plan.id);
  const draft = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite")!;
  await b.proposalsApprove(draft.id);
  return newest(b, ws, "build")!;
}

describe("the person's override is the person's line alone", () => {
  const at = (actor: "person" | "pip" | "supervisor" | "run", run: string) => ({ actor, action: "readiness_overridden", runId: run });
  it("is read from the person's own readiness_overridden line naming that triage", () => {
    expect(readinessOverridden([at("person", "t1")], "t1")).toBe(true);
    expect(readinessOverridden([at("person", "t1")], "t2")).toBe(false);
    for (const actor of ["pip", "supervisor", "run"] as const) expect(readinessOverridden([at(actor, "t1")], "t1")).toBe(false);
    expect(readinessOverridden([{ actor: "person", action: "readiness_answered", runId: "t1" }], "t1")).toBe(false);
  });
});
