import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "../components/Adf";
import { parsePatch, type DiffLine } from "../lib/diffHunks";
import { isTypingTarget } from "../lib/keyboard";
import type { ChangedFile, Proposal, ReviewComment } from "../types";
import { useWorkspace } from "../workspaceStore";
import { usePullDiff, usePullView, type PullDiffState, type PullViewTarget } from "./pullViewStore";

/** What j and k step through: each file's heading, and each comment under its line. */
const NAV = "[data-pull-nav]";
const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

const ring = "outline-none focus:outline-2 focus:outline-offset-[-2px] focus:outline-solid focus:outline-ws-pip";

const placeOf = (c: Pick<ReviewComment, "path" | "line">) => `${c.path}:${c.line}`;
const onLine = (c: ReviewComment, l: DiffLine) => (c.side === "LEFT" ? l.left : l.right) === c.line;

/** `n` of `noun`, said in the singular for one: "1 comment", "2 comments". */
export const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What a key does in the view: Esc closes it, j and k move through it. Nothing with a modifier, and nothing while typing in a field. */
export function pullViewKey(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, typing: boolean): "close" | "next" | "prev" | null {
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  return ev.key === "Escape" ? "close" : ev.key === "j" ? "next" : ev.key === "k" ? "prev" : null;
}

/** An element j and k step to. */
export interface Rovable {
  tabIndex: number;
  focus(): void;
  contains(other: Node | null): boolean;
  scrollIntoView?(arg?: ScrollIntoViewOptions): void;
}

/**
 * Moves focus `by` one through `items` (the files and comments, in order) from the one holding `active`, stopping at
 * either end, and keeps only that one in the Tab order (roving tabindex). From outside them, j starts at the first and
 * k at the last.
 */
export function stepPullNav<T extends Rovable>(items: readonly T[], active: Element | null, by: 1 | -1): T | null {
  if (!items.length) return null;
  const at = items.findIndex((el) => (el as unknown) === active || el.contains(active));
  const next = items[at < 0 ? (by > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + by))];
  items.forEach((el) => (el.tabIndex = el === next ? 0 : -1));
  next.focus();
  next.scrollIntoView?.({ block: "nearest" });
  return next;
}

function CommentNote({ c }: { c: ReviewComment }) {
  return (
    <div role="note" aria-label={`Comment on ${placeOf(c)}`} data-pull-nav data-pull-comment={placeOf(c)} tabIndex={-1} className={`mx-2 my-1 rounded-md border border-dashed border-ws-pip bg-ws-win px-2 py-1 font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere] ${ring}`}>
      <b className="block text-xs font-semibold text-ws-pip">
        Draft comment on {placeOf(c)}
        {c.side === "LEFT" ? " (old side)" : ""}
      </b>
      {c.body}
    </div>
  );
}

