import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import type { Proposal } from "../types";
import { DraftCard } from "./DraftCard";
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
  it("the left rail's aside has a name", () => {
    expect(renderToStaticMarkup(<Rail />)).toMatch(/<aside data-rail="true" aria-label="Workspace sidebar"/);
  });

  it("a move's button is Approve, whichever status it names", () => {
    expect(card(move("QA"), "QA")).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(card(move("Start progress"), "In Progress")).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(card(move(null), "QA")).toMatch(/<button[^>]*>Approve<\/button>/);
  });

  it("the Close confirm counts the drafts that stay, and says nothing about them when there are none", () => {
    expect(CLOSE_DRAFTS_NOTE(1)).toBe("1 draft is still waiting and stays in General.");
    expect(CLOSE_DRAFTS_NOTE(3)).toBe("3 drafts are still waiting and stay in General.");
    expect(renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} drafts={2} />).replace(/<!-- -->/g, "")).toContain("2 drafts are still waiting and stay in General.");
    expect(renderToStaticMarkup(<CloseConfirm onClose={vi.fn()} onKeep={vi.fn()} />)).not.toContain("still waiting");
  });
});
