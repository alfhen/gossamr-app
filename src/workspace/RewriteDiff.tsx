import { useEffect, useId, useMemo, useRef, useState } from "react";
import { changedLines, diffLines, withGaps, type DiffRow } from "../lib/textDiff";
import { withRunNamed } from "../lib/runNames";
import type { Intent, ProposalEdit } from "../types";

/** A run of one side of a changed line: `changed` when the other side doesn't have it. */
export type WordPart = { text: string; changed: boolean };

/** The most cells of the matching table a word diff may fill; a longer pair of lines is shown as wholly changed. */
const MAX_WORD_CELLS = 250_000;

/** Words, runs of spaces and single marks, so "plan (1000addd)" changes at "1000addd", not as a whole. */
const tokens = (line: string) => line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];

/** Adjacent tokens with the same mark, joined. */
function joined(parts: WordPart[]): WordPart[] {
  const out: WordPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.changed === p.changed) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/**
 * The words that differ between a removed line and the line added in its place, marked on each side, and whether the
 * two differ only in spacing, which no highlight would show.
 */
export function diffWords(from: string, to: string): { from: WordPart[]; to: WordPart[]; spacingOnly: boolean } {
  const spacingOnly = from !== to && from.replace(/\s+/g, "") === to.replace(/\s+/g, "");
  const a = tokens(from);
  const b = tokens(to);
  if ((a.length + 1) * (b.length + 1) > MAX_WORD_CELLS) return { from: [{ text: from, changed: true }], to: [{ text: to, changed: true }], spacingOnly };
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const left: WordPart[] = [];
  const right: WordPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      left.push({ text: a[i++], changed: false });
      right.push({ text: b[j++], changed: false });
    } else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      left.push({ text: a[i++], changed: true });
    } else {
      right.push({ text: b[j++], changed: true });
    }
  }
  return { from: joined(left), to: joined(right), spacingOnly };
}

/**
 * Which removed and added lines of a diff are one line changed: in each run of removed lines followed by added ones, the
 * first removed with the first added, and so on. Each is mapped to the index of the other.
 */
export function changedPairs(rows: readonly DiffRow[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") {
      i++;
      continue;
    }
    const dels = i;
    while (i < rows.length && rows[i].kind === "del") i++;
    const adds = i;
    while (i < rows.length && rows[i].kind === "add") i++;
    for (let k = 0; k < Math.min(adds - dels, i - adds); k++) {
      pairs.set(dels + k, adds + k);
      pairs.set(adds + k, dels + k);
    }
  }
  return pairs;
}

export type Rewrite = Extract<Intent, { type: "rewrite" }>;

const MARK = { add: "+", del: "−", same: " " } as const;
const SAID = { add: "Added: ", del: "Removed: ", same: "Unchanged: " } as const;
const TONE = { add: "bg-ws-done-soft text-ws-ink", del: "bg-ws-blocked-soft text-ws-ink2 line-through decoration-ws-blocked/50", same: "text-ws-ink3" } as const;
/** The words a changed line lost or gained, stronger than the line's own tint. */
const WORD = { add: "rounded-sm bg-ws-done/30 text-ws-ink", del: "rounded-sm bg-ws-blocked/25 text-ws-ink" } as const;
/** Said beside a line whose only change is whitespace, which no highlight shows. */
export const ONLY_SPACING = "only spacing changed";

/** A changed line's text with the words its pair doesn't have marked. */
function Words({ parts, kind }: { parts: WordPart[]; kind: "add" | "del" }) {
  return (
    <>
      {parts.map((w, i) =>
        w.changed ? (
          <mark key={i} data-word-changed className={WORD[kind]}>
            {w.text}
          </mark>
        ) : (
          <span key={i}>{w.text}</span>
        ),
      )}
    </>
  );
}

/** What the foot of a diff that scrolls in a box of its own says while more of it is below. */
export const SCROLL_FOR_DIFF = "Scroll for the whole diff";

/** Whether a row says nothing to a reader: a line with no text in it. A screen reader skips it; the eye still sees the gap. */
const blank = (r: DiffRow) => r.kind !== "gap" && r.text.trim() === "";

