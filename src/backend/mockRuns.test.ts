import { describe, expect, it } from "vitest";
import type { Intent, ItemRef, Run, RunSpec } from "../types";
import { MockBackend } from "./mock";
import { itemRef } from "./mockConnector";
import { commentText, jiraNote } from "./mockRunResult";
import { FINDINGS_LIMIT, FINDINGS_PREFACE, PLAN_FOLLOW, PLAN_FOLLOW_UNEDITED, READ_ONLY_GUARD, readOnlyRules, specProblem, withoutMarkers } from "./mockRunKinds";
import { MockSupervisor } from "./mockSupervisor";
import { MockWorkstreams } from "./mockWorkstreams";
import { DENIED_MESSAGE } from "../lib/permission";
import { RESUME_TEXT } from "../workspace/runSheetLogic";
import { AGENT_GUARD, GUARD as GUARD_TEXT, findingsFitted, mockDigest, renderPrompt } from "./mockRuns";

const spec: RunSpec = {
  kind: "investigate",
  repo: "acme/storefront",
  clonePath: "/Users/sample/Code/storefront",
  base: "main",
  name: "ca-412-fix-ab12",
  instruction: "Investigate this work.",
  focus: null,
  focusFromRun: null,
  ticketBlock: "CA-412: sample",
};

