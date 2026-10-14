import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import { AUTOSTART_DEFAULTS, HELD_BUDGET, HELD_PERSON, HELD_RESTART, TRIPWIRE } from "../types";
import type { Intent, ItemRef, Proposal, Run, RunKind, RunState, WorkstreamRule, WorkstreamStage, WorkstreamView } from "../types";
import { needs as buildNeeds, type Need } from "./needs";
import { nextStep } from "./nextStep";
import { budgetView } from "./workstreamHold";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });

const base = new MockBackend().runs.list()[0];
const run = (id: string, kind: RunKind, state: RunState, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  state,
  item: ref("CA-401"),
  spec: { ...base.spec, kind, workstream: "ws-1", allowPush: kind === "build" },
  failure: null,
  needs: null,
  queuedAt: iso(60),
  lastProgressAt: iso(1),
  endedAt: state === "done" ? iso(10) : null,
  slotWaitSince: null,
  ...over,
});

interface Over {
  mode?: "manage" | "advise";
  heldReason?: string | null;
  rules?: Partial<Record<WorkstreamRule, boolean>>;
  spent?: { autoTurns: number; wakes: number };
  stage?: WorkstreamStage;
  waitingForPr?: string | null;
  reviewBlocking?: boolean;
  closedAt?: string | null;
}

/** A workstream on CA-401 whose runs are `runs`, named R1, R2 and so on in the order given. */
const view = (runs: Run[], over: Over = {}): WorkstreamView => {
  const workstream = {
    id: "ws-1",
    connectionId: "mock",
    itemKey: "CA-401",
    repo: null,
    title: "CA-401 Something",
    pipSession: null,
    mode: over.mode ?? "manage",
    heldReason: over.heldReason ?? null,
    notes: null,
    createdAt: iso(600),
    closedAt: over.closedAt ?? null,
    budget: { autoTurns: null, wakes: null, tokens: null },
    spent: { ...(over.spent ?? { autoTurns: 0, wakes: 0 }), tokens: 0 },
    rules: over.rules ?? {},
    basis: null,
  };
  return {
    workstream,
    stage: over.stage ?? "intake",
    runs: runs.map((r) => r.id),
    labels: runs.map((r, n) => [r.id, `R${n + 1}`]),
    waitingForPr: over.waitingForPr ?? null,
    reviewBlocking: over.reviewBlocking ?? false,
    escalation: null,
    budget: budgetView(workstream),
  };
};

const needsOf = (v: WorkstreamView, runs: Run[], proposals: Proposal[] = []): Need[] => buildNeeds({ workstreams: [v], runs, proposals, dismissed: new Set(), now: NOW });
const next = (runs: Run[], over: Over = {}, proposals: Proposal[] = [], globals = AUTOSTART_DEFAULTS, events: Parameters<typeof nextStep>[5] = []) => {
  const v = view(runs, over);
  return nextStep(v, runs, proposals, needsOf(v, runs, proposals), globals, events);
};
const text = (runs: Run[], over: Over = {}, proposals: Proposal[] = []) => next(runs, over, proposals)?.text;

const applied = (id: string, from: string): Proposal =>
  ({
    id,
    createdAt: iso(20),
    updatedAt: iso(15),
    origin: { type: "run", runId: from, shortId: null },
    createdBy: "agent",
    intent: { type: "rewrite", item: ref("CA-401"), title: null, body: { from: {}, to: {}, fromText: "a", toText: "b" } } as unknown as Intent,
    label: null,
    basis: null,
    state: { type: "applied" },
    revisions: [],
    created: [],
    error: null,
    run: null,
  }) as Proposal;

