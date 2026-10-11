import { describe, expect, it } from "vitest";
import type { ReviewComment, ReviewFinding, ReviewVerdict } from "../types";
import fixtures from "../lib/reviewDraft.fixtures.json";
import { REVIEW_COMMENTS_MAX, REVIEW_COMMENT_LIMIT, REVIEW_SUMMARY_LIMIT, reviewText, verdictLine } from "./mockReviewDraft";

interface Case {
  name: string;
  verdict: string;
  ticket: string | null;
  findings: ReviewFinding[];
  files: { path: string; patch: string | null; truncated: boolean }[] | null;
  expect: { summary: string; comments: ReviewComment[] };
}

describe("review draft text, on the fixtures the Rust builder also passes", () => {
  it.each(fixtures as Case[])("$name", (c) => {
    expect(reviewText(c.verdict as ReviewVerdict, c.findings, c.files, c.ticket)).toEqual(c.expect);
  });

  it("cuts a long list of findings with a note and stays within the limit", () => {
    const findings: ReviewFinding[] = Array.from({ length: 40 }, (_, n) => ({ severity: "nit", text: `${n} ${"x".repeat(590)}`, where: `src/f${n}.ts` }));
    const { summary } = reviewText("pass", findings, [], "CA-402");
    expect([...summary].length).toBeLessThanOrEqual(REVIEW_SUMMARY_LIMIT);
    expect(summary).toContain("more; the whole review is in Gossamr.");
    expect(summary).toMatch(/\n\nDrafted by a Gossamr agent reviewing CA-402; posted only after a person approved it in Gossamr\.$/);
  });

  it("puts at most fifty findings inline and lists the rest", () => {
    const patch = `@@ -0,0 +1,60 @@\n${Array.from({ length: 60 }, (_, n) => `+line ${n + 1}`).join("\n")}`;
    const findings: ReviewFinding[] = Array.from({ length: 55 }, (_, n) => ({ severity: "nit", text: `n${n + 1}`, where: `src/a.ts:${n + 1}` }));
    const text = reviewText("pass", findings, [{ path: "src/a.ts", patch }], "CA-402");
    expect(text.comments).toHaveLength(REVIEW_COMMENTS_MAX);
    expect(text.summary).toContain("- **Nit:** n51 (src/a.ts:51)");
  });

  it("shares one line's comment between its findings only while it fits", () => {
    const findings: ReviewFinding[] = Array.from({ length: 12 }, (_, n) => ({ severity: "nit", text: `${n} ${"x".repeat(590)}`, where: "src/a.ts:1" }));
    const text = reviewText("pass", findings, [{ path: "src/a.ts", patch: "@@ -0,0 +1,1 @@\n+line" }], "CA-402");
    expect(text.comments).toHaveLength(1);
    expect([...text.comments[0].body].length).toBeLessThanOrEqual(REVIEW_COMMENT_LIMIT);
    expect(text.summary).toContain("- **Nit:** 11 ");
  });
});

describe("verdictLine", () => {
  const of = (blocking: number, shouldFix: number, nits: number) =>
    ([["blocking", blocking], ["should-fix", shouldFix], ["nit", nits]] as const).flatMap(([severity, n]) => Array.from({ length: n }, () => ({ severity })));

  it("says a blocking review isn't ready, naming only the severities found", () => {
    expect(verdictLine("blocking", of(1, 1, 1))).toBe("Not ready to merge yet: 1 blocking issue, 1 should-fix and 1 nit.");
    expect(verdictLine("blocking", of(2, 3, 2))).toBe("Not ready to merge yet: 2 blocking issues, 3 should-fixes and 2 nits.");
    expect(verdictLine("blocking", of(1, 0, 1))).toBe("Not ready to merge yet: 1 blocking issue and 1 nit.");
    expect(verdictLine("blocking", of(0, 0, 3))).toBe("Not ready to merge yet: 3 nits.");
    expect(verdictLine("blocking", of(0, 0, 0))).toBe("Not ready to merge yet.");
  });

  it("says a passing review looks good, with what's left to look at", () => {
    expect(verdictLine("pass", of(0, 0, 0))).toBe("Looks good to merge. Nothing to change.");
    expect(verdictLine("pass", of(0, 2, 4))).toBe("Looks good to merge, with 2 should-fixes and 4 nits to look at.");
    expect(verdictLine("pass", of(0, 1, 0))).toBe("Looks good to merge, with 1 should-fix to look at.");
    expect(verdictLine("pass", of(0, 0, 1))).toBe("Looks good to merge, with 1 nit to look at.");
  });

  it("calls a pass over a finding the agent tagged blocking not ready all the same", () => {
    expect(verdictLine("pass", of(1, 0, 1))).toBe("Not ready to merge yet: 1 blocking issue and 1 nit.");
    expect(verdictLine("pass", of(1, 0, 0))).toBe("Not ready to merge yet: 1 blocking issue.");
  });

  it("never names the pull request's number or commit", () => {
    expect(verdictLine("blocking", of(1, 1, 1))).not.toMatch(/#\d|[0-9a-f]{8}/);
  });
});
