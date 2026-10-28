import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend/mock";
import type { Intent, ItemRef, PauseReason, Proposal, ProposalState, Run, RunState, WorkstreamStage, WorkstreamView } from "../types";
import { docFromText } from "./docs";
import { BATCHABLE, GROUP_RANK, chipLabel, byRank, higherPriority, needAfter, needGroups, needs, needsIn, leftOutLabel, repeatedComments, safeToBatch, titleFromTicketBlock, type Need, type NeedKind, type NeedsInput } from "./needs";

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
  lastProgressAt: iso(5),
  endedAt: null,
  ...over,
});

const view = (id: string, key: string | null, over: { pausedReason?: PauseReason | null; stage?: WorkstreamStage; runs?: string[]; createdAt?: string; title?: string; closedAt?: string | null; pipAsk?: WorkstreamView["pipAsk"] } = {}): WorkstreamView => ({
  workstream: {
    id,
    connectionId: "mock",
    itemKey: key,
    repo: null,
    title: over.title ?? (key ? `${key} Something` : "Ticketless"),
    pipSession: null,
    pausedReason: over.pausedReason ?? null,
    notes: null,
    createdAt: over.createdAt ?? iso(600),
    closedAt: over.closedAt ?? null,
    basis: null,
  },
  ...(over.pipAsk ? { pipAsk: over.pipAsk } : {}),
  stage: over.stage ?? "intake",
  runs: over.runs ?? [],
  labels: (over.runs ?? []).map((r, n) => [r, `R${n + 1}`]),
  waitingForPr: null,
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
const startRun = (key: string, kind: string, workstream: string | null): Intent => ({ type: "startRun", item: ref(key), spec: { ...base.spec, kind, workstream } }) as unknown as Intent;
const answer = (runId: string): Intent => ({ type: "runAnswer", item: ref("CA-401"), runId, message: "Yes", question: "q" }) as unknown as Intent;
const review = (): Intent => ({ type: "githubReview", item: ref("CA-401"), connectionId: "github", repo: "acme/shop", number: 7, runId: "r-rev", summary: "s", comments: [] }) as unknown as Intent;

const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({ workstreams: [], runs: [], proposals: [], dismissed: new Set(), ...over });
const kinds = (list: readonly Need[]) => list.map((n) => n.kind);
describe("needs: every kind", () => {
  const ws1 = view("ws-1", "CA-401", { runs: ["r-q", "r-p", "r-f", "r-limit", "r-b", "r-rev", "r-plan"] });

  it("finds each kind of wait in its group, with the words that say it", () => {
    const list = needs(
      input({
        workstreams: [ws1, view("ws-2", "CA-402", { pausedReason: "ceiling", createdAt: iso(50) })],
        proposals: [
          draft("d-comment", comment("CA-401"), 20),
          draft("d-review", review(), 26),
          draft("d-desc", rewrite("CA-401"), 27),
          draft("d-plan", rewrite("CA-401"), 28, { origin: { type: "run", runId: "r-plan", shortId: null, workstream: "ws-1" } }),
        ],
        runs: [
          run("r-q", "triage", "needsAnswer", { needs: "Which cache?" }),
          run("r-p", "build", "needsPermission", { needs: "approve Bash: git push origin ca-401" }),
          run("r-f", "verify", "failed", { error: "boom", endedAt: iso(13) }),
          run("r-plan", "plan", "done"),
          run("r-sign", "investigate", "systemBlocked", { spec: { ...base.spec, role: "investigate", workstream: null }, item: null }),
        ],
      }),
    );
    const by = (kind: NeedKind) => list.filter((n) => n.kind === kind);
    expect(Object.fromEntries(list.map((n) => [n.kind, n.group]))).toEqual({
      plan: "decide",
      description: "decide",
      question: "unblock",
      permission: "unblock",
      failure: "unblock",
      signIn: "unblock",
      paused: "unblock",
      draft: "approve",
      review: "approve",
    });
    expect(list).toHaveLength(9);
    expect(by("plan")[0].target).toEqual({ type: "draft", id: "d-plan" });
    // The run's label is a parenthesis, not the subject: "R1 plan wrote the plan" reads wrong once the run is brought into a workstream (G12).
    expect(by("plan")[0].why).toMatch(/^An agent wrote the plan for CA-401 \(run R\d+\); approving/);
    expect(by("description")[0].title).toBe("Draft rewrite");
    expect(by("paused")[0]).toMatchObject({ title: "Paused: Pip was woken too often today", workstreamId: "ws-2", target: { type: "workstream" } });
    expect(by("question")[0]).toMatchObject({ title: "R1 asks a question", target: { type: "run", id: "r-q" }, runId: "r-q" });
    expect(by("permission")[0].title).toBe("R2 asks to run a command");
    expect(by("failure")[0].title).toBe("R3 failed");
    expect(by("draft")[0].target).toEqual({ type: "draft", id: "d-comment" });
    expect(by("review")[0].title).toBe("Draft review");
  });

  it("says why and what waiting does in one plain sentence each, for every kind", () => {
    const list = needs(
      input({
        workstreams: [view("ws-1", "CA-401", { runs: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"], pausedReason: "person" })],
        proposals: [draft("d1", comment("CA-401"), 20), draft("d3", review(), 26), draft("d4", rewrite("CA-401"), 27), draft("d5", subtasks("CA-401"), 28)],
        runs: [
          run("r1", "triage", "needsAnswer", { needs: "Which cache?" }),
          run("r2", "build", "needsPermission", { needs: "approve Bash: git push origin ca-401" }),
          run("r3", "verify", "failed", { error: "boom" }),
          run("r7", "investigate", "systemBlocked"),
        ],
      }),
    );
    expect(list.length).toBeGreaterThanOrEqual(8);
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
    expect(list.find((n) => n.kind === "draft" && n.target.type === "draft" && n.target.id === "d1")!.ifYouWait).toBe("It stays here until you decide.");
    expect(list.find((n) => n.kind === "review")!.ifYouWait).toBe("It stays here until you decide.");
    expect(list.find((n) => n.kind === "question")!.why).toBe("R1 asks: “Which cache?”");
  });

  it("names the tool when a permission is for something other than a command", () => {
    const [n] = needs(input({ workstreams: [view("ws-1", "CA-401", { runs: ["r1"] })], runs: [run("r1", "build", "needsPermission", { needs: "approve Edit: src/cart.ts" })] }));
    expect(n.why).toBe("R1 wants to use Edit on `src/cart.ts`.");
  });

  it("offers one way on for a permission prompt: Open in Terminal, whichever role asks", () => {
    const ws = view("ws-1", "CA-401", { runs: ["r1"] });
    for (const role of ["investigate", "build", "profiler"]) {
      const [n] = needs(input({ workstreams: [ws], runs: [run("r1", role, "needsPermission", { needs: "approve Bash: git push", spec: { ...base.spec, role, workstream: "ws-1" } })] }));
      expect([n.title, n.primary, n.secondary]).toEqual(["R1 asks to run a command", { id: "open", label: "Open in Terminal" }, []]);
    }
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
        workstreams: [ws],
        proposals: [draft("old-draft", comment("CA-401"), 90), draft("rewrite", rewrite("CA-401"), 1)],
        runs: [run("r1", "investigate", "failed", { lastProgressAt: iso(80) })],
      }),
    );
    expect(list.map((n) => n.group)).toEqual(["decide", "unblock", "approve"]);
    expect(kinds(list)).toEqual(["description", "failure", "draft"]);
    expect(GROUP_RANK).toEqual({ decide: 0, unblock: 1, approve: 2 });
  });

  it("is oldest first within a group, then by key", () => {
    const list = needs(
      input({
        workstreams: [view("ws-1", "CA-401", { pausedReason: "person" })],
        proposals: [draft("new", comment("CA-401"), 2), draft("old", comment("CA-401"), 40), draft("same-b", comment("CA-401"), 10), draft("same-a", comment("CA-401"), 10)],
        runs: [run("r1", "investigate", "failed", { lastProgressAt: iso(10) }), run("r2", "triage", "needsAnswer", { lastProgressAt: iso(3) })],
        pausedAt: { "ws-1": iso(5) },
      }),
    );
    expect(list.map((n) => n.key)).toEqual(["run:r1", "paused:ws-1", "run:r2", "draft:old", "draft:same-a", "draft:same-b", "draft:new"]);
    expect(byRank({ group: "approve", at: iso(1), key: "a" }, { group: "decide", at: iso(99), key: "b" })).toBeGreaterThan(0);
  });

  it("counts a pause from when it was last paused, and from its workstream's opening when that isn't known", () => {
    const held = view("ws-1", "CA-401", { pausedReason: "person", createdAt: iso(300) });
    const run1 = run("r1", "investigate", "needsAnswer", { lastProgressAt: iso(100) });
    expect(kinds(needs(input({ workstreams: [held], runs: [run1], pausedAt: { "ws-1": iso(5) } })))).toEqual(["question", "paused"]);
    expect(kinds(needs(input({ workstreams: [held], runs: [run1] })))).toEqual(["paused", "question"]);
  });
});

describe("needs: pauses", () => {
  const paused = (reason: PauseReason) => view("ws-1", "CA-401", { pausedReason: reason });

  it("makes a need of every pause, with Resume as its action", () => {
    expect(needs(input({ workstreams: [paused("person")] }))[0]).toMatchObject({
      key: "paused:ws-1",
      group: "unblock",
      kind: "paused",
      workstreamId: "ws-1",
      ticketKey: "CA-401",
      title: "Paused",
      why: "You paused it.",
      primary: { id: "resume", label: "Resume" },
      target: { type: "workstream" },
      batchable: false,
    });
    expect(needs(input({ workstreams: [paused("ceiling")] }))[0]).toMatchObject({ title: "Paused: Pip was woken too often today", why: "Pip was woken too often today, so Gossamr paused it." });
  });

  it("makes nothing of a workstream that isn't paused", () => {
    expect(needs(input({ workstreams: [view("ws-1", "CA-401")] }))).toEqual([]);
  });

  it("leaves the other needs in a paused workstream as they are", () => {
    const list = needs(input({ workstreams: [paused("person")], runs: [run("r1", "investigate", "failed")] }));
    expect(kinds(list).sort()).toEqual(["failure", "paused"]);
  });
});

describe("needs: a triage's description update", () => {
  it("is an Approve draft read in its diff, never in the safe batch, like the comment it stands in for; a plan's and a person's rewrite stay a Decide", () => {
    const triage = run("t-1", "triage", "done");
    const plan = run("p-1", "plan", "done");
    const from = (runId: string): Proposal["origin"] => ({ type: "run", runId, shortId: null, workstream: "ws-1" });
    const note = { ...draft("d-note", rewrite("CA-401"), 3, { workstream: "ws-1", origin: from("t-1") }), createdBy: "agent" } as Proposal;
    const approved = { ...draft("d-plan", rewrite("CA-401"), 2, { workstream: "ws-1", origin: from("p-1") }), createdBy: "agent" } as Proposal;
    const own = draft("d-own", rewrite("CA-401"), 1, { workstream: "ws-1" });
    const list = needs(input({ workstreams: [view("ws-1", "CA-401", { runs: ["t-1", "p-1"] })], runs: [triage, plan], proposals: [note, approved, own] }));
    const by = (key: string) => list.find((n) => n.key === key)!;
    expect(by("draft:d-note")).toMatchObject({ group: "approve", kind: "description", batchable: false, ifYouWait: "It stays here until you decide." });
    expect(by("draft:d-plan")).toMatchObject({ group: "decide", kind: "plan", title: "Approve the plan" });
    expect(by("draft:d-own")).toMatchObject({ group: "decide", kind: "description" });
    expect(safeToBatch(note)).toBe(false);
  });
});

describe("needs: folding", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1", "r-b", "r-rev"] });

  it("ignores the history of drafts that started or messaged an agent: only a question the run asks is a need", () => {
    const asking = run("r1", "triage", "needsAnswer", { needs: "Which cache?" });
    const list = needs(input({ workstreams: [ws], runs: [asking], proposals: [draft("reply", answer("r1"), 3), draft("start", startRun("CA-401", "build", "ws-1"), 2)] }));
    expect(list.map((n) => [n.key, n.kind, n.target])).toEqual([["run:r1", "question", { type: "run", id: "r1" }]]);
    expect(list[0].primary.id).toBe("answer");
    expect(needs(input({ workstreams: [ws], runs: [run("r1", "triage", "working")], proposals: [draft("reply", answer("r1"), 3)] }))).toEqual([]);
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
    const closed: WorkstreamView = { ...view("ws-9", "CA-409"), workstream: { ...view("ws-9", "CA-409").workstream, closedAt: iso(1), pausedReason: "person" } };
    const list = needs(input({ workstreams: [closed], proposals: [draft("d", comment("CA-409"), 5, { workstream: "ws-9" })] }));
    expect(list.map((n) => [n.key, n.workstreamId])).toEqual([["draft:d", null]]);
  });

  it("counts an agent's question and a draft in a closed workstream under General, as the notices in Rust do", () => {
    const closed = view("ws-9", "CA-409", { closedAt: iso(1), runs: ["r1"] });
    const list = needs(input({ workstreams: [closed], runs: [run("r1", "build", "needsPermission", { spec: { ...base.spec, workstream: "ws-9" }, needs: "approve Bash: git push" })], proposals: [draft("d", comment("CA-409"), 5, { workstream: "ws-9" })] }));
    expect(list.map((n) => [n.key, n.workstreamId])).toEqual([
      ["run:r1", null],
      ["draft:d", null],
    ]);
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

describe("needs: the runs that are never a need", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1"] });
  const only = (r: Run, extra: Partial<NeedsInput> = {}) => needs(input({ workstreams: [ws], runs: [r], ...extra }));

  it("never makes a need of a stopped run", () => {
    const stopped = run("r1", "plan", "stopped", { error: "Stopped before it started" });
    expect(only(stopped)).toEqual([]);
  });

  it("leaves out a run stopped by the person, a finished run and a queued one", () => {
    expect(only(run("r1", "build", "stopped"))).toEqual([]);
    expect(only(run("r1", "build", "done"))).toEqual([]);
    expect(only(run("r1", "build", "queued"))).toEqual([]);
    expect(only(run("r1", "build", "launching"))).toEqual([]);
  });

  it("leaves out a run that has been quiet, one whose session is not listed until the backend calls it failed, and one that may have carried on elsewhere", () => {
    expect(only(run("r1", "build", "working", { lastProgressAt: iso(300) }))).toEqual([]);
    expect(only(run("r1", "build", "unknown", { error: "This session isn't listed any more" }))).toEqual([]);
    expect(only(run("r1", "build", "stopped", { possibleContinuations: [{ shortId: "abc12345" }] }))).toEqual([]);
  });
});

describe("needs: a failure is a need only while it is the latest of its kind on its ticket", () => {
  const ws = view("ws-1", "CA-401", { runs: ["r1", "r2", "r3"] });
  const only = (runs: Run[], extra: Partial<NeedsInput> = {}) => needs(input({ workstreams: [ws], runs, ...extra }));
  const failedAt = (id: string, minutesAgo: number, over: Partial<Run> = {}) => run(id, "plan", "failed", { queuedAt: iso(minutesAgo), error: "boom", ...over });
  const trust = { shortId: null, failure: { type: "untrustedFolder", path: "/work/shop" } } as const;

  it("collapses several plan runs that failed for the same untrusted folder into one need, on the latest run", () => {
    const list = only([failedAt("r1", 90, trust), failedAt("r2", 60, trust), failedAt("r3", 30, trust)]);
    expect(list.map((n) => [n.kind, n.runId])).toEqual([["failure", "r3"]]);
    expect(list[0].title).toBe("R3 needs its folder trusted");
  });

  it("drops a failure once a newer run of the same kind on the ticket is running or finished", () => {
    for (const state of ["working", "done", "queued", "needsAnswer"] as const) {
      const newer = run("r2", "plan", state, { queuedAt: iso(10), needs: state === "needsAnswer" ? "Which?" : null });
      expect(only([failedAt("r1", 60), newer]).map((n) => n.runId), state).not.toContain("r1");
    }
  });

  it("drops a failure that a newer run failed again, keeping the newer one", () => {
    expect(only([failedAt("r1", 60), failedAt("r2", 10)]).map((n) => n.runId)).toEqual(["r2"]);
  });

  it("keeps a failure when the newer run is another kind or on another ticket", () => {
    const otherKind = run("r2", "build", "done", { queuedAt: iso(10) });
    const otherTicket = run("r3", "plan", "done", { queuedAt: iso(10), item: ref("CA-999") });
    expect(only([failedAt("r1", 60), otherKind, otherTicket]).map((n) => n.runId)).toEqual(["r1"]);
  });

  it("tells tickets of different connections apart even when they share a key", () => {
    const other = { connectionId: "other", externalId: "CA-401", key: "CA-401" };
    const newer = run("r2", "plan", "done", { queuedAt: iso(5), item: other, connectionId: "other" });
    expect(only([failedAt("r1", 60), newer]).map((n) => n.runId)).toEqual(["r1"]);
  });

  it("keeps an older run's failure only while no newer run exists, so a retry that succeeds clears it", () => {
    const failed = failedAt("r1", 60, trust);
    expect(only([failed])).toHaveLength(1);
    expect(only([failed, run("r2", "plan", "done", { queuedAt: iso(5) })])).toEqual([]);
  });

  it("drops a failure the person dismissed", () => {
    expect(only([failedAt("r1", 60)], { dismissed: new Set(["r1"]) })).toEqual([]);
  });

  it("leaves a stuck question or permission alone when a newer run exists: it is still waiting on an answer", () => {
    const asking = run("r1", "plan", "needsAnswer", { queuedAt: iso(60), needs: "Which?" });
    expect(kinds(only([asking, run("r2", "plan", "done", { queuedAt: iso(5) })]))).toEqual(["question"]);
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
        runs: [run("own", "investigate", "needsAnswer"), run("loose", "investigate", "needsAnswer", { spec: { ...base.spec, role: "investigate", workstream: null }, item: ref("CA-500") })],
      }),
    );
    expect(Object.fromEntries(list.map((n) => [n.key, n.workstreamId]))).toEqual({ "draft:made-in": "ws-3", "draft:on-ticket": "ws-1", "draft:closed-ws": null, "draft:elsewhere": null, "run:own": "ws-1", "run:loose": null });
    expect(needsIn(list, "ws-1")).toBe(2);
    expect(needsIn(list, "ws-3")).toBe(1);
    expect(needsIn(list, null)).toBe(3);
  });

  it("gives a ticket no cache holds the title its run kept in its snapshot, so every need reads KEY · Title", () => {
    expect(titleFromTicketBlock("SUP-9: Export timeout\nKind: task | Status: Open", "SUP-9")).toBe("Export timeout");
    expect(titleFromTicketBlock("SUP-90: Something else", "SUP-9")).toBeNull();
    expect(titleFromTicketBlock(null, "SUP-9")).toBeNull();
    const failed = run("f", "investigate", "failed", { item: ref("SUP-9"), spec: { ...base.spec, role: "investigate", workstream: null, ticketBlock: "SUP-9: Export timeout\nDescription: none." } });
    expect(needs(input({ runs: [failed] })).map((n) => n.head)).toEqual(["SUP-9 · Export timeout"]);
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
    const others = needs(input({ workstreams: [ws1], proposals: [draft("a", rewrite("CA-401"), 5), draft("b", review(), 4), draft("c", rewrite("CA-401"), 3)] }));
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

describe("Pip asks you", () => {
  const ws = (over: Parameters<typeof view>[2] = {}) => view("ws-1", "CA-401", { pipAsk: { question: "Which clone should I use for the build?", at: iso(7) }, ...over });

  it("is a Decide need from ask_person, in its workstream, opening the conversation", () => {
    const [n] = needs(input({ workstreams: [ws()] }));
    expect(n).toMatchObject({ key: "pip-ask:ws-1", group: "decide", kind: "pipAsk", workstreamId: "ws-1", title: "Pip asks you", target: { type: "workstream" } });
    expect(n.why).toBe("Pip asks: “Which clone should I use for the build?”");
    expect([n.primary.id, n.secondary.map((a) => a.id)]).toEqual(["reply", ["dismiss"]]);
    expect(n.at).toBe(ws().pipAsk!.at);
  });

  it("is gone once the question is answered or dismissed, and never for a closed workstream", () => {
    expect(needs(input({ workstreams: [ws({ pipAsk: null })] }))).toEqual([]);
    expect(needs(input({ workstreams: [ws({ pipAsk: undefined })] }))).toEqual([]);
    const closed = view("ws-1", "CA-401", { closedAt: iso(1), pipAsk: { question: "Still there?", at: iso(7) } });
    expect(needs(input({ workstreams: [closed] }))).toEqual([]);
  });

  it("ranks with the decisions, ahead of what is stuck and what waits for approval", () => {
    const list = needs(input({ workstreams: [ws()], runs: [run("r1", "build", "needsPermission", { needs: "approve Bash: git push" })], proposals: [draft("d1", comment("CA-401"), 20)] }));
    expect(list.map((n) => n.kind)).toEqual(["pipAsk", "permission", "draft"]);
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
    expect(chipLabel({ group: "decide", kind: "plan" })).toBe("Decide");
    const list = needs(input({ proposals: [draft("d-review", review(), 26)] }));
    expect(list[0]).toMatchObject({ kind: "review", group: "approve" });
    expect(chipLabel(list[0])).toBe("Post");
  });

  it("is the verb of the need's main button in Approve, so the tag and the button agree (G34)", () => {
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