/** One line for a screen reader before the rows: how much changed (blank lines left out), so the diff need not be read to be sized. */
export function diffSummary(rows: readonly DiffRow[], what: string): string {
  const n = (kind: string) => rows.filter((r) => r.kind === kind && !blank(r)).length;
  const [added, removed] = [n("add"), n("del")];
  const part = (count: number, verb: string) => `${count} ${count === 1 ? "line" : "lines"} ${verb}`;
  const said = [added && part(added, "added"), removed && part(removed, "removed")].filter(Boolean).join(", ");
  return `${what[0].toUpperCase()}${what.slice(1)} changes: ${said || "no lines changed"}.`;
}

/** Whether the row at `i` is the first of a block of one kind: "Added:" is said once for the block, not before each line. Blank lines do not break a block. */
export function startsBlock(rows: readonly DiffRow[], i: number): boolean {
  if (blank(rows[i])) return false;
  for (let k = i - 1; k >= 0; k--) {
    if (blank(rows[k])) continue;
    return rows[k].kind !== rows[i].kind;
  }
  return true;
}

function Rows({ rows, what }: { rows: DiffRow[]; what: string }) {
  const pairs = useMemo(() => changedPairs(rows), [rows]);
  const summaryId = useId();
  // In the Decision pane the diff is capped (see NeedsPane) so the actions under it stay in view; a fade says there is more of it.
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    watch?.observe(el);
    return () => (el.removeEventListener("scroll", measure), watch?.disconnect());
  }, [rows]);
  return (
    <div className="relative">
      <p id={summaryId} data-diff-summary className="sr-only">
        {diffSummary(rows, what)}
      </p>
      <div ref={box} role="group" aria-label={`${what} changes`} aria-describedby={summaryId} data-diff={what} className="overflow-hidden rounded-md border border-ws-sep bg-ws-win font-mono text-[12.5px] leading-snug">
        {rows.map((r, i) =>
          r.kind === "gap" ? (
            <div key={i} data-gap={r.count} className="border-y border-dashed border-ws-sep bg-ws-bar px-2 py-0.5 text-center text-xs text-ws-ink3">
              {r.count} unchanged lines
            </div>
          ) : (
            <Line key={i} row={r} pair={pairs.has(i) ? (rows[pairs.get(i)!] as { text: string }).text : null} said={startsBlock(rows, i)} />
          ),
        )}
      </div>
      {more && (
        <p data-diff-more aria-hidden="true" className="pointer-events-none absolute inset-x-px bottom-px m-0 rounded-b-md bg-gradient-to-t from-ws-win via-ws-win/90 to-transparent pt-5 pb-0.5 text-center font-sans text-xs text-ws-ink3">
          {SCROLL_FOR_DIFF} ↓
        </p>
      )}
    </div>
  );
}

/** One line of a diff, with its kind said for a screen reader only when it starts a block (`said`); a removed or added line paired with its other version marks the words that changed, or says only spacing did. */
function Line({ row: r, pair, said }: { row: Exclude<DiffRow, { kind: "gap" }>; pair: string | null; said: boolean }) {
  const words = useMemo(() => (r.kind !== "same" && pair !== null ? diffWords(r.kind === "del" ? r.text : pair, r.kind === "del" ? pair : r.text) : null), [r.kind, r.text, pair]);
  return (
    <div data-line={r.kind} aria-hidden={r.text.trim() === "" ? true : undefined} className={`flex gap-2 px-2 py-px ${TONE[r.kind]}`}>
      <span aria-hidden className="w-3 shrink-0 select-none text-center">
        {MARK[r.kind]}
      </span>
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {said && <span className="sr-only">{SAID[r.kind]}</span>}
        {words && r.kind !== "same" && !words.spacingOnly ? <Words parts={r.kind === "del" ? words.from : words.to} kind={r.kind} /> : r.text || " "}
        {words?.spacingOnly && r.kind === "add" && (
          <span data-spacing-only className="ml-2 font-sans text-xs text-ws-ink3">
            ({ONLY_SPACING})
          </span>
        )}
      </span>
    </div>
  );
}

/** What a rewrite changes, in words: "title", "description" or "title and description". */
export const rewriteWhat = (i: Rewrite) => (i.title && i.body ? "title and description" : i.body ? "description" : "title");

/** The person's edit to send before approving, or null when the text is as drafted. */
export function rewriteEdit(i: Rewrite, title: string, body: string): ProposalEdit | null {
  const t = i.title && title !== i.title.to ? { title } : {};
  const b = i.body && body !== i.body.toText ? { body } : {};
  return Object.keys({ ...t, ...b }).length ? { type: "rewrite", ...t, ...b } : null;
}

