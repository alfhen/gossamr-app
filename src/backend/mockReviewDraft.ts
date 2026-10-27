import { commentable } from "../lib/diffHunks";
import type { ChangedFile, ReviewComment } from "../types";

/** The review the sample reviewer leaves, in the words the review cards show. */
export const SAMPLE_REVIEW_SUMMARY = [
  "Not ready to merge yet: 1 blocking issue, 1 should-fix and 1 nit.",
  "Findings without a line in the diff:",
  "- **Should fix:** no test covers the timeout path. (src/consumer/retry.test.ts)",
].join("\n\n");

export const SAMPLE_REVIEW_COMMENTS: ReviewComment[] = [
  { path: "src/consumer/retry.ts", line: 42, side: "RIGHT", body: "**Blocking:** the retry loop never backs off, so a slow upstream gets hammered; the ticket asks for a growing delay between tries." },
  { path: "src/consumer/retry.ts", line: 17, side: "RIGHT", body: "**Nit:** the constant name `MAX` doesn't say what it limits." },
];

export function reviewText(summary: string, comments: readonly ReviewComment[], files: Pick<ChangedFile, "path" | "patch">[] | null): { summary: string; comments: ReviewComment[] } {
  const inline: ReviewComment[] = [];
  const listed: string[] = [];
  for (const comment of comments) {
    const file = files?.find((candidate) => candidate.path === comment.path);
    if (file?.patch && commentable(file.patch, comment.line, comment.side)) inline.push(comment);
    else listed.push(`- ${comment.body} (${comment.path}:${comment.line})`);
  }
  return { summary: [summary, listed.length ? `Comments outside the reviewed diff:
${listed.join("\n")}` : null].filter(Boolean).join("\n\n"), comments: inline };
}
