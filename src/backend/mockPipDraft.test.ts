import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { mockAsk, mockPipEvents, openQuestions, scriptPip } from "./mockPip";
import { mockPipTurns } from "./mockPipTurns";
import { itemRef } from "./mockConnector";
import { BUILD_NEEDS_PLAN, REVIEW_NEEDS_BUILD, REVIEW_NO_FOCUS, REVIEW_REPORTS, WAITING_FOR_PR_HINT } from "./mockRunKinds";
import type { AskRequest } from "./claude";
import type { Proposal, Run, RunKind, RunSpec, ScreenContext } from "../types";

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

describe("mock Pip drafting the next step of a workstream, as propose_run does", () => {
  const rustRuns = readFileSync(new URL("../../src-tauri/src/agent/runs.rs", import.meta.url), "utf8");
  const rustPip = readFileSync(new URL("../../src-tauri/src/inbox/pip_runs.rs", import.meta.url), "utf8");
  const rustPlan = readFileSync(new URL("../../src-tauri/src/inbox/plan_description.rs", import.meta.url), "utf8");
  const CA401 = itemRef("CA-401");
  const storefront = { repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront" };
  const base: RunSpec = { kind: "investigate", ...storefront, base: "main", name: "x", instruction: "", focus: null, focusFromRun: null, ticketBlock: null };
  let n = 0;
  const specOf = (p: Proposal) => (p.intent.type === "startRun" ? p.intent.spec : null)!;

  /** A backend with a workstream on CA-401 and Pip's conversation in it as request `ws-chain`, and General as `general-chain`. */
  async function workstream() {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = await b.workstreamsOpen(CA401);
    mockPipTurns.begin(`ws:${ws.id}`, "ws-chain", "next", { imageCount: 0 });
    mockPipTurns.begin("general", "general-chain", "next", { imageCount: 0 });
    return { b, ws: ws.id };
  }

  /** A run of `kind` the person started on `item` in workstream `ws`, stepped to done unless `steps` says otherwise. */
  async function ran(b: MockBackend, kind: RunKind, ws: string | null, steps = 3, item = CA401) {
    const made = await b.runsDraft({ ...base, kind, name: `ca-401-${kind}-${(n++).toString(16).padStart(4, "0")}`, ...(ws ? { workstream: ws } : {}) }, item);
    const run = await b.runsApprove(made.id, (await b.runsReview(made.id)).digest);
    for (let i = 0; i < steps; i++) b.runs.advance(run.id);
    return b.runs.get(run.id)!;
  }

  /** The person adds `extra` to the plan run's description draft and approves it. */
  async function settle(b: MockBackend, plan: Run, extra: string) {
    const draft = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite")!;
    if (draft.intent.type !== "rewrite" || !draft.intent.body) throw new Error("a description draft");
    await b.proposalsEdit(draft.id, { type: "rewrite", body: `${draft.intent.body.toText}\n\n${extra}` });
    await b.proposalsApprove(draft.id);
    return draft;
  }

  it("refuses with the backend's words", () => {
    const constant = (name: string) => new RegExp(`const ${name}: &str = "([^"]*)";`).exec(rustRuns)?.[1];
    expect(constant("BUILD_NEEDS_PLAN")).toBe(BUILD_NEEDS_PLAN);
    expect(constant("REVIEW_NEEDS_BUILD")).toBe(REVIEW_NEEDS_BUILD);
    expect(constant("REVIEW_NO_FOCUS")).toBe(REVIEW_NO_FOCUS);
    const rustWorkstreams = readFileSync(new URL("../../src-tauri/src/inbox/workstreams.rs", import.meta.url), "utf8");
    expect(new RegExp(`const WAITING_FOR_PR_HINT: &str = "([^"]*)";`).exec(rustWorkstreams)?.[1]).toBe(WAITING_FOR_PR_HINT);
    const rustDrafts = readFileSync(new URL("../../src-tauri/src/inbox/drafts.rs", import.meta.url), "utf8");
    expect(/const REVIEW_REPORTS: &str = "([^"]*)";/.exec(rustDrafts)?.[1]).toBe(REVIEW_REPORTS);
    for (const words of [
      "the person hasn't settled the plan yet: they approve or skip the Gossamr Plan draft first",
      "the plan of that run hasn't been put to the person on the ticket.",
      "the plan approved on the ticket carries text Pip wrote or is empty, so the person didn't settle it.",
      "Ask the person to settle the plan, or to draft the build themselves from the plan run's sheet.",
    ]) {
      expect(rustPlan).toContain(words);
    }
    for (const words of [
      "belongs to another workstream; ask in that workstream's conversation",
      "isn't part of this workstream; Pip can only follow a run of the workstream it is asked in",
      "that build has no pull request in this repository yet",
      "run hasn't finished",
      "run is about another ticket",
      "An identical draft is already open (proposal",
    ]) {
      expect(rustPip).toContain(words);
    }
  });

  it("drafts a build only from a plan the person approved or skipped, never one they weren't shown or Pip revised", async () => {
    const { b, ws } = await workstream();
    const plan = await ran(b, "plan", ws);
    const draft = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === plan.id && p.intent.type === "rewrite")!;
    expect(() => b.proposals.pipRevise(draft.id, { description: "Pip's plan" }, ws)).toThrow("carries the Gossamr Plan a build follows");
    // A draft Gossamr retired for a newer plan was never decided by the person.
    await ran(b, "plan", ws);
    expect(b.proposals.get(draft.id)?.state.type).toBe("retired");
    await expect(b.pipRunDraft(CA401, "build", plan.id, null, "ws-chain")).rejects.toThrow("was retired (replaced by a newer plan) before the person decided on it");
    const skipped = await ran(b, "plan", ws);
    const its = b.proposals.list({ states: ["pending"] }).find((p) => p.origin.type === "run" && p.origin.runId === skipped.id)!;
    await b.proposalsSkip(its.id);
    expect(specOf(await b.pipRunDraft(CA401, "build", skipped.id, null, "ws-chain"))).toMatchObject({ planFromRun: skipped.id, planApproved: false });
  });

  it("drafts a triage and a plan carrying the workstream's investigation's findings", async () => {
    const { b, ws } = await workstream();
    const investigation = await ran(b, "investigate", ws);
    const triage = await b.pipRunDraft(CA401, "triage", null, null, "ws-chain");
    expect(triage.createdBy).toBe("pip");
    expect(specOf(triage)).toMatchObject({ kind: "triage", findingsFromRun: investigation.id, workstream: ws });
    expect(specOf(triage).findings).toMatch(/^The consumer retries failed messages immediately/);
    const plan = await b.pipRunDraft(CA401, "plan", investigation.id, null, "ws-chain");
    expect(specOf(plan)).toMatchObject({ kind: "plan", findingsFromRun: investigation.id });
    // In General nothing is taken from a workstream unless Pip names the run.
    const loose = specOf(await b.pipRunDraft(CA401, "triage", null, null, "general-chain"));
    expect([loose.findings ?? null, loose.findingsFromRun ?? null]).toEqual([null, null]);
  });

  it("drafts a build only after a finished plan the person settled, with the edited plan and a draft pull request in a workstream", async () => {
    const { b, ws } = await workstream();
    const runs = () => b.runs.list().length;
    await expect(b.pipRunDraft(CA401, "build", null, null, "ws-chain")).rejects.toThrow(BUILD_NEEDS_PLAN);
    const working = await ran(b, "plan", ws, 2);
    await expect(b.pipRunDraft(CA401, "build", working.id, null, "ws-chain")).rejects.toThrow("that plan run hasn't finished");
    b.runs.advance(working.id);
    await expect(b.pipRunDraft(CA401, "build", working.id, null, "ws-chain")).rejects.toThrow("the person hasn't settled the plan yet: they approve or skip the Gossamr Plan draft first");
    await settle(b, working, "Marker: the person's line.");
    const investigation = await ran(b, "investigate", ws);
    await expect(b.pipRunDraft(CA401, "build", investigation.id, null, "ws-chain")).rejects.toThrow(`A build can only follow a finished plan run; run ${investigation.id} is a investigate run.`);
    await expect(b.pipRunDraft(CA401, "build", working.id, null, "general-chain")).rejects.toThrow(`run ${working.id} belongs to another workstream; ask in that workstream's conversation`);
    const loose = await ran(b, "plan", null);
    await expect(b.pipRunDraft(CA401, "build", loose.id, null, "ws-chain")).rejects.toThrow(`run ${loose.id} isn't part of this workstream; Pip can only follow a run of the workstream it is asked in`);
    await expect(b.pipRunDraft(itemRef("CA-402"), "build", loose.id, null, "general-chain")).rejects.toThrow("that plan run is about another ticket");
    const count = runs();

    const build = await b.pipRunDraft(CA401, "build", working.id, "Keep it small", "ws-chain");
    expect(build.createdBy).toBe("pip");
    expect(build.origin).toEqual({ type: "chat", requestId: "ws-chain", workstream: ws });
    expect(specOf(build)).toMatchObject({ kind: "build", planFromRun: working.id, planApproved: true, allowPush: true, focus: "Keep it small", focusFromRun: working.id, workstream: ws });
    expect(specOf(build).plan).toContain("Marker: the person's line.");
    const prompt = (await b.runsReview(build.id)).prompt;
    expect(prompt).toContain("gh pr create --draft");
    expect(prompt).toContain("Never mark the pull request ready");
    await expect(b.pipRunDraft(CA401, "build", working.id, null, "ws-chain")).rejects.toThrow(`An identical draft is already open (proposal ${build.id})`);
    await expect(b.proposalsEdit(build.id, { type: "run", allowPush: false })).rejects.toThrow("a workstream's build always publishes a draft pull request");
    expect(runs()).toBe(count);

    // Outside a workstream Pip's build doesn't push, as before.
    const general = await b.pipRunDraft(CA401, "build", loose.id, null, "general-chain").catch(async (e: Error) => {
      expect(e.message).toContain("hasn't settled the plan");
      await settle(b, loose, "Another line.");
      return b.pipRunDraft(CA401, "build", loose.id, null, "general-chain");
    });
    expect(specOf(general)).toMatchObject({ allowPush: false });
  });

  it("drafts a review only of a finished build whose pull request was found, pinned to it, reporting and with no focus", async () => {
    const { b, ws } = await workstream();
    await expect(b.pipRunDraft(CA401, "review", null, null, "ws-chain")).rejects.toThrow(REVIEW_NEEDS_BUILD);
    const unpublished = await ran(b, "build", ws);
    await expect(b.pipRunDraft(CA401, "review", unpublished.id, null, "ws-chain")).rejects.toThrow("that build has no pull request in this repository yet");
    await expect(b.pipRunDraft(CA401, "review", unpublished.id, "the tests", "ws-chain")).rejects.toThrow(REVIEW_NO_FOCUS);

    const seeded = new MockBackend({ runs: { seed: "kinds" }, githubRepos: 14 });
    mockPipTurns.begin("general", "general-review", "review it", { imageCount: 0 });
    const build = seeded.runs.list().find((r) => r.spec.kind === "build" && r.state === "done" && r.item?.key === "CA-402")!;
    const review = await seeded.pipRunDraft(build.item!, "review", build.id, null, "general-review");
    expect(review.createdBy).toBe("pip");
    expect(specOf(review)).toMatchObject({ kind: "review", pr: 218, buildFromRun: build.id, report: true, focus: null, allowPush: false });
    expect(specOf(review).prSha).toBeTruthy();
    expect((await seeded.runsReview(review.id)).prompt).toContain(`Review pull request #218 in acme/webshop at commit ${specOf(review).prSha}.`);
  });

  it("turns a refused draft into what Pip says, not a failed turn", async () => {
    const { b, ws } = await workstream();
    let said = "";
    const stop = mockPipEvents.on((id, e) => {
      if (id === "ws-refused" && e.type === "text") said += e.text;
    });
    await mockAsk({ requestId: "ws-refused", prompt: "build it", context: { screen: "board", item: CA401, selection: [] } as unknown as ScreenContext, conversation: `ws:${ws}` } as AskRequest, b, 0);
    stop();
    expect(said).toBe(`I couldn't draft that: ${BUILD_NEEDS_PLAN}`);
    expect(b.proposals.list().filter((p) => p.intent.type === "startRun")).toEqual([]);
    expect(mockPipTurns.turns(`ws:${ws}`).find((t) => t.requestId === "ws-refused")).toMatchObject({ status: "done", error: null });
  });

  it("names the workstream's newest finished run of the kind before as the one to follow", () => {
    const ws = { id: "ws1", item: CA401 };
    const run = (id: string, kind: RunKind, state: Run["state"], at: string) => ({ id, item: CA401, spec: { kind, workstream: "ws1" }, state, queuedAt: at, endedAt: state === "done" ? at : null }) as unknown as Run;
    const runs = [run("p1", "plan", "done", "2026-09-30T10:00:00Z"), run("p2", "plan", "done", "2026-09-30T11:00:00Z"), run("i1", "investigate", "done", "2026-09-30T09:00:00Z")];
    const context = { screen: "board", item: null } as unknown as ScreenContext;
    expect(scriptPip("build it", context, [], runs, NOW, [], null, ws).runDraft).toEqual({ item: CA401, kind: "build", fromRun: "p2", focus: null });
    expect(scriptPip("triage this", context, [], runs, NOW, [], null, ws).runDraft).toMatchObject({ kind: "triage", fromRun: "i1" });
    // A question about a step drafts nothing.
    expect(scriptPip("what did the triage find?", context, [], runs, NOW, [], null, ws).runDraft ?? null).toBeNull();
    expect(scriptPip("plan this", context, [], runs, NOW, [], null, ws).runDraft).toMatchObject({ kind: "plan", fromRun: "i1" });
    expect(scriptPip("review it", context, [], runs, NOW, [], null, ws).runDraft).toMatchObject({ kind: "review", fromRun: null });
    // A plan still working is named, so the backend says it hasn't finished.
    expect(scriptPip("build it", context, [], [run("w1", "plan", "working", "2026-09-30T12:00:00Z")], NOW, [], null, ws).runDraft).toMatchObject({ fromRun: "w1" });
    expect(scriptPip("build it", context, [], runs, NOW, [], null, null).runDraft ?? null).toBeNull();
  });
});
