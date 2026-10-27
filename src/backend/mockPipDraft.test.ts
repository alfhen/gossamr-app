import { describe, expect, it } from "vitest";
import { docFromText, docText } from "../lib/docs";
import { MockBackend } from "./mock";
import { mockAsk, mockPipEvents, openQuestions, scriptPip } from "./mockPip";
import { eventLine } from "./mockSupervisor";
import { mockPipTurns } from "./mockPipTurns";
import { itemRef } from "./mockConnector";
import { renderPrompt } from "./mockRuns";
import type { AskRequest } from "./claude";
import { planOpenQuestions } from "../workspace/agentsLogic";
import type { Intent, Proposal, Run, RunKind, RunSpec, ScreenContext } from "../types";

const NOW = Date.parse("2026-09-30T12:00:00Z");

describe("mock Pip reading a draft in full", () => {
  const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
  const run = b.runs.list().find((r) => r.spec.kind === "plan")!;
  const drafts = b.proposals.list();
  const context = { screen: "board", item: run.item } as unknown as ScreenContext;

  it("answers 'can you see its draft description update' with the draft's open questions", () => {
    const reply = scriptPip("can you see its draft description update?", context, [], [], NOW, drafts);
    expect(reply.steps).toEqual(["Read the draft in full"]);
    expect(reply.text).toContain("Do the Klaviyo flows read the subject lines");
    expect(reply.text).toContain("Should the second email keep its two-day delay");
    expect(reply.text).not.toMatch(/can't see|truncated/);
    expect(reply.discussed).toBeTruthy();
  });

  it("asks which draft when none is on screen", () => {
    const reply = scriptPip("can you see the draft?", { screen: "board", item: null } as unknown as ScreenContext, [], [], NOW, drafts);
    expect(reply.text).toContain("Which draft");
  });

  it("finds an open-questions section under a heading or after a lead-in and stops at the next heading", () => {
    expect(openQuestions("a\n\n## Open questions\n\n- one\n- two\n\n## Next\n\nx")).toBe("- one\n- two");
    expect(openQuestions("a\n\nOpen questions: who owns it?")).toBe("who owns it?");
    expect(openQuestions("nothing here")).toBeNull();
  });
});

describe("open questions in a run result", () => {
  it("stop before the For Jira section", () => {
    expect(openQuestions("## Open questions for a person\n\n- one?\n\nFor Jira:\nsummary")).toBe("- one?");
  });
});

describe("mock Pip woken by a finished plan (N6)", () => {
  it("says approving the description update lets Build start, and lists the questions the plan left open", () => {
    const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
    const plan = b.runs.list().find((r) => r.spec.kind === "plan")!;
    const reply = scriptPip(`[Event] run ${plan.id} (plan) Done; 1 draft`, { screen: "board", item: null } as unknown as ScreenContext, [], [plan], NOW).text;
    expect(reply).toContain("Approve the description update to let Build start.");
    const questions = planOpenQuestions(plan.result);
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) expect(reply).toContain(`- ${q}`);
    // Any other finished step says nothing of the sort.
    const other = { ...plan, spec: { ...plan.spec, kind: "triage" as const } };
    expect(scriptPip(`[Event] run ${plan.id} (triage) Done`, { screen: "board", item: null } as unknown as ScreenContext, [], [other], NOW).text).not.toContain("Approve the description update");
    // Nor a plan that left no draft: there is no description update to approve.
    expect(scriptPip(`[Event] run ${plan.id} (plan) Done`, { screen: "board", item: null } as unknown as ScreenContext, [], [plan], NOW).text).not.toContain("Approve the description update");
  });
});

