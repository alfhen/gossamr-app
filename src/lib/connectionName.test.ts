import { describe, expect, it } from "vitest";
import { NAME_LIMIT, nameProblem } from "./connectionName";

describe("a connection's display name", () => {
  it("accepts a plain name, with or without spaces around it", () => {
    expect(nameProblem("Work GitHub")).toBeNull();
    expect(nameProblem("  Work GitHub ")).toBeNull();
  });

  it("refuses an empty name, a long one and one with a line break", () => {
    expect(nameProblem("   ")).toMatch(/name/);
    expect(nameProblem("x".repeat(NAME_LIMIT))).toBeNull();
    expect(nameProblem("x".repeat(NAME_LIMIT + 1))).toMatch(/60/);
    expect(nameProblem("Work\nGitHub")).toMatch(/line breaks/);
  });
});