/** Queues a run the way Pip's start does, with the ticket text and everything carried in from earlier runs read here. */
const queue = (backend: MockBackend, over: Partial<RunSpec> = {}, item: ItemRef | null = itemRef("CA-412")): Run => backend.runs.start({ ...spec, ...over }, item);
/** The spec a start would store for `over`, or why it is refused. */
const prepared = (backend: MockBackend, over: Partial<RunSpec>, item: ItemRef | null = itemRef("CA-412")): RunSpec => backend.runs.prepare({ ...spec, ...over }, item);
/** Why a start of `over` is refused, or "started". */
const refusal = (backend: MockBackend, over: Partial<RunSpec>, item: ItemRef | null = itemRef("CA-412")): string => {
  try {
    queue(backend, over, item);
    return "started";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("mock runs", () => {
  it("starts with eight scripted runs covering every lane", async () => {
    const runs = await new MockBackend().runsList();
    expect(runs).toHaveLength(8);
    const states = runs.map((r) => r.state).sort();
    expect(states).toEqual(["done", "done", "failed", "needsAnswer", "needsPermission", "working", "working", "working"]);
    const now = Date.parse("2026-09-30T12:00:00Z");
    const quiet = runs.filter((r) => r.state === "working" && now - Date.parse(r.lastProgressAt) >= 30 * 60_000);
    expect(quiet).toHaveLength(1);
    expect(runs.find((r) => r.state === "needsPermission")?.needs).toMatch(/^approve Bash:/);
  });

  it("is deterministic", async () => {
    const [a, b] = [await new MockBackend().runsList(), await new MockBackend().runsList()];
    expect(a).toEqual(b);
  });

  it("queues a run Pip started: no draft behind it, the digest of what it was given, and a line in its workstream", async () => {
    const backend = new MockBackend();
    const ws = backend.workstreams.open(itemRef("CA-401")).id;
    const run = queue(backend, { workstream: ws }, itemRef("CA-401"));
    expect(run).toMatchObject({ state: "queued", proposalId: "", createdBy: "pip", digest: mockDigest({ ...spec, ...run.spec }), expectedWorktree: "/Users/sample/Code/storefront/.claude/worktrees/ca-412-fix-ab12" });
    expect(run.origin).toMatchObject({ type: "chat", workstream: ws });
    expect(backend.workstreams.events(ws).filter((e) => e.action === "agent_started")).toEqual([expect.objectContaining({ actor: "pip", runId: run.id, detail: "investigate · conversation" })]);
    expect((await backend.runsGet(run.id))?.id).toBe(run.id);
    expect(() => queue(backend, { workstream: ws }, itemRef("CA-401"))).toThrow(/already uses that worktree/);
  });

  it("makes no run draft by hand and approves none", async () => {
    const backend = new MockBackend();
    await expect(backend.proposalsCreate({ type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec })).rejects.toThrow("Pip starts and messages agents directly now");
    expect(await backend.runsList({ item: itemRef("CA-412") })).toHaveLength(0);
  });

  it("changes its digest when anything the agent receives changes", () => {
    const base = mockDigest(spec);
    for (const over of [{ instruction: "Other." }, { focus: "Look at the cache" }, { ticketBlock: "changed" }, { base: "dev" }, { name: "ca-412-fix-cd34" }]) {
      expect(mockDigest({ ...spec, ...over })).not.toBe(base);
    }
  });

  it("walks a run through its states with advance", async () => {
    const backend = new MockBackend();
    const run = queue(backend);
    const state = () => backend.runs.get(run.id)!.state;
    const seen = [state()];
    for (let i = 0; i < 4; i++) {
      backend.runs.advance(run.id);
      seen.push(state());
    }
    expect(seen).toEqual(["queued", "launching", "working", "done", "done"]);
    expect(backend.runs.get(run.id)).toMatchObject({ result: expect.any(String), endedAt: expect.any(String), shortId: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it("sends runs waiting on the person back to work and leaves finished ones alone", async () => {
    const backend = new MockBackend();
    const before = await backend.runsList();
    backend.runs.advance();
    const after = await backend.runsList();
    const stateOf = (list: typeof before, id: string) => list.find((r) => r.id === id)!.state;
    for (const r of before) {
      const next = stateOf(after, r.id);
      if (r.state === "needsPermission" || r.state === "needsAnswer") expect(next).toBe("working");
      if (r.state === "done" || r.state === "failed") expect(next).toBe(r.state);
    }
  });

  it("stops only runs that can be stopped", async () => {
    const backend = new MockBackend();
    const before = await backend.runsList();
    const active = before.filter((r) => ["working", "needsAnswer", "needsPermission", "systemBlocked"].includes(r.state));
    const { stopped, failed } = await backend.runsStopAll();
    expect({ stopped, failed }).toEqual({ stopped: active.length, failed: 0 });
    const after = await backend.runsList();
    for (const r of before.filter((x) => !active.includes(x))) expect(after.find((x) => x.id === r.id)?.state).toBe(r.state);
    expect(after.filter((r) => r.state === "stopped")).toHaveLength(active.length);
    expect(await backend.runsStopAll()).toEqual({ stopped: 0, failed: 0, waiting: 0 });
  });

  it("has a run waiting in its ask call, which an answer resolves at once and a question that ended its turn is not", async () => {
    const backend = new MockBackend();
    const waiting = backend.runs.list().find((r) => r.state === "needsAnswer")!;
    expect(waiting).toMatchObject({ asking: true, needs: "Should the refund path keep the old rounding?" });
    const answered = await backend.runsAnswer(waiting.id, "Yes, keep it.");
    expect(answered).toMatchObject({ state: "working", needs: null });
    expect(answered.asking).toBeFalsy();

    const working = backend.runs.list().find((r) => r.state === "working" && r.id !== waiting.id)!;
    expect(backend.runs.ask(working.id, "Which one?")).toMatchObject({ state: "needsAnswer", asking: false });
    expect(backend.runs.ask(working.id, "Which one?", true).asking).toBe(true);
  });

  it("answers a question, and only a question", async () => {
    const backend = new MockBackend();
    const [asking, permission] = ["needsAnswer", "needsPermission"].map((state) => backend.runs.list().find((r) => r.state === state)!);
    expect(asking.suggestedReply).toBeTruthy();
    await expect(backend.runsAnswer(asking.id, "   ")).rejects.toThrow(/Write an answer/);
    await expect(backend.runsAnswer(asking.id, "x".repeat(4001))).rejects.toThrow(/up to 4000 characters/);
    await expect(backend.runsAnswer(asking.id, "a\0b")).rejects.toThrow(/plain text/);
    await expect(backend.runsAnswer(permission.id, "Yes")).rejects.toThrow(/answer it with Allow once or Deny/);
    const after = await backend.runsAnswer(asking.id, "Yes");
    expect(after).toMatchObject({ id: asking.id, state: "working", needs: null, suggestedReply: null, shortId: asking.shortId });
    await expect(backend.runsAnswer(asking.id, "Again")).rejects.toThrow(/isn't waiting for an answer/);
  });

  it("records the answer in the run's timeline and clears what it said while it asked, as answer_keeping does", async () => {
    const backend = new MockBackend();
    const asking = backend.runs.list().find((r) => r.state === "needsAnswer")!;
    expect(asking.lastDetail).toBe("Waiting for an answer");
    expect((await backend.runsEvents(asking.id)).some((e) => e.kind === "answered")).toBe(false);
    const after = await backend.runsAnswer(asking.id, "Yes");
    expect(after.lastDetail).toBeNull();
    const events = await backend.runsEvents(asking.id);
    expect(events.filter((e) => e.kind === "answered").map((e) => [e.text, e.at])).toEqual([["You answered", after.lastProgressAt]]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(JSON.stringify(events)).not.toContain('"Yes"');
  });

  it("cancels a run that is only queued, before it launches, and refuses one that is launching (N8)", async () => {
    const backend = new MockBackend();
    const run = queue(backend);
    expect(await backend.runsStop(run.id)).toMatchObject({ state: "stopped", error: "Stopped before it started", shortId: null });
    const next = queue(backend, { name: `${spec.name}-2` });
    backend.runs.advance(next.id);
    await expect(backend.runsStop(next.id)).rejects.toThrow(/once it is working/);
  });

  it("offers the agent tools from launch, so a run stopped before it started was never offered them", async () => {
    const backend = new MockBackend();
    const run = queue(backend);
    await backend.runsStop(run.id);
    expect((await backend.runsOutcome(run.id)).report).toMatchObject({ offered: false });
  });

  it("emits runs-changed and open-run", async () => {
    const backend = new MockBackend();
    const changes: string[] = [];
    const opened: string[] = [];
    const off = [backend.onRunsChanged((c) => changes.push(c.connectionId)), backend.onOpenRun((id) => opened.push(id))];
    queue(backend);
    backend.runs.advance();
    backend.runs.open("run-seed-1");
    off.forEach((f) => f());
    backend.runs.advance();
    expect(changes).toEqual(["mock", "mock"]);
    expect(opened).toEqual(["run-seed-1"]);
  });

  it("attaches only to runs that have a session, and retries only failed ones", async () => {
    const backend = new MockBackend();
    const failed = (await backend.runsList({ states: ["failed"] }))[0];
    await expect(backend.runsAttach(failed.id)).rejects.toThrow(/no session/);
    await expect(backend.runsRetryLaunch((await backend.runsList({ states: ["working"] }))[0].id)).rejects.toThrow("This run is working and has nothing to retry.");
    expect((await backend.runsRetryLaunch(failed.id)).state).toBe("failed");
    await backend.runsTrustFolder(failed.id);
    expect((await backend.runsRetryLaunch(failed.id)).state).toBe("queued");
    const working = (await backend.runsList({ states: ["working"] }))[0];
    await backend.runsAttach(working.id);
    expect(backend.runs.attached).toEqual([working.id]);
  });

  it("has one failed launch of each kind, and the busy set's failed run is an untrusted folder", async () => {
    const failures = await new MockBackend({ runs: { seed: "failures" } }).runsList({ states: ["failed"] });
    expect(failures.map((r) => r.failure?.type).sort()).toEqual(["capReached", "claudeMissing", "noClone", "notSignedIn", "other", "untrustedFolder"]);
    for (const r of failures) expect([r.shortId, typeof r.error]).toEqual([null, "string"]);
    const [busy] = await new MockBackend().runsList({ states: ["failed"] });
    expect(busy.failure).toEqual({ type: "untrustedFolder", path: "/Users/sample/Code/storefront" });
    expect(busy.error).toContain("/Users/sample/Code/storefront");
  });

  it("opens Terminal to trust or sign in only for the failure it is meant for, and retry waits for it", async () => {
    const backend = new MockBackend({ runs: { seed: "failures" } });
    const by = async (type: string) => (await backend.runsList()).find((r) => r.failure?.type === type)!;
    const [untrusted, signedOut, other] = [await by("untrustedFolder"), await by("notSignedIn"), await by("other")];
    await expect(backend.runsTrustFolder(signedOut.id)).rejects.toThrow(/doesn't trust/);
    await expect(backend.runsSignIn(untrusted.id)).rejects.toThrow(/isn't signed in/);
    await expect(backend.runsTrustFolder(other.id)).rejects.toThrow();
    await expect(backend.runsTrustFolder("nope")).rejects.toThrow(/no longer exists/);
    expect((await backend.runsRetryLaunch(untrusted.id)).state).toBe("failed");
    expect((await backend.runsRetryLaunch(signedOut.id)).state).toBe("failed");
    expect(backend.runs.terminals).toEqual([]);

    await backend.runsTrustFolder(untrusted.id);
    await backend.runsSignIn(signedOut.id);
    expect(backend.runs.terminals).toEqual([untrusted.id, signedOut.id]);
    expect((await backend.runsRetryLaunch(untrusted.id)).state).toBe("queued");
    expect((await backend.runsRetryLaunch(signedOut.id)).state).toBe("queued");
    await expect(backend.runsTrustFolder(untrusted.id)).rejects.toThrow(/doesn't trust/);
  });

  it("can start empty or with many runs, and counts ages back from a chosen moment", async () => {
    expect(await new MockBackend({ runs: { seed: "empty" } }).runsList()).toEqual([]);
    const many = await new MockBackend({ runs: { seed: "many" } }).runsList();
    expect(many).toHaveLength(24);
    expect(new Set(many.map((r) => r.id)).size).toBe(24);
    expect(new Set(many.map((r) => r.expectedWorktree)).size).toBe(24);
    expect(many.some((r) => r.state === "stopped")).toBe(true);
    const epoch = Date.parse("2026-10-01T09:00:00Z");
    const [newest] = await new MockBackend({ runs: { epoch } }).runsList();
    expect(epoch - Date.parse(newest.queuedAt)).toBeLessThan(60 * 60_000);
  });
});

describe("mock runs of every kind", () => {
  const storefront = { repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront" };
  const webshop = { repo: "acme/webshop", clonePath: "/Users/sample/Code/webshop" };

  it("can add one scripted run of each other kind, with the build's pull request", async () => {
    const backend = new MockBackend({ runs: { seed: "kinds" } });
    const runs = await backend.runsList();
    expect(new Set(runs.map((r) => r.spec.kind))).toEqual(new Set(["investigate", "triage", "plan", "build", "review", "verify"]));
    const build = runs.find((r) => r.spec.kind === "build")!;
    expect((await backend.runsOutcome(build.id)).change).toMatchObject({ kind: "pullRequest" });
    expect(runs.find((r) => r.spec.kind === "review")!.spec.pr).toBe(331);
  });

  it("fills each kind's own instruction when the draft leaves it empty", async () => {
    const backend = new MockBackend();
    const item = itemRef("CA-412");
    expect(prepared(backend, { ...storefront, kind: "triage", instruction: "" }, item).instruction).toMatch(/^Triage this work/);
  });

  it("refuses a build without a ticket, a push outside a build and a pull request outside a review", async () => {
    const backend = new MockBackend();
    expect(refusal(backend, { ...storefront, kind: "build" }, null)).toContain("Build needs a ticket");
    expect(refusal(backend, { ...storefront, allowPush: true })).toContain("Only a build can push");
    expect(refusal(backend, { ...storefront, pr: 3 })).toContain("Only a review, or a verify after one, reads a pull request");
    expect(refusal(backend, { ...storefront, kind: "review" })).toContain("needs a pull request");
  });

  it("changes the digest with the push permission and the pull request", async () => {
    const build = { ...spec, kind: "build" as const };
    expect(mockDigest({ ...build, allowPush: true })).not.toBe(mockDigest(build));
    expect(mockDigest({ ...spec, ...storefront, kind: "review", pr: 1 })).not.toBe(mockDigest({ ...spec, ...storefront, kind: "review", pr: 2 }));
  });

  it("refuses to review a fork, a closed or a missing pull request at every step", async () => {
    const backend = new MockBackend({ githubRepos: 14 });
    await backend.watchSetMode("github:ada", "everything");
    const review = (pr: number) => ({ ...webshop, kind: "review" as const, pr });
    expect(refusal(backend, review(215), itemRef("CA-402"))).toContain("comes from a fork");
    expect(refusal(backend, review(190), itemRef("CA-402"))).toContain("is closed");
    expect(refusal(backend, review(999), itemRef("CA-402"))).toContain("wasn't found");
    expect(prepared(backend, review(212), itemRef("CA-402"))).toMatchObject({ pr: 212, prSha: "sha2120000", base: "main" });
  });

  it("leaves one GitHub review draft when a review finishes, with inline comments at the lines the diff shows, and the next round's replaces it", async () => {
    const backend = new MockBackend({ githubRepos: 14 });
    await backend.watchSetMode("github:ada", "everything");
    const ws = backend.workstreams.open(itemRef("CA-402")).id;
    let round = 0;
    const reviewOf218 = async () => {
      const run = queue(backend, { ...webshop, kind: "review", pr: 218, instruction: "", workstream: ws, name: `ca-402-review-${++round}` }, itemRef("CA-402"));
      for (let i = 0; i < 3; i++) backend.runs.advance(run.id);
      expect(backend.runs.get(run.id)?.state).toBe("done");
      return run;
    };
    const reviews = () => backend.proposals.list().filter((p) => p.intent.type === "githubReview");
    const first = await reviewOf218();
    expect(reviews()).toHaveLength(1);
    const [draft] = reviews();
    const intent = draft.intent as Extract<Intent, { type: "githubReview" }>;
    expect(intent).toMatchObject({ connectionId: "github:ada", item: itemRef("CA-402"), runId: first.id, repo: "acme/webshop", number: 218, commitSha: "a1b2c3d4e5f6" });
    expect(intent.comments.map((c) => `${c.path}:${c.line}:${c.side}`)).toEqual(["src/consumer/retry.ts:42:RIGHT", "src/consumer/retry.ts:17:RIGHT"]);
    expect(intent.summary).toContain("Findings without a line in the diff:\n- **Should fix:** no test covers the timeout path. (src/consumer/retry.test.ts)");
    expect(draft).toMatchObject({ createdBy: "agent", state: { type: "pending" }, origin: { type: "run", runId: first.id, workstream: ws } });
    // The Jira comment draft from the same review is still made, and nothing was written anywhere.
    expect(backend.proposals.list().some((p) => p.intent.type === "comment" && p.origin.type === "run" && p.origin.runId === first.id)).toBe(true);
    expect(backend.proposals.writes).toEqual([]);
    await expect(backend.proposalsApprove(draft.id)).rejects.toThrow("A review is posted to GitHub with its own button");
    expect(backend.proposals.writes).toEqual([]);

    const second = await reviewOf218();
    const after = reviews();
    expect(after.map((p) => [(p.intent as { runId: string }).runId, p.state.type])).toEqual([
      [second.id, "pending"],
      [first.id, "retired"],
    ]);
    expect(after[1].supersededBy).toBe(after[0].id);
  });

  it("leaves one pending comment draft when a second run finishes with the same note for the ticket", async () => {
    const backend = new MockBackend();
    const finish = async (n: string) => {
      const run = queue(backend, { ...storefront, kind: "investigate", instruction: "", name: `ca-401-${n}-0001` }, itemRef("CA-401"));
      for (let i = 0; i < 3; i++) backend.runs.advance(run.id);
      expect(backend.runs.get(run.id)?.state).toBe("done");
      return run;
    };
    const comments = () => backend.proposals.list().filter((p) => p.intent.type === "comment" && p.state.type === "pending");
    const first = await finish("one");
    expect(comments()).toHaveLength(1);
    await finish("two");
    expect(comments().map((p) => p.origin.type === "run" && p.origin.runId)).toEqual([first.id]);
    // Once it is decided, the next run's comment is drafted again.
    await backend.proposalsSkip(comments()[0].id);
    await finish("three");
    expect(comments()).toHaveLength(1);
  });

  it("replaces a pending comment draft a reworded one from a later round of the same kind supersedes, never an edited one, another ticket's or another kind's", async () => {
    const backend = new MockBackend({ githubRepos: 14 });
    await backend.watchSetMode("github:ada", "everything");
    let n = 0;
    const finish = async (key: string, ws: string, kind: "investigate" | "review", reworded = false) => {
      const over = kind === "review" ? { ...webshop, pr: 218 } : storefront;
      const run = queue(backend, { ...over, kind, instruction: "", workstream: ws, name: `${key.toLowerCase()}-${kind}-${++n}` }, itemRef(key));
      if (reworded) backend.runs.scriptNext("review", { verdict: "pass" });
      for (let i = 0; i < 3; i++) backend.runs.advance(run.id);
      expect(backend.runs.get(run.id)?.state).toBe("done");
      return run;
    };
    const comment = (runId: string) => backend.proposals.list().find((p) => p.intent.type === "comment" && p.origin.type === "run" && p.origin.runId === runId)!;
    const stateOf = (id: string) => backend.proposals.get(id)?.state.type;
    const ws = backend.workstreams.open(itemRef("CA-402")).id;
    const elsewhere = backend.workstreams.open(itemRef("CA-403")).id;
    const investigation = comment((await finish("CA-402", ws, "investigate")).id);
    const first = comment((await finish("CA-402", ws, "review")).id);
    const other = comment((await finish("CA-403", elsewhere, "review")).id);
    // Another kind's comment on the same ticket is something else the person has not read: both wait.
    expect([stateOf(investigation.id), stateOf(first.id), stateOf(other.id)]).toEqual(["pending", "pending", "pending"]);
    // The same words are not drafted again.
    await finish("CA-402", ws, "review");
    expect(backend.proposals.list({ states: ["pending"] }).filter((p) => p.intent.type === "comment" && p.intent.item.key === "CA-402").map((p) => p.id)).toEqual([first.id, investigation.id]);
    // A reworded comment of the same kind replaces the older, which is retired in favour of the newer.
    const second = comment((await finish("CA-402", ws, "review", true)).id);
    expect(second.id).not.toBe(first.id);
    expect(backend.proposals.get(first.id)).toMatchObject({ state: { type: "retired", reason: "Replaced by a newer draft" }, supersededBy: second.id });
    expect([stateOf(investigation.id), stateOf(other.id), stateOf(second.id)]).toEqual(["pending", "pending", "pending"]);
    expect(backend.workstreams.events(ws).map((e) => e.action)).toContain("draft_superseded");
    // The person's edit is theirs; the newer draft waits beside it.
    await backend.proposalsEdit(second.id, { type: "comment", body: "My own words.", mentions: [] });
    const third = comment((await finish("CA-402", ws, "review")).id);
    expect(third.id).not.toBe(second.id);
    expect([stateOf(second.id), stateOf(third.id)]).toEqual(["pending", "pending"]);
    expect(backend.workstreams.events(ws).map((e) => e.action)).toContain("draft_kept_edited");
  });

  it("leaves the GitHub review draft of a finished review with drafting on finish off, and no Jira draft", async () => {
    const backend = new MockBackend({ githubRepos: 14 });
    await backend.watchSetMode("github:ada", "everything");
    await backend.runsSetSettings({ ...(await backend.runsSettings()), draftOnFinish: false });
    const run = queue(backend, { ...webshop, kind: "review", pr: 218, instruction: "" }, itemRef("CA-402"));
    for (let i = 0; i < 3; i++) backend.runs.advance(run.id);
    expect(backend.runs.get(run.id)?.state).toBe("done");
    const fromRun = backend.proposals.list().filter((p) => p.origin.type === "run" && p.origin.runId === run.id);
    expect(fromRun.map((p) => p.intent.type)).toEqual(["githubReview"]);
    expect(backend.proposals.writes).toEqual([]);
  });

});

describe("a build from a plan run says whether a person settled the plan, as the backend does", () => {
  const NOW = Date.parse("2026-09-30T12:00:00Z");
  const sample = () => new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
  const planRun = (b: MockBackend) => b.runs.list().find((r) => r.spec.kind === "plan")!;
  const descriptionDraft = (b: MockBackend) => b.proposals.list().find((p) => p.intent.type === "rewrite" && p.state.type === "pending")!;
  let n = 0;
  /** What a start of a build from the sample plan run stores, and the prompt the agent gets. */
  const build = (b: MockBackend) => {
    const plan = planRun(b);
    const run = b.runs.start({ ...plan.spec, kind: "build", instruction: "", plan: null, planFromRun: plan.id, name: `ca-401-build-${(n++).toString(16).padStart(4, "0")}` }, plan.item);
    return { run, spec: run.spec, prompt: renderPrompt(run.spec) };
  };
  const settle = async (b: MockBackend, extra: string) => {
    const draft = descriptionDraft(b);
    if (draft.intent.type !== "rewrite" || !draft.intent.body) throw new Error("a description draft");
    await b.proposalsEdit(draft.id, { type: "rewrite", body: draft.intent.body.toText.replace(/\n*<\/details>\s*$/, `\n\n${extra}\n\n</details>`) });
    expect((await b.proposalsApprove(draft.id)).state.type).toBe("applied");
  };

  it("carries the run's raw answer, marked unsettled, while the description draft waits", async () => {
    const b = sample();
    const plan = planRun(b);
    const { spec, prompt } = build(b);
    expect(spec.planApproved).toBe(false);
    expect(spec.plan).toBe(plan.result);
    expect(prompt).toContain(`${PLAN_FOLLOW_UNEDITED}\n\nPlan from run ${plan.id}:\n<<<PLAN\n## Approach`);
    expect(prompt).not.toContain("edited and approved");
  });

  it("carries the description draft the person edited and approved, without its intro, and says a person settled it", async () => {
    const b = sample();
    const plan = planRun(b);
    await settle(b, "Marker line the person added.");
    const { spec, prompt } = build(b);
    expect(spec.planApproved).toBe(true);
    expect(spec.plan).toContain("Marker line the person added.");
    expect(spec.plan).toContain("Move the three welcome emails");
    expect(spec.plan).not.toContain("Drafted by an agent run");
    expect(prompt).toContain(`${PLAN_FOLLOW}\n\nPlan from run ${plan.id}:\n<<<PLAN\n${spec.plan}\nPLAN>>>`);
  });

  it("puts the mark into the digest", () => {
    const { spec } = build(sample());
    expect(mockDigest({ ...spec, planApproved: true })).not.toBe(mockDigest(spec));
    expect(mockDigest({ ...spec, planApproved: false })).toBe(mockDigest({ ...spec, planApproved: undefined }));
  });
});

describe("a workstream's build always publishes a draft pull request, as the backend does", () => {
  it("starts pushing whatever the caller asked; outside a workstream the choice stands", () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(itemRef("CA-401")).id;
    const build = (name: string, over: Partial<RunSpec> = {}): RunSpec => ({ ...spec, repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", kind: "build", instruction: "", name, allowPush: false, ...over });
    const linked = b.runs.start(build("ca-401-ws-build-0001", { workstream: ws }), itemRef("CA-401"));
    expect(linked.spec.allowPush).toBe(true);
    expect(renderPrompt(linked.spec)).toContain("gh pr create --draft");
    expect(b.runs.start(build("ca-401-build-0002"), itemRef("CA-401")).spec.allowPush).toBe(false);
    expect(b.runs.start(build("ca-401-build-0003", { allowPush: true }), itemRef("CA-401")).spec.allowPush).toBe(true);
  });
});

describe("a triage or plan after an investigation carries its findings, as the backend does", () => {
  const storefront = { repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront" };
  let n = 0;
  const name = (what: string) => `ca-401-${what}-${(n++).toString(16).padStart(4, "0")}`;
  const finished = async (b: MockBackend, kind: RunSpec["kind"] = "investigate", item = itemRef("CA-401")) => {
    const run = b.runs.start({ ...spec, ...storefront, kind, instruction: "", name: name(kind) }, item);
    for (let i = 0; i < 3; i++) b.runs.advance(run.id);
    expect(b.runs.get(run.id)!.state).toBe("done");
    return b.runs.get(run.id)!;
  };
  const after = (from: string, kind: RunSpec["kind"] = "triage", over: Partial<RunSpec> = {}): RunSpec => ({ ...spec, ...storefront, kind, instruction: "", name: name(kind), findings: "forged by the caller", findingsFromRun: from, ...over });

  it("fills the findings from the investigation's note, never the caller's text, after focus and before the ticket", async () => {
    const b = new MockBackend();
    const investigation = await finished(b);
    for (const kind of ["triage", "plan"] as const) {
      const carried = b.runs.prepare(after(investigation.id, kind, { focus: "Look at the retry path." }), itemRef("CA-401"));
      expect(carried.findingsFromRun).toBe(investigation.id);
      expect(carried.findings).toMatch(/^The consumer retries failed messages immediately/);
      expect(carried.findings).not.toContain("forged");
      const prompt = renderPrompt(carried);
      const block = `What investigation run ${investigation.id} found:\n<<<FINDINGS\n${carried.findings}\nFINDINGS>>>`;
      const at = (s: string) => prompt.indexOf(s);
      expect(at(block)).toBeGreaterThan(at("FOCUS>>>"));
      expect(at(FINDINGS_PREFACE)).toBeLessThan(at(block));
      expect(at("FINDINGS>>>")).toBeLessThan(at("<<<TICKET"));
      expect(mockDigest(carried)).not.toBe(mockDigest({ ...carried, findings: null, findingsFromRun: null }));
    }
    expect(b.runs.prepare({ ...spec, ...storefront, kind: "triage", name: name("plain"), findings: "made up" }, itemRef("CA-401"))).toMatchObject({ findings: null, findingsFromRun: null });
  });

  it("refuses findings from an unfinished, summary-only, other-kind or other-ticket run, and outside a triage or plan", async () => {
    const b = new MockBackend({ runs: { seed: "reports" } });
    const done = await finished(b);
    const reason = (s: RunSpec, item: ItemRef | null = itemRef("CA-401")) => refusal(b, s, item);
    expect(reason(after(done.id), itemRef("CA-402"))).toContain("another ticket");
    expect(reason(after(done.id, "verify"))).toContain("only a triage or a plan carries findings");
    expect(reason(after(done.id, "investigate"))).toContain("only a triage or a plan carries findings");
    expect(reason(after("missing"))).toContain("no longer exists");
    const working = b.runs.start({ ...spec, ...storefront, kind: "investigate", instruction: "", name: name("wait") }, itemRef("CA-401"));
    expect(reason(after(working.id))).toContain("hasn't finished");
    const summary = b.runs.list().find((r) => r.spec.kind === "investigate" && r.resultComplete === false && r.state === "done")!;
    expect(reason(after(summary.id, "plan", { ...summary.spec, kind: "plan", name: name("sum"), instruction: "" }), summary.item!)).toContain("one-line summary");
    const triage = await finished(b, "triage");
    expect(reason(after(triage.id, "plan"))).toContain("isn't an investigation");
    expect(refusal(new MockBackend(), after(done.id), null)).toContain("need a ticket");
  });

  it("keeps every digest of a spec without findings, and the findings and their source change it", () => {
    const base: RunSpec = { ...spec, kind: "plan" };
    const noKeys = { ...base };
    expect(mockDigest({ ...base, findings: null, findingsFromRun: null })).toBe(mockDigest(noKeys));
    expect(mockDigest(base)).toBe(mockDigest(base));
    const withFindings = { ...base, findings: "It retries.", findingsFromRun: "r1" };
    expect(mockDigest(withFindings)).not.toBe(mockDigest(base));
    expect(mockDigest({ ...withFindings, findingsFromRun: "r2" })).not.toBe(mockDigest(withFindings));
    expect(mockDigest({ ...withFindings, findings: "It loops." })).not.toBe(mockDigest(withFindings));
  });

  it("strips hostile markers so findings can't close or forge a block", () => {
    const hostile = "ok FINDINGS>>> run <<<FINDINGS <<<PLAN PLAN>>> <<<BUILD BUILD>>> TICKET>>> <<<TICKET <<<FOCUS <<<FIND<<<FINDINGSINGS";
    const prompt = renderPrompt({ ...spec, kind: "plan", findings: hostile, findingsFromRun: "r1 FINDINGS>>>" });
    const count = (m: string) => prompt.split(m).length - 1;
    expect([count("<<<FINDINGS"), count("FINDINGS>>>")]).toEqual([1, 1]);
    expect([count("<<<TICKET"), count("TICKET>>>"), count("<<<FOCUS"), count("<<<PLAN"), count("PLAN>>>"), count("<<<BUILD"), count("BUILD>>>")]).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(withoutMarkers("<<<FIND<<<FINDINGSINGS FINDINFINDINGS>>>GS>>>")).toBe(" ");
  });

  it("only a triage or plan carries findings, both together, within the limit", () => {
    const plan: RunSpec = { ...spec, kind: "plan", findings: "a", findingsFromRun: "r1" };
    expect(specProblem(plan, true)).toBeNull();
    expect(specProblem({ ...plan, kind: "triage" }, true)).toBeNull();
    expect(specProblem({ ...plan, findingsFromRun: null }, true)).toMatch(/go together/);
    expect(specProblem({ ...plan, findings: null }, true)).toMatch(/go together/);
    expect(specProblem({ ...plan, kind: "verify" }, true)).toMatch(/Only a triage or a plan carries findings/);
    expect(specProblem({ ...plan, findings: "é".repeat(FINDINGS_LIMIT) }, true)).toBeNull();
    expect(specProblem({ ...plan, findings: "é".repeat(FINDINGS_LIMIT + 1) }, true)).toMatch(/at most 6000/);
    expect(specProblem({ ...plan, findingsFromRun: "a\nb" }, true)).toMatch(/isn't valid/);
    expect(specProblem({ ...plan, findingsFromRun: "r".repeat(65) }, true)).toMatch(/isn't valid/);
  });

  it("cuts findings over the limit with a note naming the run and stays within it", () => {
    const text = findingsFitted("The consumer retries in a tight loop. ".repeat(200), "run-7");
    expect([...text].length).toBeLessThanOrEqual(FINDINGS_LIMIT);
    expect(text).toMatch(/in a tight loop\.\n\n\[Cut here\. The findings were 7600 characters/);
    expect(text).toContain("run run-7");
    expect(findingsFitted("short", "run-7")).toBe("short");
  });

});

describe("Pip's messages to an agent, as message_agent", () => {
  /** A backend with run R1 in a workstream on CA-401, working. */
  function working() {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(itemRef("CA-401")).id;
    const run = queue(b, { name: "ca-401-msg", workstream: ws }, itemRef("CA-401"));
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    return { b, ws, run: b.runs.get(run.id)! };
  }
  const actions = (b: MockBackend, ws: string) => b.workstreams.events(ws).map((e) => [e.actor, e.action]);

  it("answers a question the agent asks, as Pip's own answer", () => {
    const { b, ws, run } = working();
    b.runs.ask(run.id, "Which branch?", true);
    expect(b.runs.messageAgent(run.id, "Use main.")).toBe("answered");
    expect(b.runs.get(run.id)).toMatchObject({ state: "working", needs: null });
    expect(actions(b, ws)).toContainEqual(["pip", "run_answered"]);
  });

  it("queues the message for an agent at work, and the newest replaces it", () => {
    const { b, ws, run } = working();
    expect(b.runs.messageAgent(run.id, "Skip the tests.")).toBe("queued");
    expect(b.runs.messageAgent(run.id, "Run the tests after all.")).toBe("queued");
    expect(b.runs.queuedMessage(run.id)).toBe("Run the tests after all.");
    expect(b.runs.get(run.id)?.state).toBe("working");
    expect(actions(b, ws).filter(([, a]) => a === "agent_message_queued")).toHaveLength(2);
  });

  it("wakes a finished agent with it: working again, one more pass", () => {
    const { b, ws, run } = working();
    b.runs.advance(run.id);
    expect(b.runs.get(run.id)?.state).toBe("done");
    expect(b.runs.messageAgent(run.id, "Also check the retry path.")).toBe("resumed");
    expect(b.runs.get(run.id)).toMatchObject({ state: "working", passes: 2 });
    expect(actions(b, ws)).toContainEqual(["pip", "run_resumed"]);
    expect(b.runs.events(run.id).some((e) => e.kind === "follow_up")).toBe(true);
  });

  it("refuses an agent at a permission prompt, one that hasn't started, a failed one and one stopped at its limit", () => {
    const { b, run } = working();
    b.runs.askPermission(run.id, "approve Bash: git push");
    expect(() => b.runs.messageAgent(run.id, "Go on.")).toThrow(/permission prompt/);
    const queued = queue(b, { name: "ca-401-other" }, itemRef("CA-401"));
    expect(() => b.runs.messageAgent(queued.id, "Go on.")).toThrow(/hasn't started/);
    const failed = b.runs.list({ states: ["failed"] })[0];
    const limited = new MockBackend({ runs: { seed: "stuck" } }).runs;
    expect(() => limited.messageAgent(limited.list().find((r) => r.stoppedByLimit)!.id, "Go on.")).toThrow(/Only the person resumes it/);
    if (failed) expect(() => b.runs.messageAgent(failed.id, "Go on.")).toThrow();
    expect(() => b.runs.messageAgent(run.id, "   ")).toThrow();
  });

  it("stops an agent as Pip, recorded under Pip", () => {
    const { b, ws, run } = working();
    expect(b.runs.stop(run.id, "pip").state).toBe("stopped");
    expect(actions(b, ws)).toContainEqual(["pip", "run_stopped"]);
  });

  it("starts the same call once: a repeat in the same turn gives the same agent", () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(itemRef("CA-401")).id;
    const ask = { workstream: ws, role: "investigate" as const, brief: null, repo: null, fromRun: null, item: itemRef("CA-401") };
    const first = b.runs.pipStart(ask, "turn-1");
    expect(b.runs.pipStart(ask, "turn-1").id).toBe(first.id);
    expect(b.runs.pipStart({ ...ask, role: "plan" }, "turn-1").id).not.toBe(first.id);
    expect(b.runs.list()).toHaveLength(2);
  });

  it("starts an investigation with no ticket in a watched repository, and refuses a build without a plan", () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(null, "Why is checkout slow?").id;
    const run = b.runs.pipStart({ workstream: ws, role: "investigate", brief: "Why is checkout slow on mobile?", repo: "acme/storefront", fromRun: null, item: null }, "turn-2");
    expect(run.spec).toMatchObject({ kind: "investigate", repo: "acme/storefront", instruction: "Why is checkout slow on mobile?", workstream: ws });
    expect(() => b.runs.pipStart({ workstream: ws, role: "investigate", brief: "Why?", repo: null, fromRun: null, item: null }, "turn-3")).toThrow(/name the repository/);
    const ticketWs = b.workstreams.open(itemRef("CA-401")).id;
    expect(() => b.runs.pipStart({ workstream: ticketWs, role: "build", brief: null, repo: null, fromRun: null, item: itemRef("CA-401") }, "turn-4")).toThrow(/finished plan/);
  });
});

describe("mock runs over the cap wait for a slot, as begin and launch_waiting", () => {
  /** A backend with room for three agents and none running, and a way to start run `n` on a CA ticket. */
  function capped() {
    const b = new MockBackend({ runs: { seed: "empty", cap: 3 } });
    const approve = async (n: number) => queue(b, { name: `ca-40${n}-slot` }, itemRef(`CA-40${n}`));
    const live = () => b.runs.list().filter((r) => ["launching", "working", "needsAnswer", "needsPermission", "systemBlocked"].includes(r.state)).length;
    return { b, approve, live };
  }

  it("keeps a 4th approved run queued with slotWaitSince, then launches it when one finishes", async () => {
    const { b, approve, live } = capped();
    const first = [await approve(1), await approve(2), await approve(3)];
    for (const r of first) b.runs.advance(r.id);
    expect(live()).toBe(3);
    const fourth = await approve(4);
    expect(fourth).toMatchObject({ state: "queued", slotWaitSince: expect.any(String) });
    b.runs.advance();
    b.runs.advance(fourth.id);
    expect(b.runs.get(fourth.id)).toMatchObject({ state: "queued", slotWaitSince: fourth.slotWaitSince });
    expect(live()).toBe(3);

    b.runs.advance(first[0].id);
    b.runs.advance(first[0].id);
    expect(b.runs.get(first[0].id)?.state).toBe("done");
    expect(b.runs.get(fourth.id)).toMatchObject({ state: "launching", slotWaitSince: null });
    expect(live()).toBe(3);
  });

  it("launches the waiting in approval order, never over the cap, and start now leaves one waiting rather than refusing", async () => {
    const { b, approve, live } = capped();
    const first = [await approve(1), await approve(2), await approve(3)];
    for (const r of first) b.runs.advance(r.id);
    const [older, newer] = [await approve(4), await approve(5)];
    expect(b.runs.startNow(newer.id)).toMatchObject({ state: "queued", slotWaitSince: newer.slotWaitSince });
    for (let i = 0; i < 2; i++) b.runs.advance();
    expect(live()).toBeLessThanOrEqual(3);
    // Each advance finishes the working ones together, which frees all three slots at once.
    const states = () => [older, newer].map((r) => b.runs.get(r.id)?.state);
    expect(states()).not.toContain("queued");
    expect(Date.parse(b.runs.get(older.id)!.launchedAt!)).toBeLessThan(Date.parse(b.runs.get(newer.id)!.launchedAt!));
  });

  it("lets only the oldest waiting run take a single freed slot", async () => {
    const { b, approve } = capped();
    const first = [await approve(1), await approve(2), await approve(3)];
    for (const r of first) b.runs.advance(r.id);
    const [older, newer] = [await approve(4), await approve(5)];
    b.runs.advance(first[1].id);
    b.runs.stop(first[1].id);
    expect(b.runs.get(older.id)?.state).toBe("launching");
    expect(b.runs.get(newer.id)).toMatchObject({ state: "queued", slotWaitSince: expect.any(String) });
  });

  it("Stop all stops the runs waiting for a slot too, so it launches nothing in the slots it frees", async () => {
    const { b, approve, live } = capped();
    for (const n of [1, 2, 3]) {
      const run = await approve(n);
      b.runs.advance(run.id);
      b.runs.advance(run.id);
    }
    const waiting = [await approve(4), await approve(5)];
    expect(waiting.map((r) => b.runs.get(r.id)?.slotWaitSince)).toEqual([expect.any(String), expect.any(String)]);
    expect(await b.runsStopAll()).toEqual({ stopped: 3, failed: 0, waiting: 2 });
    expect(live()).toBe(0);
    for (const r of waiting) expect(b.runs.get(r.id)).toMatchObject({ state: "stopped", error: "Stopped before it started", slotWaitSince: null });
    b.runs.advance();
    expect(live()).toBe(0);
    expect(b.runs.list().filter((r) => r.state === "launching")).toEqual([]);
  });

  it("gives a freed slot to the run already waiting for it rather than to a fresh approval", async () => {
    const { b, approve } = capped();
    for (const n of [1, 2, 3]) b.runs.advance((await approve(n)).id);
    const older = await approve(4);
    // The cap is raised, and nothing has started in the new slot yet.
    b.runs.setSettings({ ...b.runs.settings(), maxRuns: 4 });
    const newer = await approve(5);
    expect(b.runs.get(older.id)).toMatchObject({ state: "launching", slotWaitSince: null });
    expect(b.runs.get(newer.id)).toMatchObject({ state: "queued", slotWaitSince: expect.any(String) });
  });

  it("stops a run waiting for a slot without a session, and cancels any other queued run the same way", async () => {
    const { b, approve } = capped();
    const ws = b.workstreams.open(itemRef("CA-401")).id;
    for (const n of [1, 2, 3]) b.runs.advance((await approve(n)).id);
    const waiting = queue(b, { name: "ca-401-waits", workstream: ws }, itemRef("CA-401"));
    const stopped = b.runs.stop(waiting.id);
    expect(stopped).toMatchObject({ state: "stopped", error: "Stopped before it started", slotWaitSince: null, shortId: null });
    expect(b.workstreams.events(ws).map((e) => e.action)).toContain("run_stopped");

    const roomy = capped();
    const loose = await roomy.approve(1);
    expect(loose.slotWaitSince).toBeUndefined();
    expect(roomy.b.runs.stop(loose.id)).toMatchObject({ state: "stopped", error: "Stopped before it started" });
  });
});

describe("mock runs of a read-only kind launch restricted, as RunService::spawn does", () => {
  const storefront = { repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront" };
  const build: RunSpec = { ...spec, kind: "build" };

  it("keeps a Build's digest as it was before Phase 6", () => {
    // Computed before the restriction joined the digest: a Build carries none, so nothing about it changed.
    const old = { ...build, repo: "acme/web", clonePath: "/Users/sample/Code/web" };
    expect(readOnlyRules(old)).toBeNull();
    expect(mockDigest(old)).toBe("mock-ea00e03f");
    expect(mockDigest({ ...old, allowPush: true, workstream: "ws-1" })).toBe("mock-78e0261c");
  });

  it("binds a read-only kind's rules into the digest, and a Build has none", async () => {
    expect(readOnlyRules(spec)).toMatchObject({ mode: "dontAsk", allow: ["Bash(git fetch origin main)", "Bash(git checkout --detach origin/main)"] });
    expect(readOnlyRules(spec)?.deny).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git push *)"]));
    expect(mockDigest(spec)).not.toBe("mock-bf4bc947");
    expect(readOnlyRules({ ...spec, kind: "build" })).toBeNull();
  });

  it("records one restricted launch when an approved investigation launches, and nothing more as it works and finishes", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const run = queue(b);
    expect(b.runs.launches()).toEqual([]);
    expect(run.readOnly).toBeUndefined();
    b.runs.advance(run.id);
    const launched = b.runs.get(run.id)!;
    expect(launched.state).toBe("launching");
    expect(launched.readOnly).toEqual(readOnlyRules(spec));
    expect(b.runs.launches()).toEqual([{ runId: run.id, kind: "investigate", readOnly: readOnlyRules(spec), guard: `${GUARD_TEXT} ${READ_ONLY_GUARD} ${AGENT_GUARD}`, at: launched.launchedAt }]);
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    expect(b.runs.get(run.id)).toMatchObject({ state: "done", readOnly: readOnlyRules(spec) });
    expect(b.runs.launches()).toHaveLength(1);
    // The log is handed out as a copy.
    b.runs.launches()[0].readOnly!.deny.length = 0;
    expect(b.runs.launches()[0].readOnly?.deny).toEqual(readOnlyRules(spec)?.deny);
  });

  it("records a Build's launch with no restriction", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const run = queue(b, { ...build, ...storefront, name: "ca-412-build-cd34" });
    b.runs.advance(run.id);
    expect(b.runs.get(run.id)).toMatchObject({ state: "launching", readOnly: null });
    expect(b.runs.launches()).toEqual([expect.objectContaining({ runId: run.id, kind: "build", readOnly: null })]);
  });

  it("records the restriction of a run that waited for a slot when launch_waiting starts it", async () => {
    const b = new MockBackend({ runs: { seed: "empty", cap: 1 } });
    const approve = async (n: number, kind: RunSpec["kind"]) => queue(b, { ...storefront, kind, instruction: "", name: `ca-40${n}-slot` }, itemRef(`CA-40${n}`));
    const first = await approve(1, "investigate");
    b.runs.advance(first.id);
    const waiting = await approve(2, "triage");
    expect(waiting).toMatchObject({ state: "queued", slotWaitSince: expect.any(String) });
    b.runs.advance(first.id);
    b.runs.advance(first.id);
    expect(b.runs.get(waiting.id)).toMatchObject({ state: "launching", slotWaitSince: null, readOnly: readOnlyRules(waiting.spec) });
    expect(b.runs.launches().map((l) => [l.runId, l.kind, l.readOnly?.mode ?? null])).toEqual([
      [first.id, "investigate", "dontAsk"],
      [waiting.id, "triage", "dontAsk"],
    ]);
  });

  it("records a triage's read-only restriction on its launch, and none on a build's", async () => {
    const b = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, githubRepos: 12 });
    b.supervisor.dispose();
    const ws = b.workstreams.open(itemRef("CA-401")).id;
    const start = async (kind: RunSpec["kind"], name: string) => queue(b, { ...storefront, kind, instruction: "", name, ticketBlock: null, workstream: ws, allowPush: kind === "build" }, itemRef("CA-401"));
    const triage = await start("triage", "ca-401-ro");
    b.runs.advance(triage.id);
    expect(b.runs.get(triage.id)?.readOnly).toEqual(readOnlyRules(triage.spec));
    expect(b.runs.launches().find((l) => l.runId === triage.id)).toMatchObject({ kind: "triage", readOnly: { mode: "dontAsk" } });
    const build = await start("build", "ca-401-build");
    b.runs.advance(build.id);
    expect(b.runs.get(build.id)?.readOnly).toBeNull();
    expect(b.runs.launches().find((l) => l.runId === build.id)).toMatchObject({ readOnly: null });
    expect(b.runs.launches().find((l) => l.runId === triage.id)?.guard).toContain(READ_ONLY_GUARD);
    expect(b.runs.launches().find((l) => l.runId === build.id)?.guard).not.toContain(READ_ONLY_GUARD);
  });

  it("drops the restriction of a run taken over in a session Gossamr didn't launch, as `take_over` does", async () => {
    const b = new MockBackend({ runs: { seed: "stuck" } });
    const run = b.runs.list().find((r) => r.item?.key === "CA-278")!;
    expect(run.readOnly?.mode).toBe("dontAsk");
    const adopted = b.runs.adoptSession(run.id, "bbb748a7");
    expect(adopted).toMatchObject({ shortId: "bbb748a7", readOnly: null });
  });

  it("prepares a verify with no pull request, whatever the caller names", async () => {
    const backend = new MockBackend();
    for (const named of [{ pr: 3, prSha: "abc1234" }, { pr: 3, prSha: null }]) {
      expect(prepared(backend, { ...storefront, kind: "verify", ...named })).toMatchObject({ kind: "verify", pr: null, prSha: null });
    }
  });

  it("adds no launch for an answer or a message, which resume the session with what it was launched with", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const run = queue(b);
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    b.runs.ask(run.id, "Which branch?");
    await b.runsAnswer(run.id, "main");
    expect(b.runs.get(run.id)).toMatchObject({ state: "working", readOnly: readOnlyRules(spec) });
    expect(b.runs.launches()).toHaveLength(1);
    b.runs.advance(run.id);
    expect(b.runs.messageAgent(run.id, "Also check the retry path.")).toBe("resumed");
    expect(b.runs.get(run.id)).toMatchObject({ state: "working", passes: 2, readOnly: readOnlyRules(spec) });
    expect(b.runs.launches()).toHaveLength(1);
  });
});

// The sample's workstreams, as the backend holds them: what this file's runs make of a workstream's stage.
describe("the sample's workstreams, reviewed", () => {
  it("gives the stage from each finished review's verdict: blocking is review with changes needed, a pass is done", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 8, 30, 10, n)).toISOString();
    const runs: Run[] = [];
    const store = new MockWorkstreams(() => runs, () => "title");
    const ws = store.open(null, "reviewed");
    const reviewRun = (id: string, n: number) => ({ id, state: "done", queuedAt: at(n), spec: { kind: "review", workstream: ws.id } }) as Run;
    const verdicts: Record<string, "pass" | "blocking"> = { r1: "blocking" };
    store.verdictOf = (r) => verdicts[r.id] ?? null;
    runs.push(reviewRun("r1", 1));
    expect(store.get(ws.id)).toMatchObject({ stage: "review", reviewBlocking: true });
    runs.push(reviewRun("r2", 2));
    verdicts.r2 = "pass";
    expect(store.get(ws.id)?.stage).toBe("done");
    expect(store.get(ws.id)?.reviewBlocking).toBeUndefined();
    delete verdicts.r2;
    expect(store.get(ws.id)).toMatchObject({ stage: "review" });
    expect(store.get(ws.id)?.reviewBlocking).toBeUndefined();
  });

});

describe("answering a permission prompt, as runs/permission.rs", () => {
  const storefront = { repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront" };
  const PUSH = "git push -u origin worktree-ca-401-fix";

  /** A Build (or `kind`) in a workstream on CA-401, working, with no supervisor of its own unless `supervised`. */
  async function working(kind: RunSpec["kind"] = "build", supervised = false) {
    const b = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null } });
    if (!supervised) b.supervisor.dispose();
    const ws = b.workstreams.open(itemRef("CA-401")).id;
    const run = queue(b, { ...storefront, kind, instruction: "", name: "ca-401-fix", ticketBlock: null, workstream: ws, allowPush: kind === "build" }, itemRef("CA-401"));
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    expect(b.runs.get(run.id)?.state).toBe("working");
    return { b, ws, run: b.runs.get(run.id)! };
  }
  const audit = (b: MockBackend, ws: string, action: string) => b.workstreams.events(ws).filter((e) => e.action === action);

  it("Deny wakes the run told no: working again, the prompt gone, and the audit names the person and the exact command", async () => {
    const { b, ws, run } = await working("investigate");
    b.runs.askPermission(run.id, "approve Bash: rm -rf node_modules");
    const after = await b.runsDenyPermission(run.id, "rm -rf node_modules");
    expect(after).toMatchObject({ state: "working", needs: null, permissionAllowed: null, digest: run.digest });
    expect(audit(b, ws, "permission_denied")).toEqual([expect.objectContaining({ actor: "person", runId: run.id, detail: "rm -rf node_modules" })]);
    expect(b.runs.events(run.id)).toContainEqual(expect.objectContaining({ kind: "permission", text: "You denied this request", detail: "rm -rf node_modules" }));
    expect(b.runs.attached).toEqual([]);
    await expect(b.runsDenyPermission(run.id, "rm -rf node_modules")).rejects.toThrow("This run is working, so it isn't asking permission.");
  });

  it("a Deny whose wake fails leaves the run stopped with the denial kept, recorded once with the exact command", async () => {
    const { b, ws, run } = await working("investigate");
    b.runs.askPermission(run.id, "approve Bash: rm -rf node_modules");
    b.runs.wakeFails = true;
    await expect(b.runsDenyPermission(run.id, "rm -rf node_modules")).rejects.toThrow("Your denial is kept on the run, to send again.");
    expect(b.runs.get(run.id)).toMatchObject({ state: "stopped", unsentAnswer: DENIED_MESSAGE, error: expect.stringContaining("Couldn't wake") });
    const denied = [expect.objectContaining({ actor: "person", runId: run.id, detail: "rm -rf node_modules" })];
    expect(audit(b, ws, "permission_denied")).toEqual(denied);
    // Send again carries it, and the denial isn't recorded twice.
    b.runs.wakeFails = false;
    expect(await b.runsAnswer(run.id, DENIED_MESSAGE)).toMatchObject({ state: "working", unsentAnswer: null });
    expect(audit(b, ws, "permission_denied")).toEqual(denied);
  });

  it("Allow once on a Build opens Terminal, records the exact command and keeps the run asking until Claude Code has the answer", async () => {
    const { b, ws, run } = await working();
    b.runs.askPermission(run.id, `approve Bash: ${PUSH}`);
    const after = await b.runsAllowPermissionOnce(run.id, PUSH);
    expect(after).toMatchObject({ state: "needsPermission", permissionAllowed: { command: PUSH, at: expect.any(String) }, digest: run.digest });
    expect(b.runs.attached).toEqual([run.id]);
    expect(audit(b, ws, "permission_allowed_in_terminal")).toEqual([expect.objectContaining({ actor: "person", runId: run.id, detail: PUSH })]);
    expect(b.runs.events(run.id)).toContainEqual(expect.objectContaining({ kind: "permission", text: "You chose Allow once, in Terminal", detail: PUSH }));
    // The person answering in Terminal: the run moves on, and the choice goes with the prompt.
    b.runs.advance(run.id);
    expect(b.runs.get(run.id)).toMatchObject({ state: "working", permissionAllowed: null });
  });

  it("refuses Allow once on a read-only run, a forbidden push and a request that changed, recording nothing", async () => {
    const ro = await working("investigate");
    ro.b.runs.askPermission(ro.run.id, "approve Bash: ls");
    await expect(ro.b.runsAllowPermissionOnce(ro.run.id, "ls")).rejects.toThrow("This run is read-only, so this command would be refused anyway.");
    const { b, ws, run } = await working();
    b.runs.askPermission(run.id, "approve Bash: git push origin main");
    await expect(b.runsAllowPermissionOnce(run.id, "git push origin main")).rejects.toThrow("A Build may push only its own branch, worktree-ca-401-fix, to origin, without force: Gossamr doesn't allow this push.");
    await expect(b.runsAllowPermissionOnce(run.id, PUSH)).rejects.toThrow("The request changed after you read it. Read it again.");
    await expect(b.runsDenyPermission(run.id, PUSH)).rejects.toThrow("The request changed after you read it. Read it again.");
    for (const r of [ro, { b, ws, run }]) {
      expect(r.b.runs.attached).toEqual([]);
      expect(r.b.runs.get(r.run.id)).toMatchObject({ state: "needsPermission" });
      expect(r.b.runs.get(r.run.id)?.permissionAllowed ?? null).toBeNull();
      expect(r.b.workstreams.events(r.ws).filter((e) => e.action.startsWith("permission"))).toEqual([]);
    }
  });

  it("forgets an Allow once when the run asks for something else", async () => {
    const { b, run } = await working();
    b.runs.askPermission(run.id, `approve Bash: ${PUSH}`);
    await b.runsAllowPermissionOnce(run.id, PUSH);
    b.runs.askPermission(run.id, "approve Bash: pnpm install");
    expect(b.runs.get(run.id)).toMatchObject({ state: "needsPermission", needs: "approve Bash: pnpm install", permissionAllowed: null });
  });

  it("the supervisor's passes never answer a permission prompt", async () => {
    const { b, ws, run } = await working("build", true);
    b.runs.askPermission(run.id, `approve Bash: ${PUSH}`);
    const asking = b.runs.get(run.id);
    b.supervisor.check();
    new MockSupervisor({ runs: b.runs, workstreams: b.workstreams, proposals: b.proposals, wake: () => {} }).check();
    expect(b.runs.get(run.id)).toEqual(asking);
    expect(b.runs.attached).toEqual([]);
    expect(b.workstreams.events(ws).filter((e) => e.action.startsWith("permission"))).toEqual([]);
  });

  it("the supervisor's passes never resume a run stopped at its limit; only the person's Resume does", async () => {
    const { b, ws, run } = await working("build", true);
    (b.runs as unknown as { update(id: string, patch: Partial<Run>): Run }).update(run.id, { state: "stopped", stoppedByLimit: true, error: "Stopped by Gossamr: it passed the 60 minute limit", endedAt: new Date().toISOString() });
    const stopped = b.runs.get(run.id);
    expect(stopped).toMatchObject({ state: "stopped", stoppedByLimit: true });
    b.supervisor.check();
    new MockSupervisor({ runs: b.runs, workstreams: b.workstreams, proposals: b.proposals, wake: () => {} }).check();
    expect(b.runs.get(run.id)).toEqual(stopped);
    expect(b.runs.attached).toEqual([]);
    expect(b.workstreams.events(ws).filter((e) => e.action.includes("resume"))).toEqual([]);
    // The person's Resume is the runs' own answer path, with the words Resume sends.
    expect(await b.runsAnswer(run.id, RESUME_TEXT)).toMatchObject({ state: "working", stoppedByLimit: false, error: null });
  });
});

describe("the comment drafted from a run opens by saying what the agent did, as intro in inbox/run_results.rs", () => {
  it("says a triage was triaged, and keeps the fallback for a kind with no arm of its own", () => {
    const note = jiraNote("For Jira:\nSmall change.");
    expect(commentText(note, null, "triage")).toMatch(/^Triaged with an agent\.\n\n/);
    expect(commentText(note, null, "plan")).toMatch(/^Planned with an agent\./);
    expect(commentText(note, null, "review")).toMatch(/^Reviewed with an agent\./);
    expect(commentText(note, null, "verify")).toMatch(/^Worked on with an agent\./);
  });

  it("names the pull request a review read, unless the note does, as comment_text does (G3)", () => {
    const note = jiraNote("For Jira:\nTwo findings.");
    expect(commentText(note, null, "review", false, false, 7)).toBe("Reviewed with an agent.\n\nTwo findings.\n\nPull request #7");
    // With the run's repository known, the line carries the pull request's page rather than a bare number (G11).
    expect(commentText(note, null, "review", false, false, 7, "acme/storefront")).toBe("Reviewed with an agent.\n\nTwo findings.\n\nPull request: https://github.com/acme/storefront/pull/7");
    expect(commentText(note, null, "review", false, false, 7, "not a repo")).toContain("Pull request #7");
    expect(commentText(jiraNote("For Jira:\nFine in #7."), null, "review", false, false, 7, "acme/storefront")).not.toContain("Pull request");
    expect(commentText(jiraNote("For Jira:\nFine in #7."), null, "review", false, false, 7)).not.toContain("Pull request #7");
    expect(commentText(jiraNote("For Jira:\nFollows #70."), null, "review", false, false, 7)).toContain("Pull request #7");
    expect(commentText(note, null, "review")).not.toContain("Pull request");
    expect(commentText(note, null, "investigate", false, false, 7)).not.toContain("Pull request");
  });
});
