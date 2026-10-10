import { describe, expect, it } from "vitest";
import type { ReviewComment, ReviewFinding, ReviewVerdict } from "../types";
import fixtures from "../lib/reviewDraft.fixtures.json";
import { REVIEW_COMMENTS_MAX, REVIEW_COMMENT_LIMIT, REVIEW_SUMMARY_LIMIT, reviewText } from "./mockReviewDraft";

interface Case {
  name: string;
  number: number;
  commitSha: string;
  verdict: string;
  run: string;
  findings: ReviewFinding[];
  files: { path: string; patch: string | null; truncated: boolean }[] | null;
  expect: { summary: string; comments: ReviewComment[] };
}

describe("review draft text, on the fixtures the Rust builder also passes", () => {
  it.each(fixtures as Case[])("$name", (c) => {
    expect(reviewText(c.number, c.commitSha, c.verdict as ReviewVerdict, c.findings, c.files, c.run)).toEqual(c.expect);
  });

  it("cuts a long list of findings with a note and stays within the limit", () => {
    const findings: ReviewFinding[] = Array.from({ length: 40 }, (_, n) => ({ severity: "nit", text: `${n} ${"x".repeat(590)}`, where: `src/f${n}.ts` }));
    const { summary } = reviewText(12, "a1b2c3d4e5f6", "pass", findings, [], "ab12cd34");
    expect([...summary].length).toBeLessThanOrEqual(REVIEW_SUMMARY_LIMIT);
    expect(summary).toContain("more; the whole review is in agent run ab12cd34.");
  });

  it("puts at most fifty findings inline and lists the rest", () => {
    const patch = `@@ -0,0 +1,60 @@\n${Array.from({ length: 60 }, (_, n) => `+line ${n + 1}`).join("\n")}`;
    const findings: ReviewFinding[] = Array.from({ length: 55 }, (_, n) => ({ severity: "nit", text: `n${n + 1}`, where: `src/a.ts:${n + 1}` }));
    const text = reviewText(12, "a1b2c3d4e5f6", "pass", findings, [{ path: "src/a.ts", patch }], "ab12cd34");
    expect(text.comments).toHaveLength(REVIEW_COMMENTS_MAX);
    expect(text.summary).toContain("- **Nit:** n51 (src/a.ts:51)");
  });

  it("shares one line's comment between its findings only while it fits", () => {
    const findings: ReviewFinding[] = Array.from({ length: 12 }, (_, n) => ({ severity: "nit", text: `${n} ${"x".repeat(590)}`, where: "src/a.ts:1" }));
    const text = reviewText(12, "a1b2c3d4e5f6", "pass", findings, [{ path: "src/a.ts", patch: "@@ -0,0 +1,1 @@\n+line" }], "ab12cd34");
    expect(text.comments).toHaveLength(1);
    expect([...text.comments[0].body].length).toBeLessThanOrEqual(REVIEW_COMMENT_LIMIT);
    expect(text.summary).toContain("- **Nit:** 11 ");
  });
});
