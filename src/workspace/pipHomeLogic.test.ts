import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { heldText } from "../lib/workstreamHold";
import { HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES } from "../types";
import type { CodeChange, Intent, ItemRef, Proposal, ProposalState, Run, RunKind, RunState, WorkstreamStage, WorkstreamView } from "../types";
import { agentSummary } from "../backend/mockPip";
import { needs } from "../lib/needs";
import { docFromText } from "../lib/docs";
import { workstreamStatus } from "../lib/workstreamStatus";
import { NO_FILTERS, groupRuns, laneCount, laneOf, summaryLine } from "./agentsLogic";
import { repeatedComments } from "../lib/needs";
import { setLiveDraft } from "./draftLive";
import { keepEditsOfDraft } from "./DraftCard";
import { batchToApprove, EDITED_ASIDE, planRewriteDraft, batchable, freezeBatch, composerFooter, draftStep, workstreamSuggestionScene, FIX_ROUNDS, lastHeldAt, nextStep, retiredStepDrafts, shortHeld, stepChips, stepDrafts, STEP_KINDS } from "./pipHomeLogic";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });

const base = new MockBackend().runs.list()[0];
const run = (id: string, kind: RunKind, state: RunState, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  state,
  item: ref("CA-401"),
  spec: { ...base.spec, kind, workstream: "ws-1" },
  failure: null,
  queuedAt: iso(60),
  lastProgressAt: iso(30),
  endedAt: null,
  ...over,
});

const view = (id: string, key: string | null, over: { heldReason?: string | null; stage?: WorkstreamStage; runs?: string[]; waitingForPr?: string | null; createdAt?: string; reviewBlocking?: boolean } = {}): WorkstreamView => ({
  workstream: {
    id,
    connectionId: "mock",
    itemKey: key,
    repo: null,
    title: key ? `${key} Something` : "Ticketless",
    pipSession: null,
    mode: "manage",
    heldReason: over.heldReason ?? null,
    notes: null,
    createdAt: over.createdAt ?? iso(600),
    closedAt: null,
    budget: { autoTurns: null, wakes: null, tokens: null },
    spent: { autoTurns: 0, wakes: 0, tokens: 0 },
    rules: {},
    basis: null,
  },
  stage: over.stage ?? "intake",
  runs: over.runs ?? [],
  labels: (over.runs ?? []).map((r, n) => [r, `R${n + 1}`]),
  waitingForPr: over.waitingForPr ?? null,
  ...(over.reviewBlocking ? { reviewBlocking: true } : {}),
  budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
});

