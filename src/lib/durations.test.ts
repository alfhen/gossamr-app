import { describe, expect, it } from "vitest";
import { humanDuration } from "./durations";

describe("humanDuration", () => {
  it("says minutes below two hours", () => {
    expect(humanDuration(0)).toBe("under a minute");
    expect(humanDuration(0.5)).toBe("under a minute");
    expect(humanDuration(1)).toBe("1 min");
    expect(humanDuration(40)).toBe("40 min");
    expect(humanDuration(119)).toBe("119 min");
  });

  it("says hours below two days, rounded down", () => {
    expect(humanDuration(120)).toBe("2 h");
    expect(humanDuration(180)).toBe("3 h");
    expect(humanDuration(47 * 60 + 59)).toBe("47 h");
  });

  it("says days from two days on, never a three-figure hour count", () => {
    expect(humanDuration(48 * 60)).toBe("2 days");
    expect(humanDuration(247 * 60)).toBe("10 days");
    expect(humanDuration(30 * 24 * 60)).toBe("30 days");
  });

  it("treats a negative or non-finite span as none", () => {
    expect(humanDuration(-5)).toBe("under a minute");
    expect(humanDuration(Number.NaN)).toBe("under a minute");
  });
});
