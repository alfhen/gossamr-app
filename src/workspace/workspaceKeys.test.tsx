import { describe, expect, it } from "vitest";
import { GENERAL_KEY_OFF, focusLost, generalKeyOutcome } from "./commands";

describe("Ctrl+0 inside a workstream (G7)", () => {
  it("goes on to General from the keyboard anywhere, and from Pip's composer while it is empty or only whitespace", () => {
    expect(generalKeyOutcome(null)).toBe("open");
    expect(generalKeyOutcome("")).toBe("open");
    expect(generalKeyOutcome("  \n ")).toBe("open");
  });

  it("is off while the composer holds a message, and says so", () => {
    expect(generalKeyOutcome("half a thought")).toBe("off");
    expect(GENERAL_KEY_OFF).toBe("Ctrl+0 is off while you type; clear or send the message first");
  });
});

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
