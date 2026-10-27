import { commentable } from "../lib/diffHunks";
import type { ChangedFile, ReviewComment } from "../types";

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
