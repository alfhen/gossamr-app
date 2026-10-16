import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { HELD_ALL, HELD_BUDGET, HELD_DAILY, HELD_PERSON, HELD_QUOTA, HELD_RESTART, TRIPWIRE } from "../types";
import type { Intent, ItemRef, Proposal, ProposalState, Run, RunKind, RunState, WorkstreamStage, WorkstreamView } from "../types";
import { docFromText } from "./docs";
import { BATCHABLE, GROUP_RANK, chipLabel, byRank, escalationReason, higherPriority, needAfter, needGroups, needs, needsIn, quietKey, leftOutLabel, readinessPrompt, readinessWhy, repeatedComments, titleFromTicketBlock, type Need, type NeedKind, type NeedsInput } from "./needs";

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
  needs: null,
  queuedAt: iso(60),
  lastProgressAt: iso(5),
  endedAt: null,
  ...over,
});

const view = (id: string, key: string | null, over: { heldReason?: string | null; stage?: WorkstreamStage; runs?: string[]; createdAt?: string; title?: string } = {}): WorkstreamView => ({
  workstream: {
    id,
    connectionId: "mock",
    itemKey: key,
    repo: null,
    title: over.title ?? (key ? `${key} Something` : "Ticketless"),
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
  waitingForPr: null,
  budget: { autoTurns: { used: 0, limit: 6 }, wakes: { used: 0, limit: 12 }, level: "ok" },
});

const draft = (id: string, intent: Intent, minutesAgo: number, over: { state?: ProposalState; workstream?: string | null; origin?: Proposal["origin"]; supersededBy?: string | null } = {}): Proposal =>
  ({
    id,
    createdAt: iso(minutesAgo),
    updatedAt: iso(minutesAgo),
    origin: over.origin ?? { type: "chat", requestId: `q-${id}`, workstream: over.workstream ?? null },
    createdBy: "pip",
    intent,
    label: null,
    basis: null,
    state: over.state ?? { type: "pending" },
    revisions: [],
    created: [],
    error: null,
    run: null,
    ...(over.supersededBy ? { supersededBy: over.supersededBy } : {}),
  }) as Proposal;

const comment = (key: string): Intent => ({ type: "comment", item: ref(key), body: docFromText("Looks good"), mentions: [] }) as unknown as Intent;
const transition = (key: string): Intent => ({ type: "transition", item: ref(key), to: "done" }) as unknown as Intent;
const subtasks = (key: string): Intent => ({ type: "subtasks", parent: ref(key), summaries: ["a", "b"] }) as unknown as Intent;
const rewrite = (key: string): Intent => ({ type: "rewrite", item: ref(key), title: null, body: { from: {}, to: {}, fromText: "a", toText: "b" } }) as unknown as Intent;
const startRun = (key: string, kind: RunKind, workstream: string | null): Intent => ({ type: "startRun", item: ref(key), spec: { ...base.spec, kind, workstream } }) as unknown as Intent;
const answer = (runId: string): Intent => ({ type: "runAnswer", item: ref("CA-401"), runId, message: "Yes", question: "q" }) as unknown as Intent;
const review = (): Intent => ({ type: "githubReview", item: ref("CA-401"), connectionId: "github", repo: "acme/shop", number: 7, runId: "r-rev", summary: "s", comments: [] }) as unknown as Intent;

const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({ workstreams: [], runs: [], proposals: [], dismissed: new Set(), now: NOW, ...over });
const kinds = (list: readonly Need[]) => list.map((n) => n.kind);
const escalated = (over: { reviewDraft?: string | null; at?: string } = {}): WorkstreamView => ({
  ...view("ws-1", "CA-401", { runs: ["r-b", "r-rev"] }),
  escalation: { reviewRun: "r-rev", buildRun: "r-b", reviewLabel: "R2", buildLabel: "R1", rounds: 2, reviewDraft: over.reviewDraft ?? null, at: over.at ?? iso(7) },
});

describe("needs: every kind", () => {
  const ws1 = view("ws-1", "CA-401", { runs: ["r-q", "r-p", "r-f", "r-limit", "r-quiet", "r-b", "r-rev", "r-plan"] });

  it("finds each kind of wait in its group, with the words that say it", () => {
    const list = needs(
      input({
        workstreams: [ws1, view("ws-2", "CA-402", { heldReason: HELD_RESTART, createdAt: iso(50) }), { ...escalated(), workstream: { ...escalated().workstream, id: "ws-3", itemKey: "CA-403", title: "CA-403 Third" } }, view("ws-4", "CA-404", { heldReason: HELD_BUDGET })],
        proposals: [
          draft("d-comment", comment("CA-401"), 20),
          draft("d-start", startRun("CA-401", "investigate", "ws-1"), 25),
          draft("d-review", review(), 26),
          draft("d-desc", rewrite("CA-401"), 27),
          draft("d-plan", rewrite("CA-401"), 28, { origin: { type: "run", runId: "r-plan", shortId: null, workstream: "ws-1" } }),
        ],
        runs: [
          run("r-q", "triage", "needsAnswer", { needs: "Which cache?" }),
          run("r-p", "build", "needsPermission", { needs: "approve Bash: git push origin ca-401" }),
          run("r-f", "build", "failed", { error: "boom", endedAt: iso(13) }),
          run("r-limit", "plan", "stopped", { stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit" }),
          run("r-quiet", "investigate", "working", { lastProgressAt: iso(45) }),
          run("r-plan", "plan", "done"),
          run("r-unknown", "investigate", "unknown", { spec: { ...base.spec, kind: "investigate", workstream: null }, item: ref("CA-900") }),
          run("r-cont", "investigate", "stopped", { spec: { ...base.spec, kind: "investigate", workstream: null }, item: ref("CA-901"), possibleContinuations: [{ shortId: "abc12345" }] }),
          run("r-sign", "investigate", "systemBlocked", { spec: { ...base.spec, kind: "investigate", workstream: null }, item: null }),
        ],
      }),
    );
    const by = (kind: NeedKind) => list.filter((n) => n.kind === kind);
    expect(Object.fromEntries(list.map((n) => [n.kind, n.group]))).toEqual({
      plan: "decide",
      description: "decide",
      escalation: "decide",
      budget: "decide",
      question: "unblock",
      permission: "unblock",
      failure: "unblock",
      stoppedAtLimit: "unblock",
      quiet: "unblock",
      unknown: "unblock",
      continuation: "unblock",
      signIn: "unblock",
      hold: "unblock",
      draft: "approve",
      review: "approve",
      runStart: "approve",
    });
    expect(list).toHaveLength(16);
    expect(by("plan")[0].target).toEqual({ type: "draft", id: "d-plan" });
    // The run's label is a parenthesis, not the subject: "R1 plan wrote the plan" reads wrong once the run is brought into a workstream (G12).
    expect(by("plan")[0].why).toMatch(/^An agent wrote the plan for CA-401 \(run R\d+\); approving/);
    expect(by("description")[0].title).toBe("Draft rewrite");
    expect(by("escalation")[0].title).toBe("Review still blocks after 2 fix rounds");
    expect(by("hold")[0]).toMatchObject({ title: "Held after a restart", workstreamId: "ws-2", target: { type: "workstream" } });
    expect(by("budget")[0]).toMatchObject({ workstreamId: "ws-4", target: { type: "workstream" } });
    expect(by("question")[0]).toMatchObject({ title: "R1 asks a question", target: { type: "run", id: "r-q" }, runId: "r-q" });
    expect(by("permission")[0].title).toBe("R2 asks to run a command");
    expect(by("failure")[0].title).toBe("R3 failed");
    expect(by("stoppedAtLimit")[0].title).toBe("R4 stopped at its limit");
    expect(by("quiet")[0].title).toBe("R5 has gone quiet");
    expect(by("unknown")[0].title).toBe("Investigate agent is in a state Gossamr can't read");
    expect(by("continuation")[0].title).toBe("Investigate agent may have continued in another session");
    expect(by("runStart")[0].title).toBe("Start Investigate");
    expect(by("draft")[0].target).toEqual({ type: "draft", id: "d-comment" });
    expect(by("review")[0].title).toBe("Draft review");
  });

  it("says why and what waiting does in one plain sentence each, for every kind", () => {
    const list = needs(
      input({
        workstreams: [view("ws-1", "CA-401", { runs: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"], heldReason: HELD_BUDGET }), { ...escalated(), workstream: { ...escalated().workstream, id: "ws-3", itemKey: "CA-403", title: "CA-403 Third" } }],
        proposals: [draft("d1", comment("CA-401"), 20), draft("d2", startRun("CA-401", "build", "ws-1"), 25), draft("d3", review(), 26), draft("d4", rewrite("CA-401"), 27), draft("d5", subtasks("CA-401"), 28)],
        runs: [
          run("r1", "triage", "needsAnswer", { needs: "Which cache?" }),
          run("r2", "build", "needsPermission", { needs: "approve Bash: git push origin ca-401" }),
          run("r3", "build", "failed", { error: "boom" }),
          run("r4", "plan", "stopped", { stoppedByLimit: true }),
          run("r5", "investigate", "working", { lastProgressAt: iso(45) }),
          run("r6", "investigate", "unknown"),
          run("r7", "investigate", "systemBlocked"),
          run("r8", "investigate", "stopped", { possibleContinuations: [{ shortId: "abc12345" }] }),
        ],
      }),
    );
    expect(list.length).toBeGreaterThanOrEqual(12);
    for (const n of list) {
      for (const text of [n.why, n.ifYouWait]) {
        expect(text, `${n.kind}`).toMatch(/\S/);
        expect(text, `${n.kind}: ${text}`).toMatch(/[.!?”]$/);
        expect(text, `${n.kind}: ${text}`).not.toMatch(/\n/);
      }
    }
    const permission = list.find((n) => n.kind === "permission")!;
    expect(permission.why).toBe("R2 wants to run `git push origin ca-401`.");
    expect(permission.ifYouWait).toBe("The run stays paused; nothing else in CA-401 moves.");
    expect(list.find((n) => n.kind === "escalation")!.why).toBe("The review still blocks after 2 fix rounds.");
    expect(list.find((n) => n.kind === "draft" && n.target.type === "draft" && n.target.id === "d1")!.ifYouWait).toBe("Nothing is written to Jira until you approve it.");
    expect(list.find((n) => n.kind === "review")!.ifYouWait).toBe("Nothing is posted to GitHub until you choose.");
    expect(list.find((n) => n.kind === "question")!.why).toBe("R1 asks: “Which cache?”");
  });

  it("names the tool when a permission is for something other than a command", () => {
    const [n] = needs(input({ workstreams: [view("ws-1", "CA-401", { runs: ["r1"] })], runs: [run("r1", "build", "needsPermission", { needs: "approve Edit: src/cart.ts" })] }));
    expect(n.why).toBe("R1 wants to use Edit on `src/cart.ts`.");
  });

  it("keeps a permission prompt the person chose Allow once for as waiting in Terminal, and asks again once the run asks something else", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r-p"] });
    const asking = run("r-p", "build", "needsPermission", { needs: "approve Bash: git push -u origin worktree-x" });
    const titles = (r: Run) => needs(input({ workstreams: [ws], runs: [r] })).map((n) => n.title);
    expect(titles(asking)).toEqual(["R1 asks to run a command"]);
    const allowed = { ...asking, permissionAllowed: { command: "git push -u origin worktree-x", at: iso(1) } };
    expect(titles(allowed)).toEqual(["R1 waits for your Yes in Terminal"]);
    expect(needs(input({ workstreams: [ws], runs: [allowed] }))[0].primary.id).toBe("open");
    expect(titles({ ...allowed, needs: "approve Bash: pnpm install" })).toEqual(["R1 asks to run a command"]);
  });

  it("offers Allow once only where it is offered: a Build's plain command, never a read-only run's", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1"] });
    const [read] = needs(input({ workstreams: [ws], runs: [run("r1", "investigate", "needsPermission", { needs: "approve Bash: git push" })] }));
    expect(read.primary.id).toBe("deny");
    expect(read.secondary).toEqual([]);
    const [build] = needs(input({ workstreams: [ws], runs: [run("r1", "build", "needsPermission", { needs: "approve Bash: git status", spec: { ...base.spec, kind: "build", workstream: "ws-1" } })] }));
    expect([build.primary.id, ...build.secondary.map((a) => a.id)]).toEqual(["allow", "deny"]);
  });
});

describe("needs: the sign-in label", () => {
  it("reads 'needs you to sign in to Claude', never 'needs permission'", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1"] });
    const [n] = needs(input({ workstreams: [ws], runs: [run("r1", "build", "systemBlocked")] }));
    expect(n.kind).toBe("signIn");
    expect(n.title).toBe("R1 needs you to sign in to Claude");
    expect(n.why).toBe("R1 needs you to sign in to Claude.");
    expect(`${n.title} ${n.why}`).not.toMatch(/permission/i);
  });
});

describe("needs: rank", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1", "r2", "r-b", "r-rev"] });

  it("puts a decision first, then what is stuck, then drafts to approve", () => {
    const list = needs(
      input({
        workstreams: [{ ...escalated(), workstream: { ...escalated().workstream, id: "ws-3", itemKey: "CA-403", title: "CA-403 Third" } }, ws],
        proposals: [draft("old-draft", comment("CA-401"), 90), draft("rewrite", rewrite("CA-401"), 1)],
        runs: [run("r1", "investigate", "failed", { lastProgressAt: iso(80) })],
      }),
    );
    expect(list.map((n) => n.group)).toEqual(["decide", "decide", "unblock", "approve"]);
    expect(kinds(list)).toEqual(["escalation", "description", "failure", "draft"]);
    expect(GROUP_RANK).toEqual({ decide: 0, unblock: 1, approve: 2 });
  });

  it("is oldest first within a group, then by key", () => {
    const list = needs(
      input({
        workstreams: [view("ws-1", "CA-401", { heldReason: HELD_RESTART })],
        proposals: [draft("new", comment("CA-401"), 2), draft("old", comment("CA-401"), 40), draft("same-b", comment("CA-401"), 10), draft("same-a", comment("CA-401"), 10)],
        runs: [run("r1", "investigate", "failed", { lastProgressAt: iso(10) }), run("r2", "investigate", "needsAnswer", { lastProgressAt: iso(3) })],
        heldAt: { "ws-1": iso(5) },
      }),
    );
    expect(list.map((n) => n.key)).toEqual(["run:r1", "held:ws-1", "run:r2", "draft:old", "draft:same-a", "draft:same-b", "draft:new"]);
    expect(byRank({ group: "approve", at: iso(1), key: "a" }, { group: "decide", at: iso(99), key: "b" })).toBeGreaterThan(0);
  });

  it("counts a hold from when it was last held, and from its workstream's opening when that isn't known", () => {
    const held = view("ws-1", "CA-401", { heldReason: HELD_RESTART, createdAt: iso(300) });
    const run1 = run("r1", "investigate", "needsAnswer", { lastProgressAt: iso(100) });
    expect(kinds(needs(input({ workstreams: [held], runs: [run1], heldAt: { "ws-1": iso(5) } })))).toEqual(["question", "hold"]);
    expect(kinds(needs(input({ workstreams: [held], runs: [run1] })))).toEqual(["hold", "question"]);
  });
});

describe("needs: holds", () => {
  const held = (reason: string, over: { mode?: "manage" | "advise" } = {}): WorkstreamView => {
    const v = view("ws-1", "CA-401", { heldReason: reason });
    return { ...v, workstream: { ...v.workstream, mode: over.mode ?? "manage" } };
  };

  it("makes no need of a hold the person chose, Hold or Hold all, and counts nothing for it", () => {
    for (const reason of [HELD_PERSON, HELD_ALL]) expect(needs(input({ workstreams: [held(reason)] })), reason).toEqual([]);
    // Other needs in the workstream are untouched by it.
    const list = needs(input({ workstreams: [held(HELD_PERSON)], runs: [run("r1", "investigate", "failed")] }));
    expect(kinds(list)).toEqual(["failure"]);
  });

  it("keeps every hold the system makes a need: a restart, a tripwire, the daily cap and the quota", () => {
    for (const reason of [HELD_RESTART, HELD_DAILY, HELD_QUOTA, `${TRIPWIRE}basis_drift`, `${TRIPWIRE}marker`, `${TRIPWIRE}repeated_failure`, `${TRIPWIRE}chain_refused`]) {
      expect(kinds(needs(input({ workstreams: [held(reason)] }))), reason).toEqual(["hold"]);
    }
    expect(needs(input({ workstreams: [held(HELD_RESTART)] }))[0]).toMatchObject({ key: "held:ws-1", group: "unblock", title: "Held after a restart", primary: { id: "resume" } });
  });

  it("asks a Decide question when the automatic steps run out, with the two choices", () => {
    const list = needs(input({ workstreams: [{ ...held(HELD_BUDGET), budget: { autoTurns: { used: 11, limit: 11 }, wakes: { used: 11, limit: 12 }, level: "spent" } }] }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "budget:ws-1",
      group: "decide",
      kind: "budget",
      workstreamId: "ws-1",
      ticketKey: "CA-401",
      title: "CA-401 used its 11 automatic steps",
      why: "Pip and the automatic steps are paused until you decide.",
      primary: { id: "allowMore", label: "Allow 5 more" },
      secondary: [{ id: "advise", label: "Switch to Advise" }],
      target: { type: "workstream" },
      batchable: false,
    });
    expect(list[0].ifYouWait).toMatch(/\.$/);
  });

  it("names the count the person reads: whichever of turns and wakes is nearer its limit", () => {
    const wakes = needs(input({ workstreams: [{ ...held(HELD_BUDGET), budget: { autoTurns: { used: 3, limit: 11 }, wakes: { used: 12, limit: 12 }, level: "spent" } }] }));
    expect(wakes[0].title).toBe("CA-401 used its 11 automatic steps");
  });

  it("is answered once the workstream is in Advise, where nothing starts on its own", () => {
    expect(needs(input({ workstreams: [held(HELD_BUDGET, { mode: "advise" })] }))).toEqual([]);
  });

  it("ranks the question with the decisions, ahead of what is stuck", () => {
    const list = needs(input({ workstreams: [held(HELD_BUDGET)], runs: [run("r1", "investigate", "failed")] }));
    expect(kinds(list)).toEqual(["budget", "failure"]);
  });
});

describe("needs: a ticket the triage found not clear enough to plan", () => {
  const unclear = (questions: string[] = ["What does done look like?", "Who is waiting on it?"], over: Partial<WorkstreamView> = {}): WorkstreamView => ({
    ...view("ws-1", "CA-401", { runs: ["r-t"] }),
    readiness: { triageRun: "r-t", triageLabel: "R1", questions, at: iso(9) },
    ...over,
  });

  it("says the reporter was asked and nudged, and offers Ask again, once they have not answered", () => {
    const asked = { "ws-1": { asked: iso(2 * 24 * 60), nudged: iso(60) } };
    const [n] = needs(input({ workstreams: [unclear()], runs: [run("r-t", "triage", "done")], asked }));
    expect(n.why).toBe("You asked the reporter 2 days ago and nudged 1 hour ago; they have not answered. R1 left these questions open: What does done look like? · Who is waiting on it?");
    expect(n.primary).toEqual({ id: "askReporter", label: "Ask again" });
    expect(needs(input({ workstreams: [unclear()], runs: [run("r-t", "triage", "done")], asked: { "ws-1": { asked: iso(60), nudged: null } } }))[0].why).toMatch(/^You asked the reporter 1 hour ago; they have not answered\. /);
    // Without an ask, or once they replied, nothing is said about one.
    expect(needs(input({ workstreams: [unclear()], runs: [run("r-t", "triage", "done")] }))[0].primary.label).toBe("Ask the reporter");
    const replied = unclear(["Q?"], { readiness: { triageRun: "r-t", triageLabel: "R1", questions: ["Q?"], at: iso(9), changed: true, replied: true } });
    expect(needs(input({ workstreams: [replied], asked }))[0].why).not.toContain("You asked");
  });

  it("is a Decide question with the open questions as its reason and the three choices", () => {
    const list = needs(input({ workstreams: [unclear()], runs: [run("r-t", "triage", "done")] }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "readiness:r-t",
      group: "decide",
      kind: "readiness",
      workstreamId: "ws-1",
      ticketKey: "CA-401",
      title: "CA-401 isn't clear enough to plan",
      why: "R1 left these questions open: What does done look like? · Who is waiting on it?",
      at: iso(9),
      primary: { id: "askReporter", label: "Ask the reporter" },
      secondary: [
        { id: "answerSelf", label: "I'll answer" },
        { id: "planAnyway", label: "Plan anyway" },
      ],
      target: { type: "workstream" },
      batchable: false,
    });
    expect(list[0].ifYouWait).toMatch(/^No plan starts until you choose.*\.$/);
  });

  it("comes back as 'changed: plan now?' when the ticket changed while the person waited on the reporter, with Plan now and Still unclear", () => {
    const changed = unclear(["What does done look like?"], { readiness: { triageRun: "r-t", triageLabel: "R1", questions: ["What does done look like?"], at: iso(9), changed: true } });
    const [need] = needs(input({ workstreams: [changed], runs: [run("r-t", "triage", "done")] }));
    expect(need).toMatchObject({
      key: "readiness:r-t",
      group: "decide",
      kind: "readiness",
      title: "CA-401 changed: plan now?",
      why: "CA-401 changed while you waited for the reporter. R1 left this question open: What does done look like?",
      primary: { id: "planAnyway", label: "Plan now" },
      secondary: [{ id: "askReporter", label: "Still unclear (ask again)" }],
      batchable: false,
    });
  });

  it("comes back as '<KEY>: the reporter replied, plan now?' with the same choices when the reporter commented while the person waited", () => {
    const replied = unclear(["What does done look like?"], { readiness: { triageRun: "r-t", triageLabel: "R1", questions: ["What does done look like?"], at: iso(9), changed: true, replied: true } });
    const [need] = needs(input({ workstreams: [replied], runs: [run("r-t", "triage", "done")] }));
    expect(need).toMatchObject({
      key: "readiness:r-t",
      kind: "readiness",
      title: "CA-401: the reporter replied, plan now?",
      why: "The reporter replied on CA-401 while you waited. R1 left this question open: What does done look like?",
      primary: { id: "planAnyway", label: "Plan now" },
      secondary: [{ id: "askReporter", label: "Still unclear (ask again)" }],
    });
  });

  it("is counted once, ranks with the decisions ahead of what is stuck, and is not a run's need", () => {
    const list = needs(input({ workstreams: [unclear()], runs: [run("r-f", "build", "failed")] }));
    expect(kinds(list)).toEqual(["readiness", "failure"]);
    expect(list.every((n) => n.kind !== "readiness" || n.runId === undefined)).toBe(true);
  });

  it("is gone once the workstream no longer reports it: chosen, or a later triage says ready", () => {
    expect(needs(input({ workstreams: [unclear([], { readiness: null })] }))).toEqual([]);
    expect(needs(input({ workstreams: [{ ...view("ws-1", "CA-401") }] }))).toEqual([]);
  });

  it("says plainly when the triage listed no questions, says one question in the singular, and clips a long list", () => {
    expect(readinessWhy({ triageLabel: "R2", questions: [] })).toBe("R2 found the ticket unclear but listed no questions.");
    expect(readinessWhy({ triageLabel: "", questions: ["Who asked?"] })).toBe("The triage left this question open: Who asked?");
    const long = readinessWhy({ triageLabel: "R2", questions: Array.from({ length: 8 }, (_, n) => `Question number ${n + 1} is quite a long one to ask?`) });
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("…")).toBe(true);
  });

  it("quotes the questions for the composer on one line, with where to answer", () => {
    expect(readinessPrompt({ triageLabel: "R1", questions: ["What does done look like?", "Who asked?"] }, "CA-401")).toBe("R1's open questions about CA-401: “What does done look like?” · “Who asked?”. My answers: ");
    expect(readinessPrompt({ triageLabel: "", questions: [] }, null)).toBe("The triage's open questions about this ticket: “(it listed no questions)”. My answers: ");
  });
});

describe("needs: the comment to a reporter", () => {
  it("is Gossamr's draft to approve, said so, and not an agent's or a run's note", () => {
    const asked = draft("d-ask", comment("CA-401"), 3, { origin: { type: "run", runId: "r-t", shortId: null, workstream: "ws-1" } });
    const [need] = needs(input({ workstreams: [view("ws-1", "CA-401", { runs: ["r-t"] })], runs: [run("r-t", "triage", "done")], proposals: [{ ...asked, createdBy: "agent", label: "Questions for the reporter" }] }));
    expect(need).toMatchObject({
      key: "draft:d-ask",
      group: "approve",
      kind: "draft",
      title: "Questions for the reporter",
      why: "Gossamr drafted a comment to the reporter of CA-401 from R1's open questions; it is posted only when you approve it.",
      primary: { id: "approve" },
      // Gossamr's words to a person outside the team are read and approved on their own, never in "Approve N safe drafts".
      batchable: false,
    });
    // The triage's own note is the agent's, as before.
    const note = needs(input({ workstreams: [view("ws-1", "CA-401", { runs: ["r-t"] })], runs: [run("r-t", "triage", "done")], proposals: [{ ...asked, createdBy: "agent" }] }));
    expect(note[0]).toMatchObject({ title: "R1 triage · comment", why: "R1 triage drafted a comment on CA-401." });
  });
});

describe("needs: the comment with the person's answers", () => {
  it("is Pip's draft to approve on its own: said so, and never in the safe batch, as the questions to a reporter are not", () => {
    const answers = { ...draft("d-ans", comment("CA-401"), 3, { workstream: "ws-1" }), label: "Answers to the open questions" } as Proposal;
    const plain = draft("d-plain", comment("CA-401"), 2, { workstream: "ws-1" });
    const asked = { ...draft("d-ask", comment("CA-401"), 4, { workstream: "ws-1" }), createdBy: "user", label: "Questions for the reporter" } as Proposal;
    const list = needs(input({ workstreams: [view("ws-1", "CA-401")], proposals: [answers, plain, asked] }));
    const by = (key: string) => list.find((n) => n.key === key)!;
    expect(by("draft:d-ans")).toMatchObject({ title: "Answers to the open questions", why: "Pip drafted a comment on CA-401 with your answers to the open questions; it is posted only when you approve it.", batchable: false });
    expect(by("draft:d-ask")).toMatchObject({ title: "Questions for the reporter", why: "Gossamr drafted a comment to the reporter of CA-401 from what the ticket leaves out; it is posted only when you approve it.", batchable: false });
    expect(by("draft:d-plain").batchable).toBe(true);
    // A comment Pip merely labels like Gossamr's is Pip's, and an ordinary draft.
    const pretend = { ...draft("d-pip", comment("CA-401"), 1, { workstream: "ws-1" }), label: "Questions for the reporter" } as Proposal;
    expect(needs(input({ workstreams: [view("ws-1", "CA-401")], proposals: [pretend] }))[0]).toMatchObject({ batchable: true });
  });
});

describe("needs: folding", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1", "r-b", "r-rev"] });

  it("folds a runAnswer draft into its question: one need, which goes to the reply", () => {
    const asking = run("r1", "triage", "needsAnswer", { needs: "Which cache?" });
    const list = needs(input({ workstreams: [ws], runs: [asking], proposals: [draft("reply", answer("r1"), 3), draft("newer", answer("r1"), 1)] }));
    expect(list.map((n) => [n.key, n.kind, n.target])).toEqual([
      ["draft:reply", "question", { type: "draft", id: "reply" }],
      // A second answer for the same run is not folded: it is its own draft until the first is dealt with.
      ["draft:newer", "draft", { type: "draft", id: "newer" }],
    ]);
    expect(list[0].runId).toBe("r1");
    expect(list[0].title).toBe("R1 asks a question · Pip suggests a reply");
    expect(list[0].primary.id).toBe("approve");
    expect(needs(input({ workstreams: [ws], runs: [asking], proposals: [{ ...draft("reply", answer("r1"), 3), createdBy: "user" }] }))[0].title).toBe("R1 asks a question · a reply is drafted");
  });

  it("does not fold an answer for a run that isn't asking any more", () => {
    const list = needs(input({ workstreams: [ws], runs: [run("r1", "triage", "working")], proposals: [draft("reply", answer("r1"), 3)] }));
    expect(kinds(list)).toEqual(["draft"]);
  });

  it("folds an escalation's review draft into the escalation, so it is not listed twice", () => {
    const list = needs(input({ workstreams: [escalated({ reviewDraft: "rd" })], proposals: [draft("rd", review(), 5), draft("other", comment("CA-401"), 4)] }));
    expect(list.map((n) => n.key)).toEqual(["escalation:r-rev", "draft:other"]);
    // Without the escalation (chosen, or closed) the draft is an ordinary one.
    expect(needs(input({ workstreams: [{ ...escalated({ reviewDraft: "rd" }), escalation: undefined }], proposals: [draft("rd", review(), 5)] })).map((n) => n.key)).toEqual(["draft:rd"]);
  });

  it("never shows a retired, superseded, applied, skipped or applying draft", () => {
    const list = needs(
      input({
        workstreams: [ws],
        proposals: [
          draft("retired", comment("CA-401"), 5, { state: { type: "retired", reason: "out of date" } }),
          draft("superseded", comment("CA-401"), 5, { supersededBy: "newer" }),
          draft("applied", comment("CA-401"), 5, { state: { type: "applied" } }),
          draft("skipped", comment("CA-401"), 5, { state: { type: "skipped" } }),
          draft("applying", comment("CA-401"), 5, { state: { type: "applying" } }),
        ],
      }),
    );
    expect(list).toEqual([]);
  });

  it("leaves a closed workstream's waits to General", () => {
    const closed: WorkstreamView = { ...view("ws-9", "CA-409"), workstream: { ...view("ws-9", "CA-409").workstream, closedAt: iso(1), heldReason: HELD_PERSON } };
    const list = needs(input({ workstreams: [closed], proposals: [draft("d", comment("CA-409"), 5, { workstream: "ws-9" })] }));
    expect(list.map((n) => [n.key, n.workstreamId])).toEqual([["draft:d", null]]);
  });
});

