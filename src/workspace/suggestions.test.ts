import { describe, expect, it } from "vitest";
import { HELD_PERSON } from "../types";
import { placeholderFor, suggestionsFor, workstreamChips, type SuggestionScene, type WorkstreamSuggestionScene } from "./suggestions";

const base: SuggestionScene = { route: "pip", quote: false, marked: 0, item: null, pendingDrafts: 0, itemDrafts: 0, unassignedInView: 0, shown: 10, filtered: false };
const ws: WorkstreamSuggestionScene = { key: "PAY-412", stage: "intake", mode: "manage", heldReason: null, hasPendingPlanRewrite: false, hasPendingStartDraft: false, investigated: false };

describe("workstream-aware suggestion chips", () => {
  it("asks for an investigation at intake, and for the next step after one", () => {
    expect(suggestionsFor({ ...base, workstream: ws })).toEqual(["Investigate PAY-412"]);
    // A run already drafted is what to read next, not another one.
    expect(suggestionsFor({ ...base, workstream: { ...ws, hasPendingStartDraft: true } })).toEqual(["What is waiting to start?"]);
    expect(suggestionsFor({ ...base, workstream: { ...ws, stage: "investigate", investigated: true } })).toEqual(["Triage this", "Plan this"]);
    expect(suggestionsFor({ ...base, workstream: { ...ws, stage: "triage", investigated: true } })).toEqual(["Plan this"]);
    expect(suggestionsFor({ ...base, workstream: { ...ws, stage: "build", investigated: true } })).not.toContain("Plan this");
  });

  it("says where to approve a plan, why it is held, what happened, and what a run is doing", () => {
    expect(workstreamChips({ ...ws, stage: "plan", investigated: true, hasPendingPlanRewrite: true })).toEqual(["Approve the plan"]);
    expect(workstreamChips({ ...ws, heldReason: HELD_PERSON })[0]).toBe("Why is this held?");
    expect(workstreamChips({ ...ws, stage: "triage", investigated: true, woke: true, running: "R2" })).toEqual(["What happened while I was away?", "What is R2 doing?"]);
    const all = workstreamChips({ ...ws, heldReason: HELD_PERSON, hasPendingPlanRewrite: true, woke: true, running: "R3", stage: "investigate", investigated: true });
    expect(all.length).toBeLessThanOrEqual(6);
    expect(all).toEqual(["Why is this held?", "Approve the plan", "What happened while I was away?", "What is R3 doing?"]);
  });

  it("on Pip home, never offers to filter the board it doesn't show: not in a workstream, not in General", () => {
    const board = /stale|blocked|unassigned|my tickets/i;
    // A workstream with nothing of its own to offer, and General.
    for (const scene of [{ ...base, workstream: { ...ws, stage: "done" as const, investigated: true } }, base, { ...base, pendingDrafts: 2 }]) {
      const chips = suggestionsFor(scene);
      expect(chips.length).toBeGreaterThan(0);
      for (const c of chips) expect(c).not.toMatch(board);
    }
    expect(suggestionsFor(base)).toEqual(["Catch me up"]);
    expect(suggestionsFor({ ...base, pendingDrafts: 1 })).toEqual(["Which drafts are safe to approve?", "Catch me up"]);
  });

  it("gives Pip home's composer its own placeholder, a peeked ticket's first", () => {
    const at = { images: false, quote: false, itemKey: null, route: "pip" as const, runOpen: false };
    expect(placeholderFor(at)).toBe("Ask about your workstreams and agents…");
    expect(placeholderFor({ ...at, workstream: true })).toBe("Ask about this workstream…");
    expect(placeholderFor({ ...at, itemKey: "CA-401" })).toBe("Ask about CA-401…");
    expect(placeholderFor({ ...at, route: "workspace" })).toBe("Ask about what you're looking at…");
  });

  it("leaves the other scenes as they were", () => {
    expect(suggestionsFor({ ...base, route: "workspace" })).toEqual(["Show stale tickets", "What is blocked?", "Show my tickets", "Catch me up"]);
    expect(suggestionsFor({ ...base, quote: true, workstream: ws })).toEqual(["Explain this", "Turn this into a ticket", "Turn this into a subtask"]);
    expect(suggestionsFor({ ...base, route: "settings", workstream: ws })).toEqual(["What can you do for me?"]);
    // The run open in its sheet comes first; a workstream with nothing to offer falls back to the screen's chips.
    expect(suggestionsFor({ ...base, workstream: ws, agents: { runs: 1, waiting: 0, done: 0, open: { stage: "going", ticket: true } } })).toEqual(["What is this run doing?"]);
    expect(suggestionsFor({ ...base, route: "workspace", workstream: { ...ws, stage: "done", investigated: true } })).toEqual(["Show stale tickets", "What is blocked?", "Show my tickets", "Catch me up"]);
  });
});
