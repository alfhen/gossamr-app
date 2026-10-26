import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { readinessPrompt, type Need } from "../lib/needs";
import type { Run, RunSpec } from "../types";
import { useWorkspace } from "../workspaceStore";
import { contextDeps } from "./contextActions";
import { keyPlan } from "./needsActions";
import { doneNeed, PLANNING_ANYWAY } from "./NeedsPane";
import { usePip } from "./pipStore";
import { useWorkView } from "./workViewStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";
import { currentNeeds } from "./useNeeds";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const CA408 = itemRef("CA-408");
const texts = () => useToasts.getState().toasts.map((t) => t.text);

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useToasts.getState().clear();
  usePip.getState().clearPrefill();
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null } });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  useToasts.getState().clear();
  vi.unstubAllGlobals();
});

const finish = (id: string) => {
  for (let i = 0; i < 3 && backend.runs.get(id)?.state !== "done"; i++) backend.runs.advance(id);
  expect(backend.runs.get(id)?.state).toBe("done");
};

/** A workstream on the vague CA-408 whose triage said it isn't ready to plan; its id and that triage. */
async function stopped(): Promise<{ id: string; triage: Run }> {
  const id = (await backend.workstreamsOpen(CA408)).id;
  const spec: RunSpec = { kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-408-look", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: id };
  const draft = await backend.runsDraft(spec, CA408);
  const run = await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
  finish(run.id);
  const triageSpec: RunSpec = { ...spec, kind: "triage", name: "ca-408-triage" };
  const triageDraft = await backend.runsDraft(triageSpec, CA408);
  const triage = await backend.runsApprove(triageDraft.id, (await backend.runsReview(triageDraft.id)).digest);
  finish(triage.id);
  await useWorkstreams.getState().refresh();
  await useWorkspace.getState().refreshProposals();
  return { id, triage };
}

const readinessNeed = () => currentNeeds().find((n) => n.kind === "readiness");
const stored = (id: string) => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!;

describe("a ticket the triage found not clear enough to plan", () => {
  it("is a Decide need in Needs you with the three choices, and no plan has started", async () => {
    const { id } = await stopped();
    expect(readinessNeed()).toMatchObject({ key: expect.stringMatching(/^readiness:/), group: "decide", workstreamId: id, title: "CA-408 isn't clear enough to plan", primary: { id: "askReporter" } });
    expect(readinessNeed()?.why).toContain("What is in scope and what is out?");
    expect(backend.runs.list({ workstream: id }).some((r) => r.spec.kind === "plan")).toBe(false);
  });

  it("Ask the reporter drafts a comment to the reporter for approval, settles the need, and posts nothing", async () => {
    const { id, triage } = await stopped();
    expect(await useWorkstreams.getState().askReporter(id)).toBe(true);
    await useWorkspace.getState().refreshProposals();
    expect(readinessNeed()).toBeUndefined();
    const asked = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    expect(asked).toMatchObject({ state: { type: "pending" }, intent: { type: "comment" }, origin: { type: "run", runId: triage.id, workstream: id } });
    expect(texts()).toContain("Here is the comment to the reporter. Nothing is posted until you press Post comment.");
    // It goes through the normal approval: it is a draft to approve in Needs you now, and nothing was written.
    expect(currentNeeds().find((n) => n.key === `draft:${asked.id}`)).toMatchObject({ group: "approve", kind: "draft", workstreamId: id });
    expect(backend.proposals.writes).toEqual([]);
    // The decision pane shows the new draft, not whichever need came next.
    expect(useWorkView.getState()).toMatchObject({ deciding: `draft:${asked.id}` });
  });

  it("takes the note about the comment back when the workstream is closed, so Undo of the close does not bring it up again (G30)", async () => {
    const { id } = await stopped();
    expect(await useWorkstreams.getState().askReporter(id)).toBe(true);
    const note = "Here is the comment to the reporter. Nothing is posted until you press Post comment.";
    expect(texts()).toContain(note);
    expect(await useWorkstreams.getState().close(id)).toBe(true);
    expect(texts()).not.toContain(note);
    expect(texts().some((t) => t.startsWith("Closed the workstream on CA-408"))).toBe(true);
  });

  it("I'll answer settles the need and opens the workstream's conversation with the questions quoted in the composer", async () => {
    const { id } = await stopped();
    const stop = stored(id).readiness!;
    useTabs.getState().setRoute("agents");
    expect(await useWorkstreams.getState().answerSelf(id)).toBe(true);
    expect(readinessNeed()).toBeUndefined();
    expect(useTabs.getState().route).toBe("agents");
    expect(useWorkView.getState().selected).toBe(id);
    expect(usePip.getState().prefill).toEqual({ text: readinessPrompt(stop, "CA-408") });
    expect(usePip.getState().prefill?.text).toMatch(/^R2's open questions about CA-408: “What does done look like for CA-408\?/);
    expect(backend.runs.list({ workstream: id }).some((r) => r.spec.kind === "plan")).toBe(false);
  });

  it("Plan anyway records the override and starts nothing", async () => {
    const { id, triage } = await stopped();
    expect(await useWorkstreams.getState().planAnyway(id)).toBe(true);
    expect(readinessNeed()).toBeUndefined();
    expect(texts()).toContain("Planning anyway. Ask Pip to draft the plan.");
    const events = await backend.workstreamsEvents(id);
    expect(events.find((e) => e.action === "readiness_overridden")).toMatchObject({ actor: "person", runId: triage.id });
  });

  it("marks Plan anyway for that question only: a later question on the workstream keeps its own title in the Done line", async () => {
    const { id, triage } = await stopped();
    expect(await useWorkstreams.getState().planAnyway(id)).toBe(true);
    const question = (run: string) => ({ key: `readiness:${run}`, kind: "readiness", workstreamId: id, title: "CA-408: not ready to plan" }) as never as Need;
    // The pane never read the mark (another need was open when the question went): a question from a later triage is not labelled by it.
    expect(doneNeed(question("triage-later")).title).toBe("CA-408: not ready to plan");
    expect(doneNeed(question(triage.id)).title).toBe(PLANNING_ANYWAY);
    expect(doneNeed(question(triage.id)).title).toBe("CA-408: not ready to plan");
  });

  it("is chosen once: a second press says the workstream isn't waiting any more and changes nothing", async () => {
    const { id } = await stopped();
    expect(await useWorkstreams.getState().answerSelf(id)).toBe(true);
    useToasts.getState().clear();
    for (const choose of [useWorkstreams.getState().askReporter, useWorkstreams.getState().answerSelf, useWorkstreams.getState().planAnyway]) {
      expect(await choose(id)).toBe(false);
    }
    // The same toast said three times is one toast.
    expect(texts()).toEqual(["The workstream isn't waiting for that choice any more."]);
  });

  it("asks for Enter on the keyboard before drafting, never plans anyway from a key, and the palette runs each choice", async () => {
    const { id } = await stopped();
    const need = readinessNeed()!;
    expect(keyPlan(need, "approve")).toMatchObject({ type: "ask", text: "draft a comment to the reporter with the open questions; nothing is posted until you approve it" });
    expect(keyPlan(need, "dismiss")).toBeNull();
    expect(keyPlan(need, "skip")).toBeNull();
    expect(keyPlan(need, "edit")).toBeNull();
    // The palette's own Enter is the deliberate step: Plan anyway runs, and so does "I'll answer".
    contextDeps.needAct(need, "planAnyway");
    await vi.waitFor(() => expect(readinessNeed()).toBeUndefined());
    expect(stored(id).readiness ?? null).toBeNull();
  });

  it("the palette's Ask the reporter drafts the comment, and its I'll answer opens the conversation", async () => {
    await stopped();
    contextDeps.needAct(readinessNeed()!, "askReporter");
    await vi.waitFor(() => expect(readinessNeed()).toBeUndefined());
    await useWorkspace.getState().refreshProposals();
    expect(Object.values(useWorkspace.getState().proposals).some((p) => p.label === "Questions for the reporter" && p.state.type === "pending")).toBe(true);
  });

  it("the palette's I'll answer settles the need and opens the conversation with the questions", async () => {
    const { id } = await stopped();
    contextDeps.needAct(readinessNeed()!, "answerSelf");
    await vi.waitFor(() => expect(readinessNeed()).toBeUndefined());
    expect(useWorkView.getState().selected).toBe(id);
    expect(usePip.getState().prefill?.text).toContain("“What is in scope and what is out?”");
  });
});
