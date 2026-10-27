import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Intent, ItemRef, Proposal, Run, RunState, PauseReason, WorkstreamStage, WorkstreamView } from "../types";
import { needs as buildNeeds, type Need } from "./needs";
import { docFromText } from "./docs";
import { nextStep } from "./nextStep";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ref = (key: string): ItemRef => ({ connectionId: "mock", externalId: key, key });

const base = new MockBackend().runs.list()[0];
const run = (id: string, kind: string, state: RunState, over: Partial<Run> = {}): Run => ({
  ...base,
  id,
  state,
  item: ref("CA-401"),
  spec: { ...base.spec, role: kind, workstream: "ws-1" },
  failure: null,
  needs: null,
  queuedAt: iso(60),
  lastProgressAt: iso(1),
  endedAt: state === "done" ? iso(10) : null,
  slotWaitSince: null,
  ...over,
});

interface Over {
  pausedReason?: PauseReason | null;
  stage?: WorkstreamStage;
  waitingForPr?: string | null;
  reviewBlocking?: boolean;
  closedAt?: string | null;
}

/** A workstream on CA-401 whose runs are `runs`, named R1, R2 and so on in the order given. */
const view = (runs: Run[], over: Over = {}): WorkstreamView => ({
  workstream: {
    id: "ws-1",
    connectionId: "mock",
    itemKey: "CA-401",
    repo: null,
    title: "CA-401 Something",
    pipSession: null,
    pausedReason: over.pausedReason ?? null,
    notes: null,
    createdAt: iso(600),
    closedAt: over.closedAt ?? null,
    basis: null,
  },
  stage: over.stage ?? "intake",
  runs: runs.map((r) => r.id),
  labels: runs.map((r, n) => [r.id, `R${n + 1}`]),
  waitingForPr: over.waitingForPr ?? null,
  reviewBlocking: over.reviewBlocking ?? false,
});

const needsOf = (v: WorkstreamView, runs: Run[], proposals: Proposal[] = []): Need[] => buildNeeds({ workstreams: [v], runs, proposals, dismissed: new Set() });
const next = (runs: Run[], over: Over = {}, proposals: Proposal[] = []) => {
  const v = view(runs, over);
  return nextStep(v, runs, needsOf(v, runs, proposals));
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
  it("says Pip is woken when it finishes, naming the run and its step", () => {
    expect(next([run("b", "build", "working")], { stage: "build" })).toMatchObject({ kind: "running", need: null, text: "Next: when R1 (Build) finishes, Pip is woken to decide what comes next." });
    expect(text([run("i", "investigate", "working")])).toBe("Next: when R1 (Investigate) finishes, Pip is woken to decide what comes next.");
  });

  it("is a launching or queued run's line too", () => {
    expect(next([run("b", "build", "launching")])?.kind).toBe("running");
    expect(next([run("b", "build", "queued")])?.kind).toBe("running");
  });
});

