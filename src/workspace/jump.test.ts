import { afterEach, describe, expect, it, vi } from "vitest";
import { focusComment } from "./jump";

afterEach(() => vi.unstubAllGlobals());

describe("focusComment", () => {
  it("takes the keyboard to the comment in the peek, making it focusable without scrolling the page", () => {
    const attrs = new Map<string, string>();
    const el = { hasAttribute: (n: string) => attrs.has(n), setAttribute: (n: string, v: string) => void attrs.set(n, v), focus: vi.fn() };
    vi.stubGlobal("document", { getElementById: (id: string) => (id === "comment-c1" ? el : null) });
    expect(focusComment("c1")).toBe(true);
    expect(attrs.get("tabindex")).toBe("-1");
    expect(el.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does nothing for a comment that isn't shown", () => {
    vi.stubGlobal("document", { getElementById: () => null });
    expect(focusComment("gone")).toBe(false);
  });
});
