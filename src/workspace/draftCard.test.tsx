import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Proposal, RunSpec } from "../types";
import { ANSWERS_COMMENT_LABEL, NUDGE_COMMENT_LABEL, READINESS_COMMENT_LABEL } from "../lib/proposals";
import { useToasts } from "./toasts";
import { DraftCard, SECRET_NOTE, answersRisks, rewriteRisks, postedNote, keepEditsOfDraft, keptEditsOfDraft, settleKeptEdits } from "./DraftCard";
import { KeyHint } from "./KeyHint";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";

const spec: RunSpec = { kind: "investigate", repo: "acme/web", clonePath: "/Users/sample/Code/web", base: "main", name: "ca-412-fix-ab12", instruction: "Investigate this work." };
const BEFORE = "Read the exact prompt and checks, then start it. Nothing runs before that.";

const runDraft = (state: Proposal["state"]): Proposal => ({
  id: "p1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "board" },
  createdBy: "user",
  intent: { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec },
  label: null,
  basis: null,
  state,
  revisions: [],
  created: [],
  error: null,
  run: null,
});

const commentDraft = (id: string): Proposal => ({ ...runDraft({ type: "pending" }), id, intent: { type: "comment", item: itemRef("CA-412"), body: docFromText("Original text") } });

describe("a startRun draft once the agent started (G13)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });
  const card = (p: Proposal) => renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} onReview={vi.fn()} />);

  it("keeps the pre-start sentence while pending and says it started once applied, on the card and in the preview", () => {
    expect(card(runDraft({ type: "pending" }))).toContain(BEFORE);
    expect(draftPreviewBody(runDraft({ type: "pending" }), null)).toContain(BEFORE.replace(" and checks", ""));
    const applied = runDraft({ type: "applied" });
    expect(card(applied)).not.toContain("Nothing runs before that");
    expect(card(applied)).toContain("Started: see its run in the steps.");
    expect(draftPreviewBody(applied, null)).not.toContain("Nothing runs before that");
    expect(draftPreviewBody(applied, null)).toContain("Started: see its run in the steps.");
  });
});

