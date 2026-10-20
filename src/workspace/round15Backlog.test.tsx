import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import type { Turn } from "../claudeStore";
import { docFromText } from "../lib/docs";
import { commentTitleOf, editedTitle } from "../lib/needs";
import { ANSWERS_COMMENT_LABEL } from "../lib/proposals";
import type { Proposal, WorkstreamView } from "../types";
import { DraftCard, keepEditsOfDraft, settleKeptEdits } from "./DraftCard";
import { liveDraft, setLiveDraft } from "./draftLive";
import { reporterAnswered, pushWaitToast } from "./NeedsPane";
import { TurnView } from "./PipConversation";
import { ORIENTATION_TERMS } from "./PipOrientation";
import { stepBatchLabel } from "./workViewLogic";
import { StepDrafts } from "./StepRail";
import { useToasts } from "./toasts";
import { useWorkstreams } from "./workstreamsStore";

// Backlog items of the fifteenth dogfood round: a secret masked in the person's bubble and the draft previews (G16), a note that
// the reporter is waited on taken back once they reply (G23), an edited marker on previews and rows (G25), the step rail's batch
// named by its scope (G26), the start review's plain lead and pinned actions (G27), the glossary's stage and status words (G28),
// and the plan's scope said in its heading (G30).

const SECRET = "hunter22secret";

const draft = (id: string, text: string, over: Partial<Proposal> = {}): Proposal => ({
  id,
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "chat", requestId: "q1" },
  createdBy: "pip",
  intent: { type: "comment", item: itemRef("CA-412"), body: docFromText(text) },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

const turn = (over: Partial<Turn> = {}): Turn => ({ requestId: "q1", prompt: `Reply with Password: ${SECRET}`, steps: [], text: "", status: "done", error: null, ...over });

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useToasts.getState().clear();
});

describe("a pasted secret in the app (G16)", () => {
  it("is masked in the person's own bubble and in the draft's preview card, with the rest kept", () => {
    const html = renderToStaticMarkup(<TurnView turn={turn()} proposals={[draft("d1", `Thanks. Password: ${SECRET}. Please retry.`)]} />);
    expect(html).not.toContain(SECRET);
    expect(html).toContain("Reply with Password: hu…");
    expect(html).toContain("Thanks. Password: hu… Please retry.");
  });

  it("is masked in the quote the person's bubble shows too", () => {
    const html = renderToStaticMarkup(<TurnView turn={turn({ prompt: "About this", quote: `token = ${SECRET}` })} proposals={[]} />);
    expect(html).not.toContain(SECRET);
    expect(html).toContain("token = hu…");
  });

  it("is masked in a reply the preview shows for an agent's question, but not on the card being edited", () => {
    const reply = draft("d2", "x", { intent: { type: "runAnswer", runId: "r1", message: `The password is ${SECRET}`, question: "Which password?" } as Proposal["intent"] });
    expect(renderToStaticMarkup(<TurnView turn={turn({ prompt: "ok" })} proposals={[reply]} />)).not.toContain(SECRET);
    const card = renderToStaticMarkup(<DraftCard proposal={draft("d3", `Password: ${SECRET}`)} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} onReview={vi.fn()} />);
    expect(card).toContain(SECRET);
  });
});