/** The editable text of a rewrite as the backend holds it. */
export const rewriteFields = (i: Rewrite | null) => ({ title: i?.title?.to ?? "", text: i?.body?.toText ?? "" });

/**
 * Whether the fields take the backend's text when it changes: always, until the person types; and while an approval is under way,
 * because that text is their own edit coming back normalised.
 */
export const takesBackendText = (edited: boolean, approving: boolean) => !edited || approving;

/** A title as the backend stores it: one line, runs of whitespace collapsed. */
export const oneLine = (title: string) => title.split(/\s+/).filter(Boolean).join(" ");

/** Why approving would do nothing or harm: a part left blank, or no part that differs from what the ticket says now. */
export function rewriteBlocked(i: Rewrite, title: string, body: string): boolean {
  const blank = (!!i.title && !oneLine(title)) || (!!i.body && !body.trim());
  const changes = (!!i.title && oneLine(title) !== i.title.from.trim()) || (!!i.body && body.trim() !== i.body.fromText.trim());
  return blank || !changes;
}

/** How many lines of a description would be added and removed, for a one-line summary. */
export function bodyChangeSize(from: string, to: string): { added: number; removed: number } {
  const lines = diffLines(from, to);
  return { added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
}

interface Props {
  intent: Rewrite;
  title: string;
  body: string;
  editing: boolean;
  disabled?: boolean;
  onTitle(value: string): void;
  onBody(value: string): void;
  /**
   * The run the draft came from, "the CA-401 plan": the diff shows it where Gossamr's text names the run by id. The
   * field being edited keeps the text exactly as it would be written.
   */
  runName?: string | null;
  /** The level of the section headings: 4 under a card's own heading, 3 where the surface's heading is a level 2. */
  headingLevel?: 3 | 4;
}

const field = "w-full rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink";

/** What a rewrite would change, as a diff against what the ticket said when it was drafted. While editing, the new text is a field and the diff follows it. */
export function RewriteView({ intent, title, body, editing, disabled, onTitle, onBody, runName = null, headingLevel = 4 }: Props) {
  const H = `h${headingLevel}` as const;
  const titleRows = useMemo(() => (intent.title ? withGaps(diffLines(intent.title.from, title)) : []), [intent.title, title]);
  const bodyRows = useMemo(() => {
    const rows = intent.body ? withGaps(diffLines(intent.body.fromText, body)) : [];
    // Only the new text came from this run; a removed line names the run that wrote the old text, often another one,
    // and naming both "the CA-401 plan" made a changed line look unchanged.
    return runName ? rows.map((r) => (r.kind === "gap" || r.kind === "del" ? r : { ...r, text: withRunNamed(r.text, runName) })) : rows;
  }, [intent.body, body, runName]);
  return (
    <div className="grid gap-2.5">
      {intent.title && (
        <section className="grid gap-1">
          <H className="m-0 text-xs font-semibold text-ws-ink3">Title</H>
          {editing && !disabled ? <input aria-label="New title" value={title} onChange={(e) => onTitle(e.target.value)} className={field} /> : null}
          <Rows rows={titleRows} what="title" />
        </section>
      )}
      {intent.body && (
        <section className="grid gap-1">
          <H className="m-0 text-xs font-semibold text-ws-ink3">Description{changedLines(diffLines(intent.body.fromText, body)) === 0 ? " (no change)" : ""}</H>
          {editing && !disabled ? (
            <textarea aria-label="New description, as Markdown" value={body} onChange={(e) => onBody(e.target.value)} rows={Math.min(18, Math.max(6, body.split("\n").length + 1))} className={`${field} font-mono text-[12.5px]`} />
          ) : null}
          <Rows rows={bodyRows} what="description" />
        </section>
      )}
      {intent.body && intent.flattened.length > 0 && (
        <p data-flattened role="note" className="m-0 rounded-md border border-ws-warn/40 bg-ws-warn/10 px-2.5 py-1.5 text-sm">
          <b className="font-semibold">The old description has {intent.flattened.join(", ")}.</b> Approving replaces {intent.flattened.length === 1 ? "it" : "them"} with plain text. Jira keeps the old text in the ticket&apos;s history.
        </p>
      )}
    </div>
  );
}
