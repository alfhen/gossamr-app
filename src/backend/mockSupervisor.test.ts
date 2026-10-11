import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoStartSwitches, Run, RunKind, RunSpec, Workstream, WorkstreamRule } from "../types";
import { MockBackend } from "./mock";
import type { MockOptions } from "./mockWatch";
import { itemRef } from "./mockConnector";
import { MockWorkstreams, basisOfItem, driftOf, type BasisTicket } from "./mockWorkstreams";
import { docFromText } from "../lib/docs";
import fixtures from "./supervisor.fixtures.json";
import { FIX_FINDING_LIMIT, FIX_INSTRUCTION, FIX_PREFACE, MockSupervisor, budgetLevel, decideAutostart, decideWake, eventLine, fixRoundMessage, keysIn, planRecommended, tripwireOf } from "./mockSupervisor";
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

  it.each(fixtures.budget.map((c) => [JSON.stringify(c), c] as const))("budget %s", (_, c) => {
    expect(budgetLevel(workstream({ spent: c.spent, budget: c.budget }))).toBe(c.expect);
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
async function investigate(b: MockBackend, ws: string): Promise<Run> {
  const spec: RunSpec = { kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: `ca-401-${Math.random().toString(16).slice(2, 8)}`, instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws };
  const draft = await b.runsDraft(spec, CA401);
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