describe("nextStep while a run works", () => {
  it("says a review starts when a build finishes, as the rules would start it", () => {
    const result = next([run("b", "build", "working")], { stage: "build" });
    expect(result).toMatchObject({ kind: "auto", need: null, text: "Next: when R1 (Build) finishes, a review starts automatically." });
  });

  it("names the other steps' followers: triage after an investigation", () => {
    expect(text([run("i", "investigate", "working")])).toBe("Next: when R1 (Investigate) finishes, a triage starts automatically.");
  });

  it("starts nothing after a build that may not push, and says why", () => {
    const result = next([run("b", "build", "working", { spec: { ...base.spec, kind: "build", workstream: "ws-1", allowPush: false } })]);
    expect(result?.kind).toBe("manual");
    expect(result?.text).toBe("Next: when R1 (Build) finishes, nothing starts on its own: it may not push, so there is no pull request to review. Your click starts the next step.");
  });

  it("says nothing starts when the rule's own switch is off, naming the rule", () => {
    expect(text([run("b", "build", "working")], { rules: { build_review: false } })).toBe("Next: when R1 (Build) finishes, nothing starts on its own: “Build's PR → Review” is off. Your click starts the next step.");
  });

  it("follows Settings for a rule the workstream has no switch for", () => {
    const v = view([run("b", "build", "working")]);
    const off = nextStep(v, [run("b", "build", "working")], [], [], { ...AUTOSTART_DEFAULTS, buildReview: false });
    expect(off?.kind).toBe("manual");
    // The workstream's own switch wins over Settings.
    const v2 = view([run("b", "build", "working")], { rules: { build_review: true } });
    expect(nextStep(v2, [run("b", "build", "working")], [], [], { ...AUTOSTART_DEFAULTS, buildReview: false })?.kind).toBe("auto");
  });

  it("says it depends on the verdict while a review works, never promising a fix round or a verify", () => {
    const result = next([run("r", "review", "working", { spec: { ...base.spec, kind: "review", workstream: "ws-1", buildFromRun: "b" } })]);
    expect(result).toMatchObject({ kind: "depends", text: "Next: depends on R1's review verdict." });
  });

  it("says nothing follows a review when fix rounds and verify are both off", () => {
    const text2 = text([run("r", "review", "working", { spec: { ...base.spec, kind: "review", workstream: "ws-1", buildFromRun: "b" } })], { rules: { fix_round: false, review_verify: false } });
    expect(text2).toBe("Next: when R1 (Review) finishes, nothing starts on its own: “Blocking review → fix round” and “Passing review → Verify” are off. Your click starts the next step.");
  });

  it("says it depends on the triage's result, since a plan starts only if one is recommended", () => {
    expect(next([run("t", "triage", "working")])).toMatchObject({ kind: "depends", text: "Next: depends on R1's triage: a plan starts automatically only if it recommends one and finds the ticket ready to plan." });
    expect(next([run("t", "triage", "working")], { rules: { triage_plan: false } })?.kind).toBe("manual");
  });

  it("says a build starts only once the plan is approved", () => {
    expect(next([run("p", "plan", "working")])).toMatchObject({ kind: "depends", text: "Next: when R1 (Plan) finishes and you approve its plan, a build starts automatically." });
    expect(next([run("p", "plan", "working")], { rules: { plan_build: false } })?.kind).toBe("manual");
  });

  it("says nothing follows a verification", () => {
    expect(text([run("v", "verify", "working")])).toBe("Next: when R1 (Verify) finishes, nothing starts on its own: nothing follows a verification on its own. Your click starts the next step.");
  });

  it("starts nothing after a run that is not on a ticket", () => {
    expect(text([run("i", "investigate", "working", { item: null })])).toContain("it is not on a ticket");
  });

  it("mentions the steps left once the budget runs low, and says it is used up once it is", () => {
    expect(text([run("b", "build", "working")], { spent: { autoTurns: 9, wakes: 0 } })).toBe("Next: when R1 (Build) finishes, a review starts automatically (2 of 11 automatic steps left).");
    expect(next([run("b", "build", "working")], { spent: { autoTurns: 11, wakes: 0 } })).toMatchObject({ kind: "spent", text: "Next: the automatic steps are used up. Your click starts the next step." });
    expect(next([run("b", "build", "working")], { spent: { autoTurns: 0, wakes: 12 } })?.kind).toBe("spent");
  });

  it("is a launching or queued run's line too", () => {
    expect(next([run("b", "build", "launching")])?.kind).toBe("auto");
    expect(next([run("b", "build", "queued")])?.kind).toBe("auto");
  });
});