describe("mock Pip starting the next step of a workstream, as start_agent does", () => {
  const CA401 = itemRef("CA-401");
  const storefront = { repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront" };
  const base: RunSpec = { kind: "investigate", ...storefront, base: "main", name: "x", instruction: "", focus: null, focusFromRun: null, ticketBlock: null };
  let n = 0;

  /** A backend with a workstream on CA-401 and Pip's conversation in it as request `ws-chain`. */
  async function workstream() {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = await b.workstreamsOpen(CA401);
    mockPipTurns.begin(`ws:${ws.id}`, "ws-chain", "next", { imageCount: 0 });
    return { b, ws: ws.id };
  }

  /** What Pip's `start_agent` does for `role` on CA-401 in workstream `ws` (none: General). */
  const start = (b: MockBackend, role: RunKind, ws: string | null, fromRun: string | null = null, brief: string | null = null, item = CA401) => b.runs.pipStart({ workstream: ws, role, brief, repo: null, fromRun, item }, `ws-chain-${n++}`);

  /** A run of `kind` on CA-401 in workstream `ws`, stepped to done unless `steps` says otherwise. */
  async function ran(b: MockBackend, kind: RunKind, ws: string | null, steps = 3, item = CA401) {
    const run = b.runs.start({ ...base, kind, name: `ca-401-${kind}-${(n++).toString(16).padStart(4, "0")}`, ...(ws ? { workstream: ws } : {}) }, item);
    for (let i = 0; i < steps; i++) b.runs.advance(run.id);
    return b.runs.get(run.id)!;
  }

  /** The person adds `extra` to the plan run's description draft and approves it. */
  async function settle(b: MockBackend, plan: Run, extra: string) {
    const draft = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite")!;
    if (draft.intent.type !== "rewrite" || !draft.intent.body) throw new Error("a description draft");
    await b.proposalsEdit(draft.id, { type: "rewrite", body: draft.intent.body.toText.replace(/\n*<\/details>\s*$/, `\n\n${extra}\n\n</details>`) });
    await b.proposalsApprove(draft.id);
    return draft;
  }

  it("starts a build only from a plan the person approved or skipped, never one they weren't shown or Pip revised", async () => {
    const { b, ws } = await workstream();
    const plan = await ran(b, "plan", ws);
    const draft = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite")!;
    expect(() => b.proposals.pipRevise(draft.id, { description: "Pip's plan" }, ws)).toThrow("carries the Gossamr Plan a build follows");
    // A draft Gossamr retired for a newer plan was never decided by the person.
    await ran(b, "plan", ws);
    expect(b.proposals.get(draft.id)?.state.type).toBe("retired");
    expect(() => start(b, "build", ws, plan.id)).toThrow("was retired (replaced by a newer plan) before the person decided on it");
    const skipped = await ran(b, "plan", ws);
    const its = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === skipped.id)!;
    await b.proposalsSkip(its.id);
    expect(start(b, "build", ws, skipped.id).spec).toMatchObject({ planFromRun: skipped.id, planApproved: false });
  });

  it("starts a triage and a plan carrying the workstream's investigation's findings", async () => {
    const { b, ws } = await workstream();
    const investigation = await ran(b, "investigate", ws);
    const triage = start(b, "triage", ws);
    expect(triage.createdBy).toBe("pip");
    expect(triage.spec).toMatchObject({ kind: "triage", findingsFromRun: investigation.id, workstream: ws });
    expect(triage.spec.findings).toMatch(/^The consumer retries failed messages immediately/);
    expect(start(b, "plan", ws, investigation.id).spec).toMatchObject({ kind: "plan", findingsFromRun: investigation.id });
    // In General nothing is taken from a workstream unless Pip names the run.
    const loose = start(b, "triage", null).spec;
    expect([loose.findings ?? null, loose.findingsFromRun ?? null]).toEqual([null, null]);
  });

  it("starts a build only after a finished plan the person settled, with the edited plan and a draft pull request in a workstream", async () => {
    const { b, ws } = await workstream();
    expect(() => start(b, "build", ws)).toThrow("A build can only follow a finished plan run");
    const working = await ran(b, "plan", ws, 2);
    expect(() => start(b, "build", ws, working.id)).toThrow("that plan run hasn't finished");
    b.runs.advance(working.id);
    expect(() => start(b, "build", ws, working.id)).toThrow("the person hasn't settled the plan yet: they approve or skip the Gossamr Plan draft first");
    await settle(b, working, "Marker: the person's line.");
    const investigation = await ran(b, "investigate", ws);
    expect(() => start(b, "build", ws, investigation.id)).toThrow(`A build can only follow a finished plan run; run ${investigation.id} is a investigate run.`);
    expect(() => start(b, "build", null, working.id)).toThrow(`run ${working.id} belongs to another workstream; ask in that workstream's conversation`);
    const loose = await ran(b, "plan", null);
    expect(() => start(b, "build", ws, loose.id)).toThrow(`run ${loose.id} isn't part of this workstream; Pip can only follow a run of the workstream it is asked in`);
    expect(() => start(b, "build", null, loose.id, null, itemRef("CA-402"))).toThrow("that plan run is about another ticket");
    const count = b.runs.list().length;

    const build = start(b, "build", ws, working.id, "Keep it small");
    expect(build).toMatchObject({ createdBy: "pip", origin: { type: "chat", workstream: ws } });
    expect(build.spec).toMatchObject({ kind: "build", planFromRun: working.id, planApproved: true, allowPush: true, focus: "Keep it small", focusFromRun: working.id, workstream: ws });
    expect(build.spec.plan).toContain("Marker: the person's line.");
    const prompt = renderPrompt(build.spec);
    expect(prompt).toContain("gh pr create --draft");
    expect(prompt).toContain("Never mark the pull request ready");
    expect(b.runs.list().length).toBe(count + 1);

    // Outside a workstream Pip's build doesn't push.
    try {
      start(b, "build", null, loose.id);
    } catch (e) {
      expect((e as Error).message).toContain("hasn't settled the plan");
    }
    await settle(b, loose, "Another line.");
    expect(start(b, "build", null, loose.id).spec).toMatchObject({ allowPush: false });
  });

  it("starts a review only of a finished build whose pull request was found, pinned to it, reporting and with no focus", async () => {
    const { b, ws } = await workstream();
    expect(() => start(b, "review", ws)).toThrow("A review needs a pull request");
    const unpublished = await ran(b, "build", ws);
    expect(() => start(b, "review", ws, unpublished.id)).toThrow("that build has no pull request in this repository yet");
    expect(() => start(b, "review", ws, unpublished.id, "the tests")).toThrow();

    const seeded = new MockBackend({ runs: { seed: "kinds" }, githubRepos: 14 });
    const build = seeded.runs.list().find((r) => r.spec.kind === "build" && r.state === "done" && r.item?.key === "CA-402")!;
    const review = start(seeded, "review", null, build.id, null, build.item!);
    expect(review.createdBy).toBe("pip");
    expect(review.spec).toMatchObject({ kind: "review", pr: 218, buildFromRun: build.id, report: true, focus: null, allowPush: false });
    expect(review.spec.prSha).toBeTruthy();
    expect(renderPrompt(review.spec)).toContain(`Review pull request #218 in acme/webshop at commit ${review.spec.prSha}.`);
  });

  it("turns a refused start into what Pip says, not a failed turn", async () => {
    const { b, ws } = await workstream();
    let said = "";
    const stop = mockPipEvents.on((id, e) => {
      if (id === "ws-refused" && e.type === "text") said += e.text;
    });
    await mockAsk({ requestId: "ws-refused", prompt: "build it", context: { screen: "board", item: CA401, selection: [] } as unknown as ScreenContext, conversation: `ws:${ws}` } as AskRequest, b, 0);
    stop();
    expect(said).toBe("I couldn't start it: A build can only follow a finished plan run: pass from_run with the plan run's id from list_runs.");
    expect(b.runs.list()).toEqual([]);
    expect(mockPipTurns.turns(`ws:${ws}`).find((t) => t.requestId === "ws-refused")).toMatchObject({ status: "done", error: null });
  });

  it("names the workstream's newest finished run of the kind before as the one to follow", () => {
    const ws = { id: "ws1", item: CA401 };
    const run = (id: string, kind: RunKind, state: Run["state"], at: string) => ({ id, item: CA401, spec: { kind, workstream: "ws1" }, state, queuedAt: at, endedAt: state === "done" ? at : null }) as unknown as Run;
    const runs = [run("p1", "plan", "done", "2026-09-30T10:00:00Z"), run("p2", "plan", "done", "2026-09-30T11:00:00Z"), run("i1", "investigate", "done", "2026-09-30T09:00:00Z")];
    const context = { screen: "board", item: null } as unknown as ScreenContext;
    expect(scriptPip("build it", context, [], runs, NOW, [], null, ws).start).toMatchObject({ item: CA401, role: "build", fromRun: "p2" });
    expect(scriptPip("triage this", context, [], runs, NOW, [], null, ws).start).toMatchObject({ role: "triage", fromRun: "i1" });
    // A question about a step starts nothing.
    expect(scriptPip("what did the triage find?", context, [], runs, NOW, [], null, ws).start ?? null).toBeNull();
    expect(scriptPip("plan this", context, [], runs, NOW, [], null, ws).start).toMatchObject({ role: "plan", fromRun: "i1" });
    expect(scriptPip("review it", context, [], runs, NOW, [], null, ws).start).toMatchObject({ role: "review", fromRun: null });
    // A plan still working is named, so the backend says it hasn't finished.
    expect(scriptPip("build it", context, [], [run("w1", "plan", "working", "2026-09-30T12:00:00Z")], NOW, [], null, ws).start).toMatchObject({ fromRun: "w1" });
    expect(scriptPip("build it", context, [], runs, NOW, [], null, null).start ?? null).toBeNull();
  });
});

