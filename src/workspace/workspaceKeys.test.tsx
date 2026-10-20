import { describe, expect, it } from "vitest";
import { focusLost } from "./commands";

describe("where the keyboard is after the page changed under it (G8)", () => {
  const body = {};
  it("is lost on the page itself, on nothing, or on an element that went away", () => {
    expect(focusLost(null, body)).toBe(true);
    expect(focusLost(body as never, body)).toBe(true);
    expect(focusLost({ isConnected: false }, body)).toBe(true);
  });

  it("is not lost on an element still in the page", () => {
    expect(focusLost({ isConnected: true }, body)).toBe(false);
  });
});