describe("nextStep when the person is waited on", () => {
  it("links to the top need and says why it is asked", () => {
    const runs = [run("b", "build", "needsPermission", { needs: "git push origin ca-401" })];
    const v = view(runs);
    const list = needsOf(v, runs);
    const result = nextStep(v, runs, [], list);
    expect(result).toMatchObject({ kind: "waiting", text: "Next: waiting on you. R1 wants to run `git push origin ca-401`." });
    expect(result?.need).toBe(list[0]);
    expect(result?.need?.key).toBe("run:b");
  });

  it("takes the highest-ranked need of the workstream, not another workstream's", () => {
    const runs = [run("b", "build", "needsAnswer", { needs: "Which branch?" }), run("x", "build", "needsPermission", { needs: "rm -rf x", spec: { ...base.spec, kind: "build", workstream: "ws-other" } })];
    const v = view(runs.slice(0, 1));
    const result = nextStep(v, runs, [], needsOf(v, runs));
    expect(result?.need?.key).toBe("run:b");
    expect(result?.text).toContain("R1 asks");
  });

  it("names the plan approval that unblocks Build before an older need, and counts the others", () => {
    const rewrite = (id: string, from: string | null, ago: number): Proposal => ({ ...applied(id, from ?? "x"), createdAt: iso(ago), state: { type: "pending" } as const, origin: from ? { type: "run", runId: from, shortId: null } : { type: "chat", requestId: "q", workstream: "ws-1" } } as Proposal);
    const runs = [run("t", "triage", "done"), run("p", "plan", "done")];
    const v = view(runs);
    const list = needsOf(v, runs, [rewrite("d-old", "t", 500), rewrite("d-plan", "p", 5)]);
    const result = nextStep(v, runs, [], list);
    expect(result?.need?.kind).toBe("plan");
    expect(result?.text).toMatch(/wrote the plan.* \(\+1 more waiting\)\.?$/);
  });

  it("says the reporter replied, and when, once their answer ended the wait and the person has not chosen", () => {
    const runs = [run("t", "triage", "done")];
    const v = { ...view(runs), reporterReplied: true, reporterRepliedAt: iso(180) } as WorkstreamView;
    const result = nextStep(v, runs, [], [], AUTOSTART_DEFAULTS, [], new Date(NOW));
    expect(result).toMatchObject({ kind: "reporter", need: null, text: "Next: the reporter replied 3 hours ago; read it, then Looks fine or ask again." });
    expect(nextStep({ ...v, reporterRepliedAt: undefined } as WorkstreamView, runs, [], [], AUTOSTART_DEFAULTS, [], new Date(NOW))?.text).toBe("Next: the reporter replied; read it, then Looks fine or ask again.");
    // A need still comes first, and a step in hand carries on.
    const going = [run("b", "build", "working")];
    expect(nextStep({ ...view(going), reporterReplied: true } as WorkstreamView, going, [], [], AUTOSTART_DEFAULTS, [], new Date(NOW))?.kind).not.toBe("reporter");
    expect(nextStep(view(runs), runs, [], [], AUTOSTART_DEFAULTS, [], new Date(NOW))?.kind).not.toBe("reporter");
  });

  it("adds no count when the person is waited on for one thing only", () => {
    const runs = [run("b", "build", "needsPermission", { needs: "git push origin ca-401" })];
    expect(next(runs)?.text).not.toContain("more waiting");
  });

  it("outranks a run that works: the person is the one being waited on", () => {
    const runs = [run("b", "build", "working"), run("q", "review", "needsAnswer", { needs: "Which file?" })];
    expect(next(runs)?.kind).toBe("waiting");
  });

  it("does not hide a working run behind a draft that only needs approving, but shows it once nothing works", () => {
    const draft = { ...applied("d1", "b"), state: { type: "pending" } as const, intent: { type: "comment", item: ref("CA-401"), body: "Hi", mentions: [] } as unknown as Intent, origin: { type: "chat", requestId: "q", workstream: "ws-1" } } as Proposal;
    expect(next([run("b", "build", "working")], {}, [draft])?.kind).toBe("auto");
    const idle = next([run("b", "build", "done")], { stage: "build", rules: { build_review: false } }, [draft]);
    expect(idle?.kind).toBe("waiting");
    expect(idle?.need?.kind).toBe("draft");
  });

  it("is not waiting on a draft while a step is queued or about to start by a rule; it is once the line would be idle", () => {
    const draft = { ...applied("d1", "b"), state: { type: "pending" } as const, intent: { type: "comment", item: ref("CA-401"), body: "Hi", mentions: [] } as unknown as Intent, origin: { type: "chat", requestId: "q", workstream: "ws-1" } } as Proposal;
    expect(next([run("b", "build", "queued")], { stage: "build" }, [draft])).toMatchObject({ kind: "auto", need: null });
    // The build has finished and build_review is on: a review is about to start.
    expect(next([run("b", "build", "done")], { stage: "build", rules: { build_review: true } }, [draft])).toMatchObject({ kind: "auto", need: null, text: "Next: a review starts automatically after R1 (Build)." });
    expect(next([], {}, [draft])).toMatchObject({ kind: "waiting" });
    // A draft decides again where the rule is off.
    expect(next([run("b", "build", "done")], { stage: "build", rules: { build_review: false } }, [draft])?.kind).toBe("waiting");
  });

  it("is waiting on a failed run, which stays a need until dealt with", () => {
    expect(next([run("b", "build", "failed", { error: "boom" })])).toMatchObject({ kind: "waiting" });
  });
});