describe("mock Pip woken by an agent that asks a question, as ask_person does", () => {
  const CA401 = itemRef("CA-401");

  it("asks the person what to tell it, and starts, stops or answers nothing", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(CA401).id;
    const run = b.runs.start({ kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-asks", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws }, CA401);
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    b.runs.ask(run.id, "Should the refund path keep the old rounding?");
    const runsBefore = b.runs.list().map((r) => [r.id, r.state]);
    let said = "";
    const stop = mockPipEvents.on((id, e) => {
      if (id === "wake-asks" && e.type === "text") said += e.text;
    });
    const prompt = eventLine([{ run: run.id, kind: "investigate", state: "needsAnswer" }]);
    await mockAsk({ requestId: "wake-asks", prompt, context: { screen: "board", item: CA401, selection: [] } as unknown as ScreenContext, conversation: `ws:${ws}`, kind: "wake" } as AskRequest, b, 0);
    stop();
    expect(said).toBe("R1 asks: “Should the refund path keep the old rounding?” I asked you what to tell it.");
    expect((await b.workstreamsGet(ws))?.pipAsk?.question).toBe("R1 asks: “Should the refund path keep the old rounding?” What should I tell it?");
    // Nothing started, stopped or answered: the runs are as they were, and no draft was made.
    expect(b.runs.list().map((r) => [r.id, r.state])).toEqual(runsBefore);
    expect(b.proposals.list({ states: ["pending"] })).toEqual([]);
  });
});

describe("mock Pip discussing and revising a GitHub review draft, as revise_proposal does", () => {
  const GH = "github:ada";
  const spec: RunSpec = { kind: "review", repo: "acme/webshop", clonePath: "/Users/sample/Code/webshop", base: "main", name: "ca-402-review", instruction: "", pr: 218, focus: null, focusFromRun: null, ticketBlock: "CA-402: sample" };
  const context = { screen: "board", item: itemRef("CA-402"), selection: [] } as unknown as ScreenContext;
  let n = 0;

  /** A backend whose review of #218 has finished, with the GitHub review draft it left. */
  async function reviewed() {
    const b = new MockBackend({ githubRepos: 14 });
    await b.watchSetMode(GH, "everything");
    const run = b.runs.start(spec, itemRef("CA-402"));
    for (let i = 0; i < 3; i++) b.runs.advance(run.id);
    const draft = b.proposals.list().find((p) => p.intent.type === "githubReview")!;
    return { b, draft, run };
  }

  /** Asks the scripted Pip `prompt` in one conversation, and what it said. */
  async function ask(b: MockBackend, prompt: string, session = "review-talk") {
    const requestId = `review-${++n}`;
    let said = "";
    const off = mockPipEvents.on((id, e) => {
      if (id === requestId && e.type === "text") said += e.text;
    });
    await mockAsk({ requestId, prompt, context, sessionId: session } as AskRequest, b, 0);
    off();
    return said;
  }

  const comments = (b: MockBackend, id: string) => {
    const p = b.proposals.get(id)!;
    return p.intent.type === "githubReview" ? p.intent.comments.map((c) => [`${c.path}:${c.line}`, c.body]) : [];
  };

  it("talks the draft over, softens, drops and adds a comment, each a revision marked 'Revised by Pip', and posts nothing", async () => {
    const { b, draft, run } = await reviewed();
    const talk = await ask(b, `Let's talk about the GitHub review draft ${draft.id} of acme/webshop#218, drafted from agent run ${run.id}. Read it in full.`);
    expect(talk).toContain("I read the review of acme/webshop#218 in full");
    // The person reads draft and run names, never their ids or Pip's tools.
    for (const id of [draft.id, run.id, run.shortId ?? run.id]) expect(talk).not.toContain(id);
    expect(talk).not.toMatch(/\b(get|list|propose|revise|retire|set)_[a-z_]+/);
    expect(talk).toContain("`src/consumer/retry.ts:42`");

    const softened = await ask(b, "soften the comment on src/consumer/retry.ts:42");
    expect(softened).toContain("I softened the comment on src/consumer/retry.ts:42");
    expect(softened).toContain("nothing was posted to GitHub");
    const [first, nit] = comments(b, draft.id);
    expect(first[0]).toBe("src/consumer/retry.ts:42");
    expect(first[1]).toMatch(/^Suggestion, if you agree: the retry loop never backs off/);
    expect(nit[0]).toBe("src/consumer/retry.ts:17");
    expect(b.proposals.get(draft.id)!.revisions.slice(-1)[0].note).toBe("Revised by Pip");

    await ask(b, "drop the nit");
    expect(comments(b, draft.id).map(([at]) => at)).toEqual(["src/consumer/retry.ts:42"]);

    await ask(b, "add a comment on src/consumer/retry.ts:18 saying A blank line to spare.");
    expect(comments(b, draft.id)).toEqual([first, ["src/consumer/retry.ts:18", "A blank line to spare."]]);
    const after = b.proposals.get(draft.id)!;
    expect([after.state.type, after.revisions.map((r) => r.note)]).toEqual(["pending", ["Revised by Pip", "Revised by Pip", "Revised by Pip"]]);
    expect(b.github.writes).toEqual([]);
    expect(b.proposals.writes).toEqual([]);
  });

  it("refuses a comment at a line the diff doesn't show, and says so", async () => {
    const { b, draft, run } = await reviewed();
    await ask(b, `Let's talk about the GitHub review draft ${draft.id} of acme/webshop#218, drafted from agent run ${run.id}.`, "off-diff");
    const before = comments(b, draft.id);
    const said = await ask(b, "add a comment on src/x.ts:99 saying Here?", "off-diff");
    expect(said).toContain("src/x.ts:99 isn't a line the pull request's diff shows; call get_proposal to see the lines it has");
    expect(comments(b, draft.id)).toEqual(before);
    expect(b.proposals.get(draft.id)!.revisions).toEqual([]);
    expect(() => b.proposals.pipRevise(draft.id, { comments: [{ path: "src/consumer/retry.ts", line: 99, side: "RIGHT", body: "x" }] }, null, b.github.code.pullFiles("acme/webshop", 218))).toThrow("src/consumer/retry.ts:99 isn't a line");
    expect(b.github.writes).toEqual([]);
  });

  it("refuses a comment Pip adds at a new line once the head moved on from the reviewed commit, and still lets it reword", async () => {
    const { b, draft } = await reviewed();
    const change = b.github.code.change("acme/webshop", 218)!;
    b.github.code.addPullRequest({ ...change, sha: "f00dfeed0000" });
    const had = (draft.intent as Extract<Intent, { type: "githubReview" }>).comments;
    const index = { path: "src/consumer/index.ts", line: 1, side: "RIGHT" as const, body: "This export moved." };
    await expect(b.pipRevise(draft.id, { comments: [...had, index] })).rejects.toThrow("has moved on from a1b2c3d4 since the review read it");
    expect(comments(b, draft.id)).toHaveLength(had.length);
    await b.pipRevise(draft.id, { comments: [{ ...had[0], body: "Could this back off?" }] });
    expect(comments(b, draft.id)).toEqual([[`${had[0].path}:${had[0].line}`, "Could this back off?"]]);
  });

  it("leaves a draft the person edited alone: it is theirs", async () => {
    const { b, draft, run } = await reviewed();
    await b.proposalsEdit(draft.id, { type: "githubReview", comments: [{ path: "src/consumer/retry.ts", line: 42, side: "RIGHT", body: "My own words." }] });
    await ask(b, `Let's talk about the GitHub review draft ${draft.id} of acme/webshop#218, drafted from agent run ${run.id}.`, "edited");
    const said = await ask(b, "soften the comment on src/consumer/retry.ts:42", "edited");
    expect(said).toContain("the user edited this review draft, so Pip can't change it any more");
    expect(said).toContain("it's yours and stays as you left it");
    expect(comments(b, draft.id)).toEqual([["src/consumer/retry.ts:42", "My own words."]]);
    expect(b.proposals.get(draft.id)!.revisions.map((r) => r.note)).toEqual(["Edited"]);
    expect(b.github.writes).toEqual([]);
  });

  it("revises a workstream's review draft only from that workstream's conversation", async () => {
    const { b, draft } = await reviewed();
    const theirs = b.proposals.fromRun(draft.intent, null, { type: "run", runId: "run-other", shortId: null, workstream: "ws-other" } as never);
    expect(() => b.proposals.pipRevise(theirs.id, { body: "hijacked" }, null)).toThrow("that draft belongs to another workstream");
    expect(() => b.proposals.pipRevise(theirs.id, { body: "fine" }, "ws-other")).not.toThrow();
  });
});

describe("mock Pip's check-in wording", () => {
  const item = { connectionId: "mock", externalId: "CA-401", key: "CA-401" };
  const waiting = (connectionId: string, text: string) => ({ id: `d-${connectionId}`, state: { type: "pending" }, intent: { type: "comment", item: { ...item, connectionId }, body: docFromText(text) } }) as unknown as Proposal;
  const wording = (drafts: Proposal[]) => {
    const turn = scriptPip("Draft a comment", { screen: "board", item } as unknown as ScreenContext, [], [], NOW, drafts);
    return turn.draft?.intent.type === "comment" ? docText(turn.draft.intent.body) : "";
  };
  const first = wording([]);

  it("moves on from the wording a draft on the same ticket already uses", () => {
    expect(wording([waiting("mock", first)])).not.toBe(first);
  });

  it("is not moved by a draft on another connection that has the same external id", () => {
    expect(wording([waiting("other", first)])).toBe(first);
  });
});
