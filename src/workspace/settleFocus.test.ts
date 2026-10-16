import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Proposal } from "../types";
import { newStartDrafts, settleDraftFocus } from "./clarityActions";
import { isInvestigateChip } from "./suggestions";
import { useWorkspace } from "../workspaceStore";

const draft = (id: string, type: "startRun" | "comment", at: string, state: "pending" | "applied" = "pending"): Proposal =>
  ({
    id,
    createdAt: at,
    updatedAt: at,
    origin: { type: "board" },
    createdBy: "pip",
    intent: type === "comment" ? { type, item: itemRef("CA-412"), body: docFromText("x") } : { type, connectionId: "mock", item: itemRef("CA-412"), spec: {} },
    label: null,
    basis: null,
    state: { type: state },
    revisions: [],
    created: [],
    error: null,
    run: null,
  }) as unknown as Proposal;

describe("the keyboard after a suggestion chip (G6)", () => {
  it("knows the Investigate chip, and no other", () => {
    expect(isInvestigateChip("Investigate CA-408")).toBe(true);
    expect(isInvestigateChip("Plan this")).toBe(false);
    expect(isInvestigateChip("What is Investigate doing?")).toBe(false);
  });

  it("finds the new pending start drafts only, oldest first", () => {
    const all = { a: draft("a", "startRun", "2026-10-01T10:00:00Z"), b: draft("b", "startRun", "2026-10-01T10:02:00Z"), c: draft("c", "comment", "2026-10-01T10:03:00Z"), d: draft("d", "startRun", "2026-10-01T10:04:00Z", "applied"), e: draft("e", "startRun", "2026-10-01T10:01:00Z") };
    expect(newStartDrafts(new Set(["a"]), all)).toEqual(["e", "b"]);
  });

  it("parks the keyboard on the composer, then moves it to the new draft's card once it renders", () => {
    const body = {};
    const input = { value: "", focus: vi.fn() };
    const card = { focus: vi.fn() };
    let shown = false;
    const doc = {
      body,
      activeElement: body as unknown,
      getElementById: () => input,
      querySelector: (sel: string) => (shown && sel === 'article[data-draft="n1"]' ? card : null),
    } as unknown as Document;
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    const queue: (() => void)[] = [];
    const step = () => queue.shift()?.();
    useWorkspace.setState({ proposals: {} });
    settleDraftFocus(new Set(), doc, (cb) => queue.push(cb));
    expect(input.focus).toHaveBeenCalled();
    step();
    expect(card.focus).not.toHaveBeenCalled();
    useWorkspace.setState({ proposals: { n1: draft("n1", "startRun", "2026-10-01T10:05:00Z") } });
    shown = true;
    step();
    expect(card.focus).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
