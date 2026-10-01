import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend/mock";
import { itemRef } from "../backend/mockConnector";
import type { Proposal, RunSpec } from "../types";
import { useWorkspace } from "../workspaceStore";
import { approvableTransitions, pendingMoves } from "./boardLogic";
import { DraftCard, draftSummary, draftTitle } from "./DraftCard";
import { DraftPreview, draftPreviewBody } from "./DraftPreview";

const spec: RunSpec = { kind: "investigate", repo: "acme/web", clonePath: "/Users/sample/Code/web", base: "main", name: "ca-412-fix-ab12", instruction: "Investigate this work." };

const runDraft = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "board" },
  createdBy: "user",
  intent: { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec },
  label: null,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
  ...over,
});

describe("a startRun draft", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  });

  it("is named for the ticket and opens the setup sheet instead of approving on its card", () => {
    const p = runDraft();
    expect(draftTitle(p)).toBe("Start an agent: CA-412");
    expect(draftSummary(p, null)).toBe("investigate in acme/web");
    const props = { proposal: p, statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn() };
    const plain = renderToStaticMarkup(<DraftCard {...props} />);
    expect(plain).not.toContain("Review and start");
    const out = renderToStaticMarkup(<DraftCard {...props} onReview={vi.fn()} />);
    expect(out).toContain("Investigate CA-412");
    expect(out).toContain("Read the exact prompt and checks, then start it. Nothing runs before that.");
    expect(out).toContain("Review and start");
    expect(out).toContain("Skip");
    for (const label of ["Apply", "Working…", "Approve", "Start agent"]) expect(out).not.toContain(label);
  });

  it("shows Pip's focus note on its card as Pip's", () => {
    const withFocus = runDraft({ intent: { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec: { ...spec, focus: "Look at the retry loop." } }, createdBy: "pip" });
    const out = renderToStaticMarkup(<DraftCard proposal={withFocus} statusName={null} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} onReview={vi.fn()} />);
    expect(out).toContain("Focus from Pip:");
    expect(out).toContain("Look at the retry loop.");
  });

  it("says Pip proposed it and which run its focus came from, and still has no approve button", () => {
    const spec2 = { ...spec, focus: "Look at the retry loop.", focusFromRun: "run-7" };
    const byPip = runDraft({ intent: { type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec: spec2 }, createdBy: "pip" });
    const props = { proposal: byPip, statusName: null, people: [], working: false, error: null, onApprove: vi.fn(), onSkip: vi.fn(), onReview: vi.fn() };
    const out = renderToStaticMarkup(<DraftCard {...props} />);
    expect(out).toContain("Proposed by Pip");
    expect(out).toContain("Focus from Pip, after reading run run-7:");
    expect(out).toContain("Review and start");
    for (const label of ["Apply", "Approve", "Start agent"]) expect(out).not.toContain(label);
    expect(renderToStaticMarkup(<DraftCard {...props} proposal={runDraft()} />)).not.toContain("Proposed by Pip");
  });

  it("previews as a plain line in the conversation", () => {
    expect(draftPreviewBody(runDraft(), null)).toContain("Start an agent: CA-412");
    const out = renderToStaticMarkup(<DraftPreview proposal={runDraft()} statusName={null} targetTitle="Fix the thing" onOpen={vi.fn()} />);
    expect(out).toContain("Start an agent: CA-412");
    expect(out).toContain("Review and start →");
    expect(out).not.toContain("Approve");
  });

  it("is not a move, so the board draws no card or bulk approval for it", () => {
    const moves = pendingMoves({ p1: runDraft() });
    expect(moves.size).toBe(0);
    expect(approvableTransitions(moves, ["mock:CA-412"])).toEqual([]);
  });

  it("cannot be approved through the workspace store, and the backend is never asked", async () => {
    const backend = new MockBackend();
    const spy = vi.spyOn(backend, "proposalsApprove");
    await useWorkspace.getState().init(backend);
    await backend.proposalsCreate({ type: "startRun", connectionId: "mock", item: itemRef("CA-412"), spec });
    await useWorkspace.getState().refreshProposals();
    const id = Object.values(useWorkspace.getState().proposals).find((p) => p.intent.type === "startRun")!.id;
    await expect(useWorkspace.getState().approve(id)).rejects.toThrow(/own button/);
    expect(spy).not.toHaveBeenCalled();
    useWorkspace.getState().dispose();
  });
});
