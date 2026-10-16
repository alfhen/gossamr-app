import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Proposal, RunSpec } from "../types";
import { DraftCard, keepEditsOfDraft, keptEditsOfDraft } from "./DraftCard";
import { draftPreviewBody } from "./DraftPreview";

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

  it("shows the kept text in edit mode when the card is back", () => {
    keepEditsOfDraft("c2", { body: { text: "My half-written reply", mentions: [] } });
    const out = renderToStaticMarkup(<DraftCard proposal={commentDraft("c2")} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);
    expect(out).toContain("My half-written reply");
    expect(out).toContain("<textarea");
    expect(out).not.toContain("Original text</");
  });
});
