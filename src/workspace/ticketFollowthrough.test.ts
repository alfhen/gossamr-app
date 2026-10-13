import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { mockAsk } from "../backend/mockPip";
import { safeToBatch } from "../lib/needs";
import { docText } from "../lib/docs";
import type { Run, RunSpec, ScreenContext } from "../types";
import { useWorkspace } from "../workspaceStore";
import { usePip } from "./pipStore";
import { usePipHome } from "./pipHomeStore";
import { useToasts } from "./toasts";
import { currentNeeds } from "./useNeeds";
import { workstreamStatus } from "./pipHomeLogic";
import { useWorkstreams } from "./workstreamsStore";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};
const CA408 = itemRef("CA-408");
const texts = () => useToasts.getState().toasts.map((t) => t.text);
const CLEAR = "The welcome flow should send three emails. Only the welcome flow is in scope; the winback flow is not. The CRM team is waiting on it. Done when all three send in the sandbox.";

let backend: MockBackend;
beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  useToasts.getState().clear();
  usePip.getState().clearPrefill();
  backend = new MockBackend({ runs: { seed: "empty", prSurfaceMs: null }, wsManage: true });
  backend.supervisor.dispose();
  await useWorkspace.getState().init(backend);
  useWorkstreams.getState().init(backend);
});
afterEach(() => {
  useWorkstreams.getState().dispose();
  useToasts.getState().clear();
  vi.unstubAllGlobals();
});

const stored = (id: string) => useWorkstreams.getState().list.find((v) => v.workstream.id === id)!;
const events = (id: string) => backend.workstreams.events(id);
const open = async (key: string) => {
  const id = (await backend.workstreamsOpen(itemRef(key))).id;
  await useWorkstreams.getState().refresh();
  return id;
};
const finish = (id: string) => {
  for (let i = 0; i < 3 && backend.runs.get(id)?.state !== "done"; i++) backend.runs.advance(id);
  expect(backend.runs.get(id)?.state).toBe("done");
};

describe("the clarity notice on a workstream", () => {
  it("shows for a thin ticket as a notice, never as a need, and not for a ticket that says what a plan needs", async () => {
    const id = await open("CA-408");
    expect(stored(id).clarity?.gaps).toEqual(["short", "done", "scope", "who"]);
    expect(currentNeeds()).toEqual([]);
    backend.editTicket("CA-401", { description: CLEAR });
    const clear = await open("CA-401");
    expect(stored(clear).clarity ?? null).toBeNull();
  });

  it("is a blank ticket's single gap, and the ask then has all four questions", async () => {
    const id = await open("CA-401");
    expect(stored(id).clarity?.gaps).toEqual(["empty"]);
    const draft = await backend.workstreamsClarityAsk(id);
    const text = docText(draft.intent.type === "comment" ? draft.intent.body : { blocks: [] });
    for (const q of ["What is the goal?", "How will we know it is done", "What is in scope, and what is out?", "Who asked for it, and who is waiting on it?"]) expect(text).toContain(q);
  });

  it("Ask the reporter now drafts the Questions for the reporter comment from the gaps, for approval, and posts nothing", async () => {
    const id = await open("CA-408");
    expect(await useWorkstreams.getState().askReporterNow(id)).toBe(true);
    await useWorkspace.getState().refreshProposals();
    const asked = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    expect(asked).toMatchObject({ state: { type: "pending" }, createdBy: "user", intent: { type: "comment" }, origin: { type: "chat", workstream: id } });
    const body = docText(asked.intent.type === "comment" ? asked.intent.body : { blocks: [] });
    for (const part of ["Hi @Mette Lund,", "Before CA-408 can be planned", "- What is the goal?", "- How will we know it is done (the acceptance criteria)?", "- What is in scope, and what is out?", "- Who asked for it, and who is waiting on it?"]) expect(body).toContain(part);
    expect(backend.proposals.writes).toEqual([]);
    expect(events(id).find((e) => e.action === "clarity_asked")).toMatchObject({ actor: "person", proposalId: asked.id });
    expect(stored(id).clarity ?? null).toBeNull();
    expect(texts()).toContain("Here is the comment to the reporter. Nothing is posted until you press Post comment.");
    // It is an ordinary draft waiting in Needs you, outside the safe batch.
    expect(currentNeeds().find((n) => n.key === `draft:${asked.id}`)).toMatchObject({ group: "approve", batchable: false, title: "Questions for the reporter" });
    expect(safeToBatch(asked)).toBe(false);
    expect(usePipHome.getState()).toMatchObject({ deciding: `draft:${asked.id}`, selected: id });
    useToasts.getState().clear();
    expect(await useWorkstreams.getState().askReporterNow(id)).toBe(false);
    expect(texts()).toEqual(["The workstream isn't waiting for that choice any more."]);
  });

  it("Looks fine dismisses it for the ticket, audited, and it stays dismissed", async () => {
    const id = await open("CA-408");
    expect(await useWorkstreams.getState().looksFine(id)).toBe(true);
    expect(stored(id).clarity ?? null).toBeNull();
    expect(events(id).filter((e) => e.action === "clarity_dismissed")).toMatchObject([{ actor: "person" }]);
    await useWorkstreams.getState().refresh();
    expect(stored(id).clarity ?? null).toBeNull();
    expect(backend.proposals.writes).toEqual([]);
    await expect(backend.workstreamsClarityDismiss(id)).rejects.toThrow("isn't flagged as possibly unclear");
  });

  it("goes once a triage ran in the workstream: the triage's verdict is the authority", async () => {
    const id = await open("CA-408");
    const spec: RunSpec = { kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-408-triage", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: id };
    const draft = await backend.runsDraft(spec, CA408);
    await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
    await useWorkstreams.getState().refresh();
    expect(stored(id).clarity ?? null).toBeNull();
  });
});

describe("a workstream that waits on the reporter", () => {
  it("starts when the asked comment is posted, shows in its status, and ends when the person resumes", async () => {
    const id = await open("CA-408");
    await useWorkstreams.getState().askReporterNow(id);
    await useWorkspace.getState().refreshProposals();
    const asked = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    expect(stored(id).waitingOnReporter ?? null).toBeNull();
    await backend.proposalsApprove(asked.id);
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter?.since).toBeTruthy();
    expect(workstreamStatus(stored(id), [])).toBe("Waiting on the reporter");
    expect(currentNeeds().filter((n) => n.workstreamId === id && n.kind !== "draft")).toEqual([]);
    expect(stored(id).clarity ?? null).toBeNull();
    // Holding and resuming is the person resuming: the wait is over.
    backend.workstreams.hold(id, undefined, "person");
    backend.workstreams.resume(id);
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter ?? null).toBeNull();
  });
});

