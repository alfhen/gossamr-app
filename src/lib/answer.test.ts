import { describe, expect, it } from "vitest";
import { answerProblem } from "./answer";

describe("answerProblem", () => {
  it("follows the backend: trimmed, 1 to 4,000 characters counted as characters, no NUL", () => {
    expect(answerProblem("  Yes \n")).toBeNull();
    expect(answerProblem("   ")).toMatch(/Write an answer/);
    expect(answerProblem("😀".repeat(4000))).toBeNull();
    expect(answerProblem("😀".repeat(4001))).toMatch(/4000 characters/);
    expect(answerProblem(`  ${"x".repeat(4000)}  `)).toBeNull();
    expect(answerProblem("a\0b")).toMatch(/plain text/);
  });
});