const draft = (id: string, intent: Intent, minutesAgo: number, over: { state?: ProposalState; workstream?: string | null } = {}): Proposal =>
  ({
    id,
    createdAt: iso(minutesAgo),
    updatedAt: iso(minutesAgo),
    origin: { type: "chat", requestId: `q-${id}`, workstream: over.workstream ?? null },
    createdBy: "pip",
    intent,
    label: null,
    basis: null,
    state: over.state ?? { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
  }) as Proposal;

const comment = (key: string): Intent => ({ type: "comment", item: ref(key), body: docFromText("Looks good"), mentions: [] }) as unknown as Intent;
const startRun = (key: string, kind: RunKind, workstream: string | null): Intent => ({ type: "startRun", item: ref(key), spec: { ...base.spec, kind, workstream } }) as unknown as Intent;

describe("shortHeld and lastHeldAt", () => {
  it("shortens what the held banner says", () => {
    expect(shortHeld(null)).toBeNull();
    expect(shortHeld(HELD_PERSON)).toBe("Held by you");
    expect(shortHeld(HELD_BUDGET)).toBe("Held: budget");
    expect(shortHeld(`${TRIPWIRE}marker`)).toBe("Held: a run's output held one of Gossamr's data markers");
    expect(shortHeld(`${TRIPWIRE}basis_drift`, ["description"])).toBe("Held: the ticket's description changed in Jira");
    expect(shortHeld(`${TRIPWIRE}basis_drift`, ["status"])).toBe("Held: the ticket was moved to Done");
  });

  it("reads a safety hold exactly as the rail banner does, never naming the tripwire", () => {
    for (const kind of TRIPWIRES) {
      const reason = `${TRIPWIRE}${kind}`;
      for (const drifted of [undefined, ["description"] as const, ["status"] as const]) {
        const short = shortHeld(reason, drifted);
        expect(short).toBe(heldText(reason, drifted));
        expect(short).not.toMatch(/tripwire/i);
      }
    }
  });

  it("never says tripwire in a row's status for any hold", () => {
    const reasons = [HELD_RESTART, HELD_PERSON, HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_QUOTA, ...TRIPWIRES.map((k) => `${TRIPWIRE}${k}`), `${TRIPWIRE}other`];
    for (const reason of reasons) {
      expect(heldText(reason, ["description"])).not.toMatch(/tripwire/i);
      expect(shortHeld(reason, ["description"])).not.toMatch(/tripwire/i);
      expect(workstreamStatus(view("ws-1", "CA-401", { heldReason: reason }), []).detail ?? "").not.toMatch(/tripwire/i);
    }
  });

  it("takes the last hold in the audit", () => {
    expect(lastHeldAt([{ action: "opened", at: iso(9) }])).toBeNull();
    expect(lastHeldAt([{ action: "held", at: iso(9) }, { action: "resumed", at: iso(8) }, { action: "held", at: iso(3) }])).toBe(iso(3));
  });
});

describe("nextStep", () => {
  const next = (runs: Run[]) => nextStep(stepChips(runs, [], {}, [], { now: NOW }));

  it("points at Investigate when nothing has run, and stays on a step until its newest run finished well", () => {
    expect(next([])).toBe("investigate");
    expect(next([run("r1", "investigate", "working")])).toBe("investigate");
    expect(next([run("r1", "investigate", "needsAnswer")])).toBe("investigate");
    expect(next([run("r1", "investigate", "done")])).toBe("triage");
    expect(next([run("r1", "investigate", "done"), run("r2", "plan", "done"), run("r3", "build", "failed")])).toBe("build");
    expect(next([run("r1", "investigate", "done"), run("r2", "build", "stopped")])).toBe("build");
  });

  it("goes by the furthest step with a run, skipped steps and all, and is null once Verify is done", () => {
    expect(next([run("r1", "investigate", "done"), run("r2", "plan", "done")])).toBe("build");
    expect(next([run("r1", "verify", "working")])).toBe("verify");
    expect(next([run("r1", "investigate", "done"), run("r2", "verify", "done")])).toBeNull();
  });
});

describe("the step chips", () => {
  const fromRun = (id: string, intent: Intent, runId: string, minutesAgo = 5): Proposal => ({ ...draft(id, intent, minutesAgo), origin: { type: "run", runId, shortId: null, workstream: "ws-1" }, createdBy: "agent" }) as Proposal;
  const chip = (chips: ReturnType<typeof stepChips>, kind: RunKind) => chips.find((c) => c.kind === kind)!;

  it("are the six steps in order, empty until a run of each starts", () => {
    const chips = stepChips([], [], {}, [], { now: NOW });
    expect(chips.map((c) => c.kind)).toEqual([...STEP_KINDS]);
    expect(chips.map((c) => c.label)).toEqual(["Investigate", "Triage", "Plan", "Build", "Review", "Verify"]);
    expect(chips.every((c) => c.newest === null && c.state === null && c.needsYou === 0)).toBe(true);
  });

  it("read Approved, not Ready to review, once the run's main draft was applied (G17)", () => {
    const runs = [run("r1", "plan", "done", { queuedAt: iso(50) }), run("r2", "investigate", "done", { queuedAt: iso(55) })];
    const rewrite = { type: "rewrite", item: ref("CA-401"), part: "description" } as unknown as Intent;
    const open = stepChips(runs, [], {}, [fromRun("d1", rewrite, "r1")], { now: NOW });
    expect(chip(open, "plan").state).toBe("Ready to review");
    const posted = stepChips(runs, [], {}, [fromRun("d1", rewrite, "r1", 5)].map((p) => ({ ...p, state: { type: "applied" } }) as Proposal), { now: NOW });
    expect(chip(posted, "plan")).toMatchObject({ state: "Approved", tone: "done" });
    expect(chip(posted, "investigate").state).toBe("Ready to review");
  });

  it("say how the newest run of each stands, how many there were and whether a rule started it", () => {
    const runs = [
      run("r1", "investigate", "done", { queuedAt: iso(50) }),
      run("r2", "triage", "working", { queuedAt: iso(40), autoStart: { rule: "investigate_triage", afterRun: "r1" } }),
      run("r0", "investigate", "failed", { queuedAt: iso(55) }),
    ];
    const chips = stepChips(runs, [], {}, [], { now: NOW });
    expect(chip(chips, "investigate")).toMatchObject({ state: "Ready to review", tone: "done", auto: false, newest: { id: "r1" } });
    expect(chip(chips, "investigate").runs.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(chip(chips, "triage")).toMatchObject({ state: "Working", auto: true });
    expect(chip(chips, "plan").state).toBeNull();
  });

  it("show the review's verdict once read: Pass, or Blocking with its count", () => {
    const review = run("r5", "review", "done");
    expect(chip(stepChips([review], [], {}, [], { now: NOW }), "review").verdict).toBeNull();
    expect(chip(stepChips([review], [], { r5: { verdict: "blocking", blocking: 2 } as never }, [], { now: NOW }), "review").verdict).toBe("Blocking · 2");
    expect(chip(stepChips([review], [], { r5: { verdict: "pass", blocking: 0 } as never }, [], { now: NOW }), "review").verdict).toBe("Pass");
    // A review still working has no verdict to show, whatever was read before.
    expect(chip(stepChips([{ ...review, state: "working" }], [], { r5: { verdict: "pass", blocking: 0 } as never }, [], { now: NOW }), "review").verdict).toBeNull();
  });

  it("count the build's fix rounds from the audit, out of two, and say when it waits for its pull request", () => {
    const build = run("r4", "build", "done");
    const sent = { action: "fix_round_sent", runId: "r4", actor: "supervisor" } as const;
    const yours = { ...sent, actor: "person" } as const;
    expect(chip(stepChips([build], [], {}, [], { now: NOW }), "build").fixRound).toBeNull();
    expect(chip(stepChips([build], [{ action: "wake", runId: "r4", actor: "pip" }, sent], {}, [], { now: NOW }), "build").fixRound).toBe(`fix round 1/${FIX_ROUNDS}`);
    expect(chip(stepChips([build], [sent, sent], {}, [], { now: NOW }), "build").fixRound).toBe("fix round 2/2");
    // The person's rounds past the cap are said as theirs, not as a third automatic one.
    expect(chip(stepChips([build], [sent, sent, yours], {}, [], { now: NOW }), "build").fixRound).toBe("fix round 3 (yours, after 2 automatic)");
    expect(chip(stepChips([build], [sent, sent, yours, yours], {}, [], { now: NOW }), "build").fixRound).toBe("fix round 4 (2 yours, after 2 automatic)");
    // Another workstream's build, or none, counts nothing.
    expect(chip(stepChips([build], [{ action: "fix_round_sent", runId: "other", actor: "supervisor" }], {}, [], { now: NOW }), "build").fixRound).toBeNull();
    expect(chip(stepChips([build], [], {}, [], { now: NOW, waitingForPr: "r4" }), "build")).toMatchObject({ state: "waiting for PR", tone: "warn" });
  });

  it("name the pull request of the newest build that opened one, once a sync has found it, and stop waiting for it", () => {
    const older = run("r4", "build", "done", { queuedAt: iso(50) });
    const newer = run("r6", "build", "done", { queuedAt: iso(20) });
    const pr = (number: number, over: Partial<CodeChange> = {}) => ({ kind: "pullRequest", number, title: "CA-401: Build (agent)", url: `https://github.com/acme/webshop/pull/${number}`, state: "draft", ...over }) as CodeChange;
    // Waiting, nothing found yet.
    expect(chip(stepChips([older, newer], [], {}, [], { now: NOW, waitingForPr: "r6" }), "build")).toMatchObject({ state: "waiting for PR", pr: null });
    // Found: the chip says how the build stands again, and names the pull request.
    const found = chip(stepChips([older, newer], [], {}, [], { now: NOW, changes: { r4: pr(301), r6: pr(302) } }), "build");
    expect(found).toMatchObject({ state: "Ready to review", pr: { number: 302, title: "CA-401: Build (agent)", url: "https://github.com/acme/webshop/pull/302", state: "draft" } });
    // The newest build without one yet falls back to the one before it; a branch is not a pull request.
    expect(chip(stepChips([older, newer], [], {}, [], { now: NOW, changes: { r4: pr(301), r6: null } }), "build").pr).toMatchObject({ number: 301 });
    expect(chip(stepChips([older], [], {}, [], { now: NOW, changes: { r4: pr(301, { kind: "branch", number: null }) } }), "build").pr).toBeNull();
    // Only Build shows one.
    expect(stepChips([older, run("r5", "review", "done")], [], {}, [], { now: NOW, changes: { r4: pr(301), r5: pr(301) } }).filter((c) => c.pr).map((c) => c.kind)).toEqual(["build"]);
  });

  it("count what needs the person in each step: its pending drafts and its runs asking", () => {
    const runs = [run("r1", "investigate", "needsAnswer"), run("r3", "plan", "done")];
    const proposals = [draft("d1", startRun("CA-401", "triage", "ws-1"), 5), fromRun("d2", comment("CA-401"), "r3"), draft("d3", comment("CA-401"), 4, { state: { type: "applied" } as ProposalState })];
    const chips = stepChips(runs, [], {}, proposals, { now: NOW });
    expect(chips.map((c) => c.needsYou)).toEqual([1, 1, 1, 0, 0, 0]);
  });
});

describe("drafts by step", () => {
  const runs = [run("r1", "investigate", "done"), run("r5", "review", "done")];
  const fromRun = (id: string, intent: Intent, runId: string, minutesAgo = 5): Proposal => ({ ...draft(id, intent, minutesAgo), origin: { type: "run", runId, shortId: null, workstream: "ws-1" }, createdBy: "agent" }) as Proposal;
  const rewrite = { type: "rewrite", item: ref("CA-401"), part: "description" } as unknown as Intent;
  const transition = { type: "transition", item: ref("CA-401"), to: "31" } as unknown as Intent;
  const subtasks = { type: "subtasks", parent: ref("CA-401"), summaries: ["One", "Two"] } as unknown as Intent;

  it("go under the run they came from, a run draft under its own kind, and the rest with Pip's drafts", () => {
    expect(draftStep(fromRun("a", comment("CA-401"), "r5"), runs)).toBe("review");
    expect(draftStep(draft("b", startRun("CA-401", "plan", "ws-1"), 3), runs)).toBe("plan");
    expect(draftStep(draft("c", comment("CA-401"), 3), runs)).toBe("pip");
    // A run the workstream doesn't have leaves the draft with Pip's.
    expect(draftStep(fromRun("d", comment("CA-401"), "elsewhere"), runs)).toBe("pip");
  });

  it("keep only the open ones, oldest first", () => {
    const groups = stepDrafts([fromRun("late", comment("CA-401"), "r5", 1), fromRun("early", comment("CA-401"), "r5", 9), { ...fromRun("done", comment("CA-401"), "r5", 5), state: { type: "applied" } } as Proposal, draft("pip", comment("CA-401"), 2)], runs);
    expect(groups.review?.map((p) => p.id)).toEqual(["early", "late"]);
    expect(groups.pip?.map((p) => p.id)).toEqual(["pip"]);
    expect(groups.investigate).toBeUndefined();
  });

  it("retired ones are grouped the same way for the rail's earlier drafts, oldest first, and stay out of the open groups", () => {
    const retired = (p: Proposal, reason: string) => ({ ...p, state: { type: "retired", reason } }) as Proposal;
    const all = [retired(draft("newer", transition, 2), "Another move of CA-401 was approved"), retired(draft("older", transition, 9), "Replaced by a newer draft"), retired(fromRun("rv", comment("CA-401"), "r5"), "x"), draft("open", transition, 1)];
    const groups = retiredStepDrafts(all, runs);
    expect(groups.pip?.map((p) => p.id)).toEqual(["older", "newer"]);
    expect(groups.review?.map((p) => p.id)).toEqual(["rv"]);
    expect(stepDrafts(all, runs).pip?.map((p) => p.id)).toEqual(["open"]);
    expect(retiredStepDrafts([draft("open", transition, 1)], runs)).toEqual({});
  });

  it("are approved together only when pending comments, moves and subtasks; never a rewrite or a run", () => {
    const drafts = [fromRun("c1", comment("CA-401"), "r5"), fromRun("rw", rewrite, "r5"), fromRun("t1", transition, "r5"), fromRun("s1", subtasks, "r5"), draft("run", startRun("CA-401", "review", "ws-1"), 3), { ...fromRun("c2", comment("CA-401"), "r5"), state: { type: "applying" } } as Proposal];
    expect(batchable(drafts).map((p) => p.id)).toEqual(["c1", "t1", "s1"]);
  });

  it("cover two identical comments on a ticket once, and leave the later one to be decided on its own", () => {
    const text = (t: string): Intent => ({ type: "comment", item: { connectionId: "c", externalId: "CA-401", key: "CA-401" }, body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: t, marks: [] }] }] } }) as unknown as Intent;
    const first = draft("a", text("Looks good  to me."), 5);
    const same = draft("b", text("looks good to me."), 4);
    const other = draft("c", text("Something else."), 3);
    expect(batchable([first, same, other]).map((p) => p.id)).toEqual(["a", "c"]);
    expect(freezeBatch([first, same, other]).map((f) => f.id)).toEqual(["a", "c"]);
    expect(repeatedComments([first, same, other]).map((p) => p.id)).toEqual(["b"]);
    // The same words on another ticket are another comment.
    const elsewhere = draft("d", { ...text("Looks good to me."), item: { connectionId: "c", externalId: "CA-402", key: "CA-402" } } as Intent, 2);
    expect(batchable([first, elsewhere]).map((p) => p.id)).toEqual(["a", "d"]);
    // When the first of the two is edited, the second is no longer a repeat of anything in the batch (CodeRabbit on #182).
    setLiveDraft("a", { edited: true, risky: false });
    expect(batchable([first, same, other]).map((p) => p.id)).toEqual(["b", "c"]);
    setLiveDraft("a", null);
  });

  it("leave out the questions to a reporter and Pip's comment with the person's answers, which are read and approved on their own", () => {
    const asked = { ...fromRun("asked", comment("CA-401"), "r5"), label: "Questions for the reporter" } as Proposal;
    const clarity = { ...draft("clarity", comment("CA-401"), 4), createdBy: "user", label: "Questions for the reporter" } as Proposal;
    const answers = { ...draft("answers", comment("CA-401"), 3), label: "Answers to the open questions" } as Proposal;
    expect(batchable([asked, clarity, answers, fromRun("c1", comment("CA-401"), "r5")]).map((p) => p.id)).toEqual(["c1"]);
  });

  it("leave out a draft the person edited, which only its card posts, and refuse a batch whose draft gained an edit after its confirm opened (G1)", () => {
    const a = fromRun("e1", comment("CA-401"), "r5");
    const b = fromRun("e2", comment("CA-401"), "r5");
    const c = { ...fromRun("e3", transition, "r5") };
    const drafts = [a, { ...b, intent: { ...comment("CA-401"), body: docFromText("Different") } } as Proposal, c];
    expect(batchable(drafts).map((p) => p.id)).toEqual(["e1", "e2", "e3"]);
    const frozen = freezeBatch(drafts);
    // An edit typed in a mounted card.
    setLiveDraft("e2", { edited: true, risky: false });
    expect(batchable(drafts).map((p) => p.id)).toEqual(["e1", "e3"]);
    expect(freezeBatch(drafts).map((f) => f.id)).toEqual(["e1", "e3"]);
    expect(batchToApprove(frozen, drafts)).toBeNull();
    setLiveDraft("e2", null);
    expect(batchToApprove(frozen, drafts)?.map((p) => p.id)).toEqual(["e1", "e2", "e3"]);
    // Edits kept for a card that has since closed count as well.
    keepEditsOfDraft("e1", { body: { text: "Mine", mentions: [] } });
    expect(batchable(drafts).map((p) => p.id)).toEqual(["e2", "e3"]);
    keepEditsOfDraft("e1", {});
    expect(EDITED_ASIDE).toBe("Not in the batch: drafts you edited are posted from their card.");
  });
});