/** One file of the pull request as a unified diff, with the draft's comments under the lines they are about. */
function FileDiff({ file, comments }: { file: ChangedFile; comments: readonly ReviewComment[] }) {
  const hunks = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const shown = new Set<ReviewComment>();
  return (
    <section aria-label={file.path} data-pull-file={file.path} className="overflow-hidden rounded-lg border border-ws-sep2">
      <h3 id={`pull-file-${file.path}`} data-pull-nav tabIndex={-1} className={`m-0 flex items-baseline gap-2 bg-ws-bar px-2.5 py-1.5 font-mono text-sm font-semibold [overflow-wrap:anywhere] ${ring}`}>
        <span className="min-w-0 flex-1">{file.path}</span>
        <span className="shrink-0 text-xs font-normal">
          <span className="text-ws-done">+{file.additions}</span> <span className="text-ws-blocked">−{file.deletions}</span>
        </span>
      </h3>
      {!file.patch ? (
        <p className="m-0 px-2.5 py-1.5 text-sm text-ws-ink3">No diff to show: a binary file or a very large change.</p>
      ) : (
        <div className="overflow-x-auto font-mono text-xs leading-5">
          {hunks.map((h, i) => (
            <Fragment key={i}>
              <div className="bg-ws-sel px-2.5 whitespace-pre text-ws-ink3">{`@@ -${h.leftStart},${h.leftLines} +${h.rightStart},${h.rightLines} @@`}</div>
              {h.lines.map((l, j) => {
                const here = comments.filter((c) => onLine(c, l));
                here.forEach((c) => shown.add(c));
                return (
                  <Fragment key={j}>
                    <div data-diff-line={l.kind} className={`flex whitespace-pre ${l.kind === "added" ? "bg-ws-done-soft" : l.kind === "deleted" ? "bg-ws-blocked-soft" : ""}`}>
                      <span aria-hidden className="w-10 shrink-0 pr-1 text-right text-ws-ink3 select-none">
                        {l.left ?? ""}
                      </span>
                      <span aria-hidden className="w-10 shrink-0 pr-1.5 text-right text-ws-ink3 select-none">
                        {l.right ?? ""}
                      </span>
                      <span className="pr-2">{l.raw}</span>
                    </div>
                    {here.map((c) => (
                      <CommentNote key={`${c.side}:${c.line}`} c={c} />
                    ))}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
          {file.truncated && <p className="m-0 px-2.5 py-1 font-sans text-ws-ink3">The diff is cut short here.</p>}
        </div>
      )}
      {comments.some((c) => !shown.has(c)) && (
        <div className="border-t border-ws-sep py-1">
          <p className="m-0 px-2.5 text-sm text-ws-ink3">Comments on lines this diff doesn&apos;t show now:</p>
          {comments
            .filter((c) => !shown.has(c))
            .map((c) => (
              <CommentNote key={`${c.side}:${c.line}`} c={c} />
            ))}
        </div>
      )}
    </section>
  );
}

/** The in-app view of a pull request: what it is, the files it changes, their diffs, and a review draft's comments in place. */
export function PullViewSheet({ target, draft, onClose, diff: given }: { target: PullViewTarget; draft: Proposal | null; onClose(): void; /** What a test shows instead of reading it. */ diff?: PullDiffState }) {
  const read = usePullDiff(given ? null : target.connectionId, target.repo, target.number);
  const diff = given ?? read;
  const panel = useRef<HTMLDivElement>(null);
  const review = draft?.intent.type === "githubReview" ? draft.intent : null;
  const comments = review?.comments ?? [];
  const name = `Pull request ${target.repo}#${target.number}`;
  const [roved, setRoved] = useState(false);

  useLayoutEffect(() => panel.current?.focus(), []);

  // Captured, so nothing behind the view (the peek, Pip home's columns, a canvas) takes its keys: Esc closes it, j and k
  // move through it, and Tab stays in it. Never while typing in a field of the view's own. The app's shortcuts with a
  // modifier (⌘J, ⌘K and the rest) don't reach behind it either, though the browser's own (copy, select all) still work.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const root = panel.current;
      if (!root) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) {
        ev.stopPropagation();
        return;
      }
      if (ev.key === "Tab") {
        const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!all.length) return;
        const [first, last] = [all[0], all[all.length - 1]];
        const at = document.activeElement;
        const wrap = !root.contains(at) ? first : ev.shiftKey && (at === first || at === root) ? last : !ev.shiftKey && at === last ? first : null;
        if (!wrap) return;
        ev.preventDefault();
        wrap.focus();
        return;
      }
      // A field behind the view that somehow has the keyboard doesn't keep Esc from closing it.
      const action = pullViewKey(ev, isTypingTarget(ev.target) && ev.target instanceof Node && root.contains(ev.target));
      if (!action) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (action === "close") onClose();
      else if (stepPullNav([...root.querySelectorAll<HTMLElement>(NAV)], document.activeElement, action === "next" ? 1 : -1)) setRoved(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // The first file is the one Tab reaches until j or k has moved on.
  useEffect(() => {
    if (roved || diff.status !== "ready") return;
    const first = panel.current?.querySelector<HTMLElement>(NAV);
    if (first) first.tabIndex = 0;
  }, [diff.status, roved]);

  const change = diff.status === "ready" ? diff.diff.change : null;
  return (
    <div className="fixed inset-0 z-[60] flex justify-center bg-black/30 p-4" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        data-pull-view={`${target.repo}#${target.number}`}
        data-esc-local
        tabIndex={-1}
        className="ws-legacy flex max-h-full w-full max-w-[960px] flex-col overflow-hidden rounded-xl border border-ws-sep2 bg-ws-win text-base text-ws-ink shadow-xl outline-none"
      >
        <header className="grid gap-1 border-b border-ws-sep px-4 py-3">
          <div className="flex items-start gap-2">
            <h2 className="m-0 min-w-0 flex-1 text-lg font-semibold [overflow-wrap:anywhere]">{change ? change.title : name}</h2>
            <button type="button" onClick={onClose} aria-label="Close pull request view" className="shrink-0 rounded-md border border-ws-sep2 px-2 py-0.5 text-sm hover:bg-ws-hover focus-visible:outline-2 focus-visible:outline-ws-pip">
              Close
            </button>
          </div>
          <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm text-ws-ink2">
            <span className="font-mono font-semibold">
              {target.repo}#{target.number}
            </span>
            {change && (
              <>
                <span data-pull-state className="rounded-full bg-ws-sel px-2 text-xs font-semibold">
                  {change.state}
                </span>
                <span className="font-mono text-xs">
                  {change.headRef} → {change.baseRef ?? "?"}
                </span>
                {change.sha && <span className="font-mono text-xs text-ws-ink3">at {change.sha.slice(0, 8)}</span>}
                <Link href={change.url}>Open on GitHub</Link>
              </>
            )}
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {review && (
            <section aria-label="Review draft" data-pull-review className="mb-3 grid gap-1 rounded-lg border border-dashed border-ws-pip bg-ws-pip-soft px-3 py-2 text-sm">
              <b className="text-ws-pip">
                Review draft at {review.commitSha.slice(0, 8)}
                {draft && draft.state.type !== "pending" ? ` (${draft.state.type})` : ", not posted"}
              </b>
              <p data-pull-summary className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {review.summary}
              </p>
            </section>
          )}
          {diff.status === "loading" && (
            <p role="status" className="m-0 text-ws-ink3">
              Loading the pull request…
            </p>
          )}
          {diff.status === "error" && (
            <p role="alert" className="m-0 text-ws-blocked [overflow-wrap:anywhere]">
              {diff.error}
            </p>
          )}
          {diff.status === "ready" && (
            <div className="grid gap-3">
              <nav aria-label="Files" className="grid gap-1">
                <h3 className="m-0 text-xs font-semibold tracking-wide text-ws-ink3 uppercase">Files changed ({diff.diff.files.length})</h3>
                <ul className="m-0 grid list-none gap-0.5 p-0">
                  {diff.diff.files.map((f) => (
                    <li key={f.path} data-pull-file-row={f.path} className="flex items-baseline gap-2 text-sm">
                      <button
                        type="button"
                        onClick={() => {
                          const heading = document.getElementById(`pull-file-${f.path}`);
                          if (!heading || !panel.current) return;
                          panel.current.querySelectorAll<HTMLElement>(NAV).forEach((el) => (el.tabIndex = el === heading ? 0 : -1));
                          heading.focus();
                          heading.scrollIntoView?.({ block: "start" });
                          setRoved(true);
                        }}
                        className="min-w-0 flex-1 rounded text-left font-mono text-xs text-ws-pip [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-ws-pip"
                      >
                        {f.path}
                      </button>
                      {comments.some((c) => c.path === f.path) && <span className="shrink-0 text-xs text-ws-pip">{countOf(comments.filter((c) => c.path === f.path).length, "comment")}</span>}
                      <span className="shrink-0 font-mono text-xs">
                        <span className="text-ws-done">+{f.additions}</span> <span className="text-ws-blocked">−{f.deletions}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </nav>
              {diff.diff.files.map((f) => (
                <FileDiff key={f.path} file={f} comments={comments.filter((c) => c.path === f.path)} />
              ))}
              {comments.some((c) => !diff.diff.files.some((f) => f.path === c.path)) && (
                <section aria-label="Comments on files not in the diff" className="grid gap-1">
                  <p className="m-0 text-sm text-ws-ink3">Comments on files the pull request doesn&apos;t change now:</p>
                  {comments
                    .filter((c) => !diff.diff.files.some((f) => f.path === c.path))
                    .map((c) => (
                      <CommentNote key={`${c.path}:${c.side}:${c.line}`} c={c} />
                    ))}
                </section>
              )}
              <p className="m-0 text-xs text-ws-ink3">j and k move through the files and comments; Esc closes.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The pull request view, mounted once in the workspace and shown when something opens it (`usePullView.open`). */
export function PullView() {
  const target = usePullView((s) => s.target);
  const draft = useWorkspace((s) => (target?.proposalId ? (s.proposals[target.proposalId] ?? null) : null));
  if (!target) return null;
  return <PullViewSheet key={`${target.repo}#${target.number}:${target.proposalId ?? ""}`} target={target} draft={draft} onClose={() => usePullView.getState().close()} />;
}
