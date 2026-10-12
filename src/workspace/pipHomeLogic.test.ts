import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { heldText } from "../lib/workstreamHold";
import { HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE, TRIPWIRES } from "../types";
import type { CodeChange, Intent, ItemRef, Proposal, ProposalState, Run, RunKind, RunState, WorkstreamStage, WorkstreamView } from "../types";
import { agentSummary } from "../backend/mockPip";
import { NO_FILTERS, attentionCount, groupRuns, laneCount, laneOf, summaryLine } from "./agentsLogic";
import { planRewriteDraft, titleFromTicketBlock, batchable, composerFooter, draftStep, workstreamSuggestionScene, FIX_ROUNDS, lastHeldAt, needsYouCount, needsYouItems, nextStep, retiredStepDrafts, shortHeld, stepChips, stepDrafts, STEP_KINDS, workstreamStatus, type NeedsYouInput } from "./pipHomeLogic";
import { commandDigest } from "../lib/permission";

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

const comment = (key: string): Intent => ({ type: "comment", item: ref(key), body: "Looks good", mentions: [] }) as unknown as Intent;
const startRun = (key: string, kind: RunKind, workstream: string | null): Intent => ({ type: "startRun", item: ref(key), spec: { ...base.spec, kind, workstream } }) as unknown as Intent;

const input = (over: Partial<NeedsYouInput> = {}): NeedsYouInput => ({ workstreams: [], runs: [], proposals: [], seenFailed: new Set(), ...over });