describe("composerFooter", () => {
  it("counts every run at work, in a workstream or General, the queued ones apart, and everything that needs the person", () => {
    const ws = view("ws-1", "CA-401", { runs: ["a", "b", "c", "d"] });
    const fresh = { lastProgressAt: iso(1) };
    const runs = [run("a", "investigate", "working", fresh), run("b", "triage", "queued"), run("c", "plan", "launching"), run("d", "build", "done"), run("x", "plan", "working", { ...fresh, item: ref("CA-999"), spec: { ...base.spec, kind: "plan", workstream: null } })];
    const waiting = needs({ workstreams: [ws], runs: [], proposals: [draft("p1", comment("CA-401"), 5), draft("p2", comment("CA-401"), 4)], dismissed: new Set(), now: NOW }).length;
    // "Running", the word the Agents view's lane uses for runs at work.
    expect(composerFooter(runs, waiting, NOW)).toBe("3 agents running · 1 queued · 2 need you");
    expect(composerFooter([runs[0]], 1, NOW)).toBe("1 agent running · 1 needs you");
    // A run outside any workstream is working as much as one in it.
    expect(composerFooter([runs[4]], 0, NOW)).toBe("1 agent running · nothing needs you");
    // Waiting at the cap is not working.
    expect(composerFooter([runs[1]], 0, NOW)).toBe("Nothing running · 1 queued · nothing needs you");
    expect(composerFooter([run("w", "plan", "queued", { slotWaitSince: iso(2) })], 0, NOW)).toBe("Nothing running · 1 waiting for a slot · nothing needs you");
    // A run with no progress for a while is quiet, as the Agents view says, not running.
    expect(composerFooter([runs[0], run("q", "plan", "working", { lastProgressAt: iso(60) })], 0, NOW)).toBe("1 agent running · 1 quiet · nothing needs you");
    expect(composerFooter([], 0, NOW)).toBe("Nothing running · nothing needs you");
  });

  it("never disagrees with the Agents view's summary on how many runs are running, quiet, queued or waiting for a slot", () => {
    const runs = [
      run("a", "investigate", "working", { lastProgressAt: iso(1) }),
      run("b", "triage", "working", { lastProgressAt: iso(1) }),
      run("q", "plan", "working", { lastProgressAt: iso(60) }),
      run("l", "plan", "launching"),
      run("u", "review", "queued"),
      run("w", "build", "queued", { slotWaitSince: iso(3) }),
      run("n", "plan", "needsAnswer"),
      run("d", "build", "done"),
      run("f", "review", "failed"),
    ];
    const counts = (line: string) => Object.fromEntries(["running", "quiet", "queued", "waiting for a slot"].map((w) => [w, Number(new RegExp(`(\\d+) (?:agents? )?${w}`).exec(line)?.[1] ?? 0)]));
    const footer = composerFooter(runs, 0, NOW);
    expect(counts(footer)).toEqual({ running: 3, quiet: 1, queued: 1, "waiting for a slot": 1 });
    expect(counts(footer)).toEqual(counts(summaryLine(runs, NOW)));
    // And the sample's Pip, asked what the agents are doing, says the same.
    expect(counts(agentSummary(runs, NOW).split("\n")[0])).toEqual(counts(footer));
    // The Agents view's Running lane, which holds the queued runs too, says the same numbers apart.
    const running = groupRuns(runs, NO_FILTERS, NOW).find((g) => g.lane === "running")!;
    expect(laneCount("running", running.runs, NOW)).toBe("3 running · 1 queued · 1 waiting for a slot");
    expect(counts(laneCount("running", running.runs, NOW))).toEqual({ ...counts(footer), quiet: 0 });
    // A run waiting on the person is in no count of runs at work: it is one of the failed or stuck, and in Needs you.
    expect(laneOf(runs[6], NOW)).toBe("bad");
  });

  it("counts by the same clock on every screen: a run that goes quiet leaves running in the footer, the summary and the lane at once", () => {
    const later = NOW + 40 * 60_000;
    const runs = [run("a", "investigate", "working", { lastProgressAt: iso(1) })];
    for (const [at, running] of [[NOW, 1], [later, 0]] as const) {
      const n = (line: string) => Number(/(\d+) (?:agents? )?running/.exec(line)?.[1] ?? 0);
      expect([n(composerFooter(runs, 0, at)), n(summaryLine(runs, at)), n(laneCount("running", runs.filter((r) => laneOf(r, at) === "running"), at))]).toEqual([running, running, running]);
    }
  });
});