describe("needs: failures persist until they are dealt with", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1"] });
  const failed = run("r1", "build", "failed", { error: "Launch was interrupted", endedAt: iso(20) });

  it("keeps a failure however often and however long it is looked at: only dismissing takes it out", () => {
    // Nothing in the input says a failure was seen, so reading the list again and again never drops it.
    for (let i = 0; i < 3; i++) expect(kinds(needs(input({ workstreams: [ws], runs: [failed] })))).toEqual(["failure"]);
    expect(kinds(needs(input({ workstreams: [ws], runs: [failed], dismissed: new Set(["r1"]) })))).toEqual([]);
    expect(kinds(needs(input({ workstreams: [ws], runs: [failed], dismissed: new Set(["other"]) })))).toEqual(["failure"]);
  });

  it("lets one go once the run is retried, which is no longer failed", () => {
    expect(needs(input({ workstreams: [ws], runs: [{ ...failed, state: "queued" }] }))).toEqual([]);
  });

  it("keeps a folder to trust as a failure, offering the step in Terminal and Dismiss", () => {
    const trust = run("r1", "build", "failed", { shortId: null, failure: { type: "untrustedFolder", path: "/Users/sample/Code/storefront" } });
    const [n] = needs(input({ workstreams: [ws], runs: [trust] }));
    expect(n).toMatchObject({ kind: "failure", title: "R1 needs its folder trusted", primary: { id: "open", label: "Trust this folder in Terminal" }, secondary: [{ id: "dismiss", label: "Dismiss" }] });
  });

  it("offers Retry for a launch that failed with no step to take, and Dismiss", () => {
    const [n] = needs(input({ workstreams: [ws], runs: [run("r1", "build", "failed", { shortId: null, error: "Launch was interrupted", failure: { type: "other" } })] }));
    expect(n.primary.id).toBe("retry");
    expect(n.secondary.map((a) => a.id)).toEqual(["dismiss"]);
  });
});

