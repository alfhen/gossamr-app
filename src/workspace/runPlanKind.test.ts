import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { SCRIPTED_PLAN_RESULT, renderPrompt } from "../backend/mockRuns";
import type { Run } from "../types";
import { useWorkspace } from "../workspaceStore";
import { buildFromPlanControl, pipAsks } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const settle = () => new Promise((r) => setTimeout(r, 0));
let backend: MockBackend;
let plan: Run;

beforeEach(async () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  backend = new MockBackend({ githubRepos: 14, runs: { epoch: Date.parse("2026-09-30T12:00:00Z"), seed: "kinds" } });
  await useWorkspace.getState().init(backend);
  useRuns.getState().init(backend);
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  await backend.watchSetMode("github:ada", "everything");
  await settle();
  plan = (await backend.runsList()).find((r) => r.spec.role === "planner")!;
});

describe("a plan run in the mock", () => {
  it("is finished with a realistic plan and a For Jira note, and drafts nothing by itself", async () => {
    expect(plan.state).toBe("done");
    expect(plan.result).toBe(SCRIPTED_PLAN_RESULT);
    for (const part of ["## Approach", "## Files and areas to change", "## Steps", "## Test plan", "## Risks", "## Open questions for a person", "\nFor Jira:\n"]) expect(plan.result).toContain(part);
    expect(plan.spec.role).toBe("planner");
    const outcome = await backend.runsOutcome(plan.id);
    expect(outcome.note).toMatchObject({ fromMarker: true });
    expect(outcome.note!.text).not.toMatch(/in the description|attached to the run/);
    expect(outcome.draft).toBeNull();
    expect(outcome.planDraft).toBeNull();
  });

  it("runs through the scripted states when Pip starts it and drafts the status comment on finishing", async () => {
    const started = backend.runs.start({ ...plan.spec, name: "ca-403-plan-0a0a", brief: "Plan this work for a person to approve." }, itemRef("CA-403"));
    expect(started.spec.role).toBe("planner");
    const prompt = renderPrompt(started.spec);
    expect(prompt).toContain("You are working as a planner on CA-403.");
    expect(prompt).toContain("Plan this work for a person to approve.");
    expect(prompt).toContain("`git checkout -B worktree-ca-403-plan-0a0a origin/main`");
    for (let i = 0; i < 4; i++) backend.runs.advance(started.id);
    const done = (await backend.runsList()).find((r) => r.id === started.id)!;
    expect(done.state).toBe("done");
    expect(done.result).toContain("## Approach");
    const outcome = await backend.runsOutcome(done.id);
    expect(outcome.draft).toMatchObject({ state: { type: "pending" } });
    const status = (await backend.proposalsList()).find((p) => p.id === outcome.draft!.id)!;
    expect(status.intent.type === "comment" && JSON.stringify(status.intent.body)).toContain("Planned with an agent.");
  });
});

describe("Ask Pip to build", () => {
  it("is a short request to Pip, on for a finished plan read in full", () => {
    expect(pipAsks.build(plan)).toEqual({ prompt: `Build it, following the plan of run ${plan.id}.`, shown: "Ask Pip to build" });
    expect(buildFromPlanControl(plan)).toEqual({ enabled: true, reason: null });
    expect(buildFromPlanControl({ ...plan, resultComplete: false }).enabled).toBe(false);
    expect(buildFromPlanControl({ ...plan, item: null }).enabled).toBe(false);
  });
});

describe("Draft the plan as a comment", () => {
  it("drafts the whole plan without the For Jira note, apart from the status comment, and nothing is posted", async () => {
    const made = await backend.runsDraftPlanComment(plan.id);
    expect(made.cut).toBe(false);
    const body = made.proposal.intent.type === "comment" ? JSON.stringify(made.proposal.intent.body) : "";
    expect(body).toContain("Move the three welcome emails");
    expect(body).toContain("Open questions for a person");
    expect(body).not.toContain("For Jira");
    expect(made.proposal.label).toMatch(/^Plan from agent run/);
    const outcome = await backend.runsOutcome(plan.id);
    expect(outcome.planDraft).toMatchObject({ id: made.proposal.id });
    expect(outcome.draft).toBeNull();
    await expect(backend.runsDraftPlanComment(plan.id)).rejects.toThrow("already waiting");
  });

  it("says when the comment had to be cut, and cuts at a sentence", async () => {
    (backend.runs as unknown as { update(id: string, patch: Partial<Run>): Run }).update(plan.id, { result: "Step: change the consumer. ".repeat(1200) });
    const made = await backend.runsDraftPlanComment(plan.id);
    expect(made.cut).toBe(true);
    const body = made.proposal.intent.type === "comment" ? JSON.stringify(made.proposal.intent.body) : "";
    expect(body).toContain("Cut here. The plan is");
    expect(body).toContain("change the consumer.");
  });

  it("cuts only a closing For Jira note, never a mention in the middle of the plan", async () => {
    const update = (result: string) => (backend.runs as unknown as { update(id: string, patch: Partial<Run>): Run }).update(plan.id, { result });
    const body = async () => {
      const made = await backend.runsDraftPlanComment(plan.id);
      return made.proposal.intent.type === "comment" ? JSON.stringify(made.proposal.intent.body) : "";
    };
    update("## Steps\n\n1. Do the work.\nFor Jira: say what changed here.\n2. Add the test.\n\n## Risks\n\nNone known.");
    const whole = await body();
    for (const kept of ["say what changed here", "Add the test", "None known"]) expect(whole).toContain(kept);
    update("## Steps\n\nDo it.\n\nFor Jira:\nThe plan is attached.");
    const cut = await body();
    expect(cut).toContain("Do it.");
    expect(cut).not.toContain("The plan is attached");
  });

  it("is only for a finished plan run on a ticket", async () => {
    const triage = (await backend.runsList()).find((r) => r.spec.role === "triager")!;
    await expect(backend.runsDraftPlanComment(triage.id)).rejects.toThrow("only a plan run");
  });
});

describe("the store", () => {
  it("tells the person the comment was cut, and opens the draft", async () => {
    (backend.runs as unknown as { update(id: string, patch: Partial<Run>): Run }).update(plan.id, { result: "Step: change the consumer. ".repeat(1200) });
    await useRuns.getState().draftPlanComment(plan.id);
    const toasts = useToasts.getState().toasts.map((t) => t.text).join("\n");
    expect(toasts).toMatch(/characters and a Jira comment holds less, so it is cut at the end of a sentence/);
  });
});
