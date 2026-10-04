import { useMemo } from "react";
import { changedLines, diffLines, withGaps, type DiffRow } from "../lib/textDiff";
import type { Intent, ProposalEdit } from "../types";

export type Rewrite = Extract<Intent, { type: "rewrite" }>;

const MARK = { add: "+", del: "−", same: " " } as const;
const SAID = { add: "Added: ", del: "Removed: ", same: "Unchanged: " } as const;
const TONE = { add: "bg-ws-done-soft text-ws-ink", del: "bg-ws-blocked-soft text-ws-ink2 line-through decoration-ws-blocked/50", same: "text-ws-ink3" } as const;

function Rows({ rows, what }: { rows: DiffRow[]; what: string }) {
  return (
    <div role="group" aria-label={`${what} changes`} data-diff={what} className="overflow-hidden rounded-md border border-ws-sep bg-ws-win font-mono text-[12.5px] leading-snug">
      {rows.map((r, i) =>
        r.kind === "gap" ? (
          <div key={i} data-gap={r.count} className="border-y border-dashed border-ws-sep bg-ws-bar px-2 py-0.5 text-center text-xs text-ws-ink3">
            {r.count} unchanged lines
          </div>
        ) : (
          <div key={i} data-line={r.kind} className={`flex gap-2 px-2 py-px ${TONE[r.kind]}`}>
            <span aria-hidden className="w-3 shrink-0 select-none text-center">
              {MARK[r.kind]}
            </span>
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="sr-only">{SAID[r.kind]}</span>
              {r.text || " "}
            </span>
          </div>
        ),
      )}
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
}

const field = "w-full rounded-md border border-ws-sep2 bg-ws-win px-2 py-1 text-ws-ink";

/** What a rewrite would change, as a diff against what the ticket said when it was drafted. While editing, the new text is a field and the diff follows it. */
export function RewriteView({ intent, title, body, editing, disabled, onTitle, onBody }: Props) {
  const titleRows = useMemo(() => (intent.title ? withGaps(diffLines(intent.title.from, title)) : []), [intent.title, title]);
  const bodyRows = useMemo(() => (intent.body ? withGaps(diffLines(intent.body.fromText, body)) : []), [intent.body, body]);
  return (
    <div className="grid gap-2.5">
      {intent.title && (
        <section className="grid gap-1">
          <h4 className="m-0 text-xs font-semibold text-ws-ink3">Title</h4>
          {editing && !disabled ? <input aria-label="New title" value={title} onChange={(e) => onTitle(e.target.value)} className={field} /> : null}
          <Rows rows={titleRows} what="title" />
        </section>
      )}
      {intent.body && (
        <section className="grid gap-1">
          <h4 className="m-0 text-xs font-semibold text-ws-ink3">Description{changedLines(diffLines(intent.body.fromText, body)) === 0 ? " (no change)" : ""}</h4>
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
