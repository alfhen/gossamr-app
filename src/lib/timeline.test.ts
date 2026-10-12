import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Intent, ItemRef, Proposal, ProposalState, Run, RunKind, RunState, WorkstreamActor, WorkstreamEvent, WorkstreamView } from "../types";
import { needs, type Need } from "./needs";
import { EMPTY_FILTER, FILTER_LABEL, SCOPE_LABEL, TIMELINE_FILTERS, TIMELINE_SCOPES, draftSentence, everyWorkstreamParts, isAgentsView, timelineAcross, workstreamLabel, filterCounts, filterTimeline, runLifecycle, runPhase, runSentence, shows, timeline, type TimelineEntry, type TimelineTurn } from "./timeline";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });

const base = new MockBackend().runs.list()[0];
const run = (id: string, kind: RunKind, state: RunState, queuedAgo: number, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  state,
  item: ref("CA-401"),
  spec: { ...base.spec, kind, workstream: "ws-1" },
  failure: null,
  needs: null,
  error: null,
  autoStart: null,
  stoppedByLimit: false,
  queuedAt: iso(queuedAgo),
  launchedAt: state === "queued" ? null : iso(queuedAgo - 1),
  lastProgressAt: iso(Math.max(0, queuedAgo - 5)),
  endedAt: ["done", "failed", "stopped"].includes(state) ? iso(Math.max(0, queuedAgo - 10)) : null,
  ...over,
});