describe("needsYouItems", () => {
  const ws1 = view("ws-1", "CA-401", { runs: ["r-q", "r-p", "r-f"] });
  const ws2 = view("ws-2", "CA-402", { heldReason: HELD_PERSON, createdAt: iso(50) });

  it("finds each kind of wait, labelled", () => {
    const items = needsYouItems(
      input({
        workstreams: [ws1, ws2],
        proposals: [draft("d-comment", comment("CA-401"), 20), draft("d-start", startRun("CA-401", "investigate", "ws-1"), 25)],
        runs: [
          run("r-q", "triage", "needsAnswer", { lastProgressAt: iso(15) }),
          run("r-p", "plan", "needsPermission", { lastProgressAt: iso(14) }),
          run("r-f", "build", "failed", { lastProgressAt: iso(13), endedAt: iso(13) }),
          run("r-t", "investigate", "failed", { spec: { ...base.spec, kind: "investigate", workstream: null }, item: ref("CA-999"), failure: { type: "untrustedFolder", path: "/x" }, lastProgressAt: iso(12) }),
          run("r-s", "investigate", "systemBlocked", { spec: { ...base.spec, kind: "investigate", workstream: null }, item: null, lastProgressAt: iso(11) }),
        ],
      }),
    );
    expect(items.map((i) => [i.kind, i.label])).toEqual([
      ["held", "CA-402 · Held by you"],
      ["runStart", "CA-401 · Start Investigate"],
      ["draft", "CA-401 · Draft comment"],
      ["question", "CA-401 · R1 asks a question"],
      ["permission", "CA-401 · R2 asks to run a command"],
      ["failure", "CA-401 · R3 failed"],
      ["permission", "CA-999 · Investigate agent needs its folder trusted"],
      ["permission", "Investigate agent needs permission"],
    ]);
    expect(items.find((i) => i.kind === "draft")?.target).toEqual({ type: "draft", id: "d-comment" });
    expect(items.find((i) => i.kind === "question")?.target).toEqual({ type: "run", id: "r-q" });
    expect(items.find((i) => i.kind === "held")?.target).toEqual({ type: "workstream" });
  });

  it("keeps a permission prompt the person chose Allow once for as waiting in Terminal, and asks again once the run asks something else", () => {
    const asking = run("r-p", "build", "needsPermission", { needs: "approve Bash: git push -u origin worktree-x" });
    const listed = (r: Run) => needsYouItems(input({ workstreams: [ws1], runs: [r] })).map((i) => i.label);
    expect(listed(asking)).toEqual(["CA-401 · R2 asks to run a command"]);
    const allowed = { ...asking, permissionAllowed: { commandDigest: commandDigest("git push -u origin worktree-x"), at: iso(1) } };
    expect(listed(allowed)).toEqual(["CA-401 · R2 waits for your Yes in Terminal"]);
    // Counted as the rail badge counts it.
    expect(needsYouItems(input({ workstreams: [ws1], runs: [allowed] }))).toHaveLength(attentionCount([allowed], new Set()));
    // A new request the Allow once wasn't for: the person is asked again.
    expect(listed({ ...allowed, needs: "approve Bash: pnpm install" })).toEqual(["CA-401 · R2 asks to run a command"]);
  });

  it("lists oldest first, by when each started waiting", () => {
    const items = needsYouItems(
      input({
        workstreams: [view("ws-1", "CA-401", { heldReason: HELD_PERSON })],
        proposals: [draft("new", comment("CA-401"), 2), draft("old", comment("CA-401"), 40)],
        runs: [run("r1", "investigate", "failed", { lastProgressAt: iso(10) })],
        heldAt: { "ws-1": iso(5) },
      }),
    );
    expect(items.map((i) => i.key)).toEqual(["draft:old", "run:r1", "held:ws-1", "draft:new"]);
  });

  it("puts a draft and a run in their workstream, and the rest in General", () => {
    const items = needsYouItems(
      input({
        workstreams: [ws1, view("ws-3", "CA-403")],
        proposals: [
          draft("made-in", comment("CA-999"), 5, { workstream: "ws-3" }),
          draft("on-ticket", comment("CA-401"), 4),
          draft("closed-ws", comment("CA-777"), 3, { workstream: "ws-gone" }),
          draft("elsewhere", comment("CA-500"), 2),
        ],
        runs: [run("own", "investigate", "needsAnswer"), run("loose", "investigate", "needsAnswer", { spec: { ...base.spec, kind: "investigate", workstream: null }, item: ref("CA-500") })],
      }),
    );
    const where = Object.fromEntries(items.map((i) => [i.key, i.workstreamId]));
    expect(where).toEqual({ "draft:made-in": "ws-3", "draft:on-ticket": "ws-1", "draft:closed-ws": null, "draft:elsewhere": null, "run:own": "ws-1", "run:loose": null });
    expect(needsYouCount(items, "ws-1")).toBe(2);
    expect(needsYouCount(items, "ws-3")).toBe(1);
    expect(needsYouCount(items, null)).toBe(3);
  });

  it("leaves out decided drafts, runs that moved on, failures already seen and lifted holds", () => {
    const items = needsYouItems(
      input({
        workstreams: [view("ws-1", "CA-401")],
        proposals: [draft("a", comment("CA-401"), 5, { state: { type: "applied" } }), draft("s", comment("CA-401"), 5, { state: { type: "skipped" } }), draft("w", comment("CA-401"), 5, { state: { type: "applying" } })],
        runs: [run("working", "investigate", "working"), run("done", "triage", "done"), run("seen", "plan", "failed")],
        seenFailed: new Set(["seen"]),
      }),
    );
    expect(items).toEqual([]);
  });

  it("brings a review that still blocks after the fix rounds to the person once, by its workstream, and lets it go when the view does", () => {
    const escalated: WorkstreamView = { ...view("ws-1", "CA-401", { runs: ["r-b", "r-rev"] }), escalation: { reviewRun: "r-rev", buildRun: "r-b", reviewLabel: "R2", buildLabel: "R1", rounds: 2, reviewDraft: null, at: iso(7) } };
    const items = needsYouItems(input({ workstreams: [escalated], titleOf: () => "Checkout fails" }));
    expect(items).toEqual([
      { key: "escalation:r-rev", kind: "escalation", workstreamId: "ws-1", label: "CA-401 · review still blocks after 2 fix rounds", head: "CA-401 · Checkout fails", reason: "review still blocks after 2 fix rounds", at: iso(7), target: { type: "escalation" } },
    ]);
    expect(needsYouCount(items, "ws-1")).toBe(1);
    // Chosen (the view has no escalation any more) or closed: it goes.
    expect(needsYouItems(input({ workstreams: [{ ...escalated, escalation: undefined }] }))).toEqual([]);
    expect(needsYouItems(input({ workstreams: [{ ...escalated, workstream: { ...escalated.workstream, closedAt: iso(1) } }] }))).toEqual([]);
  });

  it("labels budget and tripwire holds the short way", () => {
    const items = needsYouItems(input({ workstreams: [view("ws-1", "CA-401", { heldReason: HELD_BUDGET }), view("ws-2", null, { heldReason: `${TRIPWIRE}repeated_failure` })] }));
    expect(items.map((i) => i.label).sort()).toEqual(["CA-401 · Held: budget", "Held: the same step failed twice"]);
  });
});

