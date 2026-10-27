import { describe, expect, it } from "vitest";
import { goneOnRouteChange } from "./ToastHost";

describe("round 10 backlog", () => {
  it("G32: a route change takes away the toasts that offer no Undo and keeps the ones that do", () => {
    const undo = { label: "Undo", run: () => {} };
    expect(goneOnRouteChange([{ id: 1, at: 0 }, { id: 2, at: 0, action: undo }, { id: 3, at: 0 }], 10_000)).toEqual([1, 3]);
    expect(goneOnRouteChange([], 10_000)).toEqual([]);
    // One pushed with the change, as "Drafted a new ticket" is as Drafts opens, is about the page it lands on.
    expect(goneOnRouteChange([{ id: 1, at: 9_900 }, { id: 2, at: 1_000 }], 10_000)).toEqual([2]);
  });
});
