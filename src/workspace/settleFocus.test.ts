import { describe, expect, it, vi } from "vitest";
import { itemRef } from "../backend/mockConnector";
import { docFromText } from "../lib/docs";
import type { Proposal } from "../types";
import { DRAFT_WAIT_MS, investigateKey, newStartDrafts, settleDraftFocus } from "./clarityActions";
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

  it("knows the ticket the chip names, and picks only that ticket's new draft", () => {
    expect(investigateKey("Investigate CA-408")).toBe("CA-408");
    expect(investigateKey("Plan this")).toBeUndefined();
    const on = (id: string, key: string, at: string): Proposal => ({ ...draft(id, "startRun", at), intent: { type: "startRun", connectionId: "mock", item: itemRef(key), spec: {} } }) as Proposal;
    const all = { x: on("x", "CA-999", "2026-10-01T10:00:00Z"), y: on("y", "CA-408", "2026-10-01T10:01:00Z") };
    expect(newStartDrafts(new Set(), all, "CA-408")).toEqual(["y"]);
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
    settleDraftFocus(new Set(), undefined, doc, (cb) => queue.push(cb));
    expect(input.focus).toHaveBeenCalled();
    step();
    expect(card.focus).not.toHaveBeenCalled();
    useWorkspace.setState({ proposals: { n1: draft("n1", "startRun", "2026-10-01T10:05:00Z") } });
    shown = true;
    step();
    expect(card.focus).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("keeps waiting while Pip takes its time, and gives up once the wait is over", () => {
    const body = {};
    const doc = { body, activeElement: body as unknown, getElementById: () => ({ value: "", focus: vi.fn() }), querySelector: () => null } as unknown as Document;
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    useWorkspace.setState({ proposals: {} });
    let clock = 0;
    const queue: (() => void)[] = [];
    settleDraftFocus(new Set(), "CA-408", doc, (cb) => queue.push(cb), () => clock);
    // Ten seconds of frames is far more than 180 of them, and it still waits.
    for (let i = 0; i < 600; i++) (clock += 16), queue.shift()?.();
    expect(queue).toHaveLength(1);
    clock = DRAFT_WAIT_MS + 1;
    queue.shift()?.();
    expect(queue).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
