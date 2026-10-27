import { commentable, parseWhere, relativePath } from "../lib/diffHunks";
import type { ChangedFile, ReviewComment, ReviewFinding, ReviewSeverity, ReviewVerdict } from "../types";
import { withoutMarkers } from "./mockRunSpec";
import { FINDING_TEXT_LIMIT } from "./mockRunResult";

/** The longest summary a review draft posts and the most inline comments it carries, as in `proposals.rs`. */
export const REVIEW_SUMMARY_LIMIT = 10_000;
export const REVIEW_COMMENTS_MAX = 50;
export const REVIEW_COMMENT_LIMIT = 5_000;
const WHERE_LIMIT = 300;
const MORE_ROOM = 200;

const LABEL: Record<ReviewSeverity, string> = { blocking: "Blocking", "should-fix": "Should fix", nit: "Nit" };

const chars = (s: string) => [...s].length;
const clip = (s: string, limit: number) => [...s].slice(0, limit).join("");

/** The agent's text as a review may carry it: on one line, without NULs or reserved markers, cut at `limit`. */
const cleaned = (text: string, limit: number) => clip(withoutMarkers(text.split("\0").join("")).split(/\s+/).filter(Boolean).join(" "), limit);

/** Whether `path` names a file: its last part has an extension of letters and digits. */
function fileLike(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1);
  return ext.length >= 1 && ext.length <= 10 && /^[A-Za-z0-9]+$/.test(ext);
}

/** A written finding's place when its text opens with it (`src/a.ts:42: the text`), and the text after it. */
function leadingPlace(text: string): [string | null, string] {
  const space = text.indexOf(" ");
  const [first, rest] = space < 0 ? [text, ""] : [text.slice(0, space), text.slice(space + 1)];
  if (!first.endsWith(":") || !rest.trim()) return [null, text];
  const place = first.slice(0, -1).replace(/^`+|`+$/g, "");
  if (place && (parseWhere(place) || (relativePath(place) && fileLike(place)))) return [place, rest.trim()];
  return [null, text];
}

/** Each severity as the verdict line counts it, singular and plural, in the order it names them. */
const COUNTED: [ReviewSeverity, string, string][] = [
  ["blocking", "blocking issue", "blocking issues"],
  ["should-fix", "should-fix", "should-fixes"],
  ["nit", "nit", "nits"],
];

/**
 * The summary's first line, as a reviewer would put it: "Not ready to merge yet: 1 blocking issue, 1 should-fix and 1
 * nit.", "Looks good to merge, with 2 should-fixes and 4 nits to look at.", "Looks good to merge. Nothing to change.".
 * The counts name only the severities found, blocking first. A blocking finding makes it not ready whatever the verdict
 * says, so the line never reads "looks good" over one. As `verdict_line` in `inbox/review_drafts.rs`.
 */
export function verdictLine(verdict: ReviewVerdict, findings: Pick<ReviewFinding, "severity">[]): string {
  const counts = COUNTED.map(([s, one, many]) => [findings.filter((f) => f.severity === s).length, one, many] as const)
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  const listed = counts.length > 1 ? `${counts.slice(0, -1).join(", ")} and ${counts[counts.length - 1]}` : (counts[0] ?? "");
  if (verdict === "blocking" || findings.some((f) => f.severity === "blocking")) return listed ? `Not ready to merge yet: ${listed}.` : "Not ready to merge yet.";
  return listed ? `Looks good to merge, with ${listed} to look at.` : "Looks good to merge. Nothing to change.";
}

/** Who wrote a review, in its last line: a Gossamr agent, reviewing `ticket` when there is one. As `drafted_by` in Rust. */
function draftedBy(ticket: string | null): string {
  const key = ticket?.trim();
  return key ? `Drafted by a Gossamr agent reviewing ${clip(key, 40)}` : "Drafted by a Gossamr agent";
}

/**
 * The review that `verdict` and `findings` come to, opening with `verdictLine`, as `review_text` in
 * `inbox/review_drafts.rs`: inline comments for findings at lines the diff shows on the new side, the rest listed in the
 * summary. `ticket` is the key of the ticket the review was for, which its last line names, never the run's id. `files` is the pull request's files at the commit the review read; null means that diff couldn't be read (it couldn't be, or the head has moved on). Both pass `src/lib/reviewDraft.fixtures.json`.
 */
export function reviewText(verdict: ReviewVerdict, findings: ReviewFinding[], files: Pick<ChangedFile, "path" | "patch">[] | null, ticket: string | null): { summary: string; comments: ReviewComment[] } {
  const header = verdictLine(verdict, findings);
  const footer = `${draftedBy(ticket)}; posted only after a person approved it in Gossamr.`;
  const comments: ReviewComment[] = [];
  const listed: string[] = [];
  for (const f of findings) {
    let text = cleaned(f.text, FINDING_TEXT_LIMIT);
    const given = f.where == null ? "" : cleaned(f.where, WHERE_LIMIT);
    let place: string | null = given || null;
    if (!place) [place, text] = leadingPlace(text);
    const body = `**${LABEL[f.severity]}:** ${text}`;
    const parsed = place ? parseWhere(place) : null;
    const at = parsed && files?.some((file) => file.path === parsed[0] && !!file.patch && commentable(file.patch, parsed[1], "RIGHT")) ? parsed : null;
    if (at) {
      const same = comments.find((c) => c.path === at[0] && c.line === at[1]);
      if (same) {
        // Findings on one line share its comment while it stays within a comment's length.
        if (chars(same.body) + chars(body) + 2 <= REVIEW_COMMENT_LIMIT) {
          same.body = `${same.body}\n\n${body}`;
          continue;
        }
      } else if (comments.length < REVIEW_COMMENTS_MAX) {
        comments.push({ path: at[0], line: at[1], side: "RIGHT", body });
        continue;
      }
    }
    listed.push(place ? `- ${body} (${place})` : `- ${body}`);
  }
  const parts = [header];
  if (!files) parts.push("The pull request's diff at this commit couldn't be read, so every finding is listed here.");
  if (listed.length) {
    let used = [...parts, footer].reduce((n, p) => n + chars(p) + 2, 0) + 40;
    const lines: string[] = [];
    for (const [i, line] of listed.entries()) {
      const len = chars(line) + 1;
      if (used + len > REVIEW_SUMMARY_LIMIT - MORE_ROOM) {
        lines.push(`- …and ${listed.length - i} more; the whole review is in Gossamr.`);
        break;
      }
      used += len;
      lines.push(line);
    }
    parts.push(`Findings without a line in the diff:\n${lines.join("\n")}`);
  }
  parts.push(footer);
  return { summary: parts.join("\n\n"), comments };
}
