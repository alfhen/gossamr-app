import { describe, expect, it } from "vitest";
import { pausedBanner, pausedText } from "./workstreamPause";

describe("pausedText", () => {
  it("says nothing for a workstream that isn't paused", () => {
    expect(pausedText(null)).toBeNull();
    expect(pausedText(undefined)).toBeNull();
  });

  it("names both reasons", () => {
    expect(pausedText("person")).toBe("Paused");
    expect(pausedText("ceiling")).toBe("Paused: Pip was woken too often today");
  });
});

describe("pausedBanner", () => {
  it("says nothing wakes Pip until the person resumes", () => {
    expect(pausedBanner("person")).toBe("Paused. Pip isn't woken until you resume it.");
    expect(pausedBanner("ceiling")).toContain("until you resume it");
    expect(pausedBanner(null)).toBeNull();
  });
});