describe("a skipped draft's unsaved edit (G2)", () => {
  it("is kept for the card that comes back, and nothing is kept without an edit", () => {
    keepEditsOfDraft("c1", {});
    expect(keptEditsOfDraft("c1")).toBeUndefined();
    keepEditsOfDraft("c1", { body: { text: "My half-written reply", mentions: [] } });
    expect(keptEditsOfDraft("c1")?.body?.text).toBe("My half-written reply");
  });

  it("shows the kept text as a preview with an Edit button when the card is back, not an open editor (G26)", () => {
    keepEditsOfDraft("c2", { body: { text: "My half-written reply", mentions: [] } });
    const out = renderToStaticMarkup(<DraftCard proposal={commentDraft("c2")} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(out).toContain("My half-written reply");
    expect(out).not.toContain("<textarea");
    expect(out).toMatch(/data-draft-edit[^>]*>Edit</);
    expect(out).not.toContain("Done editing");
    expect(out).not.toContain("Original text</");
  });

  it("stays kept while the draft can still be shown, so a card left again comes back with it, and goes once it is posted or retired", () => {
    keepEditsOfDraft("c3", { body: { text: "Restored once", mentions: [] } });
    renderToStaticMarkup(<DraftCard proposal={commentDraft("c3")} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(keptEditsOfDraft("c3")?.body?.text).toBe("Restored once");
    for (const state of ["pending", "applying", "skipped"] as const) {
      settleKeptEdits("c3", state);
      expect(keptEditsOfDraft("c3")?.body?.text, state).toBe("Restored once");
    }
    settleKeptEdits("c3", "applied");
    expect(keptEditsOfDraft("c3")).toBeUndefined();
    keepEditsOfDraft("c4", { message: "Try again" });
    settleKeptEdits("c4", "retired");
    expect(keptEditsOfDraft("c4")).toBeUndefined();
    keepEditsOfDraft("c5", { message: "Typed" });
    keepEditsOfDraft("c5", {});
    expect(keptEditsOfDraft("c5")).toBeUndefined();
  });

  it("brings back which subtasks were unticked, and a card with nothing kept starts with every one ticked", () => {
    const subtasks = (id: string): Proposal => ({ ...runDraft({ type: "pending" }), id, intent: { type: "subtasks", parent: itemRef("CA-412"), summaries: ["Write the copy", "Add the banner"] } });
    const card = (id: string) => renderToStaticMarkup(<DraftCard proposal={subtasks(id)} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    const ticks = (html: string) => [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0].includes("checked"));
    expect(ticks(card("s1"))).toEqual([true, true]);
    keepEditsOfDraft("s2", { picked: [true, false] });
    expect(ticks(card("s2"))).toEqual([true, false]);
    // The note by Create says it makes the ticked ones in Jira as the person (G11).
    expect(card("s1")).toContain("Creates 2 subtasks under CA-412 in Jira as you.");
    expect(card("s2")).toContain("Creates 1 subtask under CA-412 in Jira as you.");
  });
});

describe("what a post from a card says (G3)", () => {
  const questions = (state: Proposal["state"]): Proposal => ({ ...commentDraft("q1"), label: READINESS_COMMENT_LABEL, intent: { type: "comment", item: itemRef("CA-408"), body: docFromText("Hi, a few things need clearing up.") }, state });
  it("says once what was posted, and that the ticket waits on the reporter when the questions went", () => {
    const p = commentDraft("c1");
    expect(postedNote(p, { ...p, state: { type: "applied" } })).toBe("Posted to Jira: Comment on CA-412.");
    expect(postedNote(p, p)).toBeNull();
    expect(postedNote(p, null)).toBeNull();
    const asked = questions({ type: "applied" });
    const note = postedNote(asked, asked);
    expect(note).toMatch(/^Posted to Jira: /);
    expect(note).toBe("Posted to Jira: Questions for the reporter on CA-408. CA-408 now waits on the reporter; nothing starts on its own.");
  });
  it("is one polite status message", () => {
    useToasts.getState().clear();
    const p = commentDraft("c1");
    const note = postedNote(p, { ...p, state: { type: "applied" } });
    useToasts.getState().push(note!, "info");
    expect(useToasts.getState().toasts.map((t) => [t.text, t.tone])).toEqual([["Posted to Jira: Comment on CA-412.", "info"]]);
    useToasts.getState().clear();
  });
});

describe("a comment draft's edit field and provenance (G4)", () => {
  it("names the edit field after the ticket, and keeps a space between the pill and the sentence", () => {
    keepEditsOfDraft("g4", { body: { text: "Edited", mentions: [] } });
    const out = renderToStaticMarkup(<DraftCard proposal={commentDraft("g4")} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    // Kept edits come back as a preview (G26); the editor opens from Edit and is named after the ticket.
    expect(out).not.toContain("<textarea");
    expect(out).toContain("Edited");
    const asked: Proposal = { ...commentDraft("g4b"), origin: { type: "chat", requestId: "r1" }, label: READINESS_COMMENT_LABEL, intent: { type: "comment", item: itemRef("CA-408"), body: docFromText("Hi") } };
    const html = renderToStaticMarkup(<DraftCard proposal={asked} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(html).toMatch(/Drafted by Gossamr<\/span> Gossamr wrote/);
  });
});

describe("an answers draft built from the person's reply (G2)", () => {
  it("pauses for a pasted secret or @everyone even when unedited, and a clean one posts at once", () => {
    expect(answersRisks("1. \u201cWhich env?\u201d\nAnswer: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789").risks).toEqual(["secret"]);
    expect(answersRisks("Answer: @everyone please check").risks).toEqual(["broadcast"]);
    expect(answersRisks("Answer: the staging environment, as in the ticket").risks).toEqual([]);
  });
});

describe("a nudge for the reporter says who Jira notifies (G6)", () => {
  it("shows the posts-as-you line for the @-mentioned reporter, as the questions card does", () => {
    const nudge: Proposal = { ...commentDraft("n1"), label: NUDGE_COMMENT_LABEL, intent: { type: "comment", item: itemRef("CA-412"), body: docFromText("Hi @Mette Lund,\n\nThe earlier questions about CA-412 are still open.") } };
    const html = renderToStaticMarkup(<DraftCard proposal={nudge} statusName={null} people={[{ accountId: "a1", name: "Mette Lund" }]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} onReview={vi.fn()} />);
    expect(html).toContain("Posts as you; Jira notifies Mette Lund.");
  });
});

describe("an edited description's posting pause counts lines in the description (G4)", () => {
  it("quotes a catch on the description's first line as line 1, and the title's without a line", () => {
    const { risks, quote } = rewriteRisks("Old", "Old text", "Old", "Hello @everyone password: hunter2hunter2\nsecond line");
    expect(risks.sort()).toEqual(["broadcast", "secret"]);
    expect(quote.broadcast).toEqual(["@everyone\t1"]);
    expect(quote.secret?.[0]).toMatch(/\t1$/);
    expect(rewriteRisks("Old", "a\nb", "Hi @here", "a\nb").quote.broadcast).toEqual(["@here"]);
  });
});

describe("a comment being read that holds something secret-like (G22)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });
  const card = (p: Proposal) => renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
  const answers = (text: string): Proposal => ({ ...commentDraft("g22"), createdBy: "pip", label: ANSWERS_COMMENT_LABEL, intent: { type: "comment", item: itemRef("CA-412"), body: docFromText(text) } });

  it("says it will pause before posting and keeps the text as written", () => {
    const out = card(answers("Answer: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
    expect(out).toContain("data-secret-note");
    expect(out).toContain(SECRET_NOTE);
    expect(out).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("says nothing on a draft without one", () => {
    expect(card(answers("Answer: the staging one"))).not.toContain("data-secret-note");
    expect(card(commentDraft("g22b"))).not.toContain("data-secret-note");
  });
});

describe("the Start-an-agent card's name (G28)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  it("is labelled by its heading, so its title is read once", () => {
    const out = renderToStaticMarkup(<DraftCard proposal={runDraft({ type: "pending" })} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} onReview={vi.fn()} />);
    const id = out.match(/aria-labelledby="([^"]+)"/)![1];
    expect(out).toMatch(new RegExp(`<h3 id="${id}"[^>]*>Start an agent: CA-412</h3>`));
    expect(out).not.toContain('aria-label="Start an agent');
  });

  it("is so in the preview too, with no status role for the key hint", () => {
    const out = renderToStaticMarkup(<DraftPreview proposal={runDraft({ type: "pending" })} statusName={null} targetTitle={null} onOpen={vi.fn()} onApprove={vi.fn()} onSkip={vi.fn()} />);
    const id = out.match(/aria-labelledby="([^"]+)"/)![1];
    expect(out).toMatch(new RegExp(`<h3 id="${id}"[^>]*>Start an agent: CA-412</h3>`));
    expect(out).not.toContain('aria-label="Start an agent');
    expect(out).not.toContain('role="status"');
  });
});

describe("an edited description draft's provenance (G5)", () => {
  const rewriteDraft = (id: string): Proposal => ({
    ...runDraft({ type: "pending" }),
    id,
    origin: { type: "run", runId: "r1", shortId: null } as Proposal["origin"],
    createdBy: "agent",
    intent: { type: "rewrite", item: itemRef("CA-412"), title: null, body: { from: docFromText("a"), to: docFromText("b"), fromText: "a", toText: "b" }, flattened: [] } as unknown as Proposal["intent"],
  });
  const render = (p: Proposal) => renderToStaticMarkup(<DraftCard proposal={p} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);

  it("says the words are the agent's until the person edits the rewrite, then that they edited it", () => {
    expect(render(rewriteDraft("rw1"))).toContain("The words are the agent&#x27;s.");
    keepEditsOfDraft("rw2", { rewrite: { title: "CA-412", text: "b @everyone" } });
    const out = render(rewriteDraft("rw2"));
    expect(out).toContain("You edited it; read it before you approve.");
    expect(out).not.toContain("The words are the agent");
  });
});

describe("the key hint's live region", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });
  const live = (html: string) => html.match(/<p aria-live="polite"[^>]*data-key-live[^>]*class="sr-only"[^>]*>(.*?)<\/p>/)?.[1];

  it("leaves out the visible line while there is no hint, so only the live region is there", () => {
    const out = renderToStaticMarkup(<KeyHint hint="" asking={false} className="x" />);
    expect(out).toBe('<p aria-live="polite" data-key-live="true" class="sr-only"></p>');
  });

  it("is mounted on a card before any hint, and empty", () => {
    const out = renderToStaticMarkup(<DraftCard proposal={commentDraft("kh1")} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(live(out)).toBe("");
  });

  it("is empty while the hint only lists keys, and the visible hint is not live", () => {
    const out = renderToStaticMarkup(<KeyHint hint="a approve · e edit" asking={false} className="x" />);
    expect(live(out)).toBe("");
    expect(out).toMatch(/<p data-key-hint="true" class="x">a approve · e edit<\/p>/);
  });

  it("holds the confirmation while asking, and the visible hint still has no aria-live", () => {
    const out = renderToStaticMarkup(<KeyHint hint="↵ approve · any other key cancels" asking className="x" />);
    expect(live(out)).toBe("↵ approve · any other key cancels");
    const visible = out.match(/<p [^>]*data-key-hint[^>]*>/)![0];
    expect(visible).not.toContain("aria-live");
  });
});
