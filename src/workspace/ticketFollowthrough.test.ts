import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import { mockAsk } from "../backend/mockPip";
import { mockPipTurns } from "../backend/mockPipTurns";
import { safeToBatch } from "../lib/needs";
import { docFromText, docText } from "../lib/docs";
import type { Proposal, Run, RunSpec, ScreenContext } from "../types";
import { useWorkspace } from "../workspaceStore";
import { usePip } from "./pipStore";
import { usePipHome } from "./pipHomeStore";
import { useToasts } from "./toasts";
import { currentNeeds } from "./useNeeds";
import { workstreamStatus } from "../lib/workstreamStatus";
import { heldBanner } from "../lib/workstreamHold";
import { useWorkstreams } from "./workstreamsStore";
import { withersOf } from "./useWorkstreamWithers";

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
/** A draft that would start a plan run. */
const planDraft = (p: Proposal) => p.intent.type === "startRun" && p.intent.spec.kind === "plan";
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
    for (const part of ["Hi @Mette Lund,", "Before work on CA-408 starts", "- What is the goal?", "- How will we know it is done (the acceptance criteria)?", "- What is in scope, and what is out?", "- Who asked for it, and who is waiting on it?"]) expect(body).toContain(part);
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
    expect(workstreamStatus(stored(id), []).word).toBe("Waiting on reporter");
    expect(currentNeeds().filter((n) => n.workstreamId === id && n.kind !== "draft")).toEqual([]);
    expect(stored(id).clarity ?? null).toBeNull();
    // Holding and resuming is the person resuming: the wait is over.
    backend.workstreams.hold(id, undefined, "person");
    backend.workstreams.resume(id);
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter ?? null).toBeNull();
  });
});

describe("a reporter's reply comment ends the wait", () => {
  it("ends it for a comment from someone else, not for the person's own, and brings the readiness question back as a reply", async () => {
    const id = await open("CA-408");
    await useWorkstreams.getState().askReporterNow(id);
    await useWorkspace.getState().refreshProposals();
    const asked = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    await backend.proposalsApprove(asked.id);
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter?.since).toBeTruthy();
    // The person's own comment answers nothing.
    await new Promise((r) => setTimeout(r, 5));
    backend.connector.comment(CA408, "Any news?");
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter?.since).toBeTruthy();
    expect(stored(id).reporterReplied ?? false).toBe(false);
    // The reporter's reply ends it, with no audit line and no hold.
    await new Promise((r) => setTimeout(r, 5));
    backend.commentOnTicket("CA-408", "It should send three emails.");
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter ?? null).toBeNull();
    expect(stored(id)).toMatchObject({ reporterReplied: true, changedWhileWaiting: true });
    expect(Number.isNaN(Date.parse(stored(id).reporterRepliedAt ?? ""))).toBe(false);
    // The view says which comment it was and how it starts (G15).
    expect(stored(id).reporterReply).toEqual({ id: expect.any(String), excerpt: "It should send three emails." });
    expect(stored(id).workstream.heldReason).toBeNull();
    expect(workstreamStatus(stored(id), []).word).not.toBe("Waiting on reporter");
    expect(withersOf([stored(id)], { events: { [id]: events(id) }, byTicket: {}, runs: [], proposals: {} }, Date.now() + 5 * 86_400_000)[id]?.reporter).toBeUndefined();
  });
});