describe("I'll answer, then the person's answers", () => {
  const context: ScreenContext = { view: null, item: null, filter: null, selection: [] };
  const ask = async (id: string, requestId: string, prompt: string) => mockAsk({ requestId, prompt, sessionId: null, context, conversation: `ws:${id}`, meta: { imageCount: 0 } }, backend, 0);

  /** A workstream on the vague CA-408 whose triage said it isn't ready; the person chose I'll answer. */
  async function answering(): Promise<{ id: string; triage: Run }> {
    const id = await open("CA-408");
    const spec: RunSpec = { kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-408-triage", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: id };
    const draft = await backend.runsDraft(spec, CA408);
    const triage = await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
    finish(triage.id);
    await useWorkstreams.getState().refresh();
    await useWorkstreams.getState().answerSelf(id);
    return { id, triage };
  }

  it("makes Pip draft a comment quoting each question with the answer for approval, not a description rewrite, then offer the plan", async () => {
    const { id, triage } = await answering();
    const prompt = usePip.getState().prefill!.text;
    expect(prompt).toMatch(/My answers: $/);
    await ask(id, "a1", `${prompt}Done means the winback mail goes to lapsed customers\nWe only touch the winback flow\nThe CRM team asked for it`);
    const drafts = backend.proposals.list({ workstream: id });
    const answers = drafts.find((p) => p.label === "Answers to the open questions")!;
    expect(answers).toMatchObject({ state: { type: "pending" }, createdBy: "pip", intent: { type: "comment" } });
    const text = docText(answers.intent.type === "comment" ? answers.intent.body : { blocks: [] });
    expect(text.startsWith("Answers to the open questions")).toBe(true);
    expect(text).toContain("“What does done look like for CA-408? Which behaviour or number should change?”\nAnswer: Done means the winback mail goes to lapsed customers");
    expect(text).toContain("“What is in scope and what is out?”\nAnswer: We only touch the winback flow");
    expect(text).toContain("“Who asked for this, and who is waiting on it?”\nAnswer: The CRM team asked for it");
    expect(drafts.some((p) => p.intent.type === "rewrite")).toBe(false);
    // The plan is proposed, not started.
    const plan = drafts.find((p) => p.intent.type === "startRun");
    expect(plan?.intent.type === "startRun" && plan.intent.spec).toMatchObject({ kind: "plan" });
    expect(backend.runs.list({ workstream: id }).filter((r) => r.spec.kind === "plan")).toEqual([]);
    expect(triage.id).toBeTruthy();
    // It needs approval like any Jira write, and is never in the safe batch.
    expect(backend.proposals.writes).toEqual([]);
    expect(safeToBatch(answers)).toBe(false);
    expect(currentNeeds().find((n) => n.key === `draft:${answers.id}`)).toMatchObject({ title: "Answers to the open questions", batchable: false });
    // One comment for the answers: the next message is an ordinary one.
    await ask(id, "a2", "where do we stand?");
    expect(backend.proposals.list({ workstream: id }).filter((p) => p.label === "Answers to the open questions")).toHaveLength(1);
  });

  it("quotes every question once and the answer as written when the answer isn't one line a question", async () => {
    const { id } = await answering();
    await ask(id, "a1", `${usePip.getState().prefill!.text}It is all about lapsed customers.`);
    const answers = backend.proposals.list({ workstream: id }).find((p) => p.label === "Answers to the open questions")!;
    const text = docText(answers.intent.type === "comment" ? answers.intent.body : { blocks: [] });
    expect(text).toContain("“What is in scope and what is out?”\n");
    expect(text.trim().endsWith("Answers: It is all about lapsed customers.")).toBe(true);
  });
});
