import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { containerRef, itemRef } from "../backend/mockConnector";
import { mockAsk } from "../backend/mockPip";
import type { AskRequest } from "../backend/claude";
import { docText } from "../lib/docs";
import type { Proposal, Run, ScreenContext, WorkContainer } from "../types";
import { useWorkspace } from "../workspaceStore";
import { AgentCard } from "./AgentCard";
import { DraftPeekView } from "./DraftPeek";
import { fieldsOf } from "./draftTicket";
import { runTitle } from "./agentsLogic";
import { rowText } from "./AgentParts";
import { createdFrom, finishWithPipPrompt, runTicketDraftOf, ticketControl, ticketStatus } from "./runSheetLogic";
import { useRuns } from "./runsStore";
import { useTabs } from "./tabsStore";
import { useToasts } from "./toasts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const blank: ScreenContext = { view: null, item: null, filter: null, selection: [] };
const container = (key: string): WorkContainer => ({ ref: containerRef(key), key, name: key, workflow: { statuses: [], transitions: { type: "any" } } }) as unknown as WorkContainer;

let backend: MockBackend;

beforeEach(async () => {
  vi.stubGlobal("localStorage", memory());
  backend = new MockBackend({ runs: { seed: "empty" } });
  await useWorkspace.getState().init(backend);
  useRuns.getState().init(backend);
  useToasts.getState().clear();
  useTabs.getState().setRoute("workspace");
  await settle();
});