describe("what the page says when the ticket changed while it waited on the reporter", () => {
  /** A workstream on CA-408 whose questions to the reporter were posted, so it waits. */
  async function waiting() {
    const id = await open("CA-408");
    await useWorkstreams.getState().askReporterNow(id);
    await useWorkspace.getState().refreshProposals();
    const asked = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    await backend.proposalsApprove(asked.id);
    await useWorkstreams.getState().refresh();
    expect(stored(id).waitingOnReporter?.since).toBeTruthy();
    return id;
  }

  it("flags the view while the drift's hold is on, so the banner says it, and not for a drift that came with no wait", async () => {
    const id = await waiting();
    expect(stored(id).changedWhileWaiting ?? false).toBe(false);
    backend.workstreams.trip(id, "basis_drift", null, ["description"]);
    await useWorkstreams.getState().refresh();
    expect(stored(id)).toMatchObject({ changedWhileWaiting: true, workstream: { heldReason: "tripwire:basis_drift" } });
    expect(heldBanner(stored(id).workstream, stored(id).changedWhileWaiting)).toMatch(/^Held: CA-408's description changed while waiting on the reporter\. Resume, then decide whether to plan now\./);

    const other = await open("CA-401");
    backend.workstreams.trip(other, "basis_drift", null, ["description"]);
    await useWorkstreams.getState().refresh();
    expect(stored(other).changedWhileWaiting ?? false).toBe(false);
    expect(heldBanner(stored(other).workstream, stored(other).changedWhileWaiting)).toMatch(/^Held: the ticket's description changed in Jira\./);
  });
});

describe("the note that the comment to the reporter waits for Post comment", () => {
  const asked = async () => {
    const id = await open("CA-408");
    await useWorkstreams.getState().askReporterNow(id);
    await useWorkspace.getState().refreshProposals();
    const draft = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    expect(texts()).toEqual(["Here is the comment to the reporter. Nothing is posted until you press Post comment."]);
    return { id, draft };
  };

  it("goes when the draft is posted", async () => {
    const { draft } = await asked();
    await backend.proposalsApprove(draft.id);
    await vi.waitFor(() => expect(texts()).toEqual([]));
  });

  it("goes when the draft is skipped, and stays while it waits", async () => {
    const { draft } = await asked();
    await useWorkspace.getState().refreshProposals();
    expect(texts()).toHaveLength(1);
    await backend.proposalsSkip(draft.id);
    await vi.waitFor(() => expect(texts()).toEqual([]));
  });
});

describe("the audit a timeline counts from", () => {
  it("is read again for every workstream something loaded, not only the selected one, when a draft is decided", async () => {
    const id = await open("CA-408");
    await useWorkstreams.getState().askReporterNow(id);
    await useWorkspace.getState().refreshProposals();
    // The Pip pane's timeline loaded it; Pip home has another workstream, or none, selected.
    usePipHome.getState().openGeneral();
    await useWorkstreams.getState().loadEvents(id);
    expect(useWorkstreams.getState().events[id].some((e) => e.action === "draft_approved")).toBe(false);
    const asked = Object.values(useWorkspace.getState().proposals).find((p) => p.label === "Questions for the reporter")!;
    await backend.proposalsApprove(asked.id);
    await vi.waitFor(() => expect(useWorkstreams.getState().events[id].some((e) => e.action === "draft_approved")).toBe(true));
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

  it("makes Pip draft a comment with each answer under its question for approval, not a description rewrite, and propose the plan only once it is posted", async () => {
    const { id, triage } = await answering();
    const prompt = usePip.getState().prefill!.text;
    expect(prompt).toMatch(/My answers: $/);
    await ask(id, "a1", `${prompt}Done means the winback mail goes to lapsed customers\nWe only touch the winback flow\nThe CRM team asked for it`);
    const drafts = backend.proposals.list({ workstream: id });
    const answers = drafts.find((p) => p.label === "Answers to the open questions")!;
    expect(answers).toMatchObject({ state: { type: "pending" }, createdBy: "pip", intent: { type: "comment" } });
    const text = docText(answers.intent.type === "comment" ? answers.intent.body : { blocks: [] });
    expect(text.startsWith("Open questions from triage, with answers:")).toBe(true);
    expect(text).toContain("“What does done look like for CA-408? Which behaviour or number should change?”\nAnswer: Done means the winback mail goes to lapsed customers");
    expect(text).toContain("“What is in scope and what is out?”\nAnswer: We only touch the winback flow");
    expect(text).toContain("“Who asked for this, and who is waiting on it?”\nAnswer: The CRM team asked for it");
    expect(drafts.some((p) => p.intent.type === "rewrite")).toBe(false);
    // The plan is not drafted beside a comment nobody posted: Pip says it will once the answers are posted.
    expect(drafts.some(planDraft)).toBe(false);
    expect(mockPipTurns.turns(`ws:${id}`).find((t) => t.requestId === "a1")?.text).toContain("Once you post the answers, I'll draft the plan.");
    expect(triage.id).toBeTruthy();
    // It needs approval like any Jira write, and is never in the safe batch.
    expect(backend.proposals.writes).toEqual([]);
    expect(safeToBatch(answers)).toBe(false);
    expect(currentNeeds().find((n) => n.key === `draft:${answers.id}`)).toMatchObject({ title: "Answers to the open questions", batchable: false });
    // One comment for the answers: the next message is an ordinary one, and still no plan while the comment waits.
    await ask(id, "a2", "where do we stand?");
    expect(backend.proposals.list({ workstream: id }).filter((p) => p.label === "Answers to the open questions")).toHaveLength(1);
    expect(backend.proposals.list({ workstream: id }).some(planDraft)).toBe(false);
    // Posted: Pip's next turn proposes the plan from the triage, which does not start, and only once.
    await backend.proposalsApprove(answers.id);
    await ask(id, "a3", "where do we stand?");
    const plans = backend.proposals.list({ workstream: id }).filter(planDraft);
    expect(plans).toHaveLength(1);
    expect(plans[0].intent.type === "startRun" && plans[0].intent.spec).toMatchObject({ kind: "plan", workstream: id });
    expect(backend.runs.list({ workstream: id }).filter((r) => r.spec.kind === "plan")).toEqual([]);
    await ask(id, "a4", "where do we stand?");
    expect(backend.proposals.list({ workstream: id }).filter(planDraft)).toHaveLength(1);
  });

  it("pairs each answer with its question when the message splits into as many sentences as there are questions", async () => {
    const { id } = await answering();
    await ask(id, "a1", `${usePip.getState().prefill!.text}Done means the winback mail goes out. We only touch the winback flow. The CRM team asked for it.`);
    const answers = backend.proposals.list({ workstream: id }).find((p) => p.label === "Answers to the open questions")!;
    const text = docText(answers.intent.type === "comment" ? answers.intent.body : { blocks: [] });
    expect(text).toContain("“What does done look like for CA-408? Which behaviour or number should change?”\nAnswer: Done means the winback mail goes out.");
    expect(text).toContain("“What is in scope and what is out?”\nAnswer: We only touch the winback flow.");
    expect(text).toContain("“Who asked for this, and who is waiting on it?”\nAnswer: The CRM team asked for it.");
    expect(text).not.toContain("Answers:");
  });

  it("retires the triage's own pending comment, which says the ticket can't be sized, the moment the person chooses to answer", async () => {
    const { id, triage } = await answering();
    const note = backend.proposals.list({ workstream: id }).find((p) => p.origin.type === "run" && p.origin.runId === triage.id && p.intent.type === "comment")!;
    expect(note.state).toMatchObject({ type: "retired", reason: "Replaced by your answers to the open questions" });
    expect(docText(note.intent.type === "comment" ? note.intent.body : { blocks: [] })).toContain("Three questions need an answer");
    expect(events(id).filter((e) => e.action === "draft_superseded" && e.proposalId === note.id)).toMatchObject([{ actor: "person" }]);
    // Nothing of it is left to approve, or to batch.
    await useWorkspace.getState().refreshProposals();
    expect(currentNeeds().some((n) => n.key === `draft:${note.id}`)).toBe(false);
  });

  it("keeps a triage comment the person edited, and leaves another run's comment alone", async () => {
    const id = await open("CA-408");
    const spec: RunSpec = { kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-408-triage", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: id };
    const draft = await backend.runsDraft(spec, CA408);
    const triage = await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
    finish(triage.id);
    await useWorkstreams.getState().refresh();
    const note = backend.proposals.list({ workstream: id }).find((p) => p.origin.type === "run" && p.origin.runId === triage.id && p.intent.type === "comment")!;
    await backend.proposalsEdit(note.id, { type: "comment", body: "My own words about this ticket.", mentions: [] });
    const findings = backend.proposals.fromRun({ type: "comment", item: CA408, body: docFromText("The investigation found the flow is one email.") }, "From an agent run", { type: "run", runId: "someone-else", shortId: null, workstream: id });
    await useWorkstreams.getState().planAnyway(id);
    expect(backend.proposals.get(note.id)?.state.type).toBe("pending");
    expect(backend.proposals.get(findings.id)?.state.type).toBe("pending");
    expect(events(id).some((e) => e.action === "draft_kept_edited" && e.proposalId === note.id)).toBe(true);
  });

  it("retires it too when the person chooses Plan anyway, with a reason that fits", async () => {
    const id = await open("CA-408");
    const spec: RunSpec = { kind: "triage", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-408-triage", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: id };
    const draft = await backend.runsDraft(spec, CA408);
    const triage = await backend.runsApprove(draft.id, (await backend.runsReview(draft.id)).digest);
    finish(triage.id);
    await useWorkstreams.getState().refresh();
    const note = backend.proposals.list({ workstream: id }).find((p) => p.origin.type === "run" && p.origin.runId === triage.id && p.intent.type === "comment")!;
    expect(note.state.type).toBe("pending");
    expect(await useWorkstreams.getState().planAnyway(id)).toBe(true);
    expect(backend.proposals.get(note.id)?.state).toMatchObject({ type: "retired", reason: "You chose to plan anyway, so this note no longer fits" });
  });

  it("marks a triage comment still waiting when the answers are drafted as superseded by them", async () => {
    const { id, triage } = await answering();
    const late = backend.proposals.fromRun({ type: "comment", item: CA408, body: docFromText("Triage could not size this.") }, "From an agent run", { type: "run", runId: triage.id, shortId: null, workstream: id });
    expect(late.state.type).toBe("pending");
    await ask(id, "a1", `${usePip.getState().prefill!.text}All about winback.`);
    const answers = backend.proposals.list({ workstream: id }).find((p) => p.label === "Answers to the open questions")!;
    expect(backend.proposals.get(late.id)).toMatchObject({ state: { type: "retired" }, supersededBy: answers.id });
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