describe("needs: stopped at the limit, quiet, unknown and possible continuation", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1"] });
  const only = (r: Run, extra: Partial<NeedsInput> = {}) => needs(input({ workstreams: [ws], runs: [r], ...extra }));

  it("includes a run Gossamr stopped at its limit, with Resume, until it is resumed or dismissed", () => {
    const stopped = run("r1", "plan", "stopped", { stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit" });
    const [n] = only(stopped);
    expect(n).toMatchObject({ kind: "stoppedAtLimit", group: "unblock", primary: { id: "resume" }, secondary: [{ id: "dismiss" }] });
    expect(n.why).toBe("R1 was stopped at its limit: Stopped by Gossamr: it passed the 60 minute limit.");
    expect(only(stopped, { dismissed: new Set(["r1"]) })).toEqual([]);
    expect(only({ ...stopped, state: "working", stoppedByLimit: false })).toEqual([]);
  });

  it("includes a working run only once it has been quiet for 30 minutes, and not before", () => {
    expect(only(run("r1", "build", "working", { lastProgressAt: iso(29) }))).toEqual([]);
    const [n] = only(run("r1", "build", "working", { lastProgressAt: iso(30) }));
    expect(n).toMatchObject({ kind: "quiet", group: "unblock", at: iso(30) });
    expect(n.why).toBe("R1 has made no progress for 30 min.");
    // It leaves when the run moves, which a dismissal is not needed for.
    expect(only(run("r1", "build", "working", { lastProgressAt: iso(30) }), { now: NOW - 40 * 60_000 })).toEqual([]);
    expect(only(run("r1", "build", "working", { lastProgressAt: iso(30) }), { dismissed: new Set(["r1"]) })).toHaveLength(1);
  });

  it("lets the person keep waiting on a quiet run, for that quiet spell only", () => {
    const quiet = run("r1", "build", "working", { lastProgressAt: iso(30) });
    const [n] = only(quiet);
    expect(n.secondary).toEqual([{ id: "dismiss", label: "Keep waiting" }]);
    expect(only(quiet, { dismissed: new Set([quietKey(quiet)]) })).toEqual([]);
    // It made progress and went quiet again: a new spell, so the need is back.
    const again = { ...quiet, lastProgressAt: iso(35) };
    expect(only(again, { dismissed: new Set([quietKey(quiet)]) })).toHaveLength(1);
    // A failure of the same run after the dismissal still needs the person.
    const failed = { ...quiet, state: "failed" as const };
    expect(kinds(only(failed, { dismissed: new Set([quietKey(quiet)]) }))).toEqual(["failure"]);
  });

  it("includes an unclear run until it is dismissed or found again", () => {
    const unknown = run("r1", "build", "unknown");
    expect(kinds(only(unknown))).toEqual(["unknown"]);
    expect(only(unknown, { dismissed: new Set(["r1"]) })).toEqual([]);
    expect(only({ ...unknown, state: "working" })).toEqual([]);
  });

  it("includes a stopped run that may have carried on in another session, until dismissed or adopted", () => {
    const stopped = run("r1", "build", "stopped", { possibleContinuations: [{ shortId: "abc12345" }] });
    expect(kinds(only(stopped))).toEqual(["continuation"]);
    expect(only(stopped, { dismissed: new Set(["r1"]) })).toEqual([]);
    expect(only({ ...stopped, possibleContinuations: [] })).toEqual([]);
    // A limit stop that may also have carried on is one need, the limit.
    expect(kinds(only({ ...stopped, stoppedByLimit: true }))).toEqual(["stoppedAtLimit"]);
  });

  it("leaves out a run stopped by the person, a finished run and a queued one", () => {
    expect(only(run("r1", "build", "stopped"))).toEqual([]);
    expect(only(run("r1", "build", "done"))).toEqual([]);
    expect(only(run("r1", "build", "queued"))).toEqual([]);
    expect(only(run("r1", "build", "launching"))).toEqual([]);
  });
});

describe("needs: where a need is", () => {
  const ws1 = view("ws-1", "CA-401", { runs: ["own"] });

  it("puts a draft and a run in their workstream, and the rest in General", () => {
    const list = needs(
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
    expect(Object.fromEntries(list.map((n) => [n.key, n.workstreamId]))).toEqual({ "draft:made-in": "ws-3", "draft:on-ticket": "ws-1", "draft:closed-ws": null, "draft:elsewhere": null, "run:own": "ws-1", "run:loose": null });
    expect(needsIn(list, "ws-1")).toBe(2);
    expect(needsIn(list, "ws-3")).toBe(1);
    expect(needsIn(list, null)).toBe(3);
  });

  it("gives a ticket no cache holds the title its run or run draft kept in its snapshot, so every need reads KEY · Title", () => {
    expect(titleFromTicketBlock("SUP-9: Export timeout\nKind: task | Status: Open", "SUP-9")).toBe("Export timeout");
    expect(titleFromTicketBlock("SUP-90: Something else", "SUP-9")).toBeNull();
    expect(titleFromTicketBlock(null, "SUP-9")).toBeNull();
    const failed = run("f", "investigate", "failed", { item: ref("SUP-9"), spec: { ...base.spec, kind: "investigate", workstream: null, ticketBlock: "SUP-9: Export timeout\nDescription: none." } });
    const start = draft("s", { type: "startRun", item: ref("WEB-120"), spec: { ...base.spec, kind: "investigate", ticketBlock: "WEB-120: Login redirect" } } as unknown as Intent, 2);
    expect(needs(input({ runs: [failed], proposals: [start] })).map((n) => n.head)).toEqual(["SUP-9 · Export timeout", "WEB-120 · Login redirect"]);
    // A cached title still comes first.
    expect(needs(input({ runs: [failed], titleOf: (k) => (k === "SUP-9" ? "Export times out" : null) }))[0].head).toBe("SUP-9 · Export times out");
  });

  it("labels a draft a run left with the run and its step", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1", "r2"] });
    const fromRun = (id: string, runId: string, minutesAgo: number): Proposal => ({ ...draft(id, comment("CA-401"), minutesAgo), origin: { type: "run", runId, shortId: null, workstream: "ws-1" } }) as Proposal;
    expect(needs(input({ workstreams: [ws], proposals: [fromRun("c1", "r1", 5), fromRun("c2", "r2", 4), draft("c3", comment("CA-401"), 3, { workstream: "ws-1" })] })).map((n) => n.title)).toEqual(["R1 comment", "R2 comment", "Draft comment: “Looks good”"]);
    const runs = [run("r1", "review", "done"), run("r2", "plan", "done")];
    expect(needs(input({ workstreams: [ws], runs, proposals: [fromRun("c1", "r1", 5), fromRun("c2", "r2", 4), fromRun("c4", "gone", 3)] })).map((n) => n.title)).toEqual(["R1 review · comment", "R2 plan · comment", "Draft comment"]);
  });

  it("keeps the step in a run's draft title once its workstream is closed, and says a Pip comment's first words", () => {
    const fromRun = (id: string, runId: string): Proposal => ({ ...draft(id, comment("CA-401"), 5), origin: { type: "run", runId, shortId: null, workstream: null } }) as Proposal;
    const runs = [run("r9", "investigate", "done")];
    expect(needs(input({ runs, proposals: [fromRun("c1", "r9")] }))[0].title).toBe("Investigate · comment");
    // A Review run's GitHub review doesn't read "Review · review".
    const reviewed = { ...draft("g1", review(), 5), origin: { type: "run", runId: "r-rev", shortId: null, workstream: null } } as Proposal;
    expect(needs(input({ runs: [run("r-rev", "review", "done")], proposals: [reviewed] }))[0].title).toBe("Review · GitHub review");
    const long = { type: "comment", item: ref("CA-401"), body: docFromText("Thanks for the report, the export times out after ten rows."), mentions: [] } as unknown as Intent;
    expect(needs(input({ proposals: [draft("c2", long, 4)] }))[0].title).toBe("Draft comment: “Thanks for the report, the export…”");
    const secret = { ...long, body: docFromText(`ghp_${"a".repeat(36)} is the token`) } as unknown as Intent;
    const title = needs(input({ proposals: [draft("c3", secret, 3)] }))[0].title;
    expect(title).toContain("gh…");
    expect(title).not.toContain("ghp_");
  });

  it("labels a tripwire hold the short way, and a used-up budget as the question it is", () => {
    const list = needs(input({ workstreams: [view("ws-1", "CA-401", { heldReason: HELD_BUDGET }), view("ws-2", null, { heldReason: `${TRIPWIRE}repeated_failure` })] }));
    expect(list.map((n) => n.title).sort()).toEqual(["CA-401 used its 6 automatic steps", "Held: the same step failed twice"]);
  });

  it("words an escalation the way the list says it", () => {
    expect(escalationReason(2)).toBe("Review still blocks after 2 fix rounds");
    expect(escalationReason(1)).toBe("Review still blocks after 1 fix round");
  });
});

describe("needGroups", () => {
  const ws1 = view("ws-1", "CA-401", { runs: ["r1", "r2"], title: "CA-401 Welcome flow refresh" });
  const ws2 = view("ws-2", "CA-402", { runs: [], title: "CA-402 Cart merge" });
  const list = needs(
    input({
      workstreams: [ws1, ws2],
      proposals: [draft("c1", comment("CA-401"), 30), draft("c2", transition("CA-401"), 25), draft("c3", subtasks("CA-401"), 24), draft("rw", rewrite("CA-401"), 23), draft("g1", comment("CA-500"), 10), draft("o1", comment("CA-402"), 9)],
      runs: [run("r1", "build", "needsPermission", { needs: "approve Bash: git push", lastProgressAt: iso(8) }), run("r2", "build", "failed", { lastProgressAt: iso(2) })],
    }),
  );

  it("makes one group per workstream, plus General, ordered by the rank of each one's top need", () => {
    const groups = needGroups(list);
    expect(groups.map((g) => [g.workstreamId, g.title, g.ticketKey])).toEqual([
      ["ws-1", "Welcome flow refresh", "CA-401"],
      // General's draft is older than CA-402's, and both are drafts to approve.
      [null, "General", null],
      ["ws-2", "Cart merge", "CA-402"],
    ]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(list.length);
  });

  it("has the highest-ranked need on top and the rest in order behind it, counted", () => {
    const [g] = needGroups(list);
    // The rewrite is a decision, so it outranks the permission and the failure.
    expect(g.top.key).toBe("draft:rw");
    expect(g.rest.map((n) => n.key)).toEqual(["run:r1", "run:r2", "draft:c1", "draft:c2", "draft:c3"]);
    expect(g.count).toBe(6);
    expect(g.rest).not.toContain(g.top);
  });

  it("offers the batchable pending drafts as the safe batch: comments, moves and subtasks, never a rewrite, a run or a review", () => {
    const [g] = needGroups(list);
    expect(g.safeBatch.map((n) => n.key)).toEqual(["draft:c1", "draft:c2", "draft:c3"]);
    expect([...BATCHABLE].sort()).toEqual(["comment", "subtasks", "transition"]);
    const others = needs(input({ workstreams: [ws1], proposals: [draft("a", startRun("CA-401", "build", "ws-1"), 5), draft("b", review(), 4), draft("c", rewrite("CA-401"), 3)] }));
    expect(needGroups(others)[0].safeBatch).toEqual([]);
    expect(others.every((n) => !n.batchable)).toBe(true);
    expect(list.filter((n) => n.batchable).map((n) => n.key).sort()).toEqual(["draft:c1", "draft:c2", "draft:c3", "draft:g1", "draft:o1"]);
  });

  it("leaves a comment with the text of an earlier one on its ticket out of the safe batch", () => {
    const said = (key: string, text: string): Intent => ({ type: "comment", item: ref(key), body: { blocks: [{ type: "paragraph", content: [{ type: "text", text, marks: [] }] }] }, mentions: [] }) as unknown as Intent;
    const [g] = needGroups(needs(input({ workstreams: [ws1], proposals: [draft("a", said("CA-401", "All good."), 9), draft("b", said("CA-401", "all  good."), 8), draft("c", said("CA-401", "Also this."), 7)] })));
    expect(g.safeBatch.map((n) => n.key)).toEqual(["draft:a", "draft:c"]);
    expect(g.count).toBe(3);
  });

  it("gives General a group of its own with each need's ticket in its head", () => {
    const general = needGroups(list).find((g) => g.workstreamId === null)!;
    expect(general.top.head).toBe("CA-500");
    expect(general.count).toBe(1);
    expect(general.safeBatch.map((n) => n.key)).toEqual(["draft:g1"]);
  });

  it("is empty with nothing waiting", () => {
    expect(needGroups([])).toEqual([]);
  });
});

describe("needAfter", () => {
  const key = (k: string) => ({ key: k });
  it("goes to the need that followed the one dealt with, else the top one left, else the first", () => {
    const before = ["a", "b", "c", "d"];
    expect(needAfter(before, "b", [key("a"), key("c"), key("d")])?.key).toBe("c");
    expect(needAfter(before, "d", [key("a"), key("b"), key("c")])?.key).toBe("a");
    expect(needAfter(before, "b", [key("c"), key("a")])?.key).toBe("c");
    expect(needAfter(before, "x", [key("z"), key("a")])?.key).toBe("z");
    expect(needAfter(before, "a", [])).toBeNull();
  });
});

describe("higherPriority", () => {
  const n = (key: string, group: Need["group"], at = "2026-10-01T10:00:00Z") => ({ key, group, at });
  const list = [n("e", "decide", "2026-10-01T09:00:00Z"), n("p", "unblock", "2026-10-01T09:30:00Z"), n("open", "unblock", "2026-10-01T10:00:00Z"), n("d", "approve")];

  it("names a Decide or Unblock that ranks above the open need and came in after it was opened", () => {
    expect(higherPriority(list, "open", new Set(["open", "d"]))?.key).toBe("e");
    expect(higherPriority(list, "open", new Set(["open", "d", "e"]))?.key).toBe("p");
  });

  it("says nothing for one that was already there, one that ranks below, or an Approve", () => {
    expect(higherPriority(list, "open", new Set(["e", "p", "open", "d"]))).toBeNull();
    expect(higherPriority(list, "e", new Set(["e"]))).toBeNull();
    expect(higherPriority([n("a", "approve", "2026-10-01T08:00:00Z"), n("open", "approve")], "open", new Set(["open"]))).toBeNull();
    expect(higherPriority(list, "gone", new Set())).toBeNull();
  });
});

describe("review nits", () => {
  const why = (kind: RunKind) => needs(input({ workstreams: [view("ws-1", "CA-401")], proposals: [draft("d", startRun("CA-401", kind, "ws-1"), 5)] })).find((n) => n.kind === "runStart")?.why;

  it("says \"an\" before a kind that starts with a vowel", () => {
    expect(why("investigate")).toContain("drafted an Investigate agent for CA-401");
    expect(why("build")).toContain("drafted a Build agent for CA-401");
  });

  it("ranks a failed run by when it ended, not by its last progress", () => {
    const list = needs(
      input({
        workstreams: [view("ws-1", "CA-401")],
        runs: [run("r-a", "build", "failed", { lastProgressAt: iso(1), endedAt: iso(50) }), run("r-b", "build", "failed", { lastProgressAt: iso(60), endedAt: iso(10) })],
      }),
    );
    expect(list.map((n) => n.key)).toEqual(["run:r-a", "run:r-b"]);
  });
});

describe("repeatedComments", () => {
  const said = (key: string, text: string): Intent => ({ type: "comment", item: ref(key), body: docFromText(text), mentions: [] }) as unknown as Intent;

  it("leaves a superseded pending comment out of what counts as seen, so its visible replacement still batches", () => {
    const old = draft("old", said("CA-401", "Checking in"), 9, { supersededBy: "new" });
    const next = draft("new", said("CA-401", "Checking in"), 5);
    expect(repeatedComments([old, next])).toEqual([]);
    const copy = draft("copy", said("CA-401", "checking  in"), 3);
    expect(repeatedComments([old, next, copy]).map((p) => p.id)).toEqual(["copy"]);
  });
});

describe("leftOutLabel", () => {
  const said = (text: string) => draft("c", { type: "comment", item: ref("CA-401"), body: docFromText(text), mentions: [] } as unknown as Intent, 5);

  it("quotes the first 40 characters of the comment after its title, with an ellipsis only when cut", () => {
    expect(leftOutLabel(said("Is it still on track?"), "Comment on CA-401")).toBe("Comment on CA-401 “Is it still on track?”");
    expect(leftOutLabel(said("a".repeat(40)), "T")).toBe(`T “${"a".repeat(40)}”`);
    expect(leftOutLabel(said(`${"word ".repeat(10)}end`), "T")).toBe(`T “${"word ".repeat(8).trimEnd()}…”`);
  });

  it("is the title alone for a draft with no comment text", () => {
    expect(leftOutLabel(draft("t", transition("CA-401"), 5), "Move CA-401")).toBe("Move CA-401");
  });
});

describe("the chip on a row (G6)", () => {
  it("is Post for a GitHub review draft and the group's word for every other need, the group staying Approve", () => {
    expect(chipLabel({ group: "approve", kind: "review" })).toBe("Post");
    expect(chipLabel({ group: "approve", kind: "draft" })).toBe("Approve");
    expect(chipLabel({ group: "decide", kind: "readiness" })).toBe("Decide");
    const list = needs(input({ proposals: [draft("d-review", review(), 26)] }));
    expect(list[0]).toMatchObject({ kind: "review", group: "approve" });
    expect(chipLabel(list[0])).toBe("Post");
  });

  it("is the verb of the need's main button in Approve, so the tag and the button agree (G34)", () => {
    expect(chipLabel({ group: "approve", kind: "runStart" })).toBe("Review");
    const start = needs(input({ proposals: [draft("d-start", startRun("CA-401", "investigate", "ws-1"), 5)] })).find((n) => n.kind === "runStart")!;
    expect(start.primary.label).toBe("Review and start");
    expect(chipLabel(start)).toBe("Review");
    expect(chipLabel({ group: "approve", kind: "draft", primary: { label: "Send answer" } })).toBe("Send");
    expect(chipLabel({ group: "approve", kind: "draft", primary: { label: "Approve" } })).toBe("Approve");
    expect(chipLabel({ group: "unblock", kind: "question", primary: { label: "Send answer" } })).toBe("Unblock");
  });

  it("is Post for a comment draft, whose button says Post comment (G25)", () => {
    const list = needs(input({ proposals: [draft("d-comment", comment("CA-401"), 5)] }));
    const need = list.find((n) => n.kind === "draft")!;
    expect(need.primary.label).toBe("Post comment");
    expect(chipLabel(need)).toBe("Post");
    expect(need.group).toBe("approve");
  });
});
