import { beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Intent, ItemRef, PauseReason, Proposal, ProposalState, Run, RunKind, RunState, WorkstreamActor, WorkstreamEvent, WorkstreamView } from "../types";
import { needs, type Need } from "./needs";
import { EMPTY_FILTER, FILTER_LABEL, TIMELINE_FILTERS, draftSentence, filterCounts, filterTimeline, runLifecycle, runPhase, runSentence, shows, timeline, type TimelineEntry, type TimelineTurn } from "./timeline";

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

const view = (over: { pausedReason?: PauseReason | null } = {}): WorkstreamView => ({
  workstream: {
    id: "ws-1",
    connectionId: "mock",
    itemKey: "CA-401",
    repo: null,
    title: "CA-401 Rounding",
    pipSession: null,
    pausedReason: over.pausedReason ?? null,
    notes: null,
    createdAt: iso(600),
    closedAt: null,
    basis: null,
  },
  stage: "build",
  runs: ["r1", "r2"],
  labels: [
    ["r1", "R1"],
    ["r2", "R2"],
  ],
  waitingForPr: null,
});

describe("timeline: one list, oldest first", () => {
  it("merges the conversation, the runs, the drafts and the audit into one chronological story", () => {
    const list = timeline({
      turns: [turn("q1", 100), turn("q2", 30)],
      runs: [run("r1", "investigate", "done", 90), run("r2", "build", "working", 20)],
      drafts: [draft("d1", comment("CA-401"), 70, { state: { type: "applied" }, updatedAgo: 60 })],
      events: [line("paused", 95, { detail: "person" }), line("draft_approved", 60, { proposalId: "d1" })],
      labels,
      ticketKey: "CA-401",
    });
    expect(keys(list)).toEqual(["turn:q1", "audit:ws-1:0", "run:r1", "draft:d1", "turn:q2", "run:r2"]);
    expect(list.map((e) => e.text)).toEqual([
      "You: question q1",
      "You paused the workstream",
      "Investigate R1 finished",
      "You approved a comment on CA-401, drafted by an agent: posted",
      "You: question q2",
      "Build R2 started",
    ]);
  });

  it("gives every entry a stable key, a kind, a time, a ticket and a sentence", () => {
    const input = { turns: [turn("q1", 10)], runs: [run("r1", "plan", "queued", 5)], drafts: [draft("d1", transition("CA-401"), 3)], events: [line("paused", 2)], ticketKey: "CA-401" };
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
    const list = timeline({ turns: [turn("q1", 10)], runs: [run("r1", "plan", "queued", 10)], drafts: [draft("d1", comment("CA-401"), 10)], events: [line("paused", 10)] });
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

  it("stands where the audit says it was approved, else where it was queued", () => {
    const list = timeline({
      turns: [turn("q1", 50)],
      runs: [run("r1", "plan", "working", 10), run("r2", "build", "queued", 5), run("r3", "review", "queued", 60)],
      events: [line("run_approved", 55, { runId: "r1" }), line("run_approved", 40, { runId: "r2" })],
    });
    expect(keys(list)).toEqual(["run:r3", "run:r1", "turn:q1", "run:r2"]);
    expect(list.find((e) => e.key === "run:r2")!.at).toBe(iso(40));
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
    expect(runSentence(run("r1", "plan", "queued", 5), "R1", undefined)).toBe("Plan R1 queued");
    expect(runSentence(run("r1", "plan", "needsAnswer", 5), "R1", undefined)).toBe("Plan R1 is waiting on you: it asks a question");
    expect(runSentence(run("r1", "build", "needsPermission", 5), "R1", undefined)).toBe("Build R1 is waiting on you: it needs permission");
    expect(runSentence(run("r1", "build", "systemBlocked", 5), "R1", undefined)).toBe("Build R1 is waiting on you: sign in to Claude");
    expect(runSentence(run("r3", "review", "done", 5), "R3", "pass")).toBe("Review R3 finished: the review passes");
    expect(runSentence(run("r3", "review", "done", 5), "R3", "blocking")).toBe("Review R3 finished: changes needed");
    expect(runSentence(run("r3", "review", "done", 5), "R3", null)).toBe("Review R3 finished");
    expect(runSentence(run("r1", "build", "failed", 5, { error: "Folder not trusted\nstack…" }), "R1", undefined)).toBe("Build R1 failed");
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
    expect(draftSentence(draft("d2", start, 5, { createdBy: "pip", state: { type: "applied" } }))).toBe("You started the investigate run that Pip drafted on CA-401");
    expect(draftSentence(draft("d3", comment("CA-401"), 5, { state: { type: "retired", reason: "gone" } }))).toBe("An agent drafted a comment on CA-401: no longer needed");
  });

  it("says who posted a GitHub review, to which pull request, with how many comments and whether it was edited", () => {
    const review = (n: number) => ({ type: "githubReview", connectionId: "gh", item: ref("CA-402"), runId: "r1", repo: "hobbii/cart", number: 17, commitSha: "abc", summary: "s", comments: Array.from({ length: n }, (_, i) => ({ path: "a.ts", line: i + 1, side: "RIGHT", body: "x" })) }) as unknown as Intent;
    expect(draftSentence(draft("d1", review(2), 5, { state: { type: "applied" } }))).toBe("You posted an agent's GitHub review on hobbii/cart#17: 2 inline comments");
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
    expect(timeline({ drafts: [{ ...asked, state: { type: "applied" } } as Proposal] })[0].text).toBe("You posted the questions for the reporter on CA-401");
    expect(timeline({ drafts: [draft("d2", comment("CA-401"), 5)] })[0].text).toBe("An agent drafted a comment on CA-401");
  });

  it("says the person started the run Pip drafted", () => {
    const start = { type: "startRun", item: ref("CA-401"), spec: { ...base.spec, kind: "build" } } as unknown as Intent;
    const d = draft("d1", start, 5, { createdBy: "pip", state: { type: "applied" } });
    expect(draftSentence(d)).toBe("You started the build run that Pip drafted on CA-401");
    expect(timeline({ drafts: [d] })[0].text).toBe("You started the build run that Pip drafted on CA-401");
  });


  it("tells the first ask, the follow-up and the nudge apart (G13)", () => {
    const asked = (id: string, label: string, over: Partial<Proposal> = {}) => ({ ...draft(id, comment("CA-408"), 5, { state: { type: "applied" } }), label, ...over }) as Proposal;
    const questions = asked("d1", "Questions for the reporter");
    expect(draftSentence(questions)).toBe("You posted the questions for the reporter on CA-408");
    expect(draftSentence(asked("d2", "Nudge for the reporter"))).toBe("You posted the nudge to the reporter on CA-408");
    expect(draftSentence(questions, { followUp: true })).toBe("You posted the follow-up questions for the reporter on CA-408");
    expect(draftSentence({ ...questions, revisions: [{}] } as unknown as Proposal)).toBe("You posted the questions for the reporter on CA-408, edited by you");
    // An earlier ask posted on the workstream makes the next one a follow-up.
    const second = asked("d3", "Questions for the reporter", { createdAt: iso(10), updatedAt: iso(10) });
    const list = timeline({ drafts: [{ ...questions, createdAt: iso(30), updatedAt: iso(30) } as Proposal, second] });
    expect(list.map((e) => e.text)).toEqual(["You posted the questions for the reporter on CA-408", "You posted the follow-up questions for the reporter on CA-408"]);
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

describe("timeline: a failed run's heading and its message", () => {
  it("heads a failure short and keeps what the run said, as it said it, for smaller type under it", () => {
    const [failed] = timeline({ runs: [run("r1", "build", "failed", 20, { error: "  Folder not trusted\nat launch (stack…)" })], labels });
    expect(failed.text).toBe("Build R1 failed");
    expect(failed.detail).toBe("Folder not trusted");
  });

  it("has no detail without a message, or for a run that did not fail", () => {
    const [bare] = timeline({ runs: [run("r1", "build", "failed", 20)], labels });
    expect(bare.text).toBe("Build R1 failed");
    expect(bare.detail).toBeUndefined();
    const [done] = timeline({ runs: [run("r2", "build", "done", 20, { error: "left over" })], labels });
    expect(done.detail).toBeUndefined();
  });
});

describe("timeline: cause before effect", () => {
  const review = (n: number) => ({ type: "githubReview", connectionId: "gh", item: ref("CA-401"), runId: "r2", repo: "hobbii/cart", number: 17, commitSha: "abc", summary: "s", comments: Array.from({ length: n }, (_, i) => ({ path: "a.ts", line: i + 1, side: "RIGHT", body: "x" })) }) as unknown as Intent;
  const posted = (minutesAgo: number, over: Parameters<typeof draft>[3] = {}) => draft("d1", review(2), minutesAgo, { state: { type: "applied" }, origin: { type: "run", runId: "r2", shortId: null, workstream: "ws-1" }, ...over });

  it("puts the review run, the review it left and its posting in that order when they share a moment", () => {
    const list = timeline({ runs: [run("r2", "review", "done", 20, { queuedAt: iso(20) })], drafts: [posted(20)], events: [line("review_posted", 20, { proposalId: "d1" })], labels });
    // The review's own entry says it was posted, so the audit line that repeats it is left out.
    expect(list.map((e) => e.kind)).toEqual(["run", "draft"]);
    expect(list[1].draftState).toBe("applied");
  });

  it("never puts a posted review before the review run it came of, whatever the clocks say", () => {
    // The review's draft and its posting are stamped before the run is, as two stores' clocks may differ.
    const list = timeline({ runs: [run("r2", "review", "done", 20)], drafts: [posted(25)], events: [line("review_posted", 24, { proposalId: "d1" })], labels });
    expect(keys(list)).toEqual(["run:r2", "draft:d1"]);
    // The entries keep the time each was stamped.
    expect(list[1].at).toBe(iso(25));
  });

  it("leaves unrelated entries by time and then by kind, and entries after the cause where they were", () => {
    const list = timeline({
      runs: [run("r2", "review", "done", 20)],
      drafts: [posted(15)],
      events: [line("paused", 20), line("review_posted", 10, { proposalId: "d1" }), line("resumed", 12)],
      labels,
    });
    expect(list.map((e) => e.key)).toEqual(["audit:ws-1:0", "run:r2", "draft:d1", "audit:ws-1:2"]);
  });

});

describe("timeline: the audit", () => {
  it("leaves out what a run's or a draft's own entry already tells", () => {
    const list = timeline({
      runs: [run("r1", "build", "working", 30)],
      drafts: [draft("d1", comment("CA-401"), 20)],
      events: [line("run_approved", 30, { runId: "r1" }), line("wake", 25, { actor: "supervisor", runId: "r1" }), line("draft_created", 20, { proposalId: "d1", actor: "run" }), line("notes_set", 19, { actor: "pip" })],
      labels,
    });
    expect(list.map((e) => e.kind)).toEqual(["run", "draft"]);
  });

  it("keeps pauses, undos and what the person did to runs and drafts", () => {
    const list = timeline({
      runs: [run("r1", "build", "done", 90), run("r2", "review", "done", 80)],
      drafts: [draft("d1", comment("CA-401"), 70, { state: { type: "pending" } })],
      events: [
        line("paused", 60),
        line("resumed", 59),
        line("basis_drifted", 58, { actor: "supervisor", detail: "description" }),
        line("draft_skipped", 56, { proposalId: "d1" }),
        line("undone", 55, { proposalId: "d1", detail: "draft_skipped" }),
        line("run_stopped", 54, { runId: "r1" }),
        line("run_retried", 53, { runId: "r1" }),
      ],
      labels,
    });
    expect(list.filter((e) => e.kind === "audit").map((e) => e.text)).toEqual([
      "You paused the workstream",
      "You resumed the workstream",
      "The ticket's description changed in Jira",
      "You skipped a comment on CA-401",
      "You brought back a comment on CA-401",
      "You stopped R1",
      "You retried R1",
    ]);
  });

  it("keeps each ask of the reporter as a line of its own, however alike (G29)", () => {
    for (const action of ["readiness_asked", "clarity_asked", "reporter_nudged"]) {
      const list = timeline({ events: [line(action, 10), line(action, 9)] });
      expect(list).toHaveLength(2);
      expect(list.some((e) => e.count !== undefined || / times\)$/.test(e.text))).toBe(false);
    }
  });

  it("tells the choice to ask the reporter before the post it made, and without the need it settled (G7)", () => {
    const base = needs({ workstreams: [view({ pausedReason: "person" })], runs: [], proposals: [], dismissed: new Set(), now: NOW, pausedAt: { "ws-1": iso(5) } }).find((n) => n.kind === "paused")!;
    const open: Need = { ...base, key: "readiness:r1", kind: "readiness", runId: "r1" };
    const list = timeline({
      drafts: [draft("d1", comment("CA-401"), 4, { state: { type: "applied" }, updatedAgo: 2 })],
      events: [line("readiness_asked", 5, { runId: "r1", proposalId: "d1" }), line("draft_approved", 2, { proposalId: "d1" })],
      needs: [open],
    });
    const texts = list.map((e) => e.text);
    const asked = list.find((e) => e.action === "readiness_asked")!;
    expect(texts.indexOf(asked.text)).toBeLessThan(texts.findIndex((t) => t.includes("approved a comment")));
    expect(asked.needKey).toBeNull();
    expect(asked.target).toEqual({ type: "draft", id: "d1" });
  });

  it("keeps the choice to ask before the draft it made and the post that followed, even when it was recorded a moment after the draft (G22)", () => {
    for (const asked of [0, -0.5]) {
      const list = timeline({
        drafts: [draft("d1", comment("CA-401"), 4, { state: { type: "applied" }, updatedAgo: 4 })],
        events: [line("clarity_asked", 4 + asked, { proposalId: "d1" }), line("draft_approved", 4, { proposalId: "d1" })],
      });
      const at = (match: (e: (typeof list)[number]) => boolean) => list.findIndex(match);
      expect(at((e) => e.action === "clarity_asked")).toBeLessThan(at((e) => e.kind === "draft"));
      expect(at((e) => e.action === "clarity_asked")).toBeLessThan(at((e) => e.text.includes("approved a comment")));
    }
  });

  it("collapses the same line again and again into one that says how many", () => {
    const list = timeline({ events: [line("run_stopped", 10, { runId: "r1" }), line("run_stopped", 9, { runId: "r1" }), line("run_stopped", 8, { runId: "r1" }), line("paused", 7), line("run_stopped", 6, { runId: "r1" })], labels });
    expect(list.map((e) => e.text)).toEqual(["You stopped R1 (3 times)", "You paused the workstream", "You stopped R1"]);
    expect(list[0].count).toBe(3);
    expect(list[0].at).toBe(iso(10));
    expect(list[0].updatedAt).toBe(iso(8));
  });

  it("marks what the person did and what asks them to decide as decisions, and not the rest", () => {
    const list = timeline({ events: [line("paused", 10, { actor: "supervisor", detail: "ceiling" }), line("resumed", 8), line("basis_drifted", 7, { actor: "supervisor", detail: "status" })] });
    expect(list.map((e) => [e.action, e.decision])).toEqual([
      ["paused", true],
      ["resumed", true],
      ["basis_drifted", false],
    ]);
  });

  it("leaves opening and closing the workstream and the notes out of the decisions", () => {
    const list = timeline({ events: [line("opened", 10), line("notes_set", 9), line("closed", 8)] });
    expect(list.map((e) => [e.action, e.decision])).toEqual([
      ["opened", false],
      ["closed", false],
    ]);
  });

  it("leaves out what an earlier version recorded: automatic starts, fix rounds, budgets, rules and modes", () => {
    const old = ["autostart", "waiting_for_pr", "fix_round_sent", "fix_rounds_exhausted", "budget_reset", "steps_allowed", "rule_set", "mode_set", "escalation_taken"];
    expect(timeline({ events: old.map((a, n) => line(a, 20 - n, { actor: "supervisor" })) })).toEqual([]);
  });

  it("links the pause that still holds to its need", () => {
    const held = view({ pausedReason: "person" });
    const all = needs({ workstreams: [held], runs: [], proposals: [], dismissed: new Set(), now: NOW, pausedAt: { "ws-1": iso(5) } });
    const pause = all.find((n) => n.kind === "paused")!;
    const list = timeline({ events: [line("paused", 30), line("resumed", 20), line("paused", 5)], needs: [pause] });
    expect(list.map((e) => e.target)).toEqual([null, null, { type: "need", key: pause.key }]);
    expect(list[2].needKey).toBe(pause.key);
  });

  it("words the person's three choices on a ticket that isn't clear enough to plan and counts each among their decisions", () => {
    const list = timeline({
      events: [line("readiness_asked", 3, { runId: "r1", proposalId: "d1" }), line("readiness_answered", 2, { runId: "r1" }), line("readiness_overridden", 1, { runId: "r1" })],
      runs: [run("r1", "triage", "done", 30)],
      labels: new Map([["r1", "R1"]]),
    });
    const audit = list.filter((e) => e.kind === "audit");
    expect(audit.map((e) => [e.text, e.decision])).toEqual([
      ["You chose to ask the reporter about R1's open questions; drafted for you to post", true],
      ["You chose to answer R1's open questions", true],
      ["You chose to plan now, after asking the reporter about R1's open questions", true],
    ]);
    expect(audit.every((e) => e.kind === "audit" && e.decision)).toBe(true);
    // The same line by anyone but the person is still worded, and is not the person's decision.
    const other = timeline({ events: [line("readiness_overridden", 1, { actor: "pip", runId: "r1" })], runs: [run("r1", "triage", "done", 30)], labels: new Map([["r1", "R1"]]) }).find((e) => e.kind === "audit")!;
    expect(other.text).toBe("Pip chose to plan anyway after R1 found the ticket not ready");
    expect(other.decision).toBe(false);
  });

  it("words a Plan now after the reporter was asked apart from Plan anyway", () => {
    const list = timeline({
      events: [line("readiness_asked", 3, { runId: "r1", proposalId: "d1" }), line("readiness_overridden", 2, { runId: "r1" }), line("readiness_overridden", 1, { runId: "r2" })],
      runs: [run("r1", "triage", "done", 30), run("r2", "triage", "done", 30)],
      labels: new Map([["r1", "R1"], ["r2", "R2"]]),
    });
    const texts = list.filter((e) => e.kind === "audit").map((e) => e.text);
    expect(texts).toContain("You chose to plan now, after asking the reporter about R1's open questions");
    expect(texts).toContain("You chose to plan anyway after R2 found the ticket not ready");
    expect(texts.join("\n")).not.toContain("plan anyway after R1");
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
      events: [line("run_stopped", 15, { runId: "r1" }), line("draft_skipped", 10, { proposalId: "d1" }), line("run_answered", 5, { runId: "gone" })],
      labels,
    });
    const audit = list.filter((e) => e.kind === "audit");
    expect(audit.map((e) => e.target)).toEqual([{ type: "run", id: "r1" }, { type: "draft", id: "d1" }, null]);
    expect(audit[2].text).toBe("You answered run gone");
  });
});

describe("timeline: one line for one post", () => {
  it("drops the approval line of a draft shown as applied, and moves the decision to the draft", () => {
    const list = timeline({ drafts: [draft("d1", comment("CA-408"), 20, { state: { type: "applied" } })], events: [line("draft_approved", 10, { proposalId: "d1" })], labels });
    expect(keys(list)).toEqual(["draft:d1"]);
    expect(list[0].decision).toBe(true);
    expect(filterCounts(list).decisions).toBe(1);
  });

  it("drops it for a draft still applying, too", () => {
    const list = timeline({ drafts: [draft("d1", comment("CA-408"), 20, { state: { type: "applying" } })], events: [line("draft_approved", 10, { proposalId: "d1" })], labels });
    expect(keys(list)).toEqual(["draft:d1"]);
  });

  it("keeps it when the draft is not on the timeline, or is not applied", () => {
    const events = [line("draft_approved", 10, { proposalId: "gone" })];
    expect(timeline({ events, labels }).map((e) => e.text)).toEqual(["You approved a draft"]);
    const pending = timeline({ drafts: [draft("d1", comment("CA-408"), 20)], events: [line("review_posted", 10, { proposalId: "d1" })], labels });
    expect(pending.map((e) => e.kind)).toEqual(["draft", "audit"]);
  });
});

describe("timeline filters", () => {
  const all = timeline({
    turns: [turn("q1", 100)],
    runs: [run("r1", "investigate", "done", 90), run("r2", "build", "needsPermission", 20, { needs: "git push" })],
    drafts: [draft("d1", comment("CA-401"), 70), draft("d2", transition("CA-401"), 60, { state: { type: "applied" } })],
    events: [line("paused", 95), line("basis_drifted", 50, { actor: "supervisor", detail: "summary" })],
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
    expect(keys(filterTimeline(all, "decisions"))).toEqual(["audit:ws-1:" + all.find((e) => e.action === "paused")!.key.split(":")[2], "draft:d1", "run:r2"]);
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

describe("timeline: the reporter's replies on the ticket (G1)", () => {
  it("keeps a reply once the person asks again, in time order between the two asks", () => {
    const asked = (id: string, minutes: number) => ({ ...draft(id, comment("CA-408"), minutes, { state: { type: "applied" } }), label: "Questions for the reporter", createdAt: iso(minutes), updatedAt: iso(minutes) }) as Proposal;
    const list = timeline({
      ticketKey: "CA-408",
      drafts: [asked("d1", 50), asked("d2", 10)],
      // The wait the reply ended was asked again, so the view has no reply pending any more.
      reporterReplies: [{ id: "c1", excerpt: "It happens on checkout…", at: iso(30) }],
    });
    expect(list.map((e) => e.text)).toEqual(["You posted the questions for the reporter on CA-408", "The reporter replied on the ticket", "You posted the follow-up questions for the reporter on CA-408"]);
    expect(list[1]).toMatchObject({ key: "audit:reply:c1", detail: "“It happens on checkout…”", attention: false, target: { type: "comment", ticketKey: "CA-408", id: "c1" } });
  });

  it("asks for attention on the reply the person has not settled, and tells each reply by its comment", () => {
    const list = timeline({ ticketKey: "CA-408", reporterRepliedAt: iso(30), reporterReplies: [{ id: "c1", excerpt: "One", at: iso(40) }, { id: "c2", excerpt: "Two", at: iso(30) }] });
    expect(list.map((e) => [e.key, e.attention])).toEqual([["audit:reply:c1", false], ["audit:reply:c2", true]]);
  });
});

describe("timeline: the reporter's reply on the ticket", () => {
  it("is an entry of its own at the reply's time, since a comment leaves no audit line", () => {
    const at = iso(30);
    const got = timeline({ ticketKey: "CA-401", reporterRepliedAt: at });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "audit", at, text: "The reporter replied on the ticket", ticketKey: "CA-401", decision: false, attention: true, target: null });
  });

  it("quotes the reply and opens its comment on the ticket, when the view says which it was (G15)", () => {
    const got = timeline({ ticketKey: "CA-401", reporterRepliedAt: iso(30), reporterReply: { id: "c7", excerpt: "It should send three emails." } });
    expect(got[0]).toMatchObject({ text: "The reporter replied on the ticket", detail: "“It should send three emails.”", target: { type: "comment", ticketKey: "CA-401", id: "c7" } });
    // A secret in the reply is masked in the quote (G2), whichever way the entry is made.
    const secret = { id: "c8", excerpt: "Use ghp_abcdefghijklmnopqrstuvwxyz0123 and password: hunter22secret" };
    for (const input of [{ reporterRepliedAt: iso(30), reporterReply: secret }, { reporterReplies: [{ ...secret, at: iso(30) }] }]) {
      const detail = timeline({ ticketKey: "CA-401", ...input })[0].detail;
      expect(detail).toBe("“Use gh… and password: hu…”");
    }
    // Without a ticket key there is nothing to open, but the quote stays.
    expect(timeline({ reporterRepliedAt: iso(30), reporterReply: { id: "c7", excerpt: "Yes." } })[0]).toMatchObject({ detail: "“Yes.”", target: null });
    expect(timeline({ ticketKey: "CA-401", reporterRepliedAt: iso(30) })[0].detail).toBeUndefined();
  });

  it("sits among the other entries by its time, and is absent without one", () => {
    const turns: TimelineTurn[] = [{ requestId: "t1", at: iso(60), prompt: "hi", text: "", status: "done" }, { requestId: "t2", at: iso(10), prompt: "again", text: "", status: "done" }];
    const texts = timeline({ turns, reporterRepliedAt: iso(30) }).map((e) => e.text);
    expect(texts).toEqual(["You: hi", "The reporter replied on the ticket", "You: again"]);
    expect(timeline({ turns }).map((e) => e.text)).toEqual(["You: hi", "You: again"]);
    expect(timeline({ reporterRepliedAt: "not a time" })).toEqual([]);
  });
});