describe("nextStep in Advise", () => {
  it("says nothing starts on its own, whether a run works or nothing does", () => {
    const line = "Next: nothing starts on its own in Advise. Pip suggests, you start.";
    expect(next([run("b", "build", "working")], { mode: "advise" })).toMatchObject({ kind: "advise", text: line, need: null });
    expect(text([], { mode: "advise" })).toBe(line);
    expect(text([run("t", "triage", "done")], { mode: "advise" })).toBe(line);
  });

  it("never says a rule starts a step", () => {
    for (const kind of ["investigate", "triage", "plan", "build", "review", "verify"] as const) expect(text([run("x", kind, "working")], { mode: "advise" })).not.toMatch(/automatically/);
  });
});

describe("nextStep when held", () => {
  it("says it is held with the reason and that Resume continues", () => {
    expect(next([run("b", "build", "working")], { heldReason: HELD_PERSON })).toMatchObject({ kind: "held", text: "Next: held by you. Resume to continue.", need: null });
    expect(text([], { heldReason: HELD_RESTART })).toBe("Next: held after a restart. Resume to continue.");
    expect(text([], { heldReason: HELD_BUDGET, mode: "advise" })).toBe("Next: held: budget. Resume to continue.");
    expect(text([], { heldReason: `${TRIPWIRE}repeated_failure` })).toBe("Next: held: the same step failed twice. Resume to continue.");
  });

  it("points a budget hold at its question in Needs you, and says nothing of a hold the person chose being a need", () => {
    const result = next([run("b", "build", "working")], { heldReason: HELD_BUDGET, spent: { autoTurns: 11, wakes: 11 } });
    expect(result).toMatchObject({ kind: "held", text: "Next: the automatic steps are used up. Choose in Needs you: allow 5 more, or switch to Advise." });
    expect(result?.need).toMatchObject({ key: "budget:ws-1", kind: "budget", title: "CA-401 used its 11 automatic steps" });
    expect(next([run("b", "build", "working")], { heldReason: HELD_PERSON })?.need).toBeNull();
  });

  it("outranks every other line, a waiting need and Advise included", () => {
    const runs = [run("b", "build", "needsPermission", { needs: "ls" })];
    expect(next(runs, { heldReason: HELD_PERSON, mode: "advise" })?.kind).toBe("held");
  });
});

describe("nextStep when the budget is spent", () => {
  it("says the click starts the next step, with nothing running too", () => {
    expect(text([run("t", "triage", "done")], { spent: { autoTurns: 11, wakes: 0 } })).toBe("Next: the automatic steps are used up. Your click starts the next step.");
  });

  it("says nothing of a budget while there is plenty left", () => {
    expect(text([run("b", "build", "working")])).not.toMatch(/budget|steps left|turns/);
  });
});

describe("nextStep when the chain is finished", () => {
  it("says nothing is left and the PR waits for a merge, after a passing review", () => {
    const runs = [run("b", "build", "done"), run("r", "review", "done")];
    expect(next(runs, { stage: "done" })).toMatchObject({ kind: "done", text: "Next: nothing left. The PR is reviewed and waits for you to merge it." });
  });

  it("says verified after a verification", () => {
    expect(text([run("v", "verify", "done")], { stage: "done" })).toBe("Next: nothing left. The PR is verified and waits for you to merge it.");
  });

  it("holds for Advise too, since nothing is left to start", () => {
    expect(next([run("r", "review", "done")], { stage: "done", mode: "advise" })?.kind).toBe("done");
  });
});