describe("Needs you labels", () => {
  it("name the run a draft came from, so a review's comments can be told apart", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1", "r2"] });
    const fromRun = (id: string, runId: string, minutesAgo: number): Proposal => ({ ...draft(id, comment("CA-401"), minutesAgo), origin: { type: "run", runId, shortId: null, workstream: "ws-1" } }) as Proposal;
    const items = needsYouItems(input({ workstreams: [ws], proposals: [fromRun("c1", "r1", 5), fromRun("c2", "r2", 4), draft("c3", comment("CA-401"), 3, { workstream: "ws-1" })] }));
    expect(items.map((i) => i.label)).toEqual(["CA-401 · R1 comment", "CA-401 · R2 comment", "CA-401 · Draft comment"]);
  });

  it("give a ticket no cache holds the title its run or run draft kept in its snapshot, so every row reads KEY · Title (D27)", () => {
    expect(titleFromTicketBlock("SUP-9: Export timeout\nKind: task | Status: Open", "SUP-9")).toBe("Export timeout");
    expect(titleFromTicketBlock("SUP-90: Something else", "SUP-9")).toBeNull();
    expect(titleFromTicketBlock(null, "SUP-9")).toBeNull();
    const failed = run("f", "investigate", "failed", { item: ref("SUP-9"), spec: { ...base.spec, kind: "investigate", ticketBlock: "SUP-9: Export timeout\nDescription: none." } });
    const start = draft("s", { type: "startRun", item: ref("WEB-120"), spec: { ...base.spec, kind: "investigate", ticketBlock: "WEB-120: Login redirect" } } as unknown as Intent, 2);
    const items = needsYouItems(input({ runs: [failed], proposals: [start] }));
    expect(items.map((i) => i.head)).toEqual(["SUP-9 · Export timeout", "WEB-120 · Login redirect"]);
    // A cached title still comes first.
    expect(needsYouItems(input({ runs: [failed], titleOf: (k) => (k === "SUP-9" ? "Export times out" : null) }))[0].head).toBe("SUP-9 · Export times out");
  });
});

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
      expect(workstreamStatus(view("ws-1", "CA-401", { heldReason: reason }), [])).not.toMatch(/tripwire/i);
    }
  });

  it("takes the last hold in the audit", () => {
    expect(lastHeldAt([{ action: "opened", at: iso(9) }])).toBeNull();
    expect(lastHeldAt([{ action: "held", at: iso(9) }, { action: "resumed", at: iso(8) }, { action: "held", at: iso(3) }])).toBe(iso(3));
  });
});