describe("workstreamSuggestionScene", () => {
  it("reads where the workstream stands for its chips", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1", "r2"], stage: "triage" });
    const runs = [run("r1", "investigate", "done"), run("r2", "triage", "working")];
    const scene = workstreamSuggestionScene(ws, runs, [], [{ kind: "user" }, { kind: "wake" }]);
    expect(scene).toEqual({ key: "CA-401", stage: "triage", mode: "manage", heldReason: null, hasPendingPlanRewrite: false, hasPendingStartDraft: false, investigated: true, woke: true, running: "R2", unclear: false, cobweb: false });
    expect(workstreamSuggestionScene(ws, runs, [], [{ kind: "wake" }, { kind: "user" }]).woke).toBe(false);
  });

  it("sees a plan's description update and a run start waiting", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r3"], stage: "plan" });
    const rewrite = { ...draft("p-rw", { type: "rewrite", item: ref("CA-401"), part: "description" } as unknown as Intent, 3), origin: { type: "run", runId: "r3" } } as Proposal;
    const scene = workstreamSuggestionScene(ws, [run("r3", "plan", "done")], [rewrite, draft("p-s", startRun("CA-401", "build", "ws-1"), 2, { workstream: "ws-1" })], []);
    expect(scene.hasPendingPlanRewrite).toBe(true);
    expect(scene.hasPendingStartDraft).toBe(true);
    expect(scene.running).toBeNull();
    // The draft 'Show me the plan update' brings into view: the plan's own, not one from another step or a decided one.
    expect(planRewriteDraft(ws, [run("r3", "plan", "done")], [rewrite])?.id).toBe("p-rw");
    expect(planRewriteDraft(ws, [run("r3", "investigate", "done")], [rewrite])).toBeNull();
    expect(planRewriteDraft(ws, [run("r3", "plan", "done")], [{ ...rewrite, state: { type: "applied" } } as Proposal])).toBeNull();
  });
});

describe("an answer Pip suggests to a run's question", () => {
  const answer = (runId: string): Intent => ({ type: "runAnswer", connectionId: "mock", runId, shortId: null, item: ref("CA-401"), message: "Keep the old rounding.", question: "Keep it?" });
  const asking = run("r-q", "investigate", "needsAnswer", { lastProgressAt: iso(10) });

  it("goes under its run's step on the rail, which counts the question once", () => {
    const p = draft("d-a", answer("r-q"), 5, { workstream: "ws-1" });
    expect(draftStep(p, [asking])).toBe("investigate");
    expect(stepDrafts([p], [asking]).investigate?.map((d) => d.id)).toEqual(["d-a"]);
    expect(stepChips([asking], [], {}, [p], { now: NOW }).find((c) => c.kind === "investigate")?.needsYou).toBe(1);
    expect(stepChips([asking], [], {}, [], { now: NOW }).find((c) => c.kind === "investigate")?.needsYou).toBe(1);
  });

  it("is never approved with the step's batch", () => {
    expect(batchable([draft("d-a", answer("r-q"), 5)])).toEqual([]);
  });
});