describe("nextStep when a run waits for a slot", () => {
  it("says it starts when a slot frees, with its place in line", () => {
    const queued = (id: string, minutesAgo: number, workstream = "ws-1") => run(id, "review", "queued", { slotWaitSince: iso(minutesAgo), queuedAt: iso(minutesAgo), spec: { ...base.spec, kind: "review", workstream } });
    const first = queued("a", 5, "ws-other");
    const mine = queued("b", 3);
    const v = view([mine]);
    expect(nextStep(v, [first, mine], [], [], AUTOSTART_DEFAULTS)).toMatchObject({ kind: "slot", text: "Next: R1 starts when a slot frees (2nd in line)." });
    expect(nextStep(v, [mine], [], [], AUTOSTART_DEFAULTS)?.text).toBe("Next: R1 starts when a slot frees (1st in line).");
  });
});

describe("nextStep after the last run finished", () => {
  it("says the rule starts the next step when it has not started yet", () => {
    expect(text([run("i", "investigate", "done")])).toBe("Next: a triage starts automatically after R1 (Investigate).");
    expect(text([run("p", "plan", "done")], {}, [applied("d", "p")])).toBe("Next: a build starts automatically after R1 (Plan).");
  });

  it("waits for the plan to be approved: no build starts for an unapproved plan", () => {
    expect(next([run("p", "plan", "done")], {})?.kind).not.toBe("auto");
  });

  it("says a review is waiting for the build's pull request", () => {
    expect(next([run("b", "build", "done")], { waitingForPr: "b" })).toMatchObject({ kind: "auto", text: "Next: waiting for R1's pull request to show up; then a review starts automatically." });
  });

  it("starts a review for a build that has a pull request, once", () => {
    expect(text([run("b", "build", "done")])).toBe("Next: a review starts automatically after R1 (Build).");
    // A review of this commit exists already, so the rule has nothing to start.
    const reviewed = run("r", "review", "done", { spec: { ...base.spec, kind: "review", workstream: "ws-1", buildFromRun: "b", prSha: null } });
    expect(next([run("b", "build", "done"), reviewed], { stage: "review" })?.kind).not.toBe("auto");
  });

  it("says a fix round starts after a blocking review, and that it does not when that switch is off", () => {
    const blocking = run("r", "review", "done", { spec: { ...base.spec, kind: "review", workstream: "ws-1", buildFromRun: "b" } });
    expect(next([run("b", "build", "done"), blocking], { stage: "review", reviewBlocking: true })).toMatchObject({ kind: "auto", text: "Next: a fix round starts automatically after R2 (Review)." });
    expect(next([run("b", "build", "done"), blocking], { stage: "review", reviewBlocking: true, rules: { fix_round: false } })?.kind).toBe("manual");
  });

  it("says no fix round starts once the automatic rounds ran out, counting them as the supervisor does", () => {
    const blocking = run("r", "review", "done", { spec: { ...base.spec, kind: "review", workstream: "ws-1", buildFromRun: "b" } });
    const sent = (n: number) => ({ at: iso(30 - n), actor: "supervisor" as const, action: "autostart", runId: "b", detail: `fix_round after r${n}` });
    const runs = [run("b", "build", "done"), blocking];
    expect(next(runs, { stage: "review", reviewBlocking: true }, [], AUTOSTART_DEFAULTS, [sent(1)])?.kind).toBe("auto");
    expect(next(runs, { stage: "review", reviewBlocking: true }, [], AUTOSTART_DEFAULTS, [sent(1), sent(2)])).toMatchObject({ kind: "manual", text: "Next: R2's review still blocks after 2 fix rounds and no fix round starts on its own. Your click starts the next step." });
  });

  it("says nothing starts on its own once the person posted a blocking review", () => {
    const blocking = run("r", "review", "done", { spec: { ...base.spec, kind: "review", workstream: "ws-1", buildFromRun: "b" } });
    const posted = { at: iso(2), actor: "person" as const, action: "review_posted", runId: null, detail: null };
    expect(next([run("b", "build", "done"), blocking], { stage: "review", reviewBlocking: true }, [], AUTOSTART_DEFAULTS, [posted])).toMatchObject({ kind: "manual", text: "Next: the review is posted; nothing starts on its own. Your click starts the next step." });
  });

  it("says nothing starts after a triage that did not lead to a plan", () => {
    expect(text([run("t", "triage", "done")])).toBe("Next: nothing starts on its own after R1 (Triage): it did not call for a plan. Your click starts the next step.");
  });

  it("says nothing starts after a stopped run, which is waiting on the person only if it asks to be dealt with", () => {
    expect(text([run("b", "build", "stopped")])).toBe("Next: nothing starts on its own after R1 (Build) stopped. Your click starts the next step.");
  });

  it("is nothing running when there are no runs", () => {
    expect(next([])).toMatchObject({ kind: "idle", text: "Next: nothing is running. Ask Pip, or start a step yourself." });
  });
});

