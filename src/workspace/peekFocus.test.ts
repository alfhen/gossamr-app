import { describe, expect, it, vi } from "vitest";
import { focusPeekOf } from "./PeekSheet";

describe("focusPeekOf", () => {
  it("looks for the peek of the ticket on its own site, not any ticket with the same key", () => {
    const asked: string[] = [];
    const focus = vi.fn();
    const root = {
      querySelector: (selector: string) => {
        asked.push(selector);
        return { focus, hasAttribute: () => true };
      },
    };
    focusPeekOf({ connectionId: "mock2", externalId: "CA-402", key: "CA-402" }, root, (go) => (go(), 1), vi.fn());
    expect(asked).toEqual(['#peek-sheet[data-item="mock2:CA-402"]']);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