describe("nextStep when the person is waited on", () => {
  it("links to the top need and says why it is asked", () => {
    const runs = [run("b", "build", "needsPermission", { needs: "git push origin ca-401" })];
    const v = view(runs);
    const list = needsOf(v, runs);
    const result = nextStep(v, runs, list);
    expect(result).toMatchObject({ kind: "waiting", text: "Next: waiting on you. R1 wants to run `git push origin ca-401`." });
    expect(result?.need).toBe(list[0]);
    expect(result?.need?.key).toBe("run:b");
  });

  it("takes the highest-ranked need of the workstream, not another workstream's", () => {
    const runs = [run("b", "build", "needsAnswer", { needs: "Which branch?" }), run("x", "build", "needsPermission", { needs: "rm -rf x", spec: { ...base.spec, role: "build", workstream: "ws-other" } })];
    const v = view(runs.slice(0, 1));
    const result = nextStep(v, runs, needsOf(v, runs));
    expect(result?.need?.key).toBe("run:b");
    expect(result?.text).toContain("R1 asks");
  });

  it("names the plan approval that unblocks Build before an older need, and counts the others", () => {
    const rewrite = (id: string, from: string | null, ago: number): Proposal => ({ ...applied(id, from ?? "x"), createdAt: iso(ago), state: { type: "pending" } as const, origin: from ? { type: "run", runId: from, shortId: null } : { type: "chat", requestId: "q", workstream: "ws-1" } } as Proposal);
    const runs = [run("t", "triage", "done"), run("p", "plan", "done")];
    const v = view(runs);
    const list = needsOf(v, runs, [rewrite("d-old", "t", 500), rewrite("d-plan", "p", 5)]);
    const result = nextStep(v, runs, list);
    expect(result?.need?.kind).toBe("plan");
    expect(result?.text).toMatch(/wrote the plan.* \(\+1 more waiting\)\.?$/);
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
    const draft = { ...applied("d1", "b"), state: { type: "pending" } as const, intent: { type: "comment", item: ref("CA-401"), body: docFromText("Hi"), mentions: [] } as unknown as Intent, origin: { type: "chat", requestId: "q", workstream: "ws-1" } } as Proposal;
    expect(next([run("b", "build", "working")], {}, [draft])?.kind).toBe("running");
    const idle = next([run("b", "build", "done")], { stage: "build" }, [draft]);
    expect(idle?.kind).toBe("waiting");
    expect(idle?.need?.kind).toBe("draft");
  });

  it("is not waiting on a draft while a step is queued; it is once nothing is", () => {
    const draft = { ...applied("d1", "b"), state: { type: "pending" } as const, intent: { type: "comment", item: ref("CA-401"), body: docFromText("Hi"), mentions: [] } as unknown as Intent, origin: { type: "chat", requestId: "q", workstream: "ws-1" } } as Proposal;
    expect(next([run("b", "build", "queued")], { stage: "build" }, [draft])).toMatchObject({ kind: "running", need: null });
    expect(next([], {}, [draft])).toMatchObject({ kind: "waiting" });
    expect(next([run("b", "build", "done")], { stage: "build" }, [draft])?.kind).toBe("waiting");
  });

  it("is waiting on a failed run, which stays a need until dealt with", () => {
    expect(next([run("b", "build", "failed", { error: "boom" })])).toMatchObject({ kind: "waiting" });
  });
});

describe("nextStep when paused", () => {
  it("says it is paused with the reason and that Resume continues", () => {
    expect(next([run("b", "build", "working")], { pausedReason: "person" })).toMatchObject({ kind: "paused", text: "Next: paused. Resume to continue.", need: null });
    expect(text([], { pausedReason: "ceiling" })).toBe("Next: paused: Pip was woken too often today. Resume to continue.");
  });

  it("outranks every other line, a waiting need included", () => {
    const runs = [run("b", "build", "needsPermission", { needs: "ls" })];
    expect(next(runs, { pausedReason: "person" })?.kind).toBe("paused");
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
});

describe("nextStep when a run waits for a slot", () => {
  it("says it starts when a slot frees, with its place in line", () => {
    const queued = (id: string, minutesAgo: number, workstream = "ws-1") => run(id, "review", "queued", { slotWaitSince: iso(minutesAgo), queuedAt: iso(minutesAgo), spec: { ...base.spec, role: "review", workstream } });
    const first = queued("a", 5, "ws-other");
    const mine = queued("b", 3);
    const v = view([mine]);
    expect(nextStep(v, [first, mine], [])).toMatchObject({ kind: "slot", text: "Next: R1 starts when a slot frees (2nd in line)." });
    expect(nextStep(v, [mine], [])?.text).toBe("Next: R1 starts when a slot frees (1st in line).");
  });
});

describe("nextStep after the last run finished", () => {
  it("says nothing is running after a run that finished, failed or stopped, and when there are no runs", () => {
    expect(text([run("t", "triage", "done")])).toBe("Next: nothing is running after R1 (Triage) finished. Ask Pip or use ⌘K to start the next step.");
    expect(text([run("b", "build", "stopped")])).toBe("Next: nothing is running after R1 (Build) stopped. Ask Pip or use ⌘K to start the next step.");
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
    expect(nextStep(v, [run("b", "build", "working"), other], [])?.kind).toBe("running");
  });

  it("always starts with Next: and is one sentence", () => {
    const cases: Run[][] = [[], [run("a", "investigate", "working")], [run("a", "build", "done")], [run("a", "review", "working")], [run("a", "plan", "failed")]];
    for (const runs of cases) for (const over of [{}, { pausedReason: "person" as const }, { pausedReason: "ceiling" as const }]) {
      const line = next(runs, over)?.text ?? "";
      expect(line).toMatch(/^Next: /);
      expect(line).toMatch(/[.)]$/);
      expect(line).not.toMatch(/\n/);
    }
  });
});