describe("the sample path from a prompt to a ticket", () => {
  async function ticketless(): Promise<Run> {
    const started = backend.runs.pipStart({ workstream: null, role: "investigator", brief: "Why does the order consumer retry so fast?", repo: "acme/storefront", item: null }, "turn-ticketless");
    for (let i = 0; i < 4; i++) backend.runs.advance(started.id);
    return (await backend.runsGet(started.id))!;
  }
  const ticketDrafts = (run: Run) => backend.proposals.list().filter((p) => p.origin.type === "run" && p.origin.runId === run.id && p.intent.type === "create");

  it("finishes with a New ticket section and leaves one draft ticket in the chosen project, created by nothing", async () => {
    const run = await ticketless();
    expect(run).toMatchObject({ state: "done", item: null });
    expect(run.result).toContain("New ticket:");
    const [draft] = ticketDrafts(run);
    expect(draft).toMatchObject({ state: { type: "pending" }, createdBy: "agent", origin: { type: "run", runId: run.id } });
    if (draft.intent.type !== "create") throw new Error("a ticket draft");
    expect(draft.intent.container).toEqual(containerRef("CA"));
    expect(draft.intent.fields).toMatchObject({ title: "Add a backoff to the order consumer's retries", kind: "bug" });
    expect(docText(draft.intent.fields.body)).toContain("Found by an agent that was asked to only read code");
    expect(backend.proposals.list({ states: ["applied"] }).filter((p) => p.intent.type === "create")).toHaveLength(0);

    const outcome = await backend.runsOutcome(run.id);
    expect(outcome.ticket?.title).toBe("Add a backoff to the order consumer's retries");
    expect(outcome.ticketDraft).toEqual({ id: draft.id, state: { type: "pending" } });
    expect(ticketStatus(outcome)).toBe("waiting");
    expect(runTicketDraftOf(backend.proposals.list(), run.id)?.id).toBe(draft.id);
    expect(runTitle(run, null)).toBe("Why does the order consumer retry so fast?");
  });

  it("makes no second draft whatever happens to the first, by advance or by the button", async () => {
    const run = await ticketless();
    backend.runs.advance(run.id);
    expect(ticketDrafts(run)).toHaveLength(1);
    // The refusal says what became of the first, never its id, which the person can't use.
    await expect(backend.runsDraftTicket(run.id)).rejects.toThrow(/^that run already has a ticket draft, waiting for you$/);
    await backend.proposalsSkip(ticketDrafts(run)[0].id);
    await expect(backend.runsDraftTicket(run.id)).rejects.toThrow(/^that run already has a ticket draft, skipped$/);
    expect(ticketDrafts(run)).toHaveLength(1);
    expect(ticketStatus(await backend.runsOutcome(run.id))).toBe("skipped");
  });

  it("drafts nothing by itself when the setting is off, and the button makes the one draft", async () => {
    await backend.runsSetSettings({ ...(await backend.runsSettings()), draftOnFinish: false });
    const run = await ticketless();
    expect(ticketDrafts(run)).toHaveLength(0);
    const made = await backend.runsDraftTicket(run.id);
    expect(made).toMatchObject({ origin: { type: "run", runId: run.id }, state: { type: "pending" } });
    expect(ticketDrafts(run)).toHaveLength(1);
  });

  it("seeds a draft from an answer with no section, and refuses a run with a ticket", async () => {
    await backend.runsSetSettings({ ...(await backend.runsSettings()), draftOnFinish: false });
    const run = await ticketless();
    backend.runs.setReport(run.id, null);
    (backend.runs as unknown as { update(id: string, patch: Partial<Run>): void }).update(run.id, { result: "The consumer retries in a loop.\n\nIt never backs off." });
    const made = await backend.runsDraftTicket(run.id);
    expect(made.intent.type === "create" && made.intent.fields.title).toBe("The consumer retries in a loop.");

    const onTicket = backend.runs.list().find((r) => r.item);
    if (onTicket) await expect(backend.runsDraftTicket(onTicket.id)).rejects.toThrow(/about a ticket/);
  });

  it("refuses to draft before the run has finished", async () => {
    const started = backend.runs.pipStart({ workstream: null, role: "investigator", brief: "Why is it slow here?", repo: "acme/storefront", item: null }, "turn-why");
    await expect(backend.runsDraftTicket(started.id)).rejects.toThrow(/hasn't finished/);
  });

  it("lets Pip finish the draft, recorded as Pip's, and the person's approval creates the ticket and tells the run", async () => {
    const run = await ticketless();
    const [draft] = ticketDrafts(run);
    const req: AskRequest = { requestId: "finish-1", prompt: finishWithPipPrompt(run, draft.id), context: blank, sessionId: null };
    await mockAsk(req, backend, 0);
    const revised = backend.proposals.get(draft.id)!;
    expect(revised.state.type).toBe("pending");
    expect(revised.createdBy).toBe("agent");
    expect(revised.revisions[revised.revisions.length - 1]?.note).toBe("Revised by Pip");
    if (revised.intent.type !== "create" || draft.intent.type !== "create") throw new Error("a ticket draft");
    expect(revised.intent.fields.title).toBe("Add a backoff to the order consumer");
    expect(revised.intent.container).toEqual(draft.intent.container);
    expect(revised.intent.fields.kind).toBe("bug");
    expect(docText(revised.intent.fields.body).length).toBeLessThan(docText(draft.intent.fields.body).length);
    expect(backend.proposals.list({ states: ["applied"] }).filter((p) => p.intent.type === "create")).toHaveLength(0);

    const done = await backend.proposalsApprove(draft.id);
    expect(done.state.type).toBe("applied");
    const made = done.created[0];
    expect((await backend.runsGet(run.id))?.createdItem).toEqual(made);
    expect(createdFrom((await backend.runsGet(run.id))!)).toBe(`Ticket ${made.key} created from this`);
    expect(ticketStatus(await backend.runsOutcome(run.id))).toBe("created");
  });

  it("does not let Pip finish a ticket draft the person wrote, or one that was decided", async () => {
    const run = await ticketless();
    const [draft] = ticketDrafts(run);
    const own = await backend.proposalsCreate({ type: "create", container: containerRef("CA"), fields: { title: "Mine", body: { blocks: [] }, kind: "task", assignee: null, parent: null, priority: null, labels: [] }, link: null });
    await mockAsk({ requestId: "f2", prompt: finishWithPipPrompt(run, own.id), context: blank, sessionId: null }, backend, 0);
    expect(backend.proposals.get(own.id)!.revisions).toHaveLength(0);
    expect(() => backend.proposals.pipRevise(own.id, { title: "hijacked" })).toThrow(/wasn't made by Pip/);

    await backend.proposalsSkip(draft.id);
    await mockAsk({ requestId: "f3", prompt: finishWithPipPrompt(run, draft.id), context: blank, sessionId: null }, backend, 0);
    expect(backend.proposals.get(draft.id)!.revisions).toHaveLength(0);
  });

  it("notifies the run list when the ticket is created, and the card and the row say which ticket", async () => {
    const run = await ticketless();
    const seen: string[] = [];
    const off = backend.onRunsChanged((c) => seen.push(c.connectionId));
    await backend.proposalsApprove(ticketDrafts(run)[0].id);
    off();
    expect(seen.length).toBeGreaterThan(0);
    const after = (await backend.runsGet(run.id))!;
    const text = `Ticket ${after.createdItem!.key} created from this`;
    expect(rowText(after, Date.now())).toBe(text);
    const card = renderToStaticMarkup(<AgentCard run={after} now={Date.now()} selected={false} position={1} total={1} ticketTitle={null} onOpen={vi.fn()} onAttach={vi.fn()} failure={{ opened: false, on: { act: vi.fn(), retry: vi.fn(), copied: vi.fn() } }} />);
    expect(card).toContain(text);
  });
});

describe("what may be drafted from a run with no ticket", () => {
  const base = { item: null, state: "done" as const };
  it("needs an answer, and a run on a ticket goes to that ticket", () => {
    expect(ticketControl({ ...base, result: "Found it." })).toEqual({ enabled: true, reason: null });
    expect(ticketControl({ ...base, result: "  " }).enabled).toBe(false);
    expect(ticketControl({ ...base, item: itemRef("CA-1"), result: "x" }).reason).toMatch(/goes to that ticket/);
  });

  it("names the run and the draft in what Finish with Pip sends and carries none of their text", () => {
    const prompt = finishWithPipPrompt({ id: "run-3" }, "d9");
    expect(prompt).toContain("new ticket draft d9, drafted from agent run run-3.");
    expect(prompt).toContain("get_run_result");
    expect(prompt).toMatch(/I still approve it/);
  });
});

describe("the draft ticket made from a run", () => {
  const draft = (over: Partial<Proposal> = {}): Proposal & { intent: Extract<Proposal["intent"], { type: "create" }> } =>
    ({
      id: "p1",
      createdAt: "2026-09-30T10:00:00Z",
      updatedAt: "2026-09-30T10:00:00Z",
      origin: { type: "run", runId: "run-3", shortId: "ab12cd34" },
      createdBy: "user",
      intent: { type: "create", container: containerRef("CA"), fields: { title: "Add a backoff", body: { blocks: [] }, kind: "bug", assignee: null, parent: null, priority: null, labels: [] }, link: null },
      label: "From agent run ab12cd34",
      basis: null,
      state: { type: "pending" },
      revisions: [],
      created: [],
      error: null,
      run: null,
      ...over,
    }) as Proposal & { intent: Extract<Proposal["intent"], { type: "create" }> };
  const view = (p: ReturnType<typeof draft>, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<DraftPeekView proposal={p} fields={fieldsOf(p)} containers={[container("CA"), container("SUP")]} people={[]} working={false} error={null} onChange={vi.fn()} onCommit={vi.fn()} onCreate={vi.fn()} onSkip={vi.fn()} onClose={vi.fn()} {...over} />);

  it("says where it came from with a link to the run, lets the project change while pending, and offers Finish with Pip", () => {
    const html = view(draft(), { onOpenRun: vi.fn(), onFinishWithPip: vi.fn() });
    expect(html).toMatch(/From <button[^>]*title="Open the run this draft came from"[^>]*>an agent run<\/button>/);
    expect(html).not.toContain("ab12cd34");
    expect(html).toContain("Finish with Pip");
    expect(html).toMatch(/<select[^>]*aria-label="Project"/);
    expect(html).not.toMatch(/<select[^>]*aria-label="Project"[^>]*disabled=""/);
  });

  it("offers neither once it is decided, and a draft that is not from a run has no run header", () => {
    expect(view(draft({ state: { type: "applied" }, created: [itemRef("CA-9")] }), { onOpenRun: vi.fn(), onFinishWithPip: vi.fn() })).not.toContain("Finish with Pip");
    const plain = view(draft({ origin: { type: "board" }, createdBy: "user" }));
    expect(plain).not.toContain("From <");
    expect(plain).not.toContain("Finish with Pip");
  });
});

describe("drafting a ticket from the run sheet", () => {
  it("opens the draft and says nothing is created, and a refusal is a message, not a crash", async () => {
    await backend.runsSetSettings({ ...(await backend.runsSettings()), draftOnFinish: false });
    const started = backend.runs.pipStart({ workstream: null, role: "investigator", brief: "Why is it slow here?", repo: "acme/storefront", item: null }, "turn-why");
    for (let i = 0; i < 4; i++) backend.runs.advance(started.id);
    await useRuns.getState().reload();
    useRuns.getState().openRun(started.id);

    await useRuns.getState().draftTicket(started.id);
    const made = backend.proposals.list().find((p) => p.intent.type === "create")!;
    expect(useToasts.getState().toasts.some((t) => t.text.startsWith("Draft ticket ready. Nothing is created until you approve it."))).toBe(true);
    expect(useTabs.getState()).toMatchObject({ route: "workspace", selected: `draft:${made.id}` });
    expect(useRuns.getState().sheet).toBeNull();

    useToasts.getState().clear();
    await useRuns.getState().draftTicket(started.id);
    expect(useToasts.getState().toasts.some((t) => /Couldn't draft the ticket: .*already has a ticket draft/.test(t.text))).toBe(true);
    expect(backend.proposals.list().filter((p) => p.intent.type === "create")).toHaveLength(1);
  });
});
