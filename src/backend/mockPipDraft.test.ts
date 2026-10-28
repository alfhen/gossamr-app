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
import type { Intent, Proposal, Run, RunSpec, ScreenContext } from "../types";

const NOW = Date.parse("2026-09-30T12:00:00Z");

describe("mock Pip reading a draft in full", () => {
  const b = new MockBackend({ runs: { seed: "kinds", epoch: NOW, planDescription: true } });
  const run = b.runs.list().find((r) => r.spec.role === "planner")!;
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
    const plan = b.runs.list().find((r) => r.spec.role === "planner")!;
    const draft = b.proposals.list().find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite");
    expect(draft?.createdBy).toBe("agent");
    if (draft?.intent.type === "rewrite") expect(draft.intent.body?.toText).toContain("Gossamr Plan");
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
  const base: RunSpec = { role: "investigator", ...storefront, base: "main", name: "x", brief: "", ticket: "CA-401", ticketBlock: null };
  let n = 0;

  /** A backend with a workstream on CA-401 and Pip's conversation in it as request `ws-chain`. */
  async function workstream() {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = await b.workstreamsOpen(CA401);
    mockPipTurns.begin(`ws:${ws.id}`, "ws-chain", "next", { imageCount: 0 });
    return { b, ws: ws.id };
  }

  /** A run with `role` on CA-401 in workstream `ws`, stepped to done unless `steps` says otherwise. */
  async function ran(b: MockBackend, role: string, ws: string | null, steps = 3, item = CA401) {
    const run = b.runs.start({ ...base, role, name: `ca-401-${role}-${(n++).toString(16).padStart(4, "0")}`, ...(ws ? { workstream: ws } : {}) }, item);
    for (let i = 0; i < steps; i++) b.runs.advance(run.id);
    return b.runs.get(run.id)!;
  }

  /** What Pip says to `prompt` in workstream `ws`, and the agents it started. */
  async function say(b: MockBackend, ws: string, prompt: string) {
    let said = "";
    const stop = mockPipEvents.on((id, e) => {
      if (id === "ws-said" && e.type === "text") said += e.text;
    });
    await mockAsk({ requestId: "ws-said", prompt, context: { screen: "board", item: CA401, selection: [] } as unknown as ScreenContext, conversation: `ws:${ws}` } as AskRequest, b, 0);
    stop();
    return said;
  }

  it("starts an agent with Pip's role and brief, as Pip's own, in the workstream, with the ticket's text", async () => {
    const { b, ws } = await workstream();
    const run = b.runs.pipStart({ workstream: ws, role: "Triager", brief: "Size it.", repo: null, item: CA401 }, "ws-chain");
    expect(run).toMatchObject({ createdBy: "pip", origin: { type: "chat", workstream: ws } });
    expect(run.spec).toMatchObject({ role: "triager", brief: "Size it.", ticket: "CA-401", report: true, workstream: ws, pr: null });
    expect(run.spec.ticketBlock).toBeTruthy();
    const prompt = renderPrompt(run.spec);
    expect(prompt).toContain("You are working as a triager on CA-401.");
    expect(prompt).toContain("Size it.");
  });

  it("starts the next step with a brief that points at the run it follows, and no typed hand-off", async () => {
    const { b, ws } = await workstream();
    const investigation = await ran(b, "investigator", ws);
    expect(await say(b, ws, "triage this")).toContain("I started a triage of **CA-401**");
    const triage = b.runs.list().find((r) => r.spec.role === "triager")!;
    expect(triage.spec.brief).toContain("Start from what R1 reported.");
    expect(triage.spec.workstream).toBe(ws);
    expect(Object.keys(triage.spec).sort()).toEqual(["base", "brief", "clonePath", "name", "pr", "prSha", "report", "repo", "role", "ticket", "ticketBlock", "workstream"].filter((k) => k in triage.spec).sort());
    expect(investigation.state).toBe("done");
  });

  it("leaves a triage description and no comment when a one-line ticket cannot be sized", async () => {
    const b = new MockBackend({ runs: { seed: "empty", planDescription: true } });
    const ws = (await b.workstreamsOpen(CA401)).id;
    b.editTicket("CA-401", { description: "Fix it." });
    const triage = await ran(b, "triager", ws);
    const drafts = b.proposals.list().filter((p) => p.origin.type === "run" && p.origin.runId === triage.id);
    expect(drafts.map((p) => p.intent.type)).toEqual(["rewrite"]);
    const rewrite = drafts[0].intent;
    expect(rewrite.type === "rewrite" && rewrite.body?.toText).toContain("The ticket cannot be sized yet");
    expect(rewrite.type === "rewrite" && rewrite.body?.toText).toContain("What does done look like for CA-401?");
  });

  it("starts a reviewer on the pull request its build opened, pinned to its head commit", async () => {
    const b = new MockBackend({ runs: { seed: "kinds" }, githubRepos: 14 });
    const build = b.runs.list().find((r) => r.spec.role === "builder" && r.state === "done" && r.item?.key === "CA-402")!;
    const review = b.runs.pipStart({ workstream: null, role: "reviewer", brief: "Review it.", repo: "acme/webshop", pr: b.runs.pullRequestOf(build.id), item: build.item }, "ws-chain");
    expect(review.createdBy).toBe("pip");
    expect(review.spec).toMatchObject({ role: "reviewer", pr: 218, report: true });
    expect(review.spec.prSha).toBeTruthy();
    expect(renderPrompt(review.spec)).toContain(`Pull request #218 in acme/webshop at commit ${review.spec.prSha}`);
  });

  it("turns a refused start into what Pip says, not a failed turn", async () => {
    const { b, ws } = await workstream();
    await ran(b, "builder", ws);
    const said = await say(b, ws, "review it");
    expect(said).toMatch(/^I couldn't start it: that build has no pull request yet\./);
    expect(b.runs.list()).toHaveLength(1);
    expect(mockPipTurns.turns(`ws:${ws}`).find((t) => t.requestId === "ws-said")).toMatchObject({ status: "done", error: null });
  });

  it("names the workstream's newest finished run of the step before in the brief it writes", () => {
    const ws = { id: "ws1", item: CA401 };
    const run = (id: string, role: string, state: Run["state"], at: string) => ({ id, item: CA401, spec: { role, workstream: "ws1" }, state, queuedAt: at, endedAt: state === "done" ? at : null }) as unknown as Run;
    const runs = [run("p1", "planner", "done", "2026-09-30T10:00:00Z"), run("p2", "planner", "done", "2026-09-30T11:00:00Z"), run("i1", "investigator", "done", "2026-09-30T09:00:00Z")];
    const context = { screen: "board", item: null } as unknown as ScreenContext;
    const start = (prompt: string, over: Run[] = runs) => scriptPip(prompt, context, [], over, NOW, [], null, ws).start;
    expect(start("build it")).toMatchObject({ item: CA401, role: "builder", brief: expect.stringContaining("following the plan R3 reported") });
    expect(start("triage this")).toMatchObject({ role: "triager", brief: expect.stringContaining("Start from what R1 reported") });
    // A question about a step starts nothing.
    expect(start("what did the triage find?") ?? null).toBeNull();
    expect(start("plan this")).toMatchObject({ role: "planner", brief: expect.stringContaining("what R1 reported") });
    expect(start("review it")).toMatchObject({ role: "reviewer", prOfRun: null });
    // A build still working is named, so the person is told its pull request isn't found.
    expect(start("review it", [run("b1", "builder", "working", "2026-09-30T12:00:00Z")])).toMatchObject({ role: "reviewer", prOfRun: "b1" });
    expect(scriptPip("build it", context, [], runs, NOW, [], null, null).start ?? null).toBeNull();
  });
});

describe("mock Pip woken by an agent that asks a question, as ask_person does", () => {
  const CA401 = itemRef("CA-401");

  it("asks the person what to tell it, and starts, stops or answers nothing", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(CA401).id;
    const run = b.runs.start({ role: "investigator", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-asks", brief: "", ticketBlock: null, workstream: ws }, CA401);
    b.runs.advance(run.id);
    b.runs.advance(run.id);
    b.runs.ask(run.id, "Should the refund path keep the old rounding?");
    const runsBefore = b.runs.list().map((r) => [r.id, r.state]);
    let said = "";
    const stop = mockPipEvents.on((id, e) => {
      if (id === "wake-asks" && e.type === "text") said += e.text;
    });
    const prompt = eventLine([{ run: run.id, role: "investigate", state: "needsAnswer" }]);
    await mockAsk({ requestId: "wake-asks", prompt, context: { screen: "board", item: CA401, selection: [] } as unknown as ScreenContext, conversation: `ws:${ws}`, kind: "wake" } as AskRequest, b, 0);
    stop();
    expect(said).toBe("R1 asks: “Should the refund path keep the old rounding?” I asked you what to tell it.");
    expect((await b.workstreams.get(ws))?.pipAsk?.question).toBe("R1 asks: “Should the refund path keep the old rounding?” What should I tell it?");
    // Nothing started, stopped or answered: the runs are as they were, and no draft was made.
    expect(b.runs.list().map((r) => [r.id, r.state])).toEqual(runsBefore);
    expect(b.proposals.list({ states: ["pending"] })).toEqual([]);
  });
});

describe("mock Pip discussing and revising a GitHub review draft, as revise_proposal does", () => {
  const GH = "github:ada";
  const spec: RunSpec = { role: "review", repo: "acme/webshop", clonePath: "/Users/sample/Code/webshop", base: "main", name: "ca-402-review", brief: "", pr: 218, ticketBlock: "CA-402: sample" };
  const context = { screen: "board", item: itemRef("CA-402"), selection: [] } as unknown as ScreenContext;
  let n = 0;

  /** A backend whose review of #218 has finished, with the GitHub review draft it left. */
  async function reviewed() {
    const b = new MockBackend({ githubRepos: 14, runs: { planDescription: true } });
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
