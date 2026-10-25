import { describe, expect, it } from "vitest";
import { age, relativeTime, statusTone } from "./views";

const now = new Date("2026-09-28T12:00:00Z");

describe("age", () => {
  it("shows ages in their largest whole unit", () => {
    expect([age("2026-09-28T11:20:00Z", now), age("2026-09-28T07:00:00Z", now), age("2026-09-16T12:00:00Z", now)]).toEqual(["40m", "5h", "12d"]);
  });
});

describe("statusTone", () => {
  it.each([
    ["To Do", "new", "todo"],
    ["In Progress", "indeterminate", "progress"],
    ["Code Review", "indeterminate", "review"],
    ["Blocked", "indeterminate", "blocked"],
    ["Closed", "done", "done"],
  ] as const)("%s is %s", (name, category, tone) => {
    expect(statusTone({ name, category })).toBe(tone);
  });
});

describe("relativeTime", () => {
  it.each([
    ["2026-09-28T11:59:50Z", "now"],
    ["2026-09-28T11:40:00Z", "20m"],
    ["2026-09-28T09:00:00Z", "3h"],
    ["2026-09-27T12:00:00Z", "Yday"],
    ["2026-09-25T12:00:00Z", "3d"],
  ])("%s → %s", (iso, out) => {
    expect(relativeTime(iso, now)).toBe(out);
  });
});
