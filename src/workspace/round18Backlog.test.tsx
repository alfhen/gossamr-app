import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import type { Proposal } from "../types";
import { DraftCard } from "./DraftCard";
import { PaletteView, START_WORKSTREAM_HINT } from "./Palette";
import { Rail } from "./Rail";
import { CLOSE_DRAFTS_NOTE, CloseConfirm } from "./WorkstreamControls";

// Smaller polish of the eighteenth dogfood round (G27).

const move = (label: string | null): Proposal => ({
  id: "m1",
  createdAt: "2026-09-30T10:00:00Z",
  updatedAt: "2026-09-30T10:00:00Z",
  origin: { type: "board" },
  createdBy: "user",
  intent: { type: "transition", item: itemRef("CA-412"), to: "31" },
  label,
  basis: null,
  state: { type: "pending" },
  revisions: [],
  created: [],
  error: null,
  run: null,
});
const card = (p: Proposal, statusName: string | null) => renderToStaticMarkup(<DraftCard proposal={p} statusName={statusName} people={[]} working={false} error={null} onApprove={vi.fn()} onSkip={vi.fn()} />);

describe("G27 polish", () => {
  it("the Start-a-workstream picker says typing finds other tickets, until something is typed", () => {
    const view = (lead?: string) => renderToStaticMarkup(<PaletteView query="" results={[]} active={0} lead={lead} onQuery={vi.fn()} onActive={vi.fn()} onRun={vi.fn()} onClose={vi.fn()} />);
    expect(START_WORKSTREAM_HINT).toBe("Only some tickets are listed. Type a key or words to find others.");
    expect(view(START_WORKSTREAM_HINT)).toContain(`data-palette-lead="true" class="m-0 border-b border-ws-sep px-3.5 py-1.5 text-xs text-ws-ink3">${START_WORKSTREAM_HINT}`);
    expect(view()).not.toContain("data-palette-lead");
  });

  it("the left rail's aside has a name", () => {
    expect(renderToStaticMarkup(<Rail />)).toMatch(/<aside data-rail="true" aria-label="Workspace sidebar"/);
  });

  it("a move whose button reads only its status is named Move to that status; a verb label is left alone", () => {
    expect(card(move("QA"), "QA")).toMatch(/<button[^>]*aria-label="Move to QA"[^>]*>QA<\/button>/);
    expect(card(move("Start progress"), "In Progress")).not.toContain("aria-label=\"Move to");
    expect(card(move(null), "QA")).toMatch(/<button[^>]*>Move to QA<\/button>/);
    expect(card(move(null), "QA")).not.toContain("aria-label=\"Move to");
  });

  it("the Close confirm counts the drafts that stay, and says nothing about them when there are none", () => {
    expect(CLOSE_DRAFTS_NOTE(1)).toBe("1 draft is still waiting and stays in General.");
    expect(CLOSE_DRAFTS_NOTE(3)).toBe("3 drafts are still waiting and stay in General.");
    expect(renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} drafts={2} />).replace(/<!-- -->/g, "")).toContain("2 drafts are still waiting and stay in General.");
    expect(renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} />)).not.toContain("still waiting");
  });
});