const draft = (id: string, intent: Intent, minutesAgo: number, over: { state?: ProposalState; origin?: Proposal["origin"]; createdBy?: Proposal["createdBy"]; updatedAgo?: number; supersededBy?: string } = {}): Proposal =>
  ({
    id,
    createdAt: iso(minutesAgo),
    updatedAt: iso(over.updatedAgo ?? minutesAgo),
    origin: over.origin ?? { type: "run", runId: "r1", shortId: null, workstream: "ws-1" },
    createdBy: over.createdBy ?? "agent",
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

const comment = (key: string): Intent => ({ type: "comment", item: ref(key), body: "Looks good", mentions: [] }) as unknown as Intent;
const transition = (key: string): Intent => ({ type: "transition", item: ref(key), to: "done" }) as unknown as Intent;
const answer = (runId: string): Intent => ({ type: "runAnswer", item: ref("CA-401"), runId, message: "Yes", question: "q" }) as unknown as Intent;

let seq = 0;
beforeEach(() => {
  seq = 0;
});
const line = (action: string, minutesAgo: number, over: { actor?: WorkstreamActor; runId?: string | null; proposalId?: string | null; detail?: string | null; workstreamId?: string } = {}): WorkstreamEvent => ({
  workstreamId: over.workstreamId ?? "ws-1",
  seq: seq++,
  at: iso(minutesAgo),
  actor: over.actor ?? "person",
  action,
  runId: over.runId ?? null,
  proposalId: over.proposalId ?? null,
  digest: null,
  detail: over.detail ?? null,
});

const turn = (id: string, minutesAgo: number | null, over: Partial<TimelineTurn> = {}): TimelineTurn => ({
  requestId: id,
  ...(minutesAgo === null ? {} : { at: iso(minutesAgo) }),
  prompt: `question ${id}`,
  text: `answer ${id}`,
  status: "done",
  ...over,
});

const keys = (list: readonly TimelineEntry[]) => list.map((e) => e.key);
const labels = new Map([
  ["r1", "R1"],
  ["r2", "R2"],
  ["r3", "R3"],
]);

const view = (over: { heldReason?: string | null } = {}): WorkstreamView => ({
  workstream: {
    id: "ws-1",
    connectionId: "mock",
    itemKey: "CA-401",
    repo: null,
    title: "CA-401 Rounding",
    pipSession: null,
    mode: "manage",
    heldReason: over.heldReason ?? null,
    notes: null,
    createdAt: iso(600),
    closedAt: null,
    budget: { autoTurns: null, wakes: null, tokens: null },
    spent: { autoTurns: 0, wakes: 0, tokens: 0 },
    rules: {},
    basis: null,
  },
  stage: "build",
  runs: ["r1", "r2"],
  labels: [
    ["r1", "R1"],
    ["r2", "R2"],
  ],
  waitingForPr: null,
  budget: { autoTurns: { used: 0, limit: 11 }, wakes: { used: 0, limit: 12 }, level: "ok" },
});

describe("timeline: one list, oldest first", () => {
  it("merges the conversation, the runs, the drafts and the audit into one chronological story", () => {
    const list = timeline({
      turns: [turn("q1", 100), turn("q2", 30)],
      runs: [run("r1", "investigate", "done", 90), run("r2", "build", "working", 20)],
      drafts: [draft("d1", comment("CA-401"), 70, { state: { type: "applied" }, updatedAgo: 60 })],
      events: [line("mode_set", 95, { detail: "manage" }), line("draft_approved", 60, { proposalId: "d1" })],
      labels,
      ticketKey: "CA-401",
    });
    expect(keys(list)).toEqual(["turn:q1", "audit:ws-1:0", "run:r1", "draft:d1", "audit:ws-1:1", "turn:q2", "run:r2"]);
    expect(list.map((e) => e.text)).toEqual([
      "You: question q1",
      "You let Pip manage the workstream",
      "Investigate R1 finished",
      "You approved a comment on CA-401, drafted by an agent: posted",
      "You approved a comment on CA-401",
      "You: question q2",
      "Build R2 started",
    ]);
  });

  it("gives every entry a stable key, a kind, a time, a ticket and a sentence", () => {
    const input = { turns: [turn("q1", 10)], runs: [run("r1", "plan", "queued", 5)], drafts: [draft("d1", transition("CA-401"), 3)], events: [line("held", 2)], ticketKey: "CA-401" };
    const a = timeline(input);
    const b = timeline(input);
    expect(keys(a)).toEqual(keys(b));
    expect(new Set(keys(a)).size).toBe(a.length);
    for (const e of a) {
      expect(e.kind).toMatch(/^(said|pip|run|draft|audit)$/);
      expect(Number.isFinite(Date.parse(e.at))).toBe(true);
      expect(e.ticketKey).toBe("CA-401");
      expect(e.text.length).toBeGreaterThan(0);
      expect(e.text).not.toMatch(/\n/);
    }
  });

  it("keeps the same order whatever order the sources come in", () => {
    const runs = [run("r1", "investigate", "done", 90), run("r2", "build", "working", 20), run("r3", "review", "queued", 10)];
    const drafts = [draft("d1", comment("CA-401"), 50), draft("d2", transition("CA-401"), 15)];
    const forward = timeline({ runs, drafts, labels });
    const backward = timeline({ runs: [...runs].reverse(), drafts: [...drafts].reverse(), labels });
    expect(keys(backward)).toEqual(keys(forward));
    expect(keys(forward)).toEqual(["run:r1", "draft:d1", "run:r2", "draft:d2", "run:r3"]);
  });

  it("breaks a tie in time by source: what was said, the audit, then runs, then drafts", () => {
    const list = timeline({ turns: [turn("q1", 10)], runs: [run("r1", "plan", "queued", 10)], drafts: [draft("d1", comment("CA-401"), 10)], events: [line("held", 10)] });
    expect(list.map((e) => e.kind)).toEqual(["said", "audit", "run", "draft"]);
  });

  it("stands a turn with no time where the turn before it does, and keeps the conversation's own order", () => {
    const list = timeline({ turns: [turn("q1", 50), turn("q2", null), turn("q3", 5)], runs: [run("r1", "plan", "queued", 30)] });
    expect(keys(list)).toEqual(["turn:q1", "turn:q2", "run:r1", "turn:q3"]);
    expect(list[1].at).toBe(list[0].at);
  });

  it("takes the next turn's time for a first turn with none, and sorts first when no turn has one", () => {
    expect(timeline({ turns: [turn("q1", null), turn("q2", 5)] })[0].at).toBe(iso(5));
    const list = timeline({ turns: [turn("q1", null)], runs: [run("r1", "plan", "queued", 30)] });
    expect(keys(list)).toEqual(["turn:q1", "run:r1"]);
  });

  it("is empty for nothing, and tells Pip's own turns from the person's", () => {
    expect(timeline({})).toEqual([]);
    const list = timeline({ turns: [turn("q1", 10), turn("w1", 5, { kind: "wake", prompt: "[Event] run r1 (plan) Done", text: "R1 finished.\nMore detail." }), turn("w2", 4, { kind: "wake", text: "" })] });
    expect(list.map((e) => [e.kind, e.text])).toEqual([
      ["said", "You: question q1"],
      ["pip", "Pip: R1 finished."],
      ["pip", "Pip picked this up"],
    ]);
    expect(list.every((e) => e.target === null && e.turnId)).toBe(true);
  });

  it("says what the person wrote as the bubble shows it", () => {
    expect(timeline({ turns: [turn("q1", 1, { prompt: "a long instruction for Pip", shown: "Plan this" })] })[0].text).toBe("You: Plan this");
  });
});

describe("timeline: a run is one entry, updated in place", () => {
  it("is one entry however far the run has got, at when it was queued", () => {
    for (const state of ["queued", "launching", "working", "needsAnswer", "done", "failed", "stopped"] as RunState[]) {
      const list = timeline({ runs: [run("r1", "build", state, 40)], labels });
      expect(list).toHaveLength(1);
      expect(list[0].key).toBe("run:r1");
      expect(list[0].at).toBe(iso(40));
    }
  });

  it("keeps its place and key as it moves on, and says where it is now", () => {
    const queued = timeline({ runs: [run("r1", "build", "queued", 40)], labels })[0];
    const done = timeline({ runs: [run("r1", "build", "done", 40)], labels })[0];
    expect(done.key).toBe(queued.key);
    expect(done.at).toBe(queued.at);
    expect(queued.text).toBe("Build R1 queued");
    expect(done.text).toBe("Build R1 finished");
    expect(done.updatedAt).toBe(iso(30));
  });

  it("stands where the audit says it was approved or started by a rule, else where it was queued", () => {
    const list = timeline({
      turns: [turn("q1", 50)],
      runs: [run("r1", "plan", "working", 10), run("r2", "build", "queued", 5), run("r3", "review", "queued", 60)],
      events: [line("run_approved", 55, { runId: "r1" }), line("autostart", 45, { runId: "r2", actor: "supervisor", detail: "plan_build after r1" }), line("run_approved", 40, { runId: "r2" })],
    });
    expect(keys(list)).toEqual(["run:r3", "run:r1", "turn:q1", "run:r2"]);
    expect(list.find((e) => e.key === "run:r2")!.at).toBe(iso(45));
  });

  it("records each step of its life: queued, started and how it ended", () => {
    expect(runLifecycle(run("r1", "build", "queued", 40)).map((s) => s.phase)).toEqual(["queued"]);
    expect(runLifecycle(run("r1", "build", "working", 40)).map((s) => s.phase)).toEqual(["queued", "started"]);
    expect(runLifecycle(run("r1", "build", "needsPermission", 40)).map((s) => s.phase)).toEqual(["queued", "started", "waiting"]);
    expect(runLifecycle(run("r1", "build", "done", 40))).toEqual([
      { phase: "queued", at: iso(40) },
      { phase: "started", at: iso(39) },
      { phase: "finished", at: iso(30) },
    ]);
    expect(runLifecycle(run("r1", "build", "failed", 40, { launchedAt: null })).map((s) => s.phase)).toEqual(["queued", "failed"]);
  });

  it("names each phase", () => {
    const cases: [RunState, Partial<Run>, string][] = [
      ["queued", {}, "queued"],
      ["launching", {}, "started"],
      ["working", {}, "started"],
      ["needsAnswer", {}, "waiting"],
      ["needsPermission", {}, "waiting"],
      ["systemBlocked", {}, "waiting"],
      ["done", {}, "finished"],
      ["failed", {}, "failed"],
      ["stopped", {}, "stopped"],
      ["stopped", { stoppedByLimit: true }, "limit"],
      ["unknown", {}, "unknown"],
    ];
    for (const [state, over, phase] of cases) expect(runPhase({ state, stoppedByLimit: over.stoppedByLimit })).toBe(phase);
  });

  it("says each phase in a plain sentence, with a finished review's verdict", () => {
    expect(runSentence(run("r1", "plan", "queued", 5, { autoStart: { rule: "triage_plan", afterRun: "r0" } }), "R1", undefined)).toBe("Plan R1 queued automatically");
    expect(runSentence(run("r1", "plan", "needsAnswer", 5), "R1", undefined)).toBe("Plan R1 is waiting on you: it asks a question");
    expect(runSentence(run("r1", "build", "needsPermission", 5), "R1", undefined)).toBe("Build R1 is waiting on you: it needs permission");
    expect(runSentence(run("r1", "build", "systemBlocked", 5), "R1", undefined)).toBe("Build R1 is waiting on you: sign in to Claude");
    expect(runSentence(run("r3", "review", "done", 5), "R3", "pass")).toBe("Review R3 finished: the review passes");
    expect(runSentence(run("r3", "review", "done", 5), "R3", "blocking")).toBe("Review R3 finished: changes needed");
    expect(runSentence(run("r3", "review", "done", 5), "R3", null)).toBe("Review R3 finished");
    expect(runSentence(run("r1", "build", "failed", 5, { error: "Folder not trusted\nstack…" }), "R1", undefined)).toBe("Build R1 failed: Folder not trusted");
    expect(runSentence(run("r1", "build", "failed", 5), undefined, undefined)).toBe("Build failed");
    expect(runSentence(run("r1", "build", "stopped", 5), "R1", undefined)).toBe("Build R1 was stopped");
    expect(runSentence(run("r1", "build", "stopped", 5, { stoppedByLimit: true }), "R1", undefined)).toBe("Build R1 stopped at its limit");
    expect(runSentence(run("r1", "build", "unknown", 5), "R1", undefined)).toMatch(/^Build R1: /);
  });

  it("takes the verdict from the verdicts it is given", () => {
    const list = timeline({ runs: [run("r3", "review", "done", 5)], labels, verdicts: { r3: "blocking" } });
    expect(list[0].text).toBe("Review R3 finished: changes needed");
  });

  it("opens the run's sheet, or its need while it waits on the person", () => {
    const working = timeline({ runs: [run("r1", "build", "working", 5)] })[0];
    expect(working.target).toEqual({ type: "run", id: "r1" });
    expect(working.needKey).toBeNull();
    expect(working.decision).toBe(false);
    const asking = run("r2", "build", "needsPermission", 5, { needs: "git push origin ca-401" });
    const need = needs({ workstreams: [view()], runs: [asking], proposals: [], dismissed: new Set(), now: NOW })[0];
    const entry = timeline({ runs: [asking], needs: [need] })[0];
    expect(entry.target).toEqual({ type: "need", key: need.key });
    expect(entry.needKey).toBe(need.key);
    expect(entry.decision).toBe(true);
  });

  it("uses the run's own ticket, else the workstream's", () => {
    expect(timeline({ runs: [run("r1", "build", "working", 5, { item: ref("CA-999") })], ticketKey: "CA-401" })[0].ticketKey).toBe("CA-999");
    expect(timeline({ runs: [run("r1", "build", "working", 5, { item: null })], ticketKey: "CA-401" })[0].ticketKey).toBe("CA-401");
  });
});

describe("timeline: drafts", () => {
  it("is one entry per draft, at when it was made, saying who made what and how it stands", () => {
    const list = timeline({
      drafts: [
        draft("d1", comment("CA-401"), 50, { createdBy: "pip" }),
        draft("d2", transition("CA-401"), 40, { state: { type: "skipped" }, updatedAgo: 20 }),
        draft("d3", comment("CA-401"), 30, { state: { type: "retired", reason: "newer" }, supersededBy: "d4" }),
        draft("d4", comment("CA-401"), 25, { state: { type: "applying" } }),
      ],
    });
    expect(list.map((e) => e.text)).toEqual([
      "Pip drafted a comment on CA-401",
      "An agent drafted a move on CA-401: skipped",
      "An agent drafted a comment on CA-401: replaced by a newer draft",
      "An agent drafted a comment on CA-401: posting",
    ]);
    expect(list[1].updatedAt).toBe(iso(20));
    expect(list.map((e) => e.draftState)).toEqual(["pending", "skipped", "retired", "applying"]);
  });

  it("says a run draft was started and an answer sent", () => {
    expect(draftSentence(draft("d1", answer("r1"), 5, { state: { type: "applied" } }))).toBe("You approved an answer on CA-401, drafted by an agent: sent");
    const start = { type: "startRun", item: ref("CA-401"), spec: { ...base.spec } } as unknown as Intent;
    expect(draftSentence(draft("d2", start, 5, { createdBy: "pip", state: { type: "applied" } }))).toBe("You started the investigate run Pip drafted on CA-401");
    expect(draftSentence(draft("d3", comment("CA-401"), 5, { state: { type: "retired", reason: "gone" } }))).toBe("An agent drafted a comment on CA-401: no longer needed");
  });

  it("says who posted a GitHub review, to which pull request, with how many comments and whether it was edited", () => {
    const review = (n: number) => ({ type: "githubReview", connectionId: "gh", item: ref("CA-402"), runId: "r1", repo: "hobbii/cart", number: 17, commitSha: "abc", summary: "s", comments: Array.from({ length: n }, (_, i) => ({ path: "a.ts", line: i + 1, side: "RIGHT", body: "x" })) }) as unknown as Intent;
    expect(draftSentence(draft("d1", review(2), 5, { state: { type: "applied" } }))).toBe("You posted an agent's GitHub review on hobbii/cart#17: 2 inline comments");
    expect(draftSentence(draft("d2", review(1), 5, { createdBy: "autopilot", state: { type: "applied" } }))).toBe("You posted Gossamr's GitHub review on hobbii/cart#17: 1 inline comment");
    const edited = { ...draft("d3", review(3), 5, { createdBy: "pip", state: { type: "applied" } }), revisions: [{}] } as unknown as Proposal;
    expect(draftSentence(edited)).toBe("You posted Pip's GitHub review on hobbii/cart#17: 3 inline comments, edited by you");
  });

  it("knows the question a chat draft answered, so its card can stay with the answer", () => {
    const e = timeline({ drafts: [draft("d1", comment("CA-401"), 5, { origin: { type: "chat", requestId: "q1", workstream: "ws-1" } })] })[0];
    expect(e.turnId).toBe("q1");
    expect(timeline({ drafts: [draft("d2", comment("CA-401"), 5)] })[0].turnId).toBeUndefined();
  });

  it("says Gossamr drafted the comment to a reporter, and still an agent for the triage's own note", () => {
    const asked = { ...draft("d1", comment("CA-401"), 5), label: "Questions for the reporter" } as Proposal;
    expect(timeline({ drafts: [asked] })[0].text).toBe("Gossamr drafted a comment on CA-401");
    expect(timeline({ drafts: [{ ...asked, state: { type: "applied" } } as Proposal] })[0].text).toBe("You approved a comment on CA-401, drafted by Gossamr: posted");
    expect(timeline({ drafts: [draft("d2", comment("CA-401"), 5)] })[0].text).toBe("An agent drafted a comment on CA-401");
  });

  it("opens the draft's card, or its need while it waits", () => {
    const pending = draft("d1", comment("CA-401"), 5);
    const need = needs({ workstreams: [view()], runs: [], proposals: [pending], dismissed: new Set(), now: NOW }).find((n) => n.key === "draft:d1")!;
    expect(need).toBeDefined();
    const linked = timeline({ drafts: [pending], needs: [need] })[0];
    expect(linked.target).toEqual({ type: "need", key: "draft:d1" });
    expect(linked.decision).toBe(true);
    const done = timeline({ drafts: [draft("d2", comment("CA-401"), 5, { state: { type: "applied" } })], needs: [need] })[0];
    expect(done.target).toEqual({ type: "draft", id: "d2" });
    expect(done.needKey).toBeNull();
  });
});

describe("timeline: the audit", () => {
  it("leaves out what a run's or a draft's own entry already tells", () => {
    const list = timeline({
      runs: [run("r1", "build", "working", 30)],
      drafts: [draft("d1", comment("CA-401"), 20)],
      events: [line("run_approved", 30, { runId: "r1" }), line("autostart", 30, { runId: "r1", actor: "supervisor", detail: "plan_build after r0" }), line("wake", 25, { actor: "supervisor", runId: "r1" }), line("draft_created", 20, { proposalId: "d1", actor: "run" }), line("notes_set", 19, { actor: "pip" })],
      labels,
    });
    expect(list.map((e) => e.kind)).toEqual(["run", "draft"]);
  });

  it("keeps holds, mode switches, escalations, undos and what the person did to runs and drafts", () => {
    const list = timeline({
      runs: [run("r1", "build", "done", 90), run("r2", "review", "done", 80)],
      drafts: [draft("d1", comment("CA-401"), 70, { state: { type: "pending" } })],
      events: [
        line("held", 60),
        line("undone", 59, { detail: "held" }),
        line("mode_set", 58, { detail: "advise" }),
        line("fix_rounds_exhausted", 57, { actor: "supervisor", runId: "r2", detail: "2" }),
        line("draft_skipped", 56, { proposalId: "d1" }),
        line("undone", 55, { proposalId: "d1", detail: "draft_skipped" }),
        line("run_stopped", 54, { runId: "r1" }),
        line("run_retried", 53, { runId: "r1" }),
      ],
      labels,
    });
    expect(list.filter((e) => e.kind === "audit").map((e) => e.text)).toEqual([
      "You held the workstream",
      "You undid holding the workstream",
      "You stopped Pip managing the workstream",
      "The review still blocks after 2 fix rounds",
      "You skipped a comment on CA-401",
      "You brought back a comment on CA-401",
      "You stopped R1",
      "You retried R1",
    ]);
  });

  it("collapses the same line again and again into one that says how many", () => {
    const list = timeline({ events: [line("rule_set", 10), line("rule_set", 9), line("rule_set", 8), line("held", 7), line("rule_set", 6)] });
    expect(list.map((e) => e.text)).toEqual(["You changed an automatic step (3 times)", "You held the workstream", "You changed an automatic step"]);
    expect(list[0].count).toBe(3);
    expect(list[0].at).toBe(iso(10));
    expect(list[0].updatedAt).toBe(iso(8));
  });

  it("marks what the person did and what asks them to decide as decisions, and not the rest", () => {
    const list = timeline({ events: [line("held", 10, { actor: "supervisor" }), line("waiting_for_pr", 9, { actor: "supervisor", runId: "r1" }), line("budget_reset", 8), line("fix_rounds_exhausted", 7, { actor: "supervisor", detail: "2" })] });
    expect(list.map((e) => [e.action, e.decision])).toEqual([
      ["held", true],
      ["waiting_for_pr", false],
      ["budget_reset", true],
      ["fix_rounds_exhausted", true],
    ]);
  });

  it("leaves opening and closing the workstream and the notes out of the decisions", () => {
    const list = timeline({ events: [line("opened", 10), line("notes_set", 9), line("closed", 8), line("mode_set", 7, { detail: "manage" })] });
    expect(list.map((e) => [e.action, e.decision])).toEqual([
      ["opened", false],
      ["closed", false],
      ["mode_set", true],
    ]);
  });

  it("links the hold that still holds and the open escalation to their needs", () => {
    const held = view({ heldReason: "restart" });
    const all = needs({ workstreams: [held], runs: [], proposals: [], dismissed: new Set(), now: NOW, heldAt: { "ws-1": iso(5) } });
    const hold = all.find((n) => n.kind === "hold")!;
    const escalation: Need = { ...hold, key: "escalation:r2", kind: "escalation", group: "decide" };
    const list = timeline({ events: [line("held", 30), line("resumed", 20), line("held", 5), line("fix_rounds_exhausted", 4, { actor: "supervisor", detail: "2" })], needs: [hold, escalation] });
    expect(list.map((e) => e.target)).toEqual([null, null, { type: "need", key: hold.key }, { type: "need", key: "escalation:r2" }]);
    expect(list[2].needKey).toBe(hold.key);
    // An undo that restores the supervisor's hold after the person's own holds the need now.
    const undone = timeline({ events: [line("held", 30, { actor: "supervisor" }), line("held", 20), line("undone", 10, { detail: "held" })], needs: [hold] });
    expect(undone.map((e) => e.target)).toEqual([null, null, { type: "need", key: hold.key }]);
    expect(undone[2].needKey).toBe(hold.key);
  });

  it("links a budget hold's line to its question, and a hold the person chose to no need", () => {
    const budget = needs({ workstreams: [view({ heldReason: "budget" })], runs: [], proposals: [], dismissed: new Set(), now: NOW })[0];
    expect(budget.kind).toBe("budget");
    const list = timeline({ events: [line("held", 5, { actor: "supervisor", detail: "budget" })], needs: [budget] });
    expect(list.map((e) => e.target)).toEqual([{ type: "need", key: "budget:ws-1" }]);
    const own = needs({ workstreams: [view({ heldReason: "person" })], runs: [], proposals: [], dismissed: new Set(), now: NOW });
    expect(own).toEqual([]);
    expect(timeline({ events: [line("held", 5, { detail: "person" })], needs: own }).map((e) => e.target)).toEqual([null]);
  });

  it("words the person's Allow 5 more and counts it among their decisions", () => {
    const [allowed] = timeline({ events: [line("steps_allowed", 5, { detail: "5" })] });
    expect(allowed).toMatchObject({ text: "You allowed 5 more automatic steps", decision: true });
  });

  it("words the person's three choices on a ticket that isn't clear enough to plan and counts each among their decisions", () => {
    const list = timeline({
      events: [line("readiness_asked", 3, { runId: "r1", proposalId: "d1" }), line("readiness_answered", 2, { runId: "r1" }), line("readiness_overridden", 1, { runId: "r1" })],
      runs: [run("r1", "triage", "done", 30)],
      labels: new Map([["r1", "R1"]]),
    });
    const audit = list.filter((e) => e.kind === "audit");
    expect(audit.map((e) => [e.text, e.decision])).toEqual([
      ["You asked the reporter about R1's open questions", true],
      ["You chose to answer R1's open questions", true],
      ["You chose to plan anyway after R1 found the ticket not ready", true],
    ]);
    expect(audit.every((e) => e.kind === "audit" && e.decision)).toBe(true);
    // The same line by anyone but the person is still worded, and is not the person's decision.
    const other = timeline({ events: [line("readiness_overridden", 1, { actor: "pip", runId: "r1" })], runs: [run("r1", "triage", "done", 30)], labels: new Map([["r1", "R1"]]) }).find((e) => e.kind === "audit")!;
    expect(other.text).toBe("Pip chose to plan anyway after R1 found the ticket not ready");
    expect(other.decision).toBe(false);
  });

  it("says a triage's finish with the reason the ticket waits, and opens its need", () => {
    const stopped: WorkstreamView = { ...view(), readiness: { triageRun: "r1", triageLabel: "R1", questions: ["Who asked?"], at: iso(20) } };
    const found = needs({ workstreams: [stopped], runs: [], proposals: [], dismissed: new Set(), now: NOW });
    expect(found.map((n) => n.kind)).toEqual(["readiness"]);
    const [entry] = timeline({ runs: [run("r1", "triage", "done", 30)], needs: found, labels: new Map([["r1", "R1"]]) });
    expect(entry).toMatchObject({ text: "Triage R1 finished: the ticket isn't clear enough to plan", target: { type: "need", key: "readiness:r1" }, needKey: "readiness:r1", decision: true });
    const [after] = timeline({ runs: [run("r1", "triage", "done", 30)], needs: [], labels: new Map([["r1", "R1"]]) });
    expect(after).toMatchObject({ text: "Triage R1 finished", target: { type: "run", id: "r1" }, decision: false });
  });

  it("opens the run or the draft a line names, when it is on the timeline", () => {
    const list = timeline({
      runs: [run("r1", "build", "stopped", 30)],
      drafts: [draft("d1", comment("CA-401"), 20, { state: { type: "applied" } })],
      events: [line("run_stopped", 15, { runId: "r1" }), line("draft_approved", 10, { proposalId: "d1" }), line("run_answered", 5, { runId: "gone" })],
      labels,
    });
    const audit = list.filter((e) => e.kind === "audit");
    expect(audit.map((e) => e.target)).toEqual([{ type: "run", id: "r1" }, { type: "draft", id: "d1" }, null]);
    expect(audit[2].text).toBe("You answered run gone");
  });
});

describe("timeline filters", () => {
  const all = timeline({
    turns: [turn("q1", 100)],
    runs: [run("r1", "investigate", "done", 90), run("r2", "build", "needsPermission", 20, { needs: "git push" })],
    drafts: [draft("d1", comment("CA-401"), 70), draft("d2", transition("CA-401"), 60, { state: { type: "applied" } })],
    events: [line("mode_set", 95, { detail: "manage" }), line("waiting_for_pr", 50, { actor: "supervisor", runId: "r1" })],
    needs: [{ key: "run:r2", runId: "r2" } as Need, { key: "draft:d1" } as Need],
    labels,
  });

  it("All shows everything", () => {
    expect(filterTimeline(all, "all")).toEqual(all);
  });

  it("Runs shows the runs alone, in order", () => {
    expect(keys(filterTimeline(all, "runs"))).toEqual(["run:r1", "run:r2"]);
  });

  it("Drafts shows the drafts alone, decided or not", () => {
    expect(keys(filterTimeline(all, "drafts"))).toEqual(["draft:d1", "draft:d2"]);
  });

  it("Decisions shows what the person decided and what waits on them", () => {
    expect(keys(filterTimeline(all, "decisions"))).toEqual(["audit:ws-1:" + all.find((e) => e.action === "mode_set")!.key.split(":")[2], "draft:d1", "run:r2"]);
  });

  it("counts what each filter shows", () => {
    expect(filterCounts(all)).toEqual({ all: all.length, runs: 2, drafts: 2, decisions: 3 });
  });

  it("names and explains each filter", () => {
    expect(TIMELINE_FILTERS.map((f) => FILTER_LABEL[f])).toEqual(["All", "Runs", "Drafts", "Decisions"]);
    for (const f of TIMELINE_FILTERS) expect(EMPTY_FILTER[f]).toMatch(/\.$/);
    expect(shows("runs", { kind: "audit", decision: true })).toBe(false);
    expect(shows("decisions", { kind: "run", decision: false })).toBe(false);
  });
});

describe("every workstream", () => {
  const view = (id: string, key: string | null, over: Partial<WorkstreamView["workstream"]> = {}): WorkstreamView =>
    ({ workstream: { id, itemKey: key, title: key ? `${key} Checkout` : "Loose ends", connectionId: "mock", closedAt: null, createdAt: iso(600), ...over }, stage: "intake", runs: [], labels: [], budget: {} }) as unknown as WorkstreamView;
  const inWs = (id: string, ws: string, queuedAgo: number) => run(id, "build", "done", queuedAgo, { item: ref(ws === "ws-1" ? "CA-401" : "CA-402"), spec: { ...base.spec, kind: "build", workstream: ws } });

  it("merges each part's own timeline by time, each entry carrying its workstream and label", () => {
    const merged = timelineAcross([
      { workstreamId: "ws-1", label: "CA-401", input: { turns: [turn("a", 50)], events: [line("held", 10)] } },
      { workstreamId: "ws-2", label: "CA-402", input: { turns: [turn("b", 40)], runs: [inWs("r9", "ws-2", 30)] } },
      { workstreamId: null, label: "General", input: { turns: [turn("c", 20)] } },
    ]);
    expect(keys(merged)).toEqual(["turn:a", "turn:b", "run:r9", "turn:c", "audit:ws-1:0"]);
    expect(merged.map((e) => e.scopeLabel)).toEqual(["CA-401", "CA-402", "CA-402", "General", "CA-401"]);
    expect(merged.map((e) => e.workstreamId)).toEqual(["ws-1", "ws-2", "ws-2", null, "ws-1"]);
  });

  it("is each part's timeline as it is, only merged: the same entries, in the same order within a part", () => {
    const one = { turns: [turn("a", 50), turn("b", 5)], runs: [run("r1", "investigate", "done", 30)], events: [line("hold_lifted", 40), line("hold_lifted", 39)] };
    const alone = timeline(one);
    const merged = timelineAcross([{ workstreamId: "ws-1", label: "CA-401", input: one }]);
    expect(merged.map(({ workstreamId: _w, scopeLabel: _l, ...e }) => e)).toEqual(alone);
  });

  it("keeps something two parts show once, in the first part to show it", () => {
    const waiting = draft("d1", comment("CA-401"), 15);
    const merged = timelineAcross([
      { workstreamId: "ws-1", label: "CA-401", input: { drafts: [waiting] } },
      { workstreamId: null, label: "General", input: { drafts: [waiting] } },
    ]);
    expect(keys(merged)).toEqual(["draft:d1"]);
    expect(merged[0].scopeLabel).toBe("CA-401");
  });

  it("keeps the parts' order for entries at the same moment, after the order by kind", () => {
    const at = iso(30);
    const merged = timelineAcross([
      { workstreamId: "ws-1", label: "CA-401", input: { runs: [run("r1", "build", "done", 30, { queuedAt: at })] } },
      { workstreamId: "ws-2", label: "CA-402", input: { turns: [turn("q", null, { at })], runs: [inWs("r2", "ws-2", 30)] } },
    ]);
    // What was said comes first at the same moment, then the runs in their parts' order.
    expect(keys(merged)).toEqual(["turn:q", "run:r1", "run:r2"]);
  });

  it("reads every open workstream, then General, from what the stores hold", () => {
    const ws1 = view("ws-1", "CA-401");
    const ws2 = view("ws-2", "CA-402");
    const closed = view("ws-3", "CA-403", { closedAt: iso(5) });
    const free = run("free", "investigate", "done", 45, { spec: { ...base.spec, kind: "investigate", workstream: null } });
    const loose = draft("loose", comment("CA-999"), 12, { origin: { type: "chat", requestId: "g1" }, createdBy: "pip" });
    const onTicket = draft("on-ticket", comment("CA-401"), 11, { origin: { type: "chat", requestId: "x" }, createdBy: "pip" });
    const parts = everyWorkstreamParts({
      views: [ws1, ws2, closed],
      turns: { "ws:ws-1": [turn("a", 50)], "ws:ws-3": [turn("gone", 49)], general: [turn("g1", 13)] },
      runs: [inWs("r1", "ws-1", 40), inWs("r2", "ws-2", 30), free],
      proposals: [loose, onTicket],
      events: { "ws-1": [line("held", 10)], "ws-3": [line("held", 9, { workstreamId: "ws-3" })] },
    });
    expect(parts.map((p) => [p.workstreamId, p.label])).toEqual([
      ["ws-1", "CA-401"],
      ["ws-2", "CA-402"],
      [null, "General"],
    ]);
    const merged = timelineAcross(parts);
    const where = Object.fromEntries(merged.map((e) => [e.key, e.scopeLabel]));
    expect(where).toEqual({ "turn:a": "CA-401", "run:free": "General", "run:r1": "CA-401", "run:r2": "CA-402", "turn:g1": "General", "draft:loose": "General", "draft:on-ticket": "CA-401", "audit:ws-1:0": "CA-401" });
    // A closed workstream takes no part.
    expect(merged.some((e) => e.key === "turn:gone" || e.key.startsWith("audit:ws-3"))).toBe(false);
  });

  it("labels a workstream by its ticket, else its title", () => {
    expect(workstreamLabel(view("ws-1", "CA-401"))).toBe("CA-401");
    expect(workstreamLabel(view("ws-2", null))).toBe("Loose ends");
  });

  it("filters the same way in either scope; Runs in every workstream is the Agents screen", () => {
    const merged = timelineAcross([
      { workstreamId: "ws-1", label: "CA-401", input: { runs: [inWs("r1", "ws-1", 40)], events: [line("held", 10)] } },
      { workstreamId: "ws-2", label: "CA-402", input: { runs: [inWs("r2", "ws-2", 30)], drafts: [draft("d2", comment("CA-402"), 20)] } },
    ]);
    expect(keys(filterTimeline(merged, "runs"))).toEqual(["run:r1", "run:r2"]);
    expect(keys(filterTimeline(merged, "drafts"))).toEqual(["draft:d2"]);
    expect(filterCounts(merged)).toEqual({ all: 4, runs: 2, drafts: 1, decisions: 1 });
    expect(TIMELINE_SCOPES.map((s) => SCOPE_LABEL[s])).toEqual(["This workstream", "Every workstream"]);
    expect(TIMELINE_FILTERS.flatMap((f) => TIMELINE_SCOPES.filter((s) => isAgentsView(f, s)).map((s) => `${f}/${s}`))).toEqual(["runs/every"]);
  });
});