describe("workstreamStatus", () => {
  const all = ["r1", "r2", "r3"];
  const status = (runs: Run[], over: Parameters<typeof view>[2] = {}) => workstreamStatus(view("ws-1", "CA-401", { runs: all, ...over }), runs);

  it("puts a hold first, then waiting for the PR, then the furthest run going", () => {
    const going = [run("r1", "plan", "working"), run("r2", "build", "queued")];
    expect(status(going, { heldReason: HELD_BUDGET, waitingForPr: "r1" })).toBe("Held: budget");
    expect(status(going, { heldReason: HELD_PERSON })).toBe("Held by you");
    expect(status(going, { waitingForPr: "r1" })).toBe("waiting for PR");
    expect(status(going)).toBe("Plan running");
    expect(status([run("r1", "plan", "launching"), run("r2", "review", "working")])).toBe("Review running");
  });

  it("says queued, then Needs you, then a failure, then Idle or Done", () => {
    expect(status([run("r1", "build", "queued"), run("r2", "plan", "needsAnswer")])).toBe("Build queued");
    expect(status([run("r1", "plan", "needsPermission"), run("r2", "investigate", "failed")])).toBe("Needs you");
    expect(status([run("r1", "investigate", "done", { queuedAt: iso(60) }), run("r2", "triage", "failed", { queuedAt: iso(30) })])).toBe("Triage failed");
    expect(status([run("r1", "investigate", "failed", { queuedAt: iso(60) }), run("r2", "triage", "done", { queuedAt: iso(30) })], { stage: "triage" })).toBe("Idle");
    expect(status([run("r1", "review", "done")], { stage: "done" })).toBe("Done");
    expect(status([])).toBe("Idle");
  });

  it("says Needs you, not Idle or Done, while a draft or anything else waits on the person in it", () => {
    expect(status([run("r1", "plan", "done")], { stage: "plan" })).toBe("Idle");
    expect(workstreamStatus(view("ws-1", "CA-401", { runs: all, stage: "plan" }), [run("r1", "plan", "done")], 2)).toBe("Needs you");
    expect(workstreamStatus(view("ws-1", "CA-401", { runs: all, stage: "done" }), [run("r1", "review", "done")], 1)).toBe("Needs you");
    // A run going still says so first.
    expect(workstreamStatus(view("ws-1", "CA-401", { runs: all }), [run("r1", "build", "working")], 1)).toBe("Build running");
  });

  it("says changes are needed, never Done, while the newest finished review is blocking, even with its draft waiting", () => {
    const reviewed = [run("r1", "build", "done", { queuedAt: iso(60) }), run("r2", "review", "done", { queuedAt: iso(30) })];
    expect(status(reviewed, { stage: "review", reviewBlocking: true })).toBe("Review · changes needed");
    expect(workstreamStatus(view("ws-1", "CA-401", { runs: all, stage: "review", reviewBlocking: true }), reviewed, 1)).toBe("Review · changes needed");
    expect(status(reviewed, { stage: "review" })).toBe("Idle");
    expect(status(reviewed, { stage: "done" })).toBe("Done");
    // A fix round going says so first.
    expect(status([...reviewed, run("r3", "build", "working")], { stage: "review", reviewBlocking: true })).toBe("Build running");
  });

  it("only reads the workstream's own runs", () => {
    expect(workstreamStatus(view("ws-1", "CA-401", { runs: ["r1"] }), [run("r9", "build", "working")])).toBe("Idle");
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
});

describe("composerFooter", () => {
  it("counts every run at work, in a workstream or General, the queued ones apart, and everything that needs the person", () => {
    const ws = view("ws-1", "CA-401", { runs: ["a", "b", "c", "d"] });
    const fresh = { lastProgressAt: iso(1) };
    const runs = [run("a", "investigate", "working", fresh), run("b", "triage", "queued"), run("c", "plan", "launching"), run("d", "build", "done"), run("x", "plan", "working", { ...fresh, item: ref("CA-999"), spec: { ...base.spec, kind: "plan", workstream: null } })];
    const items = needsYouItems(input({ workstreams: [ws], proposals: [draft("p1", comment("CA-401"), 5), draft("p2", comment("CA-401"), 4)] }));
    // "Running", the word the Agents view's lane uses for runs at work.
    expect(composerFooter(runs, items, NOW)).toBe("3 running · 1 queued · 2 need you");
    expect(composerFooter([runs[0]], items.slice(0, 1), NOW)).toBe("1 running · 1 needs you");
    // A run outside any workstream is working as much as one in it.
    expect(composerFooter([runs[4]], [], NOW)).toBe("1 running · nothing needs you");
    // Waiting at the cap is not working.
    expect(composerFooter([runs[1]], [], NOW)).toBe("Nothing running · 1 queued · nothing needs you");
    expect(composerFooter([run("w", "plan", "queued", { slotWaitSince: iso(2) })], [], NOW)).toBe("Nothing running · 1 waiting for a slot · nothing needs you");
    // A run with no progress for a while is quiet, as the Agents view says, not running.
    expect(composerFooter([runs[0], run("q", "plan", "working", { lastProgressAt: iso(60) })], [], NOW)).toBe("1 running · 1 quiet · nothing needs you");
    expect(composerFooter([], [], NOW)).toBe("Nothing running · nothing needs you");
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
    const counts = (line: string) => Object.fromEntries(["running", "quiet", "queued", "waiting for a slot"].map((w) => [w, Number(new RegExp(`(\\d+) ${w}`).exec(line)?.[1] ?? 0)]));
    const footer = composerFooter(runs, [], NOW);
    expect(counts(footer)).toEqual({ running: 3, quiet: 1, queued: 1, "waiting for a slot": 1 });
    expect(counts(footer)).toEqual(counts(summaryLine(runs, NOW)));
    // And the sample's Pip, asked what the agents are doing, says the same.
    expect(counts(agentSummary(runs, NOW).split("\n")[0])).toEqual(counts(footer));
    // The Agents view's Running lane, which holds the queued runs too, says the same numbers apart.
    const running = groupRuns(runs, NO_FILTERS, NOW).find((g) => g.lane === "running")!;
    expect(laneCount("running", running.runs, NOW)).toBe("3 running · 1 queued · 1 waiting for a slot");
    expect(counts(laneCount("running", running.runs, NOW))).toEqual({ ...counts(footer), quiet: 0 });
    expect(laneCount("needs", [runs[6]], NOW)).toBe("1");
  });

  it("counts by the same clock on every screen: a run that goes quiet leaves running in the footer, the summary and the lane at once", () => {
    const later = NOW + 40 * 60_000;
    const runs = [run("a", "investigate", "working", { lastProgressAt: iso(1) })];
    for (const [at, running] of [[NOW, 1], [later, 0]] as const) {
      const n = (line: string) => Number(/(\d+) running/.exec(line)?.[1] ?? 0);
      expect([n(composerFooter(runs, [], at)), n(summaryLine(runs, at)), n(laneCount("running", runs.filter((r) => laneOf(r, at) === "running"), at))]).toEqual([running, running, running]);
    }
  });
});

describe("workstreamSuggestionScene", () => {
  it("reads where the workstream stands for its chips", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1", "r2"], stage: "triage" });
    const runs = [run("r1", "investigate", "done"), run("r2", "triage", "working")];
    const scene = workstreamSuggestionScene(ws, runs, [], [{ kind: "user" }, { kind: "wake" }]);
    expect(scene).toEqual({ key: "CA-401", stage: "triage", mode: "manage", heldReason: null, hasPendingPlanRewrite: false, hasPendingStartDraft: false, investigated: true, woke: true, running: "R2" });
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
  const ws1 = view("ws-1", "CA-401", { runs: ["r-q"] });
  const answer = (runId: string): Intent => ({ type: "runAnswer", connectionId: "mock", runId, shortId: null, item: ref("CA-401"), message: "Keep the old rounding.", question: "Keep it?" });
  const asking = run("r-q", "investigate", "needsAnswer", { lastProgressAt: iso(10) });

  it("is one item with the run's question in the tray, going to the reply", () => {
    const items = needsYouItems(input({ workstreams: [ws1], runs: [asking], proposals: [draft("d-a", answer("r-q"), 5, { workstream: "ws-1" })] }));
    expect(items).toEqual([{ key: "draft:d-a", kind: "question", workstreamId: "ws-1", label: "CA-401 · R1 asks a question · Pip suggests a reply", head: "CA-401 · Something", reason: "R1 asks a question · Pip suggests a reply", at: iso(10), target: { type: "draft", id: "d-a" } }]);
    expect(needsYouCount(items, "ws-1")).toBe(1);
  });

  it("heads each item with its ticket and the ticket's title when cached, the wait on its own", () => {
    const failed = run("r-f", "build", "failed", { item: ref("CA-401") });
    const items = needsYouItems(input({ workstreams: [ws1], runs: [asking, failed], proposals: [draft("d-a", answer("r-q"), 5, { workstream: "ws-1" })], titleOf: (key) => (key === "CA-401" ? "Welcome flow refresh" : null) }));
    expect(items.map((i) => [i.head, i.reason])).toEqual(
      expect.arrayContaining([
        ["CA-401 · Welcome flow refresh", "R1 asks a question · Pip suggests a reply"],
        ["CA-401 · Welcome flow refresh", expect.stringMatching(/failed$/)],
      ]),
    );
    expect(items.every((i) => i.label === `CA-401 · ${i.reason}`)).toBe(true);
  });

  it("heads an item on a ticket that isn't cached with the title its workstream kept, and the key alone without one", () => {
    const failed = run("r-f", "build", "failed", { item: ref("CA-401") });
    const loose = run("r-l", "plan", "failed", { item: ref("CA-777") });
    const items = needsYouItems(input({ workstreams: [ws1], runs: [failed, loose], titleOf: () => null }));
    expect(items.map((i) => i.head)).toEqual(expect.arrayContaining(["CA-401 · Something", "CA-777"]));
    // The cache wins where it has the ticket.
    expect(needsYouItems(input({ workstreams: [ws1], runs: [failed], titleOf: () => "Welcome flow refresh" }))[0].head).toBe("CA-401 · Welcome flow refresh");
  });

  it("is a draft of its own once the run isn't asking, and the question alone once the reply is decided", () => {
    const working = run("r-q", "investigate", "working");
    expect(needsYouItems(input({ workstreams: [ws1], runs: [working], proposals: [draft("d-a", answer("r-q"), 5, { workstream: "ws-1" })] })).map((i) => i.label)).toEqual(["CA-401 · Draft answer"]);
    const skipped = draft("d-a", answer("r-q"), 5, { workstream: "ws-1", state: { type: "skipped" } });
    expect(needsYouItems(input({ workstreams: [ws1], runs: [asking], proposals: [skipped] })).map((i) => [i.key, i.label])).toEqual([["run:r-q", "CA-401 · R1 asks a question"]]);
  });

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
