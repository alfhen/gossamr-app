import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { Proposal, Run } from "../types";
import { DraftCard } from "./DraftCard";
import { DraftPreview } from "./DraftPreview";
import { answerRun, editThenSend, isSendKey, NOT_WAITING, type AnswerRun } from "./runAnswer";

const CA401 = itemRef("CA-401");
const QUESTION = "Should the refund path keep the old rounding?";

const answerDraft = (over: Partial<Proposal> = {}): Proposal => ({
  id: "a1",
  createdAt: "2026-09-30T11:00:00Z",
  updatedAt: "2026-09-30T11:00:00Z",
  origin: { type: "chat", requestId: "wake-1", workstream: "ws-1" },
  createdBy: "pip",
  intent: { type: "runAnswer", connectionId: "mock", runId: "run-x", shortId: "abcd1234", item: CA401, message: "Yes, keep the old rounding.\nOnly the refund path.", question: "What it asked when drafted" },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

/** `NOT_WAITING` as static markup writes it. */
const NOT_WAITING_HTML = NOT_WAITING.replace("'", "&#x27;");

const waiting: AnswerRun = { label: "R1", question: QUESTION, waiting: true };
const movedOn: AnswerRun = { label: "R1", question: "What it asked when drafted", waiting: false };

const preview = (p: Proposal, answer: AnswerRun | null) => renderToStaticMarkup(<DraftPreview proposal={p} statusName={null} targetTitle="Welcome flow refresh" answer={answer} onOpen={vi.fn()} onApprove={vi.fn()} onSkip={vi.fn()} />);
const card = (p: Proposal, answer: AnswerRun | null) => renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} answer={answer} onApprove={vi.fn()} onSkip={vi.fn()} onSendAnswer={vi.fn()} />);

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }));

describe("an answer draft's cards", () => {
  it("show the run's live question as the agent's words and the whole suggested reply, named by the run's label", () => {
    for (const html of [preview(answerDraft(), waiting), card(answerDraft(), waiting)]) {
      expect(html).toContain('aria-label="Answer for R1"');
      expect(html).toMatch(/data-question[^>]*><b[^>]*>R1 asks:<\/b> Should the refund path keep the old rounding\?/);
      expect(html).not.toContain("What it asked when drafted");
      expect(html).not.toContain(NOT_WAITING_HTML);
    }
    expect(preview(answerDraft(), waiting)).toContain("Yes, keep the old rounding.\nOnly the refund path.</p>");
    expect(preview(answerDraft(), waiting)).toContain("Pip suggests this reply");
    expect(preview(answerDraft(), waiting)).toContain("Review and answer →");
    const editable = card(answerDraft(), waiting);
    expect(editable).toMatch(/<textarea id="run-answer-a1"[^>]*aria-keyshortcuts="Meta\+Enter Control\+Enter"[^>]*>Yes, keep the old rounding.\nOnly the refund path.<\/textarea>/);
    expect(editable).toMatch(/<button type="button" class="[^"]*">Send answer<\/button>/);
  });

  it("fall back to the question the draft kept, and its session, when the run isn't loaded", () => {
    const html = preview(answerDraft(), null);
    expect(html).toContain('aria-label="Answer for abcd1234"');
    expect(html).toContain("The agent asks:</b> What it asked when drafted");
  });

  it("can't be sent once the run moved on, and offer Skip instead", () => {
    const shown = preview(answerDraft(), movedOn);
    expect(shown).toContain(`${NOT_WAITING_HTML}. Skip this draft.`);
    expect(shown).not.toContain("Review and answer");
    expect(shown).toMatch(/<button type="button" class="[^"]*">Skip<\/button>/);
    const peek = card(answerDraft(), movedOn);
    expect(peek).toMatch(new RegExp(`<button type="button" disabled="" title="${NOT_WAITING_HTML}"[^>]*>Send answer</button>`));
    expect(peek).toContain(`${NOT_WAITING_HTML}. Skip this draft.`);
  });

  it("show what was sent once applied, with nothing left to send", () => {
    const sent = answerDraft({ state: { type: "applied" }, run: "run-x" });
    const html = card(sent, { ...waiting, waiting: false });
    expect(html).toContain("Sent.");
    expect(html).not.toContain("Send answer");
    expect(preview(sent, null)).toContain(">Reply</span>");
  });
});

describe("answerRun", () => {
  const base = new MockBackend().runs.list()[0];
  const run = (state: Run["state"], needs: string | null): Run => ({ ...base, id: "run-x", state, needs, spec: { ...base.spec, workstream: "ws-1" } });
  const intent = answerDraft().intent as Extract<Proposal["intent"], { type: "runAnswer" }>;

  it("reads the live question while the run asks, else the one the draft kept", () => {
    expect(answerRun(intent, [run("needsAnswer", QUESTION)])).toEqual({ label: "R1", question: QUESTION, waiting: true });
    expect(answerRun(intent, [run("working", null)])).toEqual({ label: "R1", question: "What it asked when drafted", waiting: false });
    expect(answerRun(intent, [])).toEqual({ label: null, question: "What it asked when drafted", waiting: false });
  });
});

describe("sending an edited answer", () => {
  it("sends on ⌘↵ or Ctrl+↵ only", () => {
    const ev = (over: object) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
    expect(isSendKey(ev({ metaKey: true }))).toBe(true);
    expect(isSendKey(ev({ ctrlKey: true }))).toBe(true);
    expect(isSendKey(ev({}))).toBe(false);
    expect(isSendKey(ev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSendKey(ev({ key: "a", metaKey: true }))).toBe(false);
  });

  it("saves the edit before sending the reply the person read, and the run resumes with it", async () => {
    const b = new MockBackend({ runs: { seed: "empty" } });
    const ws = b.workstreams.open(CA401).id;
    const made = await b.runsDraft({ kind: "investigate", repo: "acme/storefront", clonePath: "/Users/sample/Code/storefront", base: "main", name: "ca-401-edit", instruction: "", focus: null, focusFromRun: null, ticketBlock: null, workstream: ws }, CA401);
    const started = await b.runsApprove(made.id, (await b.runsReview(made.id)).digest);
    b.runs.advance(started.id);
    b.runs.advance(started.id);
    b.runs.ask(started.id, QUESTION);
    const p = await b.runs.proposeAnswer(started.id, "Keep the old rounding.", "wake-1");
    const calls: string[] = [];
    const saveEdit = vi.fn(async (id: string, edit: Parameters<MockBackend["proposalsEdit"]>[1]) => (calls.push("edit"), b.proposalsEdit(id, edit)));
    const send = vi.fn(async (id: string, message: string) => (calls.push("send"), b.runsAnswerDraft(id, message)));
    await editThenSend(p.id, { type: "runAnswer", message: "Use the new rounding." }, "Use the new rounding.", { saveEdit, send });
    expect(calls).toEqual(["edit", "send"]);
    expect(b.runs.get(started.id)?.state).toBe("working");
    expect(b.proposals.get(p.id)).toMatchObject({ state: { type: "applied" }, intent: { message: "Use the new rounding." } });
  });

  it("sends Pip's reply unchanged without saving an edit", async () => {
    const saveEdit = vi.fn(async () => null);
    const send = vi.fn(async () => null);
    await editThenSend("a1", null, "Yes.", { saveEdit, send });
    expect(saveEdit).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("a1", "Yes.");
  });
});
