import { describe, expect, it } from "vitest";
import { untilNextDay } from "./useNow";

describe("the timeline's day headings move on at local midnight", () => {
  it("counts the time left until the next local midnight", () => {
    expect(untilNextDay(new Date(2026, 9, 15, 23, 59, 0))).toBe(60_000);
    expect(untilNextDay(new Date(2026, 9, 15, 0, 0, 0))).toBe(new Date(2026, 9, 16).getTime() - new Date(2026, 9, 15).getTime());
    expect(untilNextDay(new Date(2026, 11, 31, 12, 0, 0))).toBe(new Date(2027, 0, 1).getTime() - new Date(2026, 11, 31, 12).getTime());
  });
});