describe("nextStep edge cases", () => {
  it("says nothing for a closed workstream", () => {
    expect(next([run("b", "build", "working")], { closedAt: iso(1) })).toBeNull();
  });

  it("ignores runs that are not the workstream's", () => {
    const v = view([run("b", "build", "working")]);
    const other = run("o", "investigate", "needsPermission", { needs: "ls" });
    expect(nextStep(v, [run("b", "build", "working"), other], [], [], AUTOSTART_DEFAULTS)?.kind).toBe("auto");
  });

  it("always starts with Next: and is one sentence", () => {
    const cases: Run[][] = [[], [run("a", "investigate", "working")], [run("a", "build", "done")], [run("a", "review", "working")], [run("a", "plan", "failed")]];
    for (const runs of cases) for (const over of [{}, { mode: "advise" as const }, { heldReason: HELD_PERSON }, { spent: { autoTurns: 11, wakes: 0 } }]) {
      const line = next(runs, over)?.text ?? "";
      expect(line).toMatch(/^Next: /);
      expect(line).toMatch(/[.)]$/);
      expect(line).not.toMatch(/\n/);
    }
  });
});

describe("nextStep while the workstream waits on the reporter", () => {
  const waiting = (runs: Run[], over: Over = {}, since = iso(60 * 24 * 3)): WorkstreamView => ({ ...view(runs, over), waitingOnReporter: { since } });
  const line = (v: WorkstreamView, runs: Run[], proposals: Proposal[] = [], events: Parameters<typeof nextStep>[5] = []) => nextStep(v, runs, proposals, needsOf(v, runs, proposals), AUTOSTART_DEFAULTS, events, new Date(NOW));

  it("says since when and that nothing starts on its own, and it is not a need", () => {
    const runs = [run("t", "triage", "done")];
    const v = waiting(runs, { stage: "triage" }, iso(60 * 24 * 1));
    expect(line(v, runs)).toMatchObject({ kind: "reporter", need: null, text: "Next: Waiting on the reporter since yesterday; nothing starts on its own." });
    expect(line(v, runs)?.nudge).toBeUndefined();
    expect(needsOf(v, runs)).toEqual([]);
  });

  it("offers a nudge once the reporter has been silent for 2 days, never as a need, and not while one waits", () => {
    const runs = [run("t", "triage", "done")];
    const v = waiting(runs, { stage: "triage" });
    expect(line(v, runs)).toMatchObject({ kind: "reporter", need: null, nudge: true, text: "Next: Waiting on the reporter since 3 days ago; nothing starts on its own. The reporter hasn't answered for 3 days. You can draft a nudge." });
    expect(needsOf(v, runs)).toEqual([]);
    expect(line(waiting(runs, { stage: "triage" }, iso(60 * 24 * 2)), runs)?.nudge).toBe(true);
    expect(line(waiting(runs, { stage: "triage" }, iso(60 * 24 * 2 - 60)), runs)?.nudge).toBeUndefined();
    const drafted = { ...applied("n1", "b"), state: { type: "pending" } as const, label: "Nudge for the reporter", createdBy: "user", intent: { type: "comment", item: ref("CA-401"), body: "Hi", mentions: [] } as unknown as Intent, origin: { type: "chat", requestId: "nudge:w", workstream: v.workstream.id } } as Proposal;
    expect(line(v, runs, [drafted])?.nudge).toBeUndefined();
  });

  it("gives way to a hold, to anything that decides or unblocks, and to a step in hand", () => {
    const going = [run("t", "triage", "working")];
    expect(line(waiting(going, { stage: "triage" }), going)?.kind).not.toBe("reporter");
    expect(line(waiting([], { heldReason: HELD_PERSON }), [])?.kind).toBe("held");
    const failed = [run("b", "build", "failed")];
    expect(line(waiting(failed), failed)?.kind).toBe("waiting");
  });

  it("is gone once the wait is", () => {
    expect(line(view([]), [])?.kind).not.toBe("reporter");
  });
});
