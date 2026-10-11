import type { DiffSide } from "../types";

/**
 * Unified diffs as a pull request's files carry them, and where in one a review comment may sit, as `codehost/diff.rs`.
 * A comment can only go on a line the diff shows: on the right an added or unchanged line of the new file, on the left a
 * deleted or unchanged line of the old one. Both pass `diffHunks.fixtures.json`.
 */

export type DiffLineKind = "context" | "added" | "deleted";

/** One line of a hunk, with its number in the old file (`left`) and the new one (`right`) where it has one. */
export interface DiffLine {
  kind: DiffLineKind;
  left: number | null;
  right: number | null;
  /** The line as the patch has it, with its leading `+`, `-` or space. */
  raw: string;
}

/** One `@@` section: where it starts on either side, how many lines its header says, and the lines that arrived. */
export interface Hunk {
  leftStart: number;
  leftLines: number;
  rightStart: number;
  rightLines: number;
  lines: DiffLine[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The hunks of a file's patch; lines outside a hunk, `\ No newline at end of file` and anything past what a header promised are left out. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let [left, right, leftLeft, rightLeft] = [0, 0, 0, 0];
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const h = HEADER.exec(line);
    if (h) {
      const hunk: Hunk = { leftStart: +h[1], leftLines: h[2] === undefined ? 1 : +h[2], rightStart: +h[3], rightLines: h[4] === undefined ? 1 : +h[4], lines: [] };
      [left, right, leftLeft, rightLeft] = [hunk.leftStart, hunk.rightStart, hunk.leftLines, hunk.rightLines];
      hunks.push(hunk);
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    if (!hunk) continue;
    const first = line[0];
    const kind: DiffLineKind | null = first === undefined || first === " " ? "context" : first === "+" ? "added" : first === "-" ? "deleted" : null;
    if (!kind) continue;
    const fits = kind === "context" ? leftLeft > 0 && rightLeft > 0 : kind === "added" ? rightLeft > 0 : leftLeft > 0;
    if (!fits) continue;
    const l = kind === "added" ? null : left;
    const r = kind === "deleted" ? null : right;
    if (l !== null) [left, leftLeft] = [left + 1, leftLeft - 1];
    if (r !== null) [right, rightLeft] = [right + 1, rightLeft - 1];
    hunk.lines.push({ kind, left: l, right: r, raw: line });
  }
  return hunks;
}

const numberOn = (l: DiffLine, side: DiffSide) => (side === "LEFT" ? l.left : l.right);

function find(hunks: Hunk[], line: number, side: DiffSide): [number, number] | null {
  for (const [h, hunk] of hunks.entries()) {
    const i = hunk.lines.findIndex((l) => numberOn(l, side) === line);
    if (i >= 0) return [h, i];
  }
  return null;
}

/** Whether a review comment may sit at `line` on `side`: the patch shows that line there. */
export function commentable(patch: string, line: number, side: DiffSide): boolean {
  return line > 0 && find(parsePatch(patch), line, side) !== null;
}

/** The lines of the patch around `line` on `side`, up to `context` either side within its hunk, and which of them is `line`; null when the patch doesn't show it. */
export function hunkLinesAround(patch: string, line: number, side: DiffSide, context = 3): { lines: DiffLine[]; at: number } | null {
  const hunks = parsePatch(patch);
  const found = find(hunks, line, side);
  if (!found) return null;
  const lines = hunks[found[0]].lines;
  const [from, to] = [Math.max(0, found[1] - context), Math.min(lines.length - 1, found[1] + context)];
  return { lines: lines.slice(from, to + 1), at: found[1] - from };
}

/** The lines of the patch around `line` on `side`, up to `context` either side within its hunk; null when the patch doesn't show it. */
export function hunkAround(patch: string, line: number, side: DiffSide, context = 3): string | null {
  return (
    hunkLinesAround(patch, line, side, context)
      ?.lines.map((l) => l.raw)
      .join("\n") ?? null
  );
}

/** Whether `path` is a plain relative path inside the repository: no spaces, not absolute, no `..`, not a URL. */
export function relativePath(path: string): boolean {
  return !!path && !/\s/.test(path) && !path.includes("://") && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((seg) => seg === ".." || seg === "");
}

const DIGITS = /^\d+$/;

/** The file and line a finding's `where` names: `path:N`, `path:N-M` (taking N) or `path:N:col`; null for anything else, a path with spaces, a URL, or line 0. */
export function parseWhere(text: string): [string, number] | null {
  const trimmed = text.trim().replace(/^`+|`+$/g, "").trim();
  if (trimmed.includes("://")) return null;
  const colon = trimmed.indexOf(":");
  if (colon < 0) return null;
  let path = trimmed.slice(0, colon);
  const rest = trimmed.slice(colon + 1);
  if (path.startsWith("./")) path = path.slice(2);
  const dash = rest.indexOf("-");
  const second = rest.indexOf(":");
  let line: string;
  if (dash >= 0 && second < 0 && DIGITS.test(rest.slice(0, dash)) && DIGITS.test(rest.slice(dash + 1))) line = rest.slice(0, dash);
  else if (second >= 0 && dash < 0 && DIGITS.test(rest.slice(0, second)) && DIGITS.test(rest.slice(second + 1))) line = rest.slice(0, second);
  else if (dash < 0 && second < 0 && DIGITS.test(rest)) line = rest;
  else return null;
  const n = Number(line);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffffffff) return null;
  return relativePath(path) ? [path, n] : null;
}
