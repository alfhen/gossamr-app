import { commentable, parseWhere, relativePath } from "../lib/diffHunks";
import type { ChangedFile, ReviewComment, ReviewFinding, ReviewSeverity, ReviewVerdict } from "../types";
import { withoutMarkers } from "./mockRunKinds";
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

/**
 * The review of pull request `number` at `commitSha` that `findings` come to, as `review_text` in
 * `inbox/review_drafts.rs`: inline comments for findings at lines the diff shows on the new side, the rest listed in the
 * summary. `files` null means the diff at `commitSha` couldn't be read (it couldn't be, or the head has moved on). Both pass `src/lib/reviewDraft.fixtures.json`.
 */
export function reviewText(number: number, commitSha: string, verdict: ReviewVerdict, findings: ReviewFinding[], files: Pick<ChangedFile, "path" | "patch">[] | null, run: string): { summary: string; comments: ReviewComment[] } {
  const count = (s: ReviewSeverity) => findings.filter((f) => f.severity === s).length;
  const nits = count("nit");
  const header = `Gossamr review of #${number} at ${clip(commitSha, 8)}: ${verdict} (${count("blocking")} blocking, ${count("should-fix")} should-fix, ${nits} ${nits === 1 ? "nit" : "nits"}).`;
  const footer = `Drafted from agent run ${run}; posted only after a person approved it in Gossamr.`;
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
        lines.push(`- …and ${listed.length - i} more; the whole review is in agent run ${run}.`);
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