describe("the note that the reporter is waited on (G23)", () => {
  const view = (replied: boolean) => ({ workstream: { id: "ws-1" }, reporterReplied: replied }) as unknown as WorkstreamView;

  it("reads the reporter's reply from the workstream", () => {
    expect(reporterAnswered([view(false)], "ws-1")).toBe(false);
    expect(reporterAnswered([view(true)], "ws-1")).toBe(true);
    expect(reporterAnswered([view(true)], "ws-2")).toBe(false);
  });

  it("is taken off the screen when the workstream's reporter replies, and stays while they have not", () => {
    useWorkstreams.setState({ list: [view(false)] });
    pushWaitToast("CA-408 now waits on the reporter; nothing starts on its own.", "ws-1");
    expect(useToasts.getState().toasts).toHaveLength(1);
    useWorkstreams.setState({ list: [{ ...view(false), stage: "intake" } as WorkstreamView] });
    expect(useToasts.getState().toasts).toHaveLength(1);
    useWorkstreams.setState({ list: [view(true)] });
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("stops watching once the toast has gone by itself", () => {
    useWorkstreams.setState({ list: [view(false)] });
    const subscribe = useWorkstreams.subscribe;
    const unsubscribed = vi.fn();
    vi.spyOn(useWorkstreams, "subscribe").mockImplementation((listener) => {
      const off = subscribe(listener);
      return () => (unsubscribed(), off());
    });
    pushWaitToast("CA-408 now waits on the reporter; nothing starts on its own.", "ws-1");
    expect(unsubscribed).not.toHaveBeenCalled();
    // The toast's own timer (or anything else) takes it away: the watch on the workstreams goes with it.
    useToasts.getState().clear();
    expect(unsubscribed).toHaveBeenCalled();
  });
});

describe("an edited draft on previews and rows (G25)", () => {
  it("shows a comment's edited words and an edited marker on its preview, and none once it is posted", () => {
    const p = draft("e1", "The words as stored");
    keepEditsOfDraft("e1", { body: { text: "My own words", mentions: [] } });
    const shown = renderToStaticMarkup(<TurnView turn={turn({ prompt: "ok" })} proposals={[p]} />);
    expect(shown).toContain("My own words");
    expect(shown).toContain("data-draft-edited");
    expect(shown).not.toContain("The words as stored");
    settleKeptEdits("e1", "applied");
    const after = renderToStaticMarkup(<TurnView turn={turn({ prompt: "ok" })} proposals={[p]} />);
    expect(after).toContain("The words as stored");
    expect(after).not.toContain("data-draft-edited");
  });

  it("follows a mounted card's edit, and a row's title follows the comment's words as edited", () => {
    setLiveDraft("e2", { edited: true, risky: false, text: "Typed words here" });
    expect(liveDraft("e2")?.text).toBe("Typed words here");
    const p = draft("e2", "Stored words");
    expect(renderToStaticMarkup(<TurnView turn={turn({ prompt: "ok" })} proposals={[p]} />)).toContain("Typed words here");
    setLiveDraft("e2", null);
    expect(editedTitle("Draft comment: “Stored words”", "Typed words here")).toBe(commentTitleOf("Typed words here"));
    expect(editedTitle("Draft comment: “Stored words”", undefined)).toBe("Draft comment: “Stored words”");
    // A title that is not a run-less comment's is left as it was.
    expect(editedTitle("Approve the plan", "Typed words here")).toBe("Approve the plan");
  });
});

describe("the step rail's batch (G26)", () => {
  it("is named by its scope", () => {
    expect(stepBatchLabel("pip", 2)).toBe("Approve 2 of Pip's drafts");
    expect(stepBatchLabel("build", 3)).toBe("Approve 3 of this step's drafts");
  });

  it("repeats the note that drafts from the person's own reply are not in the batch", () => {
    const answers = (id: string) => draft(id, "Answers", { label: ANSWERS_COMMENT_LABEL, origin: { type: "board" } });
    const plain = renderToStaticMarkup(<StepDrafts step="pip" drafts={[draft("b1", "One"), draft("b2", "Two")]} approve={vi.fn()} />);
    expect(plain).not.toContain("data-batch-aside");
    expect(plain).toContain("Approve 2 of Pip&#x27;s drafts");
    const html = renderToStaticMarkup(<StepDrafts step="pip" drafts={[draft("b1", "One"), answers("b3")]} approve={vi.fn()} />);
    expect(html).toContain("Not in the batch: drafts from your reply are read on their own.");
    expect(html).not.toContain("Approve 1 of");
    // While the batch is being confirmed the note stays, so the person sees what it leaves out as they decide (CodeRabbit on #181).
    const confirming = renderToStaticMarkup(<StepDrafts step="pip" drafts={[draft("b1", "One"), draft("b2", "Two"), answers("b3")]} approve={vi.fn()} initialConfirming />);
    expect(confirming).toContain("data-batch-aside");
  });
});

describe("the glossary (G28)", () => {
  it("names the stages and the status words as well", () => {
    const terms = ORIENTATION_TERMS.map((t) => t.term);
    for (const t of ["Triage", "Plan", "Build", "Review", "Pushing", "Held", "Quiet", "Idle"]) expect(terms).toContain(t);
    expect(ORIENTATION_TERMS.find((t) => t.term === "Review")!.text).toContain("Three things share the word");
  });
});
